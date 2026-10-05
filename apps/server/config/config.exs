# This file is responsible for configuration common to all environments.
#
# OWNERSHIP (7.9): a key that `config/runtime.exs` writes UNCONDITIONALLY (in
# every env) lives ONLY there — its env read's literal default IS the stated
# default. Do not restate such a key here: runtime.exs runs last and discards
# it, so editing config.exs would have zero effect. Runtime-owned paths today:
# external_base_url; the gateway resume target/floor; the auth access/refresh
# TTLs; search_index_root and search_commit_interval_ms; the whole ssh block;
# the whole session_bridge block. `Cytale.ConfigOwnershipTest` enforces the
# split in both directions.
import Config

# ----- Cytale app env ---------------------------------------------------------

# (external_base_url is runtime-owned: CYTALE_EXTERNAL_BASE_URL in
# config/runtime.exs, where nil — the fallback — means conn-derived.)

config :cytale,
  # gateway: only the keys runtime.exs does NOT write live here. The resume
  # window (target/floor) is env-owned in runtime.exs (GATEWAY_RESUME_*_MS).
  gateway: [
    # PERF-06: live-socket mailbox depth above which the fan-out sheds
    # TypingStart/PresenceUpdate to that socket (never message/call/state).
    fan_out_shed_threshold: 200
  ],
  # auth: the JWT token TTLs are env-owned in runtime.exs (AUTH_ACCESS_TOKEN_TTL_MS
  # / AUTH_REFRESH_TOKEN_TTL_MS). The attempt-guard triple is the S3 brute-force
  # dam (Cytale.Accounts.AttemptGuard): 10 failures inside 15 minutes lock the
  # key for 15 minutes. Accessors:
  # Cytale.Config.attempt_guard_{max_failures,window_ms,lock_ms}/0.
  auth: [
    attempt_guard_max_failures: 10,
    attempt_guard_window_ms: 15 * 60 * 1000,
    attempt_guard_lock_ms: 15 * 60 * 1000,
    # Security Tier 2 #2: the lock above is per identifier PER NETWORK; the
    # global per-identifier dam sits far higher, and a network that logged in
    # to the identifier within the TTL passes it.
    attempt_guard_identifier_max_failures: 100,
    attempt_guard_known_ip_ttl_ms: 30 * 24 * 60 * 60 * 1000
  ],
  # (ssh + session_bridge are runtime-owned in full — CYTALE_SSH_* and
  # CYTALE_SESSION_BRIDGE_* in config/runtime.exs, which also scope the
  # fail-fast CA/credential checks to their switches.)
  # Attachment upload (U21a): 25 MB per-file cap, fixed mime allowlist,
  # volume-level watermarks (warn 75% / reject-new-uploads 85%).
  # SVG is deliberately ABSENT (#35 P0-2): inline SVG is script-executing
  # markup served from the app origin — a stored-XSS channel. The vetted
  # raster set covers the app's image needs; a sanitized-SVG pipeline is
  # the (not-yet-built) path back in.
  attachments: [
    max_upload_bytes: 25 * 1024 * 1024,
    allowed_mime_types: [
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "application/pdf",
      "text/plain",
      "text/markdown",
      "application/json",
      "text/csv"
    ],
    volume_cap_bytes: 10 * 1024 * 1024 * 1024,
    warn_watermark: 0.75,
    reject_watermark: 0.85,
    # The `:avatar` upload purpose (user avatars + workspace icons):
    # image-only, tighter caps than message attachments — avatars render
    # en masse client-side, so bytes and dimensions are both bounded
    # (dimension check covers sniffable formats; the byte cap bounds the
    # rest). #48's crop editor will make these moot at the source.
    avatar_max_upload_bytes: 2 * 1024 * 1024,
    avatar_max_dimension: 4096,
    avatar_allowed_mime_types: [
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp"
    ]
  ],
  # Compat route-CLASS rate limits (KTD9, C-2): each per-principal
  # per-route-template bucket takes its {limit, window_ms} from the route's
  # class — message-create POST + reaction PUT/DELETE 10/5s, other
  # mutations 25/10s, reads 50/10s. Accessor:
  # Cytale.Config.compat_route_class_limits/0 (partial overrides merge per
  # class). The pre-auth IP dam reads :preauth_ip_limit in the same scope.
  compat: [
    route_class_limits: [
      message_write: {10, 5_000},
      mutation: {25, 10_000},
      read: {50, 10_000}
    ]
  ]

