defmodule Cytale.MediaProxy.Cache do
  @moduledoc """
  The media proxy's disk cache: fetched images keyed by the SHA-256 of their
  source URL, under `Cytale.Config.media_proxy_cache_dir/0`.

      <dir>/<k0k1>/<key>        the image bytes, as fetched
      <dir>/<k0k1>/<key>.meta   `{"content_type", "fetched_at", "size"}`

  * **Freshness.** An entry older than `cache_ttl_seconds` is a miss: the next
    view refetches it. Until then the bytes are frozen as first fetched, so an
    origin cannot swap an image after it was posted and viewed.
  * **Size.** The running total lives in this process; a write that takes it
    past `cache_max_bytes` evicts least-recently-USED entries (a hit bumps the
    file's mtime) down to 90% of the cap. An hourly sweep also drops expired
    entries and re-derives the total from disk.
  * **Failures** are remembered in ETS for `negative_ttl_seconds`, so a dead or
    hostile origin is asked once per window, not once per viewer.
  * **Writes are atomic** (temp + rename), and only the SNIFFED content type is
    ever stored: the cache holds nothing the origin's headers chose.

  The cache is keyed by the URL alone, never by who asked: every signed URL for
  one source serves the same frozen bytes, and nothing a requester sends
  (headers, cookies, query noise) can reach the key — the cache-poisoning
  surface is the origin's own response to our fixed request, which is exactly
  the image the message referenced.
  """

  use GenServer

  require Logger

  @negative __MODULE__.Negative
  @sweep_interval_ms 60 * 60 * 1000
  @temp_infix ".tmp-"

  # -- public API -----------------------------------------------------------------

  @doc false
  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @doc "The cache key for a source URL."
  @spec key(String.t()) :: String.t()
  def key(url), do: :crypto.hash(:sha256, url) |> Base.encode16(case: :lower)

  @doc """
  `{:hit, path, content_type, size}` for a fresh entry (and bumps its
  recency), `{:negative, reason}` for a remembered failure, `:miss` otherwise.
  """
  @spec lookup(String.t()) :: {:hit, String.t(), String.t(), non_neg_integer()} | {:negative, term()} | :miss
  def lookup(key) do
    case negative(key) do
      {:ok, reason} -> {:negative, reason}
      :none -> disk_lookup(key)
    end
  end

  @doc "Store fetched bytes (already sniffed) under `key`."
  @spec put(String.t(), binary(), String.t()) :: :ok
  def put(key, body, content_type) do
    path = data_path(key)
    File.mkdir_p!(Path.dirname(path))
    previous = existing_size(path)

    meta =
      Jason.encode!(%{
        "content_type" => content_type,
        "fetched_at" => System.system_time(:second),
        "size" => byte_size(body)
      })

    write_atomic!(path, body)
    write_atomic!(path <> ".meta", meta)
    clear_negative(key)
    notify({:added, byte_size(body) - previous})
    :ok
  rescue
    error ->
      # A full or read-only volume must not fail the request that already
      # holds the bytes: it serves them and simply does not cache.
      Logger.warning("media proxy: cache write failed: #{Exception.message(error)}")
      :ok
  end

  @doc "Remember a failed fetch for `negative_ttl_seconds`."
  @spec put_negative(String.t(), term()) :: :ok
  def put_negative(key, reason) do
    if :ets.whereis(@negative) != :undefined do
      until = System.monotonic_time(:second) + Cytale.Config.media_proxy_negative_ttl_seconds()
      :ets.insert(@negative, {key, reason, until})
    end

    :ok
  end

  @doc "Bytes currently held on disk (this node's running total)."
  @spec total_bytes() :: non_neg_integer()
  def total_bytes do
    case :persistent_term.get({__MODULE__, :bytes}, nil) do
      nil -> 0
      ref -> :atomics.get(ref, 1)
    end
  end

  @doc "Drop every entry and every remembered failure (tests, operators)."
  @spec clear() :: :ok
  def clear do
    if :ets.whereis(@negative) != :undefined, do: :ets.delete_all_objects(@negative)
    File.rm_rf(Cytale.Config.media_proxy_cache_dir())
    set_total(0)
    :ok
  end

  @doc "Run the expiry + size sweep now (synchronous; returns the new total)."
  @spec sweep() :: non_neg_integer()
  def sweep do
    if Process.whereis(__MODULE__), do: GenServer.call(__MODULE__, :sweep, 60_000), else: do_sweep()
  end

  # -- GenServer ------------------------------------------------------------------

  @impl true
  def init(_opts) do
    if :ets.whereis(@negative) == :undefined do
      :ets.new(@negative, [:set, :named_table, :public, read_concurrency: true, write_concurrency: true])
    end

    counter()
    {:ok, %{}, {:continue, :sweep}}
  end

  @impl true
  def handle_continue(:sweep, state) do
    do_sweep()
    Process.send_after(self(), :sweep, @sweep_interval_ms)
    {:noreply, state}
  end

  @impl true
  def handle_info(:sweep, state) do
    do_sweep()
    Process.send_after(self(), :sweep, @sweep_interval_ms)
    {:noreply, state}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  @impl true
  def handle_cast({:added, _delta}, state) do
    if total_bytes() > Cytale.Config.media_proxy_cache_max_bytes(), do: evict()
    {:noreply, state}
  end

  @impl true
  def handle_call(:sweep, _from, state), do: {:reply, do_sweep(), state}

  # -- internals --------------------------------------------------------------------

  defp notify({:added, delta}) do
    adjust(delta)
    if Process.whereis(__MODULE__), do: GenServer.cast(__MODULE__, {:added, delta})
  end

  defp negative(key) do
    if :ets.whereis(@negative) == :undefined do
      :none
    else
      now = System.monotonic_time(:second)

      case :ets.lookup(@negative, key) do
        [{^key, reason, until}] when until > now -> {:ok, reason}
        [{^key, _reason, _until}] -> clear_negative(key) && :none
        [] -> :none
      end
    end
  end

  defp clear_negative(key) do
    if :ets.whereis(@negative) != :undefined, do: :ets.delete(@negative, key)
    true
  end

  defp disk_lookup(key) do
    path = data_path(key)

    with {:ok, raw} <- File.read(path <> ".meta"),
         {:ok, %{"content_type" => ct, "fetched_at" => at, "size" => size}} <- Jason.decode(raw),
         true <- fresh?(at),
         {:ok, %File.Stat{size: ^size}} <- File.stat(path) do
      # Recency for the LRU: a hit bumps mtime (one syscall per hit).
      File.touch(path)
      {:hit, path, ct, size}
    else
      _ -> :miss
    end
  end

  defp fresh?(fetched_at) when is_integer(fetched_at),
    do: fetched_at + Cytale.Config.media_proxy_cache_ttl_seconds() > System.system_time(:second)

  defp fresh?(_), do: false

  defp data_path(key), do: Path.join([Cytale.Config.media_proxy_cache_dir(), binary_part(key, 0, 2), key])

  # Every entry on disk: `{path, size, mtime_posix, meta_or_nil}`.
  defp entries do
    root = Cytale.Config.media_proxy_cache_dir()

    case File.ls(root) do
      {:ok, shards} ->
        for shard <- shards,
            dir = Path.join(root, shard),
            File.dir?(dir),
            {:ok, names} <- [File.ls(dir)],
            name <- names,
            not String.ends_with?(name, ".meta"),
            not String.contains?(name, @temp_infix),
            path = Path.join(dir, name),
            {:ok, %File.Stat{size: size, mtime: mtime}} <- [File.stat(path, time: :posix)] do
          {path, size, mtime, read_meta(path)}
        end

      {:error, _} ->
        []
    end
  end

  defp read_meta(path) do
    with {:ok, raw} <- File.read(path <> ".meta"),
         {:ok, %{} = meta} <- Jason.decode(raw) do
      meta
    else
      _ -> nil
    end
  end

  # Expired (or meta-less) entries go; then the size cap is enforced and the total re-derived from what is left.
  defp do_sweep do
    {keep, drop} =
      Enum.split_with(entries(), fn {_path, _size, _mtime, meta} ->
        is_map(meta) and fresh?(meta["fetched_at"])
      end)

    Enum.each(drop, fn {path, _, _, _} -> remove(path) end)
    set_total(Enum.reduce(keep, 0, fn {_, size, _, _}, acc -> acc + size end))
    if total_bytes() > Cytale.Config.media_proxy_cache_max_bytes(), do: evict()
    total_bytes()
  rescue
    error ->
      Logger.warning("media proxy: cache sweep failed: #{Exception.message(error)}")
      total_bytes()
  end

  # Least recently used first, down to 90% of the cap (hysteresis, so one
  # write past the line does not trigger an eviction scan per write).
  defp evict do
    target = trunc(Cytale.Config.media_proxy_cache_max_bytes() * 0.9)
    all = entries()
    total = Enum.reduce(all, 0, fn {_, size, _, _}, acc -> acc + size end)

    remaining =
      all
      |> Enum.sort_by(fn {_path, _size, mtime, _meta} -> mtime end)
      |> Enum.reduce_while(total, fn {path, size, _, _}, acc ->
        if acc <= target do
          {:halt, acc}
        else
          remove(path)
          {:cont, acc - size}
        end
      end)

    set_total(remaining)
  end

  defp remove(path) do
    File.rm(path)
    File.rm(path <> ".meta")
  end

  defp existing_size(path) do
    case File.stat(path) do
      {:ok, %{size: size}} -> size
      _ -> 0
    end
  end

  defp write_atomic!(target, bytes) do
    temp = target <> @temp_infix <> Integer.to_string(System.unique_integer([:positive, :monotonic]))

    try do
      File.write!(temp, bytes, [:binary])
      File.rename!(temp, target)
    after
      File.rm(temp)
    end
  end

  defp counter do
    case :persistent_term.get({__MODULE__, :bytes}, nil) do
      nil ->
        ref = :atomics.new(1, signed: true)
        :persistent_term.put({__MODULE__, :bytes}, ref)
        ref

      ref ->
        ref
    end
  end

  defp adjust(delta), do: :atomics.add(counter(), 1, delta)
  defp set_total(n), do: :atomics.put(counter(), 1, max(n, 0))
end
