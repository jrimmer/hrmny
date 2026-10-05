defmodule CytaleWeb.Plugs.RemoteIpTest do
  @moduledoc """
  Security Tier 2 #1 — the client address behind the reverse proxy.

  Pinned DB-free here: the right-most-untrusted rule, the trust boundary
  (a spoofed X-Forwarded-For from an untrusted peer is ignored), and that two
  clients behind the SAME proxy land in separate per-IP rate buckets. The live
  endpoint + gateway legs are in `CytaleWeb.Plugs.RemoteIpLiveTest` below.
  """

  use ExUnit.Case, async: false

  import Plug.Conn

  alias CytaleWeb.Plugs.{RateLimit, RemoteIp}

  @caddy {172, 18, 0, 3}
  @client_a {203, 0, 113, 10}
  @client_b {198, 51, 100, 20}

  setup do
    prev = Application.fetch_env(:cytale, :trusted_proxies)

    on_exit(fn ->
      case prev do
        {:ok, v} -> Application.put_env(:cytale, :trusted_proxies, v)
        :error -> Application.delete_env(:cytale, :trusted_proxies)
      end
    end)

    :ok
  end

  defp conn_from(peer, xff) do
    conn = %{Plug.Test.conn(:post, "/api/v1/auth/login") | remote_ip: peer}
    if xff, do: put_req_header(conn, "x-forwarded-for", xff), else: conn
  end

  defp run(conn), do: RemoteIp.call(conn, RemoteIp.init([]))

  describe "trust boundary" do
    test "XFF from a trusted proxy is used" do
      assert run(conn_from(@caddy, "203.0.113.10")).remote_ip == @client_a
    end

    test "a spoofed XFF from an UNTRUSTED peer is ignored" do
      assert run(conn_from(@client_b, "203.0.113.10")).remote_ip == @client_b
    end

    test "no header leaves the peer untouched" do
      assert run(conn_from(@caddy, nil)).remote_ip == @caddy
    end

    test "an empty trusted list ignores XFF entirely" do
      Application.put_env(:cytale, :trusted_proxies, [])
      assert run(conn_from(@caddy, "203.0.113.10")).remote_ip == @caddy
    end

    test "a configured list replaces the default" do
      Application.put_env(:cytale, :trusted_proxies, ["192.0.2.1/32"])
      # The compose-style address is no longer trusted…
      assert run(conn_from(@caddy, "203.0.113.10")).remote_ip == @caddy
      # …the configured one is.
      assert run(conn_from({192, 0, 2, 1}, "203.0.113.10")).remote_ip == @client_a
    end
  end

  describe "right-most untrusted hop" do
    test "entries a client prepended are never believed" do
      # The client sent `X-Forwarded-For: 1.2.3.4`; Caddy appended the real
      # address. The right-most untrusted hop is the real one.
      assert run(conn_from(@caddy, "1.2.3.4, 203.0.113.10")).remote_ip == @client_a
    end

    test "a chain of trusted proxies is walked through" do
      # border edge (10.20.0.1) → inner caddy → app
      assert run(conn_from(@caddy, "203.0.113.10, 10.20.0.1")).remote_ip == @client_a
    end

    test "multiple header lines are one list, in order" do
      conn =
        @caddy
        |> conn_from(nil)
        |> Map.update!(:req_headers, &[{"x-forwarded-for", "1.2.3.4"}, {"x-forwarded-for", "203.0.113.10"} | &1])

      assert run(conn).remote_ip == @client_a
    end

    test "garbage stops the walk at the last believable address" do
      assert run(conn_from(@caddy, "not-an-ip")).remote_ip == @caddy
      assert run(conn_from(@caddy, "203.0.113.10, garbage, 10.20.0.1")).remote_ip == {10, 20, 0, 1}
    end

    test "all-trusted chains resolve to the left-most" do
      assert run(conn_from(@caddy, "10.9.9.9, 10.20.0.1")).remote_ip == {10, 9, 9, 9}
    end

    test "IPv6, bracketed/port forms and IPv4-mapped peers" do
      assert run(conn_from(@caddy, "2001:db8::1")).remote_ip == {0x2001, 0xDB8, 0, 0, 0, 0, 0, 1}
      assert run(conn_from(@caddy, "[2001:db8::1]:4711")).remote_ip == {0x2001, 0xDB8, 0, 0, 0, 0, 0, 1}
      assert run(conn_from(@caddy, "203.0.113.10:5555")).remote_ip == @client_a
      assert run(conn_from(@caddy, "::ffff:203.0.113.10")).remote_ip == @client_a

      mapped_caddy = {0, 0, 0, 0, 0, 0xFFFF, 0xAC12, 0x0003}
      assert run(conn_from(mapped_caddy, "203.0.113.10")).remote_ip == @client_a
    end
  end

  describe "CIDR parsing" do
    test "prefixes, host routes and bad entries" do
      cidrs = RemoteIp.parse_cidrs!(["10.0.0.0/8", "192.0.2.7", "fc00::/7"])
      assert RemoteIp.trusted?({10, 200, 1, 1}, cidrs)
      assert RemoteIp.trusted?({192, 0, 2, 7}, cidrs)
      refute RemoteIp.trusted?({192, 0, 2, 8}, cidrs)
      assert RemoteIp.trusted?({0xFD12, 0, 0, 0, 0, 0, 0, 1}, cidrs)
      refute RemoteIp.trusted?({0x2001, 0xDB8, 0, 0, 0, 0, 0, 1}, cidrs)
      refute RemoteIp.trusted?({11, 0, 0, 1}, cidrs)

      assert_raise ArgumentError, ~r/invalid trusted proxy CIDR/, fn ->
        RemoteIp.parse_cidrs!(["10.0.0.0/33"])
      end

      assert_raise ArgumentError, fn -> RemoteIp.parse_cidrs!(["nope/8"]) end
    end
  end

  describe "separate buckets behind one proxy" do
    @table :cytale_rate_limit

    test "two clients through the same Caddy consume two rows, not one" do
      bucket = :"t2_remote_ip_#{System.unique_integer([:positive])}"
      opts = RateLimit.init(bucket: bucket, limit: 1, window_ms: 10_000)

      on_exit(fn ->
        for ip <- [@client_a, @client_b, @caddy], do: :ets.delete(@table, {bucket, {:ip, ip}})
      end)

      a1 = @caddy |> conn_from("203.0.113.10") |> run() |> RateLimit.call(opts)
      refute a1.halted
      # Client B is NOT refused by client A's spent budget — pre-fix both
      # keyed on Caddy's address and B would get A's 429.
      b1 = @caddy |> conn_from("198.51.100.20") |> run() |> RateLimit.call(opts)
      refute b1.halted
      # A's own second request is.
      a2 = @caddy |> conn_from("203.0.113.10") |> run() |> RateLimit.call(opts)
      assert a2.halted and a2.status == 429

      assert [{_, 2, _}] = :ets.lookup(@table, {bucket, {:ip, @client_a}})
      assert [{_, 1, _}] = :ets.lookup(@table, {bucket, {:ip, @client_b}})
      assert :ets.lookup(@table, {bucket, {:ip, @caddy}}) == []
    end
  end
