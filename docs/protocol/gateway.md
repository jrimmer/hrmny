# Gateway

The Cytale real-time gateway: a WebSocket endpoint speaking a Discord-shaped
protocol. A working client can be built from this document plus
[Events](./events.md) alone.

- **URL:** `GET wss://<host>/gateway/websocket` (cleartext `ws://` in development)
- **Protocol version:** `1` (sent by the client in Identify; see [Versioning](./versioning.md))
- **Max inbound frame size:** 1 MB — larger frames are rejected
- **Connection timeout:** 90 s of socket inactivity at the transport layer

## Envelope

Every gateway frame — in both directions — is one JSON object:

```json
{
  "op": 0,
  "t": "MessageCreate",
  "s": 42,
  "d": { "id": "123456789012345678", "channel_id": "234567890123456789" }
}
```

| Field | Type | Present | Description |
| --- | --- | --- | --- |
| `op` | integer | always | Gateway opcode (table below). |
| `t` | string | Dispatch only | Event name — see [Events](./events.md). |
| `s` | integer | Dispatch only | Monotonic per-session sequence number. |
| `d` | any | always | Payload. Shape depends on `op` (and `t` for Dispatch). |

Rules enforced on every inbound frame:

- `op` must be an integer with a currently-defined value. Ops `4` and `8` are
  unassigned forever (Discord voice legacy); unassigned values close the
  connection with **4002 Unknown Opcode**.
- Dispatch frames (`op: 0`) must carry a known event name in `t` and a
  non-negative integer `s`. Non-dispatch frames must **not** carry `t` or `s`.
- The `d` field is required on every frame.

## Opcodes

