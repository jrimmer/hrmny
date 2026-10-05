import Config

# ----- Fail-fast environment validation ---------------------------------------
# Everything here runs once at boot (mix phx.server / release start) and raises
# loudly rather than letting the node come up misconfigured.

defmodule CytaleRuntime do
  @moduledoc false

  def require_secret!(key) do
    val = System.get_env(key)

    if is_binary(val) and byte_size(val) >= 32 do
      val
    else
      raise ArgumentError,
            "environment variable #{key} must be set to a string of at least 32 characters"
    end
  end

  def worker_id!(key \\ "SNOWFLAKE_WORKER_ID") do
    raw = System.get_env(key)
    id = fetch_int!(key, 0)

    if id in 0..1023 do
      id
    else
      raise ArgumentError,
            "environment variable #{key} must be an integer between 0 and 1023 " <>
              "(got: #{inspect(raw)})"
    end
  end

  # The VAPID private key for web push, base64url (what `mix
  # web_push_ex.vapid` emits). It is a 32-byte P-256 scalar, so the 32-CHARACTER
  # floor `require_secret!/1` applies to other secrets is wrong here — the
  # right check is that it DECODES to exactly 32 bytes, since a malformed key
  # otherwise fails at the first send rather than at boot.
  def vapid_private_key!(key \\ "CYTALE_VAPID_PRIVATE_KEY") do
    case System.get_env(key) do
      nil ->
        nil

      value ->
        case Base.url_decode64(value, padding: false) do
          {:ok, raw} when byte_size(raw) == 32 ->
            value

          _ ->
            raise ArgumentError,
                  "environment variable #{key} must be a base64url-encoded 32-byte P-256 " <>
                    "scalar (generate one with `mix web_push_ex.vapid`)"
        end
    end
  end

  def parse_int!(key, default), do: fetch_int!(key, default)

  # Trimmed env read for the OIDC bootstrap keys: absent or blank → nil, so
  # "configured-empty" behaves exactly like "not configured" (Cytale.Config's
  # `present/1` normalization gives the file-side keys the same rule).
  def env_trim(key) do
    case System.get_env(key) do
      nil ->
        nil

      value ->
        case String.trim(value) do
          "" -> nil
          trimmed -> trimmed
        end
    end
  end

  # Strict-ish bool: absent → default; otherwise "true"/"false" (case- and
  # whitespace-insensitive). Anything else raises — a registration gate that
  # silently defaults on a typo is worse than a loud boot failure.
  def parse_bool!(key, default) do
    case System.get_env(key) do
      nil ->
        default

      value ->
        case String.trim(value) |> String.downcase() do
          "true" ->
            true

          "false" ->
            false

          other ->
            raise ArgumentError,
                  "environment variable #{key} must be \"true\" or \"false\" (got: #{inspect(other)})"
        end
    end
  end

  # Commit interval clamped into [100, 2000] ms (resolved decision, plan §Key
  # Technical Decisions). Out-of-range values clamp instead of raising so a
  # typo can never wedge search freshness entirely.
  def clamp_interval!(key, ms),
    do: key |> fetch_int!(ms) |> max(100) |> min(2000)

  # "FIRST-LAST" (e.g. "50000-50999") → {first, last}; absent → default.
  # Inverted or out-of-range values raise loudly — a silently swapped range
  # would mis-size the UDP span the app container publishes (voice plan KTD2).
  def parse_port_range!(key, default) do
    case System.get_env(key) do
      nil ->
        default

      value ->
        case String.trim(value) |> String.split("-", trim: true) do
          [first, last] ->
            with {f, ""} <- Integer.parse(first),
                 {l, ""} <- Integer.parse(last),
                 {:ok, range} <- validate_port_range(f, l) do
              range
            else
              _ ->
                raise ArgumentError,
                      "environment variable #{key} must be a port range \"FIRST-LAST\" " <>
                        "with 1 <= FIRST <= LAST <= 65535, e.g. \"50000-50999\" (got: #{inspect(value)})"
            end

          _ ->
            raise ArgumentError,
                  "environment variable #{key} must be a port range \"FIRST-LAST\", " <>
                    "e.g. \"50000-50999\" (got: #{inspect(value)})"
        end
    end
  end

  # ICE servers for the media plane from the CYTALE_TURN_* trio (eturnal,
  # KTD2). All blank/absent → [] (host candidates only — the loopback dev
  # default). All set → one TURN entry. PARTIALLY set → raise: a TURN server
  # with missing credentials would fail every allocation at call time, which
  # must surface at boot instead (house fail-fast).
  def turn_servers!(url, username, credential) do
    case {blank_to_nil(url), blank_to_nil(username), blank_to_nil(credential)} do
      {nil, nil, nil} ->
        []

      {u, n, c} when is_binary(u) and is_binary(n) and is_binary(c) ->
        [%{urls: u, username: n, credential: c}]

      {u, n, c} ->
        raise ArgumentError,
              "CYTALE_TURN_URL / CYTALE_TURN_USERNAME / CYTALE_TURN_CREDENTIAL must be set " <>
                "together to enable TURN (got: url=#{inspect(u)}, username: #{set_unset(n)}, " <>
                "credential: #{set_unset(c)})"
    end
  end

  # Credential material NEVER rides an exception message (turn_auth!'s
  # "secret: set" redaction precedent) — set/unset markers only.
  defp set_unset(nil), do: "unset"

  defp set_unset(_value), do: "set"

  # Ephemeral-credential TURN (voice plan U12, eturnal REST-auth):
  # CYTALE_TURN_URL + CYTALE_TURN_SECRET together select the SECRET mode —
  # Cytale.Config.calls_ice_servers/0 then mints short-lived pairs
  # (username = unix expiry, credential = HMAC-SHA1 of the secret) instead of
  # shipping a static password. Returns nil unless the mode is fully set;
  # partial or AMBIGUOUS configurations (secret mixed with the static trio's
  # username/credential) raise at boot — the operator must pick one mode.
  def turn_auth!(url, secret, username, credential) do
    case {blank_to_nil(url), blank_to_nil(secret), blank_to_nil(username), blank_to_nil(credential)} do
      # Secret unset → secret mode off, whatever the static trio holds (its
      # own all-or-nothing validation lives in turn_servers!/3 above).
      {_u, nil, _n, _c} ->
        nil

      # The secret signs every minted TURN credential (and is eturnal's
      # ETURNAL_SECRET verifier): the same >= 32-character floor as the app
      # secrets (`require_secret!/1`). Its value never rides the message.
      {u, s, nil, nil} when is_binary(u) and is_binary(s) and byte_size(s) < 32 ->
        raise ArgumentError,
              "CYTALE_TURN_SECRET (compose: ETURNAL_SECRET) must be at least 32 characters " <>
                "(got #{byte_size(s)}; generate one with `openssl rand -base64 32`)"

      {u, s, nil, nil} when is_binary(u) and is_binary(s) ->
        %{url: u, secret: s}

      {u, s, n, c} when is_binary(s) ->
        if is_binary(u) do
          raise ArgumentError,
                "CYTALE_TURN_SECRET selects ephemeral (REST-auth) TURN credentials and must " <>
                  "NOT be combined with CYTALE_TURN_USERNAME / CYTALE_TURN_CREDENTIAL " <>
                  "(static credentials) — pick one mode (got: url=#{inspect(u)}, secret: set, " <>
                  "username=#{inspect(n)}, credential=#{inspect(c)})"
        else
          raise ArgumentError,
                "CYTALE_TURN_SECRET requires CYTALE_TURN_URL to be set together (the URL " <>
                  "names the eturnal TURN server clients allocate on; got: url=#{inspect(u)}, " <>
                  "username=#{inspect(n)}, credential=#{inspect(c)})"
        end
    end
  end

  defp validate_port_range(first, last)
       when is_integer(first) and is_integer(last) and first >= 1 and last >= first and
              last <= 65_535,
       do: {:ok, {first, last}}

  defp validate_port_range(_first, _last),
    do: :error

  defp blank_to_nil(nil), do: nil

  defp blank_to_nil(value) do
    case String.trim(value) do
      "" -> nil
      trimmed -> trimmed
    end
  end

  defp fetch_int!(key, default) do
    case System.get_env(key) do
      nil ->
        default

      value ->
        case Integer.parse(String.trim(value)) do
          {int, ""} ->
            int

          _ ->
            raise ArgumentError,
                  "environment variable #{key} must be an integer (got: #{inspect(value)})"
        end
    end
  end

  # Absolute path to an OpenSSH binary: the env override when set, otherwise
  # whatever the host's PATH resolves (falling back to the conventional
  # absolute path so a release with an empty PATH still names a usable
  # default). Consumed by U1's interop gate, which must be able to fail with a
  # named reason rather than guessing where sshd lives.
  def openssh_bin!(key, program, fallback) do
    case System.get_env(key) do
      nil ->
        System.find_executable(program) || fallback

      value ->
        case String.trim(value) do
          "" -> System.find_executable(program) || fallback
          trimmed -> Path.expand(trimmed)
        end
    end
  end
