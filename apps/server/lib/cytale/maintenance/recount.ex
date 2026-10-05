defmodule Cytale.Maintenance.Recount do
  @moduledoc """
  The periodic recount job for denormalized counts that can DRIFT (review
  #24):

    * a thread's `message_count` mirrors — each moved by an optimistic LWT
      that gives up after its attempts under contention
      (`Cytale.Threads.Thread.record_reply/3`, `record_reply_removed/1`);
    * a message's per-emoji reaction tallies — the existence row's LWT and
      the counter bump are separate statements, so a failure between them
      leaves the tally off while the row is right
      (`Cytale.Messages.Reactions`).

  Both used to log the drift and keep it forever. Now the site that detects
  it QUEUES the entity here (`mark_thread/1`, `mark_reactions/2`), and every
  `@interval_ms` this job rederives at most `@per_tick` queued counts from
  the authoritative rows (`Thread.recount/1`, `Reactions.recount/2`). A
  recount that raced a concurrent write reports `:retry` and stays queued.

  Cheap and bounded by construction: only entities a writer flagged are ever
  recounted (no table walks), and a tick does a fixed maximum of work. The
  queue is in memory — a restart forgets it, which costs at most a stale count
  that the next drift on the same entity re-queues; no message is ever at
  stake, the rows are the authority. Without the owner running, marks are
  no-ops.
  """

  use GenServer

  require Logger

  @table __MODULE__.Queue
  @interval_ms 60_000
  @per_tick 100

  @doc false
  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @doc "Queue a thread's `message_count` for a recount."
  @spec mark_thread(integer()) :: :ok
  def mark_thread(thread_id) when is_integer(thread_id), do: mark({:thread, thread_id})

  @doc "Queue a message's reaction tallies for a recount."
  @spec mark_reactions(integer(), integer()) :: :ok
  def mark_reactions(channel_id, message_id) when is_integer(channel_id) and is_integer(message_id),
    do: mark({:reactions, channel_id, message_id})

  @doc "What is queued (tests, diagnostics)."
  @spec queued() :: [tuple()]
  def queued do
    if :ets.whereis(@table) == :undefined, do: [], else: Enum.map(:ets.tab2list(@table), &elem(&1, 0))
  end

  @doc """
  Run one tick now (tests; an operator nudge). Returns
  `%{done: n, retry: n, skipped: n}`.
  """
  @spec run_once() :: map()
  def run_once do
    case Process.whereis(__MODULE__) do
      nil -> %{done: 0, retry: 0, skipped: 0}
      pid -> GenServer.call(pid, :run_once, 60_000)
    end
  end

  defp mark(entry) do
    if :ets.whereis(@table) != :undefined, do: :ets.insert(@table, {entry})
    :ok
  rescue
    ArgumentError -> :ok
  end

  @impl true
  def init(_opts) do
    :ets.new(@table, [:set, :named_table, :public, write_concurrency: true])
    Process.send_after(self(), :tick, @interval_ms)
    {:ok, %{}}
  end

  @impl true
  def handle_call(:run_once, _from, state), do: {:reply, tick(), state}

  @impl true
  def handle_info(:tick, state) do
    _ = tick()
    Process.send_after(self(), :tick, @interval_ms)
    {:noreply, state}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  defp tick do
    @table
    |> :ets.tab2list()
    |> Enum.take(@per_tick)
    |> Enum.reduce(%{done: 0, retry: 0, skipped: 0}, fn {entry}, acc ->
      outcome = recount(entry)
      if outcome != :retry, do: :ets.delete(@table, entry)
      Map.update!(acc, outcome_key(outcome), &(&1 + 1))
    end)
  end

  defp outcome_key(:ok), do: :done
  defp outcome_key(:retry), do: :retry
  defp outcome_key(_skipped), do: :skipped

  defp recount({:thread, thread_id}), do: guarded(fn -> Cytale.Threads.Thread.recount(thread_id) end)

  defp recount({:reactions, channel_id, message_id}),
    do: guarded(fn -> Cytale.Messages.Reactions.recount(channel_id, message_id) end)

  # A recount that raises (the database is down) stays queued for the next tick.
  defp guarded(fun) do
    fun.()
  rescue
    e ->
      Logger.warning("recount failed (#{Exception.message(e)}); will retry")
      :retry
  end
end
