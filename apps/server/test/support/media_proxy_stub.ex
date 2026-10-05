defmodule Cytale.MediaProxyStub do
  @moduledoc """
  A local HTTP origin for the media proxy suite — no test ever reaches the
  internet. `start!/0` boots a Bandit listener on 127.0.0.1 (an ephemeral
  port) serving whatever `route/2` registered, counting every request per
  path, and installs the proxy's test seams so a hostname can point at it:

    * `:media_proxy_resolver` — `img.test` resolves to the stub; `private.test`
      to 10.0.0.5; `mixed.test` to a public AND a private address; anything
      else is unresolvable;
    * `:media_proxy_address_allowed?` — 127.0.0.1 is admitted (it is the
      stub), every other address is judged by the REAL guard, so a redirect to
      10/8, 169.254/16 or `[::ffff:127.0.0.2]` is refused exactly as in
      production;
    * `:media_proxy` — the stub's port joins the allowed ports; a per-test
      cache dir; any extra `opts`.

  Everything is restored by the `on_exit` it registers.
  """

  import ExUnit.Callbacks, only: [on_exit: 1]

  @table __MODULE__

  @doc "The default (hermetic) resolver of the suite: nothing resolves."
  def no_dns(_host), do: {:error, :nxdomain}

  @doc "Boot the stub and install the seams. Returns `%{port, base}` (`http://img.test:<port>`)."
  def start!(media_opts \\ []) do
    if :ets.whereis(@table) == :undefined do
      :ets.new(@table, [:set, :public, :named_table])
    else
      :ets.delete_all_objects(@table)
    end

    {:ok, sup} =
      Bandit.start_link(plug: __MODULE__.Plug, scheme: :http, ip: {127, 0, 0, 1}, port: 0, startup_log: false)

    {:ok, {_ip, port}} = ThousandIsland.listener_info(sup)

    cache_dir = Path.join(System.tmp_dir!(), "media-proxy-test-#{System.unique_integer([:positive])}")

    saved =
      for key <- [:media_proxy, :media_proxy_resolver, :media_proxy_address_allowed?],
          do: {key, Application.fetch_env(:cytale, key)}

    Application.put_env(
      :cytale,
      :media_proxy,
      Keyword.merge([allowed_ports: [80, 443, 8080, 8443, port], cache_dir: cache_dir], media_opts)
    )

    Application.put_env(:cytale, :media_proxy_resolver, fn
      "img.test" -> {:ok, [{127, 0, 0, 1}]}
      "private.test" -> {:ok, [{10, 0, 0, 5}]}
      "mixed.test" -> {:ok, [{93, 184, 216, 34}, {192, 168, 1, 9}]}
      _ -> {:error, :nxdomain}
    end)

    Application.put_env(:cytale, :media_proxy_address_allowed?, fn
      {127, 0, 0, 1} -> true
      other -> Cytale.Net.AddressGuard.public?(other)
    end)

    Cytale.MediaProxy.Cache.clear()

    on_exit(fn ->
      for {key, value} <- saved do
        case value do
          {:ok, v} -> Application.put_env(:cytale, key, v)
          :error -> Application.delete_env(:cytale, key)
        end
      end

      File.rm_rf(cache_dir)
      Cytale.MediaProxy.Cache.clear()

      try do
        if Process.alive?(sup), do: Supervisor.stop(sup)
      catch
        :exit, _ -> :ok
      end
    end)

    %{port: port, base: "http://img.test:#{port}"}
  end

  @doc "Serve `{status, headers, body}` at `path` (a LIST body is sent chunked, without a length)."
  def route(path, {status, headers, body}), do: :ets.insert(@table, {{:route, path}, {status, headers, body}})

  @doc "How many requests reached `path`."
  def hits(path) do
    case :ets.lookup(@table, {:hits, path}) do
      [{_, n}] -> n
      [] -> 0
    end
  end

  @doc "A 1×1 PNG (optionally padded to `size` bytes with trailing data)."
  def png(extra \\ "") do
    Base.decode64!("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==") <>
      extra
  end

  @doc "A PNG header claiming a `w`×`h` canvas (a pixel bomb's calling card)."
  def png_header(w, h) do
    <<0x89, "PNG", 0x0D, 0x0A, 0x1A, 0x0A, 13::32, "IHDR", w::32, h::32, 8, 6, 0, 0, 0, 0::32>>
  end

  defmodule Plug do
    @moduledoc false
    @behaviour Elixir.Plug

    @impl true
    def init(opts), do: opts

    @impl true
    def call(conn, _opts) do
      path = conn.request_path
      :ets.update_counter(Cytale.MediaProxyStub, {:hits, path}, {2, 1}, {{:hits, path}, 0})

      case :ets.lookup(Cytale.MediaProxyStub, {:route, path}) do
        [{_, {status, headers, chunks}}] when is_list(chunks) ->
          conn =
            conn
            |> Elixir.Plug.Conn.merge_resp_headers(headers)
            |> Elixir.Plug.Conn.send_chunked(status)

          Enum.reduce_while(chunks, conn, fn chunk, conn ->
            case Elixir.Plug.Conn.chunk(conn, chunk) do
              {:ok, conn} -> {:cont, conn}
              {:error, _closed} -> {:halt, conn}
            end
          end)

        [{_, {status, headers, body}}] ->
          conn
          |> Elixir.Plug.Conn.merge_resp_headers(headers)
          |> Elixir.Plug.Conn.send_resp(status, body)

        [] ->
          Elixir.Plug.Conn.send_resp(conn, 404, "no route")
      end
    end
  end
end
