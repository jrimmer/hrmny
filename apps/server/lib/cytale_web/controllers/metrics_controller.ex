defmodule CytaleWeb.MetricsController do
  @moduledoc """
  The Prometheus scrape surface (#87).

  What this exists for, in the owner's own words: *"we ship the SIGNALS, we do
  not promise the consumer."* A scraper needs a text exposition over a surface
  it can reach; everything a member's latency depends on is ALREADY instrumented
  (~17 `:telemetry` sites feeding `Cytale.Telemetry.Stats`'s rings, plus the
  fan-out counters), and the JSON view of those rings has existed all along at
  `GET /admin/metrics` — behind `:api_auth` + `:operator`, which is a door no
  scraper can open. This is the same data in the format and behind the door a
  scraper speaks.

  Gating: `CYTALE_METRICS_TOKEN`. Set it and the surface answers only with a
  matching `Authorization: Bearer …` (constant-time compare); leave it UNSET and
  the route is a 404 — fail-closed, the same posture as `CYTALE_ADMIN_USER_IDS`.
  Telemetry names workspaces and event classes, so an unset token must not mean
  "public", it must mean "off". The doc (`docs/monitoring.md`) says so where an
  operator will read it.
  """

  use CytaleWeb, :controller

  alias Cytale.Telemetry.Stats

  @doc """
  GET /metrics — the exposition. One family per retained metric, with the ring's
  four numbers as a `stat` label rather than four invented metric names: the
  Stats keys already carry their unit (`fanout_dispatch_ms`), so the name stays
  truthful and the label says which aggregate it is.

  #120: the backup outcome families (`cytale_backups_total`,
  `cytale_backup_duration_ms`, `cytale_backup_last_success_timestamp_seconds`)
  ride the SAME surface, appended after the ring families — same text format,
  no change to any existing family. Absent (not zero) when the backup
  scheduler has never started on this node.

  7.12 rides the same append: `cytale_push_enabled` (1 = VAPID configured and
  `Delivery.Push` is the sender, 0 = notifications are logged, not sent).
  Unlike the others it is ALWAYS present, because "is push on" has a definite
  answer on every node.
  """
  def show(conn, _params) do
    case authorize(conn) do
      :ok ->
        conn
        |> put_resp_content_type("text/plain")
        |> put_resp_header("cache-control", "no-store")
        |> send_resp(200, exposition())

      :unconfigured ->
        # No token configured = the surface is OFF, not open. A 404 keeps the
        # surface invisible rather than advertising a disabled endpoint.
        send_resp(conn, 404, "")

      :unauthorized ->
        conn
        |> put_resp_header("www-authenticate", "Bearer")
        |> send_resp(401, "")
    end
  end

  # -- gating --------------------------------------------------------------------

  defp authorize(conn) do
    case Application.get_env(:cytale, :metrics_token) || System.get_env("CYTALE_METRICS_TOKEN") do
      token when is_binary(token) and byte_size(token) > 0 ->
        presented =
          case get_req_header(conn, "authorization") do
            ["Bearer " <> value] -> value
            _ -> ""
          end

        if secure_equal?(presented, token), do: :ok, else: :unauthorized

      _ ->
        :unconfigured
    end
  end

  # Constant-time compare via Plug.Crypto (the codebase's own primitive); a
  # length-leaking `==` on a shared secret is the kind of detail that is only
  # cheap until it is not.
  defp secure_equal?(a, b) when is_binary(a) and is_binary(b) do
    Plug.Crypto.secure_compare(a, b)
  end

  # -- exposition ----------------------------------------------------------------

  @doc false
  def exposition do
    base =
      Stats.snapshot()
      |> Enum.sort_by(fn {name, _} -> to_string(name) end)
      |> Enum.map_join("", &family/1)

    # #120: the backup families, same text format, alongside — never replacing.
    # #138: the client-error alerter's families ride the same append.
    # #54: the mark outcome counters, likewise.
    # 7.12: web push is OFF unless both VAPID halves are configured, and
    # until this family existed nothing said so (`Delivery.Log` sends
    # nothing). Always present: 1 = signing, 0 = logging only.
    base <>
      Cytale.Backups.Metrics.exposition() <>
      Cytale.Observability.ErrorAlerts.Metrics.exposition() <>
      Cytale.Notifications.PushMetrics.exposition() <>
      Cytale.Marks.Metrics.exposition() <>
      Cytale.Telemetry.DeliveryCounters.exposition() <>
      Cytale.MediaProxy.Metrics.exposition()
  end

  defp family({name, aggregate}) do
    metric = "cytale_#{name}"

    header =
      "# HELP #{metric} #{help(name)}\n" <>
        "# TYPE #{metric} gauge\n"

    samples =
      [
        {"samples", aggregate.count},
        {"mean", aggregate.mean_ms},
        {"p99", aggregate.p99_ms},
        {"max", aggregate.max_ms}
      ]
      |> Enum.map_join("", fn {stat, value} ->
        ~s(#{metric}{stat="#{stat}"} #{value}\n)
      end)

    header <> samples
  end

  # The one thing an operator cannot get from the metric name alone: what the
  # number is a sample OF, and over what window.
  defp help(name) do
    case to_string(name) do
      "fanout_dispatch_ms" ->
        "Time from a publish reaching the workspace process to the fan-out send, in milliseconds. Retained-window aggregate of the [:cytale, :fanout, :latency] samples."

      other ->
        "Retained-window aggregate of the #{other} samples."
    end
  end
end
