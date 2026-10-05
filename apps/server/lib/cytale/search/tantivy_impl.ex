defmodule Cytale.Search.TantivyImpl do
  @moduledoc """
  The Tantivy-backed search implementation (U13 slice 2) behind the
  `Cytale.Search.Behaviour` seam — the muninn NIF wrapper over Tantivy.

  Writes ride the per-workspace `Cytale.Search.IndexWriter` (batched ~500ms
  commits, watermark-tracked for reconciliation). Queries open a muninn
  searcher over the workspace's index, run the full-text term, then apply the
  parsed filters (`from:`, `in:`, date-range) and the permission filter in
  the Elixir layer — query-time, always current (AE4).

  The seam is the deliverable; this module is the day-one implementation. If
  the muninn NIF is unavailable at runtime, `query/3` degrades to `[]` (search
  returns nothing, chat is unaffected) and `index/2` still succeeds (the
  writer buffers; a later NIF availability makes it searchable) — the plan's
  "index-write failure → chat persists, search degrades" contract.
  """

  @behaviour Cytale.Search.Behaviour

  alias Cytale.Search.{Drift, IndexWriter, Rebuild}

  require Logger

  @impl true
  def index(workspace_id, message) when is_integer(workspace_id) and is_map(message) do
    IndexWriter.index({:workspace, workspace_id}, message)
  end

  @impl true
  def query(workspace_id, %{term: _} = query, filters) when is_integer(workspace_id) do
    case IndexWriter.index_ref({:workspace, workspace_id}) do
      nil ->
        []

      index ->
        do_query(index, query, filters)
    end
  end

  @impl true
  def delete_by_author(workspace_id, author_id) when is_integer(workspace_id) and is_integer(author_id) do
    IndexWriter.delete_by_author({:workspace, workspace_id}, author_id)
  end

  @impl true
  def delete_message(workspace_id, message_id) when is_integer(workspace_id) and is_integer(message_id) do
    IndexWriter.delete_message({:workspace, workspace_id}, message_id)
  end

  # -- the per-user DM segment (owner direction 2026-09-15: DMs are indexed) --

  @doc "Index a DM message into one participant's index (call for EACH participant)."
  @spec index_dm(integer(), map()) :: :ok
  def index_dm(user_id, message) when is_integer(user_id) and is_map(message) do
    IndexWriter.index({:dm_user, user_id}, message)
  end

  @doc """
  The message-write seam's form: a `Cytale.Messages` struct (or the
  same-shaped map), converted and indexed. REST, compat, webhook and
  interaction writes all converge on `Messages.create_message`, which calls
  this for each participant — the DM segment therefore works under every
  producer and in every publish environment.
  """
  @spec index_dm_message(integer(), map()) :: :ok
  def index_dm_message(user_id, message) when is_integer(user_id) and is_map(message) do
    IndexWriter.index({:dm_user, user_id}, dm_message(message))
  end

  @doc "Remove a message from one participant's DM index."
  @spec unindex_dm(integer(), integer()) :: :ok
  def unindex_dm(user_id, message_id) when is_integer(user_id) and is_integer(message_id) do
    IndexWriter.delete_message({:dm_user, user_id}, message_id)
  end

  @doc """
  Search one user's DM index. The index contains only that user's own
  conversations (permission by partition), so `visible_channels` is passed as
  the user's CURRENT DM channel ids — belt and braces against a stale index
  entry from a conversation row that no longer resolves, and it is what makes
  an `in:` filter name the caller's own conversations only.
  """
  @spec query_dm(integer(), map(), list(integer())) :: [map()]
  def query_dm(user_id, %{term: _} = query, dm_channel_ids) when is_integer(user_id) do
    case IndexWriter.index_ref({:dm_user, user_id}) do
      nil -> []
      index -> do_query(index, query, %{visible_channels: dm_channel_ids})
    end
  end

  @doc """
  Bring a user's DM index up to date with their conversations, then it stays
  current via the message-write hook. Idempotent (upserts keyed by message_id)
  and bounded per call; the bound is a BACKFILL guard, not a freshness guard —
  past it, the oldest stratum stays unindexed until the next call walks no
  further (watermark only advances over what was actually indexed, so nothing
  is skipped silently).
  """
  @dm_backfill_cap 4000

  @spec ensure_dm_current(integer()) :: {:ok, non_neg_integer()}
  def ensure_dm_current(user_id) when is_integer(user_id) do
    watermark = IndexWriter.watermark({:dm_user, user_id}) || 0

    dms = Cytale.Workspaces.dms_of_user(user_id)
    latest = dms |> Enum.map(&(&1.last_message_id || 0)) |> Enum.max(fn -> 0 end)

    if latest <= watermark do
      {:ok, 0}
    else
      {indexed, _cutoff?} =
        Enum.reduce_while(dms, {0, false}, fn dm, {count, cutoff?} ->
          channel_id = dm.channel_id

          # Newest-first pages until the watermark is crossed, collected then
          # indexed OLDEST-first so the commit's watermark never advances past
          # what has actually been written.
          gap =
            stream_pages(channel_id, watermark)
            |> Enum.reverse()

          Enum.each(gap, fn row -> IndexWriter.index({:dm_user, user_id}, dm_message(row)) end)

          count = count + length(gap)

          if count >= @dm_backfill_cap do
            {:halt, {count, true}}
          else
            {:cont, {count, cutoff?}}
          end
        end)

      if indexed > 0, do: IndexWriter.commit_now({:dm_user, user_id})
      {:ok, indexed}
    end
  end

  # History pages (newest-first) for one DM channel, stopping at the watermark.
  defp stream_pages(channel_id, watermark, before \\ nil, acc \\ []) do
    page = Cytale.Messages.history(channel_id, limit: 100, before: before)

    case page do
      [] ->
        acc

      rows ->
        newer = Enum.filter(rows, &(&1.id > watermark))
        acc = acc ++ newer

        if length(newer) < length(rows) or length(rows) < 100 do
          acc
        else
          stream_pages(channel_id, watermark, List.last(rows).id, acc)
        end
    end
  end

  # The index-seam document shape (same contract as Rebuild.to_message):
  # created_at stays a DateTime — IndexWriter.to_doc does the conversion.
  defp dm_message(message) do
    %{
      id: message.id,
      channel_id: message.channel_id,
      author_id: message.author_id,
      content: message.content || "",
      thread_id: message.thread_id,
      created_at: message.created_at
    }
  end

  @impl true
  def reconcile(workspace_id) when is_integer(workspace_id) do
    # Self-heal: replay the delta between the writer's watermark and the
    # workspace's latest message, via idempotent upserts keyed by message_id.
    # The replay itself is `Cytale.Search.Rebuild.replay_range/4` — the SAME
    # path an operator-triggered rebuild runs (#89), so the forward heal and
    # the full rebuild cannot drift apart in behavior.
    watermark = IndexWriter.watermark({:workspace, workspace_id}) || 0

    case Rebuild.latest_message_id(workspace_id) do
      nil ->
        {:ok, 0}

      latest when latest <= watermark ->
        {:ok, 0}

      latest ->
        {:ok, stats} = Rebuild.replay_range(workspace_id, watermark, latest)
        {:ok, stats.messages}
    end
  end

  @impl true
  def drift(workspace_id, opts) when is_integer(workspace_id) do
    Drift.check(workspace_id, opts)
  end

  @impl true
  def repair_orphans(workspace_id, message_ids) when is_integer(workspace_id) do
    Drift.repair_orphans(workspace_id, message_ids)
  end

  @impl true
  def rebuild(workspace_id, opts) when is_integer(workspace_id) do
    Rebuild.rebuild(workspace_id, opts)
  end

  # -- query execution ----------------------------------------------------------

  defp do_query(index, %{term: term} = query, filters) do
    with {:ok, reader} <- Muninn.IndexReader.new(index),
         {:ok, searcher} <- Muninn.Searcher.new(reader) do
      qs = if term == "", do: "*", else: term

      case Muninn.Searcher.search_query(searcher, qs, ["content"], limit: 100) do
        {:ok, %{"hits" => hits}} ->
          hits
          |> Enum.map(&hit_to_result/1)
          |> apply_filters(query, filters)

        {:ok, %{hits: hits}} ->
          hits
          |> Enum.map(&hit_to_result/1)
          |> apply_filters(query, filters)

        {:error, reason} ->
          Logger.warning("search: query failed: #{inspect(reason)}")
          []

        _ ->
          []
      end
    else
      _ -> []
    end
  end

  # -- result shaping + filter application --------------------------------------

  defp hit_to_result(hit) do
    doc = hit["doc"] || hit.doc || %{}

    %{
      message_id: doc["message_id"] || doc[:message_id],
      channel_id: doc["channel_id"] || doc[:channel_id],
      author_id: doc["author_id"] || doc[:author_id],
      created_at: doc["created_at"] || doc[:created_at],
      thread_id: (doc["thread_id"] || doc[:thread_id]) |> nil_if_zero(),
      score: hit["score"] || hit.score
    }
  end

  defp nil_if_zero(0), do: nil
  defp nil_if_zero(v), do: v

  # Apply from:/in:/date-range + permission filters in the Elixir layer.
  defp apply_filters(results, %{term: _} = query, filters) do
    results
    |> filter_by_from(query.from, filters)
    |> filter_by_in(query.in, filters)
    |> filter_by_date(query.after, query.before)
    |> filter_by_permission(filters)
  end

  defp filter_by_from(results, nil, _filters), do: results

  defp filter_by_from(results, username, filters) do
    author_id = resolve_author_id(username, filters)

    if author_id do
      Enum.filter(results, &(&1.author_id == author_id))
    else
      []
    end
  end

  defp filter_by_in(results, nil, _filters), do: results

  defp filter_by_in(results, channel, filters) do
    channel_id = resolve_channel_id(channel, filters)

    if channel_id do
      Enum.filter(results, &(&1.channel_id == channel_id))
    else
      []
    end
  end

  defp filter_by_date(results, nil, nil), do: results

  defp filter_by_date(results, after_dt, before_dt) do
    Enum.filter(results, fn r ->
      ms = r.created_at

      after_ok =
        case after_dt do
          nil -> true
          dt -> ms >= DateTime.to_unix(dt, :millisecond)
        end

      before_ok =
        case before_dt do
          nil -> true
          dt -> ms <= DateTime.to_unix(dt, :millisecond)
        end

      after_ok and before_ok
    end)
  end

  # Permission filter: only return results whose channel is in the member's
  # visible set (from the U7 permission engine, passed via filters.visible_channels).
  defp filter_by_permission(results, filters) do
    case Map.get(filters, :visible_channels) do
      nil ->
        results

      visible when is_list(visible) ->
        visible_set = MapSet.new(visible)
        Enum.filter(results, &MapSet.member?(visible_set, &1.channel_id))
    end
  end

  # -- filter resolution ---------------------------------------------------------

  # Resolve a username to an author_id within the workspace's member directory.
  defp resolve_author_id(username, filters) do
    case Map.get(filters, :members, []) do
      members when is_list(members) ->
        Enum.find_value(members, fn m ->
          if String.downcase(m.username) == String.downcase(username) do
            m.user_id
          end
        end)

      _ ->
        nil
    end
  end

  # Resolve a channel (by name or id) to a channel_id within the workspace.
  defp resolve_channel_id(channel, filters) do
    case Map.get(filters, :channels, []) do
      channels when is_list(channels) ->
        Enum.find_value(channels, fn c ->
          if Integer.to_string(c.channel_id) == channel or c.name == channel do
            c.channel_id
          end
        end)

      _ ->
        nil
    end
  end

  # -- reconcile helpers --------------------------------------------------------

  # `latest_message_id/1`, `replay_range/4` (and the paged message scan they
  # rest on) moved to `Cytale.Search.Scan` / `Cytale.Search.Rebuild` in #89:
  # the forward heal and the operator rebuild share one replay path, one paged
  # scan, and one definition of "the workspace's latest message". The old
  # `latest_in_channel/1` here read only the CURRENT bucket, so a workspace
  # quiet for a whole 7-day bucket reconciled as "nothing newer than the
  # watermark" and stayed stale.
end
