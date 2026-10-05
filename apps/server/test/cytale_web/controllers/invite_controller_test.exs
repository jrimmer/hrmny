defmodule CytaleWeb.Controllers.InviteControllerTest do
  @moduledoc """
  U9 slice 2 — invite surface: public resolve (GET) + accept (POST) by code.
  The plan's happy path: invite creation → resolution → member added.
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, User}
  alias Cytale.Gateway.PushRegistry
  alias Cytale.Workspaces

  @endpoint CytaleWeb.Endpoint

  # Runtime (NOT compile-time) nonce: a module attribute freezes at compile
  # time and collides across `mix test` invocations (observed).
  defp run_nonce, do: "r" <> Cytale.TestNonce.get()

  defp run_unique(base), do: base <> run_nonce()

  setup do
    conn =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("content-type", "application/json")

    {:ok, owner} = User.create(run_unique("inv_owner"), run_unique("inv_owner@example.com"), "password-123")
    access = Auth.issue_access_token(owner.user_id, owner.username, true)
    conn = put_req_header(conn, "authorization", "Bearer " <> access)

    conn = post(conn, "/api/v1/workspaces", %{"name" => run_unique("Invite WS")})
    assert conn.status == 201
    ws_id = get_in(Jason.decode!(conn.resp_body), ["workspace", "id"]) || Jason.decode!(conn.resp_body)["id"]

    {:ok, conn: conn, ws_id: ws_id, owner: owner}
  end

  describe "POST /workspaces/:id/invites (member-scoped creation)" do
    test "a member mints a code the join flow accepts end-to-end", %{conn: conn, ws_id: ws_id} do
      conn_c = post(conn, "/api/v1/workspaces/#{ws_id}/invites", %{})
      assert conn_c.status == 201

      body = Jason.decode!(conn_c.resp_body)
      code = body["invite"]["code"]
      assert is_binary(code) and byte_size(code) > 8
      assert body["invite"]["workspace_id"] == ws_id

      # The minted code round-trips through the public accept flow.
      {:ok, joiner} = User.create(run_unique("inv_mk"), run_unique("inv_mk@example.com"), "password-123")
      joiner_access = Auth.issue_access_token(joiner.user_id, joiner.username, true)

      join_conn =
        Phoenix.ConnTest.build_conn()
        |> put_req_header("accept", "application/json")
        |> put_req_header("content-type", "application/json")
        |> put_req_header("authorization", "Bearer " <> joiner_access)
        |> post("/api/v1/invites/#{code}")

      assert join_conn.status == 200
      assert %{"workspace_id" => ^ws_id, "joined" => true} = Jason.decode!(join_conn.resp_body)
    end

    test "a non-member gets the workspace-shaped 404 (no oracle)", %{conn: conn, ws_id: ws_id} do
      {:ok, outsider} = User.create(run_unique("inv_out"), run_unique("inv_out@example.com"), "password-123")
      outsider_access = Auth.issue_access_token(outsider.user_id, outsider.username, true)

      conn_o =
        Phoenix.ConnTest.build_conn()
        |> put_req_header("accept", "application/json")
        |> put_req_header("content-type", "application/json")
        |> put_req_header("authorization", "Bearer " <> outsider_access)
        |> post("/api/v1/workspaces/#{ws_id}/invites", %{})

      assert conn_o.status == 404
      assert %{"error" => %{"key" => "workspace_not_found"}} = Jason.decode!(conn_o.resp_body)
    end
  end

  test "create → resolve → accept joins the workspace (plan happy path)", %{
    conn: conn,
    ws_id: ws_id,
    owner: owner
  } do
    {:ok, invite} =
      Workspaces.create_invite(String.to_integer(ws_id), owner.user_id, max_age_s: 600)

    # Resolve: workspace summary, no oracle (authed scope per router).
    conn_r = get(conn, "/api/v1/invites/#{invite.invite_code}")
    assert conn_r.status == 200

    body = Jason.decode!(conn_r.resp_body)
    assert body["invite"]["code"] == invite.invite_code

    # Accept: second user joins.
    {:ok, joiner} = User.create(run_unique("inv_join"), run_unique("inv_join@example.com"), "password-123")
    joiner_access = Auth.issue_access_token(joiner.user_id, joiner.username, true)

    join_conn =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("content-type", "application/json")
      |> put_req_header("authorization", "Bearer " <> joiner_access)

    conn_a = post(join_conn, "/api/v1/invites/#{invite.invite_code}")
    assert conn_a.status == 200
    assert %{"workspace_id" => ^ws_id, "joined" => true} = Jason.decode!(conn_a.resp_body)

    # Member visible in the roster (workspace show embeds members).
    conn_m = get(conn, "/api/v1/workspaces/#{ws_id}")
    assert conn_m.status == 200

    member_ids =
      Jason.decode!(conn_m.resp_body)["members"]
      |> Enum.map(&get_in(&1, ["user", "id"]))

    assert Integer.to_string(joiner.user_id) in member_ids
  end

  test "resolve unknown code → 404 invite_not_found", %{conn: conn} do
    conn = get(conn, "/api/v1/invites/nope-nope-nope")
    assert conn.status == 404
    assert %{"error" => %{"key" => "invite_not_found"}} = Jason.decode!(conn.resp_body)
  end

  test "accept after revoke → 404", %{conn: conn, ws_id: ws_id, owner: owner} do
    {:ok, invite} =
      Workspaces.create_invite(String.to_integer(ws_id), owner.user_id, max_age_s: 600)

    :ok = Workspaces.revoke_invite(invite.invite_code)

    {:ok, joiner} = User.create(run_unique("inv_rev"), run_unique("inv_rev@example.com"), "password-123")
    joiner_access = Auth.issue_access_token(joiner.user_id, joiner.username, true)

    join_conn =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("content-type", "application/json")
      |> put_req_header("authorization", "Bearer " <> joiner_access)

    conn_a = post(join_conn, "/api/v1/invites/#{invite.invite_code}")
    assert conn_a.status == 404
  end

  test "accept unauthenticated → 401", %{ws_id: ws_id, owner: owner} do
    {:ok, invite} =
      Workspaces.create_invite(String.to_integer(ws_id), owner.user_id, max_age_s: 600)

    anon = Phoenix.ConnTest.build_conn() |> put_req_header("content-type", "application/json")
    conn = post(anon, "/api/v1/invites/#{invite.invite_code}")
    assert conn.status == 401
  end

  # #111: a session that identified BEFORE the accept hydrated an empty
  # membership set at READY and stayed deaf to the workspace's dispatches. The
  # accept path must poke the joiner's live sessions (route re-join, no
  # reconnect) while the MemberAdd fan-out keeps its pre-existing audience.
  test "accept pokes the joiner's live sessions and keeps the MemberAdd fan-out", %{
    conn: conn,
    ws_id: ws_id,
    owner: owner
  } do
    {:ok, invite} =
      Workspaces.create_invite(String.to_integer(ws_id), owner.user_id, max_age_s: 600)

    {:ok, joiner} = User.create(run_unique("inv_111"), run_unique("inv_111@example.com"), "password-123")
    joiner_access = Auth.issue_access_token(joiner.user_id, joiner.username, true)

    join_conn =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("content-type", "application/json")
      |> put_req_header("authorization", "Bearer " <> joiner_access)

    # Stand-ins for live gateway sessions (the channel_controller #55 test's
    # device — the registry's reads are liveness-filtered and address-keyed, so
    # this test process can hold both routes without a socket): every READY'd
    # session implicitly holds its USER key, and each pre-existing member's
    # session holds the workspace key.
    :ok =
      PushRegistry.subscribe(
        PushRegistry.user_key(Integer.to_string(joiner.user_id)),
        "joiner-live-session"
      )

    :ok = PushRegistry.subscribe(PushRegistry.workspace_key(ws_id), "member-live-session")

    conn_a = post(join_conn, "/api/v1/invites/#{invite.invite_code}")
    assert conn_a.status == 200

    # The joiner's session was poked to re-join its routes (the deafness fix).
    assert_receive :cytale_refresh_routes, 1_000

    # The join dispatch still reaches everyone it did before: the workspace-key
    # MemberAdd fan (pre-existing members' sessions).
    # The fan-out's pre-encoded fragment rides as a 4th element (plan 2.3).
    assert_receive {:cytale_gateway_push, _from, {"MemberAdd", payload}, _fragment}, 1_000
    assert payload["workspace_id"] == ws_id
    assert get_in(payload, ["user", "id"]) == Integer.to_string(joiner.user_id)
  end
end
