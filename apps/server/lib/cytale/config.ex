defmodule Cytale.Config do
  @moduledoc """
  Typed accessor for the `:cytale` app env.

  Every value here is populated by config/{config,dev,runtime}.exs and
  validated there (fail-fast at boot). Consumers read through this module so
  key shapes stay stable across units:

    * ScyllaDB       — `scylla_nodes/0`, `scylla_default_consistency/0`,
                       `scylla_pool_size/0`, `scylla_keyspace/0`,
                       `repo_read_retries/0`
    * Search         — `search_index_root/0`, `search_commit_interval_ms/0`
    * Gateway        — `resume_window_target_ms/0`, `resume_window_floor_ms/0`
    * Auth (U8)      — `access_token_ttl_ms/0`, `refresh_token_ttl_ms/0`
    * SSH (U1)       — `ssh_certificates_enabled?/0`, `ssh_ca_key_path/0`,
                       `ssh_certificate_ttl_ms/0`, and the injectable
                       `openssh_{keygen,sshd,ssh}_bin/0` paths the interop gate
                       resolves at boot
    * Snowflake (U5) — `snowflake_worker_id/0`
    * Calls (U2–U4 voice plan) — `calls_media_udp_port_range/0`,
                       `calls_ice_servers/0` (mints eturnal REST-auth
                       ephemeral TURN credentials when the secret mode is
                       configured — U12), `calls_empty_sweep_ms/0`,
                       `calls_session_grace_ms/0`, `calls_event_sink/0`,
                       `calls_per_user_leg_limit/0`,
                       `calls_workspace_pc_ceiling/0`

  Accessors normalize between keyword lists (classic config) and maps (release
  config providers rewrite keywords into maps), so behavior is identical for
  `mix phx.server` / `mix test` and for a booted release.
  """

  @clamp_min 100
  @clamp_max 2000

  # ----- Schema-generated accessors (7.8) -----------------------------------------
  #
  # Accessors for keys that live in `Cytale.ServerConfig.Schema` are GENERATED
  # from it here, at compile time — not a runtime indirection. Storage location,
  # DEFAULT and `@doc`/`@spec` all come from the one spec, so an accessor cannot
  # read a scope, key or default the validator/editor do not believe in (the
  # drift shape behind 1.6). `external_base_url/0` and the never-schema-backed
  # keys (scylla, search, gateway, auth TTLs, calls, attachments, secrets) keep
  # their hand-written readers below. `ConfigAccessorsTest` walks every call
  # site's AST and fails if one names an accessor the schema no longer generates.

  for %{
        fun: fun,
        scope: scope,
        key: key,
        default: default,
        transform: transform,
        spec: spec,
        description: description
      } <- Cytale.ServerConfig.Schema.readers(Cytale.Config) do
    @doc description
    @spec unquote(fun)() :: unquote(spec)

    if transform == :present do
      def unquote(fun)(), do: present(read(unquote(scope), unquote(key), unquote(default)))
    else
      def unquote(fun)(), do: read(unquote(scope), unquote(key), unquote(default))
    end
  end

  # ----- ScyllaDB ---------------------------------------------------------------

  @spec scylla_nodes :: [charlist()]
  def scylla_nodes do
    get([Cytale.Config, :scylla_nodes], [~c"127.0.0.1"])
  end

  @spec scylla_default_consistency :: :local_quorum | atom()
  def scylla_default_consistency do
    get([Cytale.Config, :scylla_default_consistency], :local_quorum)
  end

  @spec scylla_pool_size :: pos_integer()
  def scylla_pool_size do
    get([Cytale.Config, :scylla_pool_size], 10)
  end

  @spec scylla_keyspace :: String.t()
  def scylla_keyspace do
    get([Cytale.Config, :scylla_keyspace], "cytale")
  end

  @doc """
  How many times an idempotent READ is retried on a transient failure
  (hardening R-7, `Cytale.Repo.with_read_retry/2`). 0 disables the retry.
  """
  @spec repo_read_retries :: non_neg_integer()
  def repo_read_retries do
    get([Cytale.Config, :repo_read_retries], 2)
  end

  # ----- Search -----------------------------------------------------------------

  @spec search_index_root :: String.t()
  def search_index_root do
    get([Cytale.Config, :search_index_root], "priv/search")
  end

  @doc """
  Tantivy commit batch window in ms. Always clamped into #{@clamp_min}..#{@clamp_max}
  regardless of what config provided (belt-and-braces on top of runtime.exs).
  """
  @spec search_commit_interval_ms :: 100..2000
  def search_commit_interval_ms do
    [Cytale.Config, :search_commit_interval_ms]
    |> get(500)
    |> max(@clamp_min)
    |> min(@clamp_max)
  end

  @doc """
  How often a workspace's index writer self-heals against ScyllaDB
  (`Cytale.Search.TantivyImpl.reconcile/1`, review #24), in ms — it also runs
  once shortly after the writer starts. `0` disables both (the hermetic test
  config: a background replay would race the suites' index assertions).
  """
  @spec search_reconcile_interval_ms :: non_neg_integer()
  def search_reconcile_interval_ms do
    case get([Cytale.Config, :search_reconcile_interval_ms], 900_000) do
      ms when is_integer(ms) and ms >= 0 -> ms
      _ -> 900_000
    end
  end

  @doc """
  Rows per page for the rebuild/reconcile scan (#89), clamped into
  `1..10_000` — the driver's page size, above which one read stops being one
  page.

  Every page is one ScyllaDB read, one `IndexWriter` commit and one telemetry
  event, so a smaller page makes progress finer-grained and a larger page
  finishes sooner.
  """
  @spec search_rebuild_page_size :: pos_integer()
  def search_rebuild_page_size do
    [Cytale.Config, :search_rebuild_page_size]
    |> get(500)
    |> clamp_int(1, 10_000, 500)
  end

  @doc """
  Ids the drift check examines per side (#89), clamped into `1..5000`.

  The two counts in a drift report are exact at any sample size; this bounds
  the COVERAGE of the missing/orphaned id samples. Every sampled id is still
  verified by an exact lookup, so a truncated sample remains trustworthy about
  the ids it does list.
  """
  @spec search_drift_sample_limit :: pos_integer()
  def search_drift_sample_limit do
    [Cytale.Config, :search_drift_sample_limit]
    |> get(500)
    |> clamp_int(1, 5_000, 500)
  end

  @doc """
  Documents whose indexed text the drift check compares to the stored row
  (#89), clamped into `0..500`. 0 skips the content comparison.
  """
  @spec search_drift_content_limit :: non_neg_integer()
  def search_drift_content_limit do
    [Cytale.Config, :search_drift_content_limit]
    |> get(25)
    |> clamp_int(0, 500, 25)
  end

  defp clamp_int(value, lo, hi, default) do
    if is_integer(value), do: value |> max(lo) |> min(hi), else: default
  end

  # ----- Gateway resume window ----------------------------------------------------
  #
  # (These two were briefly unreachable: an unterminated `@doc """` opened
  # above them turned the definitions into documentation text, so the module
  # exported neither while the source read as if it did. A compiler warning
  # said so; the source did not.)

  @spec resume_window_target_ms :: pos_integer()
  def resume_window_target_ms,
    do: get([:gateway, :resume_window_target_ms], 5 * 60 * 1000)

  @spec resume_window_floor_ms :: pos_integer()
  def resume_window_floor_ms,
    do: get([:gateway, :resume_window_floor_ms], 10 * 60 * 1000)

  @doc """
  Live-socket mailbox depth above which the fan-out SHEDS best-effort events
  to that socket (PERF-06): `TypingStart` and `PresenceUpdate` are skipped
  for a recipient whose queue exceeds this, so a stalled client cannot grow
  its mailbox without bound. Message/call/state events are never shed.
  """
  @spec fan_out_shed_threshold :: pos_integer()
  def fan_out_shed_threshold,
    do: get([:gateway, :fan_out_shed_threshold], 200)

  @doc """
  Per-principal concurrent gateway session cap (bots plan U7, KTD15) —
  machine principals only; checked at Identify. Default 8 (multi-instance
  agents stay the model).
  """
  @spec gateway_session_cap :: pos_integer()
  def gateway_session_cap,
    do: get([:gateway, :session_cap], 8)

  @doc """
  Argon2 computations allowed at once (`Cytale.Accounts.HashGate`, Tier 3 B
  finding 8). Each holds its full memory cost while it runs. Default 4.
  """
  @spec argon2_max_concurrency :: pos_integer()
  def argon2_max_concurrency,
    do: get([:auth, :argon2_max_concurrency], 4)

  @doc "How long an Argon2 caller waits for a slot before a 503 (ms). Default 2 s."
  @spec argon2_queue_ms :: non_neg_integer()
  def argon2_queue_ms,
    do: get([:auth, :argon2_queue_ms], 2_000)

  @doc """
  Live-plus-held NATIVE gateway sessions per user (Tier 3 B, 5d). At the cap
  an Identify evicts the user's oldest held session; only a user with this
  many genuinely live sockets is refused. Default 20.
  """
  @spec gateway_native_session_cap :: pos_integer()
  def gateway_native_session_cap,
    do: get([:gateway, :native_session_cap], 20)

  @doc "Inbound frames a gateway socket may send per window before a 4008 close (5a). Default 120."
  @spec gateway_frame_budget :: pos_integer()
  def gateway_frame_budget,
    do: get([:gateway, :frame_budget], 120)

  @doc "The inbound frame budget's window in ms (5a). Default 60 s."
  @spec gateway_frame_window_ms :: pos_integer()
  def gateway_frame_window_ms,
    do: get([:gateway, :frame_window_ms], 60_000)

  @doc "How long a socket may stay unidentified before a 4003 close (5b). Default 20 s."
  @spec gateway_identify_timeout_ms :: pos_integer()
  def gateway_identify_timeout_ms,
    do: get([:gateway, :identify_timeout_ms], 20_000)

  @doc "Accepted presence updates (op 3) per socket per window (5c). Default 5."
  @spec gateway_presence_budget :: pos_integer()
  def gateway_presence_budget,
    do: get([:gateway, :presence_budget], 5)

  @doc "The presence throttle's window in ms (5c). Default 20 s."
  @spec gateway_presence_window_ms :: pos_integer()
  def gateway_presence_window_ms,
    do: get([:gateway, :presence_window_ms], 20_000)

  # ----- Gateway socket memory bound (#52) ----------------------------------------

  # ~16 MB. A healthy session holds ~100 KB, so this is far above anything a
  # working client reaches, and far below the point where a stalled client's
  # backlog endangers the node.
  @socket_heap_default 16 * 1024 * 1024

  @doc """
  Per-session gateway socket heap bound in BYTES (#52) — the slow-consumer
  protection.

  A client that stops draining the wire stops the socket's writes, and the
  fan-out keeps queueing into that socket's mailbox; with no bound, that
  memory is the NODE's (at launch the gateway, every workspace and presence
  share one VM — single node by design, `docs/self-hosting.md`). The bound makes
  the VM kill that one process instead.

  Bytes here, WORDS at the `Process.flag/2` call site (the VM's unit for
  `max_heap_size`) — the conversion is pinned by the gateway heap suite.
  """
  @spec gateway_socket_max_heap_bytes :: pos_integer()
  def gateway_socket_max_heap_bytes do
    case get([Cytale.Config, :gateway_socket_max_heap_bytes], @socket_heap_default) do
      bytes when is_integer(bytes) and bytes > 0 -> bytes
      _ -> @socket_heap_default
    end
  end

  # ----- Trusted reverse proxies (security Tier 2 #1) ---------------------------

  # Private + loopback ranges: the compose network Caddy sits on is always
  # inside one of these, and port 4000 is never published, so nothing outside
  # them can reach the app to present a forged X-Forwarded-For.
  @trusted_proxies_default ~w(127.0.0.0/8 ::1/128 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 fc00::/7)

  @doc """
  The parsed CIDRs whose `X-Forwarded-For` the endpoint believes
  (`CytaleWeb.Plugs.RemoteIp`). Configured by `CYTALE_TRUSTED_PROXIES`
  (comma-separated CIDRs; empty = trust no proxy, use the TCP peer).
  Default: loopback + the RFC 1918 / ULA private ranges.

  Parsed once per distinct configured value and cached in `:persistent_term`
  (the plug reads it on every request).
  """
  @spec trusted_proxies :: [CytaleWeb.Plugs.RemoteIp.cidr()]
  def trusted_proxies do
    raw = Application.get_env(:cytale, :trusted_proxies, @trusted_proxies_default)

    case :persistent_term.get({__MODULE__, :trusted_proxies}, nil) do
      {^raw, parsed} ->
        parsed

      _ ->
        parsed = CytaleWeb.Plugs.RemoteIp.parse_cidrs!(List.wrap(raw))
        :persistent_term.put({__MODULE__, :trusted_proxies}, {raw, parsed})
        parsed
    end
  end

  # ----- Auth token TTLs ----------------------------------------------------------

  @spec access_token_ttl_ms :: pos_integer()
  def access_token_ttl_ms, do: get([:auth, :access_token_ttl_ms], 15 * 60 * 1000)

  @spec refresh_token_ttl_ms :: pos_integer()
  def refresh_token_ttl_ms,
    do: get([:auth, :refresh_token_ttl_ms], 30 * 24 * 60 * 60 * 1000)

  # ----- Per-account brute-force dam (audit S3) -------------------------------------
  #
  # Fixed-window failure counting: `attempt_guard_max_failures` failures inside
  # `attempt_guard_window_ms` lock the key for `attempt_guard_lock_ms`. The
  # defaults are the audit's numbers (10 / 15 min / 15 min); config.exs pins
  # them explicitly so the documented production values have a home.

  @doc "Failed attempts within one window that trip the dam (login / 2FA / password-reset)."
  @spec attempt_guard_max_failures :: pos_integer()
  def attempt_guard_max_failures, do: get([:auth, :attempt_guard_max_failures], 10)

  @doc "The fixed counting window for the dam, in ms."
  @spec attempt_guard_window_ms :: pos_integer()
  def attempt_guard_window_ms, do: get([:auth, :attempt_guard_window_ms], 15 * 60 * 1000)

  @doc "How long a tripped dam stays locked, in ms."
  @spec attempt_guard_lock_ms :: pos_integer()
  def attempt_guard_lock_ms, do: get([:auth, :attempt_guard_lock_ms], 15 * 60 * 1000)

  @doc """
  The GLOBAL login dam's threshold: failures against one identifier from ALL
  networks within one window (security Tier 2 #2). Far above the
  per-network `attempt_guard_max_failures`, because tripping it is the only
  way a stranger can lock the owner out — and a known network passes it.
  """
  @spec attempt_guard_identifier_max_failures :: pos_integer()
  def attempt_guard_identifier_max_failures,
    do: get([:auth, :attempt_guard_identifier_max_failures], 100)

  @doc "How long a network stays KNOWN for an identifier after a successful login, in ms."
  @spec attempt_guard_known_ip_ttl_ms :: pos_integer()
  def attempt_guard_known_ip_ttl_ms,
    do: get([:auth, :attempt_guard_known_ip_ttl_ms], 30 * 24 * 60 * 60 * 1000)

  # ----- CSP connect-src (audit S8) -------------------------------------------------

  @doc """
  Whether the CSP `connect-src` grows the localhost websocket forms
  (`ws://localhost:* wss://localhost:*`). Dev-only: config/dev.exs turns it on
  so a local gateway on an arbitrary port (and tooling that talks to one) is
  reachable from the SPA. No other environment sets it, and the blanket
  `ws: wss:` this replaces is gone everywhere.
  """
  @spec csp_localhost_ws_origins? :: boolean()
  def csp_localhost_ws_origins?, do: get([:security_headers, :localhost_ws_origins], false)

  # ----- SSH certificate surface (U1) ---------------------------------------------

  @ssh_certificate_ttl_ms 24 * 60 * 60 * 1000

  # `ssh_certificates_enabled?/0` is generated from `ssh.enabled` in the schema
  # (7.8). The switch exists so the CA's boot requirement is scoped to the SSH
  # surface rather than to the node: one process serves every client, so an
  # unprovisioned deploy must lose only the terminal, never chat. With it off,
  # `Cytale.SSH.issue_user_certificate/2` returns `{:error, :disabled}` without
  # reading the filesystem, and `config/runtime.exs` requires no CA key.
  @doc """
  Path to the CA's ed25519 private key (`openssh-key-v1`, unencrypted). The key
  is provisioned as a PATH and read once at first use — never as an environment
  value and never in argv, because both are readable by anything that shares
  this process's environment. `nil` when unset.
  """
  @spec ssh_ca_key_path :: String.t() | nil
  def ssh_ca_key_path do
    case get([:ssh, :ca_key_path], nil) do
      path when is_binary(path) and path != "" -> path
      _other -> nil
    end
  end

  @doc """
  Issued user-certificate lifetime in ms (R4: 24 hours). Read by
  `Cytale.SSH.Certificate` on every issuance; a test pins a shorter one to make
  the window's edges observable.
  """
  @spec ssh_certificate_ttl_ms :: pos_integer()
  def ssh_certificate_ttl_ms,
    do: get([:ssh, :certificate_ttl_ms], @ssh_certificate_ttl_ms)

  @doc """
  Absolute path to `ssh-keygen`, resolved at boot. U1's interop gate drives the
  real binary; tests read this rather than hardcoding a path, and override it
  in-process to exercise the missing-binary failure.
  """
  @spec openssh_keygen_bin :: String.t()
  def openssh_keygen_bin, do: get([:ssh, :keygen_bin], "/usr/bin/ssh-keygen")

  @doc "Absolute path to `sshd`, the interop gate's real verifier (see `openssh_keygen_bin/0`)."
  @spec openssh_sshd_bin :: String.t()
  def openssh_sshd_bin, do: get([:ssh, :sshd_bin], "/usr/sbin/sshd")

  @doc "Absolute path to the `ssh` client, the interop gate's real authenticating client."
  @spec openssh_ssh_bin :: String.t()
  def openssh_ssh_bin, do: get([:ssh, :ssh_bin], "/usr/bin/ssh")

  # ----- Interactions (bots plan U8, KTD13) ----------------------------------------

  @doc """
  Interaction-token lifetime (bots plan U8, KTD13): Discord gives interaction
  tokens 15 minutes (our ack window deliberately diverges — no 3-second
  invalidation, see docs/protocol/compat.md). Test suites inject shorter
  TTLs via `config :cytale, interactions: [token_ttl_ms: ...]`.
  """
  @spec interaction_token_ttl_ms :: pos_integer()
  def interaction_token_ttl_ms,
    do: get([:interactions, :token_ttl_ms], 15 * 60 * 1000)

  # ----- Native rate limiting (#90) ------------------------------------------------

  # Belt and braces: config/config.exs sets the real default explicitly (it is
  # the documented production value). This fallback keeps the request path
  # working if a release config provider ever drops the entry.
  @rate_limit_ip_ceiling_default 500

  @doc """
  The per-IP CEILING for a native bucket (#90), in the same window as that
  bucket's own limit.

  The native AUTHENTICATED bucket (`:api` behind `Plugs.Auth`) is keyed per
  ACCOUNT, so teammates behind one NAT are N budgets rather than one shared
  one; this ceiling is the SECOND, IP-keyed bucket behind it, so a single IP
  cannot hammer the surface with a churn of many accounts. It is a flood
  ceiling, not the budget: it sits far above one account's `50/10s`, and one
  account's own limit always bites first.

  Only authenticated buckets consume a ceiling — an unauthenticated request's
  primary bucket already IS the per-IP bucket, and the pre-auth `:auth` dam is
  deliberately IP-keyed.

  Production defaults and the raise-lever live in docs/self-hosting.md
  ("Rate limits"); the hermetic suite raises this (every async test shares
  127.0.0.1) via `config :cytale, rate_limit_ip_ceilings: [api: ...]`.
  """
  @spec rate_limit_ip_ceiling(atom()) :: pos_integer()
  def rate_limit_ip_ceiling(bucket) when is_atom(bucket) do
    ceilings =
      case Application.get_env(:cytale, :rate_limit_ip_ceilings, []) do
        ceilings when is_map(ceilings) -> ceilings
        ceilings when is_list(ceilings) -> Map.new(ceilings)
        _ -> %{}
      end

    Map.get(ceilings, bucket, @rate_limit_ip_ceiling_default)
  end

  # ----- The send budget (every send route) ----------------------------------------

  @send_budget_default %{conversation: {10, 5_000}, principal: {20, 5_000}}

  @doc """
  The ONE message-send rate budget (`CytaleWeb.Plugs.SendBudget`), per sender
  — a person or a bot, on the native or the compat routes alike:

    * `:conversation` — sends by one sender into one channel or thread:
      10 / 5 s;
    * `:principal` — sends by one sender across every conversation: 20 / 5 s.

  Why these numbers: Discord documents about 5 sends / 5 s per channel for a
  bot, and bot libraries pace themselves by the `X-RateLimit-*` headers, so
  twice that per conversation leaves every Discord-tuned bot clear. The web
  app sends one POST at a time per conversation (its optimistic queue), and
  on reconnect it re-sends every held message in typed order — several in a
  row into one conversation, and several conversations at once — so the
  per-conversation 10 covers a typical offline backlog and the per-sender 20
  covers that replay fanning out across conversations. A person typing as
  fast as they can Enter short lines stays well under both.

  Overrides merge per key: `config :cytale, send_budget: [conversation:
  {limit, window_ms}, principal: {limit, window_ms}]`.
  """
  @spec send_budget() :: %{conversation: {pos_integer(), pos_integer()}, principal: {pos_integer(), pos_integer()}}
  def send_budget do
    case Application.get_env(:cytale, :send_budget) do
      override when is_list(override) or is_map(override) -> Map.merge(@send_budget_default, Map.new(override))
      _ -> @send_budget_default
    end
  end

  # ----- Compat rate limiting (B2) -------------------------------------------------

  @doc """
  Pre-auth per-IP ceiling for the compat prefixes (`/api/v10`, `/api`) per
  10s window — the unauthenticated-flood dam in front of BotAuth. Generous
  by design: valid principals stay governed by the per-principal route
  buckets (50/10s per route); this only bites floods that never
  authenticate. The hermetic test suite raises it (every request shares
  127.0.0.1) via `config :cytale, compat: [preauth_ip_limit: ...]`.
  """
  @spec compat_preauth_ip_limit :: pos_integer()
  def compat_preauth_ip_limit,
    do: get([:compat, :preauth_ip_limit], 30)

  @doc """
  Compat route-CLASS rate limits (KTD9, C-2): the per-principal
  per-route-template buckets take their `{limit, window_ms}` from the
  route's CLASS —

    * `:message_write` — the reaction PUT/DELETE routes (the Discord-tight
      spam surfaces): 10 / 5s. The message-create POST classifies here too,
      but a SEND is governed by the one send budget (`send_budget/0`) on
      every surface, not by this class;
    * `:mutation` — every other non-GET (edits, deletes, typing, ack,
      thread starts, DM opens, command registration): 25 / 10s;
    * `:read` — every GET: 50 / 10s.

  Overrides merge PER CLASS over these defaults (a partial override leaves
  the other classes at their defaults), via `config :cytale, compat:
  [route_class_limits: [message_write: {limit, window_ms}, ...]]`. The
  pre-auth IP dam and the per-webhook buckets are NOT class-governed.
  """
  @spec compat_route_class_limits() :: %{
          message_write: {pos_integer(), pos_integer()},
          mutation: {pos_integer(), pos_integer()},
          read: {pos_integer(), pos_integer()}
        }
  def compat_route_class_limits do
    default = %{message_write: {10, 5_000}, mutation: {25, 10_000}, read: {50, 10_000}}

    case get([:compat, :route_class_limits], default) do
      %{} = override -> Map.merge(default, override)
      _ -> default
    end
  end

  # ----- External base URL (C-5b) --------------------------------------------------

  @doc """
  The externally-visible origin (`"https://chat.example.com"` — scheme +
  host + optional port, NO path) for every EXTERNALLY-constructed URL: the
  shared compat gateway URL builder (`/gateway/bot`'s `url` and the compat
  READY's `resume_gateway_url`) and the webhook execute/info URLs. When set,
  the configured origin is used VERBATIM instead of the request's
  host/scheme/port — deployments behind a proxy with a different public
  origin set it at boot; `nil` (the default) keeps the conn-derived
  behavior. See docs/protocol/compat.md.

  NOTE: a TOP-LEVEL scalar app env (`Application.get_env(:cytale,
  :external_base_url)`), not a scope+keys entry — the `get/2` helper below
  only digs into scoped keyword/map configs.
  """
  @spec external_base_url :: String.t() | nil
  def external_base_url do
    case Application.get_env(:cytale, :external_base_url) do
      nil ->
        nil

      url when is_binary(url) ->
        url

      other ->
        raise("cytale :external_base_url must be a string (absolute origin) or nil — got: #{inspect(other)}")
    end
  end

  # ----- Registration gate ----------------------------------------------------------
  #
  # `registration_open?/0` and `require_verified_email?/0` are generated from
  # the schema (7.8); their defaults, env sources and docs live in
  # `Cytale.ServerConfig.Schema`.

  @doc "Effective verification for a stored account under the current flag."
  @spec effective_verified?(boolean() | nil) :: boolean()
  def effective_verified?(stored_verified) do
    stored_verified == true or not require_verified_email?()
  end

  # ----- WebAuthn passkeys (ticket #36) --------------------------------------------
  #
  # `webauthn_enabled?/0` is generated from the schema's `auth.passkeys_enabled`
  # key (7.8), which stores into `[:webauthn, :enabled]` — default TRUE (owner,
  # 2026-09-14: passkeys start on). Enrollment bakes the RP ID into credentials,
  # so availability is additionally gated on a REAL RP ID being derivable; see
  # `webauthn_available?/0` below.

  @doc """
  Whether the passkey surface can actually WORK: enabled AND a real RP ID
  derivable — an explicit `[:webauthn, :rp_id]` override, or an external
  origin to derive it from. The bare `"localhost"` fallback is a dev
  convenience and must never advertise passkeys on a deploy whose origin is
  not configured (a credential enrolled against it can never work on the
  production domain).
  """
  @spec webauthn_available? :: boolean()
  def webauthn_available? do
    webauthn_enabled?() and
      (get([:webauthn, :rp_id], nil) != nil or external_base_url() != nil)
  end

  @doc """
  WebAuthn challenge lifetime in seconds: 5 minutes, the bottom of the
  WebAuthn recommendation for ceremonies that ask for user verification. A
  cross-device sign-in (scan a QR code, unlock the phone, confirm) routinely
  outlasts the former 2 minutes, and a challenge that expires mid-ceremony
  refuses a perfectly good passkey.
  """
  @spec webauthn_challenge_timeout_s :: pos_integer()
  def webauthn_challenge_timeout_s, do: get([:webauthn, :challenge_timeout_s], 300)

  @doc """
  Explicit RP ID override (`[:webauthn, :rp_id]` — a parent-domain value for
  subdomain-wide passkeys). `nil` = derive from the external origin (see
  `Cytale.Accounts.WebAuthn.rp_id/0`).
  """
  @spec webauthn_rp_id :: String.t() | nil
  def webauthn_rp_id, do: get([:webauthn, :rp_id], nil)

  @doc """
  Explicit origin allowlist override (`[:webauthn, :origins]`). `nil` =
  derive from the external origin (see `Cytale.Accounts.WebAuthn.origins/0`).
  """
  @spec webauthn_origins :: [String.t()] | nil
  def webauthn_origins, do: get([:webauthn, :origins], nil)

  # ----- TOTP two-factor (ticket #127) ----------------------------------------------
  #
  # `two_factor_enabled?/0` is generated from `auth.two_factor_enabled` in the
  # schema (7.8), default FALSE. Off means the feature is fully absent: no
  # enrollment surface, no prompts, login unchanged. On means password-only
  # accounts are forced to enroll at their next password login, and enrolled
  # accounts get a TOTP code challenge at every password login. Passkey and OIDC
  # logins are exempt (they are already multifactor). Enforcement READS this at
  # login, so a flip hot-applies to the next login without a restart.

  # ----- Media-plane master switch (ticket #124) ------------------------------------
  #
  # `media_enabled?/0` is generated from `media.enabled` in the schema (7.8):
  # default TRUE, one switch for voice, video AND screen share. The LAYERING
  # and standing-call semantics are documented on the schema key itself.

  # ----- Instance OIDC federated sign-in (ticket #12) -------------------------------
  #
  # `oidc_enabled_flag?/0`, `oidc_issuer_url/0`, `oidc_client_id/0`,
  # `oidc_scopes/0` and `oidc_button_label/0` are generated from the schema
  # (7.8). The flag is NOT the full readiness check —
  # `Cytale.OIDC.enabled?/0` additionally demands issuer_url, client_id and the
  # client secret, failing closed on a half-configured provider; the issuer and
  # client id are blank-normalized (blank → nil) by the `present` reader shape.

  # ----- Snowflake ----------------------------------------------------------------

  @spec snowflake_worker_id :: 0..1023
  def snowflake_worker_id, do: get([Cytale.Config, :snowflake_worker_id], 0)

  # ----- Attachments (U21a) -------------------------------------------------------

  @doc """
  On-disk root for attachment blobs (avatars, workspace icons, message files).

  Defaults to the release's own `priv/attachments` (`Application.app_dir/2`) —
  correct for `mix phx.server` and a plain release start. Container deploys
  must point this at the mounted volume instead (`CYTALE_ATTACHMENTS_ROOT`,
  set in compose.yaml): the release's `priv/` lives in the container's
  writable layer there, so without it every `docker compose up -d` silently
  drops every upload.
  """
  @spec attachments_root :: String.t()
  def attachments_root do
    case Application.get_env(:cytale, :attachments_root) do
      root when is_binary(root) and root != "" -> root
      _ -> Path.join(Application.app_dir(:cytale, "priv"), "attachments")
    end
  end

  @spec attachment_max_upload_bytes :: pos_integer()
  def attachment_max_upload_bytes,
    do: get([:attachments, :max_upload_bytes], 25 * 1024 * 1024)

  @spec attachment_allowed_mime_types :: [String.t()]
  def attachment_allowed_mime_types,
    do: get([:attachments, :allowed_mime_types], [])

  @spec attachment_volume_cap_bytes :: pos_integer()
  def attachment_volume_cap_bytes,
    do: get([:attachments, :volume_cap_bytes], 10 * 1024 * 1024 * 1024)

  @doc """
  Lifetime of a signed attachment URL, in seconds (security Tier 2 #4). Every
  render re-signs, so this bounds how long a URL copied out of the product
  keeps working — not how long a member can see an attachment. The expiry is
  rounded up to the hour so renders within one hour mint identical URLs.
  """
  @spec attachment_url_ttl_seconds :: pos_integer()
  def attachment_url_ttl_seconds,
    do: get([:attachments, :signed_url_ttl_seconds], 24 * 60 * 60)

  # ----- Media proxy -------------------------------------------------------------

  @doc """
  Whether the media proxy is on (`CYTALE_MEDIA_PROXY_ENABLED`, default true).
  Off, every wire omits `proxy_url`/`proxy_icon_url`/`content_proxy_urls` and
  `GET /api/v1/media/proxy` answers 404 — external images then stay hidden,
  as the app's `img-src 'self'` CSP requires.
  """
  @spec media_proxy_enabled? :: boolean()
  def media_proxy_enabled?, do: get([:media_proxy, :enabled], true) == true

  @doc "Largest external image the proxy will fetch, in bytes (streamed; the fetch aborts past it)."
  @spec media_proxy_max_bytes :: pos_integer()
  def media_proxy_max_bytes, do: get([:media_proxy, :max_bytes], 10 * 1024 * 1024)

  @doc "Total bytes the proxy's disk cache may hold before least-recently-used entries are evicted."
  @spec media_proxy_cache_max_bytes :: pos_integer()
  def media_proxy_cache_max_bytes, do: get([:media_proxy, :cache_max_bytes], 1024 * 1024 * 1024)

  @doc "How long a fetched image is served from the cache before it is fetched again, in seconds."
  @spec media_proxy_cache_ttl_seconds :: pos_integer()
  def media_proxy_cache_ttl_seconds, do: get([:media_proxy, :cache_ttl_seconds], 7 * 24 * 60 * 60)

  @doc "How long a FAILED fetch is remembered (answered without refetching), in seconds."
  @spec media_proxy_negative_ttl_seconds :: pos_integer()
  def media_proxy_negative_ttl_seconds, do: get([:media_proxy, :negative_ttl_seconds], 5 * 60)

  @doc "Largest canvas (width × height) the proxy accepts, where the format's header states it."
  @spec media_proxy_max_pixels :: pos_integer()
  def media_proxy_max_pixels, do: get([:media_proxy, :max_pixels], 50_000_000)

  @doc """
  Where the proxy keeps fetched images. Defaults to `.media-cache` under the
  attachment root — the same mounted volume, but a dot-directory, which the
  attachment store's byte counter skips and which backups never copy (they
  copy referenced blobs by hash).
  """
  @spec media_proxy_cache_dir :: String.t()
  def media_proxy_cache_dir do
    case get([:media_proxy, :cache_dir], nil) do
      dir when is_binary(dir) and dir != "" -> dir
      _ -> Path.join(attachments_root(), ".media-cache")
    end
  end

  @spec attachment_warn_watermark :: float()
  def attachment_warn_watermark, do: get([:attachments, :warn_watermark], 0.75)

  @spec attachment_reject_watermark :: float()
  def attachment_reject_watermark, do: get([:attachments, :reject_watermark], 0.85)

  # Avatars + workspace icons share the image-only purpose (the `:avatar`
  # upload pair): a tighter cap than message attachments and no document
  # types — profile imagery is always one of the four raster formats. The
  # 2 MB interim cap bounds the bytes every peer downloads per rendered
  # avatar until #48's crop editor exports bounded-size images at the
  # source (avatars render en masse; message attachments do not).
  @spec avatar_max_upload_bytes :: pos_integer()
  def avatar_max_upload_bytes,
    do: get([:attachments, :avatar_max_upload_bytes], 2 * 1024 * 1024)

  # Max width/height for avatar-purpose images, sniffed from the header
  # (PNG/GIF/JPEG only — WebP and unparseable bytes are bounded by the
  # byte cap alone, which is exactly why both limits exist).
  @spec avatar_max_dimension :: pos_integer()
  def avatar_max_dimension,
    do: get([:attachments, :avatar_max_dimension], 4096)

  @spec avatar_allowed_mime_types :: [String.t()]
  def avatar_allowed_mime_types,
    do: get([:attachments, :avatar_allowed_mime_types], [])

  # ----- Voice calls ICE/TURN (U2, voice plan KTD1/KTD2) ---------------------------

  @doc """
  UDP port range `{first, last}` the media plane reserves for ex_webrtc ICE
  host-candidate socket allocation (one socket per server-side PeerConnection;
  the same span the deploy kit publishes on the app container — KTD2). Read
  by `Cytale.Calls.ICE`/U5's media plane.
  """
  @spec calls_media_udp_port_range :: {pos_integer(), pos_integer()}
  def calls_media_udp_port_range,
    do: get([:calls, :media_udp_port_range], {50_000, 50_999})

  # Ephemeral TURN credential lifetime (voice plan U12): every mint is valid
  # for one hour from the read. eturnal only checks expiry at ALLOCATION
  # time (established relays run past it), so a call that joined inside the
  # window is never cut off mid-stream.
  @turn_credential_ttl_s 3_600

  @doc """
  ICE servers in the ex_webrtc `ice_server` shape
  (`%{urls: .., username: .., credential: ..}`). Default `[]` — host
  candidates only, which is exactly right for loopback dev/test (no STUN
  needed) and for the single-node deploy until TURN is configured.

  Two configured shapes (runtime.exs, eturnal KTD2):

    * `:turn` secret mode (U12) — `CYTALE_TURN_URL` + `CYTALE_TURN_SECRET`
      set: this mints an EPHEMERAL credential on every read (eturnal's
      REST-auth mechanism, draft-uberti-behave-turn-rest): username = unix
      expiry timestamp (now + #{@turn_credential_ttl_s}s), credential =
      Base64 of HMAC-SHA1(secret, username). The static secret NEVER
      appears in the returned entries — only minted pairs do — so this
      list is safe to hand to clients verbatim (GET /calls/ice).
    * static trio — `CYTALE_TURN_{URL,USERNAME,CREDENTIAL}` all set: the
      configured entry passes through unchanged (U2's shape; TURN servers
      without REST-auth support).
  """
  @spec calls_ice_servers :: [
          %{
            required(:urls) => String.t() | [String.t()],
            optional(:username) => String.t(),
            optional(:credential) => String.t()
          }
        ]
  def calls_ice_servers, do: calls_ice_servers(System.os_time(:second))

  @doc """
  Test seam over `calls_ice_servers/0` with a FROZEN `now` (unix seconds) —
  the mint derivation is deterministic given the timestamp.
  """
  @spec calls_ice_servers(integer()) :: [
          %{
            required(:urls) => String.t() | [String.t()],
            optional(:username) => String.t(),
            optional(:credential) => String.t()
          }
        ]
  def calls_ice_servers(now_s) when is_integer(now_s) do
    case get([:calls, :turn], nil) do
      %{url: url, secret: secret} when is_binary(url) and is_binary(secret) ->
        [mint_turn_entry(url, secret, now_s)]

      _ ->
        get([:calls, :ice_servers], [])
    end
  end

  defp mint_turn_entry(url, secret, now_s) do
    username = Integer.to_string(now_s + @turn_credential_ttl_s)
    credential = Base.encode64(:crypto.mac(:hmac, :sha, secret, username))
    %{urls: url, username: username, credential: credential}
  end

  @doc """
  How long an EMPTY call is kept open before the idle sweep ends it (AM10:
  60s — a rejoin within the window resurrects the same call). Rooms read
  this at start; tests inject shorter windows via
  `config :cytale, calls: [empty_sweep_ms: ...]`.
  """
  @spec calls_empty_sweep_ms :: pos_integer()
  def calls_empty_sweep_ms,
    do: get([:calls, :empty_sweep_ms], 60_000)

  @doc """
  Answer deadline for a server-pushed SDP offer (voice plan U13's load-leg
  falsification): an offer still un-answered past this window recovers by
  renegotiating the leg (a lost or unappliable answer would otherwise wedge
  the participant's egress behind the glare guard forever). Default 5 s —
  several round trips of headroom over a real browser's offer/answer
  exchange, bounded so a wedged leg recovers within one renegotiation.
  """
  @spec calls_answer_deadline_ms :: pos_integer()
  def calls_answer_deadline_ms,
    do: get([:calls, :answer_deadline_ms], 5_000)

  @doc """
  Liveness grace for a participant whose monitored gateway session process
  died (AM4: ~30s — a Resume re-binds the new session process within the
  window and keeps the voice leg; expiry removes the participant). Rooms
  read this at start; tests inject shorter windows the same way.
  """
  @spec calls_session_grace_ms :: pos_integer()
  def calls_session_grace_ms,
    do: get([:calls, :session_grace_ms], 30_000)

  @doc """
  The module call-room transitions are reported to (voice plan U3's
  emission seam: `Cytale.Calls.Events.Sink` behaviour). U4's default is the
  visibility-filtered publisher (`Cytale.Calls.Events.PublisherSink`); the
  no-op sink remains available for hermetic room-level tests.
  """
  @spec calls_event_sink :: module()
  def calls_event_sink,
    do: get([:calls, :event_sink], Cytale.Calls.Events.PublisherSink)

  @doc """
  Per-user concurrent voice-leg limit across ALL live calls (U4's AM-side
  cap): a user holding legs in this many OTHER calls cannot start or join
  another. Default 2 (the plan's number).
  """
  @spec calls_per_user_leg_limit :: pos_integer()
  def calls_per_user_leg_limit,
    do: get([:calls, :per_user_leg_limit], 2)

  @doc """
  Per-workspace aggregate live-PC ceiling (U4's AM-side cap): the maximum
  number of concurrent voice legs across the workspace's live call rooms —
  sized under the configured media UDP port range when not set explicitly
  (every participant leg ultimately holds ICE sockets out of that range).
  DM calls have no workspace and count against no workspace bucket.
  """
  @spec calls_workspace_pc_ceiling :: pos_integer()
  def calls_workspace_pc_ceiling do
    case get([:calls, :workspace_pc_ceiling], nil) do
      nil ->
        {lo, hi} = calls_media_udp_port_range()
        hi - lo + 1

      n when is_integer(n) and n > 0 ->
        n
    end
  end

  # ----- CORS (first-party cross-origin clients) ------------------------------------
  #
  # `cors_allowed_origins/0` is generated from `cors.allowed_origins` in the
  # schema (7.8). The deployed web client is same-origin by construction (the
  # endpoint serves the SPA, REST and gateway together), so this list exists for
  # the desktop shells: the Tauri app loads the SPA from `tauri://localhost`
  # (macOS/Linux WKWebView) or `http://tauri.localhost` (Windows WebView2) and
  # calls the API cross-origin, which the webview blocks without
  # `Access-Control-Allow-Origin`. Defaults to those two first-party shell
  # origins; `CYTALE_CORS_ALLOWED_ORIGINS` (comma-separated, runtime.exs)
  # replaces the list wholesale. `"*"` is never honored — the match is exact;
  # CORS is not an authorization boundary here (every request still carries a
  # bearer token, and a native client could call the API without CORS at all).

  # ----- Internals ----------------------------------------------------------------

  # The two storage shapes `Schema.readers/1` generates against: a top-level
  # scalar app-env key (`nil` scope) or a scope+key dug out of a keyword list
  # (classic config) or a map (release config provider).
  defp read(nil, key, default), do: Application.get_env(:cytale, key, default)
  defp read(scope, key, default), do: get([scope, key], default)

  # A configured-but-blank string is an UNconfiguration (the editor writes ""
  # when a field is cleared) — readers want nil, not "".
  defp present(value) when is_binary(value), do: if(String.trim(value) == "", do: nil, else: value)
  defp present(_other), do: nil

  # Reads `Application.get_env(:cytale, scope)` and digs `keys` into it.
  defp get([scope | keys], default) do
    case Application.get_env(:cytale, scope) do
      nil -> default
      value -> dig(normalize(value), keys, default)
    end
  end

  defp dig(_node, [], _default), do: raise("unreachable")

  defp dig(node, path, default) when is_map(node) do
    case Map.fetch(node, hd(path)) do
      {:ok, value} when tl(path) == [] -> value
      {:ok, child} -> dig(normalize(child), tl(path), default)
      :error -> default
    end
  end

  # Non-container leaf reached before the path is exhausted: treat as missing.
  defp dig(_node, _path, default), do: default

  # Classic config yields keyword lists; release config providers yield maps.
  # Charlists ([int, ...]) are never containers here, but guard anyway: only
  # keyword-shaped lists are converted.
  defp normalize(value) when is_list(value) do
    if Keyword.keyword?(value), do: Map.new(value), else: value
  end

  defp normalize(value) when is_map(value), do: value
  defp normalize(value), do: value
end