end

# ----- Dev port override (soak/parallel instances) ------------------------------

if config_env() == :dev do
  # dev.exs pins 4000; a caller-provided PORT relocates the instance (the
  # soak harness runs an isolated server beside the interactive one).
  if port_env = System.get_env("PORT") do
    config :cytale, CytaleWeb.Endpoint, http: [port: CytaleRuntime.parse_int!("PORT", 4000)]
  end

  # ...and CYTALE_DEV_KEYSPACE gives that instance its OWN keyspace, so a
  # throwaway stack (scripts/e2e-live.sh) can never write into the dev
  # database's `cytale` keyspace on a node it shares. Dev-only: a release
  # keeps its one keyspace.
  if dev_keyspace = System.get_env("CYTALE_DEV_KEYSPACE") do
    unless dev_keyspace =~ ~r/\A[a-z][a-z0-9_]{0,47}\z/ do
      raise ArgumentError,
            "CYTALE_DEV_KEYSPACE must be a lowercase CQL identifier of at most 48 characters " <>
              "(got: #{inspect(dev_keyspace)})"
    end

    config :cytale, Cytale.Config, scylla_keyspace: dev_keyspace
  end

  # CYTALE_DEV_LIFT_SEND_BUDGET=1 lifts the per-conversation/per-principal SEND
  # budget (`Cytale.Config.send_budget/0`, 10 and 20 per 5s) the same way
  # config/test.exs does, for that throwaway stack: its specs seed dozens of
  # rows over the API in a burst to set a scene, far past a person's pace.
  # Every request-rate bucket stays production-shaped. Dev-only.
  if System.get_env("CYTALE_DEV_LIFT_SEND_BUDGET") in ["1", "true"] do
    config :cytale, send_budget: [conversation: {1_000_000, 5_000}, principal: {1_000_000, 5_000}]
  end
