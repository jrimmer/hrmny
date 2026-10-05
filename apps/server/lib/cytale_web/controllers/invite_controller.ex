defmodule CytaleWeb.InviteController do
  @moduledoc """
  U9 — invite surface (public join flow, U20 consumes): resolve (GET) and
  accept (POST) by code, plus member-scoped creation (POST /workspaces/:id/
  invites). Revocation stays an admin-tier surface.
  """

  use CytaleWeb, :controller

  alias Cytale.Permissions.{Bitfield, Principal, RightsEpoch}
  alias Cytale.Workspaces
  import CytaleWeb.API.Params, only: [snowflake: 1]
  import CytaleWeb.API.Error, only: [error: 4]

  @doc """
  POST /workspaces/:workspace_id/invites — a member holding CREATE_INVITES
  mints a join code. A non-member (or unknown workspace) gets the
  workspace-shaped 404 (no oracle); a member without the bit a 403.
  """
  def create(conn, %{"workspace_id" => ws_id} = params) do
    %{user_id: user_id} = claims = conn.assigns.current_user

    with {:ok, workspace_id} <- snowflake(ws_id),
         true <- Workspaces.get_workspace(workspace_id) != nil,
         true <- Workspaces.get_member(workspace_id, user_id) != nil,
         {:ok, bits} <- Principal.resolve_cached(workspace_id, claims, nil),
         {:permitted, true} <- {:permitted, Bitfield.has?(bits, :create_invites)} do
      max_age_s = parse_pos_int(params["max_age_s"]) || 600
      max_uses = parse_pos_int(params["max_uses"]) || 0

      {:ok, invite} = Workspaces.create_invite(workspace_id, user_id, max_age_s: max_age_s, max_uses: max_uses)

      conn
      |> put_status(201)
      |> json(%{
        "invite" => %{
          "code" => invite.invite_code,
          "workspace_id" => Integer.to_string(workspace_id),
          "expires_at" => DateTime.to_iso8601(invite.expires_at),
          "max_uses" => invite.max_uses
        }
      })
    else
      {:permitted, false} -> error(conn, 403, "forbidden", "You do not have permission to create invites.")
      _ -> error(conn, 404, "workspace_not_found", "No workspace with that id")
    end
  end

  @doc "GET /invites/:code — inspect (workspace summary only; no oracle)."
  def show(conn, %{"code" => code}) do
    case Workspaces.get_invite(code) do
      nil ->
        error(conn, 404, "invite_not_found", "No such invite (or it expired).")

      invite ->
        ws = Workspaces.get_workspace(invite.workspace_id)

        json(conn, %{
          "invite" => %{
            "code" => invite.invite_code,
            "workspace" => ws && %{"id" => Integer.to_string(ws.workspace_id), "name" => ws.name},
            "expires_at" => DateTime.to_iso8601(invite.expires_at),
            "max_uses" => invite.max_uses,
            "use_count" => invite.use_count
          }
        })
    end
  end

  @doc "POST /invites/:code — accept: joins the current user to the workspace."
  def accept(conn, %{"code" => code}) do
    %{user_id: user_id} = conn.assigns.current_user

    case Workspaces.accept_invite(code, user_id) do
      {:ok, %{already_member: true} = invite} ->
        # Already a member: nothing changed, so nothing to announce or re-route.
        json(conn, %{
          "workspace_id" => Integer.to_string(invite.workspace_id),
          "joined" => true
        })

      {:ok, invite} ->
        # Member add (KTD4): the epoch bump is what tells live consumers to
        # recompute join visibility for this member's principals; the route
        # refresh below is the ACTIVE half — live principal sessions of the
        # joining parent re-run their join computation additively (the new
        # workspace's events reach live agents without a reconnect).
        RightsEpoch.bump(invite.workspace_id)
        CytaleWeb.GatewaySocket.refresh_principal_routes(user_id)
        # #111: the joiner's own HUMAN sessions are not principals — the poke
        # above reaches only machine sessions — so a socket that identified
        # before this accept (READY hydrated an empty membership set) held no
        # route in this workspace and every later dispatch here missed it.
        # The user-key poke re-subscribes each of the joiner's live sessions
        # in place, no reconnect.
        CytaleWeb.GatewaySocket.refresh_user_routes(user_id)

        # The joiner's roster row (and their granted machines'), in the people
        # page's shape — name, avatar, kind — so every open client can name
        # them the moment they speak.
        CytaleWeb.MemberEvents.announce_join(invite.workspace_id, user_id)

        json(conn, %{
          "workspace_id" => Integer.to_string(invite.workspace_id),
          "joined" => true
        })

      {:error, :invalid_invite} ->
        error(conn, 404, "invite_not_found", "No such invite (or it expired/exhausted).")
    end
  end

  defp parse_pos_int(nil), do: nil

  defp parse_pos_int(n) when is_integer(n) and n > 0, do: n

  defp parse_pos_int(n) when is_integer(n), do: nil

  defp parse_pos_int(bin) when is_binary(bin) do
    case Integer.parse(bin) do
      {int, ""} when int > 0 -> int
      _ -> nil
    end
  end
end
