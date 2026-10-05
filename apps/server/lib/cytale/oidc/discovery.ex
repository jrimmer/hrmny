defmodule Cytale.OIDC.Discovery do
  @moduledoc """
  The provider's discovery document + JWKS cache (ticket #12).

  The issuer URL is the ONLY thing an operator configures; everything else
  about the provider (authorization_endpoint, token_endpoint, jwks_uri, the
  signing keys themselves) is read from `{issuer}/.well-known/openid-configuration`
  per the OIDC Discovery spec. Both documents are cached in ETS per issuer
  with a TTL — discovery for an hour, JWKS for ten minutes — so a ceremony
  costs zero provider round trips in the common case and the provider sees
  only occasional reads. Because the cache is keyed per ISSUER and every read
  re-resolves through `Cytale.Config.oidc_issuer_url/0`, a hot-applied
  `oidc.issuer_url` edit takes effect on the next ceremony with nothing to
  restart (the runtime-scope decision for the whole oidc config block).

  JWKS rotation: the ID-token validator asks for `jwks/2` with
  `force: true` when a token's `kid` misses the cached set — one refetch per
  miss, which is exactly the provider-rotated-its-keys case — and the cache
  write is atomic overwrite (a concurrent ceremony sees old or new, never
  torn).

  HTTP is Finch (`Cytale.OIDC.Finch`, application-tree pool). Failures are
  error tuples; the caller renders the provider-unavailable state and nothing
  here raises on the request path.
  """

  use GenServer

  require Logger

  @table __MODULE__
  @discover_timeout_ms 10_000
  @discovery_ttl_ms :timer.hours(1)
  @jwks_ttl_ms :timer.minutes(10)

  # -- Client API ----------------------------------------------------------------

  @doc "Starts the ETS owner + is an application tree child."
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(_opts \\ []) do
    GenServer.start_link(__MODULE__, :ok, name: __MODULE__)
  end

  @doc """
  The provider's discovery document for `issuer` (`{:ok, map}` | `{:error,
  :provider_unavailable}`). Cached per issuer with a TTL.
  """
  @spec provider_config(String.t()) :: {:ok, map()} | {:error, :provider_unavailable}
  def provider_config(issuer) when is_binary(issuer) do
    cached({issuer, :config}, @discovery_ttl_ms) ||
      fetch_and_cache({issuer, :config}, discovery_url(issuer), @discovery_ttl_ms)
  end

  @doc """
  The provider's JWKS document (resolved through the cached discovery's
  `jwks_uri`). `force: true` skips the cache read — the kid-miss rotation
  path — and overwrites whatever was cached.
  """
  @spec jwks(String.t(), keyword()) :: {:ok, map()} | {:error, :provider_unavailable}
  def jwks(issuer, opts \\ []) when is_binary(issuer) do
    force? = Keyword.get(opts, :force, false)

    with {:ok, config} <- provider_config(issuer),
         %{"jwks_uri" => jwks_uri} when is_binary(jwks_uri) <- config do
      if force? do
        fetch_and_cache({issuer, :jwks}, jwks_uri, @jwks_ttl_ms)
      else
        cached({issuer, :jwks}, @jwks_ttl_ms) ||
          fetch_and_cache({issuer, :jwks}, jwks_uri, @jwks_ttl_ms)
      end
    else
      {:error, _} = err -> err
      _ -> {:error, :provider_unavailable}
    end
  end

  @doc "Drop every cached document (tests + an operator's emergency reset)."
  @spec clear() :: :ok
  def clear do
    if Process.whereis(@table), do: true = :ets.delete_all_objects(@table)
    :ok
  end

  # -- Internals -------------------------------------------------------------------

  defp table, do: @table

  defp cached(key, ttl_ms) do
    case :ets.lookup(table(), key) do
      [{^key, value, cached_at_ms}] ->
        if System.system_time(:millisecond) - cached_at_ms <= ttl_ms,
          do: {:ok, value},
          else: nil

      [] ->
        nil
    end
  end

  # A single-flight guard: concurrent misses for one key collapse onto ONE
  # fetch (the rest block on the same call, then read the fresh row). The
  # GenServer processes fetch calls serially; a poisoned fetch is simply
  # retried by the next ceremony.
  defp fetch_and_cache(key, url, ttl_ms) do
    GenServer.call(@table, {:fetch, key, url, ttl_ms}, @discover_timeout_ms * 2)
  end

  defp get_json(url) do
    request = Finch.build(:get, url, [{"accept", "application/json"}])

    case Finch.request(request, Cytale.OIDC.Finch, receive_timeout: @discover_timeout_ms) do
      {:ok, %Finch.Response{status: 200, body: body}} ->
        Jason.decode(body)

      {:ok, %Finch.Response{status: status}} ->
        {:error, {:http_status, status}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp discovery_url(issuer), do: String.trim_trailing(issuer, "/") <> "/.well-known/openid-configuration"

  # -- GenServer -------------------------------------------------------------------

  @impl true
  def init(:ok) do
    table = :ets.new(@table, [:set, :public, :named_table, read_concurrency: true])
    {:ok, table}
  end

  @impl true
  def handle_call({:fetch, key, url, ttl_ms}, _from, table) do
    # Re-check under the serialization point: two waiting callers for the same
    # key must not each pay (and race) a fetch — the first one's write wins
    # and the second re-reads it.
    case cached(key, ttl_ms) do
      {:ok, _} = fresh ->
        {:reply, fresh, table}

      nil ->
        case get_json(url) do
          {:ok, doc} when is_map(doc) ->
            now = System.system_time(:millisecond)
            true = :ets.insert(table(), {key, doc, now})
            {:reply, {:ok, doc}, table}

          {:error, reason} ->
            Logger.warning("oidc discovery: fetch failed for #{sanitize_url(url)}: #{inspect(reason)}")

            {:reply, {:error, :provider_unavailable}, table}
        end
    end
  end

  # The URL can carry a path with identifying scope names (realms) — that part
  # is fine to log; a query string on a discovery URL would be unusual, and
  # errors never echo response bodies or the secret anywhere.
  defp sanitize_url(url), do: url |> String.split("?") |> hd()
end
