defmodule CytaleWeb.Compat.RateLimit do
  @moduledoc """
  KTD9 — the Discord rate-limit header set for the compat surface, wrapped
  over the native plug's fixed-window ETS counter algorithm (same semantics,
  own table so the native 429 body never leaks onto the compat prefix).

  This module also owns the ONE shared counter + 429 rendering (`consume/5`,
  `maybe_limited/4`, `decimal_seconds/1`) and the app-wide per-IP bucket key
  (`ip_key/1`): U11's per-webhook execute bucket, the interaction buckets AND
  the native `CytaleWeb.Plugs.RateLimit` run the same algorithm and the same
  per-IP keying over their own tables/keys/limits — KTD9 pins the bucket
  IDENTITIES, never a second implementation.

  Buckets are COARSE: one per route-template + method (major params — the
  channel id — are masked OUT of the bucket string, so `GET
  /channels/{id}/messages` is one bucket across every channel), keyed per
  principal (`{:user, id}` — per-bot isolation is free, exactly like the
  native `:api` bucket; a request with NO principal falls back to its IP).
  Each bucket's LIMIT comes from the route's CLASS (C-2, `classify/1`):
  reaction PUT/DELETE 10/5s, other mutations 25/10s,
  reads 50/10s — config-overridable per class via
  `Cytale.Config.compat_route_class_limits/0`. Discord's full per-route
  matrix is still deliberately not replicated (three classes, not one limit
  per route). Message SENDS skip this plug's buckets: every send route, native
  and compat, shares the one send budget (`CytaleWeb.Plugs.SendBudget`), which
  renders this dialect's headers and 429 for them.

  Every response carries `X-RateLimit-Limit`, `-Remaining`, `-Reset` (epoch
  seconds), `-Reset-After` (seconds, ms-precision decimals), and `-Bucket`
  (a stable hash of the route template — identical across major params and
  across the `/api/v10` and `/api` aliases). An exhausted bucket returns 429
  with `Retry-After` (ceil seconds), `X-RateLimit-Scope: user`, and the
  Discord body `{message, code: 0, retry_after: <float seconds>, global:
  false}` — the `message` NAMES the limit that was hit and whether it is
  account-scoped or shared per IP, and the trip is logged with its bucket,
  key and window (#90), so a lockout explains itself instead of reading as
  "your account is broken".
  """

  @behaviour Plug

  require Logger

  import Plug.Conn

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, opts) do
    # A message SEND is governed by the one send budget every send route
    # shares (`CytaleWeb.Plugs.SendBudget`, which stamps this dialect's
    # headers and 429 for it), not by a route-class bucket.
    if CytaleWeb.SendRoutes.send_route?(conn), do: conn, else: limit(conn, opts)
  end

  defp limit(conn, _opts) do
    template = template(conn.method, conn.path_info)
    {limit, window_ms} = template |> classify() |> class_limit()
    identity = identity(conn)
    key = {template, identity}
    now = now_ms()

    {count, window_end} = consume(table(), key, limit, window_ms, now)
    retry_ms = max(1, window_end - now)
    # ONE digest per request (hardening plan 3.13): the bucket id is on the
    # stamped headers AND the exhaustion log/metric path, and it was being
    # computed twice for every compat request — an MD5 over the route template,
    # which is the cheapest thing here but also pure waste.
    bucket = bucket(template)

    conn
    |> stamp_headers(limit, count, window_end, retry_ms, bucket)
    |> maybe_limited(count, limit, retry_ms,
      bucket: bucket,
      key: key,
      scope: scope(identity),
      window_ms: window_ms
    )
  end

  # -- route classes (KTD9, C-2) ---------------------------------------------------

  # Reaction PUT/DELETE templates: the emoji path segment is non-numeric
  # and stays literal, but a purely-digit emoji masks to `{id}` like every
  # other numeric segment — the infix match below covers both spellings.
  @reaction_route_re ~r{^(?:PUT|DELETE):/channels/\{id\}/messages/\{id\}/reactions(?:/.*)?$}

  @doc """
  Classify a route template into its rate class (C-2):

    * `:message_write` — the message-create POST and every reaction
      PUT/DELETE route (Discord-ish per-route tightness — the spam-prone
      writes): 10 / 5s;
    * `:mutation` — every other non-GET (edits, deletes, typing, ack,
      thread starts, DM opens, command registration): 25 / 10s;
    * `:read` — every GET (including the reaction-user list): 50 / 10s.

  Class limits come from `Cytale.Config.compat_route_class_limits/0`.
  """
  @spec classify(String.t()) :: :message_write | :mutation | :read
  def classify("POST:/channels/{id}/messages"), do: :message_write

  def classify(template) when is_binary(template) do
    cond do
      Regex.match?(@reaction_route_re, template) -> :message_write
      String.starts_with?(template, "GET:") -> :read
      true -> :mutation
    end
  end

  defp class_limit(class) do
    Cytale.Config.compat_route_class_limits() |> Map.fetch!(class)
  end

  # -- route template + bucket identity ------------------------------------------

  @numeric_segment_re ~r/^\d+$/

  @doc """
  Stable route template: `METHOD:/path` with the compat version prefix
  (`api`, `api/v10`, …) dropped and every purely-numeric segment (the major
  params — channel/message ids) masked to `{id}`.
  """
  @spec template(String.t(), [String.t()]) :: String.t()
  def template(method, path_info) when is_binary(method) and is_list(path_info) do
    path = path_info |> drop_version_prefix() |> Enum.map(&mask_numeric/1) |> Enum.join("/")
    "#{method}:/#{path}"
  end

  @doc "The stable `X-RateLimit-Bucket` value for a route template."
  @spec bucket(String.t()) :: String.t()
  def bucket(template), do: Base.encode16(:crypto.hash(:md5, template), case: :lower)

  defp drop_version_prefix(["api" | rest]) do
    case rest do
      ["v" <> _version | tail] -> tail
      _ -> rest
    end
  end

  defp drop_version_prefix(path), do: path

  defp mask_numeric(segment) do
    if Regex.match?(@numeric_segment_re, segment), do: "{id}", else: segment
  end

  # -- counter (the native plug's fixed-window algorithm, own table) -------------

  @doc """
  The shared fixed-window consume — the ONE implementation behind both rate
  buckets (this plug's route-template buckets and U11's per-webhook execute
  bucket; KTD9 pins the identities, not the implementations). One atomic
  `update_counter` hop with an insert-default tuple: the pass/limit decision
  rides the value it RETURNS — a post-hoc count lookup would read other
  requests' increments (observed: three 429s for one 6-burst). The table is
  owned by the long-lived `CytaleWeb.Compat.RateTables` GenServer (app tree)
  — callers only read/write the public named table, never create it.
  """
  @spec consume(:ets.table(), term(), pos_integer(), pos_integer(), integer()) ::
          {pos_integer(), integer()}
  def consume(table, key, limit, window_ms, now) do
    count =
      :ets.update_counter(
        table,
        key,
        # Saturated counters keep reading "over the limit" until the window rolls.
        {2, 1, limit + 1, limit + 1},
        {key, 0, now + window_ms}
      )

    [{_k, _count, window_end}] = :ets.lookup(table, key)

    if now >= window_end do
      :ets.insert(table, {key, 1, now + window_ms})
      {1, now + window_ms}
    else
      {count, window_end}
    end
  end

  defp identity(conn) do
    case conn.assigns[:current_user] do
      %{user_id: id} -> {:user, id}
      _ -> {:ip, ip_key(conn.remote_ip)}
    end
  end

  @doc """
  The per-IP bucket key for a client address (#90). IPv4 keys the exact
  address; IPv6 keys its `/64` PREFIX (tagged `:ip6_64` so it can never
  collide with an IPv4 tuple).

  Why /64 for IPv6: one customer is handed a /64 (often a /56 or /48), so
  per-ADDRESS keying is bypassed for free — rotate the low 64 bits and every
  request is a fresh bucket. The /64 is "a network" in exactly the sense a
  NAT'd IPv4 address is, which is what every per-IP bucket here means
  (the pre-auth dam, the webhook miss dam, the authenticated per-IP
  ceiling). A single prefix sharing one budget is the same trade a NAT
  already makes, and the lever for a large one is the bucket's configured
  limit.
  """
  @spec ip_key(:inet.ip_address() | term()) :: term()
  def ip_key({a, b, c, d})
      when is_integer(a) and is_integer(b) and is_integer(c) and is_integer(d),
      do: {a, b, c, d}

  def ip_key({a, b, c, d, _e, _f, _g, _h}), do: {:ip6_64, a, b, c, d}
  def ip_key(other), do: other

  # The scope phrase the 429 explains itself with, derived from the identity
  # the bucket was actually keyed on (never a scope the request did not have).
  defp scope({:user, _id}), do: :account
  defp scope({:ip, _ip}), do: :network

  defp table, do: CytaleWeb.Compat.RateTables.compat_table()

  # -- 429 shape -------------------------------------------------------------------

  @doc """
  The shared `X-RateLimit-*` header stamp — the ONE definition behind the
  route plug, the per-webhook execute bucket, and the pre-auth IP dam (the
  five headers can never drift between surfaces). `retry_ms` is the caller's
  `max(1, window_end - now)` from the SAME clock read as its `consume/5`, so
  `Reset-After` stays consistent with the 429 body's `retry_after`.
  Remaining derives from `limit - count` exactly as every caller always
  rendered it.
  """
  @spec stamp_headers(Plug.Conn.t(), pos_integer(), integer(), integer(), pos_integer(), String.t()) ::
          Plug.Conn.t()
  def stamp_headers(conn, limit, count, window_end, retry_ms, bucket)
      when is_integer(count) and is_integer(window_end) and is_integer(retry_ms) do
    conn
    |> put_resp_header("x-ratelimit-limit", Integer.to_string(limit))
    |> put_resp_header("x-ratelimit-remaining", Integer.to_string(max(0, limit - count)))
    |> put_resp_header("x-ratelimit-reset", Integer.to_string(div(window_end, 1000)))
    |> put_resp_header("x-ratelimit-reset-after", decimal_seconds(retry_ms))
    |> put_resp_header("x-ratelimit-bucket", bucket)
  end

  @doc """
  The shared 429 rendering: `Retry-After` (ceil seconds), `X-RateLimit-Scope:
  user`, and Discord's `{message, code: 0, retry_after: <float seconds>,
  global: false}` body — halts the conn. Counts at/below the limit pass
  through untouched.

  `opts` carry what the message and the log line need (#90):

    * `:bucket` — the bucket id (the same value as its `X-RateLimit-Bucket`);
    * `:key` — the ETS key, i.e. the identity the bucket was keyed on;
    * `:scope` — `:account` (per-principal), `:network` (per-IP) or a
      surface-specific subject (`:webhook`, `:application`, `:interaction`);
    * `:window_ms` — the bucket's window, so the message can state the rate.

  The 429 says WHICH limit was hit, whether it is account-scoped or a shared
  per-IP one, and the retry hint; the server log names the bucket, key and
  window, so a lockout is diagnosable from the log line alone instead of
  reading as "your account is broken".
  """
  @spec maybe_limited(Plug.Conn.t(), integer(), pos_integer(), pos_integer(), keyword()) ::
          Plug.Conn.t()
  def maybe_limited(conn, count, limit, retry_ms, opts \\ [])

  def maybe_limited(conn, count, limit, retry_ms, opts) when count > limit do
    scope = Keyword.get(opts, :scope, :client)

    Logger.warning(
      "rate limit tripped bucket=#{Keyword.get(opts, :bucket, "unknown")} scope=#{scope} " <>
        "key=#{inspect(Keyword.get(opts, :key, :unknown))} window_ms=#{inspect(Keyword.get(opts, :window_ms))} " <>
        "limit=#{limit} count=#{count} retry_ms=#{retry_ms}"
    )

    conn
    |> put_resp_header("retry-after", Integer.to_string(div(retry_ms + 999, 1000)))
    |> put_resp_header("x-ratelimit-scope", "user")
    |> put_resp_content_type("application/json")
    |> send_resp(
      429,
      Jason.encode!(%{
        "message" => limit_message(scope, limit, Keyword.get(opts, :window_ms), retry_ms),
        "code" => 0,
        "retry_after" => decimal_float(retry_ms),
        "global" => false
      })
    )
    |> halt()
  end

  def maybe_limited(conn, _count, _limit, _retry_ms, _opts), do: conn

  # -- the 429's human sentence (#90) -----------------------------------------------

  @doc """
  The human half of a 429: one sentence naming the limit that was hit, whether
  it is account-scoped or shared across the client IP, and the retry hint. The
  native surface renders it into `{error: {key, code, message}}`, the compat
  surface into Discord's `message` — one definition, so the two surfaces can
  never describe the same trip differently.
  """
  @spec limit_message(atom(), pos_integer(), pos_integer() | nil, pos_integer()) :: String.t()
  def limit_message(:account, limit, window_ms, retry_ms) do
    "Too many requests from this account — the account limit is " <>
      "#{rate(limit, window_ms)}. Try again in #{seconds(retry_ms)}."
  end

  def limit_message(:ip_ceiling, limit, window_ms, retry_ms) do
    "Too many requests from this network — the shared per-IP ceiling is " <>
      "#{rate(limit, window_ms)} and covers every account behind this IP. " <>
      "Try again in #{seconds(retry_ms)}."
  end

  def limit_message(:network, limit, window_ms, retry_ms) do
    "Too many requests from this network — the per-IP limit is " <>
      "#{rate(limit, window_ms)} and is shared by everyone behind this IP. " <>
      "Try again in #{seconds(retry_ms)}."
  end

  def limit_message(:webhook, limit, window_ms, retry_ms) do
    "Too many requests to this webhook — the limit is #{rate(limit, window_ms)}. " <>
      "Try again in #{seconds(retry_ms)}."
  end

  def limit_message(:application, limit, window_ms, retry_ms) do
    "Too many requests for this application — the limit is #{rate(limit, window_ms)}. " <>
      "Try again in #{seconds(retry_ms)}."
  end

  def limit_message(:interaction, limit, window_ms, retry_ms) do
    "Too many requests for this interaction — the limit is #{rate(limit, window_ms)}. " <>
      "Try again in #{seconds(retry_ms)}."
  end

  # The per-account attempt dam (audit S3). Keyed by the ATTEMPTED identifier —
  # which may belong to nobody — so the message must not claim whose account
  # locked, nor a network scope the dam does not have.
  # The one send budget (`CytaleWeb.Plugs.SendBudget`), both surfaces.
  def limit_message(:send_conversation, limit, window_ms, retry_ms) do
    "Too many messages in this conversation — the send limit is #{rate(limit, window_ms)} " <>
      "per sender in one channel or thread. Try again in #{seconds(retry_ms)}."
  end

  def limit_message(:send_principal, limit, window_ms, retry_ms) do
    "Too many messages from this account — the send limit is #{rate(limit, window_ms)} " <>
      "across all conversations. Try again in #{seconds(retry_ms)}."
  end

  def limit_message(:credentials, _limit, _window_ms, retry_ms) do
    "Too many failed attempts — try again in #{seconds(retry_ms)}."
  end

  def limit_message(_client, limit, window_ms, retry_ms) do
    "Too many requests — the limit is #{rate(limit, window_ms)}. " <>
      "Try again in #{seconds(retry_ms)}."
  end

  defp rate(limit, nil), do: "#{limit} per window"

  defp rate(limit, window_ms) when window_ms < 1000, do: "#{limit} per #{window_ms}ms"
  defp rate(limit, window_ms) when window_ms < 60_000, do: "#{limit} per #{div(window_ms, 1000)}s"

  defp rate(limit, window_ms) when window_ms < 3_600_000,
    do: "#{limit} per #{div(window_ms, 60_000)} minutes"

  defp rate(limit, window_ms), do: "#{limit} per #{div(window_ms, 3_600_000)} hours"

  # Whole seconds read as "12 seconds", sub-second windows keep one decimal
  # ("0.4 seconds") — never a bare "0 seconds" hint.
  defp seconds(retry_ms) do
    value = Float.round(max(1, retry_ms) / 1000, 1)

    cond do
      value == 1.0 -> "1 second"
      value == Float.round(value) -> "#{trunc(value)} seconds"
      true -> "#{value} seconds"
    end
  end

  # -- formatting -------------------------------------------------------------------

  @doc "Milliseconds → seconds with ms-precision decimals (X-RateLimit-Reset-After)."
  @spec decimal_seconds(integer()) :: String.t()
  def decimal_seconds(ms), do: ms |> decimal_float() |> Float.to_string()

  defp decimal_float(ms), do: Float.round(ms / 1000, 3)

  defp now_ms, do: System.system_time(:millisecond)
end
