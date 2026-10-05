defmodule CytaleWeb.MarksController do
  @moduledoc """
  The member's message marks (#54 U3) — one route family keyed by kind.

    * `GET /users/@me/marks` — the caller's PENDING marks: identifiers and
      times only, and only in channels the caller can still read.
    * `PUT /users/@me/marks/:kind/channels/:channel_id/messages/:message_id`
      — set a mark (or re-set it: one mark per kind per message); body
      `{"due_at": "<ISO 8601>"}` for a timed kind.
    * `DELETE` on the same path — cancel it.

  ## The gate is reading the message

  A mark may be set only on a message the caller can read, checked through
  `CytaleWeb.Compat.Authorize.channel_gate/2` — the one seam that applies
  agent restrictions, DM participation and parent fallback (R12) — and the
  mark's channel is taken from the FETCHED message, never from the body. A
  nonexistent channel, a nonexistent message and a message the caller cannot
  read all answer the SAME 404 (anti-enumeration). The channel rides the PATH,
  not the body, so the authorization matrix's declaration gate can see it.

  ## Nothing here is visible to anyone else (KD4, R2)

  Every route is the caller's own scope; no route takes a user id, and no
  write fans out. Machine principals (bots, agents) may set and read their OWN
  marks through these same routes — no agent-specific surface is added.
  """

  use CytaleWeb, :controller

  import CytaleWeb.API.Params, only: [snowflake: 1]
  import CytaleWeb.API.Error, only: [error: 4]

  alias Cytale.Marks
  alias Cytale.Messages
  alias CytaleWeb.Compat.Authorize

  @doc "GET /users/@me/marks — the caller's pending marks."
  def index(conn, _params) do
    claims = conn.assigns.current_user

    # The list never outlives the caller's access: a mark in a channel they can
    # no longer read is simply not listed (one gate call per distinct channel).
    pending = Marks.list_pending(claims.user_id)

    readable =
      pending
      |> Enum.map(& &1.channel_id)
      |> Enum.uniq()
      |> Enum.filter(&match?({:ok, _, _}, Authorize.channel_gate(claims, &1)))
      |> MapSet.new()

    marks =
      pending
      |> Enum.filter(&MapSet.member?(readable, &1.channel_id))
      |> Enum.sort_by(&DateTime.to_unix(&1.due_at, :millisecond))
      |> Enum.map(&mark_json/1)

    json(conn, %{"marks" => marks})
  end

  @doc "PUT /users/@me/marks/:kind/channels/:channel_id/messages/:message_id"
  def set(conn, %{"kind" => kind, "channel_id" => cid, "message_id" => mid} = params) do
    claims = conn.assigns.current_user

    with {:ok, message} <- readable_message(claims, cid, mid),
         {:ok, due_ms} <- parse_due(params["due_at"]),
         {:ok, mark} <- Marks.set(claims.user_id, kind, message, due_ms) do
      json(conn, %{"mark" => mark_json(mark)})
    else
      {:error, :not_found} ->
        not_found(conn)

      {:error, :unknown_kind} ->
        error(conn, 400, "validation_failed", "Unknown mark kind.")

      {:error, :unsupported_kind} ->
        error(conn, 400, "validation_failed", "That kind cannot be set here.")

      {:error, :invalid_due_at} ->
        error(conn, 400, "validation_failed", "due_at must be an ISO 8601 instant.")

      {:error, :due_at_required} ->
        error(conn, 400, "validation_failed", "due_at is required.")

      {:error, :due_at_in_past} ->
        error(conn, 400, "validation_failed", "due_at must be in the future.")

      {:error, :due_at_beyond_horizon} ->
        error(conn, 400, "validation_failed", "due_at is too far ahead.")

      {:error, :thread_target} ->
        error(conn, 400, "validation_failed", "Reminders on thread replies are not supported yet.")

      {:error, :cap_reached} ->
        error(conn, 409, "cap_reached", "You have too many pending reminders.")
    end
  end

  @doc "DELETE /users/@me/marks/:kind/channels/:channel_id/messages/:message_id"
  def cancel(conn, %{"kind" => kind, "channel_id" => cid, "message_id" => mid}) do
    claims = conn.assigns.current_user

    with {:ok, message} <- readable_message(claims, cid, mid),
         :ok <- Marks.cancel(claims.user_id, kind, message.id) do
      send_resp(conn, 204, "")
    else
      {:error, :unknown_kind} -> error(conn, 400, "validation_failed", "Unknown mark kind.")
      _ -> not_found(conn)
    end
  end

  # The one precondition every write shares: the message exists and the caller
  # can read it. Every miss collapses into :not_found.
  defp readable_message(claims, cid, mid) do
    with {:ok, channel_id} <- snowflake(cid),
         {:ok, message_id} <- snowflake(mid),
         {:ok, _channel, _bits} <- Authorize.channel_gate(claims, channel_id),
         %{} = message <- Messages.get_message(channel_id, message_id) do
      {:ok, message}
    else
      _ -> {:error, :not_found}
    end
  end

  defp parse_due(nil), do: {:ok, nil}

  defp parse_due(value) when is_binary(value) do
    case DateTime.from_iso8601(value) do
      {:ok, dt, _offset} -> {:ok, DateTime.to_unix(dt, :millisecond)}
      _ -> {:error, :invalid_due_at}
    end
  end

  defp parse_due(_), do: {:error, :invalid_due_at}

  defp not_found(conn), do: error(conn, 404, "message_not_found", "No message with that id")

  # Identifiers and times only (the list-breadth rule): no content, no author.
  defp mark_json(mark) do
    %{
      "kind" => mark.kind,
      "channel_id" => Integer.to_string(mark.channel_id),
      "message_id" => Integer.to_string(mark.target_id),
      "due_at" => mark.due_at && DateTime.to_iso8601(mark.due_at),
      "state" => mark.state
    }
  end
end