end

defmodule CytaleWeb.Plugs.RemoteIpLiveTest do
  @moduledoc """
  The live legs of Tier 2 #1: the ENDPOINT derives the address before the
  router's `:auth` dam, and the gateway's Identify admission limiter keys on
  the same derived address.
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Gateway.AdmissionLimiter
  alias Cytale.Test.WSClient

  @endpoint CytaleWeb.Endpoint
  @table :cytale_rate_limit

  # The compose network's Caddy — inside the default trusted private ranges.
  @caddy {172, 18, 0, 3}

  defp login_via_caddy(client) do
    conn =
      build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("content-type", "application/json")
      |> put_req_header("x-forwarded-for", client)

    post(%{conn | remote_ip: @caddy}, "/api/v1/auth/login", %{
      "identifier" => "nobody-#{System.unique_integer([:positive])}@example.com",
      "password" => "not-the-password"
    })
  end

  test "the endpoint keys the pre-auth :auth dam on the forwarded client, per client" do
    probe = login_via_caddy("203.0.113.61")
    assert probe.status == 401
    [limit] = get_resp_header(probe, "x-ratelimit-limit")
    {limit, ""} = Integer.parse(limit)

    key_a = {:auth, {:ip, {203, 0, 113, 61}}}
    key_b = {:auth, {:ip, {198, 51, 100, 61}}}
    on_exit(fn -> for k <- [key_a, key_b], do: :ets.delete(@table, k) end)

    assert [{_, 1, _}] = :ets.lookup(@table, key_a)
    assert :ets.lookup(@table, {:auth, {:ip, @caddy}}) == []

    :ets.insert(@table, {key_a, limit, System.system_time(:millisecond) + 10_000})
    assert login_via_caddy("203.0.113.61").status == 429
    assert login_via_caddy("198.51.100.61").status == 401
  end

  test "the gateway's Identify admission keys on the forwarded client" do
    AdmissionLimiter.reset()

    {:ok, sup} =
      Bandit.start_link(
        scheme: :http,
        port: 0,
        ip: {127, 0, 0, 1},
        plug: __MODULE__.GatewayPlug
      )

    {:ok, {_ip, port}} = ThousandIsland.listener_info(sup)

    {:ok, ws} =
      WSClient.start_link({127, 0, 0, 1}, port, "/gateway/websocket", nil, [
        {"x-forwarded-for", "1.2.3.4, 203.0.113.77"}
      ])

    assert {:text, _hello} = WSClient.recv(ws)

    WSClient.send_text(
      ws,
      Jason.encode!(%{op: 2, d: %{token: "cytale_not-a-real-token", properties: %{}}})
    )

    now = System.monotonic_time(:millisecond)

    wait_until(fn -> AdmissionLimiter.recent_count(:identify, "203.0.113.77", now + 1) == 1 end)
    assert AdmissionLimiter.recent_count(:identify, "127.0.0.1", now + 1) == 0
    assert AdmissionLimiter.recent_count(:identify, "1.2.3.4", now + 1) == 0
  end

  defp wait_until(fun, tries \\ 50) do
    cond do
      fun.() -> :ok
      tries == 0 -> flunk("condition never held")
      true -> Process.sleep(20) && wait_until(fun, tries - 1)
    end
  end

  defmodule GatewayPlug do
    @moduledoc false
    def init(opts), do: opts

    def call(conn, _opts) do
      conn
      |> CytaleWeb.Plugs.RemoteIp.call([])
      |> CytaleWeb.GatewaySocket.upgrade()
    end
  end
end
