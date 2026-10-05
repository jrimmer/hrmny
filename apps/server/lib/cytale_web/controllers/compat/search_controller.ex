defmodule CytaleWeb.Compat.SearchController do
  @moduledoc """
  Compat channel search (bots plan B-4) — a **CYTALE EXTENSION**: Discord
  has no stable REST search surface to mimic, so this route rides the
  Discord-ish URL shape `/channels/{cid}/messages/search` with its OWN
  response contract and no discord.js wrapper (documented in compat.md):

      {"results": [Discord message objects], "total": <match count>}

    * `GET /channels/{cid}/messages/search?q=&limit=&before=` — the channel's
      (or THREAD's — the id may be a thread id, scoped to that thread v1)
      messages, newest-first.
    * `GET /users/@me/channels/{dm_id}/messages/search?q=…` — the same shape
      over a DM channel (recipient-gated).

  Gates: the standard anti-enumeration channel gate (view) +
  `read_message_history`; a restricted agent searching an out-of-profile
  channel gets the identical 10003. DM channels resolve through recipient
  membership (B-1).

  Implementation: workspace channels/threads map to the per-workspace
  Tantivy index (the same `TantivyImpl.query` the native workspace search
  serves), scope-filtered to the gated channel (a thread id adds a
  thread_id filter — thread messages live in the parent's index partition).
  DM messages are not Tantivy-indexed (the DM index segment is a documented
  seam) — DM search is a BOUNDED in-memory scan of the channel's message
  partition (newest-first, capped at 500 messages), substring-matched
  case-insensitively. `q` empty matches everything.

  `total` counts ALL in-scope matches; `results` is the page after
  `before=` (exclusive snowflake cursor) and `limit=` (1–100, default 25).
  An empty match set is `{"results": [], "total": 0}` — never a 404.
  """

  use CytaleWeb, :controller

  alias Cytale.Messages
  alias Cytale.Permissions.Bitfield
  alias Cytale.Search.{Query, TantivyImpl}
  alias Cytale.Snowflake
  alias Cytale.Threads.Thread
  alias CytaleWeb.Compat.{Authorize, Errors, MessageCodec}
  import CytaleWeb.API.Params, only: [parse_limit: 2, snowflake_opt: 1]

  @dm_scan_cap 500
  @dm_scan_page 100

  @doc "GET /channels/{cid}/messages/search?q=&limit=&before="
  def channel(conn, %{"channel_id" => id} = params) do
    claims = conn.assigns.current_user

    with {:ok, channel_id} <- Snowflake.parse(id) do
      case search_scope(claims, channel_id) do
        {:dm, channel} ->
          # DM channels: the in-memory bounded scan (no Tantivy segment).
          render(conn, channel.channel_id, dm_scan(channel.channel_id, params["q"]), params, claims.user_id)

        {:workspace, channel} ->
          render(
            conn,
            channel.channel_id,
            tantivy_search(channel.workspace_id, channel.channel_id, params),
            params,
            claims.user_id
          )

        {:thread, parent, thread} ->
          render(
            conn,
            parent.channel_id,
            tantivy_search(parent.workspace_id, parent.channel_id, params, thread.thread_id),
            params,
            claims.user_id
          )

        :missing_permissions ->
          Errors.missing_permissions(conn)

        :error ->
          Errors.unknown_channel(conn)
      end
    else
      _ ->
        Errors.unknown_channel(conn)
    end
  end

  # Scope resolution: a DM channel (recipient gate) | a workspace channel |
  # a THREAD id authorized on its parent (thread visibility rides the
  # parent's rights). Every leg requires read_message_history; gate misses
  # are the anti-enumeration 10003, a visible-but-unpermitted history bit is
  # the real 50001.
  defp search_scope(claims, channel_id) do
    case Authorize.channel_gate(claims, channel_id) do
      {:ok, %{type: :dm} = channel, _bits} ->
        {:dm, channel}

      {:ok, channel, bits} ->
        if Bitfield.has?(bits, :read_message_history),
          do: {:workspace, channel},
          else: :missing_permissions

      {:error, :unknown_channel} ->
        case Thread.get(channel_id) do
          %{} = thread ->
            with {:ok, parent, bits} <- Authorize.channel_gate(claims, thread.channel_id),
                 true <- Bitfield.has?(bits, :read_message_history) do
              {:thread, parent, thread}
            else
              _ -> :error
            end

          nil ->
            :error
        end
    end
  end

  @doc "GET /users/@me/channels/{dm_id}/messages/search?q=&limit=&before="
  def dm(conn, %{"channel_id" => id} = params) do
    claims = conn.assigns.current_user

    with {:ok, channel_id} <- Snowflake.parse(id),
         {:ok, channel, _bits} <- Authorize.channel_gate(claims, channel_id),
         true <- channel.type == :dm do
      render(conn, channel.channel_id, dm_scan(channel.channel_id, params["q"]), params, claims.user_id)
    else
      _ -> Errors.unknown_channel(conn)
    end
  end

  # -- workspace scope (Tantivy) ------------------------------------------------------

  defp tantivy_search(workspace_id, scope_id, params, thread_id \\ nil) do
    # The route IS the scope: any in: token rides the term, but the channel
    # scoping below is authoritative (results never leak past the gate). A
    # thread scope adds a thread_id filter — thread messages live in the
    # parent channel's index partition with thread_id set.
    query = params["q"] |> Query.parse() |> Map.put(:in, nil)

    TantivyImpl.query(workspace_id, query, %{visible_channels: [scope_id], members: [], channels: []})
    |> maybe_thread_scope(thread_id)
    |> Enum.sort_by(& &1.message_id, :desc)
  end

  defp maybe_thread_scope(hits, nil), do: hits

  defp maybe_thread_scope(hits, thread_id),
    do: Enum.filter(hits, &(&1.thread_id == thread_id))

  # -- DM scope (bounded in-memory scan) -----------------------------------------------

  # Newest-first bounded scan of the channel's partition; the caller applies
  # the before-cursor + limit slice. Substring match, case-insensitive; an
  # empty q matches everything.
  defp dm_scan(channel_id, q) do
    needle = String.downcase(q || "")

    scan_pages(channel_id, @dm_scan_cap, [])
    |> Enum.reverse()
    |> List.flatten()
    |> Enum.filter(fn row -> String.contains?(String.downcase(row.content || ""), needle) end)
    |> Enum.sort_by(& &1.id, :desc)
  end

  defp scan_pages(_channel_id, remaining, acc) when remaining <= 0, do: acc

  defp scan_pages(channel_id, remaining, acc) do
    # `acc` holds PAGES, newest page first (hardening plan 5.9 replaced the
    # `acc ++ page` copy with a prepend). `history/2` walks BACKWARD from the
    # cursor, so the cursor is the OLDEST row of the most recent page: the head
    # page's last element.
    before =
      case acc do
        [] -> nil
        [latest_page | _] -> List.last(latest_page).id
      end

    page = Messages.history(channel_id, before: before, limit: @dm_scan_page)

    case page do
      [] ->
        acc

      _ ->
        # Prepend and reverse at the end (hardening plan 5.9): `acc ++ page`
        # copied the whole accumulated list per page, so a five-page scan was
        # quadratic in the rows it had already read.
        scan_pages(channel_id, remaining - length(page), [page | acc])
    end
  end

  # -- rendering -----------------------------------------------------------------------

  # total = ALL in-scope matches (Discord's total_results semantics);
  # results = the before-cursor + limit slice, rendered as full Discord
  # message objects (reactions attached, viewer-aware). Tantivy hits are
  # ids-only — the message row re-reads from its channel partition (thread
  # rows live in the PARENT channel's partition, which is the scope id);
  # DM-scan rows are already Messages.t.
  defp render(conn, scope_channel_id, matches, params, viewer_id) do
    before = snowflake_opt(params["before"])
    limit = parse_limit(params["limit"], default: 25, cap: 100)

    total = length(matches)

    page =
      matches
      |> Enum.filter(fn row -> is_nil(before) or id_of(row) < before end)
      |> Enum.take(limit)

    # #76: resolve each hit's ROW before rendering, and drop the ones that are
    # gone. The index had no per-message delete, so every message ever deleted
    # in a channel left a ghost document; ONE ghost took out the whole request
    # (`MessageCodec.message(nil)` → KeyError), which is why this route 500'd
    # for EVERY input — no query, empty query, matching query — on any channel
    # whose history included a deletion. The index now unindexes on delete
    # (Workspace's MessageDelete branch); this guard is what makes the ghosts
    # already in it harmless.
    # ONE batched reaction read for the page (hardening plan 2.1): every hit is
    # resolved through the SAME `scope_channel_id`, so the pairs share a channel
    # and the batch is a single `IN ?` read instead of two point reads per hit.
    results =
      page
      |> Enum.map(&message_row(&1, scope_channel_id))
      |> Enum.reject(&is_nil/1)
      |> Enum.map(fn msg -> {MessageCodec.message(msg), msg} end)
      |> MessageCodec.put_reactions_many(viewer_id)

    json(conn, %{"results" => results, "total" => total})
  end

  defp id_of(%{id: id}), do: id
  defp id_of(%{message_id: id}), do: id

  defp message_row(%{id: _} = row, _scope), do: row

  defp message_row(%{message_id: id}, scope_channel_id),
    do: Cytale.Messages.get_message(scope_channel_id, id)
end
