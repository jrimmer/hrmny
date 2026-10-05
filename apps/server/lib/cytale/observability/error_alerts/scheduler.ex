defmodule Cytale.Observability.ErrorAlerts.Scheduler do
  @moduledoc """
  The client-error alert cadence (#138) — a GenServer in the supervision tree
  that runs `Cytale.Observability.ErrorAlerts.run/0` when due, with NO second
  scheduling idiom: this is `Cytale.Backups.Scheduler`'s shape, applied to the
  alert pass.

  ## Poll, don't count

  A repeating `Process.send_after` TICK (default every 60s) asks "am I due?",
  never a timer armed for the exact next instant: a hot interval change, a
  changed clock, or a missed wake-up all self-correct on the next poll. The
  anchor is the last COMPLETED pass, `last_run_at` in the ledger file (see
  `ErrorAlerts.Ledger`) — which is also what makes catch-up honest: a boot
  after a missed interval (or a fresh install, which has no anchor) runs the
  pass within one poll.

  ## Hot config

  `observability.error_alerts_enabled` and
  `observability.error_alert_interval_minutes` are read on every tick through
  `Cytale.ServerConfig` — an editor save applies without a restart. The
  enabled switch is the ticket's off switch, and (like the backups
  scheduler's) it is never overridden by `run_now/0`: OFF means this node
  does not alert, and the error store keeps recording regardless.

  ## Single-flight, failure is never silent

  ONE pass runs at a time. It runs LINKED (a stopping scheduler takes its
  in-flight pass with it) with the monitor as the second net: whatever the
  pass does — raise, exit, be killed — a terminal outcome reaches
  `ErrorAlerts.Metrics` (`cytale_error_alerts_total{result=…}`, on `/metrics`)
  and the log. A failed pass does NOT advance the ledger's anchor, so the
  next tick retries: a Scylla hiccup is log-and-retry, never a crash loop,
  never silence.

  The scheduler only starts where the database pool is part of the boot path
  (`:start_error_alerts_scheduler`, defaulting to `:start_scylla_pool`'s
  value), and never in restore mode: alerting over half-restored data would
  be noise. The hermetic test boot runs no ticks; suites that need the
  scheduler start it supervised themselves.
  """

  use GenServer

  alias Cytale.Observability.ErrorAlerts
  alias Cytale.Observability.ErrorAlerts.{Ledger, Metrics}
  alias Cytale.ServerConfig

  require Logger

  @name __MODULE__
  @default_poll_ms 60_000

  # -- API -----------------------------------------------------------------------

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: @name)
  end

  @doc """
  Force the due-check + pass now (tests, and an operator who does not want to
  wait out the poll). Returns `:ok`, `{:error, :already_running}` when a pass
  is in flight, or `{:error, :not_enabled}` — force never overrides the off
  switch.
  """
  @spec run_now() :: :ok | {:error, :already_running | :not_enabled}
  def run_now do
    GenServer.call(@name, :run_now, 10_000)
  end

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
    case Application.get_env(:cytale, :error_alerts_poll_ms) do
      n when is_integer(n) and n > 0 -> n
      _ -> @default_poll_ms
    end
  end

  # Injectable clock: tests freeze or skew time without sleeping (the same
  # seam the backups scheduler uses, same name).
  defp now do
    case Application.get_env(:cytale, :error_alerts_clock_fn) do
      fun when is_function(fun, 0) -> fun.()
      _ -> DateTime.utc_now()
    end
  end

  @impl true
  def handle_call(:run_now, _from, state) do
    case maybe_start_pass(state, force: true) do
      {:started, state} -> {:reply, :ok, state}
      :not_enabled -> {:reply, {:error, :not_enabled}, state}
      :busy -> {:reply, {:error, :already_running}, state}
    end
  end

  @impl true
  def handle_info(:tick, state) do
    state = arm(state)

    case maybe_start_pass(state, force: false) do
      {:started, state} -> {:noreply, state}
      _other -> {:noreply, state}
    end
  end

  def handle_info({:alert_pass_done, id, outcome}, %{running: %{id: id}} = state) do
    finish_pass(state.running, outcome)
    {:noreply, %{state | running: nil}}
  end

  # The second net: a pass that died without reporting cannot pin the alerter.
  def handle_info({:DOWN, ref, :process, _pid, reason}, %{running: %{monitor: ref}} = state) do
    finish_pass(state.running, {:error, {:task_down, reason}})
    {:noreply, %{state | running: nil}}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  # -- the pass --------------------------------------------------------------------

  defp maybe_start_pass(state, opts) do
    enabled? = ServerConfig.error_alerts_enabled?()
    force? = Keyword.get(opts, :force, false)

    cond do
      state.running != nil ->
        :busy

      not enabled? ->
        # Force (run_now/0) never overrides the enable switch: the off switch
        # is a deployment posture, and silence here is the feature working.
        :not_enabled

      not due?() and not force? ->
        :not_due

      true ->
        start_pass(state)
    end
  end

  # Catch-up-on-boot falls out of the anchor: no ledger (fresh install or
  # first pass) => due immediately; an anchor older than the interval => due.
  defp due? do
    clock = now()
    last = Ledger.load().last_run_at

    if last == nil do
      true
    else
      DateTime.diff(clock, last, :millisecond) >= ServerConfig.error_alert_interval_minutes() * 60_000
    end
  end

  defp start_pass(state) do
    id = System.unique_integer([:positive])
    parent = self()

    # LINKED, not under a shared supervisor — the backups scheduler's exact
    # shape: a stopping scheduler takes its in-flight pass with it, the task
    # rescues its own failures into a terminal outcome, and the monitor is
    # the second net that turns any silent death into a recorded failure.
    pid =
      spawn_link(fn ->
        outcome = run_pass()
        send(parent, {:alert_pass_done, id, outcome})
      end)

    {:started, %{state | running: %{id: id, monitor: Process.monitor(pid), started_at: now()}}}
  end

  defp run_pass do
    started = System.monotonic_time(:millisecond)
    {:ok, summary} = ErrorAlerts.run()
    {:ok, summary, System.monotonic_time(:millisecond) - started}
  rescue
    e -> {:error, Exception.message(e)}
  end

  defp finish_pass(%{started_at: started_at}, outcome) do
    duration = max(0, DateTime.diff(now(), started_at, :millisecond))

    case outcome do
      {:ok, summary, _duration_ms} ->
        Logger.info(
          "error alerts pass finished in #{duration}ms: result=#{summary.result} " <>
            "dms=#{summary.dms} fingerprints=#{inspect(summary.fingerprints)} " <>
            "suppressed=#{summary.suppressed} (window #{summary.window_hours}h, " <>
            "threshold #{summary.threshold}" <> if(summary.truncated, do: ", store TRUNCATED", else: "") <> ")"
        )

      {:error, reason} ->
        # The anchor did not move (run/0 only saves on success), so the next
        # tick retries — the log-and-retry posture, counted.
        Metrics.record(:failure)
        Logger.error("error alerts pass FAILED after #{duration}ms: #{inspect(reason)}")
    end

    :ok
  end
end
