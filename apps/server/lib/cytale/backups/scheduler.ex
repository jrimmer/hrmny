defmodule Cytale.Backups.Scheduler do
  @moduledoc """
  The backup schedule (#120) — a GenServer in the supervision tree that runs
  the backup job on the configured cadence, catches up on boot when a window
  was missed, and prunes past retention in the same pass.

  ## The cadence

  `backups.frequency` (`hourly | daily | weekly` — the editor's enum) sets the
  interval; `backups.enabled`, `backups.retention` and `backups.dir` are read
  HOT on every tick through `Cytale.ServerConfig`, so an editor save applies
  without a restart. There is no separate hour knob (the v1 editor surface is
  exactly frequency + retention): the anchor is the last SUCCESSFUL run,
  recorded in `<backups.dir>/.scheduler-state.json` — which is also what makes
  catch-up honest. On boot the state file is read back; if
  `now - last_success >= interval` (or no state file exists — a fresh install
  backs up immediately, which is also how the pipeline proves itself), the
  first tick runs the job. A boot after a missed window therefore catches up
  within one poll, not one interval.

  ## Poll, don't count

  The loop is a repeating `Process.send_after` TICK (default every 60s) that
  asks "am I due?", not a timer armed for the exact next instant: a hot
  frequency change, a changed clock, or a missed wake-up all self-correct on
  the next poll. Ticks are cheap (one file read + one comparison).

  ## Single-flight, failure is never silent

  ONE backup runs at a time, in total (the same box, the same ScyllaDB memory
  confinement as the rebuild and export runners). The walk runs in a Task
  under `Cytale.Backups.TaskSupervisor` with the runner's monitor as the
  second net: whatever the task does — raise, exit, be killed — the run
  reaches a terminal outcome and the outcome is RECORDED, on
  `Cytale.Backups.Metrics` (`cytale_backups_total{result=…}` etc., exposed on
  `/metrics`) and in the log.

  The scheduler only starts where the database pool is part of the boot path
  (`:start_backups_scheduler`, defaulting to `:start_scylla_pool`'s value):
  the hermetic test boot runs no ticks, and suites that need the scheduler
  start it supervised themselves.
  """

  use GenServer

  alias Cytale.Backups.Archive
  alias Cytale.Backups.Metrics
  alias Cytale.ServerConfig

  require Logger

  @name __MODULE__
  @default_poll_ms 60_000

  @frequencies %{
    "hourly" => 3_600_000,
    "daily" => 86_400_000,
    "weekly" => 7 * 86_400_000
  }

  # -- API -----------------------------------------------------------------------

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: @name)
  end

  @doc """
  Force the due-check + run now (tests, and an operator who does not want to
  wait out the poll). Returns `:ok`, or `{:error, :already_running}` when a
  run is in flight.
  """
  @spec run_now() :: :ok | {:error, :already_running}
  def run_now do
    GenServer.call(@name, :run_now, 10_000)
  end

  @doc "The interval in ms for a configured frequency string (daily for unknown)."
  @spec interval_ms(String.t()) :: pos_integer()
  def interval_ms(freq) when is_binary(freq), do: Map.get(@frequencies, freq, @frequencies["daily"])

  @doc "Read the scheduler state file (last success) for `dir`."
  @spec read_state(String.t()) :: %{last_success_at: DateTime.t() | nil}
  def read_state(dir) do
    path = state_path(dir)

    case File.read(path) do
      {:ok, raw} ->
        case Jason.decode(raw) do
          {:ok, %{"last_success_at" => iso}} when is_binary(iso) ->
            case DateTime.from_iso8601(iso) do
              {:ok, dt, _} -> %{last_success_at: dt}
              _ -> fresh_state()
            end

          _ ->
            fresh_state()
        end

      _ ->
        fresh_state()
    end
  end

  defp fresh_state, do: %{last_success_at: nil}

  # -- GenServer -----------------------------------------------------------------

  @impl true
  def init(_opts) do
    Metrics.init()
    {:ok, arm(%{timer: nil, running: nil})}
  end

  defp arm(state) do
    if state.timer, do: Process.cancel_timer(state.timer)
    %{state | timer: Process.send_after(self(), :tick, poll_ms())}
  end

  defp poll_ms do
    case Application.get_env(:cytale, :backups_poll_ms) do
      n when is_integer(n) and n > 0 -> n
      _ -> @default_poll_ms
    end
  end

  # Injectable clock: tests freeze or skew time without sleeping.
  defp now do
    case Application.get_env(:cytale, :backups_clock_fn) do
      fun when is_function(fun, 0) -> fun.()
      _ -> DateTime.utc_now()
    end
  end

  @impl true
  def handle_call(:run_now, _from, state) do
    case maybe_start_run(state, force: true) do
      {:started, state} -> {:reply, :ok, state}
      :not_enabled -> {:reply, {:error, :not_enabled}, state}
      :busy -> {:reply, {:error, :already_running}, state}
    end
  end

  @impl true
  def handle_info(:tick, state) do
    state = arm(state)

    case maybe_start_run(state, force: false) do
      {:started, state} -> {:noreply, state}
      _other -> {:noreply, state}
    end
  end

  def handle_info({:backup_done, id, outcome}, %{running: %{id: id}} = state) do
    finish_run(state.running, outcome)
    {:noreply, %{state | running: nil}}
  end

  # The second net: a task that died without reporting cannot pin the runner.
  def handle_info({:DOWN, ref, :process, _pid, reason}, %{running: %{monitor: ref}} = state) do
    finish_run(state.running, {:error, {:task_down, reason}})
    {:noreply, %{state | running: nil}}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  # -- the run ---------------------------------------------------------------------

  defp maybe_start_run(state, opts) do
    enabled? = ServerConfig.backups_enabled?()
    force? = Keyword.get(opts, :force, false)

    cond do
      state.running != nil ->
        :busy

      not enabled? ->
        # Force (run_now/0) never overrides the enable switch: `backups.enabled`
        # is the deployment fact that says this node does not back up.
        :not_enabled

      not due?() and not force? ->
        :not_due

      true ->
        start_run(state)
    end
  end

  # Catch-up-on-boot falls out of the anchor: no state file (fresh install or
  # first run) => due immediately; a state file older than the interval => due.
  defp due? do
    dir = Archive.resolve_dir(nil)
    clock = now()
    last = read_state(dir).last_success_at

    if last == nil do
      true
    else
      DateTime.diff(clock, last, :millisecond) >= interval_ms(ServerConfig.backup_frequency())
    end
  end

  defp start_run(state) do
    id = Archive.new_id()
    parent = self()

    # LINKED, not under a shared supervisor: a stopping scheduler takes its
    # in-flight run with it — a runner restart (or a test teardown) must never
    # leak a walk into whatever directory the config names NEXT (the next tick
    # re-runs the missed window by catch-up). The task rescues its own
    # failures, so the link is one-directional insurance; the monitor is the
    # second net that turns any silent death into a recorded failure.
    pid =
      spawn_link(fn ->
        outcome = run_backup(id)
        send(parent, {:backup_done, id, outcome})
      end)

    {:started, %{state | running: %{id: id, monitor: Process.monitor(pid), started_at: now()}}}
  end

  defp run_backup(id) do
    started = System.monotonic_time(:millisecond)
    # Archive.write raises on IO/DB failure by design — the rescue is the
    # failure path that lands as a counted, logged run outcome.
    {:ok, summary} = Archive.write(id: id)
    {:ok, summary, System.monotonic_time(:millisecond) - started}
  rescue
    e -> {:error, Exception.message(e)}
  end

  defp finish_run(%{id: id, started_at: started_at}, outcome) do
    duration = max(0, DateTime.diff(now(), started_at, :millisecond))

    case outcome do
      {:ok, summary, duration_ms} ->
        unix = DateTime.to_unix(now(), :second)
        Metrics.record(:success, duration_ms || duration, unix)
        write_state(DateTime.to_iso8601(now()))
        prune(Archive.resolve_dir(nil), ServerConfig.backup_retention())

        Logger.info(
          "backup #{id} finished in #{duration_ms || duration}ms: #{summary.tables} table(s), " <>
            "#{summary.rows} row(s), #{summary.bytes} byte(s) — retention is #{ServerConfig.backup_retention()}"
        )

      {:error, reason} ->
        Metrics.record(:failure, duration, nil)
        Logger.error("backup #{id} FAILED after #{duration}ms: #{inspect(reason)}")
    end

    :ok
  end

  defp write_state(iso) do
    dir = Archive.resolve_dir(nil)
    File.mkdir_p!(dir)

    case Cytale.ServerConfig.write_atomic(state_path(dir), Jason.encode!(%{"last_success_at" => iso}), 0o600) do
      :ok -> :ok
      {:error, reason} -> Logger.error("backup scheduler: could not write state file (#{inspect(reason)})")
    end
  end

  defp state_path(dir), do: Path.join(dir, ".scheduler-state.json")

  @doc """
  Keep the newest `retention` archives (by id — ids sort chronologically),
  deleting the rest with their listing sidecars. Files that do not carry a
  parseable backup id are never touched: prune deletes what it can DATE,
  nothing else.
  """
  @spec prune(String.t(), pos_integer()) :: :ok
  def prune(dir, retention) when is_integer(retention) and retention >= 1 do
    # Abandoned staging dirs are reclaimed on the same quiet-time pass
    # (hardening plan 4.8); age-guarded inside, so a CONCURRENT backup's own
    # staging dir is never touched.
    _ = Archive.sweep_staging(dir)

    # The KEPT pre-restore safety snapshots ride this pass too (hardening plan
    # 4.7): only the newest one is a recovery point an operator can still use,
    # and nothing else in the system reclaims them.
    _ = Archive.sweep_safety(dir)

    case File.ls(dir) do
      {:ok, files} ->
        archives =
          files
          |> Enum.filter(fn f ->
            # COMPLETE archives only (hardening plan 4.8). The sidecar is
            # written AFTER the tar finishes, so a `.tar` without one is an
            # interrupted backup — docker's 10s SIGKILL mid-walk is the usual
            # cause. Counting those as real let a partial archive occupy a
            # retention slot and evict the oldest RESTORABLE one, turning one
            # failed backup into the loss of a good one.
            #
            # Deliberately NOT deleted here: a tar with no sidecar may be a
            # backup that is still RUNNING (this prune shares its directory
            # with the in-flight writer), and removing it would corrupt that
            # run. Exclusion from retention is the fix; reclaiming stale
            # sidecar-less leftovers is a separate, quiet-time concern.
            String.ends_with?(f, ".tar") and Archive.valid_id?(Path.basename(f, ".tar")) and
              File.exists?(Path.join(dir, "#{Path.basename(f, ".tar")}.manifest.json"))
          end)
          |> Enum.sort(:desc)

        Enum.each(Enum.drop(archives, retention), fn stale ->
          id = Path.basename(stale, ".tar")
          File.rm(Path.join(dir, stale))
          File.rm(Path.join(dir, "#{id}.manifest.json"))
          Logger.info("backup prune: removed #{id} (past retention of #{retention})")
        end)

        :ok

      _ ->
        :ok
    end
  end

  def prune(_dir, _retention), do: :ok
end
