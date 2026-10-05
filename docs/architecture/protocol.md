# Cytale Gateway & REST Protocol — Architecture

**Status:** descriptive (2026-09-03) · **Canonical source:** `packages/protocol/src` (TypeScript) and `apps/server/lib/cytale_web/router.ex` + `gateway_socket.ex` (Elixir). This document explains intent and conventions; where it disagrees with the code, the code wins, and `pnpm protocol:check` exists to keep the docs honest.

---

## 1. Intent

Cytale's protocol is **one wire format with two planes**:

- **REST (`/api/v1/*`)** — the write and read plane. Auth, workspaces, channels, messages, threads, invites, roles, acks. Every mutation starts here.
- **Gateway (WebSocket, `GET /gateway/websocket`)** — the fan-out plane. Live dispatches of what changed, plus a small set of client→server realtime commands (heartbeat, typing, read-acks, presence).

Three design commitments shape everything below:

1. **Discord-shaped, voice-omitted.** The gateway follows the Discord-proven model (R3): numbered ops, seq-stamped dispatch events, Hello→Identify→READY handshake, Resume-with-replay, close codes in the 4000-range. Ops 4 and 8 (voice) are left unassigned forever; ops ≥ 20 are the Cytale-native reserved range.
2. **Single definition, every consumer.** The opcode table, event registry, and payload contracts live once in `packages/protocol` and are consumed by the Elixir server (mirrored constants), the web SPA, the load harness (U28), and — by design — the future React-Native and bot clients. One wire format is the product thesis; `pnpm protocol:check` diffs the docs against the shipped contract and `pnpm seam:check` fails the build if the server emits an event name the store doesn't reconcile.
3. **Raw WebSock, not Phoenix Channels.** The gateway speaks the exact envelope below with no channel framing, so a non-Elixir client needs zero Phoenix concepts. A connection is one BEAM process (`GatewaySocket`, a WebSock handler); fan-out is per-PID through an ETS route table.

## 2. Style conventions

| Convention | Rule | Why |
|---|---|---|
| Envelope | `{op, t?, s?, d}` — op always; `t`+`s`+`d` on dispatches only | One parse path for every frame |
| Event names | **camelCase `EventName`** in the exhaustive registry (`EventName ∪ EventPayloadMap`) | The client blind-casts `envelope.t` and the store reconciles by literal name. A drifted name (e.g. `MESSAGE_CREATE`) is silently ignored client-side — this happened once; the seam sweep now guards it |
| Snowflakes | decimal **strings** on the wire (`/^\d{1,19}$/`) | JSON-safe int64; ids are sortable by time |
| Timestamps | ISO-8601 UTC strings | — |
| Compression | negotiated at Identify: `zstd_stream \| zlib_stream \| null`; server offers in Hello under `compression_modes` | Web negotiates native zlib (measured decision); server can emit zstd for clients that link a decoder |
| Sequence | per-session monotonic `s` on every dispatch; READY/RESUMED carry `s: 0` (sequence-less control) | at-least-once delivery: the client drops `s ≤ lastSeq`, treats gaps as resume triggers |
| Errors (REST) | `{ "error": { "key", "code", "message" } }`; unknown resources 404 with a generic body | no permission oracle — a non-member learns nothing about existence |
| Errors (gateway) | close codes 4000–4012 (below), with optional pre-close frames (e.g. InvalidSession) | client-side routing by code |

## 3. Gateway ops

### 3.1 Server → client

| op | Name | Payload | Semantics |
|---|---|---|---|
| 0 | DISPATCH | `t` (event name), `s` (seq), `d` (payload) | The only carrier of state changes. Every dispatch is buffered per-session before the wire write — that buffer is what Resume replays |
| 10 | HELLO | `{ heartbeat_interval, compression_modes, v }` | First frame after connect; interval is 30s in dev/prod |
| 11 | HEARTBEAT ACK | `null` | 5 consecutive missed ACKs = dead link |
| 6 | RECONNECT | — | Planned drain: sent staggered ~4/sec with ±40% jitter before shutdown |
| 9 | INVALID SESSION | `boolean` (resumable) | `false` ⇒ the session is gone; client must reset identity and take a **fresh connection** to re-Identify (identifying on the dying socket wedges) |

### 3.2 Client → server

| op | Name | Payload | Semantics |
|---|---|---|---|
| 1 | HEARTBEAT | last seq or `null` | on the Hello cadence |
| 2 | IDENTIFY | `{ token, v, compress, properties }` | JWT from REST login; `v` must equal the server's accepted version (else close 4012). Success ⇒ READY dispatch + route join |
| 3 | PRESENCE UPDATE | `{ status }` — `online \| idle \| dnd \| invisible` | Preferred-status declaration. `offline` is **rejected** (server-derived on last-socket close); `invisible` broadcasts `offline` honestly while routing stays live |
| 5 | RESUME | `{ session_id, seq, resume_token, token }` | All three identity binds required (id + single-use token + authenticated same-user). Success ⇒ `Resumed` + replay of everything after `seq` |
| 20 | TYPING START | `{ channel_id, thread_id? }` | Throttled server-side to ~1/sec/user/channel before fan-out as `TypingStart` |
| 21 | MESSAGE ACK | `{ channel_id, message_ids }` | Read acknowledgement; thread acks use the thread id in `channel_id`. Server persists `read_state` and fans `MessageAck` back to the user's devices |

