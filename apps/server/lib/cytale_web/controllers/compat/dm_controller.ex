defmodule CytaleWeb.Compat.DmController do
  @moduledoc """
  The compat DM surface (bots plan B-1): Discord's user-DM routes over the
  NATIVE dm_channels storage — `POST /users/@me/channels {recipient_id}`
  opens (or fetches) a 1:1 DM and returns the Discord DM channel object
  (`type: 1`, `recipients` = the OTHER participant), `GET /users/@me/channels`
  lists the bot's DMs as a bare array. Messages/history/reactions/typing ride
  the EXISTING channel routes on the DM channel id (the channel gate resolves
  recipient membership — participation IS authorization).

  Kind guard (Discord parity, enforced in `Workspaces.open_dm/2`): only
  human↔human and human↔machine pairs; machine↔machine is a 400 50035
  (Discord disallows bot-to-bot DMs), webhooks are not DM-able, an unknown
  recipient is a 404 10013 Unknown User. `POST` answers 200 for both create
  and fetch (Discord's shape).

  DM search (B-4, CYTALE EXTENSION — not a Discord route): see
  `CytaleWeb.Compat.SearchController`.
  """

  use CytaleWeb, :controller

  alias Cytale.Snowflake
  alias CytaleWeb.Compat.{Authorize, Errors, MessageCodec}

  @doc "GET /users/@me/channels — the bot's DM channels, bare array (Discord's shape)."
  def index(conn, _params) do
    claims = conn.assigns.current_user

    dms =
      Cytale.Workspaces.dms_of_user(claims.user_id)
      |> Enum.map(fn dm ->
        MessageCodec.channel(Authorize.dm_channel_row(dm), claims.user_id)
      end)

    json(conn, dms)
  end

  @doc "POST /users/@me/channels `{recipient_id}` — open (or fetch) a DM."
  def create(conn, params) do
    claims = conn.assigns.current_user

    with {:ok, recipient_id} <- recipient(params["recipient_id"]) do
      case Cytale.Workspaces.open_dm(claims.user_id, recipient_id, require_shared: true) do
        {:ok, dm} ->
          json(conn, MessageCodec.channel(Authorize.dm_channel_row(dm), claims.user_id))

        {:error, :unknown_user} ->
          Errors.render(conn, 404, 10_013, "Unknown User")

        {:error, :invalid_pair} ->
          Errors.invalid_form_body(conn)

        # Discord's own answer for "no mutual guild / DMs closed".
        {:error, reason} when reason in [:dm_not_permitted, :no_shared_workspace] ->
          Errors.render(conn, 403, 50_007, "Cannot send messages to this user")
      end
    else
      _ -> Errors.invalid_form_body(conn)
    end
  end

  defp recipient(id) when is_binary(id) do
    case Snowflake.parse(id) do
      {:ok, int} -> {:ok, int}
      :error -> {:error, :invalid_body}
    end
  end

  defp recipient(id) when is_integer(id) and id > 0, do: {:ok, id}
  defp recipient(_), do: {:error, :invalid_body}
end
