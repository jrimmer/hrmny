import Config

# Dev-profile values for :cytale. Environment-dependent knobs (ports, nodes,
# secrets) live in runtime.exs so the release can be reconfigured without a
# rebuild.

config :cytale, CytaleWeb.Endpoint,
  http: [port: 4000],
  code_reloader: false,
  debug_errors: false

# ScyllaDB contact points for the dev database (central container comes up at
# U6; until then Xandra is only configured, never connected).
# U6: dev applies (idempotently) and verifies the ScyllaDB schema at boot.
# Test keeps the pool out of the boot path; prod applies via the migration
# script, never at boot.
#
# On by default so a fresh clone self-heals its keyspace, but every
# `mix phx.server` restart pays it — 41 schema statements plus the
# system_schema diff (see Migrations.live_schema/0). Once the schema is known
# good, CYTALE_APPLY_SCHEMA_ON_BOOT=0 makes a restart skip the round trips
# entirely. Set it back to 1 (or drop it) after editing priv/scylla_schema.cql.
config :cytale,
  apply_scylla_schema_on_boot: System.get_env("CYTALE_APPLY_SCHEMA_ON_BOOT", "1") not in ["0", "false"]

# Dev-loop hygiene: warn at boot when the node has accumulated far more
# keyspaces than a healthy dev database (leaked test keyspaces make ScyllaDB's
# boot slow enough to block all dev work — see "Dev-loop database hygiene" in
# AGENTS.md). Dev-only: a release has no use for it.
config :cytale, warn_on_scylla_keyspace_bloat: true

# U8: dev-mode defaults (real secrets come from runtime.exs / env in prod).
config :cytale,
  auth: [
    jwt_secret: "dev-only-jwt-secret-do-not-ship",
    refresh_pepper: "dev-only-refresh-pepper-do-not-ship"
  ]

config :cytale, Cytale.Config, scylla_nodes: [~c"127.0.0.1:9042"]

# WebAuthn passkeys (#36): dev opts in (runtime.exs's CYTALE_AUTH_PASSKEYS
# default is false for deploys). RP ID + origins DERIVE — no external_base_url
# in dev means rp_id "localhost" and the loopback origin allowlist, which is
# exactly the dev browser's origin (localhost is a secure context).
config :cytale, :webauthn, enabled: true

# Dev mailer is the Dev mailbox explicitly (runtime.exs fails prod boots
# that never opted in: CYTALE_MAILER=dev is the explicit local posture).
config :cytale, Cytale.Accounts.Mailer, adapter: Cytale.Accounts.Mailer.Dev

# Voice (U2, voice plan): dev runs loopback-only ICE — host candidates on the
# local network need no STUN, and TURN stays off (runtime.exs appends a TURN
# entry only when the full CYTALE_TURN_* trio is set). The UDP range matches
# the span the deploy kit publishes on the app container (KTD2 → U12).
config :cytale,
  calls: [
    media_udp_port_range: {50_000, 50_999},
    ice_servers: []
  ]

# Web push (notifications plan U6, H-8): the DEVELOPMENT VAPID keypair lives
# here, not in runtime.exs. It is not a secret in any meaningful sense — it
# authorizes pushes only to subscriptions created against this same dev
# instance — and prod deliberately has no default, so a real deploy cannot
# accidentally sign with a key from the repository. runtime.exs still applies
# the CYTALE_VAPID_* env overrides per half, over this pair.
config :web_push_ex, :vapid,
  private_key: "X2ahFALA9k-7fEOxS5lgS0cclJv0yZJfyQPTh8qmbUI",
  public_key: "BEQvU93maFHTu19KHfUNqlP6KiI5U7L6teTDmalu4gVPWIKnLOrZSiGXJsUN9TnjkCeVjGINoSDDN3ek0-Cla54",
  subject: "mailto:admin@localhost"

# The sender, switched on only when it can actually sign.
config :cytale, Cytale.Notifications.Delivery, Cytale.Notifications.Delivery.Push

# CSP (S8): dev grows connect-src with the localhost websocket forms
# (ws://localhost:* wss://localhost:*) so the SPA can reach a local gateway on
# an arbitrary port. Never set outside dev — see Cytale.Config.
config :cytale, security_headers: [localhost_ws_origins: true]
