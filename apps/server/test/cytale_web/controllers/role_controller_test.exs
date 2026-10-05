defmodule CytaleWeb.Controllers.RoleControllerTest do
  @moduledoc """
  U9 slice 2 — role admin surface: create/list/show/update/delete plus
  grant/revoke membership. Every mutation is gated by MANAGE_ROLES through
  the pipeline (owner implicitly holds it); hierarchy enforcement itself is
  U7's unit-tested contract.
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, User}

  @endpoint CytaleWeb.Endpoint

  # Runtime (NOT compile-time) nonce: a module attribute would freeze at
  # compilation and collide across `mix test` invocations (observed).
  # Runtime (NOT compile-time) nonce: a module attribute freezes at compile
  # time and collides across `mix test` invocations (observed).
  defp run_nonce, do: "r" <> Cytale.TestNonce.get()

  defp run_unique(base), do: base <> run_nonce()

  setup do
    conn =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("content-type", "application/json")

    {:ok, owner} = User.create(run_unique("role_owner"), run_unique("role_owner@example.com"), "password-123")
    access = Auth.issue_access_token(owner.user_id, owner.username, true)

    conn = put_req_header(conn, "authorization", "Bearer " <> access)

    conn = post(conn, "/api/v1/workspaces", %{"name" => run_unique("Role WS")})
    assert conn.status == 201
    ws_id = get_in(Jason.decode!(conn.resp_body), ["workspace", "id"]) || Jason.decode!(conn.resp_body)["id"]

    {:ok, conn: conn, ws_id: ws_id, owner: owner}
  end

  test "create → show → list → update → delete lifecycle (owner)", %{conn: conn, ws_id: ws_id} do
    role_name = run_unique("Moderator")
    conn = post(conn, "/api/v1/workspaces/#{ws_id}/roles", %{"name" => role_name, "color" => 1_234})
    assert conn.status == 201

    role = Jason.decode!(conn.resp_body)["role"]
    assert role["name"] == role_name
    role_id = role["id"]

    conn = get(conn, "/api/v1/workspaces/#{ws_id}/roles/#{role_id}")
    assert conn.status == 200
    assert Jason.decode!(conn.resp_body)["role"]["id"] == role_id

    conn = get(conn, "/api/v1/workspaces/#{ws_id}/roles")
    assert conn.status == 200
    ids = Jason.decode!(conn.resp_body)["roles"] |> Enum.map(& &1["id"])
    assert role_id in ids

    new_name = run_unique("Renamed")

    conn = patch(conn, "/api/v1/workspaces/#{ws_id}/roles/#{role_id}", %{"name" => new_name})

    assert conn.status == 200
    assert Jason.decode!(conn.resp_body)["role"]["name"] == new_name

    conn = delete(conn, "/api/v1/workspaces/#{ws_id}/roles/#{role_id}")
    assert conn.status == 200

    conn = get(conn, "/api/v1/workspaces/#{ws_id}/roles/#{role_id}")
    assert conn.status == 404
  end

  test "grant adds role to member; revoke removes it", %{conn: conn, ws_id: ws_id} do
    # A second user joins via invite so membership exists.
    conn = post(conn, "/api/v1/workspaces/#{ws_id}/invites", %{"max_uses" => 5})
    # Invite creation may be admin-tier; fall back to the workspaces layer if so.
    invite =
      if conn.status == 201 do
        Jason.decode!(conn.resp_body)["invite"]
      else
        {:ok, inv} = Cytale.Workspaces.create_invite(String.to_integer(ws_id), 0, max_age_s: 600)
        %{"code" => inv.invite_code}
      end

    code = invite["code"] || invite[:code]

    {:ok, member} = User.create(run_unique("role_member"), run_unique("role_member@example.com"), "password-123")
    member_access = Auth.issue_access_token(member.user_id, member.username, true)

    join_conn =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("content-type", "application/json")
      |> put_req_header("authorization", "Bearer " <> member_access)

    conn2 = post(join_conn, "/api/v1/invites/#{code}")
    assert conn2.status == 200

    # Owner creates a role and grants it.
    conn = post(conn, "/api/v1/workspaces/#{ws_id}/roles", %{"name" => run_unique("Grantable")})
    role_id = Jason.decode!(conn.resp_body)["role"]["id"]

    conn =
      put(
        conn,
        "/api/v1/workspaces/#{ws_id}/roles/#{role_id}/members/#{member.user_id}",
        %{}
      )

    assert conn.status == 200

    # Membership observable: workspace show carries the member roster.
    conn = get(conn, "/api/v1/workspaces/#{ws_id}")
    assert conn.status == 200

    member_ids =
      Jason.decode!(conn.resp_body)["members"]
      |> Enum.map(&get_in(&1, ["user", "id"]))

    assert Integer.to_string(member.user_id) in member_ids

    # The grant is observable AT THE DATA LAYER, not only as a 200: the mechanism
    # under test is the collection write (`roles = roles + ?`, 04f33c6), and a
    # controller-only assertion would pass for a handler that answered 200 and
    # wrote nothing.
    ws_id_int = String.to_integer(ws_id)
    role_id_int = String.to_integer(role_id)
    assert role_id_int in Cytale.Workspaces.get_member(ws_id_int, member.user_id).roles

    # Revoke.
    conn =
      delete(conn, "/api/v1/workspaces/#{ws_id}/roles/#{role_id}/members/#{member.user_id}")

    assert conn.status == 200

    # …and the subtraction is observable the same way. `roles = roles - ?` drops
    # EVERY occurrence, so the holder is left with no roles at all — not merely
    # one fewer. The assertion NORMALIZES nil because an empty `list<bigint>`
    # round-trips back as nil through Xandra (documented at
    # `Principal.load_member_roles/2`), which is the shape every consumer of this
    # column already has to allow for.
    after_revoke = Cytale.Workspaces.get_member(ws_id_int, member.user_id)
    refute role_id_int in (after_revoke.roles || [])
    assert (after_revoke.roles || []) == []
  end

  test "create with missing name → 400", %{conn: conn, ws_id: ws_id} do
    conn = post(conn, "/api/v1/workspaces/#{ws_id}/roles", %{})
    assert conn.status == 400
  end

  test "roles in unknown workspace → 404 workspace_not_found", %{conn: conn} do
    conn = get(conn, "/api/v1/workspaces/123456789012345678/roles")
    assert conn.status == 404
    assert %{"error" => %{"key" => "workspace_not_found"}} = Jason.decode!(conn.resp_body)
  end

  test "non-member mutation → 404 (the workspace does not exist for them)", %{ws_id: ws_id} do
    {:ok, outsider} = User.create(run_unique("role_out"), run_unique("role_out@example.com"), "password-123")
    access = Auth.issue_access_token(outsider.user_id, outsider.username, true)

    conn =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("content-type", "application/json")
      |> put_req_header("authorization", "Bearer " <> access)

    conn = post(conn, "/api/v1/workspaces/#{ws_id}/roles", %{"name" => run_unique("Sneaky")})
    assert conn.status == 404
    assert %{"error" => %{"key" => "workspace_not_found"}} = Jason.decode!(conn.resp_body)
  end

  describe "role permission bits are bounded by the actor's own (security tier 1 #4)" do
    alias Cytale.Permissions.Bitfield

    # A non-owner manager: holds MANAGE_ROLES through a role at position 5.
    defp manager(ws_id) do
      ws = String.to_integer(ws_id)
      {:ok, user} = User.create(run_unique("role_mgr"), run_unique("role_mgr@example.com"), "password-123")
      :ok = Cytale.Workspaces.add_member(ws, user.user_id, 0, [])

      {:ok, role} =
        Cytale.Workspaces.create_role(ws, run_unique("Managers"), permissions: Bitfield.bit(:manage_roles), position: 5)

      :ok = Cytale.Workspaces.grant_role(ws, user.user_id, role.role_id)
      access = Auth.issue_access_token(user.user_id, user.username, true)

      Phoenix.ConnTest.build_conn()
      |> put_req_header("content-type", "application/json")
      |> put_req_header("authorization", "Bearer " <> access)
    end

    test "a MANAGE_ROLES holder cannot mint an ADMINISTRATOR role (create)", %{ws_id: ws_id} do
      mgr = manager(ws_id)
      admin = Integer.to_string(Bitfield.bit(:administrator))

      resp = post(mgr, "/api/v1/workspaces/#{ws_id}/roles", %{"name" => run_unique("Esc"), "permissions" => admin})
      assert resp.status == 403

      refute Enum.any?(
               Cytale.Workspaces.list_roles(String.to_integer(ws_id)),
               &Bitfield.has?(&1.permissions, :administrator)
             )

      # Bits the manager DOES hold are fine.
      ok = Integer.to_string(Bitfield.bit(:send_messages))
      resp = post(mgr, "/api/v1/workspaces/#{ws_id}/roles", %{"name" => run_unique("Ok"), "permissions" => ok})
      assert resp.status == 201
    end

    test "a MANAGE_ROLES holder cannot add ADMINISTRATOR to a lower role (update)", %{conn: owner, ws_id: ws_id} do
      mgr = manager(ws_id)

      created = post(owner, "/api/v1/workspaces/#{ws_id}/roles", %{"name" => run_unique("Low"), "position" => 1})
      role_id = Jason.decode!(created.resp_body)["role"]["id"]

      admin = Integer.to_string(Bitfield.bit(:administrator))
      resp = patch(mgr, "/api/v1/workspaces/#{ws_id}/roles/#{role_id}", %{"permissions" => admin})
      assert resp.status == 403

      {:ok, rid} = {:ok, String.to_integer(role_id)}
      assert Cytale.Workspaces.get_role(String.to_integer(ws_id), rid).permissions == 0
    end

    test "the owner may still grant anything", %{conn: owner, ws_id: ws_id} do
      admin = Integer.to_string(Bitfield.bit(:administrator))
      resp = post(owner, "/api/v1/workspaces/#{ws_id}/roles", %{"name" => run_unique("Adm"), "permissions" => admin})
      assert resp.status == 201
      assert Jason.decode!(resp.resp_body)["role"]["permissions"] == admin
    end

    test "a PATCH that omits permissions keeps the role's mask", %{conn: owner, ws_id: ws_id} do
      bits = Integer.to_string(Bitfield.bor(Bitfield.bit(:manage_messages), Bitfield.bit(:kick_members)))

      created =
        post(owner, "/api/v1/workspaces/#{ws_id}/roles", %{"name" => run_unique("Mods"), "permissions" => bits})

      role_id = Jason.decode!(created.resp_body)["role"]["id"]

      resp = patch(owner, "/api/v1/workspaces/#{ws_id}/roles/#{role_id}", %{"color" => 42})
      assert resp.status == 200
      role = Jason.decode!(resp.resp_body)["role"]
      assert role["permissions"] == bits
      assert role["color"] == 42
    end
  end
end
