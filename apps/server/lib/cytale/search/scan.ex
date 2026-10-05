defmodule Cytale.Search.Scan do
  @moduledoc """
  Paged scans over the two sources of truth a search index is checked against
  (#89): the `messages` table and the workspace's muninn index.

  ## The paging trap, first, because it is the one that ships silently

  `Repo.execute!/3` returns only the FIRST Xandra page of a result set (10k
  rows by default) — a scan that reads it and stops silently truncates. That
  is not hypothetical in this repo: the credential sweep truncated at the page
  boundary and revoked tokens kept authenticating (`Cytale.Repo.stream_rows!/3`
  was added for exactly that incident). A rebuild built on `execute!/3` would
  look perfectly healthy and leave part of a workspace unindexed.

  So every scan here reads through `Repo.stream_rows!/3`, which follows the
  paging state to the end, and forwards `:page_size` so the caller knows how
  big a page is. `each_message_page/4` chunks that stream by `page_size` and
  hands the caller one page at a time — memory and progress are then bounded
  by the same number, and no read is ever wider than one driver page.

  ## Why the walk is bucket-shaped

  `messages` is partitioned by `((channel_id, bucket), message_id)` with a
  7-day `bucket` (`Cytale.Messages.bucket_for/1`), so a full-partition read
  must bind BOTH partition-key columns. The bucket range is
  `bucket(workspace.created_at)..bucket(now)`: a workspace cannot hold a
  message from before it existed, and the newest bucket is always included, so
  the range is complete without walking the ~2900 empty buckets back to the
  epoch.
  """

  alias Cytale.Search.IndexWriter
  alias Cytale.{Messages, Repo, Workspaces}

  require Logger

  # Xandra's default page size, i.e. the size of the first page `execute!/3`
  # would hand back. Nothing here may request more than one driver page in a
  # single call without following the paging state.
  @driver_page_size 10_000

  # The largest u64 (the index's `message_id` field type). Range queries on the
  # index span the whole id space unless the caller narrows it.
  @u64_max 18_446_744_073_709_551_615

  @typedoc """
  What the walk saw.

  `budget_hit` means the walk stopped because `:max_rows` ran out, NOT that the
  source held more rows — a caller that knows the exact total (the drift check
  does: it counts both sides) should compute `truncated` from that instead of
  trusting this flag, which cannot tell "the budget ended exactly at the last
  row" from "there was more".
  """
  @type scan_stats :: %{
          pages: non_neg_integer(),
          rows: non_neg_integer(),
          page_size: pos_integer(),
          budget_hit: boolean()
        }

  @doc """
  Walk the workspace's messages page by page, threading an accumulator.

  `fun.(page, acc)` is called once per page — each page is at most
  `:page_size` rows, i.e. exactly one Xandra page. Returns `{stats, acc}`.

  Options:

    * `:direction` — `:asc` (oldest first, the rebuild's order) or `:desc`
      (newest first, the drift sample's order). Default `:asc`.
    * `:after` — exclusive lower `message_id` bound. Default `0`.
    * `:to` — inclusive upper `message_id` bound. Default unbounded.
    * `:page_size` — rows per page. Clamped to at most #{@driver_page_size}.
    * `:max_rows` — stop after roughly this many rows (a page may overshoot by
      at most one page). Default `:infinity`.
  """
  @spec each_message_page(integer(), keyword(), acc, ([map()], acc -> acc)) :: {scan_stats(), acc}
        when acc: var
  def each_message_page(workspace_id, opts, acc, fun)
      when is_integer(workspace_id) and is_function(fun, 2) do
    page_size = opts |> Keyword.get(:page_size, 500) |> clamp_page_size()
    direction = Keyword.get(opts, :direction, :asc)
    after_id = Keyword.get(opts, :after, 0)
    to_id = Keyword.get(opts, :to)

    max_rows =
      case Keyword.get(opts, :max_rows, :infinity) do
        :infinity -> :infinity
        n when is_integer(n) and n > 0 -> n
        _ -> :infinity
      end

    {where, params} = message_where(after_id, to_id)
    order = if direction == :asc, do: " ORDER BY message_id ASC", else: ""

    statement =
      "SELECT message_id, channel_id, bucket, author_id, content, thread_id, created_at " <>
        "FROM {{K}}.messages #{where}#{order}"

    buckets = buckets_for(workspace_id, direction)

    # Each channel is walked bucket by bucket; the accumulator and the stats
    # ride along, and the whole walk halts the moment the row budget is spent.
    {stats, acc} =
      Workspaces.list_channels(workspace_id)
      |> Enum.reduce_while(
        {%{pages: 0, rows: 0, page_size: page_size, budget_hit: false}, acc},
        fn channel, {stats, acc} ->
          {stats, acc} =
            Enum.reduce_while(buckets, {stats, acc}, fn bucket, {stats, acc} ->
              {stats, acc} =
                Enum.reduce_while(
                  pages_for(statement, channel.channel_id, bucket, params, page_size),
                  {stats, acc},
                  fn page, {stats, acc} ->
                    acc = fun.(page, acc)

                    stats = %{
                      stats
                      | pages: stats.pages + 1,
                        rows: stats.rows + length(page),
                        budget_hit: stats.budget_hit or budget_spent?(stats.rows, max_rows)
                    }

                    if budget_spent?(stats.rows, max_rows),
                      do: {:halt, {stats, acc}},
                      else: {:cont, {stats, acc}}
                  end
                )

              if budget_spent?(stats.rows, max_rows),
                do: {:halt, {stats, acc}},
                else: {:cont, {stats, acc}}
            end)

          if budget_spent?(stats.rows, max_rows),
            do: {:halt, {stats, acc}},
            else: {:cont, {stats, acc}}
        end
      )

    {stats, acc}
  end

  # A bucket's rows as a lazy stream of driver pages. `stream_rows!` follows
  # the paging state to the end of the result set; chunking by the same
  # `page_size` the driver uses makes one chunk == one page.
  defp pages_for(statement, channel_id, bucket, params, page_size) do
    Repo.stream_rows!(
      statement,
      [{"bigint", channel_id}, {"int", bucket} | params],
      page_size: page_size
    )
    |> Stream.chunk_every(page_size)
  end

  @doc """
  The workspace's latest message id, or nil when it holds none.

  Walks buckets newest-first and takes the first non-empty bucket's highest
  `message_id`. The earlier shape (`tantivy_impl.ex`'s `latest_in_channel/1`)
  looked only at the CURRENT bucket, so a workspace that had been quiet for
  seven days reconciled as "nothing newer than the watermark" and its index
  silently stayed stale.
  """
  @spec latest_message_id(integer()) :: integer() | nil
  def latest_message_id(workspace_id) when is_integer(workspace_id) do
    buckets = buckets_for(workspace_id, :desc)

    Workspaces.list_channels(workspace_id)
    |> Enum.reduce(nil, fn channel, acc ->
      case latest_in_channel(channel.channel_id, buckets) do
        nil -> acc
        id -> max(acc || 0, id)
      end
    end)
  end

  defp latest_in_channel(channel_id, buckets) do
    Enum.reduce_while(buckets, nil, fn bucket, _acc ->
      rows =
        Repo.execute!(
          "SELECT message_id FROM {{K}}.messages WHERE channel_id = ? AND bucket = ? LIMIT 1",
          [{"bigint", channel_id}, {"int", bucket}]
        )
        |> Enum.to_list()

      case rows do
        [%{"message_id" => id}] -> {:halt, id}
        _ -> {:cont, nil}
      end
    end)
  end

  @doc """
  How many rows the workspace's `messages` table holds, counted per bucket.

  `COUNT(*)` is an aggregate, not a materialized set, so one call per bucket is
  exact and transfers one number — the honest denominator for "documents in
  the index vs messages in the table".
  """
  @spec count_messages(integer()) :: non_neg_integer()
  def count_messages(workspace_id) when is_integer(workspace_id) do
    buckets = buckets_for(workspace_id, :asc)

    Workspaces.list_channels(workspace_id)
    |> Enum.reduce(0, fn channel, acc ->
      acc +
        Enum.reduce(buckets, 0, fn bucket, sum ->
          rows =
            Repo.execute!(
              "SELECT COUNT(*) AS n FROM {{K}}.messages WHERE channel_id = ? AND bucket = ?",
              [{"bigint", channel.channel_id}, {"int", bucket}]
            )
            |> Enum.to_list()

          sum +
            case rows do
              [%{"n" => n}] when is_integer(n) -> n
              _ -> 0
            end
        end)
    end)
  end

  @doc """
  True when a `messages` row for `(channel_id, message_id)` exists.

  A point read keyed by the full primary key (the bucket is derived from the
  snowflake's own timestamp) — no scan, so an orphan check can ask this per
  sampled id without the answer depending on any sample size.
  """
  @spec message_exists?(integer(), integer()) :: boolean()
  def message_exists?(channel_id, message_id)
      when is_integer(channel_id) and is_integer(message_id) do
    bucket = Messages.bucket_for(Cytale.Snowflake.timestamp_ms(message_id))

    Repo.execute!(
      "SELECT message_id FROM {{K}}.messages WHERE channel_id = ? AND bucket = ? AND message_id = ?",
      [{"bigint", channel_id}, {"int", bucket}, {"bigint", message_id}]
    )
    |> Enum.to_list()
    |> case do
      [_ | _] -> true
      _ -> false
    end
  end

  @doc "The stored content of one message, or nil when the row is gone."
  @spec message_content(integer(), integer()) :: String.t() | nil
  def message_content(channel_id, message_id)
      when is_integer(channel_id) and is_integer(message_id) do
    bucket = Messages.bucket_for(Cytale.Snowflake.timestamp_ms(message_id))

    Repo.execute!(
      "SELECT content FROM {{K}}.messages WHERE channel_id = ? AND bucket = ? AND message_id = ?",
      [{"bigint", channel_id}, {"int", bucket}, {"bigint", message_id}]
    )
    |> Enum.to_list()
    |> case do
      [%{"content" => content} | _] -> content
      _ -> nil
    end
  end

  # -- the index side ------------------------------------------------------------

  @doc """
  Open the workspace's index for reading (starting its writer if needed).

  Starting the writer is the only way to get a muninn index reference for a
  workspace that is not currently writing — and an un-indexed workspace must
  still answer "zero documents", not "unknown". Returns `{:ok, searcher}` or
  `:error` when the NIF/index cannot be opened at all.
  """
  @spec index_searcher(integer()) :: {:ok, reference()} | :error
  def index_searcher(workspace_id) when is_integer(workspace_id) do
    with {:ok, index} <- index_ref(workspace_id),
         {:ok, reader} <- Muninn.IndexReader.new(index),
         {:ok, searcher} <- Muninn.Searcher.new(reader) do
      {:ok, searcher}
    else
      other ->
        Logger.warning("search_scan: index unavailable for #{workspace_id}: #{inspect(other)}")
        :error
    end
  rescue
    e ->
      Logger.warning("search_scan: index open raised for #{workspace_id}: #{Exception.message(e)}")
      :error
  end

  defp index_ref(workspace_id) do
    case IndexWriter.ensure_started({:workspace, workspace_id}) do
      {:ok, pid} -> {:ok, GenServer.call(pid, :index_ref)}
      {:error, reason} -> {:error, reason}
    end
  end

  @doc "How many documents the workspace's index holds (exact, one query)."
  @spec index_document_count(reference()) :: non_neg_integer()
  def index_document_count(searcher) do
    case Muninn.Searcher.count(searcher, "*", ["content"]) do
      {:ok, n} when is_integer(n) -> n
      _ -> 0
    end
  end

  @doc "True when the index holds a document for `message_id`."
  @spec index_has_id?(reference(), integer()) :: boolean()
  def index_has_id?(searcher, message_id) when is_integer(message_id) do
    case Muninn.Searcher.count(searcher, "message_id:#{message_id}", ["content"]) do
      {:ok, n} -> n > 0
      _ -> false
    end
  end

  @doc """
  Walk the index's documents, ascending `message_id`, up to a budget.

  Tantivy cannot offset or sort on a non-fast field (the schema's `message_id`
  is stored + indexed, not fast), so enumeration is a divide-and-conquer over
  id RANGES: a range whose count fits in a page is read whole; a denser range
  is split in half and walked in order. Divided ranges are disjoint and
  ascending, so the walk yields documents in ascending id order with no
  duplicates and no gaps — and it stops at `:max_rows` rather than pretending
  a sample is the whole set.

  `fun.(docs, acc)` receives a page of stored documents
  (`%{"message_id" =>, "channel_id" =>, "content" =>, ...}`) and the running
  accumulator; returns `{stats, acc}`.
  """
  @spec each_index_page(reference(), keyword(), acc, ([map()], acc -> acc)) :: {scan_stats(), acc}
        when acc: var
  def each_index_page(searcher, opts, acc, fun) when is_function(fun, 2) do
    page_size = opts |> Keyword.get(:page_size, 500) |> clamp_page_size()
    max_rows = Keyword.get(opts, :max_rows, :infinity)
    lo = Keyword.get(opts, :from, 0)
    hi = Keyword.get(opts, :to, @u64_max)

    stats = %{pages: 0, rows: 0, page_size: page_size, budget_hit: false}

    walk([{lo, hi}], searcher, page_size, max_rows, fun, stats, acc)
  end

  defp walk([], _searcher, _page_size, _max_rows, _fun, stats, acc), do: {stats, acc}

  defp walk([{lo, hi} | rest], searcher, page_size, max_rows, fun, stats, acc) do
    n = range_count(searcher, lo, hi)

    cond do
      n == 0 ->
        walk(rest, searcher, page_size, max_rows, fun, stats, acc)

      # Documents remain in this range and the budget is gone: stop here and
      # say so. Looking further could only confirm what the budget already
      # forced the caller to assume.
      budget_spent?(stats.rows, max_rows) ->
        {stats, acc}

      n <= page_size ->
        docs = range_docs(searcher, lo, hi, page_size)
        acc = fun.(docs, acc)

        stats = %{
          stats
          | pages: stats.pages + 1,
            rows: stats.rows + length(docs),
            budget_hit: stats.budget_hit or budget_spent?(stats.rows + length(docs), max_rows)
        }

        walk(rest, searcher, page_size, max_rows, fun, stats, acc)

      true ->
        mid = div(lo + hi, 2)

        # Lower half first: the walk stays ascending even while splitting.
        walk([{lo, mid}, {mid + 1, hi} | rest], searcher, page_size, max_rows, fun, stats, acc)
    end
  end

  # Exact match count for an id range. `search_range_u64`'s `total_hits` is
  # `min(matches, limit)` (muninn's `execute_query` sets it to `top_docs.len()`),
  # so it cannot tell a dense range from a full page — the count query can.
  defp range_count(searcher, lo, hi) do
    case Muninn.Searcher.count(searcher, "message_id:[#{lo} TO #{hi}]", ["content"]) do
      {:ok, n} when is_integer(n) -> n
      _ -> 0
    end
  end

  defp range_docs(searcher, lo, hi, limit) do
    case Muninn.Searcher.search_query(
           searcher,
           "message_id:[#{lo} TO #{hi}]",
           ["content"],
           limit: limit
         ) do
      {:ok, %{"hits" => hits}} -> Enum.map(hits, &(&1["doc"] || &1[:doc] || %{}))
      {:ok, %{hits: hits}} -> Enum.map(hits, &(&1["doc"] || &1[:doc] || %{}))
      _ -> []
    end
  end

  # -- internals -----------------------------------------------------------------

  defp budget_spent?(_rows, :infinity), do: false
  defp budget_spent?(rows, max_rows), do: rows >= max_rows

  defp message_where(after_id, nil) do
    {"WHERE channel_id = ? AND bucket = ? AND message_id > ?", [{"bigint", after_id}]}
  end

  defp message_where(after_id, to_id) do
    {"WHERE channel_id = ? AND bucket = ? AND message_id > ? AND message_id <= ?",
     [{"bigint", after_id}, {"bigint", to_id}]}
  end

  # Buckets spanned by the workspace's life, newest-first when asked. The floor
  # is the workspace's own creation instant: `messages` rows are only ever
  # written by the app, so nothing predates it and the ~2900 epoch-side empty
  # buckets can never be read.
  defp buckets_for(workspace_id, direction) do
    now_bucket = Messages.bucket_for(System.system_time(:millisecond))

    floor_bucket =
      case Workspaces.get_workspace(workspace_id) do
        %{created_at: %DateTime{} = created_at} ->
          Messages.bucket_for(DateTime.to_unix(created_at, :millisecond))

        _ ->
          0
      end

    range = min(floor_bucket, now_bucket)..now_bucket
    if direction == :asc, do: Enum.to_list(range), else: Enum.reverse(Enum.to_list(range))
  end

  defp clamp_page_size(n) when is_integer(n) and n > 0, do: min(n, @driver_page_size)
  defp clamp_page_size(_), do: 500

  @doc "The driver's default page size — the bound a single read must respect."
  @spec driver_page_size :: pos_integer()
  def driver_page_size, do: @driver_page_size
end
