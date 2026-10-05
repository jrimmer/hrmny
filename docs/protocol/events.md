# Gateway Events

Dispatch frames (`op: 0`) carry an event name in `t` and its payload in `d`.
Every frame also carries `s` — the per-session monotonic sequence number used
for [resume](./gateway.md#op-5-resume).

The [READY](#ready) and [RESUMED](#resumed) lifecycle dispatches always carry
`s: 0` and do not advance the sequence.

Snowflake fields are decimal strings. Timestamps are ISO 8601 UTC unless noted.

## Message events

### MessageCreate

A new message was persisted in a channel (or thread).

```json
{
  "op": 0,
  "t": "MessageCreate",
  "s": 42,
  "d": {
    "id": "100000000000000001",
    "channel_id": "200000000000000001",
    "thread_id": null,
    "author_id": "300000000000000001",
    "content": "hello world",
    "created_at": "2026-08-27T18:00:00.000Z",
    "edited_at": null
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `id` | Snowflake | Message id. Sorts chronologically — newest message = highest id. |
| `channel_id` | Snowflake | Parent channel. |
| `thread_id` | Snowflake \| null | Set when the message lives inside a thread; `null` for channel messages. Thread replies also emit [ThreadMessageCreate](#threadmessagecreate). |
| `author_id` | Snowflake | Author's user id. |
| `content` | string | Message body. |
| `created_at` | ISO 8601 | Creation time. |
| `edited_at` | ISO 8601 \| null | Last edit time; `null` if never edited. |
| `components` | [MessageActionRow](#messageactionrow)[] | Optional (components plan U1): the stored action rows, present ONLY when the message carries any (bot-authored component sends and interaction responses — the native human create ignores the key, so components ⇒ machine author by construction). Absent when none; never `[]` on this event. |
| `content_proxy_urls` | object | Optional: the Markdown images in `content` (`![alt](url)`), as `{ "<source url>": "<proxy url>" }` — each external source (exactly as the parse's image node carries it) mapped to a signed, same-origin `/api/v1/media/proxy?…` URL the server minted for this render (see [REST: media proxy](./rest.md#media-proxy)). Present only when the body has at least one external image. An image with no entry renders as a plain link. |
| `nonce` | string | Optional: the send's client key — the body `nonce` or `Idempotency-Key` the author's POST carried (Discord's MESSAGE_CREATE `nonce`). Present only on the create's own dispatch and its 201 (one map), and only when the send carried a key; never stored, so history reads and edits omit it. Delivered to every recipient: it is a random per-message token scoped to its author (the send dedupe and the Idempotency-Key replay are keyed on author + key), so it grants another member nothing. The author's client settles its pending row by it exactly; content matching is only the fallback for servers that predate the field. |

### MessageUpdate

A message was edited.

```json
{
  "op": 0,
  "t": "MessageUpdate",
  "s": 43,
  "d": {
    "id": "100000000000000001",
    "channel_id": "200000000000000001",
    "thread_id": null,
    "content": "hello world (edited)",
    "edited_at": "2026-08-27T18:05:00.000Z",
    "components": [
      {
        "type": 1,
        "components": [
          { "type": 2, "style": 1, "label": "Approve", "custom_id": "approve", "disabled": true }
        ]
      }
    ]
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `id` | Snowflake | Message id. |
| `channel_id` | Snowflake | Parent channel. |
| `thread_id` | Snowflake \| null | Set when the message lives inside a thread. |
| `content` | string | Full new content (not a diff). |
| `edited_at` | ISO 8601 \| null | Edit timestamp. |
| `components` | [MessageActionRow](#messageactionrow)[] | Optional (components plan U3): the message's CURRENT action rows, whenever it has any — the approval-card flip (an interaction type-7 update fans this to every live viewer). Absent when the message has none; a replace-to-empty carries `[]`. Updates without the key (plain content edits) leave stored rows untouched. |
| `embeds` | object[] | Optional: the message's CURRENT embeds. A card flip (interaction type 7 / `@original` PATCH) always carries both `components` and `embeds` — `[]` when cleared — so a flip that removes the buttons or swaps the embed reaches every live viewer. Absent on a plain content edit of a message without embeds: absent means unchanged. |
| `content_proxy_urls` | object | Optional: as on [MessageCreate](#messagecreate), for the CURRENT content — an edit re-renders it, and absence means the edited body has no external Markdown image. |

### MessageActionRow

A stored top-level component row (components plan, R1 — shared by
`MessageCreate` and `MessageUpdate`): the platform validates a shallow
shape (`type: 1` action row wrapping a `components` array of buttons /
string selects) and routes the JSON verbatim; `custom_id` is the bot's
namespace, never interpreted. Unknown keys ride untouched (the embeds
store-and-forward posture). Validation caps: ≤5 rows per message, ≤5
buttons or exactly 1 select per row, `custom_id` 1–100 chars, `label`
≤80 (buttons) / ≤100 (select options), string select ≤25 options with
`min_values`/`max_values` capped at 1 (v1 divergence — no multi-select),
style-5 link buttons require an absolute http/https `url` and forbid
`custom_id`, premium style 6 rejected, total serialized ≤8 KB.

### MessageDelete

A message was deleted. Deletion is terminal — only identity fields ride the wire.

```json
{
  "op": 0,
  "t": "MessageDelete",
  "s": 44,
  "d": {
    "id": "100000000000000001",
    "channel_id": "200000000000000001",
    "thread_id": null
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `id` | Snowflake | Deleted message id. |
| `channel_id` | Snowflake | Parent channel. |
| `thread_id` | Snowflake \| null | Set when the message lived inside a thread. |

### MessageAck

Read-state fan-out — the user acknowledged messages in a channel (via
[op 21](./gateway.md#op-21-message-ack) or the REST fallback), mirrored to the
user's other connected clients so multi-device read state converges.

```json
{
  "op": 0,
  "t": "MessageAck",
  "s": 45,
  "d": {
    "channel_id": "200000000000000001",
    "message_ids": ["100000000000000001"],
    "user_id": "300000000000000001",
    "acknowledged_at": "2026-08-27T18:06:00.000Z"
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `channel_id` | Snowflake | Channel that was read. |
| `message_ids` | Snowflake[] | Acknowledged message ids. |
| `user_id` | Snowflake | User who read them. |
| `acknowledged_at` | ISO 8601 | When the acknowledgement was recorded. |

## Reaction events

Unicode-emoji reactions (Discord-shaped). `emoji` is the raw Unicode emoji
text (e.g. `"👍"`) — Cytale has no custom-emoji system, so the Discord
compat wire always renders `emoji.id` as `null`. Events fire on
state-CHANGING operations only: an idempotent re-add (the row already
exists) or a no-op remove emits NOTHING.

### MessageReactionAdd

A principal reacted to a message.

```json
{
  "op": 0,
  "t": "MessageReactionAdd",
  "s": 45,
  "d": {
    "channel_id": "200000000000000001",
    "message_id": "100000000000000001",
    "user_id": "300000000000000001",
    "emoji": "👍"
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `channel_id` | Snowflake | Channel holding the message. |
| `message_id` | Snowflake | Reacted message. |
| `user_id` | Snowflake | Reacting principal. |
| `emoji` | string | Raw Unicode emoji text (no custom emoji). |

### MessageReactionRemove

A principal's reaction was removed — own remove (DELETE `…/reactions/{emoji}/@me`)
or a `manage_messages` removal by another actor (per-user clear or one entry
of an emoji sweep).

```json
{
  "op": 0,
  "t": "MessageReactionRemove",
  "s": 46,
  "d": {
    "channel_id": "200000000000000001",
    "message_id": "100000000000000001",
    "user_id": "300000000000000001",
    "emoji": "👍"
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `channel_id` | Snowflake | Channel holding the message. |
| `message_id` | Snowflake | Message the reaction left. |
| `user_id` | Snowflake | Principal whose reaction was removed. |
| `emoji` | string | Raw Unicode emoji text (no custom emoji). |

### MessageReactionRemoveAll

Every reaction left a message (`manage_messages` clear-all). Identity
fields only — per-emoji/per-user removals emit
[MessageReactionRemove](#messagereactionremove) instead (Discord's split).

```json
{
  "op": 0,
  "t": "MessageReactionRemoveAll",
  "s": 47,
  "d": {
    "channel_id": "200000000000000001",
    "message_id": "100000000000000001"
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `channel_id` | Snowflake | Channel holding the message. |
| `message_id` | Snowflake | Message whose reactions were cleared. |

## Channel events

### ChannelCreate

```json
{
  "op": 0,
  "t": "ChannelCreate",
  "s": 46,
  "d": {
    "id": "200000000000000002",
    "workspace_id": "400000000000000001",
    "name": "general",
    "position": 1,
    "created_at": "2026-08-27T18:00:00.000Z"
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `id` | Snowflake | Channel id. |
| `workspace_id` | Snowflake | Owning workspace. |
| `name` | string | Channel name. |
| `position` | number | Sort position within the sidebar. |
| `created_at` | ISO 8601 | Creation time. |

### ChannelUpdate

Partial update — absent keys are unchanged; explicit `null` clears a field
(where the field allows clearing).

```json
{
  "op": 0,
  "t": "ChannelUpdate",
  "s": 47,
  "d": { "id": "200000000000000002", "name": "general-2" }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `id` | Snowflake | Channel id. |
| `name?` | string | New name, if changed. |
| `topic?` | string \| null | New topic, if changed. |
| `position?` | number | New sort position, if changed. |
### UserUpdate

Profile change for a user (display name / avatar). Fanned out to every
workspace and DM the user participates in. `display_name` and `avatar_url`
are `null` when cleared; `username` is immutable and always present.

People and machine principals publish the SAME shape: `username` is always
the account's handle (its @tag) and `display_name` the name it shows. A bot or
agent rename changes its label, which rides `display_name` — never
`username` (a webhook, which has no handle, carries its label in both, as the
people roster does). A client stores `display_name` on the user's roster rows,
its own record and DM recipients (#168), and for a machine also where its row
keeps the label (the row's `nickname`); a person's `nickname` is per-workspace
and untouched. A key the event does not carry leaves the client's value as it
was.

**Which name to show** (#168, Discord's rule): the workspace `nickname`, else
the account's `display_name`, else the `username`. Every client resolves it
the same way (`displayNameOf` in `@cytale/domain`); the `username` remains the
@handle.

```json
{
  "op": 0,
  "t": "UserUpdate",
  "s": 61,
  "d": {
    "id": "9007199254740993",
    "username": "alice",
    "display_name": "Alice",
    "avatar_url": null
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `id` | Snowflake | The updated user's id. |
| `username` | string | Immutable username — the handle, for people and machines alike. |
| `display_name` | string \| null | Current display name (null = unset); a machine principal's label. |
| `avatar_url` | string \| null | Avatar URL, when set. |

### ChannelDelete

```json
{
  "op": 0,
  "t": "ChannelDelete",
  "s": 48,
  "d": { "id": "200000000000000002" }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `id` | Snowflake | Deleted channel id. |
| `workspace_id?` | Snowflake | Owning workspace, when included. |

## Thread events

Threads are Discord-style sub-channels attached to a parent channel. Thread
replies emit **both** a channel [MessageCreate](#messagecreate) (with
`thread_id` set) and a thread-scoped [ThreadMessageCreate](#threadmessagecreate)
— clients should not filter all channel messages to follow a thread.

### ThreadCreate

```json
{
  "op": 0,
  "t": "ThreadCreate",
  "s": 49,
  "d": {
    "id": "500000000000000001",
    "channel_id": "200000000000000001",
    "parent_message_id": "600000000000000001",
    "name": "deploy discussion",
    "created_by": "300000000000000001",
    "created_at": "2026-08-27T18:10:00.000Z"
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `id` | Snowflake | Thread id. |
| `channel_id` | Snowflake | Parent channel. |
| `parent_message_id` | Snowflake \| null | The seed message the thread hangs off; `null` for a standalone thread. The same value the roster read (`GET /channels/{id}/threads`) carries, so a client that did not create the thread — a bot, a webhook, another member, another device — can draw the seed's reply indicator live. Servers before 2026-10-02 omit the key: a client treats an absent key as "not stated" and keeps any anchor it already holds. |
| `name` | string | Thread name. |
| `created_by` | Snowflake | Creator's user id. |
| `created_at` | ISO 8601 | Creation time. |

### ThreadUpdate

Partial update — absent keys unchanged. Emitted by the archive write
(`PATCH /threads/:id`, and `PATCH /channels/{thread_id}` on the compat surface).

```json
{
  "op": 0,
  "t": "ThreadUpdate",
  "s": 50,
  "d": { "id": "500000000000000001", "channel_id": "400000000000000002", "parent_message_id": "600000000000000001", "archived": true }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `id` | Snowflake | Thread id. |
| `channel_id` | Snowflake | Parent channel. **Routing-bearing**: the server's fan-out addresses a publish by the channel the payload names, so a payload without one reaches no session. |
| `parent_message_id` | Snowflake \| null | The thread's seed message, restated (it never changes) so a client that missed the create still places the indicator. Same absent-key rule as [ThreadCreate](#threadcreate). |
| `name?` | string | New name, if changed. |
| `archived?` | boolean | Archive state, if changed. |

### ThreadDelete

```json
{
  "op": 0,
  "t": "ThreadDelete",
  "s": 51,
  "d": { "id": "500000000000000001" }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `id` | Snowflake | Deleted thread id. |
| `channel_id?` | Snowflake | Parent channel, when included. |

### ThreadMemberAdd

```json
{
  "op": 0,
  "t": "ThreadMemberAdd",
  "s": 52,
  "d": { "thread_id": "500000000000000001", "user_id": "300000000000000001" }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `thread_id` | Snowflake | Thread joined. |
| `user_id` | Snowflake | Member added. |

### ThreadMemberRemove

```json
{
  "op": 0,
  "t": "ThreadMemberRemove",
  "s": 53,
  "d": { "thread_id": "500000000000000001", "user_id": "300000000000000001" }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `thread_id` | Snowflake | Thread left. |
| `user_id` | Snowflake | Member removed. |

### ThreadListSync

Bulk sync of a workspace's thread list — e.g. after reconnect fallback.

```json
{
  "op": 0,
  "t": "ThreadListSync",
  "s": 54,
  "d": {
    "workspace_id": "400000000000000001",
    "threads": [
      {
        "id": "500000000000000001",
        "channel_id": "200000000000000001",
        "parent_message_id": "600000000000000001",
        "name": "deploy discussion",
        "created_by": "300000000000000001",
        "created_at": "2026-08-27T18:10:00.000Z"
      }
    ]
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `workspace_id` | Snowflake | Workspace whose threads are synced. |
| `threads` | ThreadCreate payload[] | The thread list (same shape as [ThreadCreate](#threadcreate) payloads). |

### ThreadMessageCreate

A reply inside a thread. Emitted alongside the channel-level
[MessageCreate](#messagecreate) so thread-scoped subscribers can follow
without filtering every channel message.

```json
{
  "op": 0,
  "t": "ThreadMessageCreate",
  "s": 55,
  "d": {
    "id": "100000000000000002",
    "thread_id": "500000000000000001",
    "author_id": "300000000000000002",
    "content": "a reply",
    "created_at": "2026-08-27T18:11:00.000Z",
    "edited_at": null
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `id` | Snowflake | Message id. |
| `thread_id` | Snowflake | Containing thread. |
| `author_id` | Snowflake | Author's user id. |
| `content` | string | Message body. |
| `created_at` | ISO 8601 | Creation time. |
| `edited_at` | ISO 8601 \| null | Last edit time. |
| `channel_id` | Snowflake | Parent channel (the fan-out route). |
| `attachments` | object[] | The reply's attachments, as on MessageCreate. |
| `embeds` | object[] | Optional: present only when the reply stored embeds (a bot's card posted into a thread) — the same array MessageCreate carries (external media carries its `proxy_url`). |
| `content_proxy_urls` | object | Optional: the reply's Markdown image proxy map, as on [MessageCreate](#messagecreate). |
| `components` | [MessageActionRow](#messageactionrow)[] | Optional: the reply's action rows, present only when it stored any — a bot's card in a thread is the channel card, field for field. |
| `nonce` | string | Optional: the send's client key, exactly as on [MessageCreate](#messagecreate) — both legs of a thread reply's dual emission carry it. |

## Presence and typing

### PresenceUpdate

A user's presence changed.

```json
{
  "op": 0,
  "t": "PresenceUpdate",
  "s": 56,
  "d": {
    "user_id": "300000000000000001",
    "status": "online",
    "last_seen_at": "2026-08-27T18:12:00.000Z",
    "workspace_id": "200000000000000001"
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `user_id` | Snowflake | User whose presence changed. |
| `status` | `"online"` \| `"idle"` \| `"dnd"` \| `"offline"` | Presence status. |
| `last_seen_at` | ISO 8601 | When the user was last seen. |
| `workspace_id` | Snowflake (optional) | Owning workspace of THIS copy — the announce fans one event per membership (bots plan B-3, additive; native clients may ignore it). |

### TypingStart

A user started typing (server fan-out of client
[op 20](./gateway.md#op-20-typing-start-client), throttled to ~1 per second
per user per channel before emission). The sender is never echoed their own
signal.

```json
{
  "op": 0,
  "t": "TypingStart",
  "s": 57,
  "d": {
    "channel_id": "200000000000000001",
    "thread_id": null,
    "user_id": "300000000000000002",
    "timestamp": 1792022400000
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `channel_id` | Snowflake | Channel where typing started. |
| `thread_id` | Snowflake \| null | Set when the typing applies to a thread. |
| `user_id` | Snowflake | User who is typing. |
| `timestamp` | number | Unix epoch **milliseconds** when the signal was registered. |

## Voice-call events

Unified voice calls (calls plan U1): call control and media signaling ride
the main gateway as ordinary seq-numbered dispatches — there is no dedicated
voice websocket. Delivery scoping per event is documented with each payload;
as a class:

- **Channel-keyed events** (CallStart, CallUpdate, CallEnd) fan out on the
  channel key under the visibility filter — every recipient's live
  `VIEW_CHANNEL` is re-checked at fan-out from day one (KTD6/AM9: call
  existence and rosters are presence-like data for hidden channels; a
  subscribed-but-blind session receives nothing). Message-event visibility
  parity for hidden channels is a separately-tracked pre-existing issue —
  CALL_* filtering does not wait for it. **DM calls** fan the same events
  to both participants' user keys.
- **User-keyed events** (CallSync, CallRing, CallSignal) are
  point-to-point to one recipient's sessions (roster backfill, ring
  notification, signaling relay respectively).
- **Resume replay** applies mechanically to all six (they are sequenced,
  buffered dispatches like any other). Replayed CallStart/CallUpdate/CallEnd
  apply normally; a replayed CallSync is superseded by any fresher one
  (clients treat the most recent as authoritative); replayed CallSignal
  bodies are stale signaling and should be discarded (see the event).
- **Compat (bot) sessions never receive `CALL_*` events** — the compat wire
  stays voice-free (Discord's `GUILD_VOICE_STATES` intent connects but
  delivers nothing; documented divergence). Bots observe calls only via
  [REST](./rest.md).

### CallStart

A call started in a channel (or DM channel).

```json
{
  "op": 0,
  "t": "CallStart",
  "s": 66,
  "d": {
    "channel_id": "200000000000000001",
    "call_id": "700000000000000001",
    "thread_id": "500000000000000009",
    "started_by": "300000000000000001",
    "started_at": "2026-09-06T12:00:00.000Z"
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `channel_id` | Snowflake | Channel the call lives in. |
| `call_id` | Snowflake | Call id (one live call per channel — one-live policy). |
| `thread_id` | Snowflake \| null | The channel's standing **call-log thread** (created on first call, reused for every later call). `null` on DM calls — DM rooms keep no log artifact. |
| `started_by` | Snowflake | User who started the call. |
| `started_at` | ISO 8601 | Start time. |

Delivery: channel key + visibility filter (user keys on DM calls).
Resume-replayable.

### CallUpdate

One voice-leg transition inside a live call — roster changes and per-leg
voice-state changes.

```json
{
  "op": 0,
  "t": "CallUpdate",
  "s": 67,
  "d": {
    "channel_id": "200000000000000001",
    "call_id": "700000000000000001",
    "user_id": "300000000000000002",
    "leg": "sVbXv2xKqP9mQwRt",
    "state": "muted"
  }
}
```

Calls-V2 source states carry the affected source (a `screen_off` from the
browser's own stop-share bar):

```json
{
  "op": 0,
  "t": "CallUpdate",
  "s": 72,
  "d": {
    "channel_id": "200000000000000001",
    "call_id": "700000000000000001",
    "user_id": "300000000000000002",
    "leg": "sVbXv2xKqP9mQwRt",
    "state": "screen_off",
    "source": "screen"
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `channel_id` | Snowflake | Channel the call lives in. |
| `call_id` | Snowflake | Call id. |
| `user_id` | Snowflake | User whose leg changed. |
| `leg` | string | Opaque **session-leg discriminator** of the affected leg. One voice state per user per call: each device attributes `joined` / `displaced` / `forced_leave` against its own leg. |
| `state` | string | `joined` \| `left` \| `muted` \| `unmuted` \| `deafened` \| `undeafened` \| `displaced` \| `forced_leave` — plus the calls-V2 additive source states `camera_on` \| `camera_off` \| `screen_on` \| `screen_off` \| `screen_audio_on` \| `screen_audio_off`. `displaced` = a second device joined for that user; `forced_leave` = the server removed the leg (e.g. a visibility change revoked VIEW_CHANNEL mid-call). |
| `source?` | string | Calls V2, source states only: the affected published source (`camera` \| `screen` \| `screen_audio`). Absent on every V1 state. Emitted on publish, on unpublish (user toggle, the browser's own stop-share bar, closed shared window, OS permission revoked mid-stream, server-side track-end evidence, and mid-call permission revocation — every track-ending path flows into the same unpublish), so the roster never claims a dead track. |

Delivery: channel key + visibility filter (user keys on DM calls).
Resume-replayable.

### CallEnd

A call ended terminally. Deletion-style: identity fields plus the reason.

```json
{
  "op": 0,
  "t": "CallEnd",
  "s": 68,
  "d": {
    "channel_id": "200000000000000001",
    "call_id": "700000000000000001",
    "reason": "last_left",
    "ended_at": "2026-09-06T12:31:00.000Z"
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `channel_id` | Snowflake | Channel the call lived in. |
| `call_id` | Snowflake | Call id. |
| `reason` | string | `last_left` — ordinary empty-sweep expiry after natural emptiness (the last participant left and nobody rejoined within the window); `swept` — crash-recovery adoption or the boot sweep ended it. |
| `ended_at` | ISO 8601 | End time. |

Delivery: channel key + visibility filter (user keys on DM calls).
Resume-replayable.

### CallSync

Per-recipient roster backfill — the durable answer to "which calls are live
right now". Emitted to a session at establishment (Identify) and after
Resume routing.

```json
{
  "op": 0,
  "t": "CallSync",
  "s": 69,
  "d": {
    "calls": [
      {
        "channel_id": "200000000000000001",
        "call_id": "700000000000000001",
        "thread_id": "500000000000000009",
        "participants": [
          {
            "user_id": "300000000000000001",
            "mute": false,
            "deafen": false,
            "sources": [
              { "source": "camera", "since": "2026-09-07T12:04:00.000Z" },
              { "source": "screen", "since": "2026-09-07T12:10:00.000Z" }
            ]
          },
          { "user_id": "300000000000000002", "mute": true, "deafen": false }
        ]
      }
    ],
    "dm_calls": [
      {
        "channel_id": "200000000000000080",
        "call_id": "700000000000000002",
        "participants": [{ "user_id": "300000000000000003", "mute": false, "deafen": false }]
      }
    ]
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `calls` | object[] | Live **channel** calls. Filtered per recipient: a live room appears only if the recipient's live-resolved visible set contains the channel. May be empty. |
| `dm_calls` | object[] | The recipient's live **DM** calls (no `thread_id` — DM rooms keep no log). May be empty. |
| `calls[].participants[]` / `dm_calls[].participants[]` | object[] | Roster: `{user_id, mute, deafen, sources?}` per participant. Speaking never rides the gateway — clients compute it locally from received audio. |
| `participants[].sources?` | object[] | Calls V2 additive: the participant's live published sources — `[{source, since?}]` with `source` one of `camera` \| `screen` \| `screen_audio` and `since` the publish time (ISO 8601, the recency input for stage-follows-most-recent-sharer). Absent or empty = audio-only (no published video/screen/share-audio tracks). Carried by the sync so late joiners and non-offer moments have attribution without parsing SDP (KTD1). |

Delivery: user-keyed (per-recipient). Resume-replayable, but treat the most
recent CallSync as authoritative; a fresh one follows Resume backfill
regardless.

### CallRing

Ring notification — one recipient is being summoned to a live call
(ring-enabled start, or ring-after-start via
[op 22](./gateway.md#op-22-call-state-update) `state`).

```json
{
  "op": 0,
  "t": "CallRing",
  "s": 70,
  "d": {
    "channel_id": "200000000000000001",
    "call_id": "700000000000000001",
    "from_user": "300000000000000001"
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `channel_id` | Snowflake | Channel the call lives in. |
| `call_id` | Snowflake | Call id (one ring per call — clients dedupe on it). |
| `from_user` | Snowflake | User whose start/ring triggered it. |

Delivery: user-keyed — connected members who pass a live VIEW_CHANNEL check
on the channel, minus notification-muted ones; DM ring defaults on. Rings
live ~30 s client-side; a replayed CallRing past that window is inert.
Resume-replayable mechanically.

### CallSignal

Opaque media signaling (SDP offers/answers, ICE candidates) delivered to one
recipient — the relayed half of [op 23](./gateway.md#op-23-call-signal) and
the room's own (server-sole-offerer) signaling pushes.

```json
{
  "op": 0,
  "t": "CallSignal",
  "s": 71,
  "d": {
    "channel_id": "200000000000000001",
    "body": "<opaque signaling blob, capped at 64 KiB>"
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `channel_id` | Snowflake | Channel whose call the signal belongs to. |
| `body` | string | Opaque signaling blob, exactly as relayed. Capped at **64 KiB**. Server-pushed SDP **offers** ride the versioned envelope v2 below; client answers (op 23) and ICE bodies keep the V1 shapes. |

**Offer envelope v2 (calls V2 additive — the track manifest).** The body of
a server-originated offer is a versioned JSON envelope carrying an explicit
attribution manifest — every media track the offer installs, keyed by the
SDP m-line id it rides:

```json
{
  "v": 2,
  "type": "offer",
  "sdp": "v=0\r\n…",
  "tracks": [
    { "mid": "0", "user_id": "300000000000000001", "source": "camera", "rids": ["f", "h", "q"] },
    { "mid": "1", "user_id": "300000000000000001", "source": "mic" }
  ]
}
```

| Field | Type | Description |
| --- | --- | --- |
| `v` | number | Envelope version — `2`. Absent on V1 bodies (offers and answers): clients discriminate on its presence. |
| `type` | string | `"offer"` — the envelope is carried by OFFERS ONLY; client answers keep the V1 shape on op 23 (an answer never carries a manifest — the room built the topology). |
| `sdp` | string | The SDP body itself, exactly as V1 carried it bare. |
| `tracks[]` | object[] | The manifest: one entry per media m-line. |
| `tracks[].mid` | string | The SDP m-line id the server's offer assigned the track. |
| `tracks[].user_id` | Snowflake | The participant the track is attributed to. |
| `tracks[].source` | string | `camera` \| `screen` \| `screen_audio` \| `mic` — the source kind. `mic` is manifest-only: microphone audio is the V1 call itself (mute/deafen ride op-22 `state`, never publish/unpublish, roster `sources[]`, or CallUpdate `source`) — but its m-line is manifest-attributed like every other track, so audio playback keys on the manifest too (that is R5's retirement of the positional mirror). |
| `tracks[].rids?` | string[] | Simulcast rid layers riding that m-line (e.g. `["f","h","q"]`) — present only when the source publishes multiple layers; absent for single capped streams (and never for `mic`). |

The manifest is the single attribution source: receivers key playback on
`mid` → `(user_id, source)` — audio included, which RETIRES V1's positional
m-line-order mirror (`remoteOrder`) for tracked legs. It is also the
send-side binding key: a publisher attaches its own tracks to the leg's
ingest m-lines **by manifest mid** (`transceiver.sender.replaceTrack` after
`setRemoteDescription`), never first-free-m-line — same-kind sources
(camera/screen; mic/share-audio) otherwise swap when permission prompts
resolve out of publish order. Envelope parsing is tolerance-first: an offer
without `v` is a V1 audio-only body, and a v2 offer whose `tracks` omits an
m-line leaves that line unattributed (never guessed).

Delivery: user-keyed (point-to-point to the recipient's sessions).
**Ephemeral signaling:** CallSignal is a seq-numbered dispatch and replays
mechanically on Resume, but replayed bodies describe stale negotiations —
discard them and await fresh state (CallSync plus the room's re-offer); the
media plane itself survives the reconnect.

## Lifecycle events

### READY

Dispatched once per fresh session at [Identify](./gateway.md#op-2-identify)
success, with `s: 0`. Stores the resume material a client needs to survive a
disconnect.

```json
{
  "op": 0,
  "t": "READY",
  "s": 0,
  "d": {
    "v": 1,
    "session_id": "sAbCdEfGhIjKlMnOpQrSt",
    "resume_token": "19cf5c31e0a24d2f8ba77c6d5e4f3a2b",
    "heartbeat_interval": 30000,
    "user": { "id": "300000000000000001", "username": "jason" }
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `v` | number | Negotiated protocol version. |
| `session_id` | string | Opaque session id for [Resume](./gateway.md#op-5-resume). |
| `resume_token` | string | **Single-use** resume secret. Consumed by a successful Resume; reissued only via a fresh READY. |
| `heartbeat_interval` | number | Milliseconds between heartbeats (echo of Hello). |
| `user` | object | Authenticated identity: `id` (Snowflake) and `username`. |
| `media_enabled` | boolean | Optional. The server's media-plane master switch; absent reads as enabled. |
| `workspaces` | object[] | Optional (native sessions). The member's workspaces, each in the `GET /users/@me/workspaces` row shape. |
| `channels` | object[] | Optional (native sessions). Every channel of those workspaces, each in the `GET /workspaces/{id}/channels` row shape. |
| `dm_channels` | object[] \| null | Optional (native sessions). The member's DM channels in the `GET /users/@me/channels` row shape. `null` means the list could not be read — fetch it over REST; it never means "no DMs". |

The three roster fields let a client paint its sidebar from READY instead of
re-reading the same rows over REST. A client MUST treat their absence (an
older server) as "not provided" and fall back to REST.

### RESUMED

Dispatched once at [Resume](./gateway.md#op-5-resume) success, with `s: 0`,
immediately followed by the replayed backlog (every buffered dispatch with
`s` greater than the client's acknowledged seq, oldest first).

```json
{
  "op": 0,
  "t": "RESUMED",
  "s": 0,
  "d": { "replayed_events": 3, "heartbeat_interval": 30000, "resume_token": "…" }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `replayed_events` | number | How many buffered dispatches follow RESUMED. |
| `heartbeat_interval` | number | Milliseconds between heartbeats (echo of Hello). |
| `resume_token` | string | The session's NEXT single-use resume token. |

Every resume token is single-use: the one presented is consumed by the
Resume, and RESUMED carries its replacement. A client stores it exactly as it
stored READY's, so the session can be resumed again after the next drop.
(Servers before this field consumed the token without a replacement, so a
second resume fell through Invalid Session `false` → re-Identify; a client
that finds no `resume_token` on RESUMED keeps that behaviour.)

### ReadStateSync

Session-start read state, sent on [Identify](./gateway.md#op-2-identify) and on
[Resume](./gateway.md#op-5-resume) — the cold-start half of what
[MessageAck](#messageack) does live. Without it a reconnecting client starts
empty and re-shows what the member has already read.

```json
{
  "op": 0,
  "t": "ReadStateSync",
  "s": 0,
  "d": {
    "channels": [
      {
        "channel_id": "234567890123456789",
        "last_read_id": "234567890123456700",
        "unread_floor": null,
        "unread_count": 3
      }
    ]
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `channels` | ReadStateSyncEntry[] | One entry per channel this session can see. A channel the session cannot see is **absent**, never zeroed. |

`ReadStateSyncEntry`:

| Field | Type | Description |
| --- | --- | --- |
| `channel_id` | Snowflake | Channel the entry describes. |
| `last_read_id` | Snowflake \| null | **Inclusive** watermark: this message and everything before it is read. `null` when the member has never acknowledged the channel. |
| `unread_floor` | Snowflake \| null | **Exclusive** counterpart: this message and everything after it is unread. This is how "mark this unread" survives an acknowledgement that would otherwise claim it was read. |
| `unread_count` | number \| null | Optional. The server's own unread count for the channel — the only signal a client has for a channel it has loaded nothing for. Present for every visible channel, including one never acknowledged. Absent or `null` means the count could not be read and must be treated as "not reported" (fall back to local state); it never means zero. |
| `mention_count` | number \| null | Optional. How many of the member's open mentions in the channel's timeline sit above the read position (the floor outranks the watermark, as for `unread_count`). Absent or `null` means "not reported" — never zero. |

Entries cover the **session-visible** channel set rather than only channels with
stored read state, so channels the member has never opened still report their
counts.

## Membership and roles

### ReadStateUpdate

The server moved ONE channel's read state that this client did not move
itself: a fired reminder ("Remind me…" came due — `unread_floor` now
makes the marked message unread), or a floor set or cleared on another of the
member's devices. User-addressed — the member's own sessions only — and never
translated for compat sessions. One entry in the [ReadStateSync](#readstatesync)
entry shape, but AUTHORITATIVE for its channel: it applies even when the
watermark did not move, and it creates the client's row when none exists.

```json
{
  "op": 0,
  "t": "ReadStateUpdate",
  "s": 71,
  "d": {
    "channel_id": "200000000000000001",
    "last_read_id": "100000000000000150",
    "unread_floor": "100000000000000120",
    "unread_count": 31
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `channel_id` | Snowflake | The channel whose read state moved. |
| `last_read_id` | Snowflake \| null | The inclusive watermark (unchanged by a fire). |
| `unread_floor` | Snowflake \| null | The exclusive floor: this message and everything after it is unread. `null` = cleared. |
| `unread_count` | number | The server's count for the channel under the new state. |
| `mention_count` | number \| null | The unread mention count under the new state (`null` = could not be read). |

### RoleCreate

```json
{
  "op": 0,
  "t": "RoleCreate",
  "s": 58,
  "d": {
    "id": "600000000000000001",
    "workspace_id": "400000000000000001",
    "name": "moderator",
    "permissions": "1048576",
    "position": 2,
    "color": 3066993
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `id` | Snowflake | Role id. |
| `workspace_id` | Snowflake | Owning workspace. |
| `name` | string | Role name. |
| `permissions` | string | Permission **bitfield as a decimal string** (preserves >53-bit values). See the permission bitfield reference in the domain package. |
| `position` | number | Role hierarchy position. |
| `color` | number \| null | Role color as an integer, or `null`. |

### RoleUpdate

Partial update — absent keys unchanged.

```json
{
  "op": 0,
  "t": "RoleUpdate",
  "s": 59,
  "d": { "id": "600000000000000001", "permissions": "1048577" }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `id` | Snowflake | Role id. |
| `name?` | string | New name, if changed. |
| `permissions?` | string | New permission bitfield (decimal string), if changed. |
| `position?` | number | New hierarchy position, if changed. |
| `color?` | number \| null | New color, if changed. |

### RoleDelete

```json
{
  "op": 0,
  "t": "RoleDelete",
  "s": 60,
  "d": { "id": "600000000000000001" }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `id` | Snowflake | Deleted role id. |
| `workspace_id?` | Snowflake | Owning workspace, when included. |

### MemberAdd

```json
{
  "op": 0,
  "t": "MemberAdd",
  "s": 61,
  "d": {
    "workspace_id": "400000000000000001",
    "user": { "id": "300000000000000003", "username": "newcomer" },
    "joined_at": "2026-08-27T18:15:00.000Z"
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `workspace_id` | Snowflake | Workspace joined. |
| `user` | object | Member identity: `id` (Snowflake), `username`, and (additive) `display_name` and `avatar_url` (string or null each). |
| `joined_at` | ISO 8601 | Join time (a machine principal: when it was minted). |
| `nickname?` | string \| null | The workspace nickname, shown before `user.display_name` (a machine principal's label). Additive. |
| `roles?` | Snowflake[] | Role ids. Additive. |
| `kind?` | string | `human`, `bot`, `agent` or `webhook` — the roster row's principal kind (the badge). Additive. |
| `parent_user_id?` | Snowflake | Machine principals only: the owning person. Additive. |
| `dm_support?` | string | Bots/agents only: who it will hold a DM with (`humans`, `everyone`, `none`). Additive. |

The payload is the people page's row for the member plus `workspace_id`, so a
member that arrives live carries what a reload would read. It is emitted when a
person joins (invite accept) and when a machine principal becomes ASSOCIATED
with the workspace — its owner grants it the workspace (`PATCH /bots/{id}`
`access`), or its owner joins a workspace its `all`-mode grant then covers.
Revoking that grant emits `MemberRemove`.

### MemberRemove

```json
{
  "op": 0,
  "t": "MemberRemove",
  "s": 62,
  "d": { "workspace_id": "400000000000000001", "user_id": "300000000000000003" }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `workspace_id` | Snowflake | Workspace left. |
| `user_id` | Snowflake | Member removed. |

### MemberUpdate

A member's workspace nickname changed (#169) — a person's or a bot's, set by
themselves (CHANGE_NICKNAME) or by a member with MANAGE_NICKNAMES
(`PATCH /workspaces/{id}/members/@me|{user_id}`). Delivered on the workspace
key. A nickname belongs to ONE workspace: store it per workspace, never on a
global user row. The name to show is the nickname, else the account's
`display_name`, else the `username`.

```json
{
  "op": 0,
  "t": "MemberUpdate",
  "s": 64,
  "d": { "workspace_id": "400000000000000001", "user_id": "300000000000000003", "nickname": "Gemstone" }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `workspace_id` | Snowflake | The workspace the nickname belongs to. |
| `user_id` | Snowflake | The member (person or machine principal). |
| `nickname` | string \| null | The new nickname; null when cleared. |

Compat: delivered to bots holding GUILD_MEMBERS as `GUILD_MEMBER_UPDATE`
(the member object with `nick`, plus `guild_id`).

### AccountDelete

A user account was deleted (soft-delete tombstone applied; messages become
`[message deleted]`-style placeholders per the account-deletion policy).

```json
{
  "op": 0,
  "t": "AccountDelete",
  "s": 63,
  "d": {
    "user_id": "300000000000000004",
    "deleted_at": "2026-08-27T18:20:00.000Z"
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `user_id` | Snowflake | Deleted account's user id. |
| `deleted_at` | ISO 8601 | When deletion was applied. |

### InteractionCreate

A human invoked an application command (bots plan U8) or clicked a message
component (components plan U2 — `kind: "component"`). Delivered to the
BOT's own sessions only — user-keyed (application-addressed), never
broadcast to the workspace; the invoking human gets the REST 202 from
`POST /api/v1/interactions`, then [InteractionSuccess](#interactionsuccess)
when the bot answers. `token` is the short-lived (15-minute)
callback credential for `POST /api/v10/interactions/{id}/{token}/callback`.

> Store seam note (U9): the web client's store learns this event in a later
> unit — until then a store reconcile over `InteractionCreate` is a no-op;
> the payload contract here is final.

```json
{
  "op": 0,
  "t": "InteractionCreate",
  "s": 64,
  "d": {
    "id": "100000000000000002",
    "token": "qkcDEacTOAXdfzf6fxVCf1H9_4sqGwnlQbi4sl-G3cx",
    "application_id": "600000000000000001",
    "command": { "id": "600000000000000002", "name": "echo" },
    "options": { "text": "hi" },
    "channel_id": "200000000000000001",
    "workspace_id": "400000000000000001",
    "user": { "id": "300000000000000001", "username": "invoker" }
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `id` | Snowflake | Interaction id. |
| `token` | string | Opaque one-bot callback credential (15-minute life, revocation kills it). |
| `application_id` | Snowflake | The bot principal the command/component belongs to. |
| `command` | object | Command invocations: `{id, name}` of the invoked command definition. Absent on component clicks. |
| `options` | object | Command invocations: flat name → value map exactly as the invoker supplied it. Absent on component clicks. |
| `channel_id` | Snowflake | Channel the interaction happened in (for a card inside a thread: the thread's PARENT channel). |
| `thread_id` | Snowflake | Component clicks (and modal submits opened from one) on a THREAD message: the thread's id. Absent otherwise. The compat translation renders it as Discord's `channel_id`, and answers to the interaction post into the thread. |
| `workspace_id` | Snowflake | Owning workspace. Absent on DM-channel component clicks. |
| `user` | object | Invoking human `{id, username}`. |
| `kind` | string | `"component"` on component clicks (the KTD9 discriminator), `"modal_submit"` on a modal submission; absent on command invocations. |
| `message_id` | Snowflake | Component clicks: the clicked message's id. |
| `custom_id` | string | Component clicks: the bot's opaque control namespace (verified against the stored row at ingress — routed, never interpreted). |
| `component_type` | number | Component clicks: `2` (button) \| `3` (string select). |
| `values` | string[] | String-select clicks: the chosen stored option values. |
| `app_permissions` | number | Component clicks: the owning bot's resolved channel bitfield (DM clicks: the full participation bitfield). |
| `message` | object | Component clicks: the clicked message row snapshot (bot-authored, components joined) — the source of the compat wire's `d.message`. Also on a modal submit whose modal was opened from a click. |
| `components` | object[] | Modal submits: one action row per text input, in the modal's order — `{type: 1, components: [{type: 4, custom_id, value}]}`. (`custom_id` is then the MODAL's.) The compat translation renders the submit as Discord's type-5 `MODAL_SUBMIT`. |

Component-click example (the native payload a bot's session receives; the
compat gateway translation renders it as Discord's type-3
`INTERACTION_CREATE` with the full embedded `message`, `member`/`user`,
`entitlements: []`, `authorizing_integration_owners`, `app_permissions`
(decimal string) and `attachment_size_limit`):

```json
{
  "op": 0,
  "t": "InteractionCreate",
  "s": 65,
  "d": {
    "id": "100000000000000003",
    "token": "qkcDEacTOAXdfzf6fxVCf1H9_4sqGwnlQbi4sl-G3cx",
    "application_id": "600000000000000001",
    "kind": "component",
    "channel_id": "200000000000000001",
    "workspace_id": "400000000000000001",
    "user": { "id": "300000000000000001", "username": "clicker" },
    "message_id": "100000000000000004",
    "custom_id": "approve",
    "component_type": 2,
    "app_permissions": 65535,
    "message": {
      "id": "100000000000000004",
      "channel_id": "200000000000000001",
      "author_id": "600000000000000001",
      "content": "card",
      "components": [
        {
          "type": 1,
          "components": [
            { "type": 2, "style": 1, "label": "Approve", "custom_id": "approve" }
          ]
        }
      ]
    }
  }
}
```

### InteractionModal

A bot answered one of THIS user's interactions with a modal (callback type 9). Delivered to the INVOKING human's sessions only (user-keyed); the
session holding `interaction_id` — from its click's or command's REST 202 —
opens the form. The definition is normalized server-side (defaults filled,
unknown keys dropped). Submit once, within the interaction's 15-minute life:
`POST /api/v1/interactions {kind: "modal_submit", interaction_id, custom_id,
components: [{type: 1, components: [{type: 4, custom_id, value}]}]}` — the
answers must match the inputs exactly (every input once, `required`,
`min_length`/`max_length`, no line breaks in a short input). Cancelling sends
nothing (Discord parity).

```json
{
  "op": 0,
  "t": "InteractionModal",
  "s": 66,
  "d": {
    "interaction_id": "100000000000000003",
    "application_id": "600000000000000001",
    "channel_id": "200000000000000001",
    "custom_id": "feedback",
    "title": "Tell us more",
    "components": [
      {
        "type": 1,
        "components": [
          {
            "type": 4, "custom_id": "details", "style": 2, "label": "Details",
            "min_length": 0, "max_length": 4000, "required": true,
            "placeholder": "What happened?"
          }
        ]
      }
    ]
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `interaction_id` | Snowflake | The interaction the modal answers — the key the submit names. |
| `application_id` | Snowflake | The bot that opened it. |
| `channel_id` | Snowflake | Where the originating interaction happened. |
| `custom_id` | string | The modal's own id (echoed on submit). |
| `title` | string | Form title, ≤ 45 chars. |
| `components` | object[] | 1–5 rows, each exactly one text input: `custom_id`, `style` (1 short \| 2 paragraph), `label` (≤ 45), `min_length`, `max_length` (≤ 4000), `required`, optional `value` (prefill) and `placeholder` (≤ 100). |

### InteractionSuccess

The bot ANSWERED one of this user's interactions — a component click, a
modal submit, or a slash command. Discord's `INTERACTION_SUCCESS`, which
Discord also sends only to the user who made the interaction. Delivered to
the INVOKING human's sessions only (user-keyed), ONCE per interaction, at
the bot's first answer of any kind:

- the initial response: callback type 4 (reply), 5 (deferred reply),
  6 (deferred update), 7 (update the message) or 9 (modal);
- or, from a bot that skipped the initial response, a followup (callback
  route without `type`, or `POST /webhooks/{app}/{token}`).

Later legs of the same flow (the followup after a 5, the `@original` PATCH
after a 6) send nothing more. The client resolves the pending control by
`nonce` — the optional `nonce` (1–64 chars) its `POST /api/v1/interactions`
sent, known before the REST 202, which this event can outrun (the server
fans the interaction to the bot before answering the POST) — or by
`interaction_id`. A bot that never answers produces no event: the client's
own timeout is the "no response" signal. Compat (bot) sessions never receive
it — only humans invoke interactions.

```json
{
  "op": 0,
  "t": "InteractionSuccess",
  "s": 67,
  "d": {
    "interaction_id": "100000000000000003",
    "nonce": "8f1c6c1e-5d0e-4c55-9d43-6a2b1f0c7e11",
    "application_id": "600000000000000001",
    "channel_id": "200000000000000001",
    "thread_id": "200000000000000077",
    "message_id": "300000000000000042",
    "custom_id": "once",
    "response_type": 6
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `interaction_id` | Snowflake | The interaction that was answered (the id its POST's 202 returned). |
| `nonce` | string \| null | The `nonce` the invoking POST sent; `null` when it sent none. |
| `application_id` | Snowflake | The bot that answered. |
| `channel_id` | Snowflake | Where the interaction happened — the PARENT channel for a card inside a thread. |
| `thread_id` | Snowflake \| null | The thread, for a card inside one; `null` otherwise. |
| `message_id` | Snowflake \| null | The clicked message (component clicks, and modals opened from one); `null` for a command. |
| `custom_id` | string \| null | The clicked control's `custom_id` (a modal submit's: the modal's); `null` for a command. |
| `response_type` | integer | How the bot answered: the callback type (4, 5, 6, 7, 9); 4 for a followup. |

## Event catalog index

| Event | Payload anchor |
| --- | --- |
| AccountDelete | [AccountDelete](#accountdelete) |
| CallEnd | [CallEnd](#callend) |
| CallRing | [CallRing](#callring) |
| CallSignal | [CallSignal](#callsignal) |
| CallStart | [CallStart](#callstart) |
| CallSync | [CallSync](#callsync) |
| CallUpdate | [CallUpdate](#callupdate) |
| ChannelCreate | [ChannelCreate](#channelcreate) |
| ChannelDelete | [ChannelDelete](#channeldelete) |
| ChannelUpdate | [ChannelUpdate](#channelupdate) |
| UserUpdate | [UserUpdate](#userupdate) |
| InteractionCreate | [InteractionCreate](#interactioncreate) |
| InteractionModal | [InteractionModal](#interactionmodal) |
| InteractionSuccess | [InteractionSuccess](#interactionsuccess) |
| MemberAdd | [MemberAdd](#memberadd) |
| MemberRemove | [MemberRemove](#memberremove) |
| MessageAck | [MessageAck](#messageack) |
| MessageCreate | [MessageCreate](#messagecreate) |
| MessageDelete | [MessageDelete](#messagedelete) |
| MessageReactionAdd | [MessageReactionAdd](#messagereactionadd) |
| MessageReactionRemove | [MessageReactionRemove](#messagereactionremove) |
| MessageReactionRemoveAll | [MessageReactionRemoveAll](#messagereactionremoveall) |
| MessageUpdate | [MessageUpdate](#messageupdate) |
| PresenceUpdate | [PresenceUpdate](#presenceupdate) |
| READY | [READY](#ready) |
| RESUMED | [RESUMED](#resumed) |
| ReadStateSync | [ReadStateSync](#readstatesync) |
| ReadStateUpdate | [ReadStateUpdate](#readstateupdate) |
| RoleCreate | [RoleCreate](#rolecreate) |
| RoleDelete | [RoleDelete](#roledelete) |
| RoleUpdate | [RoleUpdate](#roleupdate) |
| ThreadCreate | [ThreadCreate](#threadcreate) |
| ThreadDelete | [ThreadDelete](#threaddelete) |
| ThreadListSync | [ThreadListSync](#threadlistsync) |
| ThreadMemberAdd | [ThreadMemberAdd](#threadmemberadd) |
| ThreadMemberRemove | [ThreadMemberRemove](#threadmemberremove) |
| ThreadMessageCreate | [ThreadMessageCreate](#threadmessagecreate) |
| ThreadUpdate | [ThreadUpdate](#threadupdate) |
| TypingStart | [TypingStart](#typingstart) |

36 events. This page mirrors the `EventName` union in `@cytale/protocol`;
adding an event there requires adding it here (enforced at review, see
[Versioning](./versioning.md)).
