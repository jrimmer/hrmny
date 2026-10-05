defmodule CytaleWeb.WorkspaceController do
  @moduledoc """
  U9 — workspace surface (app tier): create, list mine, read, update (admin),
  delete (owner). Ids are snowflake strings on the wire (integer-native
  below this boundary).
  """

  use CytaleWeb, :controller

  alias Cytale.Permissions.Principal, as: PrincipalRights
  alias Cytale.Permissions.RightsEpoch
  alias Cytale.Workspaces
  import Cytale.Workspaces, only: [put_attribution: 2]
  import CytaleWeb.API.Params, only: [parse_limit: 2, snowflake: 1, snowflake_opt: 1]
  import CytaleWeb.API.Error, only: [error: 4]

  @doc "POST /workspaces — create; creator becomes owner + first member."
  def create(conn, %{"name" => name}) do
    %{user_id: user_id} = conn.assigns.current_user

    case Workspaces.create_workspace(user_id, name) do
      {:ok, ws} ->
        # #111: the creator's membership is granted to a possibly-live session
        # that identified before the workspace existed — READY subscribed it to
        # nothing here. The user-key poke re-joins its routes (additive) so the
        # new workspace's dispatches reach it without a reconnect.
        CytaleWeb.GatewaySocket.refresh_user_routes(user_id)

        conn
        |> put_status(201)
        |> json(%{"workspace" => workspace_json(ws)})

      {:error, :invalid_name} ->
        error(conn, 400, "validation_failed", "name must be 2-100 characters")

      {:error, :name_taken} ->
        error(conn, 409, "name_taken", "A workspace with that name already exists.")
    end
  end

  def create(conn, _params), do: error(conn, 400, "validation_failed", "name is required")

  @doc "GET /users/@me/workspaces — workspaces of the current user."
  def index(conn, _params) do
    %{user_id: user_id} = conn.assigns.current_user

    workspaces =
      Workspaces.workspaces_of_user(user_id)
      |> Enum.map(&workspace_json/1)

    json(conn, %{"workspaces" => workspaces})
  end

  @doc "GET /workspaces/{id} — members may read."
  def show(conn, %{"workspace_id" => id} = params) do
    with {:ok, ws_id} <- snowflake(id),
         ws when not is_nil(ws) <- Workspaces.get_workspace(ws_id),
         true <- member?(ws_id, conn) do
      members =
        Workspaces.list_members(ws_id,
          limit: parse_limit(params["limit"], default: 50, cap: 100),
          before: snowflake_opt(params["before"]),
          include_principals: true
        )
        |> Enum.map(&member_json/1)

      json(conn, %{
        "workspace" => workspace_json(ws),
        "members" => members,
        # The CALLER's effective workspace-level bits (decimal string, the
        # bitfield wire form) — what lets a client hide what it cannot do
        # (e.g. Invite People without CREATE_INVITES). Channel overwrites do
        # not apply at this level. nil when the resolve fails.
        "permissions" => viewer_permissions(ws_id, conn.assigns.current_user)
      })
    else
      _ -> error(conn, 404, "workspace_not_found", "No workspace with that id")
    end
  end

  defp viewer_permissions(ws_id, claims) do
    case PrincipalRights.resolve(ws_id, claims, nil) do
      {:ok, bits} -> Integer.to_string(bits)
      _ -> nil
    end
  end

  @doc """
  PATCH /workspaces/{id} — rename and/or icon clear (admin gate via
  pipeline). The icon can only be CLEARED here (explicit null/"" — setting
  it is exclusively the upload endpoint's job, so every icon_url in the
  table was stored through the shared validated upload path).
  """
  def update(conn, %{"workspace_id" => id} = params)
      when is_map_key(params, "name") or is_map_key(params, "icon_url") do
    with :ok <- check_icon_clear(params),
         {:ok, ws_id} <- snowflake(id),
         ws when not is_nil(ws) <- Workspaces.get_workspace(ws_id),
         :ok <- maybe_rename(params, ws_id),
         :ok <- maybe_clear_icon(params, ws_id) do
      json(conn, %{"workspace" => workspace_json(Workspaces.get_workspace(ws_id))})
    else
      {:error, :invalid_icon} ->
        error(conn, 400, "validation_failed", "icon_url can only be cleared here; use the icon upload endpoint.")

      {:error, :invalid_name} ->
        error(conn, 400, "validation_failed", "name must be 2-100 characters")

      # The rename lost the instance-wide name race (or the name is held by
      # another workspace): 409, not 400 — the request was well-formed.
      {:error, :name_taken} ->
        error(conn, 409, "name_taken", "That workspace name is already taken")

      _ ->
        error(conn, 404, "workspace_not_found", "No workspace with that id")
    end
  end

  def update(conn, _params), do: error(conn, 400, "validation_failed", "name or icon_url is required")

  # A present icon_url key must carry an explicit clear (nil/""); absent
  # key = unchanged.
  defp check_icon_clear(params) do
    if is_map_key(params, "icon_url") and not clearable_icon?(params["icon_url"]) do
      {:error, :invalid_icon}
    else
      :ok
    end
  end

  # Absent name = unchanged; a present name renames.
  defp maybe_rename(params, ws_id) do
    case Map.get(params, "name") do
      nil -> :ok
      name -> Workspaces.rename_workspace(ws_id, name)
    end
  end

  defp maybe_clear_icon(params, ws_id) do
    if is_map_key(params, "icon_url"), do: Workspaces.set_icon(ws_id, nil)
    :ok
  end

  @doc """
  POST /workspaces/{id}/icon — multipart image upload (the `:avatar`
  purpose: 2 MB cap, 4096px max dimension, raster images only), stored content-addressed and set
  as `icon_url` atomically with the upload. Admin surface (same gate as
  rename).
  """
  def upload_icon(conn, %{"workspace_id" => id} = params) do
    with {:ok, ws_id} <- snowflake(id),
         ws when not is_nil(ws) <- Workspaces.get_workspace(ws_id),
         {:ok, upload} <- Cytale.Attachments.Upload.extract(params),
         {:ok, descriptor} <- Cytale.Attachments.Upload.validate_and_store(upload, :avatar) do
      :ok = Workspaces.set_icon(ws_id, descriptor["url"])

      conn
      |> put_status(201)
      |> json(%{"workspace" => workspace_json(Workspaces.get_workspace(ws_id))})
    else
      {:error, :no_file} ->
        error(conn, 400, "validation_failed", "A file upload is required.")

      {:error, :too_large} ->
        cap_mb =
          String.trim_trailing(to_string(Float.round(Cytale.Config.avatar_max_upload_bytes() / 1024 / 1024, 1)), ".0")

        error(conn, 413, "file_too_large", "Icon exceeds the #{cap_mb} MB cap.")

      {:error, :dimensions_exceeded} ->
        max_dim = Cytale.Config.avatar_max_dimension()
        error(conn, 400, "validation_failed", "Icon image must be at most #{max_dim} pixels on a side.")

      {:error, :disallowed_mime} ->
        error(conn, 415, "unsupported_media_type", "Icons must be PNG, JPEG, GIF, or WebP.")

      {:error, :volume_full} ->
        error(conn, 507, "storage_full", "Attachment storage is full; try again later.")

      _ ->
        error(conn, 404, "workspace_not_found", "No workspace with that id")
    end
  end

  def upload_icon(conn, _params), do: error(conn, 400, "validation_failed", "workspace_id is required")

  # PATCH icon semantics: only an explicit clear (nil/"" — absent key means
  # unchanged via the clause guard). A non-empty icon_url is refused: uploads
  # go through the icon endpoint so the stored url always references a
  # validated, content-addressed blob.
  defp clearable_icon?(nil), do: true
  defp clearable_icon?(""), do: true
  defp clearable_icon?(_), do: false

  @doc """
  DELETE /workspaces/{id} — owner only. A real delete
  (`Workspaces.delete_workspace/1`): the workspace is tombstoned first, so
  every gate refuses it from that write on; its webhooks are deleted, its
  invites die with it, and every member is removed. Each member's live
  sessions get their `MemberRemove` and lose the workspace's routes; the
  channel rows are purged in the background.
  """
  def delete(conn, %{"workspace_id" => id}) do
    %{user_id: user_id} = conn.assigns.current_user

    with {:ok, ws_id} <- snowflake(id),
         ws when not is_nil(ws) <- Workspaces.get_workspace(ws_id) do
      if ws.owner_id == user_id do
        case Workspaces.delete_workspace(ws_id) do
          {:ok, %{member_ids: member_ids, channel_ids: channel_ids}} ->
            announce_workspace_gone(ws_id, member_ids, channel_ids)
            start_channel_purge(ws_id, channel_ids)
            json(conn, %{"deleted" => Integer.to_string(ws_id)})

          {:error, :not_found} ->
            error(conn, 404, "workspace_not_found", "No workspace with that id")
        end
      else
        error(conn, 403, "forbidden", "Only the workspace owner may delete it.")
      end
    else
      _ -> error(conn, 404, "workspace_not_found", "No workspace with that id")
    end
  end

  # Each former member hears about their OWN removal on their user key (one
  # event per member — not N events to N sockets on the workspace key), then
  # loses the workspace's routes on live and held sessions alike (Tier 1's
  # kick revocation, with the channel list read once).
  defp announce_workspace_gone(ws_id, member_ids, channel_ids) do
    ws = Integer.to_string(ws_id)

    Enum.each(member_ids, fn member_id ->
      CytaleWeb.GatewaySocket.fan_out(
        Cytale.Gateway.PushRegistry.user_key(Integer.to_string(member_id)),
        {"MemberRemove", %{"user_id" => Integer.to_string(member_id), "workspace_id" => ws}}
      )

      CytaleWeb.GatewaySocket.revoke_workspace_routes(member_id, ws_id, channel_ids)
    end)
  end

  # The channel rows go in the background under an existing Task.Supervisor
  # (the account-deletion sweep's); the tombstone already made them
  # unreachable, so a node without that supervisor (a bare script context)
  # simply skips the purge.
  defp start_channel_purge(ws_id, channel_ids) do
    Task.Supervisor.start_child(Cytale.Accounts.Deletion.SweepSupervisor, fn ->
      Workspaces.purge_workspace_channels(ws_id, channel_ids)
    end)

    :ok
  catch
    :exit, _ -> :ok
  end

  # -- helpers -------------------------------------------------------------------

  defp member?(ws_id, conn) do
    Workspaces.get_member(ws_id, conn.assigns.current_user.user_id) != nil
  end

  # Public for the native READY (lane D #5): the gateway hands the client the
  # same workspace rows this index does, so the two readings cannot drift.
  @doc false
  def workspace_json(ws) do
    %{
      "id" => Integer.to_string(ws.workspace_id),
      "name" => ws.name,
      # Stringified like "id" (and like the compat codec) — snowflakes over
      # JSON numbers lose >2^53 precision; the create response already
      # stringified this field.
      "owner_id" => ws.owner_id && Integer.to_string(ws.owner_id),
      "created_at" => DateTime.to_iso8601(ws.created_at),
      "icon_url" => ws.icon_url
    }
  end

  defp member_json(m) do
    %{
      "user" => %{
        "id" => Integer.to_string(m.user_id),
        "username" => m.username,
        "display_name" => Map.get(m, :display_name),
        "avatar_url" => m.avatar_url
      },
      "nickname" => m.nickname,
      "joined_at" => m.joined_at && DateTime.to_iso8601(m.joined_at),
      "roles" => Enum.map(m.roles || [], &Integer.to_string/1)
    }
    |> put_attribution(m)
  end

  @doc """
  PATCH /workspaces/{id}/members/@me and /members/{user_id} — set or clear
  (`{"nickname": null}` or blank) a member's workspace nickname (#169). Your
  own needs CHANGE_NICKNAME; anyone else's MANAGE_NICKNAMES below you in the
  role hierarchy. People and bots alike: a bot sets its own with its token.
  Answers `{workspace_id, user_id, nickname}` and announces `MemberUpdate`.
  """
  def update_member(conn, %{"workspace_id" => ws_id, "user_id" => uid} = params) do
    claims = conn.assigns.current_user

    with {:ok, workspace_id} <- snowflake(ws_id),
         {:ok, target} <- member_target(uid, claims),
         {:ok, nickname} <- nickname_param(params),
         {:ok, nick} <- CytaleWeb.Nicknames.change(workspace_id, claims, target, nickname) do
      json(conn, %{
        "workspace_id" => Integer.to_string(workspace_id),
        "user_id" => Integer.to_string(target),
        "nickname" => nick
      })
    else
      {:error, :unknown_workspace} ->
        error(conn, 404, "workspace_not_found", "No workspace with that id")

      {:error, :not_member} ->
        error(conn, 404, "member_not_found", "That user is not a member of this workspace")

      {:error, :invalid_nickname} ->
        error(conn, 400, "validation_failed", "nickname must be a string of at most 32 characters, or null")

      {:error, :forbidden} ->
        error(conn, 403, "forbidden", "You cannot change that member's nickname.")

      {:error, :name_taken} ->
        error(conn, 409, "name_taken", "Someone in this workspace already goes by that name.")

      _ ->
        error(conn, 400, "validation_failed", "Invalid workspace or user id")
    end
  end

  defp member_target("@me", %{user_id: me}), do: {:ok, me}
  defp member_target(uid, _claims), do: snowflake(uid)

  # `nickname` must be present (null clears): a PATCH without it is a mistake,
  # not a silent clear.
  defp nickname_param(%{"nickname" => nick}) when is_binary(nick) or is_nil(nick), do: {:ok, nick}
  defp nickname_param(%{"nickname" => _}), do: {:error, :invalid_nickname}
  defp nickname_param(_), do: {:error, :invalid_nickname}

  @doc """
  GET /workspaces/{id}/members — the membership roster, gated by the
  principal-rights resolver (view-rights consult): members (and machine
  principals whose PARENT is a member — the resolver's parent fallback)
  read; a workspace that exists but does not know the caller answers the
  same 404 as an unknown one (no existence oracle).
  """
  def members(conn, %{"workspace_id" => ws_id}) do
    with {:ok, workspace_id} <- snowflake(ws_id),
         true <- Workspaces.get_workspace(workspace_id) != nil,
         {:ok, _bits} <- PrincipalRights.resolve(workspace_id, conn.assigns.current_user, nil) do
      members =
        Workspaces.list_members(workspace_id, include_principals: true)
        |> Enum.map(fn m ->
          %{
            "user_id" => Integer.to_string(m.user_id),
            "username" => m.username,
            "display_name" => Map.get(m, :display_name),
            "avatar_url" => m.avatar_url,
            "nickname" => m.nickname,
            "roles" => Enum.map(m.roles || [], &Integer.to_string/1),
            "joined_at" => m.joined_at && DateTime.to_iso8601(m.joined_at)
          }
          |> put_attribution(m)
        end)

      json(conn, %{"members" => members})
    else
      # Not a member reads exactly like an unknown workspace (Tier 3 B, 11):
      # the 403 confirmed that the id was a real workspace.
      _ ->
        error(conn, 404, "workspace_not_found", "No workspace with that id")
    end
  end

  @doc """
  DELETE /workspaces/{id}/members/{user_id} — remove a member (kick).
  KICK_MEMBERS (the route's pipeline) plus the hierarchy gate
  (`Hierarchy.kick_member/3`): never the owner, never yourself, and only a
  member whose highest role sits strictly below the actor's.
  """
  def kick(conn, %{"workspace_id" => ws_id, "user_id" => uid}) do
    %{user_id: actor} = conn.assigns.current_user

    with {:ok, workspace_id} <- snowflake(ws_id),
         {:ok, user_id} <- snowflake(uid),
         true <- Workspaces.get_member(workspace_id, user_id) != nil,
         {:hierarchy, :ok} <-
           {:hierarchy, Cytale.Permissions.Hierarchy.kick_member(workspace_id, conn.assigns.current_user, user_id)} do
      # Read before the removal: the kicked person AND their machines whose
      # membership here rode on theirs leave the roster together.
      departures = CytaleWeb.MemberEvents.departures(user_id, workspace_id)
      :ok = Workspaces.remove_member(workspace_id, user_id)
      RightsEpoch.bump(workspace_id)

      CytaleWeb.MemberEvents.announce_departures(departures)

      # The membership is gone; the kicked user's ROUTES must go with it, or
      # their live sockets stay subscribed to the workspace's keys (and their
      # held, resumable sessions keep buffering its events) until they happen
      # to reconnect. Poked AFTER the MemberRemove above, from this process, so
      # the kicked user's own sockets still receive their removal notice first.
      CytaleWeb.GatewaySocket.revoke_workspace_routes(user_id, workspace_id)

      json(conn, %{"removed" => Integer.to_string(user_id), "actor" => Integer.to_string(actor)})
    else
      {:hierarchy, _} ->
        error(
          conn,
          403,
          "forbidden",
          "You cannot remove the owner, yourself, or a member at or above your highest role."
        )

      _ ->
        error(conn, 404, "member_not_found", "No such member in that workspace")
    end
  end
end
