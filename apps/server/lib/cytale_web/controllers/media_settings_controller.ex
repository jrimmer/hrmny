defmodule CytaleWeb.MediaSettingsController do
  @moduledoc """
  Calls V2 plan U8 (R16/R17) — the workspace media-settings REST surface.

  Workspace master toggles (`GET/PUT /workspaces/{id}/media-settings`):
  owner/admin tier — the routes ride the `can_manage_workspace` pipeline
  exactly like `PATCH /workspaces/{id}` (the owner holds every bit
  implicitly; admins are roles carrying MANAGE_WORKSPACE).

  Channel overrides (`GET/PUT /channels/{id}/media-override`):
  manage-channels tier, gated in-controller through the UNIFORM channel
  gate (the call_controller pattern) so a foreign channel renders the
  identical 404 `channel_not_found` anti-enumeration shape — never a 403
  oracle; a member who can view but lacks manage-channels gets the real
  403. DM channels 404 (no override surface — DM calls skip capability
  checks). A PUT against a workspace with `overrides_allowed: false` is
  the 409 `overrides_not_allowed` state conflict (the actor is properly
  permissioned; the workspace posture is what blocks).
  """

  use CytaleWeb, :controller

  alias Cytale.Permissions.Bitfield
  alias Cytale.Workspaces.MediaSettings
  alias CytaleWeb.Compat.Authorize
  import CytaleWeb.API.Params, only: [snowflake: 1]
  import CytaleWeb.API.Error, only: [error: 4]

  @doc """
  GET /workspaces/:workspace_id/media-settings — the master toggles
  (owner/admin via the router pipeline; absent row renders the defaults).
  """
  def show_workspace(conn, %{"workspace_id" => id}) do
    with {:ok, ws_id} <- snowflake(id),
         ws when not is_nil(ws) <- workspace_row(ws_id) do
      _ = ws

      json(conn, %{"media_settings" => settings_json(MediaSettings.get_workspace_settings(ws_id))})
    else
      _ -> error(conn, 404, "workspace_not_found", "No workspace with that id")
    end
  end

  @doc """
  PUT /workspaces/:workspace_id/media-settings — write the master toggles
  (owner/admin). Body keys are optional booleans; absent keys keep their
  current values: `{"calls", "video", "screenshare", "overrides_allowed"}`.
  """
  def put_workspace(conn, %{"workspace_id" => id} = params) do
    %{user_id: _} = conn.assigns.current_user

    with {:ok, ws_id} <- snowflake(id) do
      case validate_booleans(params, ~w(calls video screenshare overrides_allowed)) do
        {:ok, attrs} ->
          case MediaSettings.put_workspace_settings(ws_id, conn.assigns.current_user, attrs) do
            {:ok, settings} ->
              json(conn, %{"media_settings" => settings_json(settings)})

            {:error, :forbidden} ->
              error(conn, 403, "forbidden", "Only the workspace owner or admins may change media settings.")

            {:error, :not_found} ->
              error(conn, 404, "workspace_not_found", "No workspace with that id")
          end

        :error ->
          # The route's workspace tier already ran; a malformed body is a
          # validation failure, not an oracle.
          error(conn, 400, "validation_failed", "settings values must be booleans")
      end
    else
      _ -> error(conn, 400, "validation_failed", "workspace_id is required")
    end
  end

  @doc """
  GET /channels/:channel_id/media-override — the channel's tri-state
  override, the workspace master, and `overrides_allowed` (the channel
  manager's one read; the context menu's visibility rule consumes it).
  """
  def show_override(conn, %{"channel_id" => cid}) do
    with {:ok, channel_id} <- snowflake(cid),
         {:ok, channel, bits} <- Authorize.channel_gate(conn.assigns.current_user, channel_id),
         true <- workspace_channel?(channel) do
      if Bitfield.has?(bits, :manage_channels) do
        {:ok, view} = MediaSettings.get_channel_override_view(channel_id, conn.assigns.current_user)
        json(conn, override_view_json(view))
      else
        error(conn, 403, "forbidden", "You need the Manage Channels permission here.")
      end
    else
      _ -> error(conn, 404, "channel_not_found", "No channel with that id")
    end
  end

  @doc """
  PUT /channels/:channel_id/media-override — write the channel's override
  (manage-channels; only while the workspace allows overrides). Body keys
  are optional tri-states — a boolean writes the explicit value, `null`
  resets that capability to inherit the master.
  """
  def put_override(conn, %{"channel_id" => cid} = params) do
    with {:ok, channel_id} <- snowflake(cid),
         {:ok, channel, bits} <- Authorize.channel_gate(conn.assigns.current_user, channel_id),
         true <- workspace_channel?(channel) do
      if Bitfield.has?(bits, :manage_channels) do
        case validate_tri_states(params) do
          {:ok, attrs} ->
            case MediaSettings.put_channel_override(channel_id, conn.assigns.current_user, attrs) do
              {:ok, _override} ->
                {:ok, view} =
                  MediaSettings.get_channel_override_view(channel_id, conn.assigns.current_user)

                json(conn, override_view_json(view))

              {:error, :overrides_not_allowed} ->
                error(conn, 409, "overrides_not_allowed", "This workspace does not allow channel media overrides.")

              {:error, :forbidden} ->
                error(conn, 403, "forbidden", "You need the Manage Channels permission here.")
            end

          :error ->
            error(conn, 400, "validation_failed", "override values must be booleans or null")
        end
      else
        error(conn, 403, "forbidden", "You need the Manage Channels permission here.")
      end
    else
      _ -> error(conn, 404, "channel_not_found", "No channel with that id")
    end
  end

  # -- shapes ------------------------------------------------------------------

  defp settings_json(settings) do
    %{
      "calls" => settings.calls,
      "video" => settings.video,
      "screenshare" => settings.screenshare,
      "overrides_allowed" => settings.overrides_allowed
    }
  end

  defp override_view_json(view) do
    %{
      "override" => %{
        "calls" => view.override.calls,
        "video" => view.override.video,
        "screenshare" => view.override.screenshare
      },
      "overrides_allowed" => view.master.overrides_allowed,
      "master" => settings_json(view.master)
    }
  end

  # -- validation -----------------------------------------------------------------

  # Only the known boolean keys ride through; every PRESENT value must be
  # a boolean (absent keys keep their current values; unknown keys are
  # ignored — forward-compat posture).
  defp validate_booleans(params, keys) do
    attrs =
      Map.new(keys, fn key ->
        {String.to_atom(key), params[key]}
      end)
      |> Map.reject(fn {_k, v} -> is_nil(v) end)

    if Enum.all?(attrs, fn {_k, v} -> is_boolean(v) end) do
      {:ok, attrs}
    else
      :error
    end
  end

  # Tri-state variant for overrides: boolean | null (null resets to
  # inherit). JSON null and an absent key both arrive as nil at the
  # action, so the null-reset distinction rides Map.has_key?/2 on the raw
  # body params — a null-valued key IS present.
  defp validate_tri_states(params) do
    attrs =
      Map.new(~w(calls video screenshare), fn key ->
        {String.to_atom(key), params[key]}
      end)
      |> Map.filter(fn {k, _v} -> Map.has_key?(params, Atom.to_string(k)) end)

    if Enum.all?(attrs, fn {_k, v} -> is_boolean(v) or is_nil(v) end) do
      {:ok, attrs}
    else
      :error
    end
  end

  # -- misc -----------------------------------------------------------------------

  defp workspace_channel?(%{workspace_id: workspace_id}) when is_integer(workspace_id), do: true
  defp workspace_channel?(_dm), do: false

  defp workspace_row(ws_id), do: Cytale.Workspaces.get_workspace(ws_id)
end
