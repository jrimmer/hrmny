# Discord Compat REST

> **Status: shipped (bots plan U6; consolidated U14; components plan U5).** The
> compat prefix serves the bot route subset with Discord shapes so
> off-the-shelf Discord libraries can talk to Cytale with `Authorization:
> Bot`. The native [`/api/v1`](./rest.md) contract is unchanged and remains
> the primary surface. Compatibility is proven by consumption: `pnpm
> compat:check` (`tools/discord-compat-check.mts`) drives a pinned real
> Discord client library (discord.js) through the full scenario — connect,
> filtered events, send, reply, interaction loop, webhook execute,
> restricted agent, revocation, and the components click loop (buttons +
> `interaction.update()`, `deferUpdate` → `editReply`, select values, DM
> clicks).

**Doctrine — compatible at the edge, native underneath; every divergence is
written down.** The compat surface is byte-compatible wherever a third-party
library is watching: payload shapes, error codes, and library-visible
behaviors are pinned so a pinned discord.js client works unmodified, and the
consumption harness above is the standing gate against drift. Where
Discord's shape encodes a subsystem Cytale does not have (guild machinery,
custom emoji, privileged intents…) or a policy it deliberately chose
differently (epoch, caps, single-use acks…), we diverge *deliberately* — and
the divergence, its reason, and its owning requirement live in the
[divergence ledger](#divergences-from-discord-binding-notes) below. An
undocumented divergence is a bug; a documented one is a design decision a
bot author can code against.

## Prefixes

Two aliases, one contract (KTD7):

| Prefix | Purpose |
| --- | --- |
| `/api/v10` | Discord-versioned — for libraries that pin a REST version. |
| `/api` | Bare unversioned — for libraries that append their own version segment. |

Both prefixes serve the identical route set, share rate-limit buckets (the
prefix is stripped from the bucket identity), and are documented ONLY here.
The native `/api/v1` surface keeps its own envelope, error keys, and
versioning policy; the two never mix.

## Authentication

`Authorization: Bot cytbot_…` — **Bot scheme only** (R7):

- `Bearer cytbot_…`, `Bearer <JWT>`, and `Bot <JWT>` are a uniform `401`
  `{"code": 0}` — the compat prefix never serves the human Bearer path.
- Tokens are minted/rotated out-of-band on the native surface
  (`POST /api/v1/bots` — a bot is always user-owned; there is no
  workspace-scoped minting).
- Revocation is row delete: the next REST call 401s. Failure responses never
  distinguish missing/bad/expired/revoked (no token-state oracle).

## Route subset

| Route | Method | Response |
| --- | --- | --- |
| `/users/@me` | GET | Discord user object (below). |
| `/applications/@me` | GET | The authenticated application object ([below](#application-object)). Discord libraries fetch it during `login()`, BEFORE the socket opens; served at both this spelling and `/oauth2/applications/@me`. |
| `/users/@me/channels` | POST | Open (or fetch) a DM with `recipient_id` — the Discord DM channel object ([below](#bot-dms-b-1)). |
| `/users/@me/channels` | GET | **Bare JSON array** of the bot's DM channels ([below](#bot-dms-b-1)). |
| `/users/@me/channels/{dm_id}/messages/search` | GET | DM search — CYTALE EXTENSION ([below](#search-cytale-extension-b-4)). |
| `/gateway/bot` | GET | Gateway bootstrap (below). |
| `/channels/{channel_id}` | GET | Discord channel object (below) — carries `topic` and `parent_id`, the two real columns this projection used to drop. |
| `/channels/{channel_id}` | PATCH | Discord's **Modify Channel**: `{name?, topic?, position?}`, `MANAGE_CHANNELS` on the channel, `200` with the updated object from the SAME builder the read and the `CHANNEL_UPDATE` dispatch use. Absent key = unchanged; `topic: null` clears it. A DM id is `10003`; an unrenderable body is `400 50035` and applies nothing. A **THREAD id** takes `{archived}` instead — a thread IS a channel in Discord, and this is how every client archives one: `200` with the thread object (`thread_metadata.archived`) plus a `THREAD_UPDATE` fan-out. Gated on being the thread's owner or a moderator of the parent (`manage_messages`/`manage_threads`): a visible-but-unpermitted caller is `50001`, a non-boolean body `400 50035`, and the thread stays directly readable either way (archiving hides it from the listings, it does not change access). |
| `/channels/{channel_id}/messages` | GET | **Bare JSON array** of message objects, newest-first. `?limit=` (1–100, default 50), `?before=<snowflake>` or `?after=<snowflake>` (exclusive; `after` returns the messages just past the anchor, still newest-first; `before` wins if both are sent; `around` is not supported). The id may be a THREAD id, read from the thread's own index — [threads are channels](#threads-are-channels-c-2) (below). |
| `/channels/{channel_id}/messages` | POST | `201` message object. Body `{content, message_reference?, nonce?, attachments?, embeds?, components?}` — as JSON, or as multipart (`payload_json` part + `files[n]` parts, [below](#file-uploads-multipart-filesn--payload_json)). |
| `/channels/{channel_id}/messages/{message_id}` | PATCH | Message object. Body `{content?, embeds?, components?}`, at least one. Author-only. A bot's `embeds`/`components` are each a wholesale replace under the create's caps (a person's are ignored); absent or null `content` keeps the stored text. `MESSAGE_UPDATE` fan-out. |
| `/channels/{channel_id}/messages/{message_id}` | DELETE | `204`, empty body. Author-only. |
| `/channels/{channel_id}/messages/{message_id}/reactions/{emoji}/@me` | PUT / DELETE | Add / remove the bot's OWN Unicode-emoji reaction (below). `204`, empty body. |
| `/channels/{channel_id}/messages/{message_id}/reactions/{emoji}` | GET | **Bare JSON array** of user objects who reacted with `{emoji}` (below). `?limit=` (1–100, default 100), `?after=<snowflake>` (exclusive user_id cursor). |
| `/channels/{channel_id}/messages/{message_id}/reactions/{emoji}` | DELETE | Clear that emoji for EVERYONE — `manage_messages`. `204`, empty body. |
| `/channels/{channel_id}/messages/{message_id}/reactions/{emoji}/{user_id}` | DELETE | Remove ANOTHER principal's reaction — `manage_messages`. `204`, empty body. |
| `/channels/{channel_id}/messages/{message_id}/reactions` | DELETE | Clear EVERY reaction — `manage_messages`. `204`, empty body. |
| `/channels/{channel_id}/messages/{message_id}/ack` | POST | Read-ack (C-4, [below](#read-ack-c-4)). `200` `{"token": null}`. |
| `/channels/{channel_id}/typing` | POST | Typing indicator (C-3, [below](#typing-c-3)). `204`, empty body. |
| `/channels/{channel_id}/messages/search` | GET | Channel search — CYTALE EXTENSION ([below](#search-cytale-extension-b-4)). |
| `/guilds/{guild_id}/members/@me` and `/guilds/{guild_id}/members/{user_id}` | PATCH | Set or reset a nickname (#169): Discord's Modify Current Member and the `nick` field of Modify Guild Member (`guild.me.edit(nick=…)`, `member.edit(nick=…)`). Only `nick` is supported; any other field is `400 50035`. The bot's own needs its grant at `read_write`; another member's needs MANAGE_NICKNAMES (never in a grant) → `403 50001`. Unknown member `404 10007`. `200` the member object; `GUILD_MEMBER_UPDATE` follows (GUILD_MEMBERS intent). |
| `/channels/{channel_id}/messages/{message_id}/threads` | POST | Start a thread from a message (B-2, [below](#thread-writes-b-2)). `200` thread channel object. |
| `/channels/{channel_id}/threads` | POST | Start a standalone thread (B-2). `200` thread channel object. |
| `/channels/{thread_id}/thread-members/@me` | PUT / DELETE | Join / leave a thread (B-2). `204`, empty body. |
| `/channels/{thread_id}` | GET | The THREAD channel object — a thread id resolves here, not a `10003` ([below](#thread-reads-discovery-and-deletion)). Byte-identical to the start response and to the `THREAD_CREATE` dispatch (`newly_created` aside — that key is event metadata). |
| `/guilds/{guild_id}/threads/active` | GET | `{threads, members, has_more}` — the guild's ACTIVE threads, from channels the caller can view ([below](#thread-reads-discovery-and-deletion)). |
| `/channels/{channel_id}/threads/archived/public` | GET | The same envelope for the channel's ARCHIVED threads. |
| `/channels/{thread_id}` | DELETE | Delete a THREAD — `204` ([below](#thread-reads-discovery-and-deletion)). A real CHANNEL id is refused with `403 50001`; channel deletion is not exposed to bot credentials. |
| `/applications/{bot_id}/guilds/{workspace_id}/commands` | GET / PUT / POST | Application-command registration + read (U8 — [below](#application-commands-registration-u8)). `PUT` `200` stored array / `POST` `201` single object / `GET` `200` stored array (the read half safe-sync's fetch→diff→PUT begins with). |
| `/interactions/{interaction_id}/{token}/callback` | POST | Interaction callback (U8 — [below](#interaction-callback-u8); types 4/5/6/7/9, components plan U3 — [below](#interactive-components-buttons--select-menus)). **No `Authorization` header.** `204`, empty body. |
| `/webhooks/{application_id}/{token}` | POST | Interaction followup create — the CONTINUATION route (components plan U3 — [below](#interactive-components-buttons--select-menus)). **No `Authorization` header.** `200` message object. |
| `/webhooks/{application_id}/{token}/messages/@original` | GET / PATCH / DELETE | The pinned `@original` message (components plan U3 — [below](#interactive-components-buttons--select-menus)). **No `Authorization` header.** |

Everything else in Discord's REST — guild routes, member/role routes,
the channel COLLECTION — is out of scope for U6; see
[unsupported surface](#unsupported-surface) below.

## Reactions (Unicode emoji)

Discord's six reaction routes over the same storage and fan-out seam the
native surface serves. **Unicode emoji only**: `{emoji}` is the raw emoji
text (e.g. `👍`, URL-encoded in the path) — at most **20 distinct emojis
per message** (Discord's cap), each 1–14 UTF-8 bytes, and custom-emoji
`:name:` syntax is a `400 50035` (Cytale has no emoji system, so the
Discord emoji object's `id` is always `null`).

- `PUT …/reactions/{emoji}/@me` — add the bot's own reaction. Idempotent:
  a re-add is still `204` but emits NO event and moves no count.
- `DELETE …/reactions/{emoji}/@me` — remove own. `204` idempotent.
- `GET …/reactions/{emoji}` — the reacting principals as a **bare JSON
  array of user objects** (machine principals carry `bot: true`), ascending
  by user id; `?limit=` (1–100, default 100) and `?after=` (exclusive
  user_id cursor — feed the last id of the page back, Discord's model).
- `DELETE …/reactions/{emoji}` / `DELETE …/reactions` / `DELETE
  …/reactions/{emoji}/{user_id}` — the `manage_messages` admin set (a
  visible-but-unpermitted caller gets the real `403 50001`).

Realtime: every state-changing operation fans the NATIVE reaction events
through the channel-keyed seam; compat sessions observe
`MESSAGE_REACTION_ADD` / `MESSAGE_REACTION_REMOVE` /
`MESSAGE_REACTION_REMOVE_ALL` (Discord payload shapes, gated on the
`GUILD_MESSAGE_REACTIONS` intent — see
[gateway.md — Intents](./gateway.md#intents-compat-sessions)). Discord's
event split applies: an emoji sweep emits one `MESSAGE_REACTION_REMOVE`
per removed user; only the full clear emits `MESSAGE_REACTION_REMOVE_ALL`.
Message objects (history, create/update echoes) carry a `reactions` array
in Discord's shape when reactions exist — see
[objects](#message-object).

Gates: the standard anti-enumeration channel gate (`404 10003`) on every
route; a missing message is `404 10008`; an invalid/oversized/21st-distinct
emoji is `400 50035`.

## Bot DMs (B-1)

DM channels are channels of `type: 1` (Discord's DM type) between exactly
two principals. `POST /users/@me/channels {recipient_id}` opens the DM (or
fetches the existing one — always `200`, Discord's create-or-get) and
returns the Discord DM channel object:

```json
{
  "id": "89441171033554944",
  "type": 1,
  "recipients": [ { "user object of the OTHER participant": "..." } ],
  "last_message_id": "89441171033554945"
}
```

`GET /users/@me/channels` lists the bot's DMs as a **bare JSON array** of
the same objects. `recipients` always EXCLUDES the caller (Discord's shape —
the other participant only), and `last_message_id` denormalizes onto the DM
row at send time (the same field the channel object carries).

**Messages/reactions/typing/ack ride the EXISTING channel routes on the DM
channel id** — `GET/POST /channels/{dm_id}/messages`, the six reaction
routes, `POST /channels/{dm_id}/typing`, `…/ack` — with one gate change:
the anti-enumeration channel gate resolves a DM id through RECIPIENT
MEMBERSHIP, and **participation IS authorization** (Discord's DM rule — a
recipient can send/read/react; the gate returns the full bitfield). A
non-participant gets the identical `404 10003` on every DM route (a DM's
existence is not an oracle).

Gateway: DM-anchored events deliver to the bot's session on
`DIRECT_MESSAGES` (`1 << 12` — MESSAGE_CREATE carries the DM channel_id),
`DIRECT_MESSAGE_REACTIONS` (`1 << 13`), and `DIRECT_MESSAGE_TYPING`
(`1 << 14`); wire all three as a set. Delivery is recipient-gated (the
compat dispatch filter resolves the DM row and checks the pair, NOT the
workspace visible-set), and DM payloads carry NO `guild_id` (Discord's DM
shape). Fan-out addresses both participants' user keys — the bot's own
session receives its own DM sends, and the human participant's NATIVE
sessions receive the ordinary CamelCase events through the same seam.

**Restrictions deliberately DO NOT apply to DMs (pinned):** channel
allowlists are workspace-scoped and a DM has no workspace — a
channel-allowlist (even zero-channel) agent can still DM its parent, and
the parent's replies flow back. This is Discord parity (Discord bots DM
users regardless of in-guild channel permissions), NOT an escape hatch into
workspace channels: the resolver gates everything else exactly as before.

Kind guard (Discord parity, enforced on BOTH the compat and native open
routes): only :human ↔ :human and :human ↔ machine pairs may open a DM —
**machine ↔ machine is a `400 50035`** (Discord disallows bot-to-bot DMs),
webhooks are not DM-able at all, and an unknown `recipient_id` is a
`404 10013 Unknown User`. The NATIVE surface gains the same semantics
(`POST /api/v1/users/{user_id}/channels` accepts machine recipients now;
message/history routes on DM ids work for participants — see
[native DMs](./rest.md#dms)).

Why machine ↔ machine is rejected (decision of record, 2026-09): **loop
prevention.** Two autonomous clients in a private channel are a natural
ping-pong — A posts, B's handler fires, B responds, A's handler fires,
forever — with no human watching the side channel. Discord's parallel rules
serve the same purpose (bots cannot invoke other bots' slash commands;
libraries ignore webhook-authored messages by default). Agents that need to
interact belong in a **shared workspace channel**, where visibility,
attribution, and restrictions all apply and humans can see their automation
working. The rule is a one-line relaxation of the kind guard in
`Cytale.Workspaces.open_dm` if ever deliberately reversed — pinned by test
exactly so the decision stays visible.

## Threads are channels (C-2)

Discord treats threads as channels, and so does the compat surface: the
standard message routes accept a THREAD id.

- `GET /channels/{thread_id}/messages` serves the thread's history as a
  bare JSON array of message objects whose `channel_id` IS the thread id
  (replies live in the parent's storage partition with `thread_id` set —
  the route re-renders them onto the thread, `message_reference.
  channel_id` included). `?limit=`/`?before=` map to native pagination over
  the thread's replies.
- Authorization anchors on the PARENT channel (thread visibility rides the
  parent's rights): the caller needs view + `read_message_history` there.
  Every miss — unknown thread, unknown channel, out-of-profile parent —
  renders the identical `404 10003 Unknown Channel` (anti-enumeration; a
  thread never leaks its existence through a 404-vs-403 oracle).
- Thread REPLIES are POSTable (compat-surface remainder): the whole
  message-write surface takes a THREAD id — `POST /channels/{thread_id}/messages`
  (the reply rides the native reply route's OWN send pipeline: the durable
  nonce dedupe, the dual emission, auto-follow-on-reply, the discovery
  counters; it needs `send_messages` in the PARENT channel, the native reply
  route's gate — a read-only principal gets `403 50001`), and
  `PATCH`/`DELETE /channels/{thread_id}/messages/{mid}` edit/delete a thread
  reply (author-only, storage anchored on the parent partition). The reply
  body is the CHANNEL send's surface — `content`, `attachments`, `embeds`
  and `components` under the same validation and caps, embed-only included
  (content persists `""`) — so a bot's interactive card posts in a thread
  exactly as it does in a channel. `message_reference` is ACCEPTED (a
  thread reply is a real reply — the row stores `reply_to_id` and the wire
  renders Discord's type-19 REPLY shape, `message_reference` with the THREAD
  id as its channel). The reference must name a message IN THAT THREAD —
  a message on the parent channel's timeline or in another thread is a
  `400 50035`, the native reply route's rule and Discord's (a thread is a
  channel, and a reply stays in its own). Earlier builds resolved it against
  the whole parent partition.
  The shared builder keeps the 201 response and the live
  `ThreadMessageCreate` dispatch identical, embeds and action rows included.
  (Until thread cards shipped, `embeds`/`components` were refused here with
  `400 50035` because the thread wire did not carry them; it does now.)
  A click on a card inside a thread arrives as `INTERACTION_CREATE` whose
  `channel_id` — and `message.channel_id` — is the THREAD id (Discord's
  shape); the native payload keeps the parent as `channel_id` and adds
  `thread_id`. Every answer to such a click — the type-4 reply, followups
  (callback or `POST /webhooks/{app}/{token}`), a type-5 deferred reply —
  posts IN the thread (the thread reply's dual emission, auto-follow and
  discovery counter), and type-7 / `@original` edits flip the card in place,
  answering with the thread id as `channel_id`.
  Reaction
  routes take a thread id too (storage + events anchor on the parent, exactly
  like a web-initiated reaction on a thread message), as do `POST /channels/
  {thread_id}/typing` (the `TYPING_START` dispatch carries the THREAD id as
  `channel_id`) and the ack route — a thread ack writes the THREAD read
  watermark (`Threads.Member.mark_read`, the native follow-state writer; a
  no-op for a principal with no membership row — an ack never mints one).
- Live events agree with the reads: the dual emission's parent-anchored
  `MessageCreate` leg is NOT delivered to compat sessions (Discord never
  delivers a thread reply to the parent channel; the `ThreadMessageCreate`
  leg already carries it on the thread id), and a thread reply's
  `MESSAGE_UPDATE`/`MESSAGE_DELETE` land on the THREAD id (the payload's
  `thread_id` re-anchors them). Known residual divergence: reaction events on
  a thread message carry the PARENT channel id on both wires (the native
  reaction payload has no thread scope to translate from).

## Thread writes (B-2)

Discord's thread-management routes, mapped onto the native thread
machinery:

| Route | Method | Response |
| --- | --- | --- |
| `/channels/{cid}/messages/{mid}/threads` | POST | `200` Discord thread channel object (from-message start). |
| `/channels/{cid}/threads` | POST | `200` thread channel object (standalone start — no anchoring message). |
| `/channels/{thread_id}/thread-members/@me` | PUT | `204` empty — join (follow, idempotent). |
| `/channels/{thread_id}/thread-members/@me` | DELETE | `204` empty — leave (membership row removed, idempotent). |
| `/channels/{thread_id}/thread-members` | GET | The thread-member roster (compat-surface remainder — Discord's `fetch_members`): a bare array of Discord thread-member objects (`id` = the thread id, `user_id`, `join_timestamp`, `flags: 0`). |
| `/channels/{thread_id}/thread-members/@me` | GET | The CALLING principal's own membership, same object; a principal with no membership row gets the uniform `10003` (anti-enumeration — the same answer as an invisible thread). |

Both starts take `{name, auto_archive_duration}` (the standalone form also
`type`); `name` is 1–100 bytes (else `400 50035`) and
`auto_archive_duration` is ACCEPTED AND IGNORED (Cytale has no auto-archive
— documented divergence). The response is the type-11 thread channel object
with `thread_metadata` — the same shape the [GUILD_CREATE threads
inventory](#guild_create-threads-inventory-c-1) carries (`parent_id`, the
owning `guild_id`). A fresh Snowflake thread id is minted (Discord's shape)
— unlike the native REST start, whose id pins to the anchor message.

Two Discord shapes this surface deliberately does NOT serve:

* **Thread renames.** `PATCH /channels/{thread_id}` writes `archived` only;
  a `{name}` body is `400 50035`. Cytale has no thread rename on
  EITHER surface (names are derived from the seed message; the native
  `PATCH /threads/:id` is archive-only), so serving it here would mint a
  compat-only mutation.
* **`PATCH /channels/{thread_id}/thread-members/@me` (`{flags}`).** Discord's
  thread-notification bitmask has no Cytale mapping — the native follow-state
  write is `PATCH /threads/:id/members/@me` (`notify`/`last_read_id`), whose
  semantics do not project onto Discord's flag bits without inventing them.

Gates: the standard channel gate on the PARENT channel — `send_messages`
for the starts, `view_channel` for join/leave and the roster reads (thread
visibility rides the parent's rights); an out-of-profile parent is the
identical `404 10003`.
A dangling anchor message on the from-message start is `404 10008 Unknown
Message`. Starts publish the ordinary `THREAD_CREATE` (GUILDS intent);
join/leave emit no THREAD_MEMBER_* dispatches (thread-membership rides no
intent on this surface — divergence). The thread's messages then flow via
the existing translation (`MESSAGE_CREATE` on the thread id).

## Thread reads, discovery and deletion

Threads were WRITE-ONLY: the start responses handed out a thread id, and every
route that could resolve it again answered `404 10003`. A client could create a
thread and never use it (`fetch_channel(thread_id)` → `NotFound`), a client that
reconnected could never find one, and every created thread was permanent debris
with no API path to remove it. All four routes now exist:

| Route | Method | Response |
| --- | --- | --- |
| `/channels/{thread_id}` | GET | The thread channel object. |
| `/guilds/{guild_id}/threads/active` | GET | `{threads, members, has_more}`. |
| `/channels/{channel_id}/threads/archived/public` | GET | `{threads, members, has_more}`. |
| `/channels/{thread_id}` | DELETE | `204`, empty body. |

ONE builder (`MessageCodec.thread_channel/2`) serves the start response, this
read, the `THREAD_CREATE` dispatch and the GUILD_CREATE inventory, so a read is
byte-identical to the object the event carried (`newly_created` aside — event
metadata). The same rule the roster member, the thread event
and the reaction member were each fixed with.

Gates: the read and the archived listing ride the standard channel gate on the
PARENT (an unknown thread and an out-of-profile parent both render `10003`,
so a thread never leaks existence). The active listing takes the
WORKSPACE-level resolve — a machine principal's rights come through its parent
— and lists only threads in channels the caller can VIEW, through the same
visibility computation the gateway's per-socket memo uses. An unknown or
invisible guild is `404 10004 Unknown Guild` (not the channel code: the route
is guild-scoped).

DELETE takes the thread's owner or `manage_threads` on the parent; otherwise
`403 50001`. Divergences, both deliberate:

* **Deleting a real channel is not exposed.** A channel id on this route is the
  honest `403 50001` (visible) or `10003` (not), and nothing is destroyed —
  `MANAGE_CHANNELS` on a bot credential is a separate authorization decision.
* **A deleted thread's MESSAGES are left in place.** They become unreachable
  rather than deleted (the message table is keyed by the thread id and is
  TimeWindow-compacted, so a delete writes tombstones either way); what
  disappears is everything that made the thread listable and openable.
* The listings send `"members": []` rather than fabricating each thread's
  thread-member object for the requesting user, and `has_more` is always
  `false` (the list is capped at **100 threads**).

## GUILD_CREATE threads inventory (C-1)

The synthesized GUILD_CREATE (gateway compat sessions) carries a `threads`
array alongside `channels`: the workspace's threads whose PARENT channel is
in the session's visible set, as Discord thread channel objects — type `11`
(PUBLIC_THREAD):

```json
{
  "id": "89441171033554944",
  "guild_id": "89441170000000000",
  "parent_id": "89441170979028992",
  "name": "deploy follow-ups",
  "type": 11,
  "owner_id": "89441170000000000",
  "message_count": 5,
  "member_count": 2,
  "thread_metadata": {
    "archived": false,
    "auto_archive_duration": 1440,
    "archive_timestamp": "2026-09-04T19:27:16.912Z",
    "locked": false,
    "invitable": true,
    "create_timestamp": "2026-09-04T19:20:00.000Z"
  }
}
```

`owner_id`, `message_count`, `member_count` and the metadata's `archived` /
`auto_archive_duration` / `archive_timestamp` are **required by client
parsers** (`discord.py`'s `Thread._from_data` and `Thread._unroll_metadata`
index every one of them unguarded), and all three counts are real Cytale
data. The optional `locked` / `invitable` / `create_timestamp` are sent as
well. `create_timestamp` replaces an earlier `thread_created_at` key, which
was not a Discord field at all.

Discord libraries (discord.js) build their thread cache from it at
connect. Divergences: the list is capped at **100 threads per guild**
(Discord's GUILD_CREATE is unbounded — Cytale truncates so a thread-heavy
workspace cannot bloat the Identify burst). The cap keeps open threads
before archived ones, most recently active first, and a thread it leaves out
is announced with a `THREAD_CREATE` (no `newly_created`) just before the
first message from it, so a client never meets a thread message from a
channel it has no record of. `joined` is always `false`
(thread follow state is not part of the compat session surface),
`auto_archive_duration` is a **fixed 1440** (Discord's default — Cytale has
no archive schedule; the key is sent because the parser requires it), and
`archive_timestamp` carries the thread's **last activity** (falling back to
its creation) rather than an archive deadline, since nothing here archives.

## Typing (C-3)

`POST /channels/{id}/typing` — the channel gate runs (the same
anti-enumeration seam as every compat write), then the NATIVE typing
fan-out fires: consumers on the gateway observe the ordinary
`TYPING_START` dispatch (compat sessions get the Discord-shaped payload,
native sessions the native one — identical to the native REST fallback).
Discord's response is **`204`, empty body** — so is Cytale's. A channel the
caller cannot view is the identical `404 10003`.

`TYPING_START` carries `user_id` (who is typing) and `timestamp` in epoch
SECONDS, and rides the `GUILD_MESSAGE_TYPING` intent (`DIRECT_MESSAGE_TYPING`
for DM channels) — a session that does not request it receives no typing
events at all, per Discord's intent table. Discord does not echo a user's own
typing back to that user, not even to their other sessions: the compat
filter drops `TYPING_START` whose `user_id` IS the session's identity. The
native wire keeps its own long-standing behaviour.

Reaction events (`MESSAGE_REACTION_ADD` / `_REMOVE` / `_REMOVE_ALL`) are
broadcast to every session subscribed to the channel, the actor's own included
— Discord echoes a reaction back to the client that added it, and the ack path
depends on it. They ride `GUILD_MESSAGE_REACTIONS`
(`DIRECT_MESSAGE_REACTIONS` in DMs).

## Read-ack (C-4)

`POST /channels/{id}/messages/{message_id}/ack` — Discord's read-ack route.
The channel gate runs, then read_state is recorded **for the calling
principal** (per-principal read-state, R4: a bot/agent's ack writes its own
row and never moves its parent's), and a `MessageAck` fans back to the
caller's own gateway sessions. The response is `200` `{"token": null}` —
Discord's shape; **Cytale synthesizes no read-state token** (the field is
always `null`). Misses are the identical `404 10003`.

## Body size limit (C-5a)

JSON request bodies over **2 MB** are refused with `413` before routing or
authentication (Plug's parser cap; the legitimate maximum — a full
10 × 8 KB embed send — is ~80 KB). The error renders through the JSON
error view on both the native and the compat surface (`{"errors": {...}}`
envelope). Multipart is capped independently — attachment uploads are
unaffected.

## External base URL (C-5b)

Every externally-constructed URL — `/gateway/bot`'s `url`, the compat
READY's `resume_gateway_url`, and the webhook capability URLs — derives
from the request's origin by default. Setting the `cytale,
:external_base_url` app env (e.g. `"https://chat.example.com"` — scheme +
host + optional port, NO path) replaces that origin VERBATIM: a deployment
behind a proxy with a different public origin advertises the public origin
regardless of the request's `Host` header. Unset (the default) keeps
today's conn-derived behavior.

## Webhook execution (U11)

Discord-compatible **incoming** webhook execution lives under its own
unauthenticated prefix — the URL token IS the credential (`Authorization` is
neither required nor consulted; no `Bot` scheme here):

| Route | Method | Response |
| --- | --- | --- |
| `/api/webhooks/{webhook_id}/{token}` | GET | Webhook info `{id, name, channel_id, type: 1}` — NO `user` field (Discord token-fetch parity). |
| `/api/webhooks/{webhook_id}/{token}` | POST | **204 empty** by default; `?wait=true` → the created message object. Body: Discord's execute payload (below). |
| `/api/webhooks/{webhook_id}/{token}/slack` | POST | Slack-compat `{"text": ...}` (+ optional `"username"`). **wait defaults TRUE** → message object unless `?wait=false`. |
| `/api/webhooks/{webhook_id}/{token}/github` | POST | GitHub event JSON (`X-GitHub-Event` header). **wait defaults TRUE.** `push`/`pull_request`/`issues` render a content line + embed card; every other event renders a generic "event received" line. |

Note these routes hang off the bare `/api` prefix but are NOT part of the
Bot-authenticated subset above — they sit on the shared `/api` path purely
for Discord URL compatibility.

### Execute payload (bare POST)

- `content`: 1–4000 bytes — **required unless `embeds` is present** (an
  embed-only execute persists `""`, Discord's webhook shape; same caps and
  store-and-forward rules as compat sends).
- `username` / `avatar_url`: optional per-message author override
  (`username` 1–80 chars; `avatar_url` a string ≤ 2048 bytes). The message's
  `author_id` stays the webhook PRINCIPAL — the override is stored per
  message (`author_override` on the native surface) and the compat message
  object renders it on `author.username`/`author.global_name`.
- `embeds`: exactly the compat [embed rules](#sends) (10 × 8 KB caps,
  verbatim storage).
- `allowed_mentions`: Discord's semantics, exactly as for a
  [compat send](#sends) (malformed is a `400 50035`). `@everyone`/`@here`
  also needs the webhook's CREATOR to hold `mention_everyone`.
- `tts`: accepted and ignored. `components`: interactive
  components (anything carrying a `custom_id` — buttons, selects) are
  **REJECTED with `400 50035`** (components plan R6: webhook principals have
  no gateway session to receive clicks); style-5-only **link rows are
  allowed** (client-side anchors — no interaction needed). See
  [components](#interactive-components-buttons--select-menus).
- Empty payload (no `content`, no `embeds`) or a cap violation is a
  `400 50035`.
- The body may also ride as **multipart** (`payload_json` part + `files[n]`
  parts — the same [file-upload semantics](#file-uploads-multipart-filesn--payload_json)
  as compat message create): stored files attach to the executed message and
  render in the `wait=true` message object.

### Authorization — none (capability semantics, KD8)

Execute validity = **the webhook row + the channel existing**. There is no
permission/resolver check at execute: the creating admin leaving the
workspace does NOT kill the webhook. Channel deletion cascades the webhook
rows (execute 404s afterwards). Webhook principals carry no gateway
credential — the URL token is the only capability (native
[management routes](./rest.md#webhooks) create/rename/delete under
`manage_channels`).

### Anti-enumeration (binding)

Unknown id, wrong token, deleted webhook, deleted channel — ALL render the
byte-identical `404 {"code": 10015, "message": "Unknown Webhook"}` (both GET
info and POST execute). Nothing about the response distinguishes the legs.

### Webhook rate limits

Each webhook pair (`{id}/{token}`) has its own bucket: **5 requests / 2
seconds** (independent of the global compat bucket above and of every other
webhook). Responses carry the `X-RateLimit-*` set (Limit 5) with a stable
per-webhook `X-RateLimit-Bucket`; the exhausted bucket is Discord's 429 body
(`retry_after` float, `global: false`) + `Retry-After`. The bucket is
consumed before resolution — valid and bogus pairs throttle identically.

**Miss-path dam (per IP):** a forged pair is a 404, and an enumerator mints
a FRESH `{id}/{token}` per attempt — the per-pair bucket never fills. Every
anti-enumeration 404 (execute AND info misses) therefore also consumes a
per-IP miss bucket (**30 / 10s**); past the ceiling the miss renders the
shared Discord 429 instead of the 404. Valid-webhook traffic never touches
the miss bucket — the 5/2s pair bucket stays its only limit.

### Sends

- `content`: 1–4000 bytes — **required unless `embeds` is present** (an
  embed-only create persists `""` as the content, Discord's webhook shape).
- `message_reference`: Discord's reply shape `%{"message_id" => "<snowflake>"}`.
  It maps to the native `reply_to_id`. The referenced message must live in
  the same conversation — on a channel id, a message in that channel; on a
  thread id, a message in that thread. A dangling or out-of-conversation id
  is a `400 50035` validation failure (native semantics, one rule for every
  send route), never a 404 oracle. Replies return
  `type: 19` + `message_reference` + `referenced_message`.
- `allowed_mentions`: Discord's object — `parse` (a subset of `users`,
  `roles`, `everyone`), `users` / `roles` (≤ 100 ids each; naming a kind in
  `parse` AND listing its ids is a `400 50035`, as on Discord) and
  `replied_user` (default `false` once the object is sent). It decides which
  of the message's mentions NOTIFY — the text is never rewritten. Absent,
  every `<@id>` notifies and a reply reaches the replied-to author, as
  before. It only narrows: `@everyone`/`@here` still require the author to
  hold `mention_everyone` (no agent grant confers it, so a bot's broadcast
  never notifies), a listed user must appear in the content, and roles have
  no mention syntax in Cytale (accepted, nothing to act on). The same object
  is honoured, by the same code, on the native send routes and the webhook
  execute.
- `nonce`: echoed back verbatim on the created object — and the send's
  **durable dedupe key** (the `Idempotency-Key` header serves when there is
  no `nonce`), on a channel and a thread id alike: the key is reserved per
  author for 24 h before the message is written, so a retry with the same
  key answers **`200` with the original message** — across server restarts,
  5xx responses and retries that race the first POST — with no second
  message and no second `MESSAGE_CREATE`. The key names ONE message: a key
  already spent on another message — another channel, a channel vs. a
  thread, or the same conversation with a different `content`,
  `message_reference` or `attachments` (files compare by their stored
  content, so a multipart retry still replays) — is a `400 50035` naming the
  `nonce` field. The native routes answer the same cases the same way (their
  dialect: `409 idempotency_conflict`).
- `attachments`: array of native upload descriptors
  (`{url, filename, content_type, size, width?, height?}` from `POST
  /api/v1/channels/{id}/attachments` — image dims when the upload sniffed
  them, C-3), rendered back as Discord attachment objects
  (`{id, filename, content_type, size, url, width?, height?}` — string ids,
  integer `size`/`width`/`height`).
  Every present descriptor value must be a **scalar** (string, number, or
  boolean); a `null`/object/array value — or a non-map entry or non-list
  container — is a `400 50035` (never a 500).
- `embeds`: optional array of embed objects — **stored, not stripped**
  (KTD11: GitHub/Sentry webhook targets post embed-only). Caps: at most
  **10** entries, each at most **8 KB** serialized (`Jason` byte size);
  unknown keys WITHIN an embed are preserved verbatim (store-and-forward —
  the web renders `title`/`description`/`fields`, extra keys are inert).
  A non-list, a non-object entry, >10 entries, or an oversized embed is a
  `400 50035` (the native error key is `invalid_embeds`). A bot may replace
  its embeds with a message `PATCH` (as on Discord). Deletes cascade the
  stored embed rows with the message. The body (`content`, `embeds`,
  `components`) is parsed by the same code the native send routes use, so a
  bot posting this body natively gets the same message.
- `components`: optional array of action rows — **stored verbatim, never
  stripped** (components plan U1/R1; the old accepted-and-stripped R11
  divergence is gone). Validated against Discord's component caps
  ([below](#interactive-components-buttons--select-menus)); a violation is a
  `400 50035` (the native error key is `invalid_components`). Rows ride every
  read of the message (the `components` key, absent when none — the embeds
  precedent) and fan out on edits. A bot edits them with the interaction
  callback (type 7, `@original` PATCH) or with a plain message `PATCH`, as
  on Discord: discord.py's `message.edit(view=…)` — the way a View's
  `on_timeout` disables an expired card — sends `components` (and usually
  `embeds`) with no `content`.
- An `Idempotency-Key` header is read as the send key when there is no
  `nonce` (Discord libraries send the nonce), by the same durable dedupe
  described under `nonce` — one mechanism on every send route, native and
  compat.

### File uploads (multipart `files[n]` + `payload_json`)

Discord libraries send files as `multipart/form-data`: binary parts named
`files[0]`, `files[1]`, … plus a `payload_json` part carrying the usual JSON
body. Both surfaces that create messages accept this model:

- **Compat message create** `POST /api/v10|/api/channels/{id}/messages` —
  the permission gate is unchanged (`send_messages`).
- **Webhook execute** `POST /api/webhooks/{id}/{token}[/slack|/github]` —
  `payload_json` carries the execute body (or the Slack/GitHub event); the
  response rules (`?wait=`, 204 default) are unchanged.

Semantics (shared `CytaleWeb.MultipartUpload`):

- Each `files[n]` part stores through the same content-addressed store the
  NATIVE two-step flow uses — **25 MB per-file cap** and the fixed mime
  allowlist (`POST /api/v1/channels/{id}/attachments` rules). A violating
  file rejects the whole request with `400 50035` (both over-cap and
  disallowed type; a full store is `507`).
- **Which signal decides the type (binding).** A part that names a
  **specific** type is taken at its word — that value is judged against the
  allowlist and stored as given. A part with a **generic** header
  (`application/octet-stream`, `binary/octet-stream`, `text/plain`, or none
  at all) defers to the **filename extension**, which then decides both what
  is judged and what is stored. This is required for compatibility, not a
  convenience: discord.py hardcodes `application/octet-stream` on every
  `files[n]` part (`discord/http.py`) and ignores the file's own type, so a
  strict header comparison rejected every bot upload. Consequences worth
  stating: a `.png` sent as octet-stream stores (and serves, and sniffs) as
  `image/png`; an extension that maps to a KNOWN but disallowed type is
  refused rather than laundered — `.svg`, `.html`, `.js`, `.sh` sent with a
  generic header are rejected, where the old exact comparison could admit
  them as `text/plain`; an extension that maps to nothing leaves the header
  standing (so a dotless `NOTES` part still stores as `text/plain`, and a
  dotless octet-stream part is refused).
- Stored files ride the created message as Discord attachment objects:
  `{id, url, filename, size, content_type, width?, height?}` where `id` is
  a FRESH snowflake string (not the `files[n]` index), `url` is ABSOLUTE
  (`external_base_url` verbatim ∥ the request's origin — the same builder
  webhook capability URLs use), `size` is the byte size, and
  `content_type` is the RESOLVED type from the rule above.
  `width`/`height` ride along when the stored blob is a parseable
  PNG/GIF/JPEG (C-3). The `payload_json.attachments` index map (`[{id: "0",
  filename: …}]`) is consumed, not stored — stored files REPLACE it.
- `payload_json.attachments` WITHOUT any `files[n]` parts (self-hosted
  URLs) is tolerated: the descriptor array persists exactly like a JSON
  body's `attachments` array.
- JSON bodies behave byte-identically to the pre-multipart surface.

### Authorization

Per-route rights resolve through the same engine as the native surface
(`Cytale.Permissions.Principal`, parent fallback + action mask + channel
allowlist — restrictions apply):

- GETs: view + `read_message_history`.
- POST/PATCH/DELETE: view + `send_messages`; edit/delete are author-only.
- A read-restricted agent's history is filtered to its allowlist; a
  post-restricted agent gets `403 50001` on sends.
- **Anti-enumeration:** every channel-gate miss — missing row, non-member
  parent, out-of-profile restrictions, no view rights — renders the IDENTICAL
  `404 10003 Unknown Channel`. The same shape covers missing and forbidden.

## Application commands registration (U8)

`PUT /api/v10/applications/{bot_id}/guilds/{workspace_id}/commands` — guild
is the workspace (KTD7). The body is Discord libraries' bulk-overwrite JSON
ARRAY `[{name, description, options?}]` and IS the application's command
set: names absent from the payload are deleted, surviving names keep their
ids. `POST` with a single object upserts one command and leaves siblings
alone.

Authorization (binding, KTD13): the upsert is rejected unless `{bot_id}`
equals the authenticated principal (a foreign application id renders the
identical `404 {code: 10002}` as an unknown one — anti-oracle) AND the
principal-rights resolver returns non-zero rights for `{workspace_id}`
(non-membership or a fully-masked profile → `403 {code: 50001}`; unknown
workspace → bare `404`).

CHAT_INPUT validation: `name` matches Discord's regex
`^[-_\p{L}\p{N}]{1,32}$` AND is lowercase; `description` is 1–100 chars;
`options` ride verbatim (≤ 8 KB JSON). Violations render `400 {code:
50035}`. The response carries Discord's application-command objects
(`{id, type: 1, application_id, guild_id, name, description, options?,
version}`).

Commands are listed for humans through the NATIVE route
(`GET /api/v1/workspaces/{workspace_id}/commands`, [REST](./rest.md)); bots
read the same stored rows back through the compat GET above — the
fetch→diff→overwrite flow libraries call safe sync, which used to raise on
the missing read. The GET reuses the write echo's serializer, so what a
library reads back is byte-identical to what its PUT returned.

**Command registration is GUILD(workspace)-scoped only, by decision** (KTD7:
guild → workspace). GLOBAL `/applications/{id}/commands` GET or PUT remain
absent, and there is no application-global command store behind them. The
consequence for stock clients is worth stating plainly, because it is a
product position rather than a gap: **global-scoped command sync stays
inert** — those policies target the global routes and get a 404, so `off`
remains the supported posture for them; the guild-scoped safe-sync flow
against the routes above is the supported one. Cytale has no
application-global command scope to map them onto, and inventing one would
misstate where commands live: a command registered here belongs to a
workspace, and a "global" twin would be a scope the product does not have.
Revisit only if bot commands are ever meant to be installable
application-wide.

Divergence ledger for the application-command object: Discord's optional
`default_member_permissions`, `nsfw`, `name_localizations`,
`description_localizations`, `contexts`, and `integration_types` have no
stored counterpart (the upsert keeps name/description/options only) and are
omitted from GET as from the write echo — `type` is always `1` (CHAT_INPUT;
a context-menu payload lacks `description` and 400s) and `version` is fixed
`"1"`. Absent-vs-falsy matches in libraries' diff logic, so default payloads
sync convergent; a library that PUTs non-default values for the unstored
fields will re-PUT on every sync (its values are dropped at validation, the
fetch shows falsy, the diff never zeroes).

## Interaction callback (U8)

`POST /api/v10/interactions/{interaction_id}/{token}/callback` mounts
OUTSIDE the Bot pipeline: the interaction token in the path IS the
credential (Discord libraries send no `Authorization` header on this
route). Body: `{type, data?}` — the typed surface (components plan U3):

| `type` | Name | Effect |
| --- | --- | --- |
| `4` | CHANNEL_MESSAGE_WITH_SOURCE | Posts the reply as the bot's message (`data.content` required, optional `data.components` — the fresh-card reply). `204`. |
| `5` | DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE | Consumes the ack, posts NOTHING now — a followup POST (continuation route) or `@original` PATCH later posts the deferred reply. `204`. |
| `6` | DEFERRED_MESSAGE_UPDATE | Consumes the ack, edits NOTHING now — the `@original` PATCH later completes the deferred update. `204`. |
| `7` | UPDATE_MESSAGE | Edits the CLICKED message: `data` carries any of `content` / `components` / `embeds` (at least one); wholesale component replace + `edited_at` + MessageUpdate fan-out. `204`. See [components](#interactive-components-buttons--select-menus). |

Any other typed body is `400 {code: 50035}`.

Tokens are minted at invocation (the native `POST /api/v1/interactions` —
a command invoke or a component click — delivered to the bot inside the
gateway `INTERACTION_CREATE` payload), live 15 minutes, and die with the
bot principal (revocation/regeneration purges them). Unknown, expired,
wrong, or revoked → `401 {code: 0}`, no message lands.

**Every typed response is the SINGLE-USE ACK (C-1, Discord parity):** the
first of type 4/5/6/7 atomically consumes it — one typed response per
token. A typed response arriving after consumption is Discord's
replayed-ack shape: `400 {"code": 10063, "message": "Unknown interaction"}`,
and nothing lands. **Followups ride the same token** (like Discord's
followups): a body with NO `type` key — `{content}` bare or
`{data: {content}}` — posts as the bot WITHOUT consuming the ack, any time
in the token's life; the webhook-shaped
[continuation routes](#interactive-components-buttons--select-menus) are
the second followup surface (the one discord.js `followUp`/`editReply`
target).

Each `{interaction_id, token}` pair carries its own callback bucket —
**10 posts per 15-minute token life** (the ack plus followups; far above
any legitimate library's one-response-plus-rare-followups usage). Past
the ceiling the callback answers the shared Discord 429 (`retry_after`,
`global: false`, the `X-RateLimit-*` set) instead of posting — a replayed
token cannot post unbounded.

Every message-creating leg (type 4, callback followups, webhook-route
followups) runs AS THE BOT through the principal-rights resolver — the
bot's own restrictions apply (a channel-restricted bot posting into an
out-of-profile channel is blocked with `403 {code: 50001}` and nothing
lands). Attribution is the bot principal; realtime consumers see it as an
ordinary `MessageCreate`. Message-creating legs additionally share the
**per-application interaction-post bucket (10 / 5s)** — see
[components](#interactive-components-buttons--select-menus).

## Interactive components (buttons & select menus)

Components plan (U1–U5): bots attach Discord action rows — buttons and
string-select menus, namespaced by an opaque `custom_id` — to their
messages; a human's click enters through the NATIVE interaction route
(`POST /api/v1/interactions`, the message-keyed body variant — see
[native REST](./rest.md#interactions-application-commands)) and reaches
the OWNING bot's compat session as `INTERACTION_CREATE` **type 3**
(MESSAGE_COMPONENT); the bot responds through the callback route
(`interaction.reply`/`update`/`deferUpdate`/`deferReply`) and the
continuation routes (`editReply`/`followUp`). The platform stores
components verbatim (the embeds posture), routes `custom_id` opaquely
(verified against the stored row at click — provenance, not
interpretation), persists indefinitely (bots disable/expire via UPDATE),
and kills stale buttons on revoked/deleted bots.

### Sends

`components` is accepted on the Bot-auth message create
(`POST /api/v10|/api/channels/{id}/messages`), on interaction type-4
responses and followups (`data.components`), and on type-7 updates —
stored verbatim and rendered on every read (absent when none). It is
**rejected** (`400 50035`) on webhook execute for INTERACTIVE components
(anything with a `custom_id`); style-5-only link rows are allowed. The
native human create ignores the key entirely — components ⇒ machine
author, by construction.

Validation caps (Discord's component reference, shallow — unknown keys
within a component ride verbatim; a violation is `400 50035`, native key
`invalid_components`):

- ≤ **5 action rows** per message; each row is `type: 1` wrapping
  1–5 child components.
- A row holds ≤ **5 buttons** (`type: 2`) OR exactly **1 string select**
  (`type: 3`) — never a mix.
- Button `style` 1–5 (premium style 6 rejected); styles 1–4 REQUIRE
  `custom_id` (1–100 chars) and FORBID `url`; style 5 (link) FORBIDS
  `custom_id` and REQUIRES `url` — an absolute `http`/`https` URL only
  (`javascript:`, `data:`, protocol-relative → `50035`).
- `label` ≤ 80 (buttons); `disabled` allowed on buttons and selects (the
  resolved-card state).
- String select: `custom_id` 1–100, ≤ 25 options (`label`/`value` ≤ 100,
  `description` ≤ 100, `placeholder` ≤ 150), and Discord's multi-select
  range: `min_values` 0–25 and `max_values` 1–25, each defaulting to
  1, with min ≤ max ≤ the option count. A click's `values` is a SET — the
  same option twice is `400`.
- Total serialized components ≤ **8 KB** per message.

Link buttons (style 5) render as client-side http/https anchors and
produce NO interaction.

### Click ingress → the type-3 payload

A human click on a live component (`POST /api/v1/interactions` with
`{channel_id, message_id, custom_id, component_type, values?}`) verifies
the `(component_type, custom_id)` pair — and for selects the `values` —
against the message's CURRENT stored row (forged/stale/disabled → 400,
never a mint), takes the owning bot as the message's author principal
(dead bot → the distinct 410 dead-button error), gates the clicker
(send right in the channel / DM participation; machine principals cannot
click), mints a 15-minute token, and fans `INTERACTION_CREATE` type 3 to
the bot's sessions EMIT-BEFORE-ACK. The payload is Discord-complete for
discord.js 14.27 — the three unconditional-dereference pins
(`entitlements`, `authorizing_integration_owners`, the full embedded
`message`) ride every dispatch, and the `compat:check` components leg
proves them by consumption:

```json
{
  "type": 3,
  "id": "100000000000000005",
  "application_id": "600000000000000001",
  "data": { "custom_id": "approve", "component_type": 2 },
  "guild_id": "400000000000000001",
  "channel_id": "200000000000000001",
  "member": { "user": { "id": "300000000000000001", "username": "clicker", "bot": false } },
  "message": {
    "id": "100000000000000004",
    "channel_id": "200000000000000001",
    "author": { "id": "600000000000000001", "username": "Deploy Bot", "bot": true },
    "content": "card",
    "components": [{ "type": 1, "components": [{ "type": 2, "style": 1, "label": "Approve", "custom_id": "approve" }] }]
  },
  "token": "qkcDEacTOAXdfzf6fxVCf1H9_4sqGwnlQbi4sl-G3cx",
  "version": 1,
  "entitlements": [],
  "authorizing_integration_owners": { "0": "400000000000000001" },
  "app_permissions": "65535",
  "attachment_size_limit": 26214400
}
```

- `data` carries `{custom_id, component_type}` plus `values` (the chosen
  stored option values) on string-select clicks; `component_type` is `2`
  (button) or `3` (string select) — nothing else is minted.
- `d.message` is REQUIRED (discord.js constructs a `Message` from it): the
  FULL attached message object, stored components included.
- `app_permissions` is the bot's effective permissions in **Discord's bit
  layout** (#173), translated from Cytale's by name
  (`CytaleWeb.Compat.Permissions`): MANAGE_CHANNELS → 1<<4, ADMINISTRATOR →
  1<<3, the nickname bits → 1<<26 / 1<<27, and so on. One Cytale bit can
  grant several Discord ones (SEND_MESSAGES also sets
  SEND_MESSAGES_IN_THREADS; START_CALL sets CONNECT and SPEAK). The native
  `InteractionCreate` keeps Cytale's own bits.
- **DM clicks** carry the user shape instead: `user` (not `member`), NO
  `guild_id`, and the user-install AIO key — `authorizing_integration_owners:
  {"1": "<clicker id>"}`. Delivery is application-addressed (no intent
  bit), on live dispatch and resume replay alike.

### Modals: callback 9 → MODAL_SUBMIT

A bot may answer a command or component interaction with **type 9**
(`MODAL`): `data` is `{custom_id (1–100), title (1–45), components}` where
`components` is 1–5 action rows, each holding **exactly one text input**
(`type: 4`: `custom_id` unique in the modal, `style` 1 short / 2 paragraph,
`label` 1–45, `min_length` 0–4000, `max_length` 1–4000 with min ≤ max,
`required` default true, `value` prefill within the bounds, `placeholder`
≤ 100). A violation is `400 50035`. The modal IS the interaction's initial
response — it consumes the single-use ack like 4/5/6/7 — and answering a
MODAL_SUBMIT with another modal is `400 50035` (Discord parity), refused
before the ack is spent.

The human's client opens the form; **cancel sends nothing**. A submission
reaches the bot as `INTERACTION_CREATE` **type 5** (`MODAL_SUBMIT`) with
`data: {custom_id, components}` — rows of `{type: 4, custom_id, value}` in
the modal's order (discord.js `interaction.fields.getTextInputValue(id)`) —
plus the same `member`/`user`, `entitlements`, AIO and `app_permissions`
shape as a click, and the originating `message` when the modal came from a
component. It carries a fresh interaction token: 4/5 always work, and 6/7
work when the modal came from a message (they target that message).

Server-side provenance, all before the submit is minted: the modal is
unexpired and was opened on an interaction the SUBMITTER invoked; the
answers match the stored inputs exactly (every input once, `required`,
lengths in graphemes, no line break in a short input); the bot is still
alive; and a modal submits **once**.

### Callbacks 5/6/7 + the continuation routes

The callback route's typed surface is the table
[above](#interaction-callback-u8). Type 7 (UPDATE_MESSAGE) is
defense-in-depth pinned: the target is sourced EXCLUSIVELY from the token
(body-supplied channel/message ids are ignored — retargeting is
impossible), the stored row's author must BE the token's application
(else `404 10008`), and the bot's CURRENT send right / DM participation
applies (a bot restricted out of the channel after posting gets `403
50001` — buttons die with rights). Concurrent type-7 updates are
last-write-wins (documented; the standard bot mitigation is disabling
rows in the first UPDATE).

The **webhook-shaped continuation routes** — what discord.js
`deferReply`/`deferUpdate` → `editReply`/`followUp` call — mount under
BOTH compat prefixes with no auth pipeline (the URL token is the
credential, resolved without an interaction id; the application id is
pinned against the token — a mismatch is the callback's `401`):

| Route | Method | Effect |
| --- | --- | --- |
| `/webhooks/{application_id}/{token}` | POST | Followup create as the bot in the token's channel: `{content, components?}` (content required). `200` with the full Discord message object. After a type 5 this POST **is** the deferred reply. Under the bare `/api` prefix this route sits IN FRONT of webhook execute and falls through to it for non-interaction pairs (webhook behavior byte-identical). |
| `/webhooks/{application_id}/{token}/messages/@original` | GET | The pinned original: the click's message for update flows (types 6/7), the first posted response for reply flows. `404 10008` before a reply flow has posted anything. |
| `/webhooks/{application_id}/{token}/messages/@original` | PATCH | Edit the pinned original: `{content?, components?, embeds?}` (at least one). Completes a deferred update (deferUpdate → editReply); after a type 5 it MATERIALIZES the deferred reply (deferReply → editReply — Cytale renders no "thinking" placeholder, a documented divergence). `200` + MessageUpdate fan-out. |
| `/webhooks/{application_id}/{token}/messages/@original` | DELETE | Delete the pinned original (author-pinned + current rights). `204`. |

**Rate limit (per-application interaction-post bucket):** every
message-creating callback leg (type-4 ack, callback followups, webhook
followups) AND the `@original` write legs (PATCH/DELETE — no ack
constraint, no pair bucket) share one **10 / 5s** bucket per application;
type-7 flips ride the click budget instead (single-use ack, 1:1 with
clicks). Past the ceiling the shared Discord 429 answers.

### The approval-pattern cookbook

The patterns `compat:check`'s components leg exercises, written for bot
authors (the OpenClaw exec-approval idiom made native):

- **Gate on the payload's identity, not the channel.** `d.member.user` /
  `d.user` is the invoker — who MAY click is bot-side policy (the platform
  only gates send right / DM participation). Log the raw payloads if you
  need a durable audit trail of who approved what.
- **Denials under no-ephemerality.** The ephemeral flag (`flags: 64`) is
  accepted-and-ignored v1 (documented divergence) — a denial reply is
  visible to everyone. Two workable shapes: the QUIET ack (respond type 6
  `deferUpdate` — consumes the ack, renders nothing — or a short type-4
  "not permitted" ack), or PUBLIC denial copy ("declined: X is not an
  approver") when the audit trail benefits from being visible.
- **Disable rows before long operations.** On click, immediately
  `deferUpdate()`, then `editReply` with the rows `disabled: true` while
  the work runs (the double-click guard — the web client disables
  in-flight controls, but the row itself is the durable guard), and
  resolve with the final disabled state. This is also the LWW mitigation:
  the first UPDATE disables, so a second click cannot race a second
  resolution.
- **Expiry is yours.** There is no platform TTL: expire cards by flipping
  the rows to `disabled` when your own deadline lapses — a components-only
  type 7, an `@original` PATCH, or a plain message `PATCH` (discord.py's
  `message.edit(view=disabled_view)` from a View's `on_timeout`).
- **Post cards where the clickers can send.** Clicks require the clicker's
  send right in the channel (Discord parity: interacting requires send).
  In read-only announcement channels the platform renders cards as
  view-only — post approval cards where the intended approvers hold send
  right, or handle the click in a channel the bot can be messaged in.

## Search (CYTALE EXTENSION, B-4)

**This is a Cytale extension — NOT a Discord-compatible surface.** Discord
has no stable REST search API to mimic, discord.js has no wrapper, and the
response contract below is Cytale's own:

| Route | Method | Response |
| --- | --- | --- |
| `/channels/{cid}/messages/search?q=&limit=&before=` | GET | `{"results": [message objects], "total": n}` |
| `/users/@me/channels/{dm_id}/messages/search?q=&limit=&before=` | GET | the same shape over a DM channel |

Semantics:

- `q` is a substring match, case-insensitive (empty `q` matches everything);
  the workspace legs run through the same Tantivy query the NATIVE
  workspace search serves, scope-filtered to the gated channel — a thread
  id scopes to that thread only (v1 keeps it to channel+thread scoping).
- DM messages are not Tantivy-indexed (the DM index segment is a documented
  seam) — the DM leg is a BOUNDED in-memory scan of the DM channel's
  partition (newest 500 messages).
- `total` counts ALL in-scope matches; `results` is the page after `before=`
  (exclusive snowflake cursor) and `limit=` (1–100, default 25), newest
  first, as full Discord message objects (`reactions` attached,
  viewer-aware).
- Gates: the channel gate (view) + `read_message_history`; an
  out-of-profile channel is the identical `404 10003`, a
  visible-but-unpermitted history bit is the real `403 50001`; the DM leg
  is recipient-gated (participation IS authorization). An EMPTY match set
  is `{"results": [], "total": 0}` — never a 404.

## Objects

### User object

```json
{
  "id": "89441170979028992",
  "username": "Deploy Bot",
  "discriminator": "0",
  "global_name": "Deploy Bot",
  "avatar": null,
  "bot": true
}
```

- `id` is a decimal string (Snowflake). Machine principals carry `bot: true`;
  humans (e.g. message authors on the compat surface) omit the key.
- `discriminator` is always `"0"` — Cytale has no discriminator system
  (Discord's post-migration shape). `global_name` is the account's display
  name (a machine principal's label), or the username when it has none (#168),
  on message authors, the guild roster and `GUILD_MEMBER_ADD`.
- Webhook-authored messages carry `webhook_id` on the MESSAGE object.

### Message object

```json
{
  "id": "89441171033554944",
  "channel_id": "89441170979028992",
  "author": { "...": "user object" },
  "content": "hello",
  "timestamp": "2026-09-04T19:27:16.912Z",
  "edited_timestamp": null,
  "tts": false,
  "mention_everyone": false,
  "mentions": [],
  "mention_roles": [],
  "attachments": [{ "id": "0", "filename": "cat.png", "content_type": "image/png", "size": 2048, "url": "/api/v1/attachments/abc" }],
  "embeds": [{ "title": "Deploy OK", "description": "prod is green", "fields": [{ "name": "commit", "value": "abc123" }] }],
  "pinned": false,
  "type": 0,
  "message_reference": { "message_id": "...", "channel_id": "..." },
  "referenced_message": { "...": "message object" }
}
```

- Replies: `type: 19`, `message_reference`, and a **depth-1**
  `referenced_message` snapshot (a deleted original keeps the reference and
  drops the snapshot). Non-replies omit both keys.
- **Attachment objects** are `{id, filename, content_type, size, url,
  proxy_url}` — plus integer `width`/`height` when the stored descriptor
  carries sniffed image dimensions (PNG/GIF/JPEG uploads, C-3; the keys are
  OMITTED otherwise): decimal-string ids (a stored descriptor's own id, else
  the array index synthesizes Discord's unstored shape), integer `size`, and
  the URL as it was stored — RELATIVE (`/api/v1/attachments/{hash}`) for
  the native two-step upload flow, ABSOLUTE for files uploaded through the
  multipart create/execute surfaces. `proxy_url` is required by client
  parsers (`discord.py`'s `Attachment.__init__` indexes it unguarded, so a
  message carrying a file used to end the connection) and carries the SAME
  value as `url`: Discord's is its CDN-proxied copy of the asset, and this
  deployment serves attachments directly from one origin, so there is no
  separate proxy to name.
- **Upload part types: the header wins when it is specific, the filename when
  it is generic** — the full rule and its consequences live under
  [File uploads](#file-uploads-multipart-filesn--payload_json). Recorded here
  as a divergence because Discord itself is filename-driven: a client that
  sends `application/octet-stream` for a `.png` (every discord.py upload)
  gets `image/png` stored, served and dimension-sniffed, while a
  script-bearing extension is refused however the part is labelled.
- `mentions`/`mention_roles` are always `[]` (no mention rendering v1);
  `embeds` renders the stored embed array verbatim (`[]` when the message
  stored none) — the embed objects round-trip exactly as posted, unknown
  keys included (see [Sends](#sends)). The native message JSON exposes the
  same array under an optional `embeds` key
  ([native contract](./rest.md#message-json-embeds-optional-key)).
- **Embed media `proxy_url` — Discord parity.** Discord serves every
  external embed image through its media proxy
  (`images-ext-*.discordapp.net`) and names that copy beside the source:
  `image.proxy_url`, `thumbnail.proxy_url`, `author.proxy_icon_url`,
  `footer.proxy_icon_url`. Cytale does the same with its own
  [media proxy](./rest.md#media-proxy): when a slot's source is an absolute
  `http(s)` URL on another host, the rendered embed carries the proxy key —
  a RELATIVE, signed `/api/v1/media/proxy?u=…&e=…&s=…` path (relative like
  native attachment URLs; resolve it against the base URL you call). The
  stored embed keeps the producer's URL untouched in `url`/`icon_url`; the
  proxy key is minted per render and expires like a signed attachment URL
  (24 h by default), so re-read a message rather than keeping its proxy URL.
  Divergences: our own attachment URLs and `attachment://` references get
  NO proxy key (Discord proxies those through its CDN too — ours are served
  from this origin already); a proxy key a bot SENDS is dropped, never
  echoed (Discord ignores it as well); `video.proxy_url` is never emitted
  (the proxy serves still images only). The proxy fetches `http`/`https` on
  ports 80/443/8080/8443, public addresses only, raster images only (PNG,
  JPEG, GIF, WebP, AVIF — never SVG), up to the configured size cap.
- **Reactions** (when any exist) render as Discord's `reactions` array —
  `[{count, me, emoji: {id: null, name}}]` — with `me` computed against
  the CALLING bot; the key is ABSENT for reaction-less messages (Discord's
  shape, never `[]`). `emoji.id` is always `null` (Unicode emoji only —
  see [Reactions](#reactions-unicode-emoji)); the native surface exposes
  the flatter `{"emoji", "count", "me"}` entries under its own optional
  `reactions` key ([native contract](./rest.md#message-json-reactions-optional-key)).
- Webhook-authored messages: `webhook_id` is the webhook PRINCIPAL id, the
  author object carries `bot: true`, and a stored per-message override (the
  execute-time `username`) renders on `author.username`/`author.global_name`
  while the ids stay the principal's
  ([webhook execution](#webhook-execution); the native surface exposes the
  raw override under the optional `author_override` key
  ([native contract](./rest.md#message-json-author_override-optional-key-webhooks-only))).
- History responses are a **bare JSON array** — the native
  `{"messages": [...]}` envelope is unwrapped on this surface only.

### Channel object

```json
{
  "id": "89441170979028992",
  "guild_id": "89441170000000000",
  "name": "general",
  "type": 0,
  "position": 0,
  "last_message_id": "89441171033554944"
}
```

`guild_id` is the **workspace id** (Cytale's guild model is the workspace);
`type` maps native text → `0` and native category → `4` (GUILD_CATEGORY).
`position` is the channel's stored ordering index (Cytale orders the sidebar
by it) and is **required by client parsers** — `TextChannel._update` and
`CategoryChannel._update` index it unguarded, so a channel without it ends
`Client.connect()` rather than showing up unordered.
Thread channels render as type `11` objects with `thread_metadata` (see the
[GUILD_CREATE threads inventory](#guild_create-threads-inventory-c-1) — the
same shape the GUILD_CREATE `threads` array carries). DM channels render as
`type: 1` objects with a `recipients` array (the OTHER participant) instead
of `guild_id`/`name` — see [Bot DMs](#bot-dms-b-1) — and carry no
`position`, matching Discord's DMChannel shape.

### Application object

`GET /applications/@me` and `GET /oauth2/applications/@me` (same action, two
spellings: discord.js uses the first, discord.py the second — it fetches it
from `Client.login()` before opening a socket, so a missing route is a 404 on
login).

```json
{
  "id": "89441170979028992",
  "name": "Wire Contract Bot",
  "description": "",
  "icon": null,
  "bot_public": true,
  "bot_require_code_grant": false,
  "owner": { "id": "89441170000000000", "username": "alice", "discriminator": "0", "global_name": "alice", "avatar": null },
  "verify_key": "0000000000000000000000000000000000000000000000000000000000000000",
  "flags": 0,
  "team": null,
  "tags": []
}
```

The eight required keys are exactly the ones `discord.appinfo.AppInfo.__init__`
reads with `data[...]` (it does not `.get`, so an absent key fails login like
the 404 did): `id`, `name`, `description`, `icon`, `bot_public`,
`bot_require_code_grant`, `owner`, `verify_key`. The application IS the
machine principal — `id` is the principal snowflake, `name` its label, and
`owner` the parent human as a full user object.

**Divergence:** `verify_key` is a fixed placeholder (64 zeros). It is
Discord's Ed25519 public key for interaction-request signatures, and Cytale
has neither a signing key nor an `X-Signature-Ed25519` header — there is
nothing to publish. A client that verifies interaction signatures would fail
against it; no Cytale interaction carries a signature to verify.

### Gateway bootstrap (`GET /gateway/bot`)

```json
{
  "url": "wss://host/gateway/websocket?v=10&encoding=json",
  "shards": 1,
  "session_start_limit": { "total": 1000, "remaining": 999, "reset_after": 14400000, "max_concurrency": 1 }
}
```

`url` is derived from the request host (websocket scheme: `wss` over https,
`ws` otherwise) — or from the `cytale, :external_base_url` origin when that
app env is set ([above](#external-base-url-c-5b)). The budget is
generous/static — the real session cap
(**8 concurrent live sessions per machine principal**, refused with gateway
close 4008) is enforced at Identify on the gateway, not here. The websocket
speaks the Cytale gateway protocol with the **compat session mode** engaged
for `cytbot_` credentials — Discord-shaped READY + GUILD_CREATE per
workspace, SCREAMING dispatch names, Discord payload shapes, and the intents
subset; see [gateway.md — Session
modes](./gateway.md#session-modes) for the full contract (incl. intents
table and close 4013).

## Error shape and the code map

Errors are bare Discord objects — `{"code": <int>, "message": <text>}` —
mapped from the native envelope per this table (binding):

| HTTP | Discord `code` | `message` | Native key it maps from |
| --- | --- | --- | --- |
| 401 | `0` | `401: Unauthorized` | `unauthorized` (any auth miss) |
| 403 | `50001` | `Missing Permissions` | `forbidden` (rights/action-mask/author misses) |
| 404 | `10003` | `Unknown Channel` | `channel_not_found` + every channel-gate miss (anti-enumeration) |
| 404 | `10008` | `Unknown Message` | `message_not_found` |
| 404 | `10015` | `Unknown Webhook` | every webhook-execute miss (anti-enumeration; U11) |
| 400 | `10063` | `Unknown interaction` | a replayed interaction ack — the single-use ack (one of types 4/5/6/7) was already consumed (C-1) |
| 400 | `50035` | `Invalid Form Body` | `validation_failed` |
| 429 | `0` | `Too many requests …` — names the limit that tripped (this webhook / this application / this interaction / this network) and the retry hint | `rate_limited` (+ `retry_after` float, `global: false`) |

## Rate limits (KTD9)

The full Discord header set rides EVERY response (including 4xx):

- `X-RateLimit-Limit`, `X-RateLimit-Remaining` — integers.
- `X-RateLimit-Reset` — epoch seconds of the window's end.
- `X-RateLimit-Reset-After` — seconds, ms-precision decimals (`"9.842"`).
- `X-RateLimit-Bucket` — a stable hash of the **route template + method**
  (major params — the channel id — are masked out; `/api` and `/api/v10`
  aliases share the bucket). Identical across different channel ids on the
  same route. Message sends carry one id per send limit instead (below).
- On 429: `Retry-After` (ceil seconds), `X-RateLimit-Scope: user`, and the
  body `{message, code: 0, retry_after: <float seconds>, global: false}`. The
  `message` is self-explaining: it names the limit that was hit, whether
  it is account-scoped or a shared per-IP one, and the retry hint. The trip is
  logged with its bucket, key and window (`rate limit tripped bucket=… key=…
  window_ms=…`), so an offending bucket is identifiable from the log alone.

Buckets are **coarse**: one per route template + method, keyed per principal
(`{:user, id}` — per-bot isolation). Each bucket's limit comes from the
route's **CLASS** (C-2) — Discord-ish per-route tightness without
replicating Discord's full per-route matrix:

| Class | Routes | Limit / window |
| --- | --- | --- |
| `message_write` | every reaction PUT/DELETE route (`…/reactions/…` own-reaction add/remove and the admin clears) | **10 / 5s** |
| `mutation` | every other non-GET: message PATCH/DELETE, typing, ack, thread starts + join/leave, DM opens, command registration | **25 / 10s** |
| `read` | every GET (history, channel/user reads, reactions list, search) | **50 / 10s** |

Class limits are config-overridable per class (`config :cytale, compat:
[route_class_limits: [...]]` — accessor
`Cytale.Config.compat_route_class_limits/0`); the pre-auth IP dam and the
per-webhook execute buckets below are NOT class-governed.

**Message sends ride the one send budget**, not a class: `POST
/channels/{id}/messages` (a channel or a thread id) shares its budget with
the native send routes — per sender, **10 sends / 5 s into one channel or
thread** and **20 sends / 5 s across all of them** (accessor
`Cytale.Config.send_budget/0`, override `config :cytale, send_budget:
[...]`). The counters are shared across surfaces: a bot's native and compat
sends into one channel draw on the same budget. The headers and the 429 are
this dialect's (`X-RateLimit-*` with `-Bucket`, Discord's 429 body, `global:
false`) and describe the bucket closer to exhaustion — or, on a 429, the one
that tripped. Twice Discord's documented ~5 / 5 s per channel, so a bot
tuned for Discord never meets it; see `docs/protocol/rest.md` for why the
numbers suit the web app too.

Which of the two limits answered is told the Discord way, by
**`X-RateLimit-Bucket`** — one fixed id per limit, the same on every send
response it describes (a 429 or not) and the same for every sender:

| Limit | `X-RateLimit-Bucket` |
| --- | --- |
| per sender, one channel or thread | `fb961ff2d1580df2295e6b00f2012d9b` |
| per sender, across all conversations | `0217709127d9897d1235835d65bcb6a3` |

As in Discord's own buckets the channel id is not part of the id — it is the
major parameter, and Discord clients key a queue by bucket + major parameter,
so the conversation limit is one queue per channel or thread there. Everything
else stays Discord-valid: on either 429, `X-RateLimit-Scope` is `user` (the
limit is this bot's own, as a channel's bucket is in Discord's model — never
`global` or `shared`), and the body is exactly `{message, code: 0,
retry_after, global: false}`. The native `scope` field (`rest.md`) is not
added here.

**Interaction routes carry their own buckets** (outside the class table —
they mount with no auth pipeline): the per-`{interaction_id, token}`
callback bucket (**10 / 15 min**, the token's life) and the
per-application interaction-post bucket (**10 / 5s**, shared by every
message-creating callback leg and the `@original` write legs — see
[components](#interactive-components-buttons--select-menus)).

**Pre-auth per-IP dam:** an additional IP-keyed fixed window (default
**30 requests / 10s per IP**) is consumed BEFORE authentication. Failed
auth is never rate-limited by the per-principal buckets (there is no
principal yet), and each attempt would otherwise cost a database token
read — the dam bounds credential-guessing floods ahead of both. The
ceiling is deliberately generous: authenticated traffic from a legitimate
single-IP deployment stays far under it, and the per-principal buckets
above remain the effective limit for valid principals.

This dam is deliberately PER IP and stays that way: it is the
brute-force protection for the unauthenticated surface, and tightening the
wrong dam trades a usability bug for a security one. IPv6 clients are keyed
by `/64` prefix (per-address keying is bypassed by rotating the low 64 bits);
its 429 names itself as a shared network limit, and the trip is logged with
the bucket, key and window.

## Divergences from Discord (binding notes)

- **`UserUpdate` never rides the compat wire:** native profile events
  (avatar/name changes) are dropped for Discord-dialect sessions. Discord's
  `USER_UPDATE` payload is CDN-avatar-hash shaped and cannot map onto
  Cytale's URL-based profiles (the codec renders `"avatar" => nil); bots
  observe profile changes on their next READY/handshake instead.
- **Epoch:** Cytale Snowflakes use a 2026-01-01 epoch (KD5), not Discord's
  2015 epoch. Nothing on the wire validates the epoch; ids stay decimal
  strings and monotonically increasing, so libraries treat them opaquely.
- **Attachment `width`/`height` are sniffed for PNG/GIF/JPEG only (C-3):**
  uploads parse the image header at store time (PNG IHDR, GIF logical
  screen descriptor, JPEG SOF walk — pure header matching, no transcode),
  so attachment objects carry integer `width`/`height` for those formats.
  Other image types (WebP) and unparseable/truncated bytes omit both
  fields — libraries treat them as absent without complaint.
- **`guild_id` is the workspace id.** No guild/voice model exists beyond the
  workspace mapping. **GUILD_CREATE is synthesized gateway-side** (one per
  workspace the session can read anything in, `channels` embedded, seq-
  numbered and resume-buffered like any dispatch — a guild with nothing
  visible gets only the READY stub id); see
  [gateway.md — Compat sessions](./gateway.md#compat-sessions-bot-dialect).
- **Session dialects (CamelCase-native vs SNAKE-compat):** the REST surface
  here is Discord-shaped (snake_case as Discord spells it). On the GATEWAY,
  the dialect is keyed on the credential, not chosen by the client — human
  `cytale_`/JWT sessions speak native CamelCase events with native payload
  fields (byte-identical to the pre-compat gateway); `cytbot_` sessions get
  SCREAMING_SNAKE dispatch names with Discord payload shapes
  ([gateway.md — Session modes](./gateway.md#session-modes)). The two never
  mix on one session.
- **Intents: a 9-bit subset, allow-silent, no privileged class.** Compat
  Identifies may carry `GUILDS`, `GUILD_MEMBERS`, `GUILD_PRESENCES`,
  `GUILD_MESSAGES`, `GUILD_MESSAGE_REACTIONS`, `GUILD_MESSAGE_TYPING`,
  `DIRECT_MESSAGES`, `DIRECT_MESSAGE_REACTIONS`, and
  `DIRECT_MESSAGE_TYPING`
  ([table](./gateway.md#intents-compat-sessions)). The member/presence and
  DM classes are LIVE (bots plan B-1/B-3): `GUILD_MEMBER_ADD` /
  `GUILD_MEMBER_REMOVE` ride `GUILD_MEMBERS` (`1 << 1`),
  `PRESENCE_UPDATE` rides `GUILD_PRESENCES` (`1 << 8`, mapped 1:1 from the
  native online/idle/dnd/offline; a session never receives its own
  presence), and DM-anchored message/reaction/typing events ride the
  `DIRECT_*` bits (`1 << 12/13/14`) with recipient-membership gating.
  Known-but-unsupported Discord intent bits connect
  and simply deliver nothing for them — there is no privileged-intent
  approval class, so nothing is ever refused for "disallowed intents"
  (close 4014 is never sent). Intent bits OUTSIDE Discord's defined mask
  close the connection with **4013** (terminal).
  `INTERACTION_CREATE` rides no intent bit (application-addressed). There
  is **no `GUILD_MEMBERS_CHUNK` / op 8** (no request-members machinery).
- **`MESSAGE_CONTENT` (`1<<15`) is accepted and NOT enforced — the
  PERMISSIVE direction, deliberately.** A session receives message `content`
  whether or not it requests the bit. Discord's gate is an organization-level
  privileged-intent approval that a self-hosted deployment has no analog for,
  the workspace membership + restrictions profile is the real privacy
  boundary here, and the REST surface delivers `content` to the same
  principal regardless of intents — gating the gateway alone would withhold
  nothing. A bot ported from Discord that *relied* on content being withheld
  gets MORE than it asked for; that is the divergence, and it is pinned by a
  test.
- **The `GUILD_CREATE` roster is REAL and BOUNDED, and its presences are the
  live set.** `members` carries the workspace's actual members —
  humans plus the machine principals their parents anchor (R4) — with
  usernames resolved, each with `roles: [guild_id]` (@everyone first, which
  is the value `member.roles` permission maths sums) and `flags: 0`. One
  `@everyone` role rides `roles`, whose `id` IS the guild id (Discord's
  identity rule for it — and Cytale's `@everyone` base is a real part of the
  permission model). `member_count` is that roster's size and `large: true`
  marks the **100-entry cap**, Discord's own "what you have is not all of it"
  signal. The connecting principal is ALWAYS present (appended when the cap
  happened to exclude it), because `guild.me` and `guild.default_role`
  resolve through UNGUARDED client lookups: absent, they raise AttributeError
  inside the caller's first permission check.
  `presences` carries one object per member with a live session
  (`{user: {id}, status, activities: [], client_status: {desktop: status}}`),
  statuses mapped through the same vocabulary as `PRESENCE_UPDATE`
  (`invisible` → `offline`); unlike the presence EVENT stream — which never
  carries your own presence — this snapshot includes the connecting session.
  Still absent, deliberately: **member enumeration beyond the cap** (no op 8
  and no compat member REST route, so join/leave events stay advisory-only
  and the roster cannot be paged past 100), **Cytale roles and their
  permission BITS** (never projected into Discord's permission integer:
  `roles`/`member.roles` permission maths reads the @everyone stub alone and
  must not be trusted for authorization), and `voice_states`.
- **Client-initiated Resume is Discord's op 6, and it is ACCEPTED.**
  Discord clients recover from a dropped socket by reconnecting and sending
  `op 6` with `{token, session_id, seq}` — the same number this server's
  native dialect spends on the server→client Reconnect, which is why a stock
  client's resume used to be rejected as a protocol violation (close 4002).
  4002 is classified as *resumable* by Discord clients, so a correct client
  retried Resume forever and never reached the Identify fallback that works:
  every deploy or blip permanently deafened every bot, while the server still
  counted it online. Compat sessions now accept op 6 as Resume (the `cytbot_`
  credential decides the dialect; a native session sending op 6 is still a
  violation), and a REFUSED resume answers **Invalid Session (`d: false`)
  then close 4000** — never 4002/4004 — so clients re-Identify immediately.
  See [gateway.md — op 6 Resume (compat)](./gateway.md#op-6-resume-compat).
- **Per-principal session cap 8, close 4008:** at most 8 concurrent live
  compat sessions per machine principal; a 9th Identify is refused with
  gateway close **4008**. Native (human) sessions are exempt — unrestricted
  multi-device.
- **Close-code registry (compat additions):** beyond Discord's standard set
  the server uses **4004** (authentication failed — also the revocation /
  regenerate teardown for live bot sockets), **4008** (identify/resume rate
  limits AND the session cap above), and **4013** (invalid intents,
  terminal). Full table:
  [gateway.md — Close codes](./gateway.md#close-codes).
- **Transport compression:** `?compress=zlib-stream` on the gateway URL
  opts every SERVER→CLIENT frame into one shared **zlib stream** (window
  bits 15 — a zlib header, sync-flush-terminated members), which is Discord's
  transport compression and what conformant libraries inflate it with. CLIENT
  frames do not ride it: they stay plain JSON text frames, exactly as on an
  uncompressed connection (no Discord library compresses outbound), and a
  binary client frame is accepted as a compressed member. The per-payload
  `zstd_stream`/`zlib_stream` negotiation remains available to native
  sessions and stays RAW DEFLATE; the two never combine
  ([gateway.md — Compression](./gateway.md#compression)).
- **Compat responses are framed exactly `application/json`** — no `charset`
  parameter, on both prefixes and on error bodies alike. This is not a
  divergence but a CONVERGENCE worth pinning: discord.py decides whether to
  parse a body as JSON by exact string comparison
  (`discord/http.py`: `response.headers['content-type'] == 'application/json'`),
  so Phoenix's default `; charset=utf-8` made every compat body arrive as
  untranslatable text (`TypeError: string indices must be integers` at
  login). The native surface keeps Phoenix's default.
- **Unsupported surface:** routes outside the subset above are not mounted.
  Unmatched non-GET paths get the server's default 404 JSON; unmatched GETs
  under the compat prefixes fall through to the SPA fallback (HTML), so
  library code should treat any non-JSON response as "route not offered".
- **Reactions are Unicode-emoji only.** There is no custom-emoji system —
  the Discord emoji object's `id` is always `null` and `:name:` reaction
  syntax is a `50035` (see [Reactions](#reactions-unicode-emoji)). Thread
  READS ride the compat surface (the GUILD_CREATE `threads` inventory and
  thread history through the standard messages route), thread STARTS and
  thread-membership JOIN/LEAVE ride it too (bots plan B-2,
  [above](#thread-writes-b-2)); thread REPLY writes stay native-only and
  `auto_archive_duration` is ignored. Threads otherwise ride the gateway
  translation (THREAD_* dispatches, TYPING_START).
- **`content` cap is 4000 bytes** (native cap), not Discord's 2000.
- **Embed caps are `10 × 8 KB`** (Cytale's pinned validation), not Discord's
  10-embed/6000-character-total matrix; embeds are stored verbatim rather
  than normalized to Discord's field set.
- **`components` are stored, not stripped** (components plan U1/R1 — the
  old R11 strip divergence is GONE): action rows persist verbatim beside
  embeds and ride every read. The remaining component divergences, each
  owned by its plan requirement:
  - **Ephemerality is ignored (R6):** `flags: 64` on a type-4/followup
    response is accepted-and-ignored — every response is a normal visible
    message (see the denial cookbook above); visibility-scoped messages
    are deferred schema surface.
  - **Components-v2 containers (flag 32768) are deferred** — classic
    action rows are the surface (Discord explicitly does not deprecate
    them). Modals and multi-select are supported.
  - **Webhook-authored INTERACTIVE components are rejected (R6/R1):** a
    webhook has no gateway session to receive clicks (`400 50035`);
    style-5-only link rows are allowed.
  - **No `interaction_metadata` backfill (scope boundary):** messages
    created by interaction responses carry no `message.interaction`
    metadata — discord.js optional-chains it.
- **`?around=` is ignored** on history (`limit`, `before` and
  `after` map to native pagination).
- **Webhook `/slack` accepts a JSON body `{"text": ...}`** — Slack's own
  form-encoded `payload=<json>` envelope is not parsed (the endpoint's
  parser set is JSON-only). Everything else is Discord's slack-compat
  shape: `text` → content, optional `username` → override, wait default
  true.
- **Webhook `/github` renders its own card shapes** (content line + one
  embed per event for push/pull_request/issues; a generic one-liner
  otherwise) — not byte-compatible with Discord's GitHub webhooks, which
  format their own payloads upstream of the hook.
- **Webhook execute is unversioned-only:** the execute routes mount at
  `/api/webhooks/...` (the URL form the native create returns), NOT under
  `/api/v10/webhooks/...`. Libraries that build versioned webhook-execution
  URLs from their REST base (e.g. discord.js `WebhookClient` with a
  `/api`-rooted base) must instead POST the capability URL directly —
  integrators consume the URL the platform gave them, which is always
  correct.
- **Interaction acks are single-use with NO 3-second window** (KTD13 +
  C-1): the first typed response (4/5/6/7) consumes the ack — a replay is
  `400 10063 Unknown interaction`, exactly Discord's replayed-ack shape.
  Divergences that remain: Cytale never imposes Discord's 3-second ack
  deadline (the ack is consumable any time in the 15-minute token life),
  and followups ride BOTH the SAME callback route with a `type`-less body
  AND the webhook-shaped continuation routes (components plan U3 — the
  Discord-parity surface discord.js targets), bounded by the per-pair
  10-posts/15-min bucket plus the per-application 10/5s interaction-post
  bucket.
- **Interaction callbacks return bare `204`** — no `?with_response=true`
  body v1; libraries read the posted message back from history/channel
  events or the continuation routes. The ephemeral flag is
  accepted-and-ignored (documented divergence, above); type-4 responses
  and followups accept `data.components` — stored and rendered, never
  stripped (the fresh-card reply).
- **Gateway `INTERACTION_CREATE` is application-addressed**: delivered to
  the bot's own sessions regardless of the intents ⊗ visible-set dispatch
  filter (Discord has no interaction intent; the payload carries
  `member.user` for the invoker and `data.options` as `{name, value}`
  entries). Callback gating — not delivery — is where the bot's
  restrictions bite.
- **Ed25519 HTTP interactions are not built** (KTD13): no
  `/interactions` HTTP-mode endpoint; interactions arrive over the gateway
  only.
