defmodule Cytale.Backups.Metrics do
  @moduledoc """
  The backup outcome counters behind #120's Prometheus families.

  Three families, exactly the ones the owner named:

    * `cytale_backups_total{result="success"|"failure"}` — the run counter;
    * `cytale_backup_duration_ms` — how long the LAST run took (gauge, not a
      histogram: one backup at a time runs by construction, so "the last one"
      is the whole story);
    * `cytale_backup_last_success_timestamp_seconds` — unix time of the last
      success, `0` when none has ever succeeded. This is the number a rule
      reads to tell a quiet scheduler from a dead one (an hourly plan silent
      for 25h is dead — see the candidate rule in `docs/monitoring-rules.yml`).

  The state is a tiny public ETS table owned by `Cytale.Backups.Scheduler`
  (the same shape `Cytale.Telemetry.Stats` uses): the `/metrics` scrape never
  calls into the scheduler's mailbox, and a failed run's bookkeeping can
  never take the scrape down with it. When the table does not exist (the
  scheduler is not running — e.g. the hermetic test boot), the exposition
  renders NOTHING rather than zeros: an absent family reads as "no backup
  machinery on this node", which is the truth.
  """

  @table __MODULE__

  @type snapshot :: %{
          success: non_neg_integer(),
          failure: non_neg_integer(),
          duration_ms: non_neg_integer(),
          last_success_unix: non_neg_integer()
        }

  @doc "Create the table (idempotent — the owner calls this at init)."
  @spec init() :: :ok
  def init do
    if :ets.whereis(@table) == :undefined do
      :ets.new(@table, [:set, :named_table, :public, read_concurrency: true])
    end

    :ok
  end

  @doc "Record a finished run."
  @spec record(:success | :failure, non_neg_integer(), pos_integer() | nil) :: :ok
  def record(result, duration_ms, success_unix \\ nil) do
    # update_counter returns the NEW value (not :ok/true) — never matched.
    :ets.update_counter(@table, {:backups_total, result}, {2, 1}, {{:backups_total, result}, 0})
    :ets.insert(@table, {:last_duration_ms, duration_ms})

    if is_integer(success_unix) do
      :ets.insert(@table, {:last_success_unix, success_unix})
    end

    :ok
  end

  @doc "The current numbers (zeros before the first run)."
  @spec snapshot() :: snapshot()
  def snapshot do
    if :ets.whereis(@table) == :undefined do
      %{success: 0, failure: 0, duration_ms: 0, last_success_unix: 0}
    else
      %{
        success: counter({:backups_total, :success}),
        failure: counter({:backups_total, :failure}),
        duration_ms: counter(:last_duration_ms),
        last_success_unix: counter(:last_success_unix)
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
  The three families in Prometheus text format — appended to `/metrics`
  by `CytaleWeb.MetricsController`, byte-compatible with the existing
  exposition's shape. Empty string when the scheduler has never started.
  """
  @spec exposition() :: String.t()
  def exposition do
    if :ets.whereis(@table) == :undefined do
      ""
    else
      s = snapshot()

      "# HELP cytale_backups_total Server backup runs by result (#120).\n" <>
        "# TYPE cytale_backups_total counter\n" <>
        ~s(cytale_backups_total{result="success"} #{s.success}\n) <>
        ~s(cytale_backups_total{result="failure"} #{s.failure}\n) <>
        "# HELP cytale_backup_duration_ms Duration of the last backup run in milliseconds.\n" <>
        "# TYPE cytale_backup_duration_ms gauge\n" <>
        "cytale_backup_duration_ms #{s.duration_ms}\n" <>
        "# HELP cytale_backup_last_success_timestamp_seconds Unix time of the last successful backup; 0 = never succeeded.\n" <>
        "# TYPE cytale_backup_last_success_timestamp_seconds gauge\n" <>
        "cytale_backup_last_success_timestamp_seconds #{s.last_success_unix}\n"
    end
  end
end
