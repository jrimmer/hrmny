defmodule CytaleWeb.Plugs.RateLimit do
  @moduledoc """
  U9 — rate-limit headers + 429s (fixed-window ETS counter, per the resolved
  Open Question), rescoped per #90 so a bucket is keyed on the thing it
  protects.

  Three bucket shapes, one algorithm:

    * **per-ACCOUNT (primary, authenticated)** — the plug runs AFTER
      `CytaleWeb.Plugs.Auth` on the `:api_auth` pipeline, so
      `conn.assigns.current_user` identifies the principal and the bucket is
      `{bucket, {:user, id}}`. A team behind one office NAT gets one budget
      PER ACCOUNT instead of sharing a single 50/10s that 429s the fourth
      person through the door (#90). Per-bot/per-agent isolation is free: an
      agent token is its own principal.
    * **per-IP CEILING (secondary, authenticated)** — behind the account
      bucket, one IP-keyed bucket (`{{bucket, :ip_ceiling}, {:ip, ip}}`,
      `Cytale.Config.rate_limit_ip_ceiling/1`) caps the aggregate, so a single
      IP cannot hammer the surface with a churn of many accounts. It is a
      CEILING, not the budget: it sits far above one account's limit and only
      bites a genuine flood. Its 429 says so.
    * **per-IP (only, unauthenticated)** — the pre-auth `:auth` surface and
      the public invite resolve have no principal to key on, so the per-IP
      bucket stays the ONLY bucket, with the same window and headers it always
      had. THAT dam protects the unauthenticated surface and must not be
      loosened (#90 trap): the account scoping above is ADDITIVE, never a
      replacement for IP-keying the pre-auth surface.

  IPv6 client addresses are keyed by `/64` prefix
  (`CytaleWeb.Compat.RateLimit.ip_key/1`): per-address keying is bypassed for
  free by rotating the low 64 bits, and a /64 is "a network" in exactly the
  sense a NAT'd IPv4 address is.

  Every response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining`,
  `X-RateLimit-Reset-After` for the bucket that governed it; an exhausted
  bucket returns 429 with `Retry-After` and the standard envelope
  (`{error: {key, code, message, scope, retry_after_ms}}`) whose message names
  the limit that was hit, whether it is account-scoped or a shared per-IP
  ceiling, and the retry hint (#90: a bare "slow down" reads as "your account is
  broken"). The same limit rides as DATA for clients to branch on: `scope` in
  the body and the `X-RateLimit-Scope` header — `"account"` for the account
  bucket, `"ip"` for the per-IP bucket and the per-IP ceiling (and, from
  `CytaleWeb.Plugs.SendBudget`, `"conversation"` / `"sender"`). Header values
  always belong to the TRIPPED bucket — a ceiling 429 renders the ceiling's
  limit/remaining, never the account budget's.

  Window semantics: a fixed window per bucket (window_ms, default 10s) with
  the count kept in ETS — cheap, lock-free, and monotone within a window. The
  table is owned by the long-lived `CytaleWeb.Compat.RateTables` GenServer
  (app tree) and swept on its cadence; this plug only reads/writes it. Every
  429 logs `bucket`, `key`, `window_ms`, `limit` and `count`, so an offending
  bucket is identifiable from the log line alone (#90).
  """

  @behaviour Plug

  require Logger

  import Plug.Conn

  alias CytaleWeb.Compat.RateLimit, as: Shared

  # The envelope code for this surface: `status * 100 + 1`, the convention
  # every `/api/v1` controller uses (`CytaleWeb.AuthController.error/4`), so a
  # 429 reads 42901 exactly as a 401 reads 40101.
  @rate_limited_code 42_901

  @impl true
  def init(opts) do
    [
      bucket: Keyword.fetch!(opts, :bucket),
      limit: Keyword.fetch!(opts, :limit),
      window_ms: Keyword.get(opts, :window_ms, 10_000)
    ]
  end

  @impl true
  def call(conn, bucket: bucket, limit: limit, window_ms: window_ms) do
    # Per-bucket runtime override (`config :cytale, :rate_limit_overrides`):
    # the hermetic suite raises the shared-IP buckets (127.0.0.1 carries
    # every async test), and ops can tune a bucket without a rebuild. The
    # compile-time limit stays the default; the override only widens or
    # narrows the same bucket.
    limit = Keyword.get(overrides(), bucket, limit)
    identity = identity(conn)
    key = {bucket, identity}
    now = now_ms()

    if send_by_account?(conn, identity) do
      # A message SEND is governed by the one send budget every send route
      # shares (`CytaleWeb.Plugs.SendBudget` — per sender, human or bot,
      # native or compat), not by this account's general request budget; the
      # per-IP ceiling still applies.
      ip_ceiling(conn, bucket, identity, window_ms, now)
    else
      {count, window_end} = consume(key, limit, window_ms, now)

      if count > limit do
        refuse(
          conn,
          %{
            key: key,
            scope: scope(identity),
            wire_scope: wire_scope(identity),
            limit: limit,
            window_ms: window_ms,
            count: count,
            window_end: window_end
          },
          now
        )
      else
        conn
        |> stamp_headers(limit, count, window_end, now)
        |> ip_ceiling(bucket, identity, window_ms, now)
      end
    end
  end

  defp send_by_account?(conn, {:user, _id}), do: CytaleWeb.SendRoutes.send_route?(conn)
  defp send_by_account?(_conn, _identity), do: false

  # -- the secondary per-IP ceiling (authenticated requests only) ----------------

  # Only a request WITH a principal gets a ceiling: its whole purpose is to
  # stop one IP from multiplying itself through many accounts. An
  # unauthenticated request's PRIMARY bucket is already the per-IP bucket, so a
  # second IP-keyed bucket would double-count it — and changing the pre-auth
  # surface's keying is precisely what #90 forbids.
  defp ip_ceiling(conn, _bucket, {:ip, _ip}, _window_ms, _now), do: conn

  defp ip_ceiling(conn, bucket, _identity, window_ms, now) do
    ceiling = Cytale.Config.rate_limit_ip_ceiling(bucket)
    key = {{bucket, :ip_ceiling}, {:ip, Shared.ip_key(conn.remote_ip)}}

    {count, window_end} = consume(key, ceiling, window_ms, now)

    if count > ceiling do
      refuse(
        conn,
        %{
          key: key,
          scope: :ip_ceiling,
          wire_scope: "ip",
          limit: ceiling,
          window_ms: window_ms,
          count: count,
          window_end: window_end
        },
        now
      )
    else
      conn
    end
  end

  # -- refusal -----------------------------------------------------------------

  # The one 429 rendering: the surface's standard envelope, `Retry-After` in
  # ceil seconds, and a message that says WHICH limit was hit and whether it is
  # account-scoped or shared per IP — the user-facing half of #90. The limit is
  # also DATA (`scope` in the body and `X-RateLimit-Scope`), so a client decides
  # what to hold without reading the sentence. The headers are the TRIPPED
  # bucket's, so `X-RateLimit-Limit` can never describe a budget this request
  # was not actually measured against.
  @doc false
  # Public for `CytaleWeb.Plugs.SendBudget`: the native dialect's 429 for a
  # bucket that plug keeps, rendered by the one native refusal. `tripped`
  # carries the bucket's `key`, `scope` (the message and log atom),
  # `wire_scope` (the client-facing string), `limit`, `window_ms`, `count`
  # and `window_end`.
  def refuse(conn, tripped, now) do
    %{key: key, scope: scope, wire_scope: wire_scope, limit: limit, window_ms: window_ms} = tripped
    %{count: count, window_end: window_end} = tripped
    retry_ms = max(1, window_end - now)

    Logger.warning(
      "rate limit tripped bucket=#{bucket_name(key)} scope=#{Atom.to_string(scope)} key=#{inspect(key)} " <>
        "window_ms=#{window_ms} limit=#{limit} count=#{count} retry_ms=#{retry_ms}"
    )

    conn
    |> stamp_headers(limit, count, window_end, now)
    |> put_resp_header("retry-after", Integer.to_string(retry_seconds(retry_ms)))
    |> put_resp_header("x-ratelimit-scope", wire_scope)
    |> put_resp_content_type("application/json")
    |> send_resp(
      429,
      Jason.encode!(%{
        "error" => %{
          "key" => "rate_limited",
          "code" => @rate_limited_code,
          "message" => Shared.limit_message(scope, limit, window_ms, retry_ms),
          "scope" => wire_scope,
          "retry_after_ms" => retry_ms
        }
      })
    )
    |> halt()
  end

  defp bucket_name({{bucket, :ip_ceiling}, _identity}), do: "#{bucket}_ip_ceiling"
  defp bucket_name({bucket, _identity}), do: Atom.to_string(bucket)

  # `:account` when the request carried a principal, `:network` when its own
  # bucket is the IP bucket (the pre-auth `:auth` surface, the public invite
  # resolve) — the message must never claim an account scope it did not have.
  defp scope({:user, _id}), do: :account
  defp scope({:ip, _ip}), do: :network

  # The same distinction as data: the `scope` a client branches on.
  defp wire_scope({:user, _id}), do: "account"
  defp wire_scope({:ip, _ip}), do: "ip"

  defp retry_seconds(retry_ms), do: max(1, div(retry_ms + 999, 1000))

  @doc false
  # Public for `CytaleWeb.Plugs.SendBudget` (the native header set).
  def stamp_headers(conn, limit, count, window_end, now) do
    conn
    |> put_resp_header("x-ratelimit-limit", Integer.to_string(limit))
    |> put_resp_header("x-ratelimit-remaining", Integer.to_string(max(0, limit - count)))
    |> put_resp_header("x-ratelimit-reset-after", Integer.to_string(max(0, div(window_end - now, 1000))))
  end

  # -- counter -----------------------------------------------------------------

  defp overrides, do: Application.get_env(:cytale, :rate_limit_overrides, [])

  # Single atomic consume: increments the window's counter, rolling the
  # window when expired.
  @doc false
  # Public for `CytaleWeb.Plugs.SendBudget`: the same counter, the same table.
  def consume(key, limit, window_ms, now) do
    :ets.update_counter(
      table(),
      key,
      # increment by 1, initialized to 0; wrap the window in the same entry
      [{2, 1, limit + 1, limit + 1}],
      {key, 0, now + window_ms}
    )

    [{_k, count, window_end}] = :ets.lookup(table(), key)

    if now >= window_end do
      # window rolled: reset
      :ets.insert(table(), {key, 1, now + window_ms})
      {1, now + window_ms}
    else
      {count, window_end}
    end
  end

  defp identity(conn) do
    case conn.assigns[:current_user] do
      %{user_id: id} -> {:user, id}
      _ -> {:ip, Shared.ip_key(conn.remote_ip)}
    end
  end

  # The bucket table is OWNED by the long-lived `CytaleWeb.Compat.RateTables`
  # GenServer (app supervision tree) and swept there, exactly like the compat
  # tables. This plug only reads/writes the public named table: a lazily
  # created one would belong to whichever request process arrived first, and
  # every counter would reset when that process (or its keep-alive connection)
  # ended — no budget could accumulate, so whether a 429 fired at all depended
  # on connection reuse (#90).
  defp table, do: CytaleWeb.Compat.RateTables.native_table()

  defp now_ms, do: System.system_time(:millisecond)
end
