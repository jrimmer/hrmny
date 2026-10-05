defmodule CytaleWeb.Plugs.RateLimitTest do
  @moduledoc """
  #90 — the native rate buckets are keyed on the thing they protect, and a 429
  explains itself.

  Two directions are pinned against the LIVE `:api_auth` pipeline (a real
  Bearer token through the endpoint, not a mock):

    * several accounts behind ONE egress IP do NOT lock each other out — an
      account at its own limit 429s, its four neighbours on the same IP keep
      answering 200;
    * one IP still CANNOT hammer: past the per-IP ceiling every account behind
      it is refused, while another IP is untouched.

  The plug is also driven directly (no DB, no router) for the parts a live
  budget cannot reach cheaply: the ceiling and the IPv6 `/64` keying.

  Why these tests exist at all: the hermetic suite raises every shared-IP
  bucket to 10_000 (all async modules share 127.0.0.1), so nothing else in the
  tree exercises a native 429. This module is `async: false` and uses invented
  TEST-NET addresses, so nothing here contends with a peer's 127.0.0.1 buckets
  — and every row it seeds is deleted again.
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Accounts.{Auth, User}
  alias Cytale.Snowflake
  alias CytaleWeb.Compat.RateLimit, as: Shared
  alias CytaleWeb.Plugs.RateLimit

  @endpoint CytaleWeb.Endpoint

  # The table is owned by the long-lived `CytaleWeb.Compat.RateTables`
  # GenServer (app tree), so rows survive the whole run — every seed below is
  # deleted again on the way out.
  @table :cytale_rate_limit

  # TEST-NET addresses, never 127.0.0.1: the buckets under test are per-IP, and
  # a peer module's requests must not land in them (or vice versa).
  @nat_ip {203, 0, 113, 7}
  @other_ip {198, 51, 100, 22}
  @desk_ip {192, 0, 2, 44}
  @v6_a {0x2001, 0xDB8, 0x1, 0, 0, 0, 0, 0x1}
  @v6_b {0x2001, 0xDB8, 0x1, 0, 0xDEAD, 0xBEEF, 0, 0x7}
  @v6_other {0x2001, 0xDB8, 0x1, 1, 0, 0, 0, 0x1}

  # ---------------------------------------------------------------------------
  # The live pipeline: distinct accounts behind one IP
  # ---------------------------------------------------------------------------

  describe "per-account buckets on the live :api_auth pipeline (#90 acceptance)" do
    test "an account at its own limit 429s; four accounts behind the same IP do not" do
      accounts = for _ <- 1..5, do: account!()
      limit = effective_api_limit(hd(accounts))

      # These 200s are unremarkable on their own — the point is what follows.
      for account <- accounts do
        assert me(account, @nat_ip).status == 200
      end

      # Exhaust ONLY the first account's bucket (the deterministic seed the
      # compat pipeline_test uses — no 10_000-request flood on a shared test IP).
      [first | neighbours] = accounts
      seed({:api, {:user, first.user_id}}, limit)

      denied = me(first, @nat_ip)
      assert denied.status == 429

      for account <- neighbours do
        conn = me(account, @nat_ip)
        assert conn.status == 200, "account #{account.user_id} was locked out by a neighbour's burst"
        # Each neighbour has its OWN counter: the row was never shared.
        assert [remaining] = get_resp_header(conn, "x-ratelimit-remaining")
        assert {remaining, ""} = Integer.parse(remaining)
        assert remaining >= limit - 2
      end
    end

    test "the account bucket and the per-IP ceiling are separate rows" do
      account = account!()
      # A dedicated address, so this test's ceiling row is its own and the
      # count below is unambiguous.
      ip = @desk_ip
      before = System.system_time(:millisecond)

      assert me(account, ip).status == 200

      assert [{_, count, window_end}] = :ets.lookup(@table, {:api, {:user, account.user_id}})
      assert count == 1
      assert window_end > before

      # The ceiling is keyed on the IP, not on the account, and it is a SECOND
      # row (the same request consumed both).
      assert [{_, ceil_count, _}] = :ets.lookup(@table, {{:api, :ip_ceiling}, {:ip, ip}})
      assert ceil_count == 1

      assert :ets.lookup(@table, {:api, {:ip, ip}}) == [],
             "an authenticated request must not consume an unauthenticated-style per-IP :api bucket"
    end

    test "the 429 carries the envelope, Retry-After and the account-scoped explanation" do
      account = account!()
      limit = effective_api_limit(account)
      seed({:api, {:user, account.user_id}}, limit)

      log =
        capture_log(fn ->
          conn = me(account, @nat_ip)
          assert conn.status == 429

          # The surface's standard envelope — same shape, key spelling and
          # `status * 100 + 1` code convention as every other /api/v1 error.
          assert %{"error" => %{"key" => "rate_limited", "code" => 42_901, "message" => message}} =
                   Jason.decode!(conn.resp_body)

          assert message =~ "this account"
          assert message =~ "account limit is #{limit} per 10s"

          # ...and the same limit as data, for a client to branch on.
          assert %{"error" => %{"scope" => "account", "retry_after_ms" => ms}} = Jason.decode!(conn.resp_body)
          assert is_integer(ms) and ms >= 1 and ms <= 10_000
          assert get_resp_header(conn, "x-ratelimit-scope") == ["account"]
          assert message =~ "Try again in"
          assert message =~ "second"

          assert [retry_after] = get_resp_header(conn, "retry-after")
          assert {seconds, ""} = Integer.parse(retry_after)
          assert seconds >= 1 and seconds <= 10

          # The headers belong to the bucket that TRIPPED, and remaining is
          # saturated rather than negative.
          assert get_resp_header(conn, "x-ratelimit-limit") == [Integer.to_string(limit)]
          assert get_resp_header(conn, "x-ratelimit-remaining") == ["0"]

          assert [reset_after] = get_resp_header(conn, "x-ratelimit-reset-after")
          assert {reset_after, ""} = Integer.parse(reset_after)
          assert reset_after >= 0 and reset_after <= 10
        end)

      # The offending bucket is identifiable from the log line alone (#90):
      # name, key and window are all there.
      assert log =~ "rate limit tripped bucket=api"
      assert log =~ "scope=account"
      assert log =~ "key={:api, {:user, #{account.user_id}}}"
      assert log =~ "window_ms=10000"
      assert log =~ "limit=#{limit}"
    end
  end

  # ---------------------------------------------------------------------------
  # Both directions as a REAL burst (no seeding): the plug's own opts set a
  # limit small enough to reach, so these are the literal acceptance probes.
  # ---------------------------------------------------------------------------

  describe "a real burst (#90 acceptance, no seeded rows)" do
    test "one account hammering its own bucket 429s on request limit + 1" do
      account_id = Snowflake.next()
      opts = [bucket: :test_burst_one, limit: 3]

      under =
        for _ <- 1..3 do
          plug_call(principal_conn(@nat_ip, account_id), opts)
        end

      # Every request under the limit passes, and the count is visibly the
      # ACCOUNT's own: 2, 1, 0 remaining.
      assert Enum.map(under, & &1.status) == [nil, nil, nil]

      assert Enum.map(under, fn conn -> get_resp_header(conn, "x-ratelimit-remaining") end) ==
               [["2"], ["1"], ["0"]]

      over = plug_call(principal_conn(@nat_ip, account_id), opts)
      assert over.status == 429
      assert %{"error" => %{"key" => "rate_limited", "message" => message}} = Jason.decode!(over.resp_body)
      assert message =~ "account limit is 3 per 10s"
      assert get_resp_header(over, "retry-after") != []
    end

    test "that burst does not lock out the other accounts on the same IP" do
      hammered = Snowflake.next()
      opts = [bucket: :test_burst_many, limit: 2]

      # Burn the hammering account's budget: two in-window requests, then 429.
      assert plug_call(principal_conn(@nat_ip, hammered), opts).status != 429
      assert plug_call(principal_conn(@nat_ip, hammered), opts).status != 429
      assert plug_call(principal_conn(@nat_ip, hammered), opts).status == 429

      # ...and the three neighbours behind the SAME IP each still get a fresh
      # budget (this is the NAT lockout #90 is about).
      for _ <- 1..3 do
        neighbour = plug_call(principal_conn(@nat_ip, Snowflake.next()), opts)
        assert neighbour.status != 429
        assert get_resp_header(neighbour, "x-ratelimit-remaining") == ["1"]
      end
    end
  end

  # ---------------------------------------------------------------------------
  # The per-IP ceiling (plug level — a live 1_000_000 budget cannot be reached)
  # ---------------------------------------------------------------------------

  describe "the per-IP ceiling" do
    test "one IP past its ceiling 429s an account that is well under its own limit" do
      account_id = Snowflake.next()
      bucket = :test_ceiling_account
      ceiling = Cytale.Config.rate_limit_ip_ceiling(bucket)
      seed({{bucket, :ip_ceiling}, {:ip, @nat_ip}}, ceiling)

      conn = plug_call(principal_conn(@nat_ip, account_id), bucket: bucket, limit: 50)

      assert conn.status == 429
      assert %{"error" => %{"key" => "rate_limited", "message" => message}} = Jason.decode!(conn.resp_body)
      assert message =~ "this network"
      assert message =~ "shared per-IP ceiling is #{ceiling} per 10s"
      assert message =~ "covers every account behind this IP"
      assert %{"error" => %{"scope" => "ip"}} = Jason.decode!(conn.resp_body)
      assert get_resp_header(conn, "x-ratelimit-scope") == ["ip"]
    end

    test "a tripped ceiling does not touch a different IP" do
      bucket = :test_ceiling_other_ip
      ceiling = Cytale.Config.rate_limit_ip_ceiling(bucket)
      seed({{bucket, :ip_ceiling}, {:ip, @nat_ip}}, ceiling)

      assert plug_call(principal_conn(@nat_ip, Snowflake.next()), bucket: bucket, limit: 50).status == 429

      # Same bucket, same limit, a different egress IP: untouched.
      assert plug_call(principal_conn(@other_ip, Snowflake.next()), bucket: bucket, limit: 50).status != 429
    end

    test "an UNAUTHENTICATED request never consumes a ceiling — its own bucket is the IP bucket" do
      bucket = :test_ceiling_unauth
      ceiling = Cytale.Config.rate_limit_ip_ceiling(bucket)
      seed({{bucket, :ip_ceiling}, {:ip, @nat_ip}}, ceiling)

      # No principal → no ceiling consult, so this passes even with the ceiling
      # seeded past its limit: the pre-auth surface's own per-IP bucket is its
      # only dam (#90 trap — that dam must not be loosened).
      conn = plug_call(Plug.Test.conn(:get, "/api/v1/invites/abc"), bucket: bucket, limit: 50)
      assert conn.status != 429

      # Untouched: its counter is exactly what the seed wrote, so the ceiling
      # was never consumed.
      assert [{_, ^ceiling, _}] = :ets.lookup(@table, {{bucket, :ip_ceiling}, {:ip, @nat_ip}})
    end
  end

  # ---------------------------------------------------------------------------
  # The unauthenticated surface is still keyed per IP
  # ---------------------------------------------------------------------------

  describe "the pre-auth :auth surface" do
    test "the per-IP dam bites whichever account a login names — and only on that IP" do
      probe = login(@nat_ip, "nobody@example.com")
      assert probe.status == 401
      assert [limit_header] = get_resp_header(probe, "x-ratelimit-limit")
      assert {limit, ""} = Integer.parse(limit_header)

      seed({:auth, {:ip, @nat_ip}}, limit)

      log =
        capture_log(fn ->
          conn = login(@nat_ip, "someone-else@example.com")
          assert conn.status == 429

          assert %{"error" => %{"key" => "rate_limited", "message" => message}} =
                   Jason.decode!(conn.resp_body)

          # Says "network", never "account": there is no principal yet, and the
          # limit really is shared by everyone behind that IP.
          assert message =~ "this network"
          assert message =~ "per-IP limit is #{limit} per 10s"
          assert message =~ "shared by everyone behind this IP"
          assert %{"error" => %{"scope" => "ip"}} = Jason.decode!(conn.resp_body)
          assert get_resp_header(conn, "x-ratelimit-scope") == ["ip"]
        end)

      assert log =~ "rate limit tripped bucket=auth scope=network"
      assert log =~ "key={:auth, {:ip, #{inspect(@nat_ip)}}}"
      assert log =~ "window_ms=10000"

      # A different network is unaffected — the dam is per IP, not global.
      assert login(@other_ip, "someone-else@example.com").status == 401
    end
  end

  # ---------------------------------------------------------------------------
  # IPv6: per-/64, not per-address
  # ---------------------------------------------------------------------------

  describe "IPv6 keying (#90)" do
    test "ip_key/1 keeps IPv4 exact and collapses IPv6 to its /64" do
      assert Shared.ip_key({127, 0, 0, 1}) == {127, 0, 0, 1}
      assert Shared.ip_key(@v6_a) == {:ip6_64, 0x2001, 0xDB8, 0x1, 0}

      # Same /64, wildly different interface ids → one bucket...
      assert Shared.ip_key(@v6_a) == Shared.ip_key(@v6_b)
      # ...a different /64 does not collapse into it...
      refute Shared.ip_key(@v6_a) == Shared.ip_key(@v6_other)

      # ...and the tag keeps a /64 from EVER colliding with an IPv4 tuple: the
      # four numbers are the same, the terms are not.
      key = Shared.ip_key(@v6_a)
      assert {elem(key, 0), elem(key, 1), elem(key, 2), elem(key, 3)} == {:ip6_64, 0x2001, 0xDB8, 0x1}
      refute tuple_size(key) == 4
    end

    test "rotating the interface id does not mint a fresh ceiling bucket" do
      bucket = :test_v6_ceiling
      ceiling = Cytale.Config.rate_limit_ip_ceiling(bucket)
      seed({{bucket, :ip_ceiling}, {:ip, Shared.ip_key(@v6_a)}}, ceiling)

      # @v6_b shares @v6_a's /64 → the seeded bucket catches it.
      assert plug_call(principal_conn(@v6_b, Snowflake.next()), bucket: bucket, limit: 50).status == 429
      # A different /64 is its own bucket.
      assert plug_call(principal_conn(@v6_other, Snowflake.next()), bucket: bucket, limit: 50).status != 429
    end
  end

  # ---------------------------------------------------------------------------
  # The shared 429 sentence
  # ---------------------------------------------------------------------------

  describe "the shared 429 sentence" do
    test "names the limit, its scope, and the retry hint" do
      assert Shared.limit_message(:account, 50, 10_000, 12_000) =~ "account limit is 50 per 10s"
      assert Shared.limit_message(:account, 50, 10_000, 12_000) =~ "Try again in 12 seconds"

      ceiling = Shared.limit_message(:ip_ceiling, 500, 10_000, 9_000)
      assert ceiling =~ "shared per-IP ceiling is 500 per 10s"
      assert ceiling =~ "covers every account behind this IP"

      assert Shared.limit_message(:network, 30, 10_000, 1_000) =~ "1 second"
      assert Shared.limit_message(:webhook, 5, 2_000, 1_400) =~ "5 per 2s"
      assert Shared.limit_message(:webhook, 5, 2_000, 1_400) =~ "1.4 seconds"
      assert Shared.limit_message(:application, 10, 5_000, 5_000) =~ "this application"
      assert Shared.limit_message(:interaction, 10, 900_000, 60_000) =~ "10 per 15 minutes"
    end
  end

  # ---------------------------------------------------------------------------
  # Helpers
  # ---------------------------------------------------------------------------

  defp account! do
    suffix = System.unique_integer([:positive, :monotonic])

    {:ok, user} =
      User.create("rl90_#{suffix}", "rl90_#{suffix}@example.com", "password-123")

    %{user_id: user.user_id, token: Auth.issue_access_token(user.user_id, user.username, true)}
  end

  # The effective :api budget (the hermetic suite's override included), read off
  # a live response rather than hardcoded.
  defp effective_api_limit(account) do
    conn = me(account, @nat_ip)
    assert conn.status == 200
    assert [limit] = get_resp_header(conn, "x-ratelimit-limit")
    assert {limit, ""} = Integer.parse(limit)
    limit
  end

  defp me(account, ip) do
    conn =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("authorization", "Bearer " <> account.token)

    get(%{conn | remote_ip: ip}, "/api/v1/users/@me")
  end

  defp login(ip, identifier) do
    conn =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("content-type", "application/json")

    post(%{conn | remote_ip: ip}, "/api/v1/auth/login", %{
      "identifier" => identifier,
      "password" => "not-the-password"
    })
  end

  # A conn for the plug under direct test: a principal is what makes the bucket
  # per-account, so this is the shape the `:api_auth` pipeline hands over.
  defp principal_conn(ip, user_id) do
    Plug.Test.conn(:get, "/api/v1/users/@me")
    |> Map.put(:remote_ip, ip)
    |> assign(:current_user, %{user_id: user_id})
  end

  defp plug_call(conn, opts) do
    RateLimit.call(conn, RateLimit.init(opts))
  end

  # Seed one bucket's counter AT its limit: the next consume saturates and
  # refuses (the deterministic seed the compat pipeline_test uses).
  defp seed(key, limit) do
    ensure_table!()
    :ets.insert(@table, {key, limit, System.system_time(:millisecond) + 10_000})
    on_exit(fn -> :ets.delete(@table, key) end)
    :ok
  end

  defp ensure_table! do
    if :ets.whereis(@table) == :undefined do
      :ets.new(@table, [:set, :named_table, :public, read_concurrency: true])
    end

    :ok
  end
end
