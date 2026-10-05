defmodule Cytale.Search.Drift do
  @moduledoc """
  The index integrity check (#89's higher-value half) — and the reason a
  rebuild is rarely what an operator actually needs.

  A rebuild walks every message in a workspace (CPU + disk, minutes on a real
  workspace). A drift check answers "is the index wrong, and where" from a
  bounded sample, and names the ids — so the common repairs ("three ghosts
  from #76", "the last hour never reached the index") are a surgical
  `delete_message/2` or a watermark reconcile, not a rebuild.

  ## What it reports, and what it does NOT claim

  Two exact counts and three bounded samples:

    * `documents` — documents in the index (one count query) against messages
      in the table (per-bucket `COUNT(*)`), plus their delta. Exact at any
      sample size.
    * `missing` — db ids whose document the index does not hold.
    * `orphaned` — index documents whose `messages` row is gone (the #76 ghost
      class: a delete that reached ScyllaDB but never the index).
    * `content` — a bounded sample comparing the indexed text to the stored
      row (this is what catches a stale document left by an edit — the
      forward-only index path never revisits one).

  Every SAMPLED ID is verified exactly: when a side's walk covered that side
  completely, set membership decides; when it did not, a point lookup does
  (`Scan.index_has_id?/2`, `Scan.message_exists?/2`). What is bounded is
  COVERAGE, and `truncated` says when. `clean` is therefore true only when the
  counts agree, every sample came back empty, and nothing was truncated — the
  check never reports "fine" on evidence it did not collect.
  """

  alias Cytale.Config
  alias Cytale.Search.{IndexWriter, Scan}

  @max_sample_limit 5_000

  @doc """
  Check one workspace's index against its `messages` table.

  Options: `:sample_limit` (ids examined per side, default
  `Cytale.Config.search_drift_sample_limit/0`), `:content_limit` (documents
  whose text is compared, default `Cytale.Config.search_drift_content_limit/0`).

  Returns a native (atom-keyed) report; the admin controller shapes it for the
  wire.
  """
  @spec check(integer(), keyword()) :: map()
  def check(workspace_id, opts \\ []) when is_integer(workspace_id) do
    sample_limit =
      opts
      |> Keyword.get(:sample_limit)
      |> resolve(Config.search_drift_sample_limit())
      |> clamp_limit()

    content_limit =
      opts
      |> Keyword.get(:content_limit)
      |> resolve(Config.search_drift_content_limit())
      |> clamp_limit()

    index = index_side(workspace_id, sample_limit)
    db = db_side(workspace_id, sample_limit)

    missing = missing_ids(db, index, sample_limit)
    orphaned = orphaned_ids(db, index, sample_limit)
    content = content_mismatches(index, orphaned, content_limit)

    %{
      workspace_id: workspace_id,
      checked_at: DateTime.utc_now() |> DateTime.truncate(:millisecond),
      documents: %{index: index.count, messages: db.count, delta: index.count - db.count},
      missing: missing,
      orphaned: orphaned,
      content: content,
      index_state: %{
        watermark: IndexWriter.watermark({:workspace, workspace_id}),
        latest_message_id: Scan.latest_message_id(workspace_id)
      },
      clean:
        index.count == db.count and missing.count == 0 and orphaned.count == 0 and
          content.mismatched_count == 0 and not missing.truncated and not orphaned.truncated and
          not content.truncated
    }
  end

  @doc """
  Unindex the given message ids — the surgical repair, no rebuild.

  `IndexWriter.discard/2` deletes the id terms and commits once, so repairing N
  ghosts costs one commit rather than N. Deleting an id that is not in the index
  is a no-op, which makes the repair safe to run twice.
  """
  @spec repair_orphans(integer(), [integer()]) :: %{unindexed: non_neg_integer(), ids: [integer()]}
  def repair_orphans(workspace_id, ids) when is_integer(workspace_id) and is_list(ids) do
    ids = ids |> Enum.filter(&is_integer/1) |> Enum.uniq()

    if ids == [] do
      %{unindexed: 0, ids: []}
    else
      :ok = IndexWriter.discard({:workspace, workspace_id}, ids)
      %{unindexed: length(ids), ids: ids}
    end
  end

  # -- the two sides -------------------------------------------------------------

  defp index_side(workspace_id, sample_limit) do
    case Scan.index_searcher(workspace_id) do
      {:ok, searcher} ->
        count = Scan.index_document_count(searcher)

        {stats, docs} =
          Scan.each_index_page(
            searcher,
            [page_size: sample_limit, max_rows: sample_limit],
            [],
            fn page, acc -> acc ++ page end
          )

        %{
          searcher: searcher,
          # The exact count decides truncation, not the walk's budget flag: a
          # sample of exactly `count` documents is the whole index. The walk may
          # overshoot its budget by one page, so the sample is trimmed back to
          # the limit the report advertises.
          truncated: count > stats.rows,
          count: count,
          docs: docs |> Enum.map(&normalize_doc/1) |> Enum.take(sample_limit),
          sampled: min(stats.rows, sample_limit)
        }

      :error ->
        %{searcher: nil, truncated: false, count: 0, docs: [], sampled: 0}
    end
  end

  defp db_side(workspace_id, sample_limit) do
    count = Scan.count_messages(workspace_id)

    {_stats, rows} =
      Scan.each_message_page(
        workspace_id,
        [direction: :desc, page_size: sample_limit, max_rows: sample_limit],
        [],
        fn page, acc -> acc ++ page end
      )

    ids = rows |> Enum.map(& &1["message_id"]) |> Enum.take(sample_limit)

    %{count: count, ids: ids, truncated: count > length(ids), sampled: length(ids)}
  end

  defp normalize_doc(doc) do
    %{
      message_id: doc["message_id"] || doc[:message_id],
      channel_id: doc["channel_id"] || doc[:channel_id],
      content: doc["content"] || doc[:content]
    }
  end

  # -- the three comparisons -----------------------------------------------------

  defp missing_ids(db, index, sample_limit) do
    index_ids = MapSet.new(index.docs, & &1.message_id)

    # Membership is exact either way: from the enumerated set when the walk
    # covered the whole index, by point lookup when it did not.
    is_indexed? =
      if index.truncated or is_nil(index.searcher) do
        fn id -> not is_nil(index.searcher) and Scan.index_has_id?(index.searcher, id) end
      else
        fn id -> MapSet.member?(index_ids, id) end
      end

    ids = Enum.reject(db.ids, is_indexed?)

    %{
      ids: ids,
      count: length(ids),
      sampled: db.sampled,
      sample_limit: sample_limit,
      truncated: db.truncated,
      order: :newest_first
    }
  end

  defp orphaned_ids(db, index, sample_limit) do
    db_ids = MapSet.new(db.ids)

    is_live? =
      if db.truncated do
        fn doc -> Scan.message_exists?(doc.channel_id, doc.message_id) end
      else
        fn doc -> MapSet.member?(db_ids, doc.message_id) end
      end

    ids = index.docs |> Enum.reject(is_live?) |> Enum.map(& &1.message_id)
    orphans = MapSet.new(ids)

    %{
      ids: ids,
      count: length(ids),
      sampled: index.sampled,
      sample_limit: sample_limit,
      truncated: index.truncated,
      order: :ascending_message_id,
      # The documents behind the ids, so a repair can delete by term without a
      # second lookup.
      docs: Enum.filter(index.docs, &MapSet.member?(orphans, &1.message_id))
    }
  end

  defp content_mismatches(index, orphaned, content_limit) do
    orphans = MapSet.new(orphaned.ids)

    live_docs = Enum.reject(index.docs, &MapSet.member?(orphans, &1.message_id))
    checked = Enum.take(live_docs, content_limit)

    mismatched =
      Enum.filter(checked, fn doc ->
        stored = Scan.message_content(doc.channel_id, doc.message_id)
        to_string(stored || "") != to_string(doc.content || "")
      end)

    %{
      mismatched_ids: Enum.map(mismatched, & &1.message_id),
      mismatched_count: length(mismatched),
      checked: length(checked),
      sample_limit: content_limit,
      # Only documents the index walk handed over can be compared, so a
      # truncated WALK truncates the content coverage too.
      truncated: index.truncated or length(live_docs) > length(checked)
    }
  end

  # -- option handling -----------------------------------------------------------

  defp resolve(nil, default), do: default
  defp resolve(n, _default) when is_integer(n) and n >= 0, do: n
  defp resolve(_, default), do: default

  defp clamp_limit(n), do: n |> max(1) |> min(@max_sample_limit)
end
