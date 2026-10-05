import Config

# Test environment: same server-on behavior as dev, isolated port so a running
# `mix phx.server` (dev, :4000) can never collide with the test run.
# CYTALE_TEST_PORT lets a second concurrent agent's suite take a different
# port instead of dying on :eaddrinuse (same checkout, TestNonce keyspaces).

config :cytale, CytaleWeb.Endpoint,
  http: [port: System.get_env("CYTALE_TEST_PORT", "4001") |> String.to_integer()],
  code_reloader: false,
  debug_errors: false

config :logger, level: :info

# U6: the Xandra pool stays OUT of the shared boot path in :test — the suite
# must stay hermetic; repo_test starts its own pool and drives the per-run
# `cytale_test` keyspace (drop + reapply schema, fully idempotent).
config :cytale, start_scylla_pool: false

# U11: hermetic suites publish through the logging impl; the workspace-process
# fan-out implementation is exercised in workspaces/workspace_test.exs (which
# re-wires the env for its own cases and restores it in on_exit).
config :cytale, Cytale.Publish, Cytale.Publish.Log

# U8: non-secret test defaults (real secrets come from runtime.exs in prod).
config :cytale,
  auth: [
    jwt_secret: "test-only-jwt-secret-do-not-ship",
    refresh_pepper: "test-only-refresh-pepper-do-not-ship"
  ]

# CYTALE_TEST_KEYSPACE lets a second concurrent agent's suite take its OWN
# keyspace instead of dropping the shared one out from under the first (the
# drop+reapply at boot is per-keyspace; same-name runs still collide, so
# concurrent agents MUST namespace — pair with CYTALE_TEST_PORT).
config :cytale, Cytale.Config,
  scylla_nodes: [~c"127.0.0.1:9042"],
  scylla_keyspace: System.get_env("CYTALE_TEST_KEYSPACE", "cytale_test"),
  # The index writers' background self-heal (review #24) replays messages the
  # suites wrote without indexing on purpose; its own tests drive it directly.
  search_reconcile_interval_ms: 0

# Gateway auth (U2, bots plan): the Principal composite is the top-level
# authenticator here too — `cytbot_` machine credentials resolve real
# principals, while the human half routes to the deterministic Stub (U10
# lifecycle tests mint no JWTs; Prod/dev default :human_impl to the JWT
# verifier inside the composite module).
config :cytale, Cytale.Gateway.Authenticator, Cytale.Gateway.Authenticator.Principal
config :cytale, :human_impl, Cytale.Gateway.Authenticator.Stub

# B2: the pre-auth per-IP flood dam ships at 30/10s in production; the
# hermetic suite raises it because EVERY request — across all async modules —
# shares 127.0.0.1, and the per-principal buckets are the limit under test.
# The dam's own 429 behavior is exercised deterministically by seeding the
# bucket table (the pipeline_test pattern).
config :cytale, compat: [preauth_ip_limit: 10_000]

# Gateway abuse bounds (Tier 3 B, finding 5): the suites share ONE stub
# identity (`GatewayCase.valid_token/0`) and one socket per scenario, so the
# production per-user session cap, per-socket frame budget and presence
# throttle would trip across unrelated tests. They are lifted here; the
# gateway abuse-limit suite lowers each one explicitly and restores it.
config :cytale,
  gateway: [native_session_cap: 100_000, frame_budget: 1_000_000, presence_budget: 1_000_000]

