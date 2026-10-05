defmodule Cytale.MediaProxy.Fetcher do
  @moduledoc """
  The media proxy's outbound GET — the one place this server fetches a URL a
  member or a bot chose, so every SSRF rule lives here and nowhere else.

  ## The rules

    * `http`/`https` only, a host, no userinfo, and a port of 80, 443, 8080
      or 8443 (`allowed_ports` in the `:media_proxy` config) — an image host
      on any other port is not worth handing every public service's odd
      ports a scanner.
    * The host is resolved (`Cytale.Net.AddressGuard`, shared with web push)
      and EVERY answer must be public — no loopback, private, CGNAT,
      link-local (cloud metadata), multicast or reserved range, and an
      IPv4-mapped IPv6 address is judged by the v4 address it carries.
    * **The connection is pinned to the address that was checked.** Mint
      connects to the resolved IP tuple and takes the name only as `hostname`
      (the `Host` header, TLS SNI and certificate verification), so DNS is
      never consulted again between the check and the connect: a rebinding
      answer (public for the check, `127.0.0.1` for the connect) has no
      second lookup to answer. This is the residual risk
      `Cytale.Notifications.PushEndpointGuard` documents and accepts; the
      proxy closes it, because here the response body is returned to the
      requester.
    * Redirects are followed by hand, at most 3, and every hop goes
      through the same scheme/port/address checks — a public URL that
      redirects to `http://169.254.169.254/` is refused at the hop.
    * Connect timeout 5 s, a per-read timeout of 5 s and a 15 s deadline for
      the whole fetch; the body is streamed and the fetch aborts the moment it
      passes `max_bytes` (the `Content-Length` is checked first, but never
      trusted alone).
    * No `Accept-Encoding` is sent, so the body arrives as the origin's bytes;
      a server that compresses anyway yields a body the sniffer refuses —
      nothing here ever inflates, so there is no decompression bomb to defuse.
    * No cookies, no `Referer`, a fixed User-Agent: the origin learns that the
      Cytale server asked, never which member was reading.

  ## Test seams

  `config :cytale, :media_proxy_resolver` (a `/1` fun with
  `AddressGuard.resolve/1`'s contract) and `:media_proxy_address_allowed?` (a
  `/1` predicate over an address tuple; default `AddressGuard.public?/1`) let
  the suite point a hostname at a local test server. Neither is read from the
  environment; production never sets them.
  """

  alias Cytale.Net.AddressGuard

  @max_redirects 3
  @default_ports [80, 443, 8080, 8443]
  @connect_timeout_ms 5_000
  @recv_timeout_ms 5_000
  @deadline_ms 15_000
  @user_agent "Mozilla/5.0 (compatible; Hrmny-MediaProxy/1.0)"

  @type reason ::
          :invalid_url
          | :scheme
          | :port
          | :unresolvable
          | :blocked_address
          | :too_many_redirects
          | :too_large
          | :timeout
          | {:status, pos_integer()}
          | {:connect, term()}

  @doc """
  GET `url`. `{:ok, body}` for a 2xx whose body stayed within `max_bytes`;
  `{:error, reason}` otherwise.
  """
  @spec get(String.t(), pos_integer()) :: {:ok, binary()} | {:error, reason()}
  def get(url, max_bytes) when is_binary(url) do
    deadline = System.monotonic_time(:millisecond) + @deadline_ms
    follow(url, max_bytes, deadline, 0)
  end

  @doc """
  Parse and vet a URL WITHOUT resolving it: `{:ok, uri}` when its scheme,
  host and port are ones the proxy would fetch. What the render path uses to
  decide whether a URL gets a `proxy_url` at all.
  """
  @spec parse(term()) :: {:ok, URI.t()} | {:error, :invalid_url | :scheme | :port}
  def parse(url) when is_binary(url) and byte_size(url) <= 2048 do
    case URI.new(url) do
      {:ok, %URI{scheme: scheme, host: host, port: port, userinfo: nil} = uri}
      when scheme in ["http", "https"] and is_binary(host) and host != "" ->
        if port in allowed_ports(), do: {:ok, uri}, else: {:error, :port}

      {:ok, %URI{scheme: scheme}} when scheme not in ["http", "https"] ->
        {:error, :scheme}

      _ ->
        {:error, :invalid_url}
    end
  end

  def parse(_other), do: {:error, :invalid_url}

  # -- internals ---------------------------------------------------------------------

  defp follow(_url, _max, _deadline, hops) when hops > @max_redirects, do: {:error, :too_many_redirects}

  defp follow(url, max_bytes, deadline, hops) do
    with {:ok, uri} <- parse(url),
         {:ok, address} <- pinned_address(uri.host) do
      case request(uri, address, max_bytes, deadline) do
        {:redirect, location} ->
          # A relative Location resolves against the URL that answered.
          next = uri |> URI.merge(location) |> URI.to_string()
          follow(next, max_bytes, deadline, hops + 1)

        other ->
          other
      end
    end
  end

  # The address the connection will use: the literal itself, or the FIRST of
  # the resolved answers — and only when every answer is allowed, since an
  # attacker who controls one record of a round-robin controls the rest.
  defp pinned_address(host) do
    case AddressGuard.classify_host(host) do
      {:literal, address} ->
        if allowed?(address), do: {:ok, address}, else: {:error, :blocked_address}

      :name ->
        case resolver().(host) do
          {:ok, [_ | _] = addresses} ->
            if Enum.all?(addresses, &allowed?/1),
              do: {:ok, hd(addresses)},
              else: {:error, :blocked_address}

          _ ->
            {:error, :unresolvable}
        end
    end
  end

  defp request(uri, address, max_bytes, deadline) do
    scheme = if uri.scheme == "https", do: :https, else: :http
    family = if tuple_size(address) == 8, do: [inet6: true, inet4: false], else: []

    opts = [
      hostname: uri.host,
      protocols: [:http1],
      mode: :passive,
      transport_opts: [timeout: @connect_timeout_ms] ++ family
    ]

    path =
      case {uri.path, uri.query} do
        {p, nil} when p in [nil, ""] -> "/"
        {p, q} when p in [nil, ""] -> "/?" <> q
        {p, nil} -> p
        {p, q} -> p <> "?" <> q
      end

    headers = [
      {"user-agent", @user_agent},
      {"accept", "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9"}
    ]

    case Mint.HTTP.connect(scheme, address, uri.port, opts) do
      {:ok, conn} ->
        case Mint.HTTP.request(conn, "GET", path, headers, nil) do
          {:ok, conn, ref} ->
            receive_response(conn, ref, max_bytes, deadline, %{status: nil, headers: [], body: [], size: 0})

          {:error, conn, reason} ->
            close_with(conn, {:error, {:connect, reason}})
        end

      {:error, %Mint.TransportError{reason: :timeout}} ->
        {:error, :timeout}

      {:error, reason} ->
        {:error, {:connect, reason}}
    end
  end

  defp receive_response(conn, ref, max_bytes, deadline, acc) do
    remaining = deadline - System.monotonic_time(:millisecond)

    if remaining <= 0 do
      close_with(conn, {:error, :timeout})
    else
      case Mint.HTTP.recv(conn, 0, min(remaining, @recv_timeout_ms)) do
        {:ok, conn, responses} ->
          case consume(responses, ref, max_bytes, acc) do
            {:cont, acc} -> receive_response(conn, ref, max_bytes, deadline, acc)
            {:done, result} -> close_with(conn, result)
          end

        {:error, conn, %Mint.TransportError{reason: :timeout}, _responses} ->
          close_with(conn, {:error, :timeout})

        {:error, conn, reason, _responses} ->
          close_with(conn, {:error, {:connect, reason}})
      end
    end
  end

  defp consume([], _ref, _max, acc), do: {:cont, acc}

  defp consume([{:status, ref, status} | rest], ref, max, acc),
    do: consume(rest, ref, max, %{acc | status: status})

  defp consume([{:headers, ref, headers} | rest], ref, max, acc) do
    acc = %{acc | headers: acc.headers ++ headers}

    cond do
      acc.status in [301, 302, 303, 307, 308] ->
        case header(acc.headers, "location") do
          nil -> {:done, {:error, {:status, acc.status}}}
          location -> {:done, {:redirect, location}}
        end

      acc.status not in 200..299 ->
        {:done, {:error, {:status, acc.status}}}

      declared_too_large?(acc.headers, max) ->
        {:done, {:error, :too_large}}

      true ->
        consume(rest, ref, max, acc)
    end
  end

  defp consume([{:data, ref, chunk} | rest], ref, max, acc) do
    size = acc.size + byte_size(chunk)

    if size > max,
      do: {:done, {:error, :too_large}},
      else: consume(rest, ref, max, %{acc | body: [acc.body | chunk], size: size})
  end

  defp consume([{:done, ref} | _rest], ref, _max, acc),
    do: {:done, {:ok, IO.iodata_to_binary(acc.body)}}

  defp consume([_other | rest], ref, max, acc), do: consume(rest, ref, max, acc)

  defp declared_too_large?(headers, max) do
    case header(headers, "content-length") do
      nil ->
        false

      value ->
        case Integer.parse(value) do
          {n, _} -> n > max
          :error -> false
        end
    end
  end

  defp header(headers, name) do
    Enum.find_value(headers, fn {k, v} -> if String.downcase(k) == name, do: v end)
  end

  defp close_with(conn, result) do
    Mint.HTTP.close(conn)
    result
  end

  defp allowed_ports do
    case Application.get_env(:cytale, :media_proxy, []) do
      opts when is_list(opts) -> Keyword.get(opts, :allowed_ports, @default_ports)
      opts when is_map(opts) -> Map.get(opts, :allowed_ports, @default_ports)
      _ -> @default_ports
    end
  end

  defp resolver, do: Application.get_env(:cytale, :media_proxy_resolver, &AddressGuard.resolve/1)

  defp allowed?(address) do
    Application.get_env(:cytale, :media_proxy_address_allowed?, &AddressGuard.public?/1).(address)
  end
end