end

# ----- Web push (notifications plan U6) ----------------------------------------
# Signing needs BOTH halves, so they are configured together and read together:
# a private key with no public key signs nothing, and a public key with no
# private key cannot be checked. Neither alone is a useful state.
#
# ABSENT KEYS MEAN PUSH STAYS OFF, not that the node fails to boot. A deploy
# that has not generated keys has no push subscriptions to serve, so refusing
# to start would be a boot loop over an unused feature. Providing the private
# key is the entire deploy step: it turns the real sender on.
#
# H-8: NO keypair is committed here any more. The development pair lives in
# config/dev.exs (the suite pins its own explicit copy in config/test.exs);
# this block applies the CYTALE_VAPID_* environment overrides — in any
# environment, per half — over whatever the config files set. A prod boot
# therefore stays nil-unless-env, with push off.
env_vapid_public = System.get_env("CYTALE_VAPID_PUBLIC_KEY")
env_vapid_private = CytaleRuntime.vapid_private_key!()

configured_vapid = Application.get_env(:web_push_ex, :vapid, [])

vapid_public = env_vapid_public || Keyword.get(configured_vapid, :public_key)
vapid_private = env_vapid_private || Keyword.get(configured_vapid, :private_key)

if vapid_public && vapid_private do
  config :web_push_ex, :vapid,
    private_key: vapid_private,
    public_key: vapid_public,
    subject:
      System.get_env("CYTALE_VAPID_SUBJECT") ||
        Keyword.get(configured_vapid, :subject) ||
        "mailto:admin@localhost"

  # The sender, switched on only when it can actually sign.
  config :cytale, Cytale.Notifications.Delivery, Cytale.Notifications.Delivery.Push
end

# ----- Secrets (fail-fast) -----------------------------------------------------

if config_env() == :prod do
  secret_key_base = CytaleRuntime.require_secret!("SECRET_KEY_BASE")

  config :cytale, CytaleWeb.Endpoint,
    server: true,
    secret_key_base: secret_key_base,
    http: [port: CytaleRuntime.parse_int!("PORT", 4000)]
end

# ----- External origin (C-5b) ---------------------------------------------------
# nil (unset/empty) keeps the conn-derived behavior; deployments behind a
# proxy with a different public origin set CYTALE_EXTERNAL_BASE_URL (absolute
# origin: scheme + host + optional port, NO path) so every externally-
# constructed URL (gateway bootstrap/resume, webhook capability URLs)
# advertises the public origin. Consumed via Cytale.Config.external_base_url/0.

external_base_url =
  case System.get_env("CYTALE_EXTERNAL_BASE_URL") do
    nil ->
      nil

    url ->
      case String.trim(url) do
        "" -> nil
        trimmed -> trimmed
      end
  end

config :cytale, external_base_url: external_base_url

# ----- Attachment storage root --------------------------------------------------
# Container deploys mount a volume at /app/priv/attachments and set this;
# unset (dev, plain release) keeps the release's own priv/attachments.
# See Cytale.Config.attachments_root/0 — the volume is what makes uploads
# survive `docker compose up -d`.

attachments_root =
  case System.get_env("CYTALE_ATTACHMENTS_ROOT") do
    nil -> nil
    "" -> nil
    root -> root
  end

config :cytale, :attachments_root, attachments_root

# ----- Media proxy ---------------------------------------------------------------
# External embed images and Markdown images are fetched by the server and served
# from our origin (the CSP's `img-src 'self'` never admits a third-party host).
# See Cytale.MediaProxy and docs/self-hosting.md ("Media proxy"). Only the variables an
# operator SET are written, and Config deep-merges keyword lists, so every
# other knob keeps its config.exs / Cytale.Config default.

media_proxy_env =
  [
    enabled: {"CYTALE_MEDIA_PROXY_ENABLED", :bool},
    max_bytes: {"CYTALE_MEDIA_PROXY_MAX_BYTES", :int},
    cache_max_bytes: {"CYTALE_MEDIA_PROXY_CACHE_MAX_BYTES", :int},
    cache_ttl_seconds: {"CYTALE_MEDIA_PROXY_CACHE_TTL_SECONDS", :int},
    cache_dir: {"CYTALE_MEDIA_PROXY_CACHE_DIR", :string}
  ]
  |> Enum.flat_map(fn {key, {var, kind}} ->
    case {CytaleRuntime.env_trim(var), kind} do
      {nil, _} -> []
      {_, :bool} -> [{key, CytaleRuntime.parse_bool!(var, true)}]
      {_, :int} -> [{key, CytaleRuntime.parse_int!(var, 0)}]
      {value, :string} -> [{key, value}]
    end
  end)