# Same shared-IP story for the native plug buckets: the auth surface's
# per-IP :auth bucket (30/10s in prod, S-P1-6) would trip across async
# modules hammering register/login. The plug reads the override at call
# time; the 429 behavior itself is tested in the rate-limit plug suite.
#
# Effectively UNBOUNDED, not just "raised": the native table is owned by the
# long-lived RateTables GenServer (#90 — it used to die with whichever request
# process created it, which silently reset every counter between tests), so
# these per-127.0.0.1 counters now accumulate across the WHOLE run. Any finite
# value would make the suite fail by request budget rather than by behaviour.
#
# `client_errors` (#88) joins the list for the same reason: the ingest bucket
# ships at a deliberately tight 10/60s per IP, and every test request shares
# 127.0.0.1. Its own 429 is exercised deterministically by seeding the bucket
# table (the pipeline_test/rate_limit_plug_test pattern), never by exhausting
# this shared counter.
config :cytale, rate_limit_overrides: [auth: 1_000_000, api: 1_000_000, client_errors: 1_000_000]

# ...and the same for the per-IP CEILING behind the authenticated bucket
# (#90): one IP-keyed budget shared by every module's requests. The ceiling's
# own 429 is exercised in the rate-limit plug suite, against a test-only bucket
# (never by exhausting this one).
config :cytale, rate_limit_ip_ceilings: [api: 1_000_000]

# ...and the send budget (`Cytale.Config.send_budget/0`): suites send in
# bursts far past a person's pace. The budget's own 429s are exercised by
# narrowing it inside the test that asserts them.
config :cytale, send_budget: [conversation: {1_000_000, 5_000}, principal: {1_000_000, 5_000}]

# The mailer adapter is the Dev mailbox in every non-prod env (explicit
# here to mirror runtime.exs's prod fail-fast: :prod requires the
# CYTALE_MAILER=dev opt-in or a real adapter).
config :cytale, Cytale.Accounts.Mailer, adapter: Cytale.Accounts.Mailer.Dev

# Voice (U2, voice plan): hermetic loopback-only ICE — the suite must never
# emit STUN/TURN egress; host candidates over 127.0.0.1 are all a test VM
# ever needs (runtime.exs still merges over this, appending TURN only if the
# runner environment sets the full CYTALE_TURN_* trio — which it must not).
config :cytale,
  calls: [
    media_udp_port_range: {50_000, 50_999},
    ice_servers: []
  ]

# WebAuthn passkeys (#36): the suite drives the ceremonies against FIXED RP
# configuration — the software-authenticator fixtures sign exactly this origin
# and RP ID, and wax string-matches the client-data origin against this list.
# Modules testing the DISABLED posture flip `[:webauthn, :enabled]` in-process
# and restore it (the standard put_env pattern).
config :cytale, :webauthn,
  enabled: true,
  rp_id: "localhost",
  origins: ["http://localhost:4001"]

# Web push (notifications plan U6, H-8): the dev pair moved OUT of
# runtime.exs into config/dev.exs, so the suite pins its own EXPLICIT copy
# here instead of leaning on a runtime fallback. The values are the same
# development fixture pair dev.exs uses (a public-ish test credential, not a
# secret); push_key_controller_test reads the configured key through the
# real route.
config :web_push_ex, :vapid,
  private_key: "X2ahFALA9k-7fEOxS5lgS0cclJv0yZJfyQPTh8qmbUI",
  public_key: "BEQvU93maFHTu19KHfUNqlP6KiI5U7L6teTDmalu4gVPWIKnLOrZSiGXJsUN9TnjkCeVjGINoSDDN3ek0-Cla54",
  subject: "mailto:admin@localhost"

# S1 (SSRF guard): the suite must never touch DNS. The default test resolver
# answers every name with a TEST-NET-1 address (public by the guard's
# classification, reserved by IANA — no real system owns it); individual
# tests override with their own stub (the standard put_env pattern) to
# exercise loopback / link-local refusals.
config :cytale, push_endpoint_resolver: &Cytale.PushResolverStub.resolve/1

# The media proxy never touches real DNS in the suite: every name is
# unresolvable unless a test installs its own resolver (Cytale.MediaProxyStub
# points names at its local server). Proxy URL MINTING never resolves.
config :cytale, media_proxy_resolver: &Cytale.MediaProxyStub.no_dns/1
