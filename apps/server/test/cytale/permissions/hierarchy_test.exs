defmodule Cytale.Permissions.HierarchyTest do
  @moduledoc """
  The role-hierarchy gate (#35 P0-4): strict position bound (equal denied,
  ADMINISTRATOR does not bypass), owner-exempt, no self-targeting
  grants/revokes, no mutating a role the actor holds. The HTTP-level
  escalation chains are asserted through the RoleController surface.
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Permissions.Hierarchy
  alias Cytale.Workspaces

  defp nonce, do: "h" <> Cytale.TestNonce.get()

  setup do
    {:ok, owner} = Cytale.Accounts.User.create(nonce() <> "o", nonce() <> "o@x.test", "password-123")
    {:ok, ws} = Workspaces.create_workspace(owner.user_id, nonce() <> "ws")

    claims = %{user_id: owner.user_id}

    {:ok, owner: owner, ws: ws, ws_id: ws.workspace_id, claims: claims}
  end

  test "the owner manages every role regardless of position", %{ws_id: ws_id, claims: claims} do
    assert :ok = Hierarchy.manage_role(ws_id, claims, target_position: 1)
    assert :ok = Hierarchy.manage_role(ws_id, claims, target_position: 9_999)
  end

  test "unknown workspace fails closed", %{claims: claims} do
    assert {:error, :forbidden} = Hierarchy.manage_role(987_654_321, claims, target_position: 1)
  end

  test "a manager's bound is strict: max position must EXCEED the target", %{
    ws_id: ws_id,
    owner: owner
  } do
    # The manager role sits at position 5 (and carries MANAGE_ROLES).
    {:ok, manager_role} =
      Workspaces.create_role(ws_id, nonce() <> "mgr", permissions: 16, position: 5)

    :ok = Workspaces.grant_role(ws_id, owner.user_id, manager_role.role_id)
    claims = %{user_id: owner.user_id}

    # Owner still bypasses (they own the workspace).
    assert :ok = Hierarchy.manage_role(ws_id, claims, target_position: 9_999)
  end

  test "a non-owner manager is bounded by their highest held role", %{ws_id: ws_id, owner: owner} do
    {:ok, manager} = Cytale.Accounts.User.create(nonce() <> "m", nonce() <> "m@x.test", "password-123")
    :ok = Workspaces.add_member(ws_id, manager.user_id, owner.user_id)

    {:ok, chief} = Workspaces.create_role(ws_id, nonce() <> "chief", permissions: 16, position: 5)
    {:ok, peer} = Workspaces.create_role(ws_id, nonce() <> "peer", permissions: 0, position: 5)
    {:ok, under} = Workspaces.create_role(ws_id, nonce() <> "under", permissions: 0, position: 3)

    :ok = Workspaces.grant_role(ws_id, manager.user_id, chief.role_id)
    :ok = Workspaces.grant_role(ws_id, manager.user_id, peer.role_id)
    claims = %{user_id: manager.user_id}

    # Strictly greater: a role AT the manager's max (equal, via `peer`) is
    # denied; below it is fine.
    assert {:error, :forbidden} = Hierarchy.manage_role(ws_id, claims, target_position: 5)
    assert {:error, :forbidden} = Hierarchy.manage_role(ws_id, claims, target_position: 6)
    assert :ok = Hierarchy.manage_role(ws_id, claims, target_position: 3)

    # An edit may not move the target to or above the manager's bound.
    assert {:error, :forbidden} =
             Hierarchy.manage_role(ws_id, claims,
               target_position: 3,
               new_position: 5,
               target_role_id: under.role_id
             )

    assert :ok =
             Hierarchy.manage_role(ws_id, claims,
               target_position: 3,
               new_position: 4,
               target_role_id: under.role_id
             )
  end

  test "self-targeting grants/revokes are denied even when the bound allows", %{ws_id: ws_id, owner: owner} do
    {:ok, manager} = Cytale.Accounts.User.create(nonce() <> "m2", nonce() <> "m2@x.test", "password-123")
    :ok = Workspaces.add_member(ws_id, manager.user_id, owner.user_id)

    {:ok, chief} = Workspaces.create_role(ws_id, nonce() <> "chief2", permissions: 16, position: 5)
    {:ok, low} = Workspaces.create_role(ws_id, nonce() <> "low", permissions: 0, position: 2)

    :ok = Workspaces.grant_role(ws_id, manager.user_id, chief.role_id)
    claims = %{user_id: manager.user_id}

    # Granting YOURSELF a role you don't hold is the escalation path (a).
    assert {:error, :forbidden} =
             Hierarchy.manage_role(ws_id, claims,
               target_position: low.position,
               target_role_id: low.role_id,
               target_user_id: manager.user_id
             )

    # Granting to someone else below the bound is the delegated-admin norm.
    {:ok, member} = Cytale.Accounts.User.create(nonce() <> "m3", nonce() <> "m3@x.test", "password-123")
    :ok = Workspaces.add_member(ws_id, member.user_id, owner.user_id)

    assert :ok =
             Hierarchy.manage_role(ws_id, claims,
               target_position: low.position,
               target_role_id: low.role_id,
               target_user_id: member.user_id
             )
  end

  test "mutating a role the actor holds is denied (the self-elevation path)", %{ws_id: ws_id, owner: owner} do
    {:ok, manager} = Cytale.Accounts.User.create(nonce() <> "m4", nonce() <> "m4@x.test", "password-123")
    :ok = Workspaces.add_member(ws_id, manager.user_id, owner.user_id)

    {:ok, chief} = Workspaces.create_role(ws_id, nonce() <> "chief3", permissions: 16, position: 5)
    {:ok, other_low} = Workspaces.create_role(ws_id, nonce() <> "other", permissions: 0, position: 2)

    :ok = Workspaces.grant_role(ws_id, manager.user_id, chief.role_id)
    claims = %{user_id: manager.user_id}

    # Editing the role you HOLD (e.g. adding `administrator` to its
    # bitfield) is escalation path (b) — denied even though the position
    # bound passes.
    assert {:error, :forbidden} =
             Hierarchy.manage_role(ws_id, claims,
               target_position: chief.position,
               target_role_id: chief.role_id
             )

    # A role you do NOT hold, below your bound, is manageable.
    assert :ok =
             Hierarchy.manage_role(ws_id, claims,
               target_position: other_low.position,
               target_role_id: other_low.role_id
             )
  end

  test "a non-member manager candidate fails closed", %{ws_id: ws_id} do
    {:ok, outsider} = Cytale.Accounts.User.create(nonce() <> "x", nonce() <> "x@x.test", "password-123")

    assert {:error, :forbidden} =
             Hierarchy.manage_role(ws_id, %{user_id: outsider.user_id}, target_position: 1)
  end
end