if media_proxy_env != [] do
  config :cytale, :media_proxy, media_proxy_env
end

# ----- CORS (first-party cross-origin clients) ----------------------------------
# Comma-separated EXACT origins allowed to call the API cross-origin, for
# browser clients this server does not host. The deployed web client is
# same-origin and unaffected. Defaults to the Tauri desktop shell origins
# (`tauri://localhost` on macOS/Linux, `http://tauri.localhost` on Windows);
# set the variable to replace the list wholesale. `*` is never honored.
# Consumed via Cytale.Config.cors_allowed_origins/0.

cors_allowed_origins =
  case System.get_env("CYTALE_CORS_ALLOWED_ORIGINS") do
    nil -> ["tauri://localhost", "http://tauri.localhost"]
    value -> value |> String.split(",", trim: true) |> Enum.map(&String.trim/1)
  end

config :cytale, :cors, allowed_origins: cors_allowed_origins

# ----- Trusted reverse proxies (security Tier 2 #1) -----------------------------
# Comma-separated CIDRs whose X-Forwarded-For the app believes when deriving
# the client address every per-IP rate limit keys on (CytaleWeb.Plugs.RemoteIp).
# Unset = loopback + the private ranges (the compose network Caddy proxies
# from is always inside them; port 4000 is never published). Set it EMPTY to
# ignore X-Forwarded-For entirely (app exposed with no proxy in front). A bad
# entry fails the boot. Consumed via Cytale.Config.trusted_proxies/0.

case System.get_env("CYTALE_TRUSTED_PROXIES") do
  nil ->
    :ok

  value ->
    cidrs = value |> String.split(",", trim: true) |> Enum.map(&String.trim/1)

    Enum.each(cidrs, fn cidr ->
      [addr | prefix] = String.split(cidr, "/", parts: 2)

      valid? =
        match?({:ok, _}, :inet.parse_strict_address(String.to_charlist(addr))) and
          Enum.all?(prefix, &match?({n, ""} when n in 0..128, Integer.parse(&1)))

      unless valid? do
        raise ArgumentError, "CYTALE_TRUSTED_PROXIES: invalid CIDR #{inspect(cidr)}"
      end
    end)

    config :cytale, trusted_proxies: cidrs
end

# ----- Registration gate --------------------------------------------------------
# CYTALE_REGISTRATION_OPEN closes POST /api/v1/auth/register to everyone WITHOUT
# a valid invite — the single-node operator's invite-only switch (checked before
# any validation; a body carrying a live `invite_code` still registers and joins
# that workspace — see CytaleWeb.AuthController.register/2). Default: CLOSED in
# prod (security Tier 2 #5: invite-only until a mailer exists — with the Dev
# mailer nobody can verify an email, so open sign-up is a spam door), open in
# dev/test. NOTE: once /etc/cytale/config.json exists its `registration_open`
# wins over this variable (config.json > env > default).

config :cytale,
  registration_open: CytaleRuntime.parse_bool!("CYTALE_REGISTRATION_OPEN", config_env() != :prod)

# CYTALE_REQUIRE_VERIFIED=false (default true) lifts the view-only gate on
# accounts with unverified emails — the escape hatch for deploys with no
# working mailer adapter (Dev mailer never sends). Fail-safe default: on.
config :cytale, require_verified_email: CytaleRuntime.parse_bool!("CYTALE_REQUIRE_VERIFIED", true)

# ----- WebAuthn passkeys (ticket #36) -------------------------------------------
# CYTALE_AUTH_PASSKEYS opts the deploy's sign-in surface into passkeys
# (default TRUE, owner 2026-09-14). Enrollment BAKES the RP ID into
# credentials, so the surface additionally requires a derivable RP ID —
# external origin configured (or the explicit RP-ID override); a deploy with
# neither keeps passkeys hidden regardless of the switch. RP ID and origins
# derive from CYTALE_EXTERNAL_BASE_URL unless pinned explicitly:
#   * CYTALE_WEBAUTHN_RP_ID — the registrable domain WITHOUT scheme/port
#     (e.g. chat.example.com); only for a parent-domain passkey scope.
#   * CYTALE_WEBAUTHN_ORIGINS — comma-separated EXACT origins the browser may
#     put in clientDataJSON (the unicode-serialized origin, e.g.
#     https://chat.example.com — no trailing slash, no path).
# Consumed via Cytale.Accounts.WebAuthn.{enabled?, rp_id, origins}/0.

webauthn_rp_id =
  case System.get_env("CYTALE_WEBAUTHN_RP_ID") do
    nil -> nil
    "" -> nil
    id -> String.trim(id)
  end

webauthn_origins =
  case System.get_env("CYTALE_WEBAUTHN_ORIGINS") do
    nil -> nil
    "" -> nil
    value -> value |> String.split(",", trim: true) |> Enum.map(&String.trim/1)
  end

# Applied only when the operator actually set one of the three variables:
# runtime.exs runs in EVERY env (after dev.exs/test.exs), and an unconditional
# write would clobber the profile defaults (dev opts in; the hermetic suite
# pins a fixed RP config for the ceremony fixtures). With nothing set, the
# safe defaults stand: disabled, RP ID/origins derived.
if System.get_env("CYTALE_AUTH_PASSKEYS") != nil or webauthn_rp_id != nil or webauthn_origins != nil do
  config :cytale, :webauthn,
    enabled: CytaleRuntime.parse_bool!("CYTALE_AUTH_PASSKEYS", true),
    rp_id: webauthn_rp_id,
    origins: webauthn_origins
