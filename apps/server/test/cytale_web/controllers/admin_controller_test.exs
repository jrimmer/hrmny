defmodule CytaleWeb.Controllers.AdminControllerTest do
  @moduledoc """
  U9 slice 3 — admin tier (`/api/v1/admin/...`), now behind the OPERATOR
  gate (#33): audit summary, deletion cascade status (U14 fills the sweep),
  invite listing (documented seam: empty until the per-workspace index table
  lands). The gate itself is the primary subject here: 401 unauthenticated /
  403 authenticated non-operator / 200 listed operator — fail-closed when
  the allowlist is unset, and operator ⇒ trusted (no separate verified
  check).
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, User}

  @endpoint CytaleWeb.Endpoint

  defp run_nonce, do: "r" <> Cytale.TestNonce.get()
  defp run_unique(base), do: base <> run_nonce()

  setup do
    conn =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("content-type", "application/json")

    {:ok, owner} = User.create(run_unique("adm_owner"), run_unique("adm_owner@example.com"), "password-123")
    {:ok, other} = User.create(run_unique("adm_other"), run_unique("adm_other@example.com"), "password-123")

    # The operator allowlist names the owner; tests may re-flip it (always
    # restored — the env is global and this module runs async: false).
    Application.put_env(:cytale, :operator_user_ids, [owner.user_id])

    on_exit(fn -> Application.put_env(:cytale, :operator_user_ids, []) end)

    access = Auth.issue_access_token(owner.user_id, owner.username, true)
    conn = put_req_header(conn, "authorization", "Bearer " <> access)

    ws_conn = post(conn, "/api/v1/workspaces", %{"name" => run_unique("Admin WS")})
    assert ws_conn.status == 201
    ws_id = get_in(Jason.decode!(ws_conn.resp_body), ["workspace", "id"]) || Jason.decode!(ws_conn.resp_body)["id"]

    {:ok, conn: conn, ws_id: ws_id, owner: owner, other: other}
  end

  test "unauthenticated request → 401 (Auth plug owns the surface edge)", %{ws_id: ws_id} do
    conn =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("accept", "application/json")
      |> get("/api/v1/admin/workspaces/#{ws_id}/audit")

    assert conn.status == 401
  end

  test "authenticated non-operator → 403 forbidden (was: full access, #33)", %{
    other: other,
    ws_id: ws_id
  } do
    other_access = Auth.issue_access_token(other.user_id, other.username, true)

    conn =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("authorization", "Bearer " <> other_access)
      |> get("/api/v1/admin/workspaces/#{ws_id}/audit")

    assert conn.status == 403
    assert %{"error" => %{"key" => "forbidden"}} = Jason.decode!(conn.resp_body)
  end

  test "authenticated non-operator cannot touch ANY admin route (incl. metrics reset)", %{other: other} do
    other_access = Auth.issue_access_token(other.user_id, other.username, true)

    conn =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("content-type", "application/json")
      |> put_req_header("authorization", "Bearer " <> other_access)

    assert conn |> get("/api/v1/admin/invites") |> Map.get(:status) == 403
    assert conn |> get("/api/v1/admin/metrics") |> Map.get(:status) == 403
    assert conn |> post("/api/v1/admin/metrics/reset", %{}) |> Map.get(:status) == 403
  end

  test "fail-closed: empty allowlist denies even the would-be operator", %{conn: conn, ws_id: ws_id} do
    Application.put_env(:cytale, :operator_user_ids, [])

    assert conn |> get("/api/v1/admin/workspaces/#{ws_id}/audit") |> Map.get(:status) == 403
  end

  test "listed operator passes (unverified included — operator ⇒ trusted)", %{
    ws_id: ws_id,
    owner: owner
  } do
    unverified_access = Auth.issue_access_token(owner.user_id, owner.username, false)

    unverified_conn =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("authorization", "Bearer " <> unverified_access)

    assert unverified_conn
           |> get("/api/v1/admin/workspaces/#{ws_id}/audit")
           |> Map.get(:status) == 200
  end

  test "audit returns workspace summary with counts", %{conn: conn, ws_id: ws_id} do
    conn = get(conn, "/api/v1/admin/workspaces/#{ws_id}/audit")
    assert conn.status == 200

    body = Jason.decode!(conn.resp_body)
    assert body["workspace"]["id"] == ws_id
    assert body["channel_count"] == 0
    assert body["member_count"] >= 1
    assert is_list(body["keyspace_tables"])
    assert "messages" in body["keyspace_tables"]
  end

  test "deletion cascade status endpoint answers for a member", %{conn: conn, ws_id: ws_id, owner: owner} do
    conn =
      get(conn, "/api/v1/admin/workspaces/#{ws_id}/deletion-cascade/#{owner.user_id}")

    assert conn.status == 200
  end

  test "admin invites list endpoint answers (documented empty-list seam)", %{conn: conn} do
    conn = get(conn, "/api/v1/admin/invites")
    assert conn.status == 200
    assert %{"invites" => invites} = Jason.decode!(conn.resp_body)
    assert is_list(invites)
  end

  test "audit of unknown workspace → 404", %{conn: conn} do
    conn = get(conn, "/api/v1/admin/workspaces/123456789012345678/audit")
    assert conn.status == 404
  end
end
