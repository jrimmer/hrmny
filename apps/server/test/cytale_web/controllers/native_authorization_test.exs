defmodule CytaleWeb.Controllers.NativeAuthorizationTest do
  @moduledoc """
  The #35 P0-1 IDOR family, regression-pinned: the native REST surface now
  gates through the SAME seam the compat surface always had
  (`Authorize.channel_gate` / the parent-channel thread gate). One actor
  outside a workspace must receive the uniform 404 across every
  channel/thread/workspace-metadata read that used to be existence-only or
  ungated — and a legitimate default MEMBER (only the @everyone base) must
  keep working (the view-only gate must not over-block).
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, User}

  @endpoint CytaleWeb.Endpoint

  defp run_nonce, do: "r" <> Cytale.TestNonce.get()
  defp run_unique(base), do: base <> run_nonce()

  setup do
    {:ok, alice} = User.create(run_unique("ida"), run_unique("ida@example.com"), "password-123")
    {:ok, mallory} = User.create(run_unique("idm"), run_unique("idm@example.com"), "password-123")

    alice_conn = conn_for(alice)
    ws = post(alice_conn, "/api/v1/workspaces", %{"name" => run_unique("WS A")})
    assert ws.status == 201
    # Workspace create answers a FLAT object (no "workspace" envelope).
    ws_id = Jason.decode!(ws.resp_body)["workspace"]["id"]

    ch = post(alice_conn, "/api/v1/workspaces/#{ws_id}/channels", %{"name" => run_unique("chan")})
    assert ch.status == 201
    ch_id = Jason.decode!(ch.resp_body)["channel"]["id"]

    msg =
      post(alice_conn, "/api/v1/channels/#{ch_id}/messages", %{"content" => "workspace secret"})

    assert msg.status == 201
    msg_id = Jason.decode!(msg.resp_body)["message"]["id"]

    thread = post(alice_conn, "/api/v1/channels/#{ch_id}/messages/#{msg_id}/threads", %{"name" => "t"})
    assert thread.status == 201
    thread_id = Jason.decode!(thread.resp_body)["thread"]["id"]

    # A DM between alice and a third account, with content and a thread on it.
    {:ok, bob} = User.create(run_unique("idb"), run_unique("idb@example.com"), "password-123")
    Cytale.Test.SharedWorkspace.share!(alice.user_id, bob.user_id)
    dm = post(alice_conn, "/api/v1/users/#{bob.user_id}/channels", %{})
    assert dm.status == 201
    dm_id = Jason.decode!(dm.resp_body)["channel"]["id"]

    dm_msg =
      post(alice_conn, "/api/v1/channels/#{dm_id}/messages", %{"content" => "private dm line"})

    assert dm_msg.status == 201
    dm_msg_id = Jason.decode!(dm_msg.resp_body)["message"]["id"]

    dm_thread =
      post(alice_conn, "/api/v1/channels/#{dm_id}/messages/#{dm_msg_id}/threads", %{"name" => "dmt"})

    assert dm_thread.status == 201
    dm_thread_id = Jason.decode!(dm_thread.resp_body)["thread"]["id"]

    %{
      alice: alice,
      alice_conn: alice_conn,
      bob: bob,
      mallory: mallory,
      mallory_conn: conn_for(mallory),
      ws_id: ws_id,
      ch_id: ch_id,
      msg_id: msg_id,
      thread_id: thread_id,
      dm_id: dm_id,
      dm_thread_id: dm_thread_id
    }
  end

  defp conn_for(user) do
    access = Auth.issue_access_token(user.user_id, user.username, true)

    Phoenix.ConnTest.build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
    |> put_req_header("authorization", "Bearer " <> access)
  end

  # -- the outsider (authenticated, member of nothing) ---------------------------

  test "channel history of a foreign workspace → 404 (was: full leak)", %{mallory_conn: conn, ch_id: ch_id} do
    assert conn |> get("/api/v1/channels/#{ch_id}/messages") |> Map.get(:status) == 404
  end

  test "channel metadata + overwrites of a foreign workspace → 404", %{mallory_conn: conn, ch_id: ch_id} do
    assert conn |> get("/api/v1/channels/#{ch_id}") |> Map.get(:status) == 404
    assert conn |> get("/api/v1/channels/#{ch_id}/overwrites") |> Map.get(:status) == 404
    assert conn |> get("/api/v1/channels/#{ch_id}/threads") |> Map.get(:status) == 404
    assert conn |> get("/api/v1/channels/#{ch_id}/call") |> Map.get(:status) == 404
  end

  test "the whole foreign thread surface → 404 (was: leak + membership INSERT)", %{
    mallory_conn: conn,
    thread_id: thread_id
  } do
    assert conn |> get("/api/v1/threads/#{thread_id}") |> Map.get(:status) == 404
    assert conn |> get("/api/v1/threads/#{thread_id}/messages") |> Map.get(:status) == 404
    assert conn |> get("/api/v1/threads/#{thread_id}/members") |> Map.get(:status) == 404

    join = post(conn, "/api/v1/threads/#{thread_id}/members", %{})
    assert join.status == 404
  end

  test "foreign DM + DM thread content → 404 (the audit's headline leak)", %{
    mallory_conn: conn,
    dm_id: dm_id,
    dm_thread_id: dm_thread_id
  } do
    assert conn |> get("/api/v1/channels/#{dm_id}/messages") |> Map.get(:status) == 404
    assert conn |> get("/api/v1/threads/#{dm_thread_id}/messages") |> Map.get(:status) == 404
    assert conn |> get("/api/v1/threads/#{dm_thread_id}/members") |> Map.get(:status) == 404
  end

  test "foreign workspace role metadata → 404", %{mallory_conn: conn, ws_id: ws_id} do
    assert conn |> get("/api/v1/workspaces/#{ws_id}/roles") |> Map.get(:status) == 404
  end

  test "foreign channel ack → 404 (read_state was writable cross-workspace)", %{
    mallory_conn: conn,
    ch_id: ch_id,
    msg_id: msg_id
  } do
    ack = post(conn, "/api/v1/channels/#{ch_id}/ack", %{"message_ids" => [msg_id]})
    assert ack.status == 404
  end

  # -- the legitimate member (ONLY the @everyone base) must keep working ---------

  test "default member reads channel history and thread surfaces (no over-block)", %{
    alice: alice,
    bob: bob,
    ws_id: ws_id,
    ch_id: ch_id,
    thread_id: thread_id
  } do
    # bob joins via invite and holds NO roles — base bits only.
    invite = post(conn_for(alice), "/api/v1/workspaces/#{ws_id}/invites", %{"max_uses" => 5})
    assert invite.status == 201
    code = Jason.decode!(invite.resp_body)["invite"]["code"]

    join = post(conn_for(bob), "/api/v1/invites/#{code}", %{})
    assert join.status == 200

    bob_conn = conn_for(bob)
    assert bob_conn |> get("/api/v1/channels/#{ch_id}/messages") |> Map.get(:status) == 200
    assert bob_conn |> get("/api/v1/threads/#{thread_id}/messages") |> Map.get(:status) == 200
    assert bob_conn |> get("/api/v1/threads/#{thread_id}/members") |> Map.get(:status) == 200
    assert bob_conn |> get("/api/v1/channels/#{ch_id}") |> Map.get(:status) == 200
    assert bob_conn |> get("/api/v1/channels/#{ch_id}/threads") |> Map.get(:status) == 200
  end

  test "thread reply works for a member (S-P2-14: the route 403'd unconditionally)", %{
    alice: alice,
    bob: bob,
    ws_id: ws_id,
    thread_id: thread_id
  } do
    invite = post(conn_for(alice), "/api/v1/workspaces/#{ws_id}/invites", %{"max_uses" => 5})
    code = Jason.decode!(invite.resp_body)["invite"]["code"]
    assert post(conn_for(bob), "/api/v1/invites/#{code}", %{}).status == 200

    reply = post(conn_for(bob), "/api/v1/threads/#{thread_id}/messages", %{"content" => "a reply"})
    assert reply.status == 201
  end

  test "member follow-state rides the verified gate + parent view gate", %{
    alice: alice,
    bob: bob,
    ws_id: ws_id,
    thread_id: thread_id
  } do
    invite = post(conn_for(alice), "/api/v1/workspaces/#{ws_id}/invites", %{"max_uses" => 5})
    code = Jason.decode!(invite.resp_body)["invite"]["code"]
    assert post(conn_for(bob), "/api/v1/invites/#{code}", %{}).status == 200

    bob_conn = conn_for(bob)
    assert bob_conn |> post("/api/v1/threads/#{thread_id}/members", %{}) |> Map.get(:status) == 201

    assert bob_conn |> patch("/api/v1/threads/#{thread_id}/members/@me", %{"notify" => false}) |> Map.get(:status) ==
             200

    assert bob_conn |> delete("/api/v1/threads/#{thread_id}/members/@me") |> Map.get(:status) == 200
  end
end
