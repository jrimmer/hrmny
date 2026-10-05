defmodule Cytale.Gateway.AdmissionLimiter do
  @moduledoc """
  Reconnect-storm damping scaffold (U10): a sliding-window counter per
  `kind × ip` (kinds: `:identify`, `:resume`) over one ETS table of timestamped
  events, capping gateway admission attempts per client IP. U9 later folds this
  into its general plug rate-limit pattern — what survives is the bucket-kind
  shape and the `{admit | refuse}` decision pair.

  Counting is exact (one entry per event, pruned periodically). The limiter
  fails OPEN: any internal error admits the connection rather than taking the
  gateway down with it.
  """

  use GenServer
  require Logger

  @window_ms 10_000
  @identify_limit 30
  @resume_limit 60
  @cleanup_interval_ms 5_000

  @type kind :: :identify | :resume
  @type decision :: {:ok, non_neg_integer()} | {:rate_limited, non_neg_integer()}

  # -- Public API -------------------------------------------------------------

  @doc "Starts the pruning loop; owns the backing ETS table."
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(_opts \\ []) do
    GenServer.start_link(__MODULE__, :ok, name: __MODULE__)
  end

  @doc """
  Record + judge one admission attempt.

      {:ok, n}            → admit; n = attempts inside the window including this one
      {:rate_limited, ms} → refuse; ms = suggested retry delay
  """
  @spec check(kind(), term()) :: decision()
  def check(kind, ip), do: check(kind, ip, System.monotonic_time(:millisecond))

  @doc "Time-injected variant for tests."
  @spec check(kind(), term(), integer()) :: decision()
  def check(kind, ip, now_mono_ms)
      when kind in [:identify, :resume] and is_integer(now_mono_ms) do
    key = {kind, ip}
    cutoff = now_mono_ms - @window_ms

    try do
      :ets.insert(table(), {{key, now_mono_ms, make_ref()}, nil})
      count = count_recent(key, cutoff)

      if count > limit_for(kind) do
        {:rate_limited, retry_after()}
      else
        {:ok, count}
      end
    catch
      class, reason ->
        Logger.warning("gateway admission limiter error (#{class}): #{inspect(reason)}")
        {:ok, 0}
    end
  end

  def check(_kind, _ip, _now_mono_ms), do: {:ok, 0}

  @doc "Events recorded inside the current window for `kind × ip`."
  @spec recent_count(kind(), term(), integer()) :: non_neg_integer()
  def recent_count(kind, ip, now_mono_ms) do
    count_recent({kind, ip}, now_mono_ms - @window_ms)
  rescue
    _ -> 0
  end

  # Test isolation: gateway suites share one client IP, and their combined
  # Identify volume legitimately exceeds the production burst cap within the
  # sliding window. Clears every recorded attempt.
  @spec reset() :: :ok
  def reset do
    if :ets.whereis(table()) != :undefined do
      :ets.delete_all_objects(table())
    end

    :ok
  end

  @doc "Window size + per-kind limits as a plain map (tests/observability)."
  @spec config() :: %{window_ms: pos_integer(), identify: pos_integer(), resume: pos_integer()}
  def config, do: %{window_ms: @window_ms, identify: @identify_limit, resume: @resume_limit}

  # -- GenServer ---------------------------------------------------------------

  @impl true
  def init(:ok) do
    # `:ordered_set`, not `:set`: the keys are `{{kind, ip}, ts, ref}`, so the
    # per-key window count is a range scan of one key prefix (plan 5.5) and the
    # periodic prune below can still fold everything.
    :ets.new(table(), [:ordered_set, :named_table, :public, read_concurrency: true])
    Process.send_after(self(), :cleanup, @cleanup_interval_ms)
    {:ok, %{}}
  end

  @impl true
  # The periodic prune still folds the table: it runs on a timer (every 5s), not
  # per admission, so it is not the path 5.5 is about. It also has to touch every
  # key by definition — pruning IS a whole-table question.
  def handle_info(:cleanup, state) do
    cutoff = System.monotonic_time(:millisecond) - @window_ms

    stale_keys =
      :ets.foldl(
        fn
          {{key, ts, _ref}, nil}, acc when ts < cutoff -> [key | acc]
          _entry, acc -> acc
        end,
        [],
        table()
      )

    Enum.each(stale_keys, fn key ->
      :ets.match_delete(table(), {{key, :_, :_}, nil})
    end)

    Process.send_after(self(), :cleanup, @cleanup_interval_ms)
    {:noreply, state}
  end

  # -- Internals ----------------------------------------------------------------

  defp table, do: __MODULE__

  # Counted with a KEY-RANGE select (hardening plan 5.5): the table is an
  # `:ordered_set` whose keys are `{{kind, ip}, ts, ref}`, so a partially-bound key
  # prefix is a contiguous range and ETS walks only this key's entries. It used to
  # `:ets.foldl` the WHOLE table per admission check — every Identify and every
  # Resume paid for every other client IP's attempts inside the window, which is
  # exactly the storm this limiter exists to damp.
  defp count_recent(key, cutoff) do
    match = [{{{key, :"$1", :_}, :_}, [{:>=, :"$1", cutoff}], [true]}]
    :ets.select_count(table(), match)
  end

  defp limit_for(:identify), do: @identify_limit
  defp limit_for(:resume), do: @resume_limit

  defp retry_after, do: max(div(@window_ms, 4), 250)
end
