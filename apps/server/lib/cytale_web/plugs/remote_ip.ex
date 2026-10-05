defmodule CytaleWeb.Plugs.RemoteIp do
  @moduledoc """
  The real client address behind the reverse proxy (security Tier 2, #1).

  The deploy puts Caddy in front of the app, so the TCP peer of EVERY request
  is Caddy's container address. Without this plug `conn.remote_ip` is that
  one address for the whole internet, and every per-IP limiter (the `:auth`
  surface, the `:api_ip_ceiling`, the compat pre-auth dam, the webhook miss
  dam, the gateway Identify/Resume admission) collapses into ONE global
  bucket — a single abusive client locks everybody out, and the dams stop
  protecting anything.

  The rule, and why it cannot be spoofed:

    * `X-Forwarded-For` is honoured ONLY when the TCP peer is inside a
      configured trusted-proxy CIDR (`CYTALE_TRUSTED_PROXIES`, read through
      `Cytale.Config.trusted_proxies/0`). A client that talks to the app
      directly and sends its own header is ignored outright.
    * The header is walked RIGHT to LEFT — each hop was appended by the hop
      after it — and the first address that is NOT a trusted proxy is the
      client. Everything to the left of it was written by that untrusted
      client and is never believed, so prepending fake entries buys nothing.
    * If every hop is trusted (an internal caller), the left-most is used.
      An unparseable entry stops the walk at the last address we could
      believe.

  Runs in the endpoint BEFORE the router, so every rate-limit plug and the
  gateway upgrade (which reads `conn.remote_ip` for its admission key) see the
  derived address. `Plug.Conn.get_peer_data/1` still reports the raw TCP peer
  for anything that genuinely needs it.
  """

  @behaviour Plug

  import Bitwise

  @impl true
  def init(opts), do: opts

  @impl true
  def call(%Plug.Conn{} = conn, _opts) do
    case Cytale.Config.trusted_proxies() do
      [] -> conn
      trusted -> %{conn | remote_ip: client_ip(conn.remote_ip, xff_hops(conn), trusted)}
    end
  end

  @doc """
  The client address for a TCP `peer` and the `X-Forwarded-For` hops (in
  header order, left to right) given the parsed `trusted` CIDRs.
  """
  @spec client_ip(:inet.ip_address(), [String.t()], [cidr()]) :: :inet.ip_address()
  def client_ip(peer, hops, trusted) do
    hops
    |> Enum.reverse()
    |> Enum.reduce_while(peer, fn hop, current ->
      if trusted?(current, trusted) do
        case parse_hop(hop) do
          {:ok, ip} -> {:cont, ip}
          :error -> {:halt, current}
        end
      else
        {:halt, current}
      end
    end)
  end

  defp xff_hops(conn) do
    conn
    |> Plug.Conn.get_req_header("x-forwarded-for")
    |> Enum.flat_map(&String.split(&1, ","))
    |> Enum.map(&String.trim/1)
    |> Enum.reject(&(&1 == ""))
  end

  # A hop is a bare address; tolerate the `[v6]:port` / `v4:port` forms some
  # proxies write, and the IPv4-mapped IPv6 form (keyed as the IPv4 address).
  defp parse_hop(hop) do
    candidate =
      case Regex.run(~r/^\[([^\]]+)\](?::\d+)?$/, hop) do
        [_, inner] ->
          inner

        nil ->
          case Regex.run(~r/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/, hop) do
            [_, v4] -> v4
            nil -> hop
          end
      end

    case :inet.parse_strict_address(String.to_charlist(candidate)) do
      {:ok, {0, 0, 0, 0, 0, 0xFFFF, hi, lo}} ->
        {:ok, {hi >>> 8, hi &&& 0xFF, lo >>> 8, lo &&& 0xFF}}

      {:ok, ip} ->
        {:ok, ip}

      {:error, _} ->
        :error
    end
  end

  # -- CIDRs --------------------------------------------------------------------

  @typedoc "A parsed CIDR: `{family_bits, network_integer, prefix_length}`."
  @type cidr :: {32 | 128, non_neg_integer(), non_neg_integer()}

  @doc "Whether `ip` falls inside any of the parsed `cidrs`."
  @spec trusted?(:inet.ip_address(), [cidr()]) :: boolean()
  def trusted?(ip, cidrs) do
    {bits, value} = to_int(ip)

    Enum.any?(cidrs, fn {cbits, network, prefix} ->
      cbits == bits and value >>> (bits - prefix) == network >>> (bits - prefix)
    end)
  end

  @doc """
  Parses a list of CIDR strings (`"10.0.0.0/8"`, `"::1"`, …; a bare address
  is a host route). Raises `ArgumentError` naming the bad entry, so a typo in
  `CYTALE_TRUSTED_PROXIES` fails the boot instead of silently trusting less.
  """
  @spec parse_cidrs!([String.t()]) :: [cidr()]
  def parse_cidrs!(list), do: Enum.map(list, &parse_cidr!/1)

  defp parse_cidr!(entry) do
    {addr, prefix} =
      case String.split(String.trim(entry), "/", parts: 2) do
        [a] -> {a, nil}
        [a, p] -> {a, p}
      end

    with {:ok, ip} <- :inet.parse_strict_address(String.to_charlist(addr)),
         {bits, value} = to_int(ip),
         {:ok, len} <- prefix_len(prefix, bits) do
      mask = if len == 0, do: 0, else: (1 <<< bits) - (1 <<< (bits - len))
      {bits, value &&& mask, len}
    else
      _ -> raise ArgumentError, "invalid trusted proxy CIDR: #{inspect(entry)}"
    end
  end

  defp prefix_len(nil, bits), do: {:ok, bits}

  defp prefix_len(p, bits) do
    case Integer.parse(p) do
      {n, ""} when n >= 0 and n <= bits -> {:ok, n}
      _ -> :error
    end
  end

  defp to_int({a, b, c, d}), do: {32, (a <<< 24) + (b <<< 16) + (c <<< 8) + d}

  # An IPv4-mapped IPv6 peer (a dual-stack listener) is the IPv4 address.
  defp to_int({0, 0, 0, 0, 0, 0xFFFF, hi, lo}),
    do: to_int({hi >>> 8, hi &&& 0xFF, lo >>> 8, lo &&& 0xFF})

  defp to_int({_, _, _, _, _, _, _, _} = t) do
    {128, t |> Tuple.to_list() |> Enum.reduce(0, fn w, acc -> (acc <<< 16) + w end)}
  end
end