end

# ----- Instance OIDC federated sign-in (ticket #12) -------------------------------
# ENV is the BOOTSTRAP source for the OIDC block (file > env > default per the
# ServerConfig load order — an operator may configure entirely through env, or
# seed env once and let the first boot's generated config.json take over):
#
#   CYTALE_OIDC_ENABLED        (bool, default false)
#   CYTALE_OIDC_ISSUER_URL     (e.g. https://idp.example.com/realms/main)
#   CYTALE_OIDC_CLIENT_ID
#   CYTALE_OIDC_SCOPES         (default "openid email profile")
#   CYTALE_OIDC_BUTTON_LABEL   (default "Sign in with SSO")
#
# The CLIENT SECRET is NOT here: it is a secrets.json key
# (`oidc_client_secret`) with the same env fallback name
# CYTALE_OIDC_CLIENT_SECRET, read at ceremony time via ServerConfig.secret/1 —
# never in the editable document, never GET-served (#121's secret pattern).
# Everything above is runtime-scoped, so a Server Settings save hot-applies.
# Applied only when at least one variable is set (the webauthn rule: an
# unconditional write would clobber the profile defaults in every env).

oidc_issuer = CytaleRuntime.env_trim("CYTALE_OIDC_ISSUER_URL")
oidc_client = CytaleRuntime.env_trim("CYTALE_OIDC_CLIENT_ID")
oidc_scopes = CytaleRuntime.env_trim("CYTALE_OIDC_SCOPES")
oidc_label = CytaleRuntime.env_trim("CYTALE_OIDC_BUTTON_LABEL")
oidc_enabled_env = System.get_env("CYTALE_OIDC_ENABLED")

if oidc_issuer != nil or oidc_client != nil or oidc_scopes != nil or oidc_label != nil or
     oidc_enabled_env != nil do
  config :cytale, :oidc,
    enabled: CytaleRuntime.parse_bool!("CYTALE_OIDC_ENABLED", false),
    issuer_url: oidc_issuer,
    client_id: oidc_client,
    scopes: oidc_scopes,
    button_label: oidc_label
end

# ----- Snowflake worker ID (validated 0..1023; single-node launch uses 0) ------

config :cytale, Cytale.Config, snowflake_worker_id: CytaleRuntime.worker_id!()

# ----- ScyllaDB cluster connection (U6) -----------------------------------------
# Contact points are env-driven (CYTALE_SCYLLA_NODES, legacy SCYLLA_NODES);
# the pool itself starts async (Cytale.Repo) so a boot without a reachable
# ScyllaDB surfaces the error on first query instead of wedging the tree.
# PERF-12: the pool default scales with the node — one connection per
# scheduler keeps every scheduler able to run a query — with a floor of 10 so
# a small box (2-4 schedulers) still hides statement latency; SCYLLA_POOL_SIZE
# pins it explicitly.

nodes =
  (System.get_env("CYTALE_SCYLLA_NODES") || System.get_env("SCYLLA_NODES") || "127.0.0.1:9042")
  |> String.split(",", trim: true)
  |> Enum.map(&String.trim/1)
  |> Enum.map(&String.to_charlist/1)

config :cytale, Cytale.Config,
  scylla_nodes: nodes,
  scylla_default_consistency: :local_quorum,
  scylla_pool_size: CytaleRuntime.parse_int!("SCYLLA_POOL_SIZE", max(:erlang.system_info(:schedulers_online), 10)),
  # Hardening R-7: transient read failures retry this many times inside the
  # Repo before surfacing (0 disables). Writes are never retried.
  repo_read_retries: CytaleRuntime.parse_int!("CYTALE_REPO_READ_RETRIES", 2)

# ----- Schema lifecycle at boot ---------------------------------------------------
# Dev boots always apply+verify (dev.exs sets the flag). For :prod the
# portable single-node deploy (Docker, docs/self-hosting.md) sets
# CYTALE_APPLY_SCHEMA_ON_BOOT=true so a fresh container converges its own
# keyspace on first boot; the default stays false so an existing deployment
# that applies the schema out-of-band keeps its current behavior.

if config_env() == :prod do
  config :cytale,
    apply_scylla_schema_on_boot: CytaleRuntime.parse_bool!("CYTALE_APPLY_SCHEMA_ON_BOOT", false)
end

# ----- Search index root + batched commit window -------------------------------

search_root = System.get_env("SEARCH_INDEX_ROOT")

config :cytale, Cytale.Config,
  search_index_root: if(is_binary(search_root), do: Path.expand(search_root), else: Path.expand("priv/search")),
  search_commit_interval_ms: CytaleRuntime.clamp_interval!("SEARCH_COMMIT_INTERVAL_MS", 500)

