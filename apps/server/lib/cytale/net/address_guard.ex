defmodule Cytale.Net.AddressGuard do
  @moduledoc """
  The ONE answer to "may this server open a connection to that address?" —
  shared by every outbound fetch whose target a member or a bot chooses:
  web-push delivery (`Cytale.Notifications.PushEndpointGuard`, audit S1) and
  the media proxy (`Cytale.MediaProxy.Fetcher`).

  Extracted from the push guard unchanged, so both surfaces refuse the same
  ranges and judge an IPv4-mapped IPv6 address by the v4 address it carries
  (8713b532) — a dual-stack socket connects `[::ffff:127.0.0.1]` to loopback.

  Rejected v4 ranges: 0/8, 10/8, 100.64/10 (CGNAT), 127/8, 169.254/16
  (link-local, incl. cloud metadata), 172.16/12, 192.168/16, 198.18/15
  (benchmarking), 224/4 (multicast), 240/4 (reserved, incl. broadcast).
  Rejected v6: `::1`, `::`, fc00::/7 (ULA), fe80::/10 (link-local), and any
  `::ffff:a.b.c.d` whose embedded v4 address is rejected.
  """

  # A resolution that hangs is a refusal: every caller is either on a request
  # path or a delivery path, and waiting out a wedged resolver is never safer.
  @resolve_timeout_ms 2_000

  @doc "True when `address` (an `:inet` tuple) is a public unicast address."
  @spec public?(:inet.ip_address()) :: boolean()
  # One clause per audited range; anything not matched is public.
  def public?({0, _, _, _}), do: false
  def public?({10, _, _, _}), do: false
  def public?({100, second, _, _}) when second in 64..127, do: false
  def public?({127, _, _, _}), do: false
  def public?({169, 254, _, _}), do: false
  def public?({172, second, _, _}) when second in 16..31, do: false
  def public?({192, 168, _, _}), do: false
  def public?({198, second, _, _}) when second in 18..19, do: false
  def public?({first, _, _, _}) when first in 224..239, do: false
  def public?({first, _, _, _}) when first in 240..255, do: false
  # v6: ::ffff:0:0/96 (IPv4-mapped) is the v4 address it carries.
  def public?({0, 0, 0, 0, 0, 0xFFFF, hi, lo}),
    do: public?({div(hi, 256), rem(hi, 256), div(lo, 256), rem(lo, 256)})

  # v6: ::1 (loopback), :: (unspecified), fc00::/7 (ULA), fe80::/10 (link-local).
  def public?({0, 0, 0, 0, 0, 0, 0, 1}), do: false
  def public?({0, 0, 0, 0, 0, 0, 0, 0}), do: false
  def public?({first, _, _, _, _, _, _, _}) when first in 0xFC00..0xFDFF, do: false
  def public?({first, _, _, _, _, _, _, _}) when first in 0xFE80..0xFEBF, do: false
  def public?({_, _, _, _} = _v4), do: true
  def public?({_, _, _, _, _, _, _, _} = _v6), do: true
  def public?(_other), do: false

  @doc """
  `{:literal, address}` when `host` is an IP literal (bracketed v6 included),
  `:name` otherwise. A literal is judged directly and never consults DNS, so a
  literal private address is refused even where a resolver would answer.
  """
  @spec classify_host(String.t()) :: {:literal, :inet.ip_address()} | :name
  def classify_host(host) when is_binary(host) do
    clean = host |> String.trim_leading("[") |> String.trim_trailing("]")

    case :inet.parse_address(String.to_charlist(clean)) do
      {:ok, address} -> {:literal, address}
      {:error, _} -> :name
    end
  end

  @doc """
  Resolve `host` (A + AAAA) in one bounded step.

  `:inet.getaddrs/2` is the OTP call that answers `{:ok, [address]}` per
  family (hosts file + DNS, per the node's inet config). `Task.yield/2` with a
  hard shutdown keeps a wedged resolver from parking the caller.
  """
  @spec resolve(String.t()) :: {:ok, [:inet.ip_address()]} | {:error, :nxdomain | :timeout}
  def resolve(host) when is_binary(host) do
    charlist = String.to_charlist(host)

    task =
      Task.async(fn ->
        Enum.flat_map([:inet, :inet6], fn family ->
          case :inet.getaddrs(charlist, family) do
            {:ok, addresses} -> addresses
            {:error, _} -> []
          end
        end)
      end)

    case Task.yield(task, @resolve_timeout_ms) || Task.shutdown(task, :brutal_kill) do
      {:ok, []} -> {:error, :nxdomain}
      {:ok, addresses} -> {:ok, addresses}
      _ -> {:error, :timeout}
    end
  end
end
