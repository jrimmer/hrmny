defmodule Cytale.Notifications.PushEndpointGuard do
  @moduledoc """
  SSRF gate for web-push endpoints (audit S1).

  A push subscription's `endpoint` is a URL THE CLIENT chooses, and delivery
  POSTs to it verbatim (Finch). Unchecked, any authenticated member could
  register `http://169.254.169.254/`, `http://127.0.0.1:4100` (the session-
  bridge port), or any other internal address and read delivery outcomes —
  status codes, timeouts, DNS failures — as a reachability oracle against the
  server's own network.

  `validate/1` therefore runs twice:

    * at registration (`CytaleWeb.PushController.create/2`) — a bad endpoint
      never lands in the store;
    * at SEND time (`Cytale.Notifications.WebPush.send_to/2`) — a row that was
      registered before the guard existed, or whose host re-resolved somewhere
      private since registration, is retired (the 404/410 path) rather than
      posted to.

  The rules:

    * scheme MUST be `https` (a web-push service is a TLS endpoint by spec);
    * host MUST be present;
    * no explicit port, or exactly 443;
    * the host is resolved (A + AAAA, bounded by a small timeout) and EVERY
      resolved address must be public. Rejected v4 ranges: 0/8, 10/8,
      100.64/10 (CGNAT), 127/8, 169.254/16 (link-local), 172.16/12, 192.168/16,
      198.18/15 (benchmarking), 224/4 (multicast), 240/4 (reserved, incl.
      broadcast). Rejected v6: `::1`, the unspecified address `::`, fc00::/7
      (ULA), fe80::/10 (link-local), and any IPv4-mapped `::ffff:a.b.c.d`
      whose embedded v4 address is in a rejected v4 range.

  IP-literal endpoints (`https://127.0.0.1/...`) are classified directly and
  never consult the resolver, so a literal private address is refused even
  where DNS would answer.

  ## Residual risk, stated honestly

  This is a resolve-then-connect check and the two events share no lock: DNS
  is re-consulted when Finch actually opens the connection, so an
  authoritative DNS server can hand out a different address in between (DNS
  rebinding / TOCTOU). The guard shrinks that window to one resolution TTL and
  to whoever controls the endpoint host's DNS — it does not close it. Full
  closure would mean pinning the validated address at connect time (a custom
  Finch pool), which this surface does not pay for: the POST body is encrypted
  to keys the subscriber chose, so the exposed primitive is the reachability
  oracle and an unwanted internal POST, not a data leak.

  Test seam: the resolver is injectable via
  `config :cytale, push_endpoint_resolver` (a `/1` fun with `resolve/1`'s
  contract). The default is this module's real resolver; the hermetic suite
  substitutes a stub so no test ever touches DNS.
  """

  alias Cytale.Net.AddressGuard

  @typedoc "Why an endpoint was refused. Stable wire tokens (see PushController)."
  @type reason :: :malformed | :scheme | :host | :port | :unresolvable | :blocked_address

  @doc """
  `:ok` when `endpoint` is an https URL on port 443 whose host resolves to
  public addresses only; `{:error, reason}` otherwise.
  """
  @spec validate(term()) :: :ok | {:error, reason()}
  def validate(endpoint) when is_binary(endpoint) do
    case URI.parse(endpoint) do
      %URI{scheme: "https", host: host, port: port}
      when is_binary(host) and host != "" and port in [nil, 443] ->
        check_addresses(host)

      # https with a host but a foreign port — the port is the reason.
      %URI{scheme: "https", host: host} when is_binary(host) and host != "" ->
        {:error, :port}

      # https with no usable host at all.
      %URI{scheme: "https"} ->
        {:error, :host}

      %URI{} ->
        {:error, :scheme}

      _ ->
        {:error, :malformed}
    end
  end

  def validate(_), do: {:error, :malformed}

  @doc false
  # Host + path only, for log lines. A web-push endpoint does not carry
  # credentials, but the discipline stays: never paste a full client-supplied
  # URL into a log — host+path is everything the operator needs.
  def log_target(endpoint) when is_binary(endpoint) do
    case URI.parse(endpoint) do
      %URI{host: host, path: path} when is_binary(host) and host != "" ->
        host <> if(is_binary(path), do: path, else: "")

      _ ->
        "(unparseable endpoint)"
    end
  end

  def log_target(_), do: "(unparseable endpoint)"

  # -- internals -----------------------------------------------------------------

  defp check_addresses(host) do
    case classify_host(host) do
      {:literal, address} ->
        verdict([address])

      :name ->
        case resolver().(host) do
          {:ok, addresses} -> verdict(addresses)
          {:error, _} -> {:error, :unresolvable}
        end
    end
  end

  defp verdict(addresses) do
    # ANY resolved address landing in a private/reserved range refuses the
    # endpoint: an attacker who controls one record controls the round-robin.
    if Enum.all?(addresses, &public?/1),
      do: :ok,
      else: {:error, :blocked_address}
  end

  defp classify_host(host), do: AddressGuard.classify_host(host)

  # The default resolver: A + AAAA in one bounded step — the shared
  # `Cytale.Net.AddressGuard.resolve/1` (the media proxy resolves the same way).
  @doc false
  def resolve(host) when is_binary(host), do: AddressGuard.resolve(host)

  defp resolver do
    Application.get_env(:cytale, :push_endpoint_resolver, &resolve/1)
  end

  # The audited ranges live in `Cytale.Net.AddressGuard`, shared with the
  # media proxy so both outbound surfaces refuse exactly the same addresses.
  defp public?(address), do: AddressGuard.public?(address)
end