### 3.3 Close codes

`4000` unknown · `4001` decode · `4002` unknown op · `4003` not authenticated · `4004` auth failed · `4005` already authenticated · `4007` invalid seq (resume ahead of server) · `4008` rate-limited (identify: 30/10s/IP) · `4009` session timeout (dead link) · `4012` unsupported version.

## 4. Dispatch events

The registry is exhaustive (`EventName` ↔ `EventPayloadMap` — adding one without the other fails the build). Emission status is sweep-checked.

**Message & threads** — `MessageCreate` `{id, channel_id, thread_id, author_id, content, created_at, edited_at}` (replies double-dispatch: thread route + channel route) · `MessageUpdate` · `MessageDelete` `{id, channel_id, thread_id}` · `ThreadCreate` `{id, channel_id, name, created_by, created_at}` — workspace-routed, a new thread has no subscribers of its own · `ThreadMessageCreate`.

**Channels** — `ChannelCreate` (workspace-routed; same reason) · `ChannelUpdate` `{id, name?, topic?, position?}` · `ChannelDelete` `{id}`.

**Membership & presence** — `MemberAdd` `{user:{id,username}, workspace_id, joined_at}` on invite accept · `MemberRemove` `{user_id, workspace_id}` on kick · `PresenceUpdate` `{user_id, status, last_seen_at}` — join announce + newcomer snapshot + op-3 fan-out + offline on last-socket close.

**Typing & read** — `TypingStart` `{channel_id, thread_id, user_id, timestamp}` · `MessageAck` `{channel_id, message_ids, user_id, acknowledged_at}`.

**Session lifecycle** — `Ready` `{v, session_id, resume_token, heartbeat_interval, user}` · `Resumed` `{replayed_events, heartbeat_interval}`.

**Threads** — `ThreadUpdate` `{id, name?, archived?}` — emitted by the archive write (`PATCH /threads/:id` natively, `PATCH /channels/{thread_id}` on the compat surface), channel-routed like `ThreadCreate` · `ThreadDelete` `{id, channel_id}` — emitted by the compat `DELETE /channels/{thread_id}`.

**Registered but not yet emitted** (admin-epic scope — the sweep reports these): `ThreadMemberAdd/Remove`, `ThreadListSync`, `RoleCreate/Update/Delete`, `AccountDelete`.

## 5. REST surface (`/api/v1`)

Conventions: Bearer access JWT on every route except `POST /auth/register|login` and the public invite resolve; content-producing mutations pass a single choke pipeline (`RequireVerified` → `Idempotency` → `RequirePermitted`, verification first so an unverified account learns no permission state); per-ACCOUNT bucket `50 req/10s` on the authenticated surface (with a per-IP `500 req/10s` ceiling behind it), and a per-IP bucket on the pre-auth surface (`/auth/*` `30 req/10s`) — see docs/self-hosting.md ("Rate limits").

**Auth** — `register` · `verify-email` · `resend-verification` · `login` · `refresh` (Bearer: expired-OK access JWT for the `sub`; body: refresh token; rotates the pair) · `logout` (revokes the presented refresh token) · `password-reset/request|complete`.

**Workspaces & membership** — CRUD on `/workspaces`; `/workspaces/:id/members` (roster) · `/members/:user_id` DELETE (kick, MANAGE_WORKSPACE) · `/invites` POST (member-scoped mint; `max_age_s`, `max_uses`) · `/invites/:code` GET/POST (public resolve/accept) · `/people` (paginated directory, `next_before` cursor — null when the page came back short).

**Channels** — CRUD under MANAGE_CHANNELS; `GET /channels/:id/overwrites` + `PUT/DELETE` (permission deny/allow rows, permission-name lists ↔ bitfield); `GET /channels/:id/threads` (sidebar roster).

**Messages** — `GET /channels/:id/messages` (newest-first, `before=<oldest_id>` cursor, `oldest_id` in the envelope) · `POST` (Idempotency-Key honored; envelope `{message}` unwrapped by the api-client) · `PATCH`/`DELETE` (author, or MANAGE_MESSAGES) · `POST /ack` · `POST /typing` (REST fallbacks for ops 21/20).

**Threads** — `POST .../messages/:mid/threads` (start) · `POST /threads/:id/messages` (reply) · `/members` join/leave/follow.

**Admin** — `/workspaces/:id/audit` · `/deletion-cascade/:user_id` · `/invites` · `/metrics` (hop-budget p50/p99: `scylla_insert_ms`, `fanout_dispatch_ms`).

**Delivery guarantees** — REST writes are the choke point; every mutation that changes shared state publishes on the `Cytale.Publish` seam, and the workspace process fans out through the route table with the per-session seq/buffer discipline above: **at-least-once on the wire, exactly-once at the store** (id-deduped upserts). What a fully-disconnected client misses converges on its next fresh READY (`sessionEpoch` drives REST re-hydration) — see `docs/architecture/system-and-flows.html` §05.

## 6. Versioning & compatibility

One accepted gateway version (`v: 1`); a mismatch closes 4012. Backward-compatible additions (new events, new ops ≥ 20) are the growth path; the `protocol:check` gate pins docs to the shipped table so drift fails CI rather than clients silently.
