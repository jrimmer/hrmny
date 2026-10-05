defmodule Cytale.Observability.ErrorAlerts.Ledger do
  @moduledoc """
  The alerter's memory (#138): which fingerprint was alerted in which window
  bucket, persisted to disk so a restart cannot cause a re-alert storm.

  ## Why a FILE, and why keyed on fingerprints

  The ticket's resolved design names both halves. An IN-MEMORY ledger re-alerts
  every currently-repeating fingerprint on every deploy — an alert storm
  triggered by the act of deploying. And the dedupe must key on the
  FINGERPRINT SET, never on a coarse "last action": a coarse state is the
  shape that made the SABnzbd monitor flap. One entry per fingerprint, holding
  the bucket it was last alerted in.

  ## Window bucketing

  `bucket/2` floors unix time by the configured window length
  (`observability.error_alert_window_hours`): a steady error can therefore
  nag at most once per window, because every pass inside one window computes
  the same bucket for the same fingerprint and the ledger refuses a second
  alert with an unchanged bucket.

  The gap between the current bucket and the stored one is also the regression
  signal:

    * `0` — already alerted this window: silence (the whole point);
    * `1` — alerted last window and repeating again: "still broken";
    * `>= 2` — at least one FULL window passed without this fingerprint
      alerting and it is back: "broke again" — the distinct wording the
      ticket asks for, because a return after quiet is exactly the signal
      #137 waits for.

  ## Shape and location

  One JSON file — `{"version": 1, "last_run_at": iso, "alerts": {fp => …}}`.
  `last_run_at` doubles as the scheduler's due anchor (a failed pass never
  updates it, so the next tick retries). The file lives beside the server
  config on the same durable volume (the restore-marker convention),
  overridable with the `:error_alerts_ledger_path` app env for tests. Entries
  older than `@keep_buckets` are pruned on save, so the file stays small
  without ever discarding the just-quieted history the regression wording
  reads.
  """

  require Logger

  alias Cytale.ServerConfig

  @version 1
  @mode 0o600
  @keep_buckets 30
  @filename ".error-alerts-ledger.json"

  @typedoc "One fingerprint's last alert."
  @type entry :: %{
          bucket: integer(),
          alerted_at: DateTime.t(),
          count: non_neg_integer(),
          kind: :new | :still_broken | :returned
        }

  @typedoc "The whole ledger, as the callers see it."
  @type t :: %{last_run_at: DateTime.t() | nil, alerts: %{String.t() => entry()}}

  # -- The bucket ---------------------------------------------------------------

  @doc """
  The window bucket for a moment: floor(unix_ms / window_ms). The same
  floor-to-a-grid move `Cytale.Observability.ClientErrors.day_of/1` uses for
  day partitions, at the configured window's granularity.
  """
  @spec bucket(DateTime.t(), pos_integer()) :: integer()
  def bucket(%DateTime{} = at, window_hours) when is_integer(window_hours) and window_hours >= 1 do
    div(DateTime.to_unix(at, :millisecond), window_hours * 3_600_000)
  end

  # -- Load / save ----------------------------------------------------------------

  @doc "The ledger file's path (beside the config file; app-env overridable)."
  @spec path() :: String.t()
  def path do
    Application.get_env(:cytale, :error_alerts_ledger_path) ||
      Path.join(Path.dirname(ServerConfig.config_path()), @filename)
  end

  @doc """
  Read the ledger back. ANY failure — absent file, bad JSON, wrong shape — is
  a FRESH ledger with a loud log, never a crash: losing the memory may cost
  one extra alert, and that is the correct failure direction.
  """
  @spec load() :: t()
  def load do
    case File.read(path()) do
      {:ok, raw} ->
        case decode(raw) do
          {:ok, ledger} -> ledger
          :error -> fresh_with_log("unreadable content")
        end

      {:error, _reason} ->
        %{last_run_at: nil, alerts: %{}}
    end
  end

  defp fresh_with_log(why) do
    Logger.warning("error alerts: ledger at #{path()} #{why} — starting fresh (may alert once extra)")
    %{last_run_at: nil, alerts: %{}}
  end

  defp decode(raw) do
    with {:ok, %{"version" => @version, "alerts" => alerts} = doc} when is_map(alerts) <-
           Jason.decode(raw),
         {:ok, last_run_at} <- parse_ts(doc["last_run_at"]),
         {:ok, entries} <- decode_entries(alerts) do
      {:ok, %{last_run_at: last_run_at, alerts: entries}}
    else
      _ -> :error
    end
  end

  defp decode_entries(alerts) do
    Enum.reduce_while(alerts, {:ok, %{}}, fn {fp, entry}, {:ok, acc} ->
      case decode_entry(entry) do
        {:ok, parsed} -> {:cont, {:ok, Map.put(acc, fp, parsed)}}
        :error -> {:halt, :error}
      end
    end)
  end

  defp decode_entry(%{"bucket" => bucket, "alerted_at" => iso, "count" => count, "kind" => kind})
       when is_integer(bucket) and is_integer(count) and kind in ["new", "still_broken", "returned"] do
    with {:ok, alerted_at} <- parse_ts(iso) do
      {:ok, %{bucket: bucket, alerted_at: alerted_at, count: count, kind: String.to_existing_atom(kind)}}
    end
  end

  defp decode_entry(_other), do: :error

  defp parse_ts(nil), do: {:ok, nil}

  defp parse_ts(iso) when is_binary(iso) do
    case DateTime.from_iso8601(iso) do
      {:ok, dt, _offset} -> {:ok, dt}
      _ -> :error
    end
  end

  defp parse_ts(_other), do: :error

  @doc """
  Persist the ledger (0600, atomic through `Cytale.ServerConfig.write_atomic/3`)
  and prune entries older than `@keep_buckets` — old enough to keep the
  quiet-window history a regression wording needs, small enough to stay a
  one-page file forever. A failed write is logged, not raised: the alerts of
  this pass already went out, and the cost of losing the file is bounded by
  the load path's fresh-start behavior.
  """
  @spec save(t(), integer()) :: :ok
  def save(%{last_run_at: last_run_at, alerts: alerts}, current_bucket) do
    keep_from = current_bucket - @keep_buckets

    survivors =
      alerts
      |> Enum.filter(fn {_fp, entry} -> entry.bucket >= keep_from end)
      |> Map.new(fn {fp, entry} ->
        {fp,
         %{
           "bucket" => entry.bucket,
           "alerted_at" => DateTime.to_iso8601(entry.alerted_at),
           "count" => entry.count,
           "kind" => Atom.to_string(entry.kind)
         }}
      end)

    doc = %{
      "version" => @version,
      "last_run_at" => last_run_at && DateTime.to_iso8601(last_run_at),
      "alerts" => survivors
    }

    case ServerConfig.write_atomic(path(), Jason.encode!(doc, pretty: true), @mode) do
      :ok ->
        :ok

      {:error, reason} ->
        Logger.error("error alerts: could not write ledger #{path()} (#{inspect(reason)})")
        :ok
    end
  end

  # -- The decision ---------------------------------------------------------------

  @doc """
  Whether this fingerprint may alert now, and with which wording:

    * `:already_alerted` — its stored bucket IS the current one: silence;
    * `{:alert, :new}` — no history: first alert for this fingerprint;
    * `{:alert, :still_broken}` — alerted in the immediately previous bucket:
      the steady error's once-per-window nag;
    * `{:alert, :returned}` — at least one full window passed without it:
      a regression, worded apart.
  """
  @spec decide(t() | %{alerts: %{String.t() => entry()}}, String.t(), integer()) ::
          :already_alerted | {:alert, :new | :still_broken | :returned}
  def decide(ledger, fingerprint, current_bucket) do
    case ledger.alerts[fingerprint] do
      nil ->
        {:alert, :new}

      %{bucket: ^current_bucket} ->
        :already_alerted

      %{bucket: last} when current_bucket - last == 1 ->
        {:alert, :still_broken}

      %{bucket: last} when current_bucket - last >= 2 ->
        {:alert, :returned}
    end
  end
end
