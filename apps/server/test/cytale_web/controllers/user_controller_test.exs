defmodule CytaleWeb.Controllers.UserControllerTest do
  @moduledoc """
  U9 slice 3 — @me surface + the people-directory contract (U24/U26).
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, User}
  alias Cytale.Test.AgentGrants

  @endpoint CytaleWeb.Endpoint

  defp run_nonce, do: "r" <> Cytale.TestNonce.get()
  defp run_unique(base), do: base <> run_nonce()

  setup do
    conn =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("content-type", "application/json")

    {:ok, me} = User.create(run_unique("me_user"), run_unique("me_user@example.com"), "password-123")
    access = Auth.issue_access_token(me.user_id, me.username, true)
    conn = put_req_header(conn, "authorization", "Bearer " <> access)

    ws_conn = post(conn, "/api/v1/workspaces", %{"name" => run_unique("People WS")})
    assert ws_conn.status == 201
    ws_id = get_in(Jason.decode!(ws_conn.resp_body), ["workspace", "id"]) || Jason.decode!(ws_conn.resp_body)["id"]

    {:ok, conn: conn, me: me, ws_id: ws_id}
  end

  test "GET /users/@me returns the current profile", %{conn: conn, me: me} do
    conn = get(conn, "/api/v1/users/@me")
    assert conn.status == 200

    user = Jason.decode!(conn.resp_body)["user"]
    assert user["id"] == Integer.to_string(me.user_id)
    assert user["username"] == me.username
  end

  test "PATCH /users/@me updates display_name", %{conn: conn} do
    new_name = run_unique("Display")

    conn = patch(conn, "/api/v1/users/@me", %{"display_name" => new_name})
    assert conn.status == 200
    assert Jason.decode!(conn.resp_body)["user"]["display_name"] == new_name
  end

  test "PATCH /users/@me absent keys leave fields unchanged (rename does not wipe avatar)", %{
    conn: conn,
    me: me
  } do
    # avatar_url is clear-only: setting rides the upload endpoint, so seed
    # one the way the wire does (the avatar suite covers the upload itself).
    seeded = "/api/v1/attachments/" <> String.duplicate("ab", 32)
    :ok = Cytale.Accounts.User.update_profile!(me.user_id, "Seeded Name", seeded)

    # Rename with NO avatar key: the avatar survives.
    conn = patch(conn, "/api/v1/users/@me", %{"display_name" => run_unique("Renamed")})
    assert conn.status == 200

    resp = Jason.decode!(conn.resp_body)["user"]
    assert resp["avatar_url"] == seeded
    assert resp["display_name"] != "Seeded Name"

    # Avatar-only PATCH: display_name survives. Explicit null still clears.
    conn = patch(conn, "/api/v1/users/@me", %{"avatar_url" => nil})
    assert conn.status == 200
    user_json = Jason.decode!(conn.resp_body)["user"]
    assert user_json["avatar_url"] == nil
    assert user_json["display_name"] == resp["display_name"]
  end

  test "people directory: query filters by username prefix (owner is a member)", %{
    conn: conn,
    me: me,
    ws_id: ws_id
  } do
    # The owner is a member; add one more member via invite.
    {:ok, invite} =
      Cytale.Workspaces.create_invite(String.to_integer(ws_id), me.user_id, max_age_s: 600)

    prefix = run_unique("janetester")
    {:ok, member} = User.create(prefix, run_unique("janetester@example.com"), "password-123")

    {:ok, member_access} = {:ok, Auth.issue_access_token(member.user_id, member.username, true)}

    join_conn =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("content-type", "application/json")
      |> put_req_header("authorization", "Bearer " <> member_access)

    conn_j = post(join_conn, "/api/v1/invites/#{invite.invite_code}")
    assert conn_j.status == 200

    # Query by a prefix of the member's username.
    q = String.slice(prefix, 0, div(String.length(prefix), 2))
    conn = get(conn, "/api/v1/workspaces/#{ws_id}/people?query=#{q}&limit=50")
    assert conn.status == 200

    ids =
      Jason.decode!(conn.resp_body)["people"]
      |> Enum.map(&get_in(&1, ["user", "id"]))

    assert Integer.to_string(member.user_id) in ids
  end

  test "unauthenticated @me → 401" do
    anon = Phoenix.ConnTest.build_conn() |> put_req_header("accept", "application/json")
    conn = get(anon, "/api/v1/users/@me")
    assert conn.status == 401
  end

  describe "people directory roster synthesis (bots plan U5)" do
    test "machine principals appear beside their parent with kind + parent_user_id", %{
      conn: conn,
      me: me,
      ws_id: ws_id
    } do
      {:ok, %{user_id: bot_id, username: bot_username}} =
        Cytale.Test.AgentGrants.mint_all(me.user_id, :bot, run_unique("Dir Bot"))

      conn = get(conn, "/api/v1/workspaces/#{ws_id}/people?limit=50")
      assert conn.status == 200
      %{"people" => people, "next_before" => cursor} = Jason.decode!(conn.resp_body)

      me_str = Integer.to_string(me.user_id)

      assert [
               %{"user" => %{"id" => ^me_str, "username" => me_username}, "kind" => "human"},
               %{
                 "user" => %{"id" => bot_str, "username" => ^bot_username},
                 "kind" => "bot",
                 "parent_user_id" => ^me_str
               }
             ] = people

      assert bot_str == Integer.to_string(bot_id)
      assert me_username == me.username
      # One human (< limit 50): the roster is exhausted, no dead cursor —
      # even though the page carried TWO entries.
      assert cursor == nil
    end

    test "the before-cursor stays keyed on HUMAN rows across pages", %{
      conn: conn,
      me: me,
      ws_id: ws_id
    } do
      # Older member (joined after workspace create → add_member here), so
      # user_id DESC pages the joiner first. BOTH humans carry a machine
      # principal, so every page mixes humans + synthesized entries.
      {:ok, joiner} = User.create(run_unique("u5_joiner"), run_unique("u5_joiner@example.com"), "password-123")
      :ok = Cytale.Workspaces.add_member(String.to_integer(ws_id), joiner.user_id, me.user_id)
      {:ok, %{user_id: bot_id}} = Cytale.Test.AgentGrants.mint_all(joiner.user_id, :bot, run_unique("Pager Bot"))
      {:ok, %{user_id: agent_id}} = Cytale.Test.AgentGrants.mint_all(me.user_id, :agent, run_unique("Owner Agent"))

      # Page 1 (limit 1): the newest human + its synthesized bot. The cursor
      # must be the JOINER's id (the last human), never the bot's.
      page1 = get(conn, "/api/v1/workspaces/#{ws_id}/people?limit=1")
      assert page1.status == 200
      %{"people" => p1, "next_before" => cursor1} = Jason.decode!(page1.resp_body)

      joiner_str = Integer.to_string(joiner.user_id)

      assert [%{"user" => %{"id" => ^joiner_str}, "kind" => "human"}, %{"kind" => "bot", "user" => %{"id" => bot_str}}] =
               p1

      assert bot_str == Integer.to_string(bot_id)
      assert cursor1 == joiner_str

      # Page 2: strictly older humans — the owner + its agent. A full human
      # page (== limit) still cursors (pre-existing contract), but on the
      # OWNER's id — the last human — never the synthesized agent's.
      page2 = get(conn, "/api/v1/workspaces/#{ws_id}/people?limit=1&before=#{cursor1}")
      assert page2.status == 200
      %{"people" => p2, "next_before" => cursor2} = Jason.decode!(page2.resp_body)
      me_str = Integer.to_string(me.user_id)

      assert [%{"user" => %{"id" => ^me_str}, "kind" => "human"}, %{"kind" => "bot", "user" => %{"id" => agent_str}}] =
               p2

      assert agent_str == Integer.to_string(agent_id)
      assert cursor2 == me_str

      # Page 3 (before the last human): exhausted roster, no dead cursor.
      page3 = get(conn, "/api/v1/workspaces/#{ws_id}/people?limit=1&before=#{cursor2}")
      %{"people" => p3, "next_before" => cursor3} = Jason.decode!(page3.resp_body)
      assert p3 == []
      assert cursor3 == nil
    end
  end
end
