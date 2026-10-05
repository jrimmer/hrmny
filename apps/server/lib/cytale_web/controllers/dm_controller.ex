defmodule CytaleWeb.DmController do
  @moduledoc """
  U9 — DM channel surface: list the current user's DMs, open a 1:1 DM.
  DMs ARE channels — the message endpoints apply unchanged.

  B-1 (bots): the paths are principal-aware — a machine principal may open
  (and list) its own DMs; `Workspaces.open_dm/2` enforces the kind guard
  (human↔human and human↔machine only; machine↔machine is a 400, webhooks
  are not DM-able, Discord parity).
  """

  use CytaleWeb, :controller

  alias Cytale.Workspaces
  import CytaleWeb.API.Params, only: [snowflake: 1]
  import CytaleWeb.API.Error, only: [error: 4]

  @doc "GET /users/@me/channels — the user's DM channels."
  def index(conn, _params) do
    %{user_id: user_id} = conn.assigns.current_user

    json(conn, %{"channels" => list_json(user_id)})
  end

  @doc """
  The caller's DM channels in the wire shape `GET /users/@me/channels`
  answers. Public for the native READY (lane D #5), which carries the same
  list so the home column needs no boot fetch of its own.
  """
  @spec list_json(integer()) :: [map()]
  def list_json(user_id) when is_integer(user_id) do
    dms = Workspaces.dms_of_user(user_id)

    # One batched users read resolves every peer's summary (username +
    # avatar_url) for the whole page — the DM column renders its peer from
    # `recipients` with no roster dependency.
    peers =
      dms
      |> Enum.flat_map(&(&1.user_ids || []))
      |> Enum.reject(&(&1 == user_id))
      |> Cytale.Accounts.User.get_many()

    Enum.map(dms, fn dm ->
      %{
        "id" => Integer.to_string(dm.channel_id),
        "user_ids" => Enum.map(dm.user_ids || [], &Integer.to_string/1),
        "recipients" => recipient_summaries(dm.user_ids || [], user_id, peers),
        "created_at" => dm.created_at && DateTime.to_iso8601(dm.created_at),
        "last_message_id" => dm.last_message_id && Integer.to_string(dm.last_message_id)
      }
    end)
  end

  @doc "POST /users/:user_id/channels — open (or fetch) a DM with a user."
  def create(conn, %{"user_id" => uid}) do
    %{user_id: me} = conn.assigns.current_user

    with {:ok, other} <- snowflake(uid) do
      case Workspaces.open_dm(me, other, require_shared: true) do
        {:ok, dm} ->
          peer = Cytale.Accounts.User.get(other)

          conn
          |> put_status(if(dm.created?, do: 201, else: 200))
          |> json(%{
            "channel" => %{
              "id" => Integer.to_string(dm.channel_id),
              "user_ids" => Enum.map(dm.user_ids || [], &Integer.to_string/1),
              "recipients" =>
                recipient_summaries(dm.user_ids || [], me, %{other => peer} |> Map.reject(fn {_k, v} -> is_nil(v) end)),
              "created_at" => dm.created_at && DateTime.to_iso8601(dm.created_at),
              "last_message_id" => dm.last_message_id && Integer.to_string(dm.last_message_id)
            }
          })

        {:error, :unknown_user} ->
          error(conn, 404, "user_not_found", "No user with that id")

        {:error, :invalid_pair} ->
          error(conn, 400, "validation_failed", "DMs require a human participant (no bot-to-bot DMs)")

        {:error, :dm_not_permitted} ->
          error(conn, 403, "forbidden", "This account does not accept direct messages")

        {:error, :no_shared_workspace} ->
          error(conn, 403, "forbidden", "You can only start a direct message with someone you share a workspace with")
      end
    else
      _ -> error(conn, 400, "validation_failed", "user_id must be another user's snowflake")
    end
  end

  def create(conn, _params), do: error(conn, 400, "validation_failed", "user_id is required")

  # Discord-parity recipients: the OTHER participants as full user summaries
  # (`{id, username, display_name, avatar_url}`) — the DM column's peer
  # rendering surface.
  defp recipient_summaries(user_ids, viewer_id, users_by_id) do
    user_ids
    |> Enum.reject(&(&1 == viewer_id))
    |> Enum.map(fn uid ->
      case Map.get(users_by_id, uid) do
        nil ->
          %{"id" => Integer.to_string(uid), "username" => nil, "display_name" => nil, "avatar_url" => nil}

        u ->
          %{
            "id" => Integer.to_string(u.user_id),
            "username" => u.username,
            "display_name" => u.display_name,
            "avatar_url" => u.avatar_url
          }
      end
    end)
  end
end
