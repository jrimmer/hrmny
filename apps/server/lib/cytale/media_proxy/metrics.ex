defmodule Cytale.MediaProxy.Metrics do
  @moduledoc """
  The media proxy's counters on `/metrics` (the `Cytale.Telemetry.
  DeliveryCounters` shape: one ETS table created by `Cytale.Telemetry.Stats`,
  bumped in place, every label always present — zeros included — so a
  dashboard can alert on a rate before it first sees a non-zero):

    * `cytale_media_proxy_requests_total{result}` — how each signed request
      was answered: `hit` (disk cache), `miss` (fetched now), `negative`
      (a remembered failure), `refused` (bad/expired signature, disabled).
    * `cytale_media_proxy_fetches_total{outcome}` — outbound fetches by
      outcome: `ok`, `blocked` (SSRF guard: private address, scheme, port),
      `unsupported_type`, `too_large`, `too_many_pixels`, `upstream_error`
      (non-2xx, redirect loop, connect/TLS failure), `timeout`.
    * `cytale_media_proxy_bytes_total{direction}` — `fetched` from origins and
      `served` to viewers.
    * `cytale_media_proxy_cache_bytes` — bytes the disk cache holds now.
  """

  @table __MODULE__

  @results ~w(hit miss negative refused)
  @outcomes ~w(ok blocked unsupported_type too_large too_many_pixels upstream_error timeout)
  @directions ~w(fetched served)

  @doc "Create the table (idempotent)."
  @spec init() :: :ok
  def init do
    if :ets.whereis(@table) == :undefined do
      :ets.new(@table, [:set, :named_table, :public, write_concurrency: true])
    end

    :ok
  end

  @doc "Count one request answered as `result`."
  @spec request(String.t()) :: :ok
  def request(result) when result in @results, do: bump({:request, result}, 1)

  @doc "Count one outbound fetch that ended as `outcome`."
  @spec fetch(String.t()) :: :ok
  def fetch(outcome) when outcome in @outcomes, do: bump({:fetch, outcome}, 1)

  @doc "Add `n` bytes in `direction` (`fetched` / `served`)."
  @spec bytes(String.t(), non_neg_integer()) :: :ok
  def bytes(direction, n) when direction in @directions and is_integer(n) and n >= 0,
    do: bump({:bytes, direction}, n)

  @doc "`%{{family, label} => count}`, zeros included."
  @spec snapshot() :: map()
  def snapshot do
    stored = if :ets.whereis(@table) == :undefined, do: %{}, else: Map.new(:ets.tab2list(@table))

    for {family, labels} <- [request: @results, fetch: @outcomes, bytes: @directions],
        label <- labels,
        into: %{} do
      {{family, label}, Map.get(stored, {family, label}, 0)}
    end
  end

  @doc "The Prometheus text families (empty when the table is absent)."
  @spec exposition() :: String.t()
  def exposition do
    if :ets.whereis(@table) == :undefined do
      ""
    else
      snap = snapshot()

      family(
        "cytale_media_proxy_requests_total",
        "Media proxy requests by how they were answered (hit, miss, negative, refused).",
        "result",
        @results,
        snap,
        :request
      ) <>
        family(
          "cytale_media_proxy_fetches_total",
          "Media proxy outbound fetches by outcome (ok, or why the image was refused).",
          "outcome",
          @outcomes,
          snap,
          :fetch
        ) <>
        family(
          "cytale_media_proxy_bytes_total",
          "Media proxy bytes fetched from origins and served to viewers.",
          "direction",
          @directions,
          snap,
          :bytes
        ) <>
        "# HELP cytale_media_proxy_cache_bytes Bytes held by the media proxy's disk cache on this node.\n" <>
        "# TYPE cytale_media_proxy_cache_bytes gauge\n" <>
        "cytale_media_proxy_cache_bytes #{Cytale.MediaProxy.Cache.total_bytes()}\n"
    end
  end

  defp family(metric, help, label_name, labels, snap, key) do
    "# HELP #{metric} #{help}\n# TYPE #{metric} counter\n" <>
      Enum.map_join(labels, "", fn label ->
        ~s(#{metric}{#{label_name}="#{label}"} #{Map.fetch!(snap, {key, label})}\n)
      end)
  end

  defp bump(key, n) do
    if :ets.whereis(@table) != :undefined, do: :ets.update_counter(@table, key, {2, n}, {key, 0})
    :ok
  end
end