# ----- Gateway socket memory bound (#52) ---------------------------------------
# Per-session socket heap cap in BYTES. A stalled client's backlog is bounded
# by this instead of by the box's RAM: the socket is killed and the client
# re-establishes. ~16 MB default (a healthy session holds ~100 KB).
gateway_socket_max_heap_bytes =
  CytaleRuntime.parse_int!("GATEWAY_SOCKET_MAX_HEAP_BYTES", 16 * 1024 * 1024)

# Written to the scope AND key that `Cytale.Config.gateway_socket_max_heap_bytes/0`
# reads. It previously went to `config :cytale, gateway: [socket_max_heap_bytes: n]`
# — a different scope and a different key name — so the accessor never saw it:
# the env var was inert, `.env.example` documented a knob that did nothing, and
# every socket kept the 16 MB compile-time default however the operator set it.
# (The nested `:gateway` scope is legitimate and still used by the resume-window
# keys below; the defect was this key's scope/name pairing, not the style.)
config :cytale, Cytale.Config, gateway_socket_max_heap_bytes: gateway_socket_max_heap_bytes

# No boot-time read-back here: writes made by this file are not visible to
# Application.get_env until it finishes evaluating (verified 2026-09-20 — at
# this point in the file even `snowflake_worker_id`, written ~45 lines earlier,
# reads back nil, so asserting the write from here would raise on every boot).
# The wiring is guarded instead by
# `GatewaySocketHeapTest."runtime.exs writes the cap where the accessor reads it"`,
# a textual scope/key check that would have caught the original bug, and the fix
# is proven end to end by
# `GATEWAY_SOCKET_MAX_HEAP_BYTES=8388608 mix run -e '...gateway_socket_max_heap_bytes()'`
# returning 8388608.

# ----- Gateway resume window ---------------------------------------------------
# Target of 5 minutes with a hard floor of 10 minutes (U10 session lifecycle).
resume_target_ms = CytaleRuntime.parse_int!("GATEWAY_RESUME_TARGET_MS", 5 * 60 * 1000)
resume_floor_ms = CytaleRuntime.parse_int!("GATEWAY_RESUME_FLOOR_MS", 10 * 60 * 1000)

config :cytale,
  gateway: [
    resume_window_target_ms: resume_target_ms,
    resume_window_floor_ms: resume_floor_ms
  ]

# ----- Auth (U8) — secrets fail-fast in prod, env defaults elsewhere ------------
# AUTH_JWT_SECRET / AUTH_REFRESH_PEPPER have NO default in :prod: booting prod
# without them is a misconfiguration that would silently sign forgeable tokens.
# Both require >= 32 chars (S-P2-15 — a 1-char HS256 secret used to boot).
# Dev/test get obviously-fake defaults from config/{dev,test}.exs.
{auth_jwt_secret, auth_refresh_pepper} =
  if config_env() == :prod do
    {CytaleRuntime.require_secret!("AUTH_JWT_SECRET"), CytaleRuntime.require_secret!("AUTH_REFRESH_PEPPER")}
  else
    {nil, nil}
  end

access_ttl_ms = CytaleRuntime.parse_int!("AUTH_ACCESS_TOKEN_TTL_MS", 15 * 60 * 1000)
refresh_ttl_ms = CytaleRuntime.parse_int!("AUTH_REFRESH_TOKEN_TTL_MS", 30 * 24 * 60 * 60 * 1000)

auth_config =
  [access_token_ttl_ms: access_ttl_ms, refresh_token_ttl_ms: refresh_ttl_ms] ++
    if is_binary(auth_jwt_secret),
      do: [jwt_secret: auth_jwt_secret, refresh_pepper: auth_refresh_pepper],
      else: []

config :cytale, auth: auth_config

# ----- SSH certificate authority (U1) -------------------------------------------
# The CA's ed25519 signing key is provisioned by an OPERATOR at a PATH
# (CYTALE_SSH_CA_KEY_PATH → Cytale.Config.ssh_ca_key_path/0), never as an
# environment VALUE and never in argv: a value is readable from the
# environment and from the host's /proc, and this key mints certificates for
# every account. The surface is opt-in (CYTALE_SSH_CERTIFICATES_ENABLED,
# default false) and the boot requirement is scoped to that switch — one
# process serves all four clients, so a deploy that has not provisioned the
# CA must lose only the terminal, never chat. With the switch ON, a missing
# or unreadable key fails the boot fast, in the turn_auth! redaction style:
# the PATH and the reason, never the key's bytes.
#
# The three OpenSSH binary paths are resolved here (not hardcoded at the call
# site) so U1's interop gate can locate ssh-keygen/sshd/ssh and fail with a
# named reason when one is absent.

ssh_certificates_enabled = CytaleRuntime.parse_bool!("CYTALE_SSH_CERTIFICATES_ENABLED", false)

ssh_ca_key_path =
  case System.get_env("CYTALE_SSH_CA_KEY_PATH") do
    nil ->
      nil

    value ->
      case String.trim(value) do
        "" -> nil
        trimmed -> Path.expand(trimmed)
      end
  end

