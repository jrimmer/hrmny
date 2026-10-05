defmodule Cytale.Observability.ErrorAlerts.Metrics do
  @moduledoc """
  The alerter's outcome counters (#138) — "the alerter must not fail silently"
  made scrapeable.

  Three families, the backups-scheduler shape:

    * `cytale_error_alerts_total{result="alert"|"quiet"|"no_admin"|"failure"}` —
      the pass counter. `alert` delivered at least one DM, `quiet` had nothing
      past threshold, `no_admin` had something to say and nobody configured to
      say it to (the ticket's silence-not-error case, but COUNTED — an
      unconfigured admin address is exactly the kind of quiet failure this
      feature exists to prevent), `failure` is a crashed pass;
    * `cytale_error_alerts_dm_total` — DMs actually handed to the delivery
      seam (before policy may withhold any);
    * `cytale_error_alerts_last_run_timestamp_seconds` — unix time of the last
      COMPLETED pass; `0` when none ever completed. This is the number a rule
      reads to tell a quiet alerter from a dead one (a failed pass does not
      touch it, so an alerter crashing since Tuesday is visible from orbit).

  The state is a tiny public ETS table owned by the scheduler (the same shape
  `Cytale.Backups.Metrics` and `Cytale.Telemetry.Stats` use): the `/metrics`
  scrape never calls into the scheduler's mailbox. When the table does not
  exist (the scheduler is not running), the exposition renders NOTHING rather
  than zeros — an absent family reads as "no alerting on this node", which is
  the truth.
  """

  @table __MODULE__

  @type snapshot :: %{
          alert: non_neg_integer(),
          quiet: non_neg_integer(),
          no_admin: non_neg_integer(),
          failure: non_neg_integer(),
          dms: non_neg_integer(),
          last_run_unix: non_neg_integer()
        }

  @doc "Create the table (idempotent — the owner calls this at init)."
  @spec init() :: :ok
  def init do
    if :ets.whereis(@table) == :undefined do
      :ets.new(@table, [:set, :named_table, :public, read_concurrency: true])
    end

    :ok
  end

  @doc "Record one finished pass. `result` is :alert | :quiet | :no_admin | :failure."
  @spec record(:alert | :quiet | :no_admin | :failure, non_neg_integer()) :: :ok
  def record(result, dms \\ 0) do
    :ets.update_counter(@table, {:total, result}, {2, 1}, {{:total, result}, 0})
    :ets.update_counter(@table, :dm_total, {2, dms}, {:dm_total, 0})

    # A FAILED pass does not move the last-run anchor: a stale timestamp is
    # how a dead alerter admits it (the backups last-success semantics).
    unless result == :failure do
      :ets.insert(@table, {:last_run_unix, DateTime.to_unix(DateTime.utc_now(), :second)})
    end

    :ok
  end

  @doc "The current numbers (zeros before the first pass)."
  @spec snapshot() :: snapshot()
  def snapshot do
    if :ets.whereis(@table) == :undefined do
      %{alert: 0, quiet: 0, no_admin: 0, failure: 0, dms: 0, last_run_unix: 0}
    else
      %{
        alert: counter({:total, :alert}),
        quiet: counter({:total, :quiet}),
        no_admin: counter({:total, :no_admin}),
        failure: counter({:total, :failure}),
        dms: counter(:dm_total),
        last_run_unix: counter(:last_run_unix)
      }
    end
  end

  defp counter(key) do
    case :ets.lookup(@table, key) do
      [{^key, n}] when is_integer(n) -> n
      _ -> 0
    end
  end

  @doc """
  The families in Prometheus text format — appended to `/metrics` by
  `CytaleWeb.MetricsController`. Empty string when the alerter never started.
  """
  @spec exposition() :: String.t()
  def exposition do
    if :ets.whereis(@table) == :undefined do
      ""
    else
      s = snapshot()

      "# HELP cytale_error_alerts_total Client-error alert passes by result (#138).\n" <>
        "# TYPE cytale_error_alerts_total counter\n" <>
        ~s(cytale_error_alerts_total{result="alert"} #{s.alert}\n) <>
        ~s(cytale_error_alerts_total{result="quiet"} #{s.quiet}\n) <>
        ~s(cytale_error_alerts_total{result="no_admin"} #{s.no_admin}\n) <>
        ~s(cytale_error_alerts_total{result="failure"} #{s.failure}\n) <>
        "# HELP cytale_error_alerts_dm_total Admin DMs handed to the delivery seam.\n" <>
        "# TYPE cytale_error_alerts_dm_total counter\n" <>
        "cytale_error_alerts_dm_total #{s.dms}\n" <>
        "# HELP cytale_error_alerts_last_run_timestamp_seconds Unix time of the last completed alert pass; 0 = never completed.\n" <>
        "# TYPE cytale_error_alerts_last_run_timestamp_seconds gauge\n" <>
        "cytale_error_alerts_last_run_timestamp_seconds #{s.last_run_unix}\n"
    end
  end
end
