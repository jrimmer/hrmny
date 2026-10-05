# REST API

> **Status: shipped (U9+), growing unit by unit.**
> The `/api/v1` surface below is the endpoint contract. Units land the
> surfaces they name; a described-but-unserved endpoint notes its unit on the
> row. Treat undocumented additions as additive (new optional keys never
> change existing fields).

Base URL: `https://<host>/api/v1`

## Conventions (binding for every endpoint)

- **Versioned paths.** `/api/v1/...` — never versioned headers alone (see
  [Versioning](./versioning.md)).
- **IDs are Snowflake strings.** Every ID in a path or body is a decimal
  string, never a JSON number — see the [protocol conventions](./README.md#conventions-both-surfaces).
- **One error envelope everywhere:**

  ```json
  {
    "error": {
      "key": "channel_not_found",
      "code": 40001,
      "message": "No channel with that id"
    }
  }
  ```

  with the appropriate HTTP status. `key` is a stable machine-readable key
  documented per endpoint; `code` is a numeric error code.

- **`503` when the database cannot answer.** A transient storage failure uses
  the envelope above with `key: "service_unavailable"` and `code: 50301`, plus a
  `Retry-After` header (integer seconds). Clients should retry after that delay
  rather than treat it as a credential or request failure.
  Only READ-class failures are answered this way: a write whose outcome is
  UNKNOWN (a write timeout or a replica write failure) is a `500`, because
  retrying it could duplicate the write. The other half of the same hardening
  item — a cluster-wide driver retry strategy — is not configured yet, so
  `Retry-After` is a client hint, not a server guarantee.
  The Discord-compatible surface at `/api/v10` (and its bare `/api` alias) does
  NOT use this envelope; it keeps its own bare `{code, message}` shape — see
  [compat](./compat.md).

- **Cursor pagination** on Snowflake IDs: `?before=<snowflake>&after=<snowflake>&limit=N`.
  Every list endpoint documents its default and max `limit`. Newest-first
  ordering falls out of Snowflake chronological sort.
- **Recovery is by cursor, over HTTP**. Messages, thread replies and
  channels are recoverable with the cursors above — a client that missed
  events (beyond the gateway's resume buffer) re-reads with `after=<last id
  it holds>` and converges. **Reactions deliberately ride the message rows**
  rather than having a separate replay listing: channel history (and the
  compat surface's channel and thread reads) carry each message's current
  reaction summary, so re-reading a message recovers its reactions exactly,
  including removals a replay would have to encode. The native thread index
  carries none today — no native client renders reactions on a thread reply;
  it gains the summary when one does. A per-message reaction history stays
  unbuilt until a consumer needs one.
- **Idempotent mutations.** Mutating POSTs accept an `Idempotency-Key` header
  so client retries never double-send. For most POSTs that replay is
  in-memory (the stored response, `Idempotency-Replayed: true`). **Message
  sends** — the channel send and the thread reply
  (`POST /threads/{id}/messages`) — use ONE mechanism instead, the durable
  dedupe every send route shares: the body `nonce` (or the Idempotency-Key
  when there is no nonce) is reserved per author for 24 h before the message
  is written, and a retry with the same key answers **200 with the original
  message** — across restarts, 5xx responses and retries that race the first
  POST — without re-emitting its events or re-counting a thread reply. The
  key names ONE message: reusing it for a different message is a
  `409 idempotency_conflict` — another channel, the channel timeline vs. a
  thread, or the same conversation with different `content`, `reply_to_id`
  or `attachments` (files compare by their stored content, so a retry whose
  upload URLs were re-signed still replays). The Discord-compatible send
  dedupes on the same key space the same way (see `compat.md`).
- **Rate limits** surface standard headers on every response:
  `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset-After`;
  exhausted buckets return `429` with `Retry-After` and a `message` that names
  the limit that tripped (account vs. shared per-IP) plus the retry hint —
  clients render a 429 as "slow down", never as a credential failure. The
  tripped limit is also DATA, so a client branches on it rather than on the
  sentence: the envelope carries `scope` and `retry_after_ms`, and the same
  scope rides the `X-RateLimit-Scope` header:

  ```json
  {
    "error": {
      "key": "rate_limited",
      "code": 42901,
      "message": "Too many messages in this conversation — …",
      "scope": "conversation",
      "retry_after_ms": 1840
    }
  }
  ```

  | `scope` | The limit that tripped |
  | --- | --- |
  | `conversation` | the send budget, per sender in ONE channel or thread — only that conversation needs to wait |
  | `sender` | the send budget, per sender across all conversations |
  | `account` | the account's general request budget |
  | `ip` | a per-IP limit: the pre-auth dam, or the ceiling shared by every account behind one IP |

  `retry_after_ms` is the wait in milliseconds (`Retry-After` is the same wait
  rounded up to whole seconds). Treat an absent or unknown `scope` as a limit
  on everything the client sends. The failed-attempt locks on login and
  two-factor verification answer `rate_limited` without a `scope`.
- **Message sends have ONE budget**, the same for a person and a bot and
  shared with the Discord-compatible send (which renders it in Discord's
  429 shape): per sender, **10 sends / 5 s into one channel or thread**, and
  **20 sends / 5 s across all conversations**. Sends are not counted against
  the general `50 / 10s` account budget (every other request still is; the
  per-IP ceiling covers both). The headers describe the send bucket closer
  to exhaustion. Why these numbers: the web app posts one message at a time
  per conversation, and when a connection returns it re-sends every held
  message in typed order — several into one conversation, several
  conversations at once — so 10 per conversation and 20 overall let a normal
  offline backlog through; Discord documents about 5 / 5 s per channel for
  bots, and at twice that a Discord-tuned bot (which paces by these headers)
  never meets the limit, while a flood from any one sender still stops within
  seconds.
- **Verbs:** reads are GET-only and cache-friendly where sensible; writes use
  POST/PATCH/DELETE. No verbs in paths.
- **Auth:** `Authorization: Bearer <token>` on everything except the auth
  endpoints themselves. Tokens are the same JWT access tokens the gateway
  Identify consumes. Unverified accounts are view-only: content-producing
  mutations fail at one server-side choke point regardless of client
  behavior.
- **Tiers:** the app tier below serves members, clients, and third parties
  alike; `/api/v1/admin/...` adds operator/owner powers gated by
  ADMINISTRATOR-class permissions.

## Auth

| Endpoint | Method | Description |
| --- | --- | --- |
| `/auth/register` | POST | Create an account (username, email, password). Account is **view-only until email verification completes**. |
| `/auth/verify-email` | POST | Consume a verification token; unlocks content-producing mutations. |
| `/auth/login` | POST | Username-or-email + password → access token (15 min TTL) + refresh token (30-day rotating). |
| `/auth/refresh` | POST | Rotate the refresh token; issue a fresh access token. |
| `/auth/logout` | POST | Revoke the presented refresh token. |
| `/auth/password-reset` | POST | Begin password reset (email a short-TTL token). |
| `/auth/password-reset/confirm` | POST | Consume the reset token; set the new password. |
| `/users/@me` | GET / PATCH | Current account; display name/avatar updates. `GET` carries `kind` (plain `"human"` for app accounts) plus `parent_user_id` (decimal string) when the caller is a machine principal. |
| `/users/@me/delete` | POST | Begin account deletion (soft-delete tombstone, 30-day grace). |

Machine credentials (`Authorization: Bearer cytbot_…` or `Bot cytbot_…`)
authenticate every endpoint above except the auth endpoints themselves;
revocation is wire-instant (next REST call 401s, live gateway sessions close
4004). Only `:human` principals may mint sub-credentials (R5).

## Bots (machine principals)

**Vocabulary:** the wire, the kind, the token prefix (`cytbot_`) and the
routes all say **bot**. "Agent" is only ever the word the UI shows a person —
no identifier, path or field uses it.

Zero-ceremony minting and lifecycle. One field (`name`) yields a principal
plus a once-only `cytbot_` token returned EXACTLY at create/regenerate —
every other read is metadata only (`id`, `name`, `kind`, `created_at`,
`access`; never tokens). A bot is **user-owned**: any verified human mints one
for themselves, no permission gate, and it is not tied to a workspace —
workspaces appear only as grants in its access document. Unknown or unowned
ids 404 with `bot_not_found`.

**Mint cap:** a human parent holds at most **50 machine principals** (bots and
webhooks combined). The 51st create is a `400` with the native `principal_cap`
error key — the budget bounds credential sprawl and roster synthesis per human.

The merge principle applies throughout: sub-identity principals appear in
members/people reads and presence like any member (see
[roster synthesis](#roster-synthesis-sub-identities-in-memberspeople-reads)),
and read-state is per-principal — an agent's `/channels/{id}/ack` writes the
agent's own `read_state` row and never moves the parent's unread.

### Workspace-scoped bots — RETIRED

The routes that let a workspace own a credential
(`POST|GET /workspaces/{id}/bots`, `PATCH|POST .../bots/:id`,
`POST .../bots/:id/regenerate`, `DELETE .../bots/:id`) are **gone**: authority
comes from the access grant the bot's owner sets, never from a role in a
workspace. `POST /bots` below is the only provisioning path.

Rows minted under the old route keep working — the ownership rule is "the
caller is the parent", independent of kind, so nothing is stranded — and the
`kind` a row carries is not a distinction the API draws: a row that reads out
as `agent` (minted while a second kind existed) is the same thing as one that
reads `bot`.

### Access policy (the bot grant)

A bot's authority is an **access document** held on its principal row —
`"access"` on every bot read and write, and the authoritative form for a
machine principal. A machine principal resolves to **the parent's reach
intersected with its grant**, so a grant can only ever narrow; an un-granted or
unparseable document is **no access, never the legacy behaviour**. `"restrictions"`
is retained on the wire for Discord-compat consumers but is **not
authoritative** for a machine principal.

```json
{ "v": 1,
  "server": "read",
  "account": { "agent": "read" },
  "dms": "read_write",
  "workspaces": { "mode": "custom", "level": null,
    "grants": { "91267263520309248": { "level": "read_write",
      "channels": { "91267352024317952": "read" } } } } }
```

| Field | Values | Notes |
| --- | --- | --- |
| `v` | `1` | Document version. A future version reads as no access until it is understood. |
| `server` | `read` | **Fixed.** Reported by the server; not the caller's to set. |
| `account.agent` | `read` | **Fixed.** The agent's OWN identity — it acts as itself, never as its owner (no impersonation, by design). |
| `dms` | `none` \| `read` \| `read_write` | Explicit; never implied. |
| `workspaces.mode` | `none` \| `all` \| `custom` | `all` uses `level` for every workspace **including ones joined later**. |
| `workspaces.level` | level \| `null` | The level for `mode: "all"`; `null` while `grants` are in force. |
| `workspaces.grants` | map of workspace-id → grant | Used by `mode: "custom"`; **retained but dormant** while `mode` is `all` — switching modes never rewrites the other side, and clearing the root restores the grants unchanged. |

**Levels** are exactly `none` · `read` · `read_write`. The capability table is
the contract — a new bit belongs in a level or in the never-grantable set, and
a test fails if it lands in neither:

| Capability | none | read | read_write |
| --- | --- | --- | --- |
| Workspace/channel metadata, member + presence roster | — | ✓ | ✓ |
| Message history, search, receiving gateway events | — | ✓ | ✓ |
| Own read state | — | ✓ | ✓ |
| Send messages, upload attachments, type | — | — | ✓ |
| Add/remove reactions | — | — | ✓ |
| Create/reply in threads | — | — | ✓ |
| Manage channels/roles, invite/kick, edit/delete others' messages | — | — | — (never, by any grant) |

A `PATCH` carries the **whole document** (one save path: the server validates
mode/level consistency — `mode: "all"` requires a level — before persisting, so
a tree can never be half-applied). Invalid documents → 400 `invalid_access`.
An authority change (`"access"` **or** the legacy `"restrictions"`) tears the
principal's live sessions down through the reconnectable Reconnect signal (op 6
native / op 7 compat — never 4004) and purges their resume records, so a Resume
cannot resurrect the pre-change grant; the socket's visibility memo also
recomputes against the current document on an epoch move, so a session that
slips through the teardown window is re-resolved rather than left stale.

### Legacy restrictions policy

`"restrictions"` is `null` (unrestricted) or an object with `"actions"`
(subset of `["read", "post"]`) and/or `"channels"` (allowlist of channel-id
decimal strings; empty/omitted = all channels). Superseded by the access
document above for machine principals; a restrictions PATCH still tears live
sessions down through the reconnectable server Reconnect signal (op 6 native /
op 7 compat on the gateway wire) — never close 4004, which client libraries
treat as fatal. In-flight REST requests complete; revocation bounds the NEXT
action. Deleting the parent account revokes every sub-credential, deletes
their webhook capability rows, and closes their sessions with 4004.

## Workspaces

| Endpoint | Method | Description |
| --- | --- | --- |
| `/workspaces` | POST | Create a workspace. |
| `/workspaces/{id}` | GET / PATCH / DELETE | Read/update/delete a workspace. |
| `/workspaces/{id}/members` | GET | List members (cursor-paginated). Membership-gated through the principal-rights resolver (view-rights consult): members and their machine principals (parent fallback) read; non-members 403 `forbidden`; unknown workspace 404. The roster also lists every member's machine principals beside them — see [roster synthesis](#roster-synthesis-sub-identities-in-memberspeople-reads). |
| `/workspaces/{id}/members/{user_id}` | DELETE | Kick a member (admin tier). |
| `/workspaces/{id}/members/@me` and `/workspaces/{id}/members/{user_id}` | PATCH | Set or clear a workspace nickname (#169): body `{"nickname": "…"}`, `null` or blank clears, at most 32 characters. Your own needs `CHANGE_NICKNAME` (everyone's by default; a bot's via a `read_write` grant), anyone else's `MANAGE_NICKNAMES` and a role above theirs (never the owner's unless you are the owner). `200 {workspace_id, user_id, nickname}`; announces `MemberUpdate`. `403 forbidden`, `404 member_not_found`, `400 validation_failed`, `409 name_taken` (see [unique shown names](#unique-shown-names)). People and bots, one path. |
| `/workspaces/{id}/members/{user_id}/ban` | PUT / DELETE | Ban / unban (admin tier). |
| `/workspaces/{id}/invites` | GET | List invites (admin tier). |
| `/workspaces/{id}/media-settings` | GET / PUT | Workspace master media toggles (calls V2 plan U8, R16) — [shape below](#workspace-media-settings-getput-workspacesidmedia-settings). Owner/admin tier (`manage_workspace`, exactly `PATCH /workspaces/{id}`'s gate). |
| `/invites/{code}` | GET / POST | Inspect / accept an invite (expiring, revocable). |
| `/invites/{code}` | DELETE | Revoke an invite. |

### Roster synthesis: sub-identities in members/people reads

Machine principals appear in the member roster and the people directory like
any member (the merge principle): for every human member row, that member's
machine principals ride the same row group in the payload. A principal
belongs to a workspace exactly where its PARENT is a member (R1) —
principals never carry `workspace_members` rows of their own, and cursors
stay keyed on human ids (`limit` bounds the human page; synthesized entries
are additive on top of it).

Every entry carries `"kind"`: `"human"` for member rows, or the principal's
minted kind (`"bot"`, `"agent"`, `"webhook"`); machine entries additionally
carry `"parent_user_id"` (decimal string). The people directory's
`next_before` cursor always points at the last HUMAN entry of the page.

#### Unique shown names

A shown name is unique in a workspace (owner decision 2026-10-04). The name a
member CHOOSES is refused with `409 name_taken` when another member of the
workspace is already shown by it — their nickname, display name or username,
people and bots alike — compared ignoring case and folding Unicode
compatibility forms (NFKC), so look-alikes collide:

- a workspace nickname (`PATCH /workspaces/{id}/members/…`), in that workspace;
- an account display name (`PATCH /users/@me`), in every workspace the account
  belongs to (the message names the first one);
- a bot's label (`PATCH /bots/{id}` `name`), in every workspace its grant
  reaches.

Your own names never collide with you, and clearing is always allowed. A
collision nobody chose (someone joining with a name already in use) is not
refused; clients show the `@username` beside a name wherever it differs from
it, which tells the two apart.

Every entry's `user` carries `"display_name"` (#168): the account's display
name, or `null` when it has none; a machine principal's is its label. The
members list carries it beside `username`, and DM `recipients` carry it on
each peer. Show a member by `nickname`, else `display_name`, else `username`;
the people search (`?query=`) matches all three.

```json
{
  "user": { "id": "89432729178865664", "username": "ops-agent", "display_name": "Ops Agent" },
  "nickname": null,
  "joined_at": "2026-09-04T00:00:00Z",
  "roles": [],
  "kind": "agent",
  "parent_user_id": "89432729145311232"
}
```

## Channels and messages

### Sending a message

Every send route — `POST /channels/{id}/messages`,
`POST /threads/{id}/messages`, and the Discord-compatible
`POST /api/v10/channels/{id}/messages` — runs ONE pipeline, so people and
bots get the same rules; only the error dialect differs.

- `content` 1–4000 bytes, required unless `embeds` ride the message.
- `embeds` / `components`: from machine authors (see
  [embeds](#message-json-embeds-optional-key)); a person's embeds are a
  `400 embeds_not_allowed`, a person's components are ignored.
- `reply_to_id`: a message in the same conversation (the channel, or the
  thread for a thread reply).
- `allowed_mentions` (optional): Discord's object — `parse` (a subset of
  `users`, `roles`, `everyone`), `users` / `roles` (≤ 100 ids each, never
  together with the same kind in `parse`), `replied_user` (default `false`
  once sent). It decides which mentions NOTIFY; the text is unchanged.
  Absent, every `<@id>` notifies and a reply reaches the replied-to author.
  It only narrows: `@everyone`/`@here` still require `mention_everyone`, a
  listed user must appear in the content, and roles have no mention syntax
  (accepted, nothing to act on). Malformed is a `400 validation_failed`.
  When sent, the create's answer and dispatch carry `mention_user_ids` — the
  users the message may notify directly (the replied-to author included when
  `replied_user` allows) — which the push policy and the mentions inbox
  honour.

| Endpoint | Method | Description |
| --- | --- | --- |
| `/workspaces/{id}/channels` | GET / POST | List / create channels (categories included). |
| `/channels/{id}` | GET / PATCH / DELETE | Read / update / delete a channel. |
| `/channels/{id}/messages` | GET | History, newest first. `?before=` pages older, `?after=` pages newer (the rows just past the anchor — incremental catch-up); both exclusive, at most one (`400` for both). `?limit=` 1–100, default 50. Response `{messages, oldest_id, newest_id}`: pass `oldest_id` as the next `before`, `newest_id` as the next `after`; both `null` on an empty page. |
| `/channels/{id}/messages` | POST | Send a message (`Idempotency-Key` honored; fan-out via gateway [MessageCreate](./events.md#messagecreate)). Body `{content, nonce?, reply_to_id?, thread_id?, attachments?, embeds?, components?, allowed_mentions?}` — see [Sending a message](#sending-a-message). A body `thread_id` (a thread whose parent is this channel, else `400`) makes it a **thread reply**, exactly as `POST /threads/{id}/messages` posts one: the same dual emission, auto-follow and reply counters, the thread-wire response, and a `reply_to_id` that must name a message in that thread. `reply_to_id` otherwise names any message in the channel. |
| `/channels/{id}/messages/{mid}` | GET / PATCH / DELETE | Read / edit / delete one message. The GET is the **permalink resolver**: the uniform channel gate (view rights; DM channels authorize by participation; a thread reply resolves through the PARENT channel and carries its own `thread_id`), and every miss — malformed id, foreign or unknown channel, unknown message — renders the identical `404 message_not_found` body, so it is not an enumeration oracle. |
| `/permalinks` | POST | Mint an opaque permalink: `{channel_id, message_id}` → `{token, url}`. Member-gated on the channel (the same gate as the resolver); minting does not check that the message exists, because a link is a reference, not a read. |
| `/permalinks/{token}` | GET | Resolve a token → `{channel_id, message_id}`. The same uniform 404 for an unknown token, a tampered tag, and a channel the caller cannot see — no existence oracle. Feeding the pair to `/channels/{id}/messages/{mid}` is what reads the message, under that route's gate. |
| `/m/{token}` | GET (page) | **The shareable address.** Always serves the SPA shell with a **content-free** card (`og:` metadata with no message text, author, channel or id), because unfurls are fetched unauthenticated by the receiving platform; a signed-in client resolves the token and lands on the message. The token is keyed to the instance (`CYTALE_PERMALINK_KEY`, else derived from the app secret), so rotating the key invalidates previously copied links. |
| `/channels/{id}/messages/{mid}/reactions/{emoji}/@me` | PUT / DELETE | Add / remove the CALLER's own Unicode-emoji reaction → `204`. Idempotent: a re-add of an existing reaction is still `204` but emits NO event and moves no count. Emoji validation: 1–14 UTF-8 bytes, no colons (custom-emoji `:name:` syntax rejected) → `400 validation_failed`; the 21st DISTINCT emoji on one message → `400 too_many_emojis` (Discord's cap of 20). |
| `/channels/{id}/messages/{mid}/reactions/{emoji}` | GET / DELETE | GET: users who reacted with that emoji — `{"users": [{id, username, …}], "next_after"}` (`?limit=` cap 100, `?after=` exclusive user_id cursor; `next_after` null on the last page). DELETE: clear that emoji for EVERYONE — `manage_messages` (403 otherwise) → `204` + one [MessageReactionRemove](./events.md#messagereactionremove) per removed user. |
| `/channels/{id}/messages/{mid}/reactions/{emoji}/{user_id}` | DELETE | Remove ANOTHER principal's reaction — `manage_messages` → `204` (idempotent no-op on an absent row). |
| `/channels/{id}/messages/{mid}/reactions` | DELETE | Clear EVERY reaction — `manage_messages` → `204` + one [MessageReactionRemoveAll](./events.md#messagereactionremoveall). |
| `/channels/{id}/messages/{mid}/threads` | POST | Start a thread on a message. |
| `/channels/{id}/ack` | POST | REST fallback for gateway [op 21](./gateway.md#op-21-message-ack) — same body. |
| `/channels/{id}/typing` | POST | REST fallback for gateway [op 20](./gateway.md#op-20-typing-start-client). Gated by the uniform channel gate: a channel the caller cannot view renders the identical 404 `channel_not_found` (anti-enumeration, never a 403 oracle). |
| `/channels/{id}/call` | GET | Call state + call-log anchor — [shape below](#call-state-and-call-log-get-channelsidcall). Uniform channel gate (DM channels authorize by participation). |
| `/channels/{id}/media-override` | GET / PUT | Per-channel media overrides (calls V2 plan U8, R16) — [shape below](#channel-media-override-getput-channelsidmedia-override). Manage-channels tier through the uniform channel gate (foreign channel → the identical 404 `channel_not_found`; DM channels carry no override surface and 404). |
| `/calls/ice` | GET | ICE config for call media (voice plan U12) — [shape below](#ice-config-get-callsice). Authenticated, principal-scoped (not channel-scoped). |

### Message marks

User-assigned state on a message, one route family keyed by `kind`. v1 has
one kind, `snooze` — the "Remind me…" action: private to its owner, and when
due it makes the message unread again for that owner (the read state's
exclusive floor — no second unread behaviour).

| Path | Method | Purpose |
| --- | --- | --- |
| `/users/@me/marks` | GET | The caller's PENDING marks: `{marks: [{kind, channel_id, message_id, due_at, state}]}`, soonest first — identifiers and times only, and only in channels the caller can still read. |
| `/users/@me/marks/{kind}/channels/{channel_id}/messages/{message_id}` | PUT | Set, or RE-SET (one mark per kind per message): body `{"due_at": "<ISO 8601 instant>"}` → `{mark}`. `400 validation_failed` for an unknown kind, a missing/malformed/past `due_at`, one more than 365 days ahead, or a thread reply; `409 cap_reached` past 500 pending marks. |
| `/users/@me/marks/{kind}/channels/{channel_id}/messages/{message_id}` | DELETE | Cancel → `204`. |

Every write first proves the caller can READ the message (the uniform channel
gate, which also applies agent restrictions and DM participation); a missing
channel, a missing message and an unreadable one are the same `404
message_not_found`. The stored channel is the message's own. Nothing here is
visible to any other principal — no route takes a user id and no write fans
out. Bots and agents may keep marks of their own through the same routes.

### Message JSON: embeds (optional key)

A message object in native responses (history pages, create/edit echoes, and
the [MessageCreate](./events.md#messagecreate) fan-out) carries an **optional
`embeds` array** — present ONLY when the message stored embeds, absent
otherwise (additive growth: every other field is unchanged). Each entry is
the embed object exactly as it was accepted, decoded from storage:

```json
{
  "id": "89441171033554944",
  "content": "",
  "embeds": [
    {
      "title": "Deploy OK",
      "description": "prod is green",
      "fields": [{ "name": "commit", "value": "abc123" }]
    }
  ],
  "attachments": []
}
```

- Embeds are **store-and-forward**: unknown keys within an embed ride
  untouched; the web renders `title`/`description`/`fields` and treats extra
  keys as inert.
- **External media gains a proxy URL at render** (Discord's names): an
  embed's `image.url` / `thumbnail.url` / `author.icon_url` /
  `footer.icon_url` that is an absolute `http(s)` URL on another host gets a
  sibling `image.proxy_url` / `thumbnail.proxy_url` /
  `author.proxy_icon_url` / `footer.proxy_icon_url` — a signed same-origin
  [media proxy](#media-proxy) path. Our own attachment URLs and
  `attachment://` references get none. A proxy key the producer sent is
  dropped; the stored embed keeps only the producer's URL. Clients load the
  proxy key and keep the source URL for links ("open original").
- Who may send them: **machine authors** (bots, agents, webhooks), on every
  send route — the native `POST /channels/{id}/messages` and
  `POST /threads/{id}/messages` bodies take `embeds` exactly as the
  [compat](./compat.md) create and the webhook execute do (one parser, the
  same caps, embed-only included). A **person's** embeds are a
  `400 embeds_not_allowed` (an empty list is simply no embeds). An embed is a
  card its sender composes — title, description, link, images — and a
  person's message gets cards only from what a link actually is (server-side
  link previews), never from a card a client drew, which could dress any URL
  up as any page. A bot's message is marked as a bot's and its card is its
  own presentation.
- Embeds are immutable after create: `PATCH` edits content only.
- Validation caps (enforced where embeds are accepted): a list of JSON
  objects, at most **10** entries, each at most **8 KB** serialized; a
  violation is a 400 whose native key is `invalid_embeds` (the compat surface
  renders it as `50035 Invalid Form Body`). Embed-only messages (empty
  `content`) are valid.

### Message JSON: `content_proxy_urls` (optional key)

A message whose body holds Markdown images (`![alt](https://…)`) carries an
**optional `content_proxy_urls` object** mapping each external image source,
exactly as written, to its signed same-origin [media proxy](#media-proxy)
URL — present ONLY when there is at least one (at most 20 per message),
absent otherwise. It is minted on every render (history pages, create/edit
echoes, and the MessageCreate / MessageUpdate / ThreadMessageCreate
fan-outs), never stored, and expires like an attachment URL; a refetch
carries fresh ones. A client renders an image node through its entry and
falls back to a plain link when there is none.

```json
{
  "content": "the plan ![whiteboard](https://img.example/wb.png)",
  "content_proxy_urls": {
    "https://img.example/wb.png": "/api/v1/media/proxy?u=aHR0cHM6Ly9pbWcuZXhhbXBsZS93Yi5wbmc&e=1790000000&s=…"
  }
}
```

### Media proxy

`GET /api/v1/media/proxy?u=<base64url source>&e=<unix expiry>&s=<signature>`
serves an external image from this origin (the app's CSP admits no
third-party image host). Only URLs the server itself minted while rendering a
message are served — `s` is an HMAC over `e` and the source URL with a server
secret — so the route is not an open proxy; there is no bearer auth, because
`<img>` cannot carry one (the attachment route's model). `e` is rounded up to
the hour, one attachment-URL lifetime ahead (24 h by default).

| Status | Code | Meaning |
| --- | --- | --- |
| 200 | — | The image. `Content-Type` is the type sniffed from its bytes (PNG, JPEG, GIF, WebP, AVIF), with `X-Content-Type-Options: nosniff`, `Content-Disposition: inline` and `Cache-Control: private, max-age=<signature's remaining life>, immutable`. |
| 403 | `media_url_invalid` / `media_url_expired` | Missing, tampered or stale signature. |
| 404 | `media_not_found` | The proxy is off, or the source is one the server will not fetch (a private or reserved address, a disallowed scheme or port). |
| 415 | `unsupported_media_type` | The source is not an accepted raster image (SVG included), or its canvas is too large. |
| 502 | `media_fetch_failed` | The origin failed: a non-2xx, a timeout, too many redirects, a body over the size cap. |

Clients treat every non-200 the same way: the image hides quietly. Fetched
images are cached (frozen as first fetched until the cache TTL) and failures
are remembered briefly; see docs/self-hosting.md ("Media proxy") for the limits.

### Message JSON: `components` (optional key)

A message object in native responses (history pages, echoes, and the
[MessageCreate](./events.md#messagecreate)/[MessageUpdate](./events.md#messageupdate)
fan-outs) carries an **optional `components` array** — present ONLY when
the message stored action rows (bot-authored sends — on the native routes
as on compat — and interaction responses; a person's native create ignores
the key entirely, so components ⇒ machine author by construction), absent
otherwise (additive growth, same rule as `embeds`):

```json
{
  "id": "89441171033554944",
  "content": "approve this run",
  "components": [
    {
      "type": 1,
      "components": [
        { "type": 2, "style": 1, "label": "Approve", "custom_id": "approve" },
        { "type": 2, "style": 4, "label": "Deny", "custom_id": "deny" }
      ]
    }
  ]
}
```

- Rows are stored **verbatim** (the embeds posture) — the shallow
  validation caps live in
  [events — MessageActionRow](./events.md#messageactionrow); `custom_id`
  is the bot's namespace, never interpreted.
- Components are create-only, from machine authors (the native and compat
  creates, interaction callbacks); the native `PATCH` edits content only — the
  interaction callback type 7 / `@original` PATCH is the single component
  edit path ([compat](./compat.md#interactive-components-buttons--select-menus)).

### Message JSON: `reactions` (optional key)

A message object in native responses (history pages, echoes, and the
[MessageCreate](./events.md#messagecreate)/[MessageUpdate](./events.md#messageupdate)
fan-outs) carries an **optional `reactions` array** — present ONLY when the
message has at least one reaction, absent otherwise (additive growth, same
rule as `embeds`). Each entry is `{"emoji", "count", "me"}`:

```json
{
  "id": "89441171033554944",
  "content": "hello",
  "reactions": [{ "emoji": "👍", "count": 2, "me": true }]
}
```

- `emoji` is the raw Unicode emoji text — Cytale has no custom-emoji system.
- `me` is computed against the REQUESTING principal on REST reads (the
  viewer who reacted sees `me: true`). On gateway fan-out projections the
  flag is `false` — a broadcast has no single recipient; clients reconcile
  `me` from the [MessageReactionAdd](./events.md#messagereactionadd) events
  for their own user id.
- `count` is the per-emoji reaction total (max **20 distinct emojis** per
  message, Discord's cap).

### Message JSON: `author_override` (optional key, webhooks only)

A message object in native responses (history pages, echoes, and the
[MessageCreate](./events.md#messagecreate) fan-out) carries an **optional
`author_override` object** — present ONLY on webhook-executed messages that
supplied a `username` and/or `avatar_url` override, absent otherwise
(additive growth, same rule as `embeds`). `author_id` stays the webhook
PRINCIPAL id — attribution is intact; the override is presentation-only:

```json
{
  "id": "89441171033554944",
  "author_id": "89441170979028992",
  "content": "deploy done",
  "author_override": { "username": "Dep Roy", "avatar_url": "https://cdn.example.com/a.png" }
}
```

### Call state and call log (GET /channels/{id}/call)

The durable call surface for one channel: the standing call-log thread
anchor, the live call (if any), a bounded list of recently ended calls,
and the requester's effective media capabilities. The first three fields
are ALWAYS present — `live` is `null` when no call is active, and both
lists may be empty. This is the boundary source the web client and the
call-log timeline hydrate from; live updates arrive as
[CallStart](./events.md#callstart) / [CallUpdate](./events.md#callupdate) /
[CallEnd](./events.md#callend) dispatches.

```json
{
  "thread_id": "500000000000000009",
  "live": {
    "call_id": "700000000000000001",
    "started_by": "300000000000000001",
    "started_at": "2026-09-06T12:00:00.000Z",
    "participants": [
      { "user_id": "300000000000000001", "mute": false, "deafen": false },
      { "user_id": "300000000000000002", "mute": true, "deafen": false }
    ]
  },
  "recently_ended": [
    {
      "call_id": "700000000000000014",
      "started_by": "300000000000000001",
      "started_at": "2026-09-06T09:00:00.000Z",
      "ended_at": "2026-09-06T09:21:00.000Z",
      "reason": "last_left"
    }
  ],
  "capabilities": { "calls": true, "video": false, "screenshare": true }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `thread_id` | Snowflake \| null | The channel's standing **call-log thread** (created on the channel's first call, reused thereafter — its messages render as the channel's call log). `null` on DM channels: DM calls keep no thread and no `calls` row (no persistent artifact). |
| `live` | object \| null | The live call if one is active, else `null`. Shape: `{call_id, started_by, started_at, participants}` — `participants` is the same roster projection as [CallSync](./events.md#callsync): `{user_id, mute, deafen}` per member, plus the calls-V2 additive `sources?` (published source state, once the server publishing unit emits it — absent on audio-only participants). |
| `recently_ended` | object[] | Bounded, newest-first list of the channel's recently ended calls: `{call_id, started_by, started_at, ended_at, reason}` (`reason` as in [CallEnd](./events.md#callend): `last_left` \| `swept`). Empty for DM channels (no rows exist). |
| `capabilities` | object | The REQUESTER's effective media capabilities for this channel (calls V2 plan U8, R17): `{calls, video, screenshare}` — channel-override-then-master per the [media settings](#workspace-media-settings-getput-workspacesidmedia-settings) resolution. All-true on DM channels (DM calls skip capability checks). Clients gate affordances honestly: a `false` renders the affordance visible-but-disabled with an explanatory dialog (the ratified VM10 pattern — no disappearing UI), never silently hidden. |

Gating: the uniform channel gate — a channel the caller cannot view renders
the identical 404 `channel_not_found` (anti-enumeration); DM channels
authorize by participation. `START_CALL` is NOT required to read (view
access is sufficient); starting a call is gateway
[op 22](./gateway.md#op-22-call-state-update).

### Ice config (GET /calls/ice)

The ICE-config delivery path for call media (voice plan U12). The client
fetches it at call-join time and feeds the entries to its
`RTCPeerConnection` (`iceServers`) BEFORE creating it. Any authenticated
caller may read it — it is principal-scoped, not channel-scoped.

```
GET /api/v1/calls/ice     → 200
{
  "ice_servers": [
    {
      "urls": "turn:chat.example.com:3478",
      "username": "1800003600",
      "credential": "TzQdJjc/Vqz1cSptekQHSXhwv+Q="
    }
  ]
}
```

| Field | Type | Description |
| --- | --- | --- |
| `ice_servers` | object[] | The ICE servers for media. `[]` when the deployment configures no TURN (host/loopback candidates only — the documented no-TURN degradation). |
| entry.`urls` | string | The TURN URL (`turn:host:port`; `turns:` for TLS). |
| entry.`username` | string | Ephemeral credential username — a unix EXPIRY timestamp (eturnal REST-auth, draft-uberti-behave-turn-rest). |
| entry.`credential` | string | Ephemeral credential password — `Base64(HMAC-SHA1(shared secret, username))`, minted ON READ (~1h validity window). |

The STATIC shared secret (the value eturnal also holds) never appears in a
response — only minted pairs do. Because credentials are minted per read,
clients must fetch at join time rather than caching across sessions; expiry
is enforced by the TURN server at allocation time only (an established
relay runs past it). Revocation is secret rotation
([self-hosting guide](../self-hosting.md#voice-calls)).

### Ring notification mute (PATCH /channels/{id}/call-notification-mute)

The per-user-per-channel ring mute (AM6) — the durable setting
[CallRing](./events.md#callring) delivery excludes. Body
`{"muted": true|false}` (required, boolean); the response echoes the
persisted state: `{"muted": true}`.

```
PATCH /api/v1/channels/{channel_id}/call-notification-mute
{"muted": true}          → 200 {"muted": true}
```

Gating: the same uniform channel gate (view access; DM participation) with
the identical 404 anti-enumeration shape; a non-boolean `muted` is a
`400 validation_failed` (the gate already ran — no enumeration surface).
The mute survives server restarts (a Scylla row, not memory), so a
restarting cluster never re-rings muted members.

### Workspace media settings (GET/PUT /workspaces/{id}/media-settings)

The workspace's MASTER media toggles (calls V2 plan U8, R16): calls,
video, and screenshare each enable/disable workspace-wide, plus the
"channels may override" flag. With `overrides_allowed: false` the master
values apply EVERYWHERE (existing override rows stay inert); with it set,
a channel may flip each capability for itself through the
[channel override](#channel-media-override-getput-channelsidmedia-override)
surface. Enforcement sits at the op gates (call start; camera publish;
screen/screen-audio publish) consulting override-then-master — capability
is gate-time, never eviction (a mid-call master flip affects new
starts/publishes, not live calls). Absent row → defaults: everything
enabled, overrides disallowed (explicit opt-in, no migration).

```
GET /api/v1/workspaces/{id}/media-settings     → 200
{
  "media_settings": {
    "calls": true, "video": true, "screenshare": true, "overrides_allowed": false
  }
}

PUT /api/v1/workspaces/{id}/media-settings
{"video": false, "overrides_allowed": true}     → 200 (merged echo, same shape)
```

| Field | Type | Description |
| --- | --- | --- |
| `media_settings.calls` | boolean | Master switch for the calls capability (call start gate). |
| `media_settings.video` | boolean | Master switch for camera publishing. |
| `media_settings.screenshare` | boolean | Master switch for screen + screen-audio publishing. |
| `media_settings.overrides_allowed` | boolean | When `false` (the default), the master applies everywhere and channel override PUTs answer `409 overrides_not_allowed`. |

PUT body keys are optional booleans; absent keys keep their current
values, non-boolean values are `400 validation_failed`. Gating: the
owner/admin tier (`manage_workspace` — the owner holds it implicitly),
exactly `PATCH /workspaces/{id}`'s pipeline: a member without the bit →
`403 forbidden`; unknown workspace → `404 workspace_not_found`.

### Channel media override (GET/PUT /channels/{id}/media-override)

The per-channel tri-state override (R16): each capability is an explicit
`true`/`false` or `null` = inherit the workspace master. One read returns
the override row, the master settings, and the `overrides_allowed` flag
(the channel manager's visibility rule for the override affordances).

```
GET /api/v1/channels/{id}/media-override       → 200
{
  "override": { "calls": null, "video": false, "screenshare": null },
  "overrides_allowed": true,
  "master": { "calls": true, "video": true, "screenshare": true, "overrides_allowed": true }
}

PUT /api/v1/channels/{id}/media-override
{"video": null}                                 → 200 (full view echo, same shape as GET)
```

| Field | Type | Description |
| --- | --- | --- |
| `override.{calls,video,screenshare}` | boolean \| null | The channel's explicit value for that capability; `null` inherits the master. Absent row → all `null`. |
| `overrides_allowed` | boolean | The workspace master flag (convenience copy — the menu's visibility rule). |
| `master` | object | The full [workspace media settings](#workspace-media-settings-getput-workspacesidmedia-settings) shape. |

PUT body keys are optional tri-states: a boolean writes the explicit
value, `null` RESETS that capability to inherit; absent keys keep their
current values; non-tri-state values are `400 validation_failed`. The
PUT/GET echo the full view (override + flag + master) so clients update
one store.

Gating: `manage_channels` through the UNIFORM channel gate — a foreign
channel (or a DM id; DM channels carry no override surface because DM
calls skip capability checks) renders the identical `404
channel_not_found` anti-enumeration shape, never a 403 oracle; a member
who can view but lacks the bit gets the real `403 forbidden`; a PUT
against a workspace with `overrides_allowed: false` is the `409
overrides_not_allowed` STATE conflict (the actor is properly
permissioned; the workspace posture is what blocks).

## Webhooks

Discord-compatible **incoming** webhooks (U11): channel-scoped capability
URLs. Execution lives on the unauthenticated
[compat surface](./compat.md#webhook-execution) under `/api/webhooks/{id}/{token}`;
the routes below are the native management surface (Bearer-authenticated,
email-verified, gated `manage_channels` on the channel in the path). The URL
token is **re-viewable** by managers (Discord parity) — unlike bot/agent
credentials, list responses carry the full capability URL.

| Endpoint | Method | Response |
| --- | --- | --- |
| `/channels/{id}/webhooks` | POST | `201 {"id": "<snowflake>", "url": "http(s)://<host>/api/webhooks/{id}/{token}"}` — body `{"name"}`. Unknown channel → 404 `channel_not_found`; member without the permission → 403; machine principals → 403 (only humans mint); a channel already holding **50 webhooks** → 400 `webhook_cap` (the per-channel budget). |
| `/channels/{id}/webhooks` | GET | `200 {"webhooks": [{"id", "name", "channel_id", "url"}]}` — token re-viewable via `url`. |
| `/channels/{id}/webhooks/{webhook_id}` | PATCH | `200 {"webhook": {...}}` — body `{"name"}` (display-label rename, metadata only). |
| `/channels/{id}/webhooks/{webhook_id}` | DELETE | `204` — capability rows die; execute returns the compat `404 10015` from then on. Provenance survives for attribution. |

Lifecycle notes:

- **Execute validity = the webhook row + the channel existing** (KD8): the
  creating admin leaving the workspace does NOT kill the webhook — capability
  URLs are exempt from the parent-rights intersection at execute.
- **Channel deletion cascades**: deleting a channel deletes its webhooks
  (`webhooks_by_channel` index); execute 404s afterwards.
- A webhook principal holds NO gateway credential — the URL token is its only
  capability (the mint-time `cytbot_` token is revoked at creation).

## Threads

| Endpoint | Method | Description |
| --- | --- | --- |
| `/channels/{id}/threads` | GET | Channel thread roster. Archived threads are excluded; `?include_archived=true` includes them. Rows carry `message_count` + `latest_reply_at` (the seed-message indicator's summary). |
| `/threads/{id}` | PATCH | Archive (`{archived: bool}` — the only thread mutation served; rename is not, so a body without `archived` is `400`). The thread's creator or a parent-channel moderator (`manage_messages`/`manage_threads`), else `403`. Emits [ThreadUpdate](./events.md#threadupdate). Archiving is roster-hiding, not an access change: the thread leaves the default listing and stays directly readable. |
| `/threads/{id}/messages` | GET / POST | Thread history — same cursors and envelope as channel history, read from the thread's own index, so pages are dense and a page shorter than `limit` means nothing further that way — / reply (also emits channel [MessageCreate](./events.md#messagecreate) with `thread_id` set + [ThreadMessageCreate](./events.md#threadmessagecreate)). |
| `/threads/{id}/members` | GET / POST / DELETE | Follow state: list / join / leave. |
| `/threads/{id}/members/@me` | PATCH | Update own follow state (`notify` flag, `last_read_id`). |

## Roles and permissions

| Endpoint | Method | Description |
| --- | --- | --- |
| `/workspaces/{id}/roles` | GET / POST | List / create roles (permission bitfield as decimal string). |
| `/workspaces/{id}/roles/{role_id}` | GET / PATCH / DELETE | Read / update / delete a role. |
| `/workspaces/{id}/roles/{role_id}/members/{user_id}` | PUT / DELETE | Grant / revoke a role on a member. |
| `/channels/{id}/overwrites` | GET / PUT / DELETE | Channel permission overwrites (target: role or member; allow/deny bitfields). |

## Search and directory

| Endpoint | Method | Description |
| --- | --- | --- |
| `/workspaces/{id}/search` | GET | Keyword message search with `from:` / `in:` / date-range filters; near-instant freshness (~1s). |
| `/dm/search` | GET | Search across the requesting user's DMs. |
| `/users/@me/omnisearch` | GET | Cmd-K omnisearch: one query over the caller's REACHABLE messages — workspace hits through the visible-channel gate, DM hits from the caller's own per-user index. **[Details](#omnisearch-cmd-k).** |
| `/workspaces/{id}/people` | GET | Member directory lookup by name/handle (sub-identities synthesized beside their parent — see [roster synthesis](#roster-synthesis-sub-identities-in-memberspeople-reads)). `?ids=<id>,<id>,…` (at most 100) is the lookup form: the same rows for exactly those ids (a member, or a machine principal granted the workspace), every other id left out, `next_before: null`; more than 100 ids is a 400 `validation_failed`. Clients use it to name authors beyond the first people page. |

### Omnisearch (Cmd-K)

`GET /api/v1/users/@me/omnisearch?q=` — self-scoped (plain authenticated
route). Workspace hits re-use the per-workspace `visible_channels` gate; DM
hits come from the caller's own per-user Tantivy index
(`priv/search/_dmu/{user_id}/`) — every DM message is indexed to BOTH
participants' indexes at the message-write seam, so participation IS the
authorization by partition, and a first query runs a bounded idempotent
backfill over the watermark (existing conversations become searchable without
an operator task). Rows are HYDRATED (a palette of bare ids is unusable):

```json
{ "results": [ {
    "kind": "workspace" | "dm",
    "message_id": "…", "channel_id": "…", "thread_id": "…" | null,
    "workspace_id": "…" | null, "author_id": "…",
    "content": "…(≤240 chars)…", "created_at": "…", "score": 3.5 | null } ],
  "total": null }
```

Workspace hits order by score, DM hits by recency, capped (30 + 20). A query
under 2 characters (after trim) answers `{"results": [], "total": 0}` without
touching either segment. An index hit whose message row is gone (delete drift)
is dropped at hydration. The old `/dm/search` stub still answers its stable
501.

## DMs

| Endpoint | Method | Description |
| --- | --- | --- |
| `/users/@me/channels` | GET | List the requesting user's DM channels (the `dms_of_user` index, bots plan B-1 — machine principals list their OWN DMs). |
| `/users/{user_id}/channels` | POST | Open (or fetch) a DM channel with a user. |
| `/channels/{id}/messages` | — | DMs are channels: message endpoints above apply. |

Bots plan B-1 makes the paths principal-aware: a machine principal may
open and list its own DMs. Kind guard (Discord parity): only
human ↔ human and human ↔ machine pairs — machine ↔ machine is a `400`
(Discord disallows bot-to-bot DMs) and webhooks are not DM-able. A
participant's message reads/writes on a DM channel id authorize by
PARTICIPATION (the permission plug resolves DM channels through recipient
membership — the full bitfield; a non-participant gets the anti-enumeration
`404 channel_not_found`). DM events fan out to both participants' live
sessions (the ordinary CamelCase dispatches).

## Interactions (application commands)

Workspace-scoped application commands (bots plan U8): the composer lists a
workspace's commands, and invoking one is this single native endpoint —
`POST /api/v1/interactions`. Registration itself is the bot's, over the
[compat applications routes](./compat.md#application-commands-registration-u8).

| Endpoint | Method | Description |
| --- | --- | --- |
| `/workspaces/{id}/commands` | GET | The workspace's registered commands (all applications) for the command palette: `[{id, application_id, name, description, options?}]`. Any member (view rights via the principal-rights resolver); non-members 403. |
| `/interactions` | POST | **Two body variants, one pipeline** (the `Idempotency-Key` plug is honored on both; the `InteractionCreate` gateway event is fanned to the OWNING bot's sessions EMIT-BEFORE-ACK, then 202 with `{interaction_id}`): **command invoke** `{command_id, channel_id, options?}` (ids as snowflake strings, `options` a flat JSON map) — the caller's send right is checked on the target channel; **component click** (components plan U2) `{channel_id, message_id, custom_id, component_type, values?}` — a HUMAN clicking a button (`component_type: 2`) or string-select option (`component_type: 3` with `values`, each ≤100 chars, ⊆ the component's stored options). The click is verified against the message's CURRENT stored components (forged/stale/disabled `custom_id`, out-of-profile values, or a component-less message → 400 `component_unavailable`, never a mint); the owning bot is the message's author principal (a revoked/deleted bot → **410 `component_unavailable`**, the distinct dead-button error); the clicker must hold the send right in the channel (DM clicks authorize by participation); machine principals cannot click (403). |

Invocation/click errors: `channel_not_found` / `command_not_found` /
`message_not_found` (404; a DM the clicker does not participate in renders
`channel_not_found` — no oracle), `forbidden` (403 — no membership, no
send right on the channel, or a machine principal clicking),
`component_unavailable` (400 forged/stale/disabled/out-of-values clicks;
**410** when the owning bot is revoked or deleted — dead buttons, no
retry), `validation_failed` (400 — missing fields, a non-snowflake id, an
unknown `component_type`, invalid `values`, or a malformed `nonce`).

Every variant (command, click, modal submit) takes an optional `nonce`, a
string of 1–64 characters the client picks. When the bot answers, the
invoker's sessions get [InteractionSuccess](./events.md#interactionsuccess)
carrying it — the client's exact "answered" signal, which can arrive before
this POST's 202.

A component click mints a 15-minute interaction token and delivers the
type-3 `InteractionCreate` to the owning bot's session — payload shape in
[events](./events.md#interactioncreate); the bot's response surface
(callbacks 4/5/6/7 + the webhook-shaped continuation routes) is the
[compat contract](./compat.md#interactive-components-buttons--select-menus).

The bot's response arrives through the compat callback
(`POST /api/v10/interactions/{id}/{token}/callback`, see
[compat](./compat.md#interaction-callback-u8)) and lands as an ordinary
message authored by the bot principal. The type-4 response is the
SINGLE-USE ack (first one posts and consumes it; a replay is the compat
`400 10063 Unknown interaction`), followups post through the same
callback route without consuming the ack, and the pair is rate-bucketed
(**10 posts / 15 min**, the token's lifetime) — past the ceiling the
callback answers the shared Discord 429 instead of posting.

### Interaction callbacks 5/6/7 and continuation routes (components plan U3)

Beside type 4 the callback accepts the remaining component-flow types; all
four typed responses consume the single-use ack (any later one is the same
`400 10063`):

- **type 5 / type 6 (deferred)** — consume the ack and post/edit nothing;
  their delivery is the webhook-shaped continuation routes below.
- **type 7 (UPDATE_MESSAGE)** — edits the CLICKED message, target-sourced
  exclusively from the token (body-supplied ids are ignored), author-pinned
  (`message.author_id == application_id`, else compat `404 10008`), gated on
  the bot's CURRENT send right / DM participation (a bot restricted out of
  the channel after posting gets compat `403 50001` — buttons die with
  rights). `data` carries any of `content` (validated as every edit
  surface), `components` (wholesale replace, R1 caps), `embeds` (wholesale
  replace) — at least one; the edit bumps `edited_at` and fans
  **MessageUpdate carrying `components`** to every live viewer. Concurrent
  type-7 updates are last-write-wins per operation (documented divergence —
  Discord does not serialize either; bots disable buttons in the first
  UPDATE). Type-4 responses and followups accept `data.components` the same
  way (stored + rendered — the fresh-card reply).

The continuation routes (what discord.js `deferReply`/`deferUpdate` →
`editReply`/`followUp` call) live under BOTH compat prefixes (`/api/v10`
and `/api`), with no auth pipeline — the URL token is the credential:

| Endpoint | Method | Description |
| --- | --- | --- |
| `/webhooks/{application_id}/{token}` | POST | Followup create as the bot in the token's channel: `{content, components?}` (content required, 1–4000 bytes). 200 with the full Discord message object. After a type 5 this POST **is** the deferred reply; under the bare `/api` prefix this route sits in front of webhook execute and falls through to it for non-interaction tokens. |
| `/webhooks/{application_id}/{token}/messages/@original` | GET | The pinned original: the click's message for update flows (type 6/7), the first posted response for reply flows. 404 `10008` before a reply flow has posted. |
| `/webhooks/{application_id}/{token}/messages/@original` | PATCH | Edit the pinned original: `{content?, components?, embeds?}` (at least one). Completes a deferred update; after a type 5 it materializes the deferred reply (deferReply → editReply). 200 with the message object; fans MessageUpdate. |
| `/webhooks/{application_id}/{token}/messages/@original` | DELETE | Delete the pinned original (author-pinned + current rights). 204. |

Wrong/expired token or a mismatched application id renders the callback's
undifferentiated `401`. Every message-creating callback leg (type 4,
followups, webhook-route POSTs) and the `@original` write legs share the
**per-application interaction-post bucket (10 / 5s)**; type-7 flips ride
the click budget instead (single-use ack, 1:1 with clicks).

## Attachments and push

The native flow is **two-step**: upload the file to
`POST /channels/{id}/attachments` (multipart, 25 MB cap, fixed mime
allowlist), then include the returned
`{url, filename, content_type, size, width?, height?}` descriptor in the
message create's `attachments` array (image uploads carry sniffed
`width`/`height` — PNG/GIF/JPEG header parsing at store time, C-3; the
keys are omitted when unknown). The message's `attachments` echo those
descriptors back on every read and on the gateway `MessageCreate`, with
`size`, `width` and `height` as JSON **integers** — a client can reserve an
image's aspect-ratio box before the bytes load. Serving:
`GET /api/v1/attachments/{hash}` renders the blob with its stored
content-type — `content-disposition: inline` for image types (direct-open
and `<img>` friendly), `attachment` otherwise. The Discord-compat message
create and webhook execute surfaces additionally accept the one-step
multipart model (`files[n]` + `payload_json`) directly — see
[compat](./compat.md#file-uploads-multipart-filesn--payload_json).

| Endpoint | Method | Description |
| --- | --- | --- |
| `/channels/{id}/attachments` | POST | Upload an attachment; returns the metadata to attach to a message. |
| `/attachments/{hash}` | GET | Serve the stored blob (content-addressed; content-type + disposition from the stored metadata). |
| `/users/@me/push-subscriptions` | POST / DELETE | Register / remove a web-push subscription (endpoint/keys blob). |

## Admin tier (`/api/v1/admin/...`)

Operator/owner surface, gated by ADMINISTRATOR-class permissions:

| Endpoint | Method | Description |
| --- | --- | --- |
| `/admin/workspaces/{id}/audit` | GET | Audit-style reads: workspace buckets, index health. |
| `/admin/workspaces/{id}/deletion-cascade/{user_id}` | GET | Account-deletion cascade status for a user. |
| `/admin/invites` | GET | Cross-workspace invite governance. |
| `/admin/client-errors` | GET | The last N client-error reports, grouped by fingerprint. |

## Client errors (`/api/v1/client-errors`)

The sink behind the clients' crash reporting. A user hitting a JavaScript
exception, a failed API call or a dead socket had no path to the maintainer
before this; web, the desktop shell and mobile now report through one shared
seam.

| Endpoint | Method | Description |
| --- | --- | --- |
| `/client-errors` | POST | Store one report. **Unauthenticated** — see below. |

`POST /client-errors` body (all fields optional except `message`,
`fingerprint`, `client` and `source`):

```json
{
  "client": "web",
  "source": "api.request",
  "fingerprint": "3f2a1b8e",
  "message": "Request failed with status 500",
  "stack": "…",
  "route": "/api/v1/channels/:id/messages",
  "version": "va08ce92",
  "status": 500,
  "request_id": "GEBMr97eLMHtGWsAAAVj",
  "detail": "POST internal_error"
}
```

* `client` is `web | desktop | mobile`; `source` is one of `window.onerror`,
  `unhandledrejection`, `error-boundary`, `api.request`, `gateway.telemetry`.
  Anything else is a `validation_failed` 400.
* **UNAUTHENTICATED by design.** The most valuable crash to capture happens on
  the login page, before anyone has a token. A valid `Authorization` header is
  still *resolved* when present, and the report is then attributed to its
  account; otherwise it is stored **anonymous** (`account_id` null). A stale or
  malformed credential is NOT a 401 here — it stores the report anonymously.
* Answered `204 No Content`. A storage failure is logged and still answered
  `204`: an error-reporting route that fails loudly on its own storage problem
  turns a diagnosis gap into a second incident.
* Rate-limited **tightly per IP** (10 requests / 60s) — a low-volume,
  best-effort sink. Exceeding it is a 429 and the report is dropped; clients
  never retry.
* **The `request_id` is the server's own `x-request-id`** (`Plug.RequestId`),
  returned as a response header on every Phoenix response. The client records
  it off a FAILED call and sends it back with the report, so a client-side
  failure can be traced INTO the server logs by grepping for that string
  instead of being a dead end. For the cross-origin desktop shell,
  `X-Request-Id` is on the CORS `Access-Control-Expose-Headers` list — a header
  that is set but not exposed is invisible to JS.

### Privacy (binding on clients and this sink alike)

* **No message content is ever captured.** The report schema has no field for a
  request body, a response body, headers, cookies or a token, and the stored
  row has no column for them either. A failed POST's body is the tempting thing
  to attach and the one thing that would turn an error log into a content
  store.
* **Identifiers are redacted out of every captured string** before it leaves
  the client: snowflakes and UUIDs become `:id`, emails `:email`, query-string
  values `[redacted]`. A report's `route` is therefore a shape, not a map of a
  private workspace.
* Messages and stacks are truncated (500 / 4000 chars client-side, with
  server-side backstops).
* **Retention is 30 days**, enforced by the ScyllaDB row TTL on
  `client_errors` (`apps/server/priv/scylla_schema.cql`). There is no dashboard,
  no grouping engine and no alerting: `GET /api/v1/admin/client-errors` is the
  whole read surface, and a client report is a diagnosis aid, not analytics.

## Errors

Machine-readable error `key`s follow the resource-verb pattern:
`unauthorized`, `forbidden`, `account_unverified` (view-only until email
verification), `not_found`
(scoped per resource, e.g. `channel_not_found`, `bot_not_found`,
`bot_not_found`, `webhook_not_found`), `validation_failed` (with
per-field details),
`invalid_restrictions`, `invalid_embeds` / `invalid_components` (over the
send caps), `embeds_not_allowed` (a person's send carried embeds),
`invalid_access` (the document is malformed or
internally inconsistent, e.g. `mode: "all"` with no level), `rate_limited`,
`idempotency_conflict` (same key,
different body — for a message send, a different message). Endpoint-level keys are finalized as U9 implements each
surface; unknown keys must be treated as generic errors by clients.