if ssh_certificates_enabled do
  cond do
    is_nil(ssh_ca_key_path) ->
      raise ArgumentError,
            "CYTALE_SSH_CERTIFICATES_ENABLED=true requires CYTALE_SSH_CA_KEY_PATH: the path " <>
              "to the CA's ed25519 openssh-key-v1 private key (generate one with " <>
              "`ssh-keygen -t ed25519 -f <path> -N ''`). The key is provisioned as a PATH, " <>
              "never as an environment value."

    not File.regular?(ssh_ca_key_path) ->
      raise ArgumentError,
            "no readable SSH CA key at #{ssh_ca_key_path} (CYTALE_SSH_CA_KEY_PATH); " <>
              "certificates cannot be signed without it"

    true ->
      case File.open(ssh_ca_key_path, [:read]) do
        {:ok, io} ->
          File.close(io)

        {:error, reason} ->
          raise ArgumentError,
                "SSH CA key at #{ssh_ca_key_path} is not readable by this process " <>
                  "(#{:file.format_error(reason)}), so certificates cannot be signed"
      end
  end
end

config :cytale, :ssh,
  enabled: ssh_certificates_enabled,
  ca_key_path: ssh_ca_key_path,
  certificate_ttl_ms: CytaleRuntime.parse_int!("CYTALE_SSH_CERTIFICATE_TTL_MS", 24 * 60 * 60 * 1000),
  keygen_bin: CytaleRuntime.openssh_bin!("CYTALE_OPENSSH_KEYGEN_BIN", "ssh-keygen", "/usr/bin/ssh-keygen"),
  sshd_bin: CytaleRuntime.openssh_bin!("CYTALE_OPENSSH_SSHD_BIN", "sshd", "/usr/sbin/sshd"),
  ssh_bin: CytaleRuntime.openssh_bin!("CYTALE_OPENSSH_SSH_BIN", "ssh", "/usr/bin/ssh")

# ----- SSH session bridge (U2) ---------------------------------------------------
# The host-side mint endpoint: the SSH host verifies a certificate locally and
# then exchanges that identity here for a short-lived access token. Two things
# about its shape are load-bearing.
#
# IT BINDS ITS OWN LISTENER, not the app's. A Phoenix route table belongs to
# the endpoint, so a second bind address (or a Unix socket) on the same
# endpoint still serves the path on the listener Caddy proxies — the property
# R8a forbids. `CytaleWeb.BridgeServer` is therefore a separate child with its
# own route table, and the bridge path is deliberately ABSENT from
# `CytaleWeb.Router`. The bind defaults to loopback and the port is distinct
# from the app's, so a misconfiguration cannot silently publish it.
#
# Its credential is a PATH, like the CA key: the host reads it once at boot and
# unlinks it, which a value in the environment cannot survive (`/proc` stays
# readable to a same-UID child). CYTALE_SESSION_BRIDGE_CREDENTIAL exists as a
# value only for a dev box with no file to point at.
#
# The bridge is OFF by default: it mints tokens for an asserted identity, so
# enabling it is an explicit operator act, and with it off the listener does
# not start at all.

session_bridge_enabled = CytaleRuntime.parse_bool!("CYTALE_SESSION_BRIDGE_ENABLED", false)

session_bridge_credential_path =
  case System.get_env("CYTALE_SESSION_BRIDGE_CREDENTIAL_PATH") do
    nil ->
      nil

    value ->
      case String.trim(value) do
        "" -> nil
        trimmed -> Path.expand(trimmed)
      end
  end

session_bridge_bind =
  case System.get_env("CYTALE_SESSION_BRIDGE_BIND") do
    nil ->
      {127, 0, 0, 1}

    value ->
      case String.trim(value) do
        "" ->
          {127, 0, 0, 1}

        trimmed ->
          case :inet.parse_address(String.to_charlist(trimmed)) do
            {:ok, address} ->
              address

            {:error, _} ->
              raise ArgumentError,
                    "CYTALE_SESSION_BRIDGE_BIND must be an IP address (got #{inspect(trimmed)}); " <>
                      "the bridge binds the internal network only, never a public interface"
          end
      end
  end

if session_bridge_enabled do
  cond do
    is_nil(session_bridge_credential_path) and
        (System.get_env("CYTALE_SESSION_BRIDGE_CREDENTIAL") || "") == "" ->
      raise ArgumentError,
            "CYTALE_SESSION_BRIDGE_ENABLED=true requires a credential: set " <>
              "CYTALE_SESSION_BRIDGE_CREDENTIAL_PATH (the path the host reads once and unlinks) " <>
              "or, on a dev box only, CYTALE_SESSION_BRIDGE_CREDENTIAL"

    not is_nil(session_bridge_credential_path) and
        not File.regular?(session_bridge_credential_path) ->
      raise ArgumentError,
            "no readable session-bridge credential at #{session_bridge_credential_path} " <>
              "(CYTALE_SESSION_BRIDGE_CREDENTIAL_PATH); the host cannot mint without it"

    true ->
      :ok
  end
end

config :cytale, :session_bridge,
  enabled: session_bridge_enabled,
  bind_ip: session_bridge_bind,
  port: CytaleRuntime.parse_int!("CYTALE_SESSION_BRIDGE_PORT", 4100),
  credential_path: session_bridge_credential_path,
  credential: System.get_env("CYTALE_SESSION_BRIDGE_CREDENTIAL")