| op | Name | Direction | `d` shape |
| --- | --- | --- | --- |
| 0 | Dispatch | server → client | Event payload (see [Events](./events.md)) |
| 1 | Heartbeat | client → server | last seq (`number \| null`) |
| 2 | Identify | client → server | [Identify payload](#op-2-identify) |
| 3 | Presence Update | client → server | presence payload (accepted; no ack yet) |
| 5 | Resume | client → server | [Resume payload](#op-5-resume) |
| 6 | Reconnect | server → client | *none* |
| 9 | Invalid Session | server → client | `boolean` — resumable flag |
| 10 | Hello | server → client | [Hello payload](#op-10-hello) |
| 11 | Heartbeat ACK | server → client | *none* |
| 20 | Typing Start (client) | client → server | [Typing payload](#op-20-typing-start-client) |
| 21 | Message ACK | client → server | [Message ACK payload](#op-21-message-ack) |
| 22 | Call State Update | client → server | [Call State Update payload](#op-22-call-state-update) |
| 23 | Call Signal | client → server | [Call Signal payload](#op-23-call-signal) |
| 24 | Focus Update | client → server | [Focus Update payload](#op-24-focus-update) |

Ops ≥ 20 are the Cytale-reserved command range. Ops 4 and 8 are permanently
unassigned. Server-to-client ops (0, 6, 9, 10, 11) sent by a client close the
connection with **4002 Unknown Opcode**.

> **Compat sessions (Discord dialect):** the server-pushed Reconnect is
> **op 7** on a compat session's wire, and the CLIENT's Resume is **op 6** —
> Discord's numbering, which collides with the native table's op 6
> (Reconnect). The dialect therefore decides what an inbound op 6 means: a
> `cytbot_` credential sending it is RESUMING (accepted, see
> [op 6 Resume (compat)](#op-6-resume-compat)), while a native session sending
> it is still a protocol violation (close 4002) because native Resume is op 5.
> Planned-shutdown drains and restriction-profile teardowns carry the
> session's dialect's Reconnect op (6 native, 7 compat).
>
> A refused Resume — either dialect — is answered with **Invalid Session
> (`d: false`) followed by close 4000**, never with 4002/4004: Discord clients
> classify 4002 as *resumable* and retry Resume forever, so a fatal-looking or
> resumable-looking refusal during a deploy (or any socket drop) leaves a bot
> permanently deaf while the server still counts it online. Invalid Session
> (`false`) is the protocol's "Identify again" signal, and every client takes
> it immediately.

## Connection lifecycle

```
connect ─▶ Hello(10) ─▶ Identify(2) or Resume(5)
                          │
              READY dispatch (fresh session)
              RESUMED dispatch + replay (resume)
                          │
                steady state: heartbeats (1 → 11), seq-numbered dispatches,
                TYPING_START(20) fan-out, MESSAGE_ACK(21) fan-out
                          │
             disconnect ─▶ Resume within the window ──▶ back to steady state
                        └▶ window expiry / Invalid Session(9, false) ─▶ re-Identify
```

### op 10 Hello

The **first frame the server sends** on every new connection, before any
client frame:

```json
{
  "op": 10,
  "d": {
    "heartbeat_interval": 30000,
    "compression_modes": ["zstd_stream", "zlib_stream"],
    "v": 1
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `heartbeat_interval` | number | Milliseconds between client heartbeats (30000 = 30 s). |
| `compression_modes` | string[] | Supported stream codecs; client picks at most one in Identify. |
| `v` | number | The accepted gateway protocol version. Echoes the version the connection URL requested (`?v=N` — compat clients arrive via [`/gateway/bot`](./compat.md#gateway-bootstrap-get-gatewaybot)'s `?v=10` URL); `1` when the URL did not carry one. |

### op 2 Identify

Starts a fresh session. Sent after Hello on a connection that will not resume.

```json
{
  "op": 2,
  "d": {
    "token": "<auth token from REST login>",
    "v": 1,
    "compress": "zstd_stream",
    "intents": 2561,
    "properties": { "os": "linux", "browser": "cytale", "device": "cytale" }
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `token` | string | Auth token issued by REST login. Invalid/expired tokens close with **4004 Authentication Failed**. |
| `v` | number | Requested protocol version — gated AFTER token verification, keyed on the credential type (see [Session modes](#session-modes)). Native sessions: only `1`, anything else closes with **4012 Invalid API Version**. Compat sessions: `10` (what `/gateway/bot` advertises) or `1` (interop window); an ABSENT `v` is accepted (Discord libraries carry the version in the connection URL). |
| `compress` | string \| null | Requested PAYLOAD codec: `"zstd_stream"` (preferred), `"zlib_stream"` (fallback), or `null` for none. Unknown values close with **4001 Decode Error**. (Transport compression is separate — [below](#compression).) |
| `intents` | number? | Intent bitmask, compat sessions only (see [Intents](#intents-compat-sessions)). Optional: absent = 0 (lifecycle only). Native sessions IGNORE the field. |
| `properties` | object | Client environment description: `os`, `browser`, `device` (strings). BOTH the bare form (`os`) and Discord's `$`-prefixed form (`$os`) are accepted. |

On success the server dispatches [READY](./events.md#ready) — sequence number
`0` — and the connection enters steady state. A failed Identify closes the
socket; a client that receives **Invalid Session (`d: false`)** before closing
must re-Identify on a fresh connection.

One connection authenticates exactly once: sending Identify or Resume after
READY closes with **4005 Already Authenticated**. Open a new socket instead.

**Per-principal session cap (compat sessions only):** at most **8 concurrent
live sessions** per machine principal (config-overridable server-side). A 9th
Identify is refused with **4008** (Discord has no dedicated cap close code;
4008's rate-limit semantics carry it). The slot is claimed ATOMICALLY at
Identify — concurrent Identifies can never overshoot the cap. Native
sessions are exempt — humans keep unrestricted multi-device.

### Heartbeats (op 1 → op 11)

Send op 1 every `heartbeat_interval` milliseconds starting after Hello:

```json
{ "op": 1, "d": null }
```

`d` is the **last dispatch sequence number** the client has processed, or
`null` if none has arrived yet. The server replies with op 11 (no `d`).

The server tracks liveness by wall-clock accounting, not by counting frames:
if no heartbeat arrives for `heartbeat_interval × 5` the link is declared dead
and closed with **4009 Session Timeout**. Clients should treat a missing op 11
within roughly one interval as a warning sign and reconnect opportunistically.

Sending a Heartbeat before Identify closes with **4003 Not Authenticated**
(prefixed by an Invalid Session `false` frame).

### op 5 Resume

Reattaches to a dropped session and replays everything the client missed.
Sent after Hello on a fresh socket, instead of Identify:

```json
{
  "op": 5,
  "d": {
    "session_id": "sAbCdEfGhIjKlMnOpQrSt",
    "seq": 41,
    "resume_token": "19cf5c31e0a24d2f8ba77c6d5e4f3a2b",
    "token": "<same auth token as Identify>"
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `session_id` | string | The id issued in READY (starts with `s`). |
| `seq` | integer | The last dispatch sequence number the client processed. |
| `resume_token` | string | The **single-use** secret issued in READY. Consumed on success — a later resume of the same session needs a token from a subsequent READY. |
| `token` | string | Current auth token. Resume **re-authenticates**: the presented identity must match the session's bound user. |

On success the server sends [RESUMED](./events.md#resumed) (sequence number
`0`) followed immediately by every buffered dispatch with `s > seq`, oldest
first, then continues live delivery. The client applies the replay before
returning to steady state; see [Versioning — delivery semantics](./versioning.md#delivery-semantics).

Resume is refused with **Invalid Session (`d: false`)** — followed by close —
when any of: the session is unknown, the resume window expired, `resume_token`
is missing or mismatched, the authenticated identity does not own the session,
the session is already live on another connection, the session's stored record
was purged by a restriction-profile teardown (a profile change purges the
principal's records so the narrowed rights can only be picked up by a FRESH
Identify — a Resume would otherwise run under the pre-narrowing restrictions
frozen at the old Identify), the given `seq` is **older than the buffer's
eviction watermark** (see below), or the given `seq` is **ahead** of the
server's high-water mark (that specific case closes with **4007 Invalid Seq**
instead). Any refusal means: discard session state, re-Identify, and
full-sync from REST.

#### Resume buffer cap and the eviction watermark

The replay buffer is **bounded at 1000 envelopes per session**. When a
session dispatches past the cap, the OLDEST buffered envelopes are evicted as
new ones arrive; the retained window is always the newest 1000 sequence
numbers. The **eviction watermark** is the oldest retained seq — a client
whose acknowledged `seq` sits **below** that watermark has missed envelopes
that can never be replayed, so the server refuses that Resume with
Invalid Session (`d: false`) exactly like any other non-resumable case
(never a silent partial replay with a hole in it): the client re-Identifies
and full-syncs from REST. A Resume at or above the watermark replays
exactly — every retained dispatch with `s > seq`, oldest first, gap-free.

A successful Resume re-derives the session's identity from the token
presented on the NEW connection (not the copy frozen in the stored record):
`session_id`, the seq counter, and the replay buffer keep their continuity,
but visibility and restrictions are evaluated as of the resume itself.

### op 6 Resume (compat)

Discord clients send their Resume as **op 6** ([Discord's numbering](https://discord.com/developers/docs/topics/gateway-events#resume)),
and that is the only op they use for recovery after an unexpected drop — a
client that receives a resumable-classified close retries Resume and never
falls back to Identify. Compat sessions therefore accept it:

```json
{ "op": 6, "d": { "token": "cytbot_…", "session_id": "s…", "seq": 42 } }
```

The frame carries Discord's three fields and **no `resume_token`** (Discord has
no such concept): the credential itself is the adoption proof, and it must
authenticate to the SAME principal that owns the session, which is exactly the
guarantee the native `resume_token` provides. Everything else — the resume
window, the liveness/claim checks, the seq high-water mark, the replay-buffer
watermark, the compat re-filter of the replay against current visibility —
is shared with [op 5 Resume](#op-5-resume), and success answers with
`RESUMED` followed by the replay.

Two consequences worth stating because a bot's liveness depends on them:

- A NATIVE session sending op 6 is still a protocol violation (close 4002):
  the dialect is a property of the credential, so `cytbot_` decides.
- A refused compat Resume answers **Invalid Session (`d: false`) then close
  4000** — never 4002/4004. Discord clients treat 4002 as resumable (they
  retry Resume forever) and 4004 as fatal (they stop), so either code turns a
  routine socket drop — a deploy, a restart, a blip — into a permanently deaf
  bot that the server still reports online. Invalid Session (`false`) is the
  signal every client acts on immediately: discard, re-Identify, full-sync.


**Security contract:** a Resume requires *all* of `session_id`, the unspent
`resume_token`, and a valid token for the same user. Neither secret alone
suffices.

### Session and resume windows

| Window | Value | Meaning |
| --- | --- | --- |
| Target | 5 minutes | Disconnects shorter than this should always resume. |
| Hard floor | 10 minutes | Sessions are guaranteed to survive at least this long after the last disconnect; beyond it the server may sweep them at any time. |

Both are server-configurable (`GATEWAY_RESUME_TARGET_MS` /
`GATEWAY_RESUME_FLOOR_MS`); the hard floor is what the server enforces. The
window is anchored on the **last disconnect**, not session age — a session
live for hours that dropped 10 seconds ago is fully resumable.

Additional session rules:

- **One live connection per session.** A second connection cannot adopt a
  live session; doing so is refused as an identity/live mismatch.
- **Buffered replay** is per-session, in-memory, and bounded (the newest
  **1000** envelopes; older ones are evicted oldest-first — a Resume from
  below the eviction watermark is refused in favor of a fresh Identify);
  resuming clients get exactly the dispatches after their acknowledged
  `seq`, gap-free.
- **Full sync fallback:** after window expiry, buffer eviction, crash, or a
  seq gap the client cannot reconcile, rebuild state via REST reads and
  resume-safe dispatches. Offline-overnight clients should expect to
  full-sync.

### Presence (op 3)

Clients may request a presence change with op 3. At protocol v1 the server
accepts the frame (no protocol error) but does not yet act on it; presence
fan-out arrives with the workspace-process unit. Send `d` as your presence
payload.

## Session modes

The wire dialect is keyed on the **credential type** (verified before the
version gate — the client never gets to pick its dialect):

| Credential | Mode | Dispatch names | READY | `v` accepted |
| --- | --- | --- | --- | --- |
| `cytale_` (human JWT) / anything non-`cytbot_` | **native** | CamelCase (`MessageCreate`) | minimal (`v`, `session_id`, `resume_token`, `heartbeat_interval`, `user`) | `1` only |
| `cytbot_` (machine principal) | **compat** | SCREAMING_SNAKE (`MESSAGE_CREATE`) | Discord-shaped (below) | `10`, `1`, or absent |

Native sessions are byte-identical to the pre-compat gateway — the whole
native contract above applies unchanged.

### Compat sessions (bot dialect)

A `cytbot_` Identify mints a **compat session** speaking Discord's gateway
dialect over the same envelope/opcode frame:

- **READY** (`t: "READY"`, `s: 0`) carries `v: 10`, a Discord user object
  (`bot: true`, `discriminator: "0"`, `global_name`), `guilds` as unavailable
  stubs (`{id, unavailable: true}` per workspace), `session_id`,
  `resume_gateway_url`, `shard: [0, 1]` (one shard, matching `/gateway/bot`'s
  `shards: 1` — `discord.AutoShardedClient` indexes `shard[0]` unguarded),
  and `application: {id, flags: 0}`. Discord libraries read `application.id`
  — it is the principal id.
- **GUILD_CREATE** follows immediately, once per workspace (seq-numbered,
  buffered like any dispatch — a Resume replays them). The guild object
  carries `id` (workspace id), `name`, `owner_id`, `unavailable: false`,
  `channels` (Discord channel objects with their `position`), a REAL bounded
  `members` roster (the connecting principal always included, `@everyone`
  first in each `roles`), one `@everyone` role, live-set `presences` (one per
  member with a session, statuses in Discord's vocabulary), `member_count`
  with `large: true` at the 100-entry cap, and the remaining array fields
  real client libraries iterate unconditionally — `threads` (the C-1
  inventory), `voice_states`, `emojis`, `stickers`, `features` (the last
  four are documented-divergence stubs). A guild the session can read
  NOTHING in gets no GUILD_CREATE at all — the READY stub carries only the
  id, which the session's own routing already knows.
- **Dispatch translation**: `t` is the SCREAMING_SNAKE of the native event
  name; payloads are Discord shapes via the shared compat codec
  ([compat.md objects](./compat.md#objects)) — message objects (incl.
  `guild_id`, `author` user object with `bot: true` for machine principals,
  `referenced_message` for replies), channel objects, thread objects
  (`type: 11`, `parent_id` = parent channel), and
  `{channel_id, guild_id, user_id, timestamp}` typing payloads (`timestamp`
  in Unix epoch **SECONDS** — Discord's unit; the native
  [TypingStart](./events.md#typingstart) event carries milliseconds, the
  codec converts).
  `ThreadMessageCreate` translates to `MESSAGE_CREATE` **on the thread
  channel**, and the dual emission's parent-anchored `MessageCreate` leg for
  a thread reply is DROPPED for compat sessions (Discord never delivers a
  thread reply to the parent channel). A
  thread reply's `MESSAGE_UPDATE`/`MESSAGE_DELETE` land on the THREAD id too
  (the payload's `thread_id` re-anchors them — a client keys its message
  cache on `channel_id` + id), and a TYPING_START for in-thread typing
  carries the thread id as `channel_id`.
  `MESSAGE_DELETE` carries `{id, channel_id, guild_id}`.
  `MESSAGE_REACTION_ADD` / `MESSAGE_REACTION_REMOVE` carry
  `{user_id, channel_id, message_id, emoji: {id: null, name}, guild_id}`
  (ADD additionally carries `member.user` for the reacting principal, the
  INTERACTION_CREATE pattern); `MESSAGE_REACTION_REMOVE_ALL` carries
  `{channel_id, message_id, guild_id}` — gated on GUILD_MESSAGE_REACTIONS
  (`1 << 10`).
- **Translate failures fail CLOSED:** the compat translation path does point
  reads (channel/thread rows, author resolution) on a best-effort contract.
  A translation that raises is logged + counted (`cytale.gateway.
  compat_push_error` telemetry) and the event is **dropped for that
  session only** — never over-delivered, never a socket crash. Native
  sessions share no code on that path (no translation, no reads) and are
  unaffected.
- **Visibility filter (the security core):** every compat-session dispatch is
  computed under parent ∩ restrictions — the channel must be in the
  session's visible set (the same resolver the REST gates use, per-channel
  `view_channel` under the parent's membership). Out-of-profile events never
  reach the wire, never consume a seq, and rights/membership changes (role,
  overwrite, kick) propagate on the very NEXT dispatch without a reconnect
  (per-workspace rights epochs). A parent joining a workspace mid-session
  actively refreshes live principal sessions — the new workspace's events
  flow without a reconnect.
- **Resume replay is filtered-consistent:** buffered envelopes are re-checked
  against CURRENT visibility at replay (under the identity freshly
  re-verified by the Resume — never the restrictions frozen at the original
  Identify). Anchors: message and typing envelopes on their channel (a
  thread reply's envelope carries the THREAD id and is admitted through its
  PARENT channel), `THREAD_*` on the parent channel, `CHANNEL_*` and
  `GUILD_CREATE` on workspace membership, `INTERACTION_CREATE` always
  (application-addressed). Any OTHER buffered shape is dropped FAIL-CLOSED
  (counted as `cytale.gateway.replay_dropped` telemetry) — an unrecognized
  envelope never replays on trust. An envelope dropped by the re-check
  leaves a **seq gap** — clients should treat a replay gap as
  "refetch via REST", exactly like any other gap. (Native replays are never
  filtered.)
- **Documented divergences:** PresenceUpdate, MemberAdd/Remove, Role*, and
  read-state events (MessageAck) are NOT delivered to compat sessions;
  `CHANNEL_DELETE` visibility is decided against the session's last-epoch
  visible set (the channel row is already gone at fan-out time — an
  in-profile channel's delete still arrives; an out-of-profile one never
  does).

### Intents (compat sessions)

The optional `intents` bitmask on Identify selects event classes:

| Intent | Bit | Delivered events (translated) |
| --- | --- | --- |
| GUILDS | `1 << 0` | `CHANNEL_CREATE` / `CHANNEL_UPDATE` / `CHANNEL_DELETE`, `THREAD_CREATE` / `THREAD_UPDATE` / `THREAD_DELETE` |
| GUILD_MEMBERS | `1 << 1` | `GUILD_MEMBER_ADD` / `GUILD_MEMBER_REMOVE` (bots plan B-3). No `GUILD_MEMBERS_CHUNK` / op 8 — there is no request-members machinery (documented divergence). |
| GUILD_PRESENCES | `1 << 8` | `PRESENCE_UPDATE` (bots plan B-3; a session never receives its own presence — Discord parity). |
| GUILD_MESSAGES | `1 << 9` | `MESSAGE_CREATE` / `MESSAGE_UPDATE` / `MESSAGE_DELETE` (thread replies arrive as `MESSAGE_CREATE` on the thread) |
| GUILD_MESSAGE_REACTIONS | `1 << 10` | `MESSAGE_REACTION_ADD` / `MESSAGE_REACTION_REMOVE` / `MESSAGE_REACTION_REMOVE_ALL` |
| GUILD_MESSAGE_TYPING | `1 << 11` | `TYPING_START` |
| DIRECT_MESSAGES | `1 << 12` | `MESSAGE_CREATE` / `MESSAGE_UPDATE` / `MESSAGE_DELETE` on a DM channel id (bots plan B-1; recipient-gated, no `guild_id` — Discord's DM shape) |
| DIRECT_MESSAGE_REACTIONS | `1 << 13` | `MESSAGE_REACTION_ADD` / `MESSAGE_REACTION_REMOVE` / `MESSAGE_REACTION_REMOVE_ALL` on a DM channel id |
| DIRECT_MESSAGE_TYPING | `1 << 14` | `TYPING_START` on a DM channel id |

- `intents: 0` (or absent) connects fine — lifecycle only.
- Known-but-unsupported Discord intent bits (e.g. MESSAGE_CONTENT `1 << 15`,
  GUILD_VOICE_STATES `1 << 7`) connect and simply deliver nothing for them
  (allow-silent — a refused handshake reads as outage to a client library).
- **Unknown bits** (anything outside Discord's defined intent mask, e.g.
  `1 << 26`) close the connection with **4013 Invalid Intents** — terminal.
- Intents gate EVENT CLASSES; the per-channel visibility filter applies on
  top (an in-intent event for an out-of-profile channel still never arrives).
- DM-anchored events (bots plan B-1) anchor on RECIPIENT MEMBERSHIP instead
  of the workspace visible-set (a DM has no workspace — see
  [compat.md — Bot DMs](./compat.md#bot-dms-b-1)); member/presence events
  (B-3) anchor on workspace membership. A guild intent never unlocks a DM
  event and vice versa (Discord's split).
- Post-only principals (restrictions without `read`) connect identically —
  allow-silent — and simply have an empty visible set.
- `INTERACTION_CREATE` (bots plan U8) is the one APPLICATION-ADDRESSED
  dispatch: it rides no intent bit and skips the visibility filter — it is
  a point-to-point event to the bot's own sessions (fanned to its user key
  at invocation), so even an `intents: 0` session receives its own
  interactions. The bot's restrictions bite at the CALLBACK, not at
  delivery.

Discord libraries find the websocket through
[`GET /api/v10/gateway/bot`](./compat.md#gateway-bootstrap-get-gatewaybot),
whose `url` points here carrying `?v=10&encoding=json`.

## Client → server commands

### op 20 Typing Start (client)

```json
{
  "op": 20,
  "d": { "channel_id": "234567890123456789", "thread_id": "345678901234567890" }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `channel_id` | string | Required. Channel the user is typing in. |
| `thread_id` | string | Optional. Present when the typing signal applies to a thread instead of the parent channel. |

The server throttles per user × channel at roughly one signal per second
(900 ms floor): faster signals are silently swallowed. Signals for a channel
the session's principal cannot view (unknown channel, non-member,
out-of-profile restrictions) are **silently dropped** — no fan-out, no
protocol error, no visibility oracle; the resolver is consulted per signal.
Accepted signals fan out to other channel subscribers as a
[TypingStart](./events.md#typingstart) event. Requires an authenticated
session — commands before Identify close with **4003 Not Authenticated**.

### op 21 Message ACK

Client read acknowledgement. Marks messages as read:

```json
{
  "op": 21,
  "d": {
    "channel_id": "234567890123456789",
    "message_ids": ["123456789012345678", "123456789012345679"]
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `channel_id` | string | Required. |
| `message_ids` | string[] | Required, non-empty. Snowflake strings. |

The acknowledged shape is mirrored back to the acknowledging user's **other
connected clients** (same user fan-out) as a [MessageAck](./events.md#messageack)
event so multi-device read state converges. The same body is the contract for
the REST fallback `POST /channels/{id}/ack` (see [REST](./rest.md), U9).

### op 22 Call State Update

Voice-call control plane — one command shape for the call verbs (there is no
dedicated voice websocket; call control rides the main gateway):

```json
{
  "op": 22,
  "d": { "channel_id": "234567890123456789", "action": "start", "ring": true }
}
```

```json
{
  "op": 22,
  "d": { "channel_id": "234567890123456789", "action": "state", "mute": true, "deafen": false }
}
```

```json
{
  "op": 22,
  "d": { "channel_id": "234567890123456789", "action": "publish", "source": "screen" }
}
```

```json
{
  "op": 22,
  "d": {
    "channel_id": "234567890123456789",
    "action": "state",
    "video_want": { "tiles": 4, "max_quality": "medium" }
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `channel_id` | string | Required. Channel (or DM channel) the call lives in. |
| `action` | string | Required. One of `start` \| `join` \| `leave` \| `state` \| `publish` \| `unpublish` (the last two are calls-V2 additive). |
| `mute?` | boolean | `state` action: desired mute flag. Absent = unchanged. |
| `deafen?` | boolean | `state` action: desired deafen flag (implies self-mute). Absent = unchanged. |
| `ring?` | boolean | Allowed on `start` AND on `state` — ring-after-start, so a silent starter alone in a call can summon the room without restarting. Absent = silent. |
| `source?` | string | `publish` / `unpublish` only (calls V2): the media source — `camera` \| `screen` \| `screen_audio`. One source per op. |
| `video_want?` | object | `state` action only (calls V2): the receiver's adaptive viewing declaration — `{ "tiles": <int>, "max_quality"?: "high" \| "medium" \| "low" }`. Absent = unchanged. |

Semantics (enforced server-side by the gateway signaling unit):

- `start` — begin a call. Gated on the `START_CALL` permission plus a live
  `VIEW_CHANNEL` check; a start racing an existing live call resolves as a
  join (one-live policy). `ring: true` rings connected members who can view
  the channel (minus notification-muted ones).
- `join` / `leave` — enter / exit the live call. VIEW_CHANNEL is re-checked
  live each time.
- `state` — update the caller's own voice state (`mute`/`deafen`), ring the
  room (`ring`), and/or declare the receiver's adaptive viewing budget
  (`video_want`, calls V2).
- `publish` / `unpublish` — calls V2: start/stop sending one media source
  (`camera`, `screen`, or `screen_audio`) into the live call. The sender
  must be a current participant. Permission gating at publish (resolver
  doctrine preserved — the bit is consulted in the op gate, and the room
  re-checks serialized, V1's join/state twin-check pattern): `camera`
  requires **SEND_VIDEO**; BOTH `screen` and `screen_audio` require
  **SHARE_SCREEN** (share-audio is at least as sensitive as the screen —
  never ungated). **DM rooms skip the bit checks** — participation is
  authorization there (V1 posture; DM rooms never subscribe to
  RightsEpoch). A mid-call revocation of either bit unpublishes that bit's
  sources with a notice; only VIEW_CHANNEL revocation evicts (V1 behavior).
  Accepted publishes fan out as source-state
  [CallUpdate](./events.md#callupdate) events and re-offer the affected
  legs (the offer carries the track manifest — see
  [CallSignal](./events.md#callsignal)). `screen_audio` may ride only
  alongside a live `screen` source from the same publisher.
- DM channels route through the same op (no call-log thread, no durable
  row); ring defaults on for DM targets.

Accepted state changes fan out as [CallUpdate](./events.md#callupdate)
events; call lifecycle as [CallStart](./events.md#callstart) /
[CallEnd](./events.md#callend); ring as user-keyed
[CallRing](./events.md#callring). Requires an authenticated session —
commands before Identify close with **4003 Not Authenticated**. Compat
(bot) sessions send ops 22/23 to no effect and never receive `CALL_*`
events — the compat wire stays voice-free (documented divergence; bots
observe calls only via [REST](./rest.md)).

Server-enforced behavior notes (U4):

- **Throttle** — both call ops carry the typing-style per-session
  per-channel throttle with silent saturation: op 22 at the typing window
  (900 ms), op 23 at a tighter 50 ms window (media signaling is
  bursty-but-brief — SDP answer + ICE trail — while still capping the
  stream well under the resume-buffer budget). The stamp lands on accepted
  AND rejected ops alike, so a stream of denied starts cannot hammer the
  permission resolver unthrottled. Saturation counts
  `[:cytale, :gateway, :call_throttled]` telemetry. Two calls-V2
  carve-outs: `publish`/`unpublish` are **exempt** from the op-22 window
  exactly the way `leave` is (rapid publish toggles are legitimate client
  behavior; clients debounce chatty UI at ~300 ms anyway), and `state` ops
  bearing `video_want` ride a **dedicated loose window (~2 s)** — a separate
  window, NOT an exemption: the state throttle stays the only server-side
  bound on the permission-resolver path, and the ladder's ~10 s cadence
  cannot legitimately need faster.
- **One live call per channel** — registry-enforced; a start racing the
  live call resolves as a join of it (no error surface), and the live
  call's ring semantics stand as the first starter set them.
- **Permission denials are silent** — a `start` failing `START_CALL` or
  the live `VIEW_CHANNEL` consult, and a `join`/`state` failing the live
  view check, are dropped without an error surface (the typing non-oracle
  doctrine) and counted as `[:cytale, :calls, :op_error]` telemetry. A
  rights-epoch bump mid-call evicts participants whose live view failed
  (a `forced_leave` CallUpdate per leg, media teardown client-side).
- **Caps** — a per-user concurrent voice-leg limit (2 across all live
  calls; re-joining a call you already leg in displaces your own leg and
  never trips the cap) and a per-workspace aggregate live-PC ceiling
  (sized under the configured media UDP port range, 1000 by default).
  Exceeding either rejects the op (no close, no error surface) with
  `[:cytale, :calls, :op_error]` telemetry naming the ceiling.
- **Ring is once per call** — honored at start or via the first
  `state`-action `ring: true`; later ring requests on the same call are
  ignored server-side (clients dedupe on `call_id` regardless). Ring
  targets: connected members passing the live `VIEW_CHANNEL` check, minus
  notification-muted ones (see the REST mute route), minus the initiator.

### op 23 Call Signal

Opaque media-signaling relay (SDP/ICE) between a call participant and the
channel's call room. The gateway never interprets `body`:

```json
{
  "op": 23,
  "d": {
    "channel_id": "234567890123456789",
    "kind": "sdp",
    "body": "<opaque signaling blob>"
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `channel_id` | string | Required. Channel whose live call the signal belongs to. |
| `kind` | string | Required. `sdp` \| `ice` — the signaling class (used for ingress validation; the relayed payload stays opaque). |
| `body` | string | Required. Opaque signaling blob — SDP or ICE candidate payload as a string. Capped at **128 KiB (131072 bytes UTF-8)** — raised from 64 KiB at calls-V2 (25-participant simulcast offers and multi-share worst cases measured past the old cap); larger bodies are rejected at ingress. |

Server-enforced contract: the sender must be a **current participant of the
live call** on `channel_id` — signals from anyone else are silently dropped
(no protocol error, no visibility oracle). The body cap and a typing-style
per-session throttle apply at ingress. Relayed signals are delivered to the
recipient as user-keyed [CallSignal](./events.md#callsignal) events.
Signaling is **ephemeral by nature**: a resumed client replays buffered
`CallSignal` dispatches like any other, but stale SDP/ICE describes a dead
negotiation — discard replayed bodies and await fresh state
([CallSync](./events.md#callsync) plus the room's re-offer).

## Compression

Compression is optional and negotiated per connection at Identify. Two
streaming codecs are offered (in Hello's `compression_modes`):

| Codec | Wire value | Notes |
| --- | --- | --- |
| zstd stream (preferred) | `"zstd_stream"` | Persistent per-connection zstd streaming context: successive frames share compression history, so repeated envelope shapes compress incrementally better. |
| zlib stream (fallback) | `"zlib_stream"` | Raw DEFLATE (no zlib header) with sync flushes — the NATIVE codec, matching the web client's `DecompressionStream('deflate-raw')`. (The compat TRANSPORT stream below is zlib-WRAPPED instead; they are deliberately different, and a change to one must not move the other.) |
| none | `null` | Plain JSON text frames. |

Client-visible rules:

- Handshake frames — Hello, the READY/RESUMED dispatch, and the
  Invalid Session frame on the resume close path — always travel as **plain
  JSON text frames**, even on a payload-compressed connection (a client's
  inflater may be replaced mid-handshake). Transport-compressed connections
  are the exception: their whole wire is the stream (below).
- Once connected, compressed sessions carry every subsequent SERVER→CLIENT
  frame as a **binary WebSocket frame containing exactly one compressed
  envelope** — no cross-frame concatenation. Uncompressed sessions use text
  frames.
- Payload compression is **server→client only**: client frames are ALWAYS
  plain JSON text frames, whatever codec Identify negotiated (Discord's
  semantics — and no browser runtime ships a zstd compressor). Inbound
  decoding therefore happens **only** on the transport path below, and it is
  keyed on the FRAME OPCODE, not on the connection's codec: a text frame is
  plain JSON, a binary frame is a member of the transport stream.
- **Transport compression** (compat clients): `?compress=zlib-stream` on the
  connection URL opts every SERVER→CLIENT frame — Hello and the rest of the
  handshake included — into one shared **zlib stream** (window bits 15: a
  zlib header, sync-flush-terminated members, `00 00 ff ff`), which is what
  Discord's transport compression is and what every conformant library
  inflates with (discord.py's `zlib.decompressobj()`, Node's
  `zlib.createInflate()`).
  **Client frames do NOT ride that stream**: a client sends plain JSON TEXT
  frames exactly as on an uncompressed connection (no Discord library
  compresses outbound — discord.py ships no compressor at all), and the
  server accepts a BINARY frame as a compressed member for clients that
  choose to compress. This is Discord's transport compression, distinct from
  the per-payload `d.compress` negotiation above; the two never combine (the
  transport stream wins).

## Close codes

The server closes WebSocket connections with Discord-shaped codes:

| Code | Meaning | Client action |
| --- | --- | --- |
| 4000 | Unknown error — resume may still work | Reconnect; try Resume. |
| 4001 | Decode error — invalid JSON, malformed envelope, bad `op` type, unknown compression mode | Fix the frame; Resume is unlikely to help. |
| 4002 | Unknown opcode (includes forever-unassigned ops 4/8, undefined reserved ops, and server-to-client ops sent by a client) | Fix the frame. |
| 4003 | Not authenticated — heartbeat/command before Identify | Identify first. |
| 4004 | Authentication failed — bad or expired token | Get a fresh token via REST, then re-Identify. |
| 4005 | Already authenticated — Identify/Resume after READY | Open a new socket for a second session. |
| 4007 | Invalid seq — Resume `seq` ahead of the server high-water mark | Full-sync: rebuild from REST, then re-Identify. |
| 4008 | Rate limited — too many Identify/Resume attempts; ALSO the per-principal session cap (compat sessions: a 9th concurrent live session on one machine principal) | Wait the suggested delay / close one session before reconnecting (see below). |
| 4009 | Session timeout — 5 missed heartbeat intervals | Reconnect; the session may still be resumable if within the window. |
| 4012 | Invalid API version — Identify `v` outside the credential's accepted set (native: `1` only; compat: `10` or `1`) | Use the version Hello advertised. |
| 4013 | Invalid intents — compat Identify carried intent bits outside Discord's defined mask (e.g. `1 << 26`), or a negative value. **Terminal** (Discord semantics, like 4014) — reconnecting with the same intents will fail again | Fix the bitmask, then reconnect. Native clients never receive 4013 (native Identifies ignore `intents`). |

Any close may be preceded by an Invalid Session (`op 9`) frame carrying the
resumable flag; treat `d: false` as "session gone — re-Identify" and `d: true`
as "retry Resume."

### op 24 Focus Update

Client-declared focus report: is **this** session the one the member is
currently looking at? Notification delivery reads it so that one event does
not buzz every device the member has open — the focused session suppresses the
push for its own principal, while the other sessions still receive the dispatch.

```json
{
  "op": 24,
  "d": { "focused": true }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `focused` | boolean | Required. `true` when this session has the member's attention; `false` when it loses focus. A non-boolean closes with **4001**. |

No ack frame is returned (`op 11` is heartbeat-only); the report is a
best-effort hint, and a stale `true` only ever costs the member a push they
did not need — never a missed message, which is still delivered on the wire.

**Compat sessions** receive this op and silently ignore it: Discord has no
focus concept, and letting a machine principal claim focus would suppress the
owning human's own notifications.

### Reconnect etiquette

- **Jittered, bounded retries.** Reconnect storm damping exists server-side:
  admission attempts per client IP are capped per 10-second sliding window —
  30 Identify and 60 Resume attempts per window; refusals close with **4008**
  and a suggested wait of 2500 ms. Clients must back off exponentially and
  jitter rather than hammer.
- **Honor Reconnect immediately:** the server is dropping the
  connection (e.g. planned shutdown drain). Native sessions receive op 6 and
  compat sessions op 7 (Discord's dialect — see the note under
  [Opcodes](#opcodes)). Close, re-handshake with Resume, and expect the
  replay to bridge the gap. During planned shutdowns the server staggers
  Reconnect frames across sessions at roughly 4 per second, so clients
  reconnect in a wave, not a stampede — clients should jitter their own
  reconnect delay too. After a RESTRICTION-PROFILE teardown the Reconnect is
  followed by an Invalid Session (resumable false): the stored records were
  purged so the narrowed rights require a fresh Identify.
