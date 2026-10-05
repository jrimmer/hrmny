defmodule Cytale.Search.Rebuild do
  @moduledoc """
  The replay path (#89) — re-index a workspace from its `messages` table.

  A rebuild IS `replay_range(workspace_id, 0, latest_message_id(workspace_id))`:

      * one mechanism, two callers — the fan-out's self-heal
        (`TantivyImpl.reconcile/1`, which replays from the writer's watermark)
        and the operator-triggered rebuild (which replays from 0);
      * oldest first, in pages of `search_rebuild_page_size`, upserting through
        `IndexWriter.index/2` (idempotent by `message_id`) and committing once
        per page;
      * every page rides `Cytale.Search.Scan`, so paging is the driver's
        paging state and not the first-page truncation `execute!/3` would give
        an unbounded scan.

  ## Why a rebuild does not wipe the index directory

  Discarding the directory first would leave the workspace unsearchable until
  the walk finished, and a crash halfway would leave it half-empty with
  nothing to compare against. Replay-from-0 is idempotent, interrupt-safe (the
  index is always a superset-or-equal of the rows already replayed), and
  cheap to re-run. The consequence is deliberate and worth stating: **a
  rebuild repairs MISSING documents; it does not remove orphaned ones** —
  nothing in an upsert walk ever deletes. Removing ghosts is the drift check's
  job, which names them and then calls `IndexWriter.discard/2`.

  ## Live writes may land mid-rebuild

  The fan-out cannot be paused. A delete that lands after a page was read but
  before its document is written back can be resurrected into the index by that
  page — an orphan. That is acceptable for v1 precisely because the result is
  PROVABLE: run the drift check after the rebuild and repair whatever it names.
  (The same races are why the check, not the rebuild, is the source of truth.)

  ## Telemetry

  Emits `[:cytale, :search, :rebuild, :page]` per page with `count` and
  `duration_ms` (metadata: `workspace_id`, optional `job_id`), so the rebuild
  is visible on the `/metrics` surface while it runs — a long rebuild with no
  observable progress is indistinguishable from a hang.
  """

  alias Cytale.Config
  alias Cytale.Search.{IndexWriter, Scan}

  @doc """
  Rebuild a workspace's index from scratch (replay from id 0).

  Returns `{:ok, %{pages:, messages:, to:, truncated:}}` — the walk's own
  numbers, never a claim about the result. Verify with
  `Cytale.Search.Drift.check/2`.
  """
  @spec rebuild(integer(), keyword()) :: {:ok, map()}
  def rebuild(workspace_id, opts \\ []) when is_integer(workspace_id) do
    case latest_message_id(workspace_id) do
      nil ->
        {:ok, %{pages: 0, messages: 0, to: nil, truncated: false, workspace_id: workspace_id}}

      latest ->
        {:ok, stats} = replay_range(workspace_id, 0, latest, opts)
        {:ok, Map.put(stats, :to, latest)}
    end
  end

  @doc """
  Replay `(from_exclusive, to_inclusive]` for one workspace, oldest first.

  The caller owns the meaning of the bounds: the fan-out's reconcile passes
  its watermark and the workspace's latest id; a rebuild passes 0 and the
  latest id. Commits once per page, which bounds the writer's buffer (a
  workspace's whole history must never accumulate in memory) and makes every
  page a durable increment.

  Options: `:page_size` (default `Cytale.Config.search_rebuild_page_size/0`),
  `:on_page` (`fn %{pages:, messages:} -> any` — progress), `:telemetry_meta`
  (extra metadata merged into the page event).
  """
  @spec replay_range(integer(), integer(), integer(), keyword()) :: {:ok, map()}
  def replay_range(workspace_id, from_exclusive, to_inclusive, opts \\ [])
      when is_integer(workspace_id) and is_integer(from_exclusive) and is_integer(to_inclusive) do
    page_size = opts |> Keyword.get(:page_size) |> resolve_page_size()
    on_page = Keyword.get(opts, :on_page, fn _ -> :ok end)
    meta = Keyword.get(opts, :telemetry_meta, %{})

    acc = %{pages: 0, messages: 0}

    {stats, acc} =
      Scan.each_message_page(
        workspace_id,
        [direction: :asc, after: from_exclusive, to: to_inclusive, page_size: page_size],
        acc,
        fn page, acc ->
          started = System.monotonic_time(:millisecond)

          Enum.each(page, fn row -> IndexWriter.index({:workspace, workspace_id}, to_message(row)) end)
          # Bound the writer's buffer and make this page durable before the
          # next one is read: an interrupt then costs at most one page.
          IndexWriter.commit_now({:workspace, workspace_id})

          acc = %{acc | pages: acc.pages + 1, messages: acc.messages + length(page)}

          :telemetry.execute(
            [:cytale, :search, :rebuild, :page],
            %{count: length(page), duration_ms: System.monotonic_time(:millisecond) - started},
            Map.merge(%{workspace_id: workspace_id}, meta)
          )

          on_page.(acc)
          acc
        end
      )

    {:ok, Map.merge(acc, %{workspace_id: workspace_id, truncated: stats.budget_hit})}
  end

  @doc """
  The workspace's latest message id (nil when it holds none).

  Counts every bucket the workspace has lived through, newest first — not just
  the current one — so a workspace that has been quiet for more than a 7-day
  bucket still reconciles.
  """
  @spec latest_message_id(integer()) :: integer() | nil
  def latest_message_id(workspace_id) when is_integer(workspace_id) do
    Scan.latest_message_id(workspace_id)
  end

  # The ScyllaDB row → the behaviour's message map. Same shape the fan-out
  # hands the index, so a replayed document is byte-identical to a live one.
  defp to_message(row) do
    %{
      id: row["message_id"],
      channel_id: row["channel_id"],
      author_id: row["author_id"],
      content: row["content"],
      thread_id: row["thread_id"],
      created_at: row["created_at"]
    }
  end

  defp resolve_page_size(n) when is_integer(n) and n > 0, do: min(n, Scan.driver_page_size())
  defp resolve_page_size(_), do: Config.search_rebuild_page_size()
end