# ----- Voice calls ICE/TURN (U2, voice plan KTD1/KTD2; U12 ephemeral mode) --------
# The media UDP range ex_webrtc allocates ICE host-candidate sockets from —
# the deploy kit publishes the same span on the app container (KTD2 → U12).
# TURN is opt-in: absent CYTALE_TURN_* keeps host-candidates-only ICE (the
# loopback-friendly default); a partially-set trio fails fast at boot.
# U12 adds the SECRET mode: CYTALE_TURN_URL + CYTALE_TURN_SECRET (the value
# eturnal's ETURNAL_SECRET must share) makes Cytale.Config mint short-lived
# REST-auth credentials per read instead of shipping a static password —
# the static trio list stays empty in that mode (minting wins in Config).

turn_auth =
  CytaleRuntime.turn_auth!(
    System.get_env("CYTALE_TURN_URL"),
    System.get_env("CYTALE_TURN_SECRET"),
    System.get_env("CYTALE_TURN_USERNAME"),
    System.get_env("CYTALE_TURN_CREDENTIAL")
  )

config :cytale,
  calls: [
    media_udp_port_range: CytaleRuntime.parse_port_range!("CYTALE_MEDIA_UDP_PORT_RANGE", {50_000, 50_999}),
    ice_servers:
      if turn_auth do
        []
      else
        CytaleRuntime.turn_servers!(
          System.get_env("CYTALE_TURN_URL"),
          System.get_env("CYTALE_TURN_USERNAME"),
          System.get_env("CYTALE_TURN_CREDENTIAL")
        )
      end,
    turn: turn_auth
  ]

# ----- Mailer posture (P0-3: production never defaults to the dev mailbox) ------
# The Dev adapter writes credential tokens to a local mailbox file — the
# dev-mode delivery channel, and a liability anywhere real users exist. In
# :prod the operator must opt in EXPLICITLY (CYTALE_MAILER=dev) or configure
# a real adapter in release config; an unconfigured prod boot fails fast
# (a silent Dev default meant reset/verification tokens landed in logs+files
# and verification could never complete). Non-prod envs keep the Dev default.
if config_env() == :prod do
  case System.get_env("CYTALE_MAILER") do
    "dev" ->
      config :cytale, Cytale.Accounts.Mailer, adapter: Cytale.Accounts.Mailer.Dev

    other ->
      raise ArgumentError,
            "no mailer adapter configured for production (CYTALE_MAILER=#{inspect(other)}). " <>
              "Configure a real adapter (config :cytale, Cytale.Accounts.Mailer, adapter: ...) " <>
              "or set CYTALE_MAILER=dev to explicitly accept the LOCAL-ONLY dev mailbox " <>
              "(tokens land in tmp/dev_mailbox.jsonl; verification mail is never sent)"
  end
end

# ----- Platform operators (#33) ---------------------------------------------------
# Comma-separated snowflakes naming the server's operators — the allowlist
# behind CytaleWeb.Plugs.RequireOperator on /api/v1/admin/*. Fail-closed:
# unset/empty denies EVERY account (403 for everyone, operators included) —
# a deploy must name its operators explicitly. Malformed entries raise at
# boot (house fail-fast; a typo'd allowlist silently locking everyone out
# would be worse).
operator_ids =
  case System.get_env("CYTALE_ADMIN_USER_IDS") do
    nil ->
      []

    raw ->
      raw
      |> String.split(",", trim: true)
      |> Enum.map(fn id ->
        case id |> String.trim() |> Integer.parse() do
          {int, ""} when int > 0 ->
            int

          _ ->
            raise ArgumentError,
                  "CYTALE_ADMIN_USER_IDS entries must be positive snowflake integers " <>
                    "(got: #{inspect(id)})"
        end
      end)
  end

# `:operator_user_ids` is the seed the config file's first boot copies (and
# then replaces with the file's list); `:env_operator_user_ids` keeps the
# environment's own list so it always ADDS operators (#170): the first boot
# freezes the file before any account exists, so this is how a new install
# names its first operator.
config :cytale, operator_user_ids: operator_ids, env_operator_user_ids: operator_ids

# ----- Server config file (#121) -------------------------------------------------
# The one local JSON config document + the 0600 secrets file beside it.
# Precedence (Cytale.ServerConfig): file > env > code default for every key
# the file names. Prod mounts /etc/cytale (compose); dev/test default to a
# LOCAL tmp path so nothing breaks without a mount — and the hermetic test
# suite never GENERATES one (a boot writing files into the shared checkout
# would collide across parallel agents; tests bring their own tmp paths).
# `secrets.json` always sits beside the config file (its dir), so relocating
# the config relocates the secrets with it.

server_config_path =
  case System.get_env("CYTALE_SERVER_CONFIG_PATH") do
    nil ->
      if config_env() == :prod do
        "/etc/cytale/config.json"
      else
        # Local default so nothing breaks without a mount. :test gets its OWN
        # name: a dev boot's tmp/server-config.json must never be read (and
        # its values applied) by the test VM, and vice versa.
        name = if config_env() == :test, do: "test-server-config.json", else: "server-config.json"
        Path.expand(Path.join(File.cwd!(), "tmp/" <> name))
      end

    value ->
      Path.expand(value)
  end

config :cytale,
  server_config_path: server_config_path,
  server_config_generate: config_env() != :test
