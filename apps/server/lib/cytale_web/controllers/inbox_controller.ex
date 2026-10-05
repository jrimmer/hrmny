defmodule CytaleWeb.InboxController do
  @moduledoc """
  The member's mention inbox (#117) — "where was I needed", message by
  message, from storage.

  Three routes, all self-scoped, and the shape is the point:

    * `GET /users/@me/inbox` — the member's own open backlog, newest first,
      cursor-paginated like every other read on this API;
    * `DELETE /users/@me/inbox/:message_id` — answer one mention;
    * `DELETE /users/@me/inbox` — sweep the backlog.

  ## There is nothing to gate but the caller

  The partition key of a mention row IS the member it is about, so "can this
  caller read this inbox" has one answer: the inbox is the caller's. The
  routes therefore carry no resource id that could address anyone else's rows
  — there is no `:user_id` to declare, no membership check to forget, and no
  existence oracle to leak, because no request can name another member's
  inbox. That is a stronger property than a 403: the shape of the surface
  makes the question unaskable.

  This is the same privacy test #113's bookmarks must pass (the owner's
  non-goal: "no visibility of anyone else's inbox"), and it is why the
  `AuthorizationMatrix` declaration is `:api_auth` with a note rather than a
  gate.

  ## What is deliberately absent

  No counts (a second set of unread numbers is #117's explicit non-goal — the
  badge keeps coming from the one watermark), no read receipts (no route here
  can report who read what), and no per-member read of anyone else's state.
  Marking done never touches `read_state`: answering a mention is not reading
  a channel, and the surface that shows a channel's badge must not move when
  an inbox row is cleared.
  """

  use CytaleWeb, :controller

  alias Cytale.Inbox
  import CytaleWeb.API.Params, only: [parse_limit: 2, snowflake: 1, snowflake_opt: 1]
  import CytaleWeb.API.Error, only: [error: 4]

  @doc """
  GET /users/@me/inbox?limit=&before= — the caller's open mentions, newest
  first.

  `items` is the page and `oldest_id` the cursor for the next one (nil when
  the page came back short of the limit). An empty inbox is `items: []` — the
  honest empty state, not an error and not a count.
  """
  def index(conn, params) do
    %{user_id: user_id} = conn.assigns.current_user

    {items, oldest_id} =
      Inbox.list_for_user(user_id,
        limit: parse_limit(params["limit"], default: Inbox.limit_default(), cap: :infinity),
        before: snowflake_opt(params["before"])
      )

    json(conn, %{"items" => items, "oldest_id" => oldest_id})
  end

  @doc """
  DELETE /users/@me/inbox/:message_id — answer one mention.

  Idempotent and deliberately indifferent to whether the row was there: it is
  the caller's own backlog, so a repeat is a no-op rather than a 404 (and a
  404 here would be the existence oracle the rest of this API avoids).

  Only the ROW is removed. The channel's watermark is untouched, so its unread
  badge and its in-pane divider stay exactly where the member's reading left
  them.
  """
  def dismiss(conn, %{"message_id" => mid}) do
    %{user_id: user_id} = conn.assigns.current_user

    case snowflake(mid) do
      {:ok, message_id} ->
        :ok = Inbox.mark_done(user_id, message_id)
        json(conn, %{"done" => Integer.to_string(message_id)})

      :error ->
        error(conn, 400, "validation_failed", "message_id must be a message id")
    end
  end

  @doc """
  DELETE /users/@me/inbox — sweep the backlog.

  Returns how many rows were cleared. The bulk twin of `dismiss/2`: rows only,
  never the watermark.
  """
  def sweep(conn, _params) do
    %{user_id: user_id} = conn.assigns.current_user

    json(conn, %{"done_count" => Inbox.mark_all_done(user_id)})
  end

  # -- helpers -------------------------------------------------------------------
end
