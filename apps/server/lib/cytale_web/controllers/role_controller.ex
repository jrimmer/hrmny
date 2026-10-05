defmodule CytaleWeb.RoleController do
  @moduledoc """
  U9 — role surface (workspace tier). Reads gate on workspace membership
  (role metadata is member-visible, Discord parity — but the workspace
  itself is not an oracle: a non-member gets the workspace 404). Every
  mutation is gated twice: MANAGE_ROLES by the pipeline, then role
  HIERARCHY through the shared engine seam (`Cytale.Permissions.
  Hierarchy` — #35 P0-4): strict position bound, no self-targeting
  grants/revokes, no mutating a role the actor holds. The hierarchy check
  lives beside the resolver so every surface inherits it.
  """

  use CytaleWeb, :controller

  alias Cytale.Permissions.Hierarchy
  alias Cytale.Permissions.RightsEpoch
  alias Cytale.Workspaces
  import CytaleWeb.API.Params, only: [snowflake: 1]
  import CytaleWeb.API.Error, only: [error: 4]

  @doc "GET /workspaces/:id/roles — hierarchy order (position DESC)."
  def index(conn, %{"workspace_id" => ws_id}) do
    %{user_id: user_id} = conn.assigns.current_user

    with {:ok, workspace_id} <- snowflake(ws_id),
         true <- Workspaces.get_workspace(workspace_id) != nil,
         true <- Workspaces.get_member(workspace_id, user_id) != nil do
      roles =
        Workspaces.list_roles(workspace_id)
        |> Enum.map(&role_json/1)

      json(conn, %{"roles" => roles})
    else
      _ -> error(conn, 404, "workspace_not_found", "No workspace with that id")
    end
  end

  @doc "POST /workspaces/:id/roles."
  def create(conn, %{"workspace_id" => ws_id, "name" => name} = params) do
    with {:ok, workspace_id} <- snowflake(ws_id),
         true <- Workspaces.get_workspace(workspace_id) != nil,
         position <- parse_int(params["position"], 1),
         :ok <-
           Hierarchy.manage_role(workspace_id, conn.assigns.current_user, target_position: position),
         {:ok, permissions} <- permissions_param(params, 0),
         :ok <- Hierarchy.grant_bits(workspace_id, conn.assigns.current_user, permissions),
         {:ok, role} <-
           Workspaces.create_role(workspace_id, name,
             permissions: permissions,
             position: position,
             color: parse_int(params["color"], nil)
           ) do
      # Rights mutation (KTD4): consumers recompute on the next check.
      RightsEpoch.bump(workspace_id)

      conn |> put_status(201) |> json(%{"role" => role_json(role)})
    else
      {:error, :forbidden} ->
        error(conn, 403, "forbidden", "You cannot create a role at that position or with those permissions.")

      {:error, :bad_permissions} ->
        error(conn, 400, "validation_failed", "permissions must be a non-negative integer bitfield")

      _ ->
        error(conn, 404, "workspace_not_found", "No workspace with that id")
    end
  end

  def create(conn, _params), do: error(conn, 400, "validation_failed", "name is required")

  @doc "GET /workspaces/:id/roles/:role_id."
  def show(conn, %{"workspace_id" => ws_id, "role_id" => r_id}) do
    %{user_id: user_id} = conn.assigns.current_user

    with {:ok, workspace_id} <- snowflake(ws_id),
         {:ok, role_id} <- snowflake(r_id),
         true <- Workspaces.get_member(workspace_id, user_id) != nil,
         role when not is_nil(role) <- find_role(workspace_id, role_id) do
      json(conn, %{"role" => role_json(role)})
    else
      _ -> error(conn, 404, "role_not_found", "No such role")
    end
  end

  @doc "PATCH /workspaces/:id/roles/:role_id."
  def update(conn, %{"workspace_id" => ws_id, "role_id" => r_id} = params) do
    with {:ok, workspace_id} <- snowflake(ws_id),
         {:ok, role_id} <- snowflake(r_id),
         role when not is_nil(role) <- find_role(workspace_id, role_id),
         new_position <- parse_int(params["position"], role.position),
         :ok <-
           Hierarchy.manage_role(workspace_id, conn.assigns.current_user,
             target_position: role.position,
             new_position: new_position,
             target_role_id: role.role_id
           ),
         # An omitted `permissions` KEEPS the role's mask (it used to reset it
         # to 0 — a rename silently stripped every permission).
         {:ok, permissions} <- permissions_param(params, role.permissions),
         :ok <-
           Hierarchy.grant_bits(
             workspace_id,
             conn.assigns.current_user,
             Bitwise.band(permissions, Bitwise.bnot(role.permissions))
           ) do
      :ok =
        Workspaces.update_role(workspace_id, role_id, %{
          name: params["name"] || role.name,
          permissions: permissions,
          position: new_position,
          color: parse_int(params["color"], role.color)
        })

      RightsEpoch.bump(workspace_id)

      json(conn, %{"role" => role_json(find_role(workspace_id, role_id))})
    else
      {:error, :forbidden} ->
        error(conn, 403, "forbidden", "You cannot modify this role (hierarchy or permissions you do not hold).")

      {:error, :bad_permissions} ->
        error(conn, 400, "validation_failed", "permissions must be a non-negative integer bitfield")

      _ ->
        error(conn, 404, "role_not_found", "No such role")
    end
  end

  @doc "DELETE /workspaces/:id/roles/:role_id."
  def delete(conn, %{"workspace_id" => ws_id, "role_id" => r_id}) do
    with {:ok, workspace_id} <- snowflake(ws_id),
         {:ok, role_id} <- snowflake(r_id),
         role when not is_nil(role) <- find_role(workspace_id, role_id),
         :ok <-
           Hierarchy.manage_role(workspace_id, conn.assigns.current_user,
             target_position: role.position,
             target_role_id: role.role_id
           ) do
      :ok = Workspaces.delete_role(workspace_id, role_id)
      RightsEpoch.bump(workspace_id)
      json(conn, %{"deleted" => Integer.to_string(role.role_id)})
    else
      {:error, :forbidden} ->
        error(conn, 403, "forbidden", "You cannot delete this role (hierarchy).")

      _ ->
        error(conn, 404, "role_not_found", "No such role")
    end
  end

  @doc "PUT /workspaces/:id/roles/:role_id/members/:user_id — grant."
  def grant(conn, %{"workspace_id" => ws_id, "role_id" => r_id, "user_id" => u_id}) do
    with {:ok, workspace_id} <- snowflake(ws_id),
         {:ok, role_id} <- snowflake(r_id),
         {:ok, target_id} <- snowflake(u_id),
         role when not is_nil(role) <- find_role(workspace_id, role_id),
         :ok <-
           Hierarchy.manage_role(workspace_id, conn.assigns.current_user,
             target_position: role.position,
             target_role_id: role.role_id,
             target_user_id: target_id
           ),
         member when not is_nil(member) <- Workspaces.get_member(workspace_id, target_id) do
      :ok = Workspaces.grant_role(workspace_id, target_id, role_id)
      RightsEpoch.bump(workspace_id)
      json(conn, %{"granted" => Integer.to_string(role_id)})
    else
      {:error, :forbidden} ->
        error(conn, 403, "forbidden", "You cannot grant this role (hierarchy).")

      _ ->
        error(conn, 404, "role_not_found", "No such role or member")
    end
  end

  @doc "DELETE /workspaces/:id/roles/:role_id/members/:user_id — revoke."
  def revoke(conn, %{"workspace_id" => ws_id, "role_id" => r_id, "user_id" => u_id}) do
    with {:ok, workspace_id} <- snowflake(ws_id),
         {:ok, role_id} <- snowflake(r_id),
         {:ok, target_id} <- snowflake(u_id),
         role when not is_nil(role) <- find_role(workspace_id, role_id),
         :ok <-
           Hierarchy.manage_role(workspace_id, conn.assigns.current_user,
             target_position: role.position,
             target_role_id: role.role_id,
             target_user_id: target_id
           ) do
      :ok = Workspaces.revoke_role(workspace_id, target_id, role_id)
      RightsEpoch.bump(workspace_id)
      json(conn, %{"revoked" => Integer.to_string(role_id)})
    else
      {:error, :forbidden} ->
        error(conn, 403, "forbidden", "You cannot revoke this role (hierarchy).")

      _ ->
        error(conn, 404, "role_not_found", "No such role")
    end
  end

  # -- helpers -------------------------------------------------------------------

  defp find_role(workspace_id, role_id) do
    Workspaces.list_roles(workspace_id)
    |> Enum.find(&(&1.role_id == role_id))
  end

  defp role_json(r) do
    %{
      "id" => Integer.to_string(r.role_id),
      "name" => r.name,
      # Decimal STRING on the wire (>53-bit safety, U2 convention).
      "permissions" => Integer.to_string(r.permissions),
      "position" => r.position,
      "color" => r.color
    }
  end

  # The requested bitfield, or `default` when the key is absent (create: 0;
  # edit: the role's current mask). A present-but-malformed value is a 400,
  # never a silent 0.
  defp permissions_param(params, default) do
    case Map.fetch(params, "permissions") do
      :error -> {:ok, default}
      {:ok, nil} -> {:ok, default}
      {:ok, n} when is_integer(n) and n >= 0 -> {:ok, n}
      {:ok, bin} when is_binary(bin) -> parse_bitfield(bin)
      {:ok, _} -> {:error, :bad_permissions}
    end
  end

  defp parse_bitfield(bin) do
    case Integer.parse(bin) do
      {n, ""} when n >= 0 -> {:ok, n}
      _ -> {:error, :bad_permissions}
    end
  end

  defp parse_int(nil, default), do: default

  defp parse_int(bin, _default) when is_integer(bin), do: bin

  defp parse_int(bin, default) when is_binary(bin) do
    case Integer.parse(bin) do
      {n, ""} -> n
      _ -> default
    end
  end
end
