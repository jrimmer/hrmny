defmodule CytaleWeb.Controllers.AccountControllerTest do
  @moduledoc """
  U14 slice 1 — `DELETE /api/v1/account` (self-delete): answers 202 Accepted
  immediately (async cascade), marks the user deleted, and the sweep
  tombstones the user's messages.
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, TokenStore, User}
  alias Cytale.Messages

  @endpoint CytaleWeb.Endpoint

  defp run_nonce, do: "r" <> Cytale.TestNonce.get()
  defp run_unique(base), do: base <> run_nonce()

  setup do
    conn =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("content-type", "application/json")

    {:ok, me} = User.create(run_unique("acct_user"), run_unique("acct_user@example.com"), "password-123")
    access = Auth.issue_access_token(me.user_id, me.username, true)
    conn = put_req_header(conn, "authorization", "Bearer " <> access)

    {:ok, conn: conn, me: me}
  end

  # Revoking every session is "nothing of mine stays live on any device", and
  # stored notification preferences share that lifetime. A survivor would
  # silently re-apply to whatever session signs in next (plan U2, R19).
  test "DELETE /users/@me/sessions drops the caller's notification preferences", %{
    conn: conn,
    me: me
  } do
    :ok = Cytale.Notifications.Preferences.set_level(me.user_id, :account, 0, "mentions")
    assert map_size(Cytale.Notifications.Preferences.all(me.user_id)) == 1

    conn = delete(conn, "/api/v1/users/@me/sessions")
    assert conn.status == 204

    assert Cytale.Notifications.Preferences.all(me.user_id) == %{}
  end

  # The subscription lives in the browser's push manager, not in page storage,
  # so signing out does NOT remove it. A row left behind would deliver this
  # member's notifications to a signed-out browser (plan U6, R19/R20).
  test "DELETE /users/@me/sessions drops the caller's push subscriptions", %{conn: conn, me: me} do
    :ok =
      Cytale.Workspaces.put_push_subscription(
        me.user_id,
        "https://push.example.com/sessions-test",
        Jason.encode!(%{"p256dh" => "p", "auth" => "a"})
      )

    assert length(Cytale.Notifications.Subscriptions.list_for_user(me.user_id)) == 1

    conn = delete(conn, "/api/v1/users/@me/sessions")
    assert conn.status == 204

    assert Cytale.Notifications.Subscriptions.list_for_user(me.user_id) == [],
           "a signed-out browser must not keep receiving notifications"
  end

  test "DELETE /users/@me/sessions drops the caller's participation index", %{conn: conn, me: me} do
    :ok = Cytale.Notifications.Participations.record(me.user_id, 12_345_678)

    conn = delete(conn, "/api/v1/users/@me/sessions")
    assert conn.status == 204

    assert Cytale.Notifications.Participations.channels_for_user(me.user_id) == []
  end

  test "DELETE /api/v1/account → 202 Accepted, user soft-deleted, messages tombstoned", %{
    conn: conn,
    me: me
  } do
    # A message authored by the user.
    channel_id = Cytale.Snowflake.next()

    {:ok, wire} =
      Messages.Message.send_message(%{
        channel_id: channel_id,
        author_id: me.user_id,
        content: "self-delete me",
        thread_id: nil
      })

    mid = String.to_integer(wire["id"])

    conn = delete(conn, "/api/v1/account")
    assert conn.status == 202
    assert %{"deleted" => true, "status" => "accepted"} = Jason.decode!(conn.resp_body)

    # Soft-delete tombstone set.
    assert %{deleted_at: %DateTime{}} = User.get(me.user_id)

    # Give the spawned sweep a beat, then assert the message is tombstoned.
    Process.sleep(200)
    history = Messages.history(channel_id, limit: 10)
    assert Enum.any?(history, &(&1.id == mid and &1.content == "[message deleted]"))
  end

  test "unauthenticated DELETE /api/v1/account → 401" do
    anon = Phoenix.ConnTest.build_conn() |> put_req_header("content-type", "application/json")
    conn = delete(anon, "/api/v1/account")
    assert conn.status == 401
  end

  # ---------------------------------------------------------------------------
  # Sessions revoke-all (settings gear surface)
  # ---------------------------------------------------------------------------

  test "DELETE /api/v1/users/@me/sessions → 204, every refresh token revoked", %{
    conn: conn,
    me: me
  } do
    # Two devices: two live refresh tokens.
    assert {:ok, raw_one, _hash_one, _} = Auth.issue_refresh_token(me.user_id)
    assert {:ok, raw_two, _hash_two, _} = Auth.issue_refresh_token(me.user_id)
    assert length(TokenStore.list(me.user_id)) == 2

    conn = delete(conn, "/api/v1/users/@me/sessions")
    assert conn.status == 204

    # Every token is gone and both devices' rotations now fail.
    assert TokenStore.list(me.user_id) == []
    assert {:error, :revoked} = Auth.rotate_refresh_token(me.user_id, raw_one)
    assert {:error, :revoked} = Auth.rotate_refresh_token(me.user_id, raw_two)
  end

  test "unauthenticated DELETE /api/v1/users/@me/sessions → 401" do
    anon = Phoenix.ConnTest.build_conn() |> put_req_header("content-type", "application/json")
    assert delete(anon, "/api/v1/users/@me/sessions").status == 401
  end
end
