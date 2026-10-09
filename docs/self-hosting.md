# Self-hosting Hrmny — portable single-node (Docker Compose)

This is the self-hosting path (root `Dockerfile` + `compose.yaml`): one image
serving the SPA, REST API and gateway from one origin on :4000, fronted by
Caddy for TLS.

Topology (all on the default compose network, plus one dedicated network for
the terminal — see ["SSH host"](#ssh-host-terminal-client)):

```
internet ── 80/443 ── caddy (TLS, ACME) ── cytale:4000 ── scylladb:9042
                        (signaling only)        │
             3478/tcp+udp ── eturnal (TURN) ◀───┤ relay when direct UDP fails
             50000-50099/udp ── cytale (media)  │
                                                │
             2222/tcp ── ssh-host ──── 4100 ──▶ cytale (the bridge, internal)
              (published)   │              ssh-net 172.31.240.0/24:
                            │              app + host ONLY — the bridge is
                            │              never published, never on the edge
                            └── one terminal client process per session

                              volumes: attachments/ search/ (stateful paths)
```

Media NEVER traverses Caddy — only the TLS gateway (signaling) does. The SSH
bridge never traverses Caddy either: it is its own listener on the dedicated
network, and Caddy's denial of its path is the second layer rather than the
control.

## Deploying from the published images

The project publishes two container images to the GitHub Container Registry,
built by the repository's GitHub Actions workflows:

- `ghcr.io/jrimmer/hrmny`: the app (SPA + Phoenix release + NIFs, built from
  `Dockerfile.runtime`, which is the root `Dockerfile`'s runtime stage);
- `ghcr.io/jrimmer/hrmny-ssh-host`: the SSH host for the terminal client
  (built from `Dockerfile.ssh-host`; Go and Node are build stages inside the
  image).

`compose.yaml` defaults to `ghcr.io/jrimmer/hrmny:latest` and
`ghcr.io/jrimmer/hrmny-ssh-host:latest`. The images are public, so no
`docker login` is needed. A deploy target therefore needs Docker and nothing
else (no Elixir, no Rust, no Node — the image is self-contained):

```bash
git clone https://github.com/jrimmer/hrmny.git && cd hrmny
cp .env.example .env                   # fill in secrets (see First deploy)
docker compose pull
docker compose up -d
```

Subsequent updates are `git pull && docker compose pull && docker compose
up -d` — pull takes seconds-to-minutes; nothing compiles on the host.

**Pinning and rollback.** `:latest` follows `main`. To run a known version,
or to roll back, pin a tag in `.env` and `up -d` again:

```bash
# .env
CYTALE_IMAGE=ghcr.io/jrimmer/hrmny:<tag>
CYTALE_SSH_HOST_IMAGE=ghcr.io/jrimmer/hrmny-ssh-host:<tag>
```

Pin the tag of the last known-good build; `CYTALE_SSH_HOST_IMAGE` does the
same for the terminal's image. Keep the checkout at the matching revision too,
because `compose.yaml`, `deploy/` and `.env.example` travel with the code.

Internal identifiers (environment variables `CYTALE_*`, the `cytale` compose
service and keyspace) still use the project's former codename, cytale; a
rename is planned.

### Building the images yourself

`docker compose up -d --build` builds locally from the root `Dockerfile`
(BuildKit cache mounts keep redeploys incremental on a warm host). The two
paths produce the same artifact: `Dockerfile.runtime` is the root
Dockerfile's runtime stage verbatim — keep them in sync. To publish your own
build to your own registry, point `CYTALE_IMAGE` / `CYTALE_SSH_HOST_IMAGE` at
it.

The Dockerfiles take one optional build argument, `BUILD_NAMESERVERS`
(comma-separated, empty by default). Leave it unset; it exists only for
builders whose sandbox cannot resolve DNS on its own.

## Prerequisites

- A host with Docker Engine + the compose plugin (`docker compose version`).
  Compose ≥ 2.24 if you use the local override (it uses the `!override` tag).
- DNS: an A record `chat.example.com` → the host's public IPv4.
- Firewall: ports 80 and 443 reachable from the internet (the ACME HTTP-01
  challenge needs 80; serving needs both). Port 4000 and 9042 are NOT
  published — everything stays on the internal compose network. Voice calls
  additionally publish UDP directly — see ["Voice calls"](#voice-calls). The
  terminal additionally publishes exactly one TCP port (2222 by default) —
  see ["SSH host"](#ssh-host-terminal-client).
- ~4 GB RAM free: Scylla is capped at 3 GB (`mem_limit: 3g`, `--memory
  1200M`, `--smp 2` — sized for a small host; do not raise it there). The limit sits well above seastar's `--memory` on purpose:
  cgroup page cache counts against it.
- Linux hosts: raise the async-io context cap (standard Scylla OS prep —
  boot fails otherwise with "minimum AIO requirements"):
  ```bash
  echo fs.aio-max-nr=1048576 | sudo tee /etc/sysctl.d/99-cytale-aio.conf
  sudo sysctl --system
  ```
  On a Mac used for verification, the same must be raised inside the Docker
  Desktop VM: `docker run --privileged --rm alpine sysctl -w
  fs.aio-max-nr=1048576` (VM-global, resets on Docker restart).

## First deploy

```bash
cp .env.example .env
# fill in the three secrets, e.g.:
#   openssl rand -base64 48   # SECRET_KEY_BASE
#   openssl rand -base64 48   # AUTH_JWT_SECRET
#   openssl rand -base64 48   # AUTH_REFRESH_PEPPER
# plus CYTALE_DOMAIN / ACME_EMAIL (required by the caddy service)
# (CYTALE_EXTERNAL_BASE_URL, e.g. https://chat.example.com, is optional)

# EITHER run the published images (see "Deploying from the published images"):
docker compose pull && docker compose up -d

# OR build from this checkout. CYTALE_VERSION is optional but recommended
# for a local build: the image build has no .git (excluded from the build
# context) and no git binary, so without it the rail's version badge reads
# "vdev" instead of the commit.
CYTALE_VERSION=$(git rev-parse --short=7 HEAD) docker compose up -d --build
```

First boot, in order:

1. `scylladb` becomes healthy (nodetool reports the node UN; ~1–2 min).
2. `cytale` starts. With `CYTALE_APPLY_SCHEMA_ON_BOOT=true` (default in
   `.env.example`) the boot runs `Cytale.Migrations.apply!` then `verify!` —
   every statement in `priv/scylla_schema.cql` is `IF NOT EXISTS`, so this
   is idempotent on every start and converges a fresh volume. Verify raises
   loudly on drift instead of serving queries against a wrong schema.
3. `caddy` starts once cytale is healthy and issues a Let's Encrypt
   certificate for `{$CYTALE_DOMAIN}` (ACME account `{$ACME_EMAIL}`).

**The first account.** Sign-up is invite-only by default (see
["Sign-up"](#sign-up-invite-only-by-default)), and an invite needs a workspace,
which needs an account. And the first boot writes `/etc/cytale/config.json`
(the `server_config` volume) from `.env`, after which **the file wins** for
most settings: removing `CYTALE_REGISTRATION_OPEN` from `.env` later does not
close sign-up. So:

1. Before the first boot, set `CYTALE_REGISTRATION_OPEN=true` in `.env`.
2. Boot, register your account in the web app, and note your account id
   (`GET /api/v1/users/@me` → `user.id`).
3. Put that id in `CYTALE_ADMIN_USER_IDS` in `.env` and `docker compose up -d`.
   This setting always adds operators, even after the first boot.
4. Sign in again and open Server Settings: turn `registration_open` off.
   Sign-up is invite-only from here; create your workspace and invite
   everyone else.

Operators named in `CYTALE_ADMIN_USER_IDS` cannot be removed from Server
Settings. To revoke an operator (a compromised account, say), delete the id
from `.env` **and** from Server Settings, then `docker compose up -d`.

Fail-fast: if `SECRET_KEY_BASE` / `AUTH_JWT_SECRET` / `AUTH_REFRESH_PEPPER`
are missing or short, the release refuses to boot with an explicit
`ArgumentError` naming the variable — check `docker compose logs cytale`.

The terminal is OFF by default and costs nothing until it is provisioned:
`CYTALE_SSH_CERTIFICATES_ENABLED` and `CYTALE_SESSION_BRIDGE_ENABLED` are
false in `.env.example`, the CA key is never read while they are, and the
`ssh-host` service reports what it is missing instead of stopping anything
else. To turn it on, provision the secret material FIRST and flip both
switches after — a CA flag with no readable key is a boot failure by design
(see ["SSH host"](#ssh-host-terminal-client) → provisioning, which orders it).

### Pre-existing keyspace warning

`apply!` creates missing TABLES but never ALTERs existing ones. If you point
this deploy at a keyspace that predates 2026-09-06, `verify!` will fail boot
on the denormalized `last_message_id` column. One-off fix (cqlsh against the
existing cluster), then restart:

```sql
ALTER TABLE cytale.dm_channels ADD last_message_id bigint;
-- same one-off for the other two tables carrying the column:
ALTER TABLE cytale.channels      ADD last_message_id bigint;
ALTER TABLE cytale.channels_by_id ADD last_message_id bigint;
```

(Alternatively set `CYTALE_APPLY_SCHEMA_ON_BOOT=false` and keep applying the
schema out-of-band — but the ALTERs are the actual repair.)

### HSTS

`deploy/Caddyfile` sends `Strict-Transport-Security: max-age=31536000;
includeSubDomains` on every response of the site: after one HTTPS visit a
browser refuses plain HTTP to `CYTALE_DOMAIN` and every name under it for a
year. That is a one-way door — before pointing a new domain at this kit, make
sure every subdomain of it serves HTTPS, and do not shorten `max-age` expecting
browsers to forget sooner. Behind an external edge (`CYTALE_EDGE_SCHEME=http`)
the header passes through the edge to the browser; if the edge already sets
its own HSTS, keep the two identical. Check:
`curl -sI https://chat.example.com/ | grep -i strict-transport`.

## Verify the deployment

```bash
curl -fsS https://chat.example.com/health
# {"status":"ok","version":"1.0.2"}  (no node identity)

curl -fsS https://chat.example.com/ | grep -o '<title>Hrmny</title>'
# <title>Hrmny</title>

# register + login round-trip. Sign-up is INVITE-ONLY by default in prod
# (registration_open=false): without an invite this is
#   403 {"error":{"key":"registration_closed",...}}
# so pass a live invite code (create one from any workspace's invite dialog);
# the account is made AND joins that workspace:
curl -fsS -X POST https://chat.example.com/api/v1/auth/register \
  -H 'content-type: application/json' \
  -d '{"username":"smoke1","email":"smoke1@example.com","password":"super-secret-9","invite_code":"<code>"}'
# 201 + tokens + "invite_accepted":true   (a dead code: 403 invite_invalid)

curl -fsS -X POST https://chat.example.com/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"identifier":"smoke1","password":"super-secret-9"}'
# 200 + tokens

# gateway WS handshake (a real upgrade, not just a route check):
curl --include --no-buffer \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  'https://chat.example.com/gateway/websocket?v=10&encoding=json'
# HTTP/2 101 (switching protocols) — kill curl after the status line.
```

Without TLS (local box): the same probes against `http://127.0.0.1:4000`
via the local override — see below.

The discord.js compat harness (`pnpm compat:check`) spawns its OWN server
from the checkout on `COMPAT_PORT` (default 4130) against local Scylla — it
does not target a deployed origin (BASE is fixed to 127.0.0.1). Use it to
validate the revision being deployed; use the curl probes above against the
live origin.

The terminal's smoke test is its own, and it is the only proof that the SSH
path works end to end: a real `ssh` client reaching the two-column shell. See
["SSH host"](#ssh-host-terminal-client) below — `scripts/ssh-host-e2e.sh` runs
it and fails loudly when its prerequisites are missing.

### Local (no caddy / no TLS)

Compose checks every service's variables even when it starts only some of
them, so `CYTALE_DOMAIN` and `ACME_EMAIL` must still be set here; any
placeholder works (`chat.example.com`, `admin@example.com`) because Caddy is
not started.

```bash
# .env still needed (secrets); publish the app on 127.0.0.1:4000 only:
docker compose -f compose.yaml -f deploy/compose.local.yml up -d scylladb cytale
curl -s http://127.0.0.1:4000/health

# THROWAWAY teardown — deletes the volumes; never run against real data:
docker compose -f compose.yaml -f deploy/compose.local.yml down -v
```

## Operations

```bash
docker compose logs -f cytale        # app logs (boot, schema apply, requests)
docker compose logs -f scylladb
docker compose logs -f eturnal       # TURN: allocations, auth, relay range
docker compose logs -f ssh-host      # terminal: listens line, session starts/ends
docker compose restart cytale        # bounce the app only
docker compose ps                    # health of all services

# upgrade (published images):
git pull && docker compose pull && docker compose up -d
# upgrade (local build from the current checkout):
git pull && docker compose up -d --build
```

The image is self-contained (SPA + release + NIFs), so an upgrade is always
a pull (or rebuild) + recreate; no in-place steps. Rolling back = pin the
previous image tag (`CYTALE_IMAGE`, see "Deploying from the published
images") or rebuild the previous revision.

PWA note: the service worker is generated by
vite-plugin-pwa (`generateSW`, `registerType: autoUpdate`) and its precache
manifest is content-hashed per build — a new image carries a new SW and
clients pick it up on their next load; there is no manual version bump, but
already-open tabs serve the previous shell until they reload.

### ScyllaDB pool + read retries

The app's Scylla connection pool defaults to `max(CPU schedulers online, 10)`
(one connection per scheduler, floor 10 for a small box); set
`SCYLLA_POOL_SIZE` to pin it. Read queries that fail transiently
(`read_timeout` / `unavailable` / `overloaded` / `server_error` / connection
errors) are retried inside the app up to `CYTALE_REPO_READ_RETRIES` times
(default 2, `0` disables, linear backoff) before a failure answers
`503 Service Unavailable` with `Retry-After: 1`; writes are never retried —
their outcome after a failure is unknown, so a retry could duplicate them.

### Sign-up (invite-only by default)

`registration_open` defaults to **false** in production: `POST
/api/v1/auth/register` accepts only a body carrying a valid, unexpired,
not-used-up `invite_code`, and the new account joins that workspace through
the normal invite accept (the invite's `max_uses` seat is consumed). The web
sign-up page sends the code of the invite link the visitor arrived through;
without one it explains that sign-up is by invitation. Keep it closed until a
real mailer is configured — with the Dev mailer no one can verify an email, so
open sign-up is only a spam door. To open it: Server Settings →
`registration_open`, or `CYTALE_REGISTRATION_OPEN=true` on a node that has no
`/etc/cytale/config.json` yet (once that file exists, its value wins over the
environment).

### Single sign-on (OIDC)

One OpenID Connect provider per deployment can be offered as a third sign-in
path beside password and passkey (authorization-code grant with PKCE,
server-mediated). It is off by default. Configure it in Server Settings, or
bootstrap it from the environment (file wins over env once
`/etc/cytale/config.json` exists, as for sign-up above):

```bash
# .env
CYTALE_OIDC_ENABLED=true
CYTALE_OIDC_ISSUER_URL=https://idp.example.com/realms/main
CYTALE_OIDC_CLIENT_ID=hrmny
CYTALE_OIDC_CLIENT_SECRET=...            # a secret: never in config.json
# CYTALE_OIDC_SCOPES="openid email profile"   (default)
# CYTALE_OIDC_BUTTON_LABEL="Sign in with SSO"  (default)
```

Register `https://chat.example.com/auth/oidc/callback` as the redirect URI at
the provider (it is built from the external origin, so set
`CYTALE_EXTERNAL_BASE_URL` if the app cannot derive it from the request).
Accounts are linked by a provider-asserted **verified** email: an ID token
without `email_verified: true` is refused, and an existing local account is
signed into only when it has verified that address itself. A new identity
gets an account on first sign-in only while sign-up is open. The full policy is
in `apps/server/lib/cytale/oidc.ex`.

### Rate limits (thresholds and the levers)

Every limiter is a fixed window in ETS. An exhausted one answers `429` with
`Retry-After` and a body whose message NAMES the limit that tripped (account
vs. shared per-IP) and the retry hint; the server logs the offending bucket
on the way out:

```
rate limit tripped bucket=api scope=account key={:api, {:user, 42}} window_ms=10000 limit=50 count=51 retry_ms=9300
```

so a lockout is diagnosable from the log line alone — bucket, key and window
are all there. The web client renders a 429 as "slow down" copy, never as a
credential failure.

| Surface | Bucket | Keyed on | Production value |
| --- | --- | --- | --- |
| `/api/v1` authenticated | `:api` | the account id | **50 / 10s per account** (message sends excepted — see the send budget) |
| message sends, native AND compat | send budget (`CytaleWeb.Plugs.SendBudget`) | the sender (person or bot) × conversation · the sender | **10 / 5s per conversation · 20 / 5s per sender** (`config :cytale, send_budget`) |
| `/api/v1` authenticated | `:api_ip_ceiling` | the client IP | **500 / 10s per IP** |
| `/api/v1/auth/*` (login, register, refresh, reset) | `:auth` | the client IP | 30 / 10s per IP |
| login failure dam (`AttemptGuard`) | per identifier × client network · per identifier | the submitted identifier + client IP (/64) · the identifier | 10 fails / 15 min → 15-min lock of THAT network · 100 fails / 15 min → 15-min lock of every network that has not logged in to it in the last 30 days |
| public invite resolve `/api/v1/invites/{code}` | `:api` | the client IP | 50 / 10s per IP |
| compat `/api/v10` + `/api` route buckets | per route template | the bot/agent | 10/5s · 25/10s · 50/10s by route class (sends ride the send budget) |
| compat pre-auth flood dam | pre-auth IP | the client IP | 30 / 10s per IP |
| gateway Identify / Resume | kind × IP | the client IP | 30 / 10s · 60 / 10s |
| webhook execute / miss dam | per token · per IP | the token pair · the client IP | 5 / 2s · 30 / 10s |
| interaction callback / post | per token · per app | the interaction · the application | 10 / 15 min · 10 / 5s |

**Which address is "the client IP".** Caddy is the TCP peer of every request,
so the app derives the client from `X-Forwarded-For` — but ONLY when the peer
is a trusted proxy (`CYTALE_TRUSTED_PROXIES`, comma-separated CIDRs; default
loopback + `10/8`, `172.16/12`, `192.168/16`, `fc00::/7`, which always
contains the compose network and never an internet client). The header is
read right to left and the first untrusted hop is the client, so entries a
client prepends are ignored. The same address feeds every per-IP bucket below
and the gateway's Identify/Resume admission. Set the variable EMPTY to ignore
the header entirely (app exposed with no proxy). With an external edge in
front of this Caddy (`CYTALE_EDGE_SCHEME=http`), `deploy/Caddyfile` trusts
private-range peers (`trusted_proxies static private_ranges`) so the edge's
`X-Forwarded-For` survives the second hop; an edge on a PUBLIC address must be
added there and to `CYTALE_TRUSTED_PROXIES`. Check it: a 429 log line's `key=`
must name the caller's public address, never `172.x` — if it names the Docker
bridge gateway, Docker's userland proxy is rewriting the source (typically
IPv6 publishes) and every such client shares one bucket.

**Why the two-keying**: a team behind one NAT (office, VPN, CGNAT) used to
share ONE budget on the authenticated surface, so a few people refreshing at
once 429'd each other. `/api/v1` is now keyed per ACCOUNT with the
per-IP `:api_ip_ceiling` kept behind it (so one IP still can't hammer with a
churn of accounts). The PRE-AUTH surface (`/auth/*`, the compat dam, the
webhook miss dam) stays per-IP deliberately: there is no principal to key on
before authentication, and that dam is the brute-force protection — do not
loosen it, raise it.

IPv6 clients are keyed by `/64` prefix, not by address (per-address keying is
bypassed for free by rotating the low 64 bits). A large /64 or a large NAT
therefore shares one budget — that is the intended reading of "one network",
and the lever is the limit below.

**Raising them.** All of these are live config reads, so they can be set in
`config/config.exs` (baked at build) or `config/runtime.exs` (from your own
env var, applied at boot — no rebuild):

```elixir
# the authenticated budget and the ceiling behind it
config :cytale, rate_limit_overrides: [auth: 300, api: 500]
config :cytale, rate_limit_ip_ceilings: [api: 2_000]

# the compat flood dam and the compat route classes
config :cytale, compat: [preauth_ip_limit: 300]
config :cytale, compat: [route_class_limits: [read: {200, 10_000}]]
```

A NAT of N active teammates wants roughly `N × 50` for `:api_ip_ceiling`
(the ceiling, not the per-account budget) before anything else moves; raise
`:auth` too if a whole floor logs in within the same 10-second window.

### Attachments (signed URLs)

Message attachments are served only through short-lived signed URLs:
`/api/v1/attachments/<sha256>?e=<unix expiry>&s=<HMAC>`. The server signs
every attachment URL each time it renders a message (REST pages, gateway
dispatches, compat, search, threads) with a key derived from
`SECRET_KEY_BASE`; the URL stays valid 24–25 hours (expiry rounded up to the
hour, so repeated renders within an hour produce the same, cacheable URL),
and the blob answers `Cache-Control: private` for no longer than that. An
unsigned or tampered URL is a 404, an expired one a 403 — a client refetches
the message to get a fresh URL. Rotating `SECRET_KEY_BASE` invalidates every
outstanding attachment URL (clients re-render on their next fetch).

Avatars and workspace icons are public profile media and keep their plain,
immutable `/api/v1/attachments/<sha256>` URLs. Uploads through the avatar/icon
endpoints are marked public in the store's `.public/` directory; avatars
uploaded before that marker existed are found by a one-time backfill (a scan of
`users.avatar_url` and `workspaces.icon_url`) the first time an unmarked blob is
requested, recorded by `.public/backfill-v1.done` on the attachments volume.

### Media proxy (external images)

The app's CSP is `img-src 'self' data: blob:`, so a browser never loads an
image from another host. External images a message shows — a bot's embed
image, thumbnail, author/footer icon, or a Markdown `![alt](url)` in any
message — are fetched by the server and served from this origin at
`/api/v1/media/proxy?u=<base64url url>&e=<expiry>&s=<HMAC>`. Viewers' IPs and
read times never reach the image's host, and the image is frozen as first
fetched.

- **Not an open proxy.** Only URLs the server signed while rendering a message
  are served (HMAC with a key derived from `SECRET_KEY_BASE`, its own salt).
  Signed URLs live as long as attachment URLs (24–25 h, rounded up to the
  hour); rotating `SECRET_KEY_BASE` invalidates them, and clients get fresh
  ones on their next fetch.
- **Outbound safety.** `http`/`https` only, ports 80/443/8080/8443, and every
  address the host resolves to must be public (no loopback, RFC 1918, CGNAT,
  link-local/metadata, multicast or reserved ranges; IPv4-mapped IPv6 is
  judged as the v4 it carries). The connection is pinned to the checked
  address (no second DNS lookup — DNS rebinding cannot swap it), each
  redirect (at most 3) is re-checked, connect/read timeouts are 5 s with a
  15 s ceiling, and no cookies or `Referer` are sent.
- **Images only.** The body is sniffed from its magic bytes — PNG, JPEG, GIF,
  WebP, AVIF; SVG and everything else is refused — and served with the
  sniffed `Content-Type`, `nosniff`, `Content-Disposition: inline` and a
  sandboxing CSP. A stated canvas over 50 megapixels (or 16384 px a side)
  is refused.
- **Cache.** Fetched images land in `<attachments root>/.media-cache/` (the
  attachments volume; a dot-directory the attachment byte counter and
  backups skip). Entries older than the TTL are refetched on next view; past
  the size cap the least-recently-viewed are evicted down to 90%; an hourly
  sweep drops expired entries. Failed fetches are remembered for 5 minutes,
  so a dead or hostile origin is asked once per window.
- **Metrics** on `/metrics`: `cytale_media_proxy_requests_total{result}`
  (`hit`/`miss`/`negative`/`refused`), `cytale_media_proxy_fetches_total{outcome}`
  (`ok`/`blocked`/`unsupported_type`/`too_large`/`too_many_pixels`/
  `upstream_error`/`timeout`), `cytale_media_proxy_bytes_total{direction}`
  (`fetched`/`served`) and the gauge `cytale_media_proxy_cache_bytes`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `CYTALE_MEDIA_PROXY_ENABLED` | `true` | `false` turns the proxy off: no proxy URLs are minted and the route answers 404, so external images stay hidden (the CSP still blocks them). |
| `CYTALE_MEDIA_PROXY_MAX_BYTES` | `10485760` (10 MB) | Largest image fetched; the download aborts past it. |
| `CYTALE_MEDIA_PROXY_CACHE_MAX_BYTES` | `1073741824` (1 GB) | Disk cache size cap (LRU eviction). Counts toward the attachments volume's free space, not its attachment cap. |
| `CYTALE_MEDIA_PROXY_CACHE_TTL_SECONDS` | `604800` (7 days) | How long a fetched image is served before it is fetched again. |
| `CYTALE_MEDIA_PROXY_CACHE_DIR` | `<attachments root>/.media-cache` | Where the cache lives, if not on the attachments volume. |

Operationally: a growing `fetches_total{outcome="blocked"}` means someone is
posting images that point at internal addresses (the guard is working); a
high `negative` rate with `upstream_error` usually means an origin that
blocks server-side fetches (hotlink protection).

### Backups

The app's own scheduler writes archives into `backups.dir`, which defaults to
`backups` (cwd-relative → `/app/backups`). compose.yaml mounts a dedicated
named volume there, so a DEFAULT deploy survives `docker compose up -d`:

- `cytale_backups` — the app's archives (`/app/backups`), plus the staged copy
  a restore makes. `docker compose config` should show
  `target: /app/backups` for the `cytale` service. If you override
  `backups.dir` in `/etc/cytale/config.json`, mount your own path — a custom
  directory without a volume is back to the failure this volume exists to
  prevent: the container's writable layer is destroyed on every upgrade, and
  because backups keep succeeding into the fresh directory the staleness alert
  never fires, so the RPO becomes unbounded while every probe stays green.

Verify the mount after any compose change:

```bash
docker compose config | grep -A2 'target: /app/backups'
```

State lives in these named volumes (`docker volume ls`):

- `cytale_scylla` — all data (messages, accounts, tokens). Snapshot
  properly: flush first, then file-copy the volume:
  ```bash
  docker compose exec scylladb nodetool flush
  docker run --rm -v cytale_scylla:/data -v "$PWD":/backup alpine \
    tar czf /backup/scylla-$(date +%F).tgz -C /data .
  ```
- `cytale_attachments` — content-addressed blobs (write-once, never
  mutated): a plain file-level copy is consistent by construction:
  ```bash
  docker run --rm -v cytale_attachments:/data -v "$PWD":/backup alpine \
    tar czf /backup/attachments-$(date +%F).tgz -C /data .
  ```
- `cytale_search` — the Tantivy index: rebuildable from Scylla; snapshot it
  only to skip a reindex on restore.

`caddy_data` holds the ACME account/certificates — back it up or accept
re-issuance on restore.

The terminal's secret directory (`CYTALE_SSH_SECRETS_DIR`, outside the volumes
on purpose — it is the operator's, not the stack's) is the one thing here whose
loss is not recoverable by rebuilding:

- `host_key` **must** be backed up. Losing it means generating a new one, and
  every member's pinned fingerprint then fails hard until they each re-verify
  the new one.
- `ca_key` is worth backing up: without it no certificate can be issued or
  re-issued (already-issued ones stay valid until they expire).
- `bridge_credential` is trivially recoverable — regenerate it and recreate
  both containers — so back it up only for convenience.

### Web push

Notifications are delivered over web push, signed with a VAPID keypair. **On a
by-the-book deploy push is silently OFF**: with the pair unset the app still
boots healthy and falls back to `Cytale.Notifications.Delivery.Log`, which
records the decision and sends nothing. The one signal is the
`cytale_push_enabled` gauge on `/metrics` (0 = logging only, 1 = signing).

Generate the pair once, from the repo root:

```bash
scripts/vapid-keys.sh > vapid.env      # generate a fresh pair + print the env block
scripts/vapid-keys.sh --check          # report whether the RUNNING config has keys
```

Put `CYTALE_VAPID_PRIVATE_KEY` and `CYTALE_VAPID_PUBLIC_KEY` into `.env`
(`config/runtime.exs` reads them in every environment; `CYTALE_VAPID_SUBJECT`
is optional and defaults to `mailto:admin@localhost`). The private key must be
valid base64url for a 32-byte P-256 scalar — a malformed one fails the boot
loudly rather than at the first send.

**Rotating the pair invalidates every existing subscription.** RFC 8292 binds
the key to a subscription at creation time, so a new pair silently stops every
browser that already subscribed, with no 404/410 for the sender to notice.
Generate once per instance and keep it with `SECRET_KEY_BASE`.

The pair is deliberately NOT part of the backup archive — it never enters
`secrets.json` (see `docs/restore-drill.md`), so a restore that regenerates the
environment must carry it over by hand.

Verify after a recreate:

```bash
scripts/vapid-keys.sh --check
# public key:  present (87 chars)
# private key: present (43 chars)
# delivery:    Cytale.Notifications.Delivery.Push
# => web push is ON.

# and, with CYTALE_METRICS_TOKEN set:
curl -s -H "Authorization: Bearer $CYTALE_METRICS_TOKEN" https://$CYTALE_DOMAIN/metrics | grep cytale_push_enabled
# cytale_push_enabled 1
```

## Voice calls

Voice (calls plan) adds the kit's first UDP surface: an `eturnal` TURN
service and the app's media port range, both published on the host. Media
flows peer↔app (UDP media range) and peer↔eturnal (TURN relay) directly —
Caddy stays signaling-only (`deploy/Caddyfile` documents this inline).

### Ports

| Port | Proto | Service | Purpose |
| --- | --- | --- | --- |
| 80/443 | tcp | caddy | Existing: TLS + ACME (unchanged). |
| 7880 | — | — | **Not used.** (LiveKit's default; listed to close the question — the media plane is embedded ex_webrtc.) |
| 3478 | tcp+udp | eturnal | STUN + TURN endpoint (`turn:host:3478`). UDP is the path media uses; TCP covers blocked-UDP networks. |
| 50000–50099 | udp | cytale | The app's ex_webrtc ICE media range — one port per server-side PeerConnection; sized for ~100 concurrent voice legs. **Must match `CYTALE_MEDIA_UDP_PORT_RANGE`.** |
| 51000–51099 | udp | eturnal | TURN RELAY range — one port per active allocation, published 1:1 (a relayed address carries the port, so host and container ports must match). Keep DISJOINT from the media range or the publishes collide. |
| 5349 | tcp+udp | eturnal | TLS TURN (`turns:`) — OFF by default; see "TLS escalation" below. |

### Environment (additions in `.env`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `CYTALE_MEDIA_UDP_PORT_RANGE` | `50000-50099` | The app's media span AND the range compose publishes — compose feeds the app from the SAME value it maps (`environment:` overrides `env_file:`), so the two cannot drift inside compose. A bare `docker run` must keep them in sync by hand (check below). |
| `CYTALE_TURN_URL` | `turn:chat.example.com:3478` | The TURN URL handed to clients — the PUBLIC address browsers reach, not the compose-internal name. |
| `ETURNAL_SECRET` | _(empty)_ | **Single source of truth for TURN auth.** Compose feeds it to eturnal (`ETURNAL_SECRET`, its REST-auth verifier) AND to the app (`CYTALE_TURN_SECRET`, the credential minter). Generate: `openssl rand -base64 32`. Empty = TURN off. |
| `ETURNAL_RELAY_MIN_PORT` / `ETURNAL_RELAY_MAX_PORT` | `51000` / `51099` | eturnal's relay span (the published 1:1 range). |
| `ETURNAL_RELAY_IPV4_ADDR` | _(autodetect)_ | Set the host's public IPv4 explicitly if eturnal's boot-time STUN autodetect cannot leave the host (log: `Cannot query stun...`). |

Sync requirements, in one place: (1) media range = app config = published
span; (2) the TURN secret is SHARED by the app and eturnal — one `.env`
value drives both; (3) relay range ≠ media range.

### Ephemeral TURN credentials (the auth model)

No static TURN password exists anywhere. The app MINTS short-lived
credentials on every read (`Cytale.Config.calls_ice_servers/0`, per
eturnal's REST-auth / draft-uberti-behave-turn-rest): username = unix
expiry timestamp (`now + 1h`), credential = `Base64(HMAC-SHA1(secret,
username))`. Clients fetch them at call-join time from the authenticated
`GET /api/v1/calls/ice` and feed the entry to their `RTCPeerConnection`;
the server's own media legs authenticate to eturnal with the same minted
pairs. Consequences operators care about:

- **The static secret never ships to clients** — only minted pairs do.
- **Expiry is enforced at ALLOCATION time only** (eturnal): a call that
  joined inside the 1h window keeps its relay past expiry; a NEW allocation
  with an expired username is rejected 401 (verified: `turn-check.exs
  --ttl -60` fails with 401).
- **Revocation/rotation = secret rotation**: change `ETURNAL_SECRET` in
  `.env` and `docker compose up -d` (recreates app + eturnal). Existing
  relays die with the old secret's container; clients re-join and re-mint.

### Local verification

```bash
# eturnal alone (no app build needed) via the shipped service definition:
docker compose up -d eturnal
docker compose logs eturnal | grep 'Listening on'   # STUN/TURN on 3478

# The committed TURN allocation check (mints a credential exactly like the
# app and performs a real Allocate handshake; exit 0 = PASS):
elixir deploy/turn-check.exs --host 127.0.0.1 --port 3478 \
  --secret "$(grep ^ETURNAL_SECRET .env | cut -d= -f2)"

# Negative controls (both must FAIL with 401):
elixir deploy/turn-check.exs --host 127.0.0.1 --secret wrong-secret
elixir deploy/turn-check.exs --host 127.0.0.1 --secret "$(...)" --ttl -60

# ICE-config delivery (register/login first; TURN entry only when the
# secret mode is configured):
curl -fsS -H "authorization: Bearer $TOKEN" https://chat.example.com/api/v1/calls/ice
# {"ice_servers":[{"urls":"turn:chat.example.com:3478","username":"...","credential":"..."}]}

docker compose rm -sf eturnal   # teardown the voice leg when done
```

`turn-check.exs` needs Elixir ≥ 1.15 and network on FIRST run only
(`Mix.install` fetches ex_turn/ex_stun, then caches). Verified with
eturnal 1.12.2-r5 on 2026-09-06: allocation created
(`Creating TURN allocation ... user <expiry-ts>, relay <ip>:<port>` in
eturnal's log) with the correct secret; 401 with a wrong secret; 401 with
an expired timestamp.

### Failure modes and checks

- **Port-range drift (config vs publish).** Symptom: signaling connects but
  media never leaves `connecting` — the app allocates ICE sockets on ports
  the host never published. Inside compose this cannot happen (one
  interpolation feeds both); a bare `docker run` can cause it. Check:
  `docker inspect cytale | grep -A2 50000` vs
  `docker compose exec cytale env | grep CYTALE_MEDIA_UDP_PORT_RANGE` — the
  spans must be identical.
- **Secret mismatch (app vs eturnal).** Symptom: TURN allocations 401 in
  `docker compose logs eturnal` while `GET /calls/ice` still returns
  entries. Check: both containers hold the same value —
  `docker compose exec cytale env | grep CYTALE_TURN_SECRET` and the
  `.env` `ETURNAL_SECRET` (eturnal reads it at boot only). Fix = recreate
  both (`docker compose up -d`).
- **Expired credential.** A client holding an ICE config older than 1h
  gets 401 on allocation — the app fetches fresh at every join, so this
  only bites long-lived custom clients. Re-join re-mints.
- **eturnal cannot resolve its public address.** Log: `Cannot query
  stun.conversations.im...`. Allocations then relay through an
  unroutable address. Fix: set `ETURNAL_RELAY_IPV4_ADDR` to the host's
  public IPv4.

### Relay peer denylist (`deploy/eturnal.yml`)

compose.yaml mounts `deploy/eturnal.yml` read-only at `/etc/eturnal.yml`. It
sets ONE policy — `blacklist_peers`: eturnal refuses to relay to loopback,
RFC 1918, link-local (cloud metadata), CGNAT, IPv6 loopback/ULA/link-local
and the compose networks (plus eturnal's own `recommended` list), so a TURN
credential cannot be turned into an SSRF into the host, the compose network
or the LAN. The pinned eturnal 1.12.2 already defaulted to that
`recommended` list; the file makes the policy explicit and version-proof.
Secret, relay range and relay address still come from the `ETURNAL_*`
variables — eturnal reads each only when the file leaves the option out, so
never add `secret`/`relay_*` keys there. A single-host test topology that pins
`ETURNAL_RELAY_IPV4_ADDR` to a PRIVATE address relays to itself through a
denied peer; such a test box needs a `whitelist_peers` entry for that one
address (never on a public deploy). Check after `docker compose up -d
eturnal`: `docker compose logs eturnal` shows `Listening on` for 3478 (a YAML
error aborts the boot with the offending option named), and
`deploy/turn-check.exs` still allocates.

### Docker networking note (honest topology caveat)

Under Docker bridge networking the app's ICE HOST candidates carry
container-internal addresses — published ports make host:port reachable,
but remote clients route reliably via the TURN path (both sides gather
relay candidates through eturnal, which advertises the host's public
address — this is why the secret/relay wiring above matters). Direct UDP
media works for same-host/loopback clients, and for all clients when the
app runs with `network_mode: host` on Linux (then unpublish the media
range — the sockets ARE the host's).

### TLS escalation (blocked-UDP networks)

For clients behind UDP-blocking networks, TLS TURN on 5349: provision
certs for the TURN hostname, mount them and add `tls_crt_file`/`tls_key_file`
(readable by uid 9000) plus a `tls` listener to `deploy/eturnal.yml`, uncomment the 5349
publishes in compose.yaml, and set `CYTALE_TURN_URL` to
`turns:host:5349`. The app mints credentials identically — only the URL
scheme/port change.

### Capacity re-run (the deploy-box numbers)

The project's voice capacity numbers were measured on an M3-class Mac during
the voice design spike. Your deploy box has a different core budget (Scylla
alone is pinned to 2 cores by `compose.yaml`). Before relying on capacity
assumptions, measure on the deploy box itself: the load harness in
`tools/load-test` drives real voice legs against a running server (see
`tools/load-test/README.md` and its voice scenarios).

### Rollback (voice off)

Voice is degradable without touching the rest of the stack:

1. Stop publishing UDP: remove/comment the `ports:` entries of `cytale`
   (media range) and the `eturnal` service block in compose.yaml — or
   `docker compose rm -sf eturnal` and stop exposing the media range.
2. Unset the TURN trio: blank `ETURNAL_SECRET` + `CYTALE_TURN_URL` in
   `.env`, then `docker compose up -d`.
3. The app boots healthy with `GET /calls/ice` → `{"ice_servers": []}`
   and media degrades to direct UDP host candidates (loopback /
   LAN-reachable topologies; verified: eturnal with an empty secret runs
   as a harmless STUN listener). Signaling, chat, and the call log are
   unaffected.

## SSH host (terminal client)

The terminal client (`apps/tui`) has no listening socket of its own: a member
reaches it over SSH, and the `ssh-host` service is what terminates that
connection. It verifies the member's OpenSSH **user certificate** — issued from
the web UI's SSH settings — exchanges the verified identity for a short-lived
access token through the session bridge, and spawns one client process per
connection with the token arriving on an inherited descriptor. The certificate
IS the login: no password prompt exists on this path, and the client takes its
server origin from host configuration, so a session cannot redirect a
freshly-minted token at a server of its choosing.

This is opt-in and degradable: with the two switches below false, nothing here
is read or started, and every other client is unaffected.

### How the pieces are placed

`ssh-host` joins exactly one network — a dedicated one nothing else is on — and
publishes exactly one port. The bridge it calls is a separate listener on that
same network, never published and never proxied.

| Piece | Address | Reachable from |
| --- | --- | --- |
| `ssh-host` SSH listener | container `:2222`, published as `${CYTALE_SSH_PORT:-2222}` | the internet |
| the session bridge (`POST /internal/ssh/session`) | `${CYTALE_SSH_BRIDGE_BIND:-172.31.240.2}:4100`, the app's address on `cytale_ssh-internal` | the `ssh-host` container only |
| the app's public listener | `cytale:4000` (shared network) | Caddy; the bridge path is not a route on it at all |

Three properties follow, and each is a control rather than a convention:

- **The bridge is not published** — no `ports:` entry anywhere maps 4100, so it
  is unreachable from the host's network interfaces.
- **The bridge binds the internal network's address, not `0.0.0.0`** — the app
  is also on the shared network (Caddy, ScyllaDB, eturnal live there), and a
  wildcard bind would put the bridge on that network too. The subnet and the
  bind address are the same interpolation, so they cannot drift; a drift is a
  loud boot failure (`cannot assign requested address`), never a silent
  publication.
- **The edge denial in `deploy/Caddyfile` is the second layer** — the bridge is
  not a route on the listener Caddy proxies (`CytaleWeb.BridgeServer` has its
  own route table), and the `respond 403` is there so a route added under
  `/internal/*` by mistake still never reaches the internet.

The dedicated network is `cytale_ssh-internal` (`172.31.240.0/24` by default):
only `cytale` and `ssh-host` are on it. It is deliberately **not** declared
`internal: true` — Docker does not install the port-forwarding rule for a
container whose only network is marked internal, so the host would boot and
listen while the published SSH port stayed refused (measured on this engine,
2026-09-13). The boundary that matters is membership plus the bind address, and
neither depends on that flag.

### Provisioning (once per deployment)

The operator provides one directory of secret material, mounted read-only into
both containers. Nothing about it is generated by the deployment, which is the
point: **the host key must not be regenerated**, or every member's pinned
fingerprint becomes a hard failure instead of a prompt (see below).

| File | Read by | Mode · owner | Notes |
| --- | --- | --- | --- |
| `ca_key` | the app (signing) | `0640 root:10001` | the CA private key; `ssh-keygen` writes it |
| `ca_key.pub` | the host (trust set) | `0644` | the CA **public** key: not a secret, stays on disk |
| `host_key` | the host (host key) | `0600 root:root` | the host's private key; **never regenerate** |
| `host_key.pub` | the published fingerprint only | `0644` | `ssh-keygen -lf` reads it |
| `bridge_credential` | the app + the host | `0640 root:10001` | the shared secret of the mint endpoint |

`10001` is the uid/gid the `ssh-host` container runs as, and it is the group
the app joins (`group_add`) so it can read the two files it needs in place. The
app runs as its own unprivileged user, so a `0644` file would also work — it is
just one secret more readable than it needs to be.

**On a Linux host** the modes above are what the containers see. **On Docker
Desktop (macOS/Windows)** a bind mount is presented as `root:root` with the
host's mode, so the group half of `0640` does not reach either container and the
app cannot read `ca_key` or `bridge_credential` at 0640. For a local trial,
loosen those two to `0644` (the host is unaffected — its entrypoint reads as
root — and the posture is only loosened on the machine running the trial).

```bash
# On a real deploy, keep this OUTSIDE the checkout (CYTALE_SSH_SECRETS_DIR).
# The in-tree default ./deploy/ssh is a local-trial convenience and is NOT
# covered by .gitignore: a committed CA key mints certificates for every account.
sudo install -d -m 0750 -g 10001 /etc/cytale/ssh && cd /etc/cytale/ssh

# The CA: signs every member certificate. One per deployment.
sudo ssh-keygen -t ed25519 -f ca_key -N '' -C 'cytale-ssh-ca'

# The HOST key: the fingerprint members pin. Generate ONCE, then never again.
sudo ssh-keygen -t ed25519 -f host_key -N '' -C 'cytale-ssh-host'

# The bridge credential: the shared secret between the app and the host.
openssl rand -base64 48 | sudo tee bridge_credential >/dev/null

sudo chmod 0644 ca_key.pub host_key.pub
sudo chmod 0640 ca_key bridge_credential
sudo chmod 0600 host_key
sudo chown root:root ca_key host_key bridge_credential
```

Then point `.env` at it and print the fingerprint members will pin:

```bash
echo 'CYTALE_SSH_SECRETS_DIR=/etc/cytale/ssh' >> .env

ssh-keygen -lf host_key.pub
# 256 SHA256:AbCd… cytale-ssh-host (ED25519)   ← the published fingerprint
```

The host also prints it at boot, next to the CA fingerprints it trusts, so a
running deployment can be checked without the file:

```bash
docker compose logs ssh-host | grep 'ssh host listening'
# …host_key=SHA256:AbCd… authorities=SHA256:… max_session_duration=12h idle_timeout=30m0s
```

**What the entrypoint does with these files, and why it must.** The host reads
its credential and its host private key **once at boot and then unlinks them**;
an unlink that fails is fatal to its boot by design, because leaving a readable
secret behind is the thing it refuses to do. A read-only mount cannot be
unlinked, so the image's entrypoint copies the three files it needs into a
writable **tmpfs**, hands them to uid 10001, and only then execs the host as
that uid. The operator's files are never modified — which is how both halves
hold at once: read-once-and-unlink at runtime, and a host key that is the same
key on every boot.

### Turning it on

```bash
# .env
CYTALE_SSH_CERTIFICATES_ENABLED=true
CYTALE_SESSION_BRIDGE_ENABLED=true
CYTALE_SSH_HOST_ORIGIN=https://<your public origin>   # must equal CYTALE_DOMAIN

docker compose up -d
```

The order matters: provisioning comes first. With both switches on and no
readable CA key, the app fails its boot loudly, naming the path (never the
content) — that is the intended failure, not a misconfiguration to work around.
With them off, `docker compose up -d` starts everything else and leaves the
terminal down, and `ssh-host` exits with a message naming the missing file
(`docker compose logs ssh-host`), retrying a bounded number of times rather
than crash-looping over the one line that explains it.

Starting everything is one command; starting only what the terminal needs is:

```bash
docker compose up -d cytale ssh-host
```

### A member's first connection

1. In the web UI: **Settings → SSH**, generate a keypair (the private key is
   shown once and downloaded), and submit the public key. The server returns a
   signed certificate.
2. Install the two files **side by side**, with the private key owner-only:
   `~/.ssh/id_ed25519` and `~/.ssh/id_ed25519-cert.pub`, then
   `chmod 600 ~/.ssh/id_ed25519`. The basename pairing is what makes `ssh`
   present the certificate automatically.
3. Connect with the **username as the login name** — the certificate's only
   principal is the Hrmny username, so a bare `ssh host` presents the local
   username and is refused:

   ```bash
   ssh -l <username> -p ${CYTALE_SSH_PORT:-2222} -i ~/.ssh/id_ed25519 <host>
   ```

   A ready-made alias, and the pin:

   ```
   # ~/.ssh/config
   Host cytale
     HostName <host>
     Port 2222
     User <username>
     IdentityFile ~/.ssh/id_ed25519
   ```

   On first connect the client host key is unknown, so `ssh` prompts and adds
   it to `known_hosts`; after that the entry is a pin. **If the host key is
   ever regenerated that pin becomes `REMOTE HOST IDENTIFICATION HAS
   CHANGED`, and `ssh` refuses to connect at all** — a hard failure for every
   member, not a warning they can click past. That is why `host_key` is
   provisioned once and never generated by the deployment (R29a).

### Ports, and the collision check

| Port | Proto | Service | Purpose |
| --- | --- | --- | --- |
| 80/443 | tcp | caddy | Existing: TLS + ACME (unchanged). |
| 3478 | tcp+udp | eturnal | Existing: STUN + TURN. |
| 50000–50099 | udp | cytale | Existing: the app's ex_webrtc media range. |
| 51000–51099 | udp | eturnal | Existing: the TURN relay range. |
| 2222 | tcp | ssh-host | **New, and this service's ONLY published port** (`CYTALE_SSH_PORT`). |

The check against the ranges this stack already publishes:

```bash
# Every published (port, protocol) pair, per service:
docker compose config --format json \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); [print(s, [(p.get("published"), p.get("protocol")) for p in (v.get("ports") or [])]) for s,v in d["services"].items()]'
```

Rules that keep the publishes disjoint:

- The SSH port is **TCP** and the media/relay ranges are **UDP**, and Docker
  keys a publish by the `(port, protocol)` pair — so 50000/tcp and 50000/udp
  can coexist. Keep the SSH port out of `CYTALE_MEDIA_UDP_PORT_RANGE`
  (`50000-50099`) and the `ETURNAL_RELAY_MIN/MAX_PORT` span (`51000-51099`)
  anyway, and off 80/443/3478/5349: a host firewall rule that names one number
  cannot tell the two apart, and the disjointness is what makes the table above
  trustworthy.
- If the deploy host already runs its own `sshd` on 22, leave it there: this
  host is published on 2222 and takes nothing from the system sshd. Do not move
  this one onto 22 unless you also move that one, or Docker fails the container
  with `address already in use` at start.

### Sync requirements, in one place

1. `CYTALE_SSH_HOST_ORIGIN` equals the public origin (`CYTALE_DOMAIN`): the
   client resolves its REST and gateway URLs from it, and the session-end
   message a member reads names it as the re-issue URL, so it must be an origin
   their browser can actually open.
2. `CYTALE_SSH_SECRETS_DIR` holds the CA keypair whose `.pub` the host trusts —
   `ca_key` and `ca_key.pub` are one pair, and swapping in a new CA means
   updating both halves and restarting the app and the host.
3. `CYTALE_SSH_NETWORK_SUBNET` and `CYTALE_SSH_BRIDGE_BIND` are one value in
   compose; change them only together, and only if `172.31.240.0/24` collides
   with a LAN/VPN route.
4. The published SSH port stays out of the UDP ranges (above).

### Reading the audit trail

Every issuance, every mint, and every refusal of either is recorded in
`ssh_certificate_audit`, partitioned by account (events with no resolved
account — an unknown serial, a wrong credential — land in partition `0`). It is
the detection path for what the design cannot prevent, so it deliberately
outlives the account: deleting an account de-identifies its rows rather than
removing them.

```bash
docker compose exec scylladb cqlsh
```
```sql
USE cytale;
-- one member's history, newest first:
SELECT event_id, action, outcome, reason, serial, occurred_at
  FROM ssh_certificate_audit WHERE account_id = <snowflake>;
-- refusals that never resolved to an account:
SELECT event_id, action, reason, serial, fingerprint, occurred_at
  FROM ssh_certificate_audit WHERE account_id = 0;
```

`action` is one of `issued`, `issue_refused`, `minted`, `mint_refused`,
`key_removed`; `outcome` is `ok` or `refused`. A failed audit write is logged
at error level rather than raised, because the audit table shares a database
with the thing being audited — a transient blip must not become an
authentication outage.

### Failure modes and checks

- **Secrets missing or unreadable.** `docker compose logs ssh-host` shows
  `cytale-ssh-host: missing or empty /run/cytale-ssh/<file>`, and the container
  stops after a few retries. If instead the app refuses to boot, the message
  names the CA key path — check `CYTALE_SSH_SECRETS_DIR` and the file modes
  (0640 `root:10001` for `ca_key`, 0600 for `host_key`).
- **The bridge is unreachable.** A connection is accepted, authentication
  succeeds, and then the member reads "The Cytale server could not be reached to
  start your session" (`bridge_unreachable`): no token, no client process. Check
  `docker compose logs cytale | grep 'session bridge listening'` and that the
  bind address is the app's address on `cytale_ssh-internal`.
- **`docker compose up -d` fails with `bind source path does not exist`** — the
  secret directory does not exist yet. Provision it (or point
  `CYTALE_SSH_SECRETS_DIR` at it) and re-run.
- **Wrong login name.** Refused before a session exists, with the login name in
  the message: the certificate's principal must equal `ssh -l`'s value.
- **A member's certificate expired.** The session ends with
  `(reason: certificate_expired)` and the re-issue URL, mid-session or at the
  next renewal — never at the session's maximum.
- **The host key changed under a member.** `REMOTE HOST IDENTIFICATION HAS
  CHANGED` and a refusal: their `known_hosts` entry was pinned to the old key.
  Recovering means the member removes the stale line and re-verifies, and every
  member has to do it — hence never regenerate `host_key`.
- **The app restarted without the host restarting (or the reverse).** Both read
  the credential at their own boot; after rotating `bridge_credential`, recreate
  BOTH (`docker compose up -d cytale ssh-host`) or mints fail with a refused
  credential until they agree.

### Rotation, and what does not exist

- **Revocation does not exist.** There is no revocation list: a certificate is
  valid for its 24 hours. The levers are removing the stored public key
  (Settings → SSH → remove), which stops further issuance and authentication
  against it, and the natural expiry. A leaked private key therefore has a
  bounded but real window.
- **The CA key and the bridge credential have no rotation automation.** The CA
  can be rotated under dual trust (put both public keys in the host's trust set
  — `ca_key.pub` is a file the host reads as a list — while new certificates are
  issued by the new key); the bridge credential is rotated by replacing the file
  and recreating both containers. Both are manual, and both are cheap at this
  scale.
- **The terminal is not a complete client.** It reads and posts, handles
  threads, searches, reacts, and renders basic markdown. Attachments, message
  edit/delete, notifications, voice, new DMs and threads, and
  administration/settings are hard absences: a member in an SSH-only session
  has no web fallback to route them to (see
  [`docs/architecture/platform-clients.md`](architecture/platform-clients.md)).

### Local verification (no caddy / no TLS)

```bash
# The app on 127.0.0.1:4000, the terminal on 127.0.0.1:2222 (the override
# narrows the publish to loopback; it needs Compose >= 2.24 for `!override`):
docker compose -f compose.yaml -f deploy/compose.local.yml up -d cytale ssh-host
ssh -l <username> -p 2222 -i ~/.ssh/id_ed25519 127.0.0.1

# THROWAWAY teardown — deletes the volumes; never run against real data:
docker compose -f compose.yaml -f deploy/compose.local.yml down -v
```

The committed end-to-end script drives a real `ssh` client through the whole
path (it generates a CA and a client key, signs a certificate, starts the host,
and asserts on the rendered session) and fails loudly when its prerequisites
are missing rather than skipping:

```bash
scripts/ssh-host-e2e.sh
```

### Rollback (terminal off)

1. `docker compose rm -sf ssh-host` — the published SSH port goes with it.
2. Set `CYTALE_SSH_CERTIFICATES_ENABLED=false` and
   `CYTALE_SESSION_BRIDGE_ENABLED=false` in `.env`, then
   `docker compose up -d cytale`: the bridge listener is not started at all,
   and certificate issuance is off. Chat, voice, search and the gateway are
   untouched.
3. Keep the secret material where it is. The host key is what members pin, so
   deleting it is what turns a pause into a re-verification for everyone.

## Desktop app media capability (calls V2)

The desktop shell (`apps/desktop`, Tauri 2) hosts the web build in the OS
webview, and the *webview* — not the product — bounds what media it can
honestly capture. The web app / installed PWA is the full client on every
platform: mic, camera and screenshare all work there. The desktop
app capability-probes at runtime
(`apps/web/src/features/calls/capability`) — API presence plus a dry-run
capture attempt, because presence alone lies on macOS — and hands off to
the browser where its webview falls short:

| Platform (desktop shell) | Mic | Camera | Screenshare | Desktop behavior |
| --- | --- | --- | --- | --- |
| Windows (WebView2) | yes | yes | works with host picker/permission wiring | probe-gated |
| macOS (WKWebView) | yes (prompt quirks) | partial | screen-only at best, quirk-prone (wry #1195 prompt conflict; screen picker, never a window) | probe-gated → handoff on failure |
| Linux (WebKitGTK) | experimental | experimental | absent (GStreamer WebRTC still landing) | handoff |
| Browser / installed PWA (all OS) | yes | yes | yes | full client |

When a probe (or a live capture) fails on the desktop, the affordance
says so plainly and offers exactly one button — "Open the web app" —
which opens the configured web origin in the default browser (no
deep link, no auto-join; the user signs in and joins the call
themselves). The browser's join displaces the desktop leg (the V1
one-leg-per-user rule) and the desktop shows "Call continued in your
browser."

Handoff URL wiring: the opener prefers a runtime-set origin
(`setWebAppOrigin` in the capability module) or `VITE_WEB_ORIGIN` when
the web build sets it, else the current origin. Dev (`tauri dev`,
devUrl `http://localhost:5173`) resolves correctly; production desktop
bundles serve from the webview's internal scheme, so those builds MUST
set `VITE_WEB_ORIGIN=https://<your deployment origin>` at build time (or
call `setWebAppOrigin` at shell boot).
The open itself targets the standard Tauri opener plugin command
(`plugin:opener|open_url`); until `apps/desktop` registers
`tauri-plugin-opener` in its Cargo.toml + capabilities, the web side
falls back to `window.open` (a real default-browser open on WebView2; a
no-op on WKWebView/WebKitGTK — wire the plugin for those platforms).

The per-platform caveats are tracked upstream: wry #1195 (permission-responder
conflict), WebKit bug 271688 (window-selection gap) and WebKitGTK's GStreamer
support.

### Desktop API access (CORS + baked origin)

The desktop shell serves the SPA from its own scheme — `tauri://localhost`
on macOS/Linux, `http://tauri.localhost` on Windows — so it calls this
server CROSS-origin. The web client never does (it is served from the same
origin as the API), which is why the endpoint carries no CORS by default
and the plug's allowlist defaults to exactly those two shell origins
(`Cytale.Config.cors_allowed_origins/0`). `CYTALE_CORS_ALLOWED_ORIGINS`
(comma-separated, exact match) replaces the list; `*` is never honored.
CORS is not an authorization boundary here — every request still needs a
bearer token, and a native client could call the API without CORS at all.

A packaged desktop shell resolves its server in this order: an origin baked
in at build time (`VITE_CYTALE_ORIGIN`), else the optional hosted fallback
(`VITE_CYTALE_HOSTED_ORIGIN`, also the server the login form suggests), else
nothing — the login form asks the user for a server. A plain build sets
neither, so it asks. A self-hosted deployment that ships its own desktop
build sets, at build time:

- `VITE_CYTALE_ORIGIN=https://chat.example.com` (API base + gateway URL), or
  `VITE_CYTALE_HOSTED_ORIGIN=https://chat.example.com` to suggest the server
  while still letting users type another;
- `VITE_WEB_ORIGIN=https://chat.example.com` (the media handoff opener above).

The browser build needs none of these: it is same-origin by default, which is
what a self-hosted deployment wants. The mobile app has the same pair,
`EXPO_PUBLIC_CYTALE_ORIGIN` and `EXPO_PUBLIC_CYTALE_HOSTED_ORIGIN` (sign-in
suggestion).

The public `apps/desktop/src-tauri/tauri.conf.json` names no server hosts in
its CSP and no updater endpoint. A release build supplies both with
`tauri build --config <json-file>`: a JSON overlay that adds your origin to the
CSP (`connect-src` for `https://` and `wss://`, `img-src` for `https://`) and, if you
ship auto-updates, your own updater endpoint and public key. A fork supplies
its own update feed and signing key; it never auto-updates from anyone
else's. The desktop bundle identifier is `chat.hrmny.desktop`.

## Scale boundary

Single node BY DESIGN: one Elixir node (snowflake worker 0, in-process
workspace fan-out, local Tantivy writers) + one Scylla + one volume host.
Do not scale `cytale` replicas (`docker compose up --scale cytale=2` will
not shard — snowflake ids would collide and the resume window is local).
Horizontal sharding is future work.

## Environment reference

See `.env.example` — every variable, its default, and which are fail-fast
required. The full validation contract lives in
`apps/server/config/runtime.exs`.