# Native per-IP CEILING (#90): the SECOND, IP-keyed bucket behind the
# per-ACCOUNT `:api` bucket — one budget per client IP, so a single IP cannot
# hammer the authenticated surface with a churn of many accounts. It sits far
# above one account's budget (`50/10s`, declared on the `:api_auth` pipeline
# in router.ex): ten accounts at full budget — a large office NAT — stay under
# it. Accessor: Cytale.Config.rate_limit_ip_ceiling/1; the production table
# and the raise-lever: docs/self-hosting.md ("Rate limits").
config :cytale, rate_limit_ip_ceilings: [api: 500]

# Consistency / driver knobs are validated in runtime.exs because they come from
# the environment; compile-time defaults are as innocent as possible.

# Search: `search_index_root` and `search_commit_interval_ms` are runtime-owned
# (SEARCH_INDEX_ROOT / SEARCH_COMMIT_INTERVAL_MS in config/runtime.exs).
config :cytale, Cytale.Config,
  # #89: rebuild/reconcile page size (one ScyllaDB read, one commit and one
  # telemetry event per page) and the drift check's sampling bounds. The
  # accessors clamp all three; environment overrides are read at boot. (These
  # keys are NOT written by runtime.exs, so these defaults are live.)
  search_rebuild_page_size: 500,
  search_drift_sample_limit: 500,
  search_drift_content_limit: 25

# ----- Phoenix endpoint -------------------------------------------------------

config :cytale, CytaleWeb.Endpoint,
  url: [host: "localhost"],
  render_errors: [formats: [json: CytaleWeb.ErrorJSON], root: nil],
  secret_key_base:
    "6hTZNILeGKHD9dPYEGjOQwvBEcLYDIWS7WEaVZxgXAAcrWQFPDFiIZfKnbFxJsCb" <>
      "u32OU+FHTpS/mTCkutCyPg==",
  adapter: Bandit.PhoenixAdapter,
  live_view: [signing_salt: "cytalelv"],
  # Server is ON for every environment: tests drive real HTTP round-trips
  # against the endpoint (U4 health-check scenario).
  server: true,
  http: [port: 4000]

config :logger, level: :info

# Request-id traceability (#88): `Plug.RequestId` stamps every request with an
# id and puts it in the Logger metadata as `:request_id`, but Elixir's default
# formatter prints NO metadata — so the id existed and was invisible in the log
# text. A client that reports a failed call carries that same id (it reads it
# off the `x-request-id` response header), and the whole point of capturing it
# is that an operator can grep the logs for it and land on the failing request.
# This is the one line that makes that true; Plug.RequestId's own docs
# recommend exactly this setting.
config :logger, :default_formatter, metadata: [:request_id]

# Request-parameter redaction in Phoenix's request logs (Tier 3 B, 12b). A
# key CONTAINING any of these is logged as [FILTERED] — so "token" also covers
# refresh_token/access_token/resume_token, "password" covers new_password, and
# "code" covers 2FA codes and invite_code. Message bodies ("content") are
# members' private text and never belong in a log line.
config :phoenix, :filter_parameters, ~w(password token refresh_token content secret code grant credential)

# Production gateway authentication: U2's composite routes by prefix —
# `cytbot_` static tokens (machine principals) through the principals store,
# everything else to the human impl (`:human_impl`, defaulting to U9's JWT
# verifier inside Cytale.Gateway.Authenticator.Principal itself). :test keeps
# the same composite via config/test.exs and points :human_impl at the Stub
# so gateway wire tests keep their deterministic synthetic identities.
config :cytale, Cytale.Gateway.Authenticator, Cytale.Gateway.Authenticator.Principal

# Fan-out seam (U11): the workspace-process implementation serves dev/prod.
# :test overrides to Cytale.Publish.Log (hermetic suites) in config/test.exs.
config :cytale, Cytale.Publish, Cytale.Publish.WorkspaceProcess

# ----- Environment-specific overrides ----------------------------------------

import_config "#{config_env()}.exs"
