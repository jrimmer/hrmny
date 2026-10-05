defmodule CytaleWeb.Compat.PreAuthRateLimit do
  @moduledoc """
  B2 — the unauthenticated-flood dam in front of `BotAuth`: an IP-keyed
  fixed-window bucket consumed BEFORE authentication, so credential-guessing
  floods (a) never reach the Scylla token read per attempt and (b) never ride
  the per-principal buckets, which only exist for VALID principals
  (`{:user, id}` — a failed auth has no principal to key).

  The IP bucket applies to ALL compat requests at a deliberately HIGH
  ceiling (`Cytale.Config.compat_preauth_ip_limit/0`, default 30 / 10s per
  IP): authenticated traffic from a legitimate single-IP deployment stays
  far under it, and the per-principal route bucket remains the effective
  limit for valid principals (no double-throttle — the dam only bites floods
  that were never authenticating anyway). The 429 is the shared Discord
  shape (`RateLimit.maybe_limited/4`); the table is owned by the long-lived
  `CytaleWeb.Compat.RateTables` GenServer and swept with the same cadence.
  """

  @behaviour Plug

  alias CytaleWeb.Compat.RateLimit

  @window_ms 10_000
  # Stable bucket identity for the pre-auth dam (distinct from every route
  # template bucket — it is per-IP, not per-route).
  @bucket RateLimit.bucket("compat-preauth-ip")

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, _opts) do
    limit = Cytale.Config.compat_preauth_ip_limit()
    now = System.system_time(:millisecond)
    key = {:ip, RateLimit.ip_key(conn.remote_ip)}

    {count, window_end} = RateLimit.consume(table(), key, limit, @window_ms, now)

    retry_ms = max(1, window_end - now)

    conn
    |> RateLimit.stamp_headers(limit, count, window_end, retry_ms, @bucket)
    |> RateLimit.maybe_limited(count, limit, retry_ms,
      bucket: @bucket,
      key: key,
      scope: :network,
      window_ms: @window_ms
    )
  end

  defp table, do: CytaleWeb.Compat.RateTables.preauth_table()
end
