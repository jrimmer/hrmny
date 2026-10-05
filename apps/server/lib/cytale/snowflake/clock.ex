defmodule Cytale.Snowflake.Clock do
  @moduledoc """
  Snowflake monotonicity ACROSS restarts (review #24).

  `Cytale.Snowflake` is strictly monotonic within a run — its atomics cell
  never moves backwards — but the cell starts from the wall clock at boot. If
  the clock stepped back while the node was down (VM guests drift; an NTP
  correction after a restore), the new run could mint an id the previous run
  already issued, and a `messages` INSERT with a repeated primary key is an
  upsert: it silently OVERWRITES the stored message.

  This process closes that with a lease on the worker's timestamp space:

    * every `@refresh_ms` it persists `snowflake_clock(worker_id) =
      max(now, cell) + @lease_ms` — a high-water mark AHEAD of every id the
      run has issued or can issue before the next refresh;
    * at boot it reads that mark back and raises the cell's floor to it
      (`Cytale.Snowflake.raise_floor/1`), so the first id of the new run is
      newer than any id of the old one, whatever the clock now says. The
      generator mints from the cell's own time while the wall clock is behind
      it, so a large step back does not stall anything.

  Until the mark is read (the pool connects asynchronously) the node may mint
  ids from the wall clock alone — the pre-existing behaviour, and the reason
  the boot path waits for `await_restored/1` before starting a deferred
  endpoint. A mark that cannot be read within the grace window is logged and
  the node proceeds; the refresh keeps trying to WRITE, so the next restart
  is protected.
  """

  use GenServer

  require Logger

  alias Cytale.Repo
  alias Cytale.Snowflake

  @refresh_ms 1_000
  @lease_ms 5_000
  @restore_grace_ms 30_000
  @restore_poll_ms 250

  @doc false
  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @doc """
  Block until the boot restore has run (or `timeout_ms` passes). `:ok` either
  way — a node must still come up when the mark is unreadable — but the
  caller then knows the floor is seeded before it opens the endpoint.
  """
  @spec await_restored(timeout()) :: :ok
  def await_restored(timeout_ms \\ @restore_grace_ms + 5_000) do
    case Process.whereis(__MODULE__) do
      nil -> :ok
      pid -> GenServer.call(pid, :await_restored, timeout_ms)
    end
  catch
    :exit, _ -> :ok
  end

  @doc "Read the persisted high-water mark for this worker (nil when none)."
  @spec persisted_high_water(non_neg_integer()) :: integer() | nil
  def persisted_high_water(worker_id \\ Snowflake.worker_id()) do
    "SELECT high_water_ms FROM {{K}}.snowflake_clock WHERE worker_id = ?"
    |> Repo.query!([{"int", worker_id}])
    |> Enum.to_list()
    |> case do
      [%{"high_water_ms" => ms}] when is_integer(ms) -> ms
      _ -> nil
    end
  end

  @doc "Persist the lease now (and return the mark written)."
  @spec persist(non_neg_integer()) :: integer()
  def persist(worker_id \\ Snowflake.worker_id()) do
    mark = max(System.system_time(:millisecond), Snowflake.high_water_ms()) + @lease_ms

    Repo.query!(
      "UPDATE {{K}}.snowflake_clock SET high_water_ms = ? WHERE worker_id = ?",
      [{"bigint", mark}, {"int", worker_id}]
    )

    mark
  end

  @doc """
  The boot restore, callable directly (tests): read the mark and raise the
  generator's floor to it. `{:ok, mark | nil}` or `{:error, reason}`.
  """
  @spec restore(non_neg_integer()) :: {:ok, integer() | nil} | {:error, term()}
  def restore(worker_id \\ Snowflake.worker_id()) do
    case persisted_high_water(worker_id) do
      nil ->
        {:ok, nil}

      mark ->
        behind = mark - System.system_time(:millisecond)

        if behind > @lease_ms do
          Logger.warning(
            "snowflake: wall clock is #{behind} ms behind the previous run's high-water mark; " <>
              "minting from the persisted mark until the clock catches up"
          )
        end

        :ok = Snowflake.raise_floor(mark)
        {:ok, mark}
    end
  rescue
    e -> {:error, e}
  end

  @impl true
  def init(_opts) do
    {:ok, %{restored?: false, waiters: [], started_at: System.monotonic_time(:millisecond)}, {:continue, :restore}}
  end

  @impl true
  def handle_continue(:restore, state), do: {:noreply, try_restore(state)}

  @impl true
  def handle_call(:await_restored, _from, %{restored?: true} = state), do: {:reply, :ok, state}
  def handle_call(:await_restored, from, state), do: {:noreply, %{state | waiters: [from | state.waiters]}}

  @impl true
  def handle_info(:restore, state), do: {:noreply, try_restore(state)}

  def handle_info(:refresh, state) do
    try do
      persist()
    rescue
      e -> Logger.warning("snowflake: high-water refresh failed: #{Exception.message(e)}")
    end

    Process.send_after(self(), :refresh, @refresh_ms)
    {:noreply, state}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  defp try_restore(state) do
    waited = System.monotonic_time(:millisecond) - state.started_at

    case restore() do
      {:ok, _mark} ->
        restored(state)

      {:error, reason} when waited < @restore_grace_ms ->
        _ = reason
        Process.send_after(self(), :restore, @restore_poll_ms)
        state

      {:error, reason} ->
        Logger.error(
          "snowflake: could not read the persisted high-water mark (#{inspect(reason)}); " <>
            "ids are monotonic within this run only until the next refresh lands"
        )

        restored(state)
    end
  end

  defp restored(state) do
    Enum.each(state.waiters, &GenServer.reply(&1, :ok))
    send(self(), :refresh)
    %{state | restored?: true, waiters: []}
  end
end
