defmodule Cytale.Telemetry.Stats do
  @moduledoc """
  Hot-path latency aggregates (the pillars, made observable).

  Attaches to the hop telemetry the plan budgets — `[:cytale, :scylla,
  :insert_duration]` (≤ 50ms) and `[:cytale, :fanout, :latency]` (≤ 5ms) —
  and keeps a bounded ring of the most recent samples per metric in a
  public ETS table. `snapshot/0` returns per-metric count/mean/p99/max over
  that window; the admin metrics endpoint and the soak harness assert
  against it.

  #89 added one long-running metric: the search-index rebuild's per-page
  duration (`:search_rebuild_page_ms`), so an operator watching `/metrics`
  sees a rebuild advancing.
  """

  use GenServer

  @table __MODULE__.Samples
  @metrics [
    {[:cytale, :scylla, :insert_duration], :scylla_insert_ms},
    {[:cytale, :fanout, :latency], :fanout_dispatch_ms},
    # #89: one sample per rebuild page, so a long rebuild is visible on the
    # metrics surface WHILE it runs rather than only when it ends.
    {[:cytale, :search, :rebuild, :page], :search_rebuild_page_ms},
    # Review #20/#23: the send path end to end. `message_post_ms` is the native
    # POST /messages handler (accept → response ready); `message_deliver_ms`
    # is accept → the push to each recipient's socket, so it includes the
    # persist, the publish cast, the fan-out queue and the socket's mailbox.
    {[:cytale, :message, :post_ms], :message_post_ms},
    {[:cytale, :message, :deliver_ms], :message_deliver_ms}
  ]

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(_opts \\ []) do
    GenServer.start_link(__MODULE__, :ok, name: __MODULE__)
  end

  @doc "Per-metric aggregates over the retained sample window (ms)."
  @spec snapshot() :: %{
          optional(atom()) => %{count: non_neg_integer(), mean_ms: number(), p99_ms: number(), max_ms: number()}
        }
  def snapshot do
    Map.new(@metrics, fn {_event, key} ->
      samples = :ets.lookup(@table, key)

      values =
        samples
        |> Enum.map(fn {_, _, v, _} -> v end)
        |> Enum.sort()

      {key, aggregate(values)}
    end)
  end

  defp aggregate([]), do: %{count: 0, mean_ms: 0.0, p99_ms: 0.0, max_ms: 0.0}

  defp aggregate(values) do
    n = length(values)
    mean = Enum.sum(values) / n
    p99 = Enum.at(values, floor(n * 0.99) - min(n, 1)) || List.last(values)
    max = List.last(values)
    %{count: n, mean_ms: Float.round(mean * 1.0, 3), p99_ms: p99, max_ms: max}
  end

  # Telemetry handler (module capture — no closure penalty on the hot path).
  def handle_event(_event, measurements, _meta, key) do
    value = Map.get(measurements, :duration_ms) || Map.get(measurements, :latency)

    if is_number(value) do
      # MILLISECONDS, matching `trim/0`'s cutoff. This used to store
      # `System.monotonic_time/0` (native units) while trim subtracted 60_000
      # from it — 60 MICROseconds, not the documented 60 seconds.
      :ets.insert(@table, {key, System.monotonic_time(:millisecond), value, nil})
    end
  end

  @doc "Clear the sample rings (test/soak phase isolation — boot-phase samples under co-tenant load otherwise pollute p99 for the full 60s retention)."
  @spec reset() :: :ok
  def reset do
    if :ets.whereis(@table) != :undefined do
      :ets.delete_all_objects(@table)
    end

    :ok
  end

  # -- GenServer -----------------------------------------------------------

  @impl true
  def init(:ok) do
    :ets.new(@table, [:duplicate_bag, :named_table, :public, read_concurrency: true])

    for {event, key} <- @metrics do
      :telemetry.attach({__MODULE__, key}, event, &__MODULE__.handle_event/4, key)
    end

    # #54: the mark outcome counters live beside the latency rings (this
    # process is always supervised, so it owns their table).
    :ok = Cytale.Marks.Metrics.init()
    # Review #22/#24: the delivery-loss counters (dropped offline appends,
    # post-write publish failures, nonce-claim failures) — same ownership.
    :ok = Cytale.Telemetry.DeliveryCounters.init()
    # The media proxy's request/fetch/byte counters — same ownership.
    :ok = Cytale.MediaProxy.Metrics.init()

    # Bound the ring: old samples age out periodically.
    :timer.send_interval(10_000, :trim)
    {:ok, %{}}
  end

  @impl true
  def handle_info(:trim, state) do
    cutoff = System.monotonic_time(:millisecond) - 60_000

    # `:ets.select_delete/2`, NOT a `:ets.lookup/2` + `Enum.take_while/2` walk
    # (hardening plan 7.13). The walk assumed stale samples were contiguous and
    # first, but `:duplicate_bag` returns rows in unspecified order — one
    # in-window sample landing between two stale ones stopped the walk and
    # stranded the trailing stale rows in the table forever, so the ring grew
    # without bound. `select_delete` removes every row below the cutoff in one
    # order-independent pass.
    for {_event, key} <- @metrics do
      :ets.select_delete(@table, [{{key, :"$1", :_, :_}, [{:<, :"$1", cutoff}], [true]}])
    end

    {:noreply, state}
  end
end
