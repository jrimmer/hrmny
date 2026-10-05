defmodule Cytale.Telemetry.DeliveryCounters do
  @moduledoc """
  Counters for the delivery paths' SILENT failure modes (review #22/#24) —
  the ones that used to leave no trace but a log line:

    * `offline_append_dropped` — a session-store shard was down when the
      fan-out tried to buffer an event for a disconnected session
      (`Cytale.Gateway.SessionStore.append_offline/4`); counts sessions.
    * `publish_failed` — a message was STORED but its publish raised; the
      send still answered 201 (`CytaleWeb.MessageController`).
    * `nonce_claim_failed` — the durable send-dedupe reservation could not be
      written, so the send went ahead without it.

  One family, `cytale_delivery_events_total{event}`, every event always
  present (zeros included) so a dashboard can alert on a rate without first
  seeing a non-zero. The table is owned by `Cytale.Telemetry.Stats` (the
  `Cytale.Marks.Metrics` shape): the scrape never calls a process.
  """

  @table __MODULE__

  @events [
    {[:cytale, :gateway, :offline_append_dropped], "offline_append_dropped"},
    {[:cytale, :message, :publish_failed], "publish_failed"},
    {[:cytale, :message, :nonce_claim_failed], "nonce_claim_failed"}
  ]

  @doc "Create the table and attach the handlers (idempotent)."
  @spec init() :: :ok
  def init do
    if :ets.whereis(@table) == :undefined do
      :ets.new(@table, [:set, :named_table, :public, write_concurrency: true])
    end

    :telemetry.detach({__MODULE__, :events})

    :telemetry.attach_many(
      {__MODULE__, :events},
      Enum.map(@events, &elem(&1, 0)),
      &__MODULE__.handle_event/4,
      Map.new(@events)
    )

    :ok
  end

  @doc false
  def handle_event(event, measurements, _meta, labels) do
    if :ets.whereis(@table) != :undefined do
      label = Map.fetch!(labels, event)
      :ets.update_counter(@table, label, {2, Map.get(measurements, :count, 1)}, {label, 0})
    end

    :ok
  end

  @doc "`%{label => count}` for every event, zeros included."
  @spec snapshot() :: %{String.t() => non_neg_integer()}
  def snapshot do
    stored =
      if :ets.whereis(@table) == :undefined, do: %{}, else: Map.new(:ets.tab2list(@table))

    Map.new(@events, fn {_event, label} -> {label, Map.get(stored, label, 0)} end)
  end

  @doc "The Prometheus text family (empty when the table is absent)."
  @spec exposition() :: String.t()
  def exposition do
    if :ets.whereis(@table) == :undefined do
      ""
    else
      "# HELP cytale_delivery_events_total Delivery-path failures that do not fail the request (dropped offline appends, post-write publish failures, nonce-claim failures).\n" <>
        "# TYPE cytale_delivery_events_total counter\n" <>
        (snapshot()
         |> Enum.sort()
         |> Enum.map_join("", fn {label, n} -> ~s(cytale_delivery_events_total{event="#{label}"} #{n}\n) end))
    end
  end
end
