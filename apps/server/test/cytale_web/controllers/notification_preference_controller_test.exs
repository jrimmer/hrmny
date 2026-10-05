defmodule CytaleWeb.NotificationPreferenceControllerTest do
  @moduledoc """
  U2 of the notification plan — the member-facing preference surface.

  The gate that matters here is scope validation: a preference is a claim about
  a workspace or channel the member belongs to, so an id they cannot reach
  must be refused rather than stored. An unvalidated write would let a member
  accumulate rows pointing at other workspaces, and the notification decision
  reads those rows.
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, User}
  alias Cytale.Notifications.Preferences

  @endpoint CytaleWeb.Endpoint

  defp run_nonce, do: "r" <> Cytale.TestNonce.get()
  defp run_unique(base), do: base <> run_nonce()

  defp auth(conn, user) do
    access = Auth.issue_access_token(user.user_id, user.username, true)
    put_req_header(conn, "authorization", "Bearer " <> access)
  end

  setup do
    conn =
      build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("content-type", "application/json")

    {:ok, alice} = User.create(run_unique("npc"), run_unique("npc@example.com"), "password-123")
    conn = auth(conn, alice)

    ws = post(conn, "/api/v1/workspaces", %{"name" => run_unique("WSN")})
    ws_id = Jason.decode!(ws.resp_body)["workspace"]["id"]

    ch = post(conn, "/api/v1/workspaces/#{ws_id}/channels", %{"name" => run_unique("chn")})
    ch_id = Jason.decode!(ch.resp_body)["channel"]["id"]

    # A second workspace the member does NOT belong to.
    {:ok, bob} = User.create(run_unique("npb"), run_unique("npb@example.com"), "password-123")
    other_conn = auth(conn, bob)
    other_ws = post(other_conn, "/api/v1/workspaces", %{"name" => run_unique("WSO")})
    other_ws_id = Jason.decode!(other_ws.resp_body)["workspace"]["id"]

    %{
      conn: conn,
      user: alice,
      ws_id: ws_id,
      ch_id: ch_id,
      other_ws_id: other_ws_id,
      other_conn: other_conn
    }
  end

  test "a fresh member has no overrides", %{conn: conn} do
    conn = get(conn, "/api/v1/users/@me/notification-preferences")

    assert conn.status == 200
    assert Jason.decode!(conn.resp_body)["preferences"] == []
    assert Jason.decode!(conn.resp_body)["suppress_broadcasts"] == []
  end

  describe "Suppress @everyone and @here (the per-workspace switch)" do
    test "turning it on round-trips as its own list, never as a level", %{conn: conn, ws_id: ws_id, user: user} do
      put =
        put(conn, "/api/v1/users/@me/notification-preferences", %{
          "scope" => "workspace",
          "entity_id" => ws_id,
          "suppress_broadcasts" => true
        })

      assert put.status == 200
      assert Jason.decode!(put.resp_body)["suppress_broadcasts"] == true
      refute Map.has_key?(Jason.decode!(put.resp_body), "level")

      read = Jason.decode!(get(conn, "/api/v1/users/@me/notification-preferences").resp_body)
      assert read["suppress_broadcasts"] == [ws_id]
      # The switch is not a level: the override list stays empty, so a client
      # building its override map from it can never read "suppress" as a level.
      assert read["preferences"] == []

      {:ok, ws_int} = parse_int(ws_id)
      assert Preferences.suppresses_broadcasts?(Preferences.all(user.user_id), ws_int)
    end

    test "turning it off deletes the row", %{conn: conn, ws_id: ws_id, user: user} do
      for value <- [true, false] do
        put(conn, "/api/v1/users/@me/notification-preferences", %{
          "scope" => "workspace",
          "entity_id" => ws_id,
          "suppress_broadcasts" => value
        })
      end

      assert Preferences.all(user.user_id) == %{}
    end

    test "the switch and a level ride one PUT independently", %{conn: conn, ws_id: ws_id} do
      put =
        put(conn, "/api/v1/users/@me/notification-preferences", %{
          "scope" => "workspace",
          "entity_id" => ws_id,
          "level" => "all",
          "suppress_broadcasts" => true
        })

      assert put.status == 200
      read = Jason.decode!(get(conn, "/api/v1/users/@me/notification-preferences").resp_body)
      assert [%{"scope" => "workspace", "level" => "all"}] = read["preferences"]
      assert read["suppress_broadcasts"] == [ws_id]
    end

    test "a bad level refuses the whole PUT, switch included", %{conn: conn, ws_id: ws_id, user: user} do
      put =
        put(conn, "/api/v1/users/@me/notification-preferences", %{
          "scope" => "workspace",
          "entity_id" => ws_id,
          "level" => "sometimes",
          "suppress_broadcasts" => true
        })

      assert put.status == 400
      assert Preferences.all(user.user_id) == %{}
    end

    test "the switch exists only on the workspace scope", %{conn: conn, ch_id: ch_id} do
      put =
        put(conn, "/api/v1/users/@me/notification-preferences", %{
          "scope" => "channel",
          "entity_id" => ch_id,
          "suppress_broadcasts" => true
        })

      assert put.status == 400
    end

    test "a non-boolean switch is refused", %{conn: conn, ws_id: ws_id} do
      put =
        put(conn, "/api/v1/users/@me/notification-preferences", %{
          "scope" => "workspace",
          "entity_id" => ws_id,
          "suppress_broadcasts" => "yes"
        })

      assert put.status == 400
    end

    test "another workspace's switch is refused, not stored", %{conn: conn, user: user, other_ws_id: other_ws_id} do
      put =
        put(conn, "/api/v1/users/@me/notification-preferences", %{
          "scope" => "workspace",
          "entity_id" => other_ws_id,
          "suppress_broadcasts" => true
        })

      assert put.status in [403, 404]
      assert Preferences.all(user.user_id) == %{}
    end
  end

  describe "the thread layer and direct messages" do
    test "a thread level round-trips and clears", %{conn: conn, ch_id: ch_id, user: user} do
      msg = post(conn, "/api/v1/channels/#{ch_id}/messages", %{"content" => "seed"})
      msg_id = Jason.decode!(msg.resp_body)["message"]["id"]
      thread = post(conn, "/api/v1/channels/#{ch_id}/messages/#{msg_id}/threads", %{"name" => "t"})
      thread_id = Jason.decode!(thread.resp_body)["thread"]["id"]

      put =
        put(conn, "/api/v1/users/@me/notification-preferences", %{
          "scope" => "thread",
          "entity_id" => thread_id,
          "level" => "mute"
        })

      assert put.status == 200
      read = Jason.decode!(get(conn, "/api/v1/users/@me/notification-preferences").resp_body)
      assert [%{"scope" => "thread", "entity_id" => ^thread_id, "level" => "mute"}] = read["preferences"]

      assert delete(conn, "/api/v1/users/@me/notification-preferences/thread/#{thread_id}").status == 200
      assert Preferences.all(user.user_id) == %{}
    end

    test "a thread in a workspace the member cannot reach is refused", %{conn: conn, other_conn: other_conn, user: user} do
      other_ws = post(other_conn, "/api/v1/workspaces", %{"name" => run_unique("WST")})
      other_ws_id = Jason.decode!(other_ws.resp_body)["workspace"]["id"]
      ch = post(other_conn, "/api/v1/workspaces/#{other_ws_id}/channels", %{"name" => run_unique("cht")})
      ch_id = Jason.decode!(ch.resp_body)["channel"]["id"]
      msg = post(other_conn, "/api/v1/channels/#{ch_id}/messages", %{"content" => "seed"})
      msg_id = Jason.decode!(msg.resp_body)["message"]["id"]
      thread = post(other_conn, "/api/v1/channels/#{ch_id}/messages/#{msg_id}/threads", %{"name" => "t"})
      thread_id = Jason.decode!(thread.resp_body)["thread"]["id"]

      put =
        put(conn, "/api/v1/users/@me/notification-preferences", %{
          "scope" => "thread",
          "entity_id" => thread_id,
          "level" => "all"
        })

      assert put.status in [403, 404]
      assert Preferences.all(user.user_id) == %{}
    end

    test "a DM participant may set the DM's level; an outsider may not", %{conn: conn, user: user} do
      {:ok, bob} = User.create(run_unique("npd"), run_unique("npd@example.com"), "password-123")
      Cytale.Test.SharedWorkspace.share!(user.user_id, bob.user_id)
      dm = post(conn, "/api/v1/users/#{bob.user_id}/channels", %{})
      assert dm.status == 201
      dm_id = Jason.decode!(dm.resp_body)["channel"]["id"]

      put =
        put(conn, "/api/v1/users/@me/notification-preferences", %{
          "scope" => "channel",
          "entity_id" => dm_id,
          "level" => "mute"
        })

      assert put.status == 200
      {:ok, dm_int} = parse_int(dm_id)
      assert Preferences.get(user.user_id, :channel, dm_int) == "mute"

      {:ok, carol} = User.create(run_unique("npe"), run_unique("npe@example.com"), "password-123")

      outsider =
        conn
        |> auth(carol)
        |> put("/api/v1/users/@me/notification-preferences", %{
          "scope" => "channel",
          "entity_id" => dm_id,
          "level" => "mute"
        })

      assert outsider.status in [403, 404]
      assert Preferences.all(carol.user_id) == %{}
    end
  end

  defp parse_int(value) do
    case Integer.parse(value) do
      {int, ""} -> {:ok, int}
      _ -> :error
    end
  end

  test "setting a channel level round-trips through a read", %{conn: conn, ch_id: ch_id} do
    put =
      put(conn, "/api/v1/users/@me/notification-preferences", %{
        "scope" => "channel",
        "entity_id" => ch_id,
        "level" => "mentions"
      })

    assert put.status == 200

    read = get(conn, "/api/v1/users/@me/notification-preferences")
    assert read.status == 200

    [pref] = Jason.decode!(read.resp_body)["preferences"]
    assert pref["scope"] == "channel"
    assert pref["entity_id"] == ch_id
    assert pref["level"] == "mentions"
  end

  test "setting a workspace level round-trips", %{conn: conn, ws_id: ws_id} do
    put =
      put(conn, "/api/v1/users/@me/notification-preferences", %{
        "scope" => "workspace",
        "entity_id" => ws_id,
        "level" => "all"
      })

    assert put.status == 200

    read = get(conn, "/api/v1/users/@me/notification-preferences")
    [pref] = Jason.decode!(read.resp_body)["preferences"]
    assert pref["scope"] == "workspace"
    assert pref["level"] == "all"
  end

  test "the account layer uses the account scope with no entity", %{conn: conn, user: user} do
    put =
      put(conn, "/api/v1/users/@me/notification-preferences", %{
        "scope" => "account",
        "level" => "mentions"
      })

    assert put.status == 200
    assert Preferences.get(user.user_id, :account, Preferences.account_entity()) == "mentions"
  end

  test "an unknown level is refused", %{conn: conn, ch_id: ch_id, user: user} do
    put =
      put(conn, "/api/v1/users/@me/notification-preferences", %{
        "scope" => "channel",
        "entity_id" => ch_id,
        "level" => "sometimes"
      })

    assert put.status == 400
    assert Preferences.all(user.user_id) == %{}
  end

  test "an unknown scope is refused", %{conn: conn, user: user} do
    put =
      put(conn, "/api/v1/users/@me/notification-preferences", %{
        "scope" => "galaxy",
        "entity_id" => "1",
        "level" => "all"
      })

    assert put.status == 400
    assert Preferences.all(user.user_id) == %{}
  end

  test "a workspace the member does not belong to is refused, not stored", %{
    conn: conn,
    user: user,
    other_ws_id: other_ws_id
  } do
    put =
      put(conn, "/api/v1/users/@me/notification-preferences", %{
        "scope" => "workspace",
        "entity_id" => other_ws_id,
        "level" => "all"
      })

    assert put.status in [403, 404]
    assert Preferences.all(user.user_id) == %{}
  end

  test "a channel the member cannot reach is refused, not stored", %{conn: conn, user: user} do
    put =
      put(conn, "/api/v1/users/@me/notification-preferences", %{
        "scope" => "channel",
        "entity_id" => "999999999999999999",
        "level" => "all"
      })

    assert put.status in [403, 404]
    assert Preferences.all(user.user_id) == %{}
  end

  test "a malformed entity id is refused", %{conn: conn, ch_id: ch_id} do
    put =
      put(conn, "/api/v1/users/@me/notification-preferences", %{
        "scope" => "channel",
        "entity_id" => "not-a-snowflake-#{ch_id}",
        "level" => "all"
      })

    assert put.status == 400
  end

  test "clearing a level returns the entity to inherit", %{conn: conn, ch_id: ch_id, user: user} do
    put(conn, "/api/v1/users/@me/notification-preferences", %{
      "scope" => "channel",
      "entity_id" => ch_id,
      "level" => "mute"
    })

    cleared = delete(conn, "/api/v1/users/@me/notification-preferences/channel/#{ch_id}")

    assert cleared.status == 200
    assert Preferences.all(user.user_id) == %{}
  end

  test "an unauthenticated caller is refused", %{ch_id: ch_id} do
    anon =
      build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("content-type", "application/json")

    assert get(anon, "/api/v1/users/@me/notification-preferences").status == 401

    put =
      put(anon, "/api/v1/users/@me/notification-preferences", %{
        "scope" => "channel",
        "entity_id" => ch_id,
        "level" => "all"
      })

    assert put.status == 401
  end
end
