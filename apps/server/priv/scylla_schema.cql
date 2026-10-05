-- Cytale ScyllaDB schema (U6) — the complete launch surface, denormalized,
-- partition-key-first, no joins (R5/R6 discipline).
--
-- Conventions:
--   * Every entity id is a Snowflake (U5) stored as `bigint` — chronological
--     clustering for free; wire serialization is a decimal string handled at
--     the JSON boundary, never here.
--   * Every table names its access pattern in its partition key. Reads are
--     partition-keyed point queries or bounded range scans; there are no
--     secondary-index hops and no ALLOW FILTERING anywhere.
--   * Times are `timestamp` (millis). TTLs are declared per-statement by the
--     writers (refresh/verification tokens), not here — USING TTL is a write
--     property, not a schema property.
--
-- Applied by `Cytale.Migrations` (idempotent: CREATE KEYSPACE/IF NOT EXISTS).
-- `{{keyspace}}` is substituted with the configured keyspace at apply time
-- (dev/prod: `cytale`; test: `cytale_test`).

CREATE KEYSPACE IF NOT EXISTS {{keyspace}}
  WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}
  AND durable_writes = true;

-- ---------------------------------------------------------------------------
-- Messages (R5) — the core table. Partition: (channel_id, bucket) where bucket
-- = floor(created_at_ms / 7 days) keeps any single partition bounded; the
-- Snowflake message_id as DESC clustering key yields newest-first history with
-- no ORDER BY.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS {{keyspace}}.messages (
    channel_id  bigint,
    bucket      int,
    message_id  bigint,
    author_id   bigint,
    content     text,
    -- null = channel-level message
    thread_id   bigint,
    -- Discord-style reply reference: message_id of the message being
    -- replied to (inline reply, distinct from threads)
    reply_to_id bigint,
    created_at  timestamp,
    edited_at   timestamp,
    -- [{id, url, filename, content_type, size}]
    attachments list<frozen<map<text, text>>>,
    PRIMARY KEY ((channel_id, bucket), message_id)
) WITH CLUSTERING ORDER BY (message_id DESC)
  AND compaction = {'class': 'TimeWindowCompactionStrategy',
                    'compaction_window_unit': 'DAYS',
                    'compaction_window_size': 7};

-- Locator rows written at persist time (author_id, message_id) -> channel_id,
-- bucket. Powers the account-deletion sweep (U14) without scanning unknown
-- partitions.
CREATE TABLE IF NOT EXISTS {{keyspace}}.author_messages (
    author_id   bigint,
    message_id  bigint,
    channel_id  bigint,
    bucket      int,
    PRIMARY KEY (author_id, message_id)
) WITH CLUSTERING ORDER BY (message_id DESC)
  AND compaction = {'class': 'TimeWindowCompactionStrategy',
                    'compaction_window_unit': 'DAYS',
                    'compaction_window_size': 7};

-- Thread reply locator (#152): (thread_id, message_id) -> channel_id, bucket.
-- A thread's replies live in their PARENT channel's timeline partitions, so a
-- thread read used to walk the whole channel and filter in memory — sparse
-- pages on a busy channel, cost growing with channel traffic, no real cursor.
-- This partition is the thread's own index: a page is one bounded read here
-- plus one hydration read per (channel, bucket) group. Written in the reply's
-- persist batch; backfilled once for pre-existing replies at boot
-- (Cytale.Migrations, `thread_messages_backfill` marker). A row whose message
-- is gone hydrates to nothing, so a missed delete never shows a ghost.
CREATE TABLE IF NOT EXISTS {{keyspace}}.thread_messages (
    thread_id   bigint,
    message_id  bigint,
    channel_id  bigint,
    bucket      int,
    PRIMARY KEY (thread_id, message_id)
) WITH CLUSTERING ORDER BY (message_id DESC)
  AND compaction = {'class': 'TimeWindowCompactionStrategy',
                    'compaction_window_unit': 'DAYS',
                    'compaction_window_size': 7};

-- Durable send dedupe: (author_id, nonce) -> the message id the FIRST attempt
-- reserved. The client mints one nonce per composed message and reuses it on
-- every retry; the create path claims the row with `INSERT ... IF NOT EXISTS
-- USING TTL 86400` BEFORE the message write, so a retry — after a timeout, a
-- 5xx that raced a landed write, a dropped connection, or a server restart
-- that wiped the in-memory Idempotency-Key table — finds the reservation and
-- answers with the stored message instead of writing a duplicate. The TTL
-- bounds the table to one day of sends; a nonce is only ever a retry key.
CREATE TABLE IF NOT EXISTS {{keyspace}}.message_nonces (
    author_id   bigint,
    nonce       text,
    channel_id  bigint,
    message_id  bigint,
    PRIMARY KEY ((author_id, nonce))
);

-- Account-deletion sweeps not yet finished (review #24). `delete_account/2`
-- writes the row BEFORE it starts the async sweep and the sweep deletes it
-- when every step has run; a node that crashed or restarted mid-sweep finds
-- the row at boot and runs the (idempotent) sweep again. A handful of rows at
-- most — read whole at boot.
CREATE TABLE IF NOT EXISTS {{keyspace}}.pending_account_sweeps (
    user_id       bigint,
    requested_at  timestamp,
    PRIMARY KEY (user_id)
);

-- Snowflake high-water lease (review #24): per worker id, a wall-clock ms
-- AHEAD of every id the running node has issued (refreshed each second). The
-- next boot raises the generator's floor to it, so ids stay monotonic across
-- a restart whose clock stepped back — a repeated message id would silently
-- overwrite the stored message.
CREATE TABLE IF NOT EXISTS {{keyspace}}.snowflake_clock (
    worker_id      int,
    high_water_ms  bigint,
    PRIMARY KEY (worker_id)
);

-- Embed side table (bots plan U10, KTD11): embeds are STORED, not stripped —
-- GitHub/Sentry webhook targets post embed-only, and stripping would render
-- them as empty messages. One row per embed, ordered by `idx`; `embed` is the
-- JSON object verbatim (store-and-forward: unknown keys within an embed ride
-- untouched — the web renders title/description/fields and treats extras as
-- inert). Written on CREATE only: edits PATCH content, embeds are immutable
-- after create (documented in docs/protocol/compat.md). Message delete
-- cascades the rows here (the messages row carries attachments inline, so it
-- is the only side-write delete needs; author_messages locator rows are
-- deliberately left to the U14 sweep).
CREATE TABLE IF NOT EXISTS {{keyspace}}.message_embeds (
    message_id bigint,
    idx        int,
    embed      text,
    PRIMARY KEY ((message_id), idx)
) WITH CLUSTERING ORDER BY (idx ASC);

-- Component side table (components plan U1, KTD1): action rows (buttons and
-- string selects) are STORED, not stripped — the embeds twin. One row per
-- top-level component (the action row), ordered by `idx`; `component` is the
-- row object's JSON verbatim (platform-opaque: `custom_id` is the bot's
-- namespace, never interpreted — unknown keys ride untouched). Written on
-- CREATE only via the Bot-auth surfaces (compat create; interaction
-- callbacks replace wholesale in U3); the native human create ignores
-- components entirely, so "components ⇒ machine author" holds by
-- construction. Message delete cascades the rows here like message_embeds.
CREATE TABLE IF NOT EXISTS {{keyspace}}.message_components (
    message_id bigint,
    idx        int,
    component  text,
    PRIMARY KEY ((message_id), idx)
) WITH CLUSTERING ORDER BY (idx ASC);

-- ---------------------------------------------------------------------------
-- Reactions (Unicode emoji, Discord-shaped): existence rows + a real COUNTER
-- for the per-emoji tally.
--
-- The tally is a `counter` column (hardening plan 4.3): `UPDATE ... SET count =
-- count + ?` is applied server-side, so concurrent adds of one emoji cannot
-- lose an update the way the previous application-managed mirror did (it read
-- the count, wrote `n + 1`, and two concurrent adds both wrote `n + 1` — drift
-- that never self-heals). A counter may not share a table with regular
-- columns, which is why this table carries nothing but its primary key and the
-- tally; `threads.message_count` and `invites.use_count` cannot become
-- counters for the same reason and move by LWT instead.
--
-- COUNT READS FILTER `count > 0`: a counter row cannot be created with a zero
-- value, and removing the last reaction writes `-1` down to 0 rather than
-- deleting the row (a delete racing a concurrent `+1` loses the whole tally, and
-- worse — probed against ScyllaDB 2026.2 — a counter DELETE leaves a tombstone
-- that DISCARDS increments written after it, so a cleared message could never
-- count a reaction again). So a zero row may linger, and "no reactions for this
-- emoji" is `count = 0`, not row absence. Reads bounded by the emoji set still
-- never scan. The ONE place a counter delete is safe is the message-delete
-- cascade, whose Snowflake message id can never be reused.
--
-- `emoji` is the RAW Unicode emoji text (e.g. 👍) as a text clustering key —
-- Cytale has no custom-emoji system, so a Discord emoji object's `id` is
-- always null on the compat wire. Partition mirrors the messages table
-- ((channel_id, bucket, message_id)); a message's reactions die with it
-- (partition DELETE on the message-delete cascade).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS {{keyspace}}.reactions_by_message (
    channel_id  bigint,
    bucket      int,
    message_id  bigint,
    emoji       text,
    user_id     bigint,
    PRIMARY KEY ((channel_id, bucket, message_id), emoji, user_id)
) WITH CLUSTERING ORDER BY (emoji ASC, user_id ASC);

CREATE TABLE IF NOT EXISTS {{keyspace}}.reaction_counts (
    channel_id  bigint,
    bucket      int,
    message_id  bigint,
    emoji       text,
    count       counter,
    PRIMARY KEY ((channel_id, bucket, message_id), emoji)
) WITH CLUSTERING ORDER BY (emoji ASC);

-- ---------------------------------------------------------------------------
-- Threads (R2) — thread metadata keyed by parent channel.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS {{keyspace}}.threads (
    channel_id        bigint,
    thread_id         bigint,
    parent_message_id bigint,
    name              text,
    created_by        bigint,
    archived          boolean,
    member_count      int,
    message_count     bigint,
    -- null until the first reply lands
    latest_reply_id   bigint,
    latest_reply_at   timestamp,
    created_at        timestamp,
    PRIMARY KEY ((channel_id), thread_id)
) WITH CLUSTERING ORDER BY (thread_id DESC);

CREATE TABLE IF NOT EXISTS {{keyspace}}.thread_members (
    thread_id    bigint,
    user_id      bigint,
    joined_at    timestamp,
    -- true = follow, false = muted
    notify       boolean,
    last_read_id bigint,
    PRIMARY KEY ((thread_id), user_id)
) WITH CLUSTERING ORDER BY (user_id ASC);

-- Thread-id lookup row (U12): the fan-out path resolves thread → channel
-- without scanning; also carries the denormalized metadata for sidebar reads.
CREATE TABLE IF NOT EXISTS {{keyspace}}.threads_by_id (
    thread_id        bigint,
    channel_id       bigint,
    parent_message_id bigint,
    name             text,
    created_by       bigint,
    archived         boolean,
    member_count     int,
    message_count    bigint,
    latest_reply_id  bigint,
    latest_reply_at  timestamp,
    created_at       timestamp,
    PRIMARY KEY ((thread_id))
);

-- Per-user thread membership index (U12): powers THREAD_LIST_SYNC (all
-- followed threads for a user across workspaces) without scanning the
-- thread_id-partitioned thread_members table.
CREATE TABLE IF NOT EXISTS {{keyspace}}.thread_members_by_user (
    user_id    bigint,
    thread_id  bigint,
    joined_at  timestamp,
    notify     boolean,
    last_read_id bigint,
    PRIMARY KEY ((user_id), thread_id)
) WITH CLUSTERING ORDER BY (thread_id DESC);

-- ---------------------------------------------------------------------------
-- Read state (R7 unread tiers) — per user per channel/thread.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS {{keyspace}}.read_state (
    user_id       bigint,
    channel_id    bigint,
    -- null = nothing read. INCLUSIVE: this message and everything before it
    -- is read.
    last_read_id  bigint,
    -- null = no explicit unread range. EXCLUSIVE: this message and everything
    -- after it is unread. The watermark alone cannot express "mark this
    -- message unread" — moving it TO the message would leave it read — so the
    -- floor carries the other direction. Written only by the mark-unread
    -- path; an acknowledgement that does not name it must not clear it.
    unread_floor  bigint,
    -- application-managed (counters can't mix with regular columns)
    mention_count bigint,
    -- application-managed mirror of the client tier (U17)
    unread_count  bigint,
    PRIMARY KEY ((user_id), channel_id)
);

-- ---------------------------------------------------------------------------
-- Mention inbox (#117) — the durable "where was I needed" backlog.
--
-- Deliberately its own table rather than another column on read_state: a
-- mention is an EVENT (one row per message that addressed the member), while
-- read_state is a POSITION (one row per channel/thread). Folding events into
-- positions is exactly the second tracker product-invariant #2 forbids — this
-- table carries no unread count, and nothing here is consulted to decide
-- whether a message is read. `read_state.last_read_id` remains the one
-- watermark; a channel's badge, its divider, and this backlog can never
-- disagree about what "read" means, because only the watermark answers that.
--
-- Partition: the MENTIONED member (the read_state discipline — the whole
-- backlog in one partition read, never a fan of per-channel queries), so a
-- row is only ever readable by the member it is about. Clustering: the
-- message id DESCENDING, which is the read order (newest mention first) and
-- makes the backlog read a bounded `LIMIT` with no client-side sort.
--
-- Lifecycle (what keeps the partition from growing without bound):
--   * an acknowledgement that covers the row DELETES it (`Cytale.Inbox.mark_done_through/3`
--     from the ack paths) — reading the channel is what answers a mention;
--   * the member's own per-item "done" / bulk sweep DELETE it;
--   * nothing else ever writes here, so the partition holds the OPEN backlog
--     plus whatever a member has genuinely not looked at.
--
-- `excerpt` is the addressed text as it stood when the mention was recorded
-- (capped). Storing it is what keeps this read ONE partition query — the
-- alternative is a message point-read per row — and it means a deleted
-- message still renders honestly instead of vanishing mid-backlog. An EDIT
-- therefore does not rewrite the quote: the row records the event, and the
-- live message is still one permalink away.
--
-- `kind` is the closed set `'mention'` today (a direct `<@id>`/`<@!id>`
-- token — the same tokenizer the notification policy uses). Broadcasts
-- (`@everyone`/`@here`) are their own preference class, and "reply to me" /
-- "thread I follow" are named as LATER work on #117: the column exists so
-- those become new values rather than a migration, and nothing here groups
-- or counts by it yet.
--
-- Rows carry a 90-day TTL (hardening PERF-9, `Inbox`'s INSERT): a mention is
-- an actionable event, not a permanent record, so the partition stays
-- proportional to the OPEN backlog even for mentions the member never
-- answers.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS {{keyspace}}.mention_events (
    user_id    bigint,
    message_id bigint,
    channel_id bigint,
    -- null = the mention is a channel-timeline message. Non-null = it lives in
    -- a thread; channel_id still carries the PARENT channel, so one ack
    -- vocabulary serves both (the client acks a thread with the thread's id).
    thread_id  bigint,
    author_id  bigint,
    kind       text,
    excerpt    text,
    created_at timestamp,
    PRIMARY KEY ((user_id), message_id)
) WITH CLUSTERING ORDER BY (message_id DESC);

-- ---------------------------------------------------------------------------
-- Roles + channel permission overwrites (R6).
-- permissions/allow/deny are bitfields stored as bigint (U7 defines the bits).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS {{keyspace}}.roles (
    workspace_id bigint,
    role_id      bigint,
    name         text,
    permissions  bigint,
    position     int,
    -- null = default color
    color        int,
    PRIMARY KEY ((workspace_id), role_id)
) WITH CLUSTERING ORDER BY (role_id ASC);

-- target_type: 0 = role overwrite, 1 = member overwrite (U7 evaluation order).
-- "allow"/"deny" are CQL reserved words — kept as quoted identifiers to match
-- the plan's column naming; queries must quote them too.
CREATE TABLE IF NOT EXISTS {{keyspace}}.channel_overwrites (
    channel_id  bigint,
    target_id   bigint,
    target_type int,
    "allow"     bigint,
    "deny"      bigint,
    PRIMARY KEY ((channel_id), target_id)
) WITH CLUSTERING ORDER BY (target_id ASC);

-- ---------------------------------------------------------------------------
-- Users + auth token surfaces (R4, U8). Password hashes are argon2 (non-null
-- post-pivot); refresh tokens store only SHA-256 hashes with TTL to expiry.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS {{keyspace}}.users (
    user_id            bigint,
    -- as-registered case; lookup via users_by_username
    username           text,
    email              text,
    -- null = view-only until verification completes
    email_verified_at  timestamp,
    password_hash      text,
    display_name       text,
    avatar_url         text,
    created_at         timestamp,
    -- soft-delete tombstone (U14 cascade start)
    deleted_at         timestamp,
    -- Monotonic credential epoch (U2, R13a): bumped by revoke-all-sessions and
    -- by password-reset completion, carried as a JWT claim, and compared by the
    -- auth plug, the gateway authenticator, and the session bridge. Rows
    -- written before the column existed read as NULL, which every reader
    -- treats as 0 — the fail-open half of the rollout posture.
    credential_epoch   int,
    PRIMARY KEY ((user_id))
);

-- Case-insensitive uniqueness is enforced by application-level compare on the
-- normalized (lowercased) handle; this table is the login lookup.
CREATE TABLE IF NOT EXISTS {{keyspace}}.users_by_username (
    username_lower text,
    user_id        bigint,
    PRIMARY KEY ((username_lower))
);

CREATE TABLE IF NOT EXISTS {{keyspace}}.users_by_email (
    email_lower text,
    user_id     bigint,
    PRIMARY KEY ((email_lower))
);

CREATE TABLE IF NOT EXISTS {{keyspace}}.refresh_tokens (
    user_id    bigint,
    -- HMAC-SHA256(pepper, raw) hex (legacy rows: SHA-256 of raw); raw tokens are never stored
    token_hash text,
    expires_at timestamp,
    PRIMARY KEY ((user_id), token_hash)
) WITH CLUSTERING ORDER BY (token_hash ASC);

-- Tombstones of ROTATED refresh tokens (HMAC key), TTL'd to the refresh
-- lifetime: presenting one again is a replay and revokes the family; a token
-- never seen here is only refused (Cytale.Accounts.Auth.rotate_refresh_token).
CREATE TABLE IF NOT EXISTS {{keyspace}}.refresh_token_rotations (
    user_id    bigint,
    token_hash text,
    PRIMARY KEY ((user_id), token_hash)
);

-- Pending-token lookup by holder: powers resend invalidation (U8) — when a
-- fresh token is issued, every row here for (user_id, purpose) is stale and
-- its verification_tokens row is deleted (tokens are single-use).
CREATE TABLE IF NOT EXISTS {{keyspace}}.verification_tokens_by_user (
    user_id    bigint,
    purpose    text,
    token_hash text,
    PRIMARY KEY ((user_id, purpose), token_hash)
) WITH CLUSTERING ORDER BY (token_hash ASC);

CREATE TABLE IF NOT EXISTS {{keyspace}}.verification_tokens (
    -- SHA-256 hex
    token_hash text,
    user_id    bigint,
    -- 'verify_email' | 'password_reset'
    purpose    text,
    expires_at timestamp,
    PRIMARY KEY ((token_hash))
);

-- ---------------------------------------------------------------------------
-- Machine principals (bots-plan U1, KTD1): provenance side tables beside
-- `users`. Machine principals insert into `users` (null email/password_hash,
-- no users_by_username/users_by_email rows, label in display_name) so every
-- existing users-reader works unchanged; these tables carry provenance only.
-- kind: 0 = human (synthesized at the boundary — humans never get a row
-- here), 1 = bot, 2 = webhook, 3 = agent. Depth is 1 (R1): a principal's
-- parent is always a human user.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS {{keyspace}}.principals (
    user_id        bigint,
    kind           int,
    parent_user_id bigint,
    -- JSON: {"actions": ["read","post"], "channels": ["<id>", ...]}
    -- absent/empty list = unrestricted on that axis; null = no policy
    -- LEGACY: kept for the human/legacy read path; no longer AUTHORITATIVE for
    -- machine principals (see `access` below).
    restrictions   text,
    -- The agent access document (Cytale.Access): a per-node grant tree —
    -- Server/Account fixed, DMs, Workspaces with All|Custom mode and
    -- per-workspace/per-channel levels. ABSENT OR CORRUPT = NO ACCESS: the
    -- resolver reads it through `Access.effective/1`, which fails closed, so a
    -- machine principal never falls back to inheriting its owner's rights.
    access         text,
    created_at     timestamp,
    PRIMARY KEY ((user_id))
);

-- Per-parent sub-identity index (roster synthesis + cascade fan-out).
CREATE TABLE IF NOT EXISTS {{keyspace}}.subs_by_parent (
    parent_user_id bigint,
    principal_id   bigint,
    kind           int,
    PRIMARY KEY ((parent_user_id), principal_id)
) WITH CLUSTERING ORDER BY (principal_id ASC);

-- Bot/agent credentials: token_hash is the SHA-256 hex of the plaintext
-- `cytbot_` token; raw tokens are never stored (token_store pattern). Keyed
-- by hash for the authenticate path (bots-plan U2).
CREATE TABLE IF NOT EXISTS {{keyspace}}.bot_tokens (
    token_hash   text,
    principal_id bigint,
    created_at   timestamp,
    PRIMARY KEY ((token_hash))
);

-- Per-principal credential index (hardening PERF-8): powers revoke/1 without
-- the `principal_id = ? ALLOW FILTERING` scan over bot_tokens. One row per
-- minted credential, written at mint (the same instant the bot_tokens row is)
-- and deleted at revoke — the two tables' lifecycles are identical by
-- construction. Credentials minted BEFORE this table existed have no index
-- row; revoke/1 self-heals those with one bounded scan when it finds an empty
-- index partition (no data-migration framework exists — see
-- Cytale.Accounts.Principals.revoke/1).
CREATE TABLE IF NOT EXISTS {{keyspace}}.bot_tokens_by_principal (
    principal_id bigint,
    token_hash   text,
    PRIMARY KEY ((principal_id), token_hash)
) WITH CLUSTERING ORDER BY (token_hash ASC);

-- ---------------------------------------------------------------------------
-- Workspaces + membership + invites (R1) and DM channels (R2). Denormalized
-- member rosters: workspace_members is keyed for "list workspace members";
-- workspaces_of_user is keyed for "list my workspaces" — no joins.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS {{keyspace}}.workspaces (
    workspace_id bigint,
    name         text,
    owner_id     bigint,
    created_at   timestamp,
    -- workspace image (content-addressed attachment path or null)
    icon_url     text,
    -- set by DELETE /workspaces/{id}: the tombstone every read refuses
    -- (Cytale.Workspaces.get_workspace/1 answers nil once it is set)
    deleted_at   timestamp,
    PRIMARY KEY ((workspace_id))
);

CREATE TABLE IF NOT EXISTS {{keyspace}}.workspace_members (
    workspace_id bigint,
    user_id      bigint,
    -- null = fall back to username
    nickname     text,
    joined_at    timestamp,
    -- role ids (U6/U7)
    roles        list<bigint>,
    PRIMARY KEY ((workspace_id), user_id)
) WITH CLUSTERING ORDER BY (user_id ASC);

-- Per-workspace nicknames of machine principals (#169). A bot is a member by
-- its grant, not by a workspace_members row (the INVARIANT in
-- Cytale.Workspaces), so its nickname cannot live on one: this is the bot
-- half of workspace_members.nickname. No row = no nickname (the roster shows
-- the bot's label, its display name).
CREATE TABLE IF NOT EXISTS {{keyspace}}.workspace_machine_nicknames (
    workspace_id bigint,
    user_id      bigint,
    nickname     text,
    PRIMARY KEY ((workspace_id), user_id)
) WITH CLUSTERING ORDER BY (user_id ASC);

-- Workspace name uniqueness (owner direction 2026-09-15: "workspaces
-- should be uniquely named" — a hard refresh showed two Example.com and two
-- Playground). Instance-wide, case-insensitive; the lightweight transaction
-- makes the claim atomic against concurrent creates from any account.
CREATE TABLE IF NOT EXISTS {{keyspace}}.workspaces_by_name (
    name_lower   text,
    workspace_id bigint,
    PRIMARY KEY ((name_lower))
);

CREATE TABLE IF NOT EXISTS {{keyspace}}.workspaces_of_user (
    user_id      bigint,
    workspace_id bigint,
    PRIMARY KEY ((user_id), workspace_id)
) WITH CLUSTERING ORDER BY (workspace_id ASC);

CREATE TABLE IF NOT EXISTS {{keyspace}}.invites (
    -- opaque public code from the link
    invite_code text,
    workspace_id bigint,
    created_by   bigint,
    -- null = unlimited
    max_uses     int,
    -- application-managed increment (counter columns can't mix here)
    use_count    bigint,
    expires_at   timestamp,
    -- null = live; revocation is a write (R1)
    revoked_at   timestamp,
    created_at   timestamp,
    PRIMARY KEY ((invite_code))
);

-- Channels (R2): text channels + category grouping. Partitioned per workspace
-- for "list channels in workspace"; category grouping via parent_id + position.
CREATE TABLE IF NOT EXISTS {{keyspace}}.channels (
    workspace_id  bigint,
    channel_id    bigint,
    name          text,
    -- 0 = text, 1 = category (voice/stage post-launch)
    type          int,
    -- null for top-level channels; a category's id for children
    parent_id     bigint,
    topic         text,
    position      int,
    created_by    bigint,
    created_at    timestamp,
    -- denormalized for the permission plug's channel→workspace hop
    last_message_id bigint,
    PRIMARY KEY ((workspace_id), channel_id)
) WITH CLUSTERING ORDER BY (channel_id DESC);

-- Channel-id lookup row (the permission plug resolves channel → workspace
-- without scanning): partitioned by channel_id.
CREATE TABLE IF NOT EXISTS {{keyspace}}.channels_by_id (
    channel_id   bigint,
    workspace_id bigint,
    name         text,
    type         int,
    parent_id    bigint,
    topic        text,
    position     int,
    created_by   bigint,
    created_at   timestamp,
    last_message_id bigint,
    PRIMARY KEY ((channel_id))
);

CREATE TABLE IF NOT EXISTS {{keyspace}}.dm_channels (
    channel_id   bigint,
    -- sorted pair for 1:1; larger sets post-launch
    user_ids     list<bigint>,
    created_at   timestamp,
    last_message_id bigint,
    PRIMARY KEY ((channel_id))
);

-- Per-user DM index (bots plan B-1): one row per PARTICIPANT per DM channel
-- (both rows written at open_dm — Discord stores a recipients list, ours is
-- the sorted pair). Read = the user's DM list (native + compat
-- GET /users/@me/channels); the pair columns denormalize the dm_channels row
-- so the list never re-reads it. Partition-keyed, no scans.
CREATE TABLE IF NOT EXISTS {{keyspace}}.dms_of_user (
    user_id     bigint,
    channel_id  bigint,
    user_ids    list<bigint>,
    created_at  timestamp,
    last_message_id bigint,
    PRIMARY KEY ((user_id), channel_id)
);

-- ---------------------------------------------------------------------------
-- Webhooks (bots plan U11, R12/KTD12): Discord-compatible INCOMING webhooks.
-- `webhooks` is the capability row — the URL token is stored PLAINTEXT by
-- decision (re-viewability requires recovery; the single-node threat model
-- means an encryption key would sit beside the data; the real mitigations are
-- anti-enumeration 404s, the per-webhook rate bucket, and regenerate/delete).
-- The webhook principal itself (attribution, display label) lives in the
-- U1 principal tables — `webhook_id` here IS the principal's user_id.
-- Execute validity = the webhook row + the channel existing (KD8: capability
-- URLs are exempt from the parent-rights intersection at execute).
CREATE TABLE IF NOT EXISTS {{keyspace}}.webhooks (
    webhook_id  bigint,
    channel_id  bigint,
    url_token   text,
    created_at  timestamp,
    PRIMARY KEY ((webhook_id))
);

-- Channel → webhooks index: powers the channel-delete cascade (a channel's
-- webhooks die with it — execute 404s from then on).
CREATE TABLE IF NOT EXISTS {{keyspace}}.webhooks_by_channel (
    channel_id  bigint,
    webhook_id  bigint,
    PRIMARY KEY ((channel_id), webhook_id)
) WITH CLUSTERING ORDER BY (webhook_id ASC);

-- Per-message author overrides (KTD12): webhook executes may carry one-time
-- `username`/`avatar_url` overrides. One row per message, written at execute
-- time only; the message read path joins it (the way it joins message_embeds).
-- author_id on the message stays the webhook PRINCIPAL id — attribution is
-- intact; the override is presentation-only.
CREATE TABLE IF NOT EXISTS {{keyspace}}.message_author_overrides (
    message_id         bigint,
    override_username  text,
    override_avatar_url text,
    PRIMARY KEY ((message_id))
);

-- ---------------------------------------------------------------------------
-- Application commands (bots plan U8, KTD13): workspace-scoped slash-command
-- registry. One row per command; (workspace_id, application_id, command_id)
-- clustering serves BOTH access patterns without filtering — the composer's
-- workspace-wide list (partition read) and an application's own set
-- (clustering-prefix read for bulk replace). `options` is the Discord
-- options definition JSON verbatim (store-and-forward, like embeds).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS {{keyspace}}.application_commands (
    workspace_id   bigint,
    application_id bigint,
    command_id     bigint,
    name           text,
    description    text,
    options        text,
    created_at     timestamp,
    PRIMARY KEY ((workspace_id), application_id, command_id)
) WITH CLUSTERING ORDER BY (application_id ASC, command_id ASC);

-- ---------------------------------------------------------------------------
-- Voice calls (voice plan U3, KTD4/KTD5). Live call state is EPHEMERAL
-- (presence-like, in the room GenServer); Scylla holds only durable
-- boundaries and mappings — no voice-state writes ever land here.
-- ---------------------------------------------------------------------------

-- Channel call history (R2/R8): one row per call, opened at start, closed at
-- end with the wire CallEndReason ('last_left' | 'swept'; null while live).
-- Partition: the channel (the history read); Snowflake call_id DESC
-- clustering yields newest-first with no ORDER BY. `name` is the reserved
-- AM-name field (KD3): null in V1 so future multi-breakout rooms need no
-- migration. DM rooms never write a row at all (R11 no-artifact).
CREATE TABLE IF NOT EXISTS {{keyspace}}.calls (
    channel_id   bigint,
    call_id      bigint,
    started_by   bigint,
    started_at   timestamp,
    -- null while the call is live
    ended_at     timestamp,
    -- 'last_left' | 'swept'; null while live
    ended_reason text,
    -- the channel's standing call-log thread (same one every call)
    thread_id    bigint,
    -- reserved (KD3): null in V1, multi-breakout names later
    name         text,
    PRIMARY KEY ((channel_id), call_id)
) WITH CLUSTERING ORDER BY (call_id DESC);

-- Live-call index (hardening plan 4.13): one row per LIVE call — written before
-- the `calls` row and deleted when the call ends — so the boot sweep walks live
-- calls instead of scanning every call ever made. Partitioned like `calls` (one
-- live call per channel is the room registry's own invariant), so this table is
-- bounded by concurrent calls rather than by history. A row here is a CANDIDATE,
-- not proof: the sweep re-reads the `calls` row before closing anything.
--
-- Exactly the two columns the sweep reads: `call_id` is a snowflake, so the
-- call's start time is derivable and does not need a column of its own.
--
-- UPGRADE NOTE (pre-launch only, no data of consequence): rows written by a
-- build older than this table have no index row and the boot sweep cannot see
-- them, so the residual is NOT self-healing until a backfill runs. There is no
-- one-statement backfill for it: ScyllaDB has no `INSERT ... SELECT`, and the
-- obvious `SELECT ... WHERE ended_at = NULL` is refused outright without
-- ALLOW FILTERING (`ended_at` is a regular column, not the partition key), so an
-- operator needs a paged read + per-row insert:
--   SELECT channel_id, call_id FROM <keyspace>.calls WHERE ended_at = NULL
--     ALLOW FILTERING;                                   -- page through it
--   INSERT INTO <keyspace>.open_calls (channel_id, call_id) VALUES (?, ?);
-- An orphan left unfilled is re-adopted by `Room.open_channel_call/3` on the
-- channel's next call, which indexes it again — but until one of those happens
-- the row stays invisible to the sweep.
CREATE TABLE IF NOT EXISTS {{keyspace}}.open_calls (
    channel_id bigint,
    call_id    bigint,
    PRIMARY KEY ((channel_id))
);

-- Standing call-log mapping (KTD5, R4): one row per channel pointing at the
-- lazily-created anchorless "Call log" thread, reused for every later call.
-- The mapping table being the ONLY creation path for that system name is
-- what keeps it from colliding with user-named threads.
CREATE TABLE IF NOT EXISTS {{keyspace}}.call_threads (
    channel_id bigint,
    thread_id  bigint,
    created_by bigint,
    created_at timestamp,
    PRIMARY KEY ((channel_id))
);

-- ---------------------------------------------------------------------------
-- Message marks (#54): ONE primitive for user-assigned message state. A mark
-- is (target message, kind, due_at?); each kind declares its visibility, its
-- read-model effect and its lifecycle (Cytale.Marks.Kind). One store PER
-- VISIBILITY, never per kind — a new kind is a registry entry, not a table.
--
-- `state` is 'pending' | 'fired' | 'cancelled' | 'missed'. A NULL state reads
-- as TERMINAL, never pending: a lapsed cell must not resurrect a cancelled
-- mark. Rows leave by their own TTL and the account-deletion cascade; the
-- sweep never deletes.
-- ---------------------------------------------------------------------------

-- Private marks. Partition: the owner — everything one user set, in one read
-- (the read_state discipline); nobody else has a read path into it.
-- (kind, target_id) clustering is what makes a second mark on the same
-- message a RE-SET rather than a duplicate. `channel_id` rides the row
-- because no message→channel mapping exists and a fire must move that
-- channel's read state; it is taken from the fetched message, never from a
-- request body.
CREATE TABLE IF NOT EXISTS {{keyspace}}.message_marks_by_user (
    user_id     bigint,
    kind        text,
    target_id   bigint,
    channel_id  bigint,
    mark_id     bigint,
    due_at      timestamp,
    state       text,
    created_at  timestamp,
    PRIMARY KEY ((user_id), kind, target_id)
);

-- Shared marks (pins and other channel-visible kinds). Partition: the
-- channel — a channel's list in one read. Declared with the primitive so a
-- shared kind lands as a registry entry; no v1 kind writes it.
CREATE TABLE IF NOT EXISTS {{keyspace}}.message_marks_by_channel (
    channel_id  bigint,
    kind        text,
    target_id   bigint,
    created_by  bigint,
    created_at  timestamp,
    PRIMARY KEY ((channel_id), kind, target_id)
);

-- The sweep's index: partition = the minute the mark is due
-- (floor(due_ms / 60 000)), so a tick reads a bounded set of small
-- partitions. The row carries the mark's identity (user, kind, target,
-- channel) so the fence read is a partition-key read of the authoritative
-- row. Its `state` is a CACHE of the authoritative one — the fence re-reads
-- the owner's row and fires only when that row is pending AND names this
-- same due_at, so a re-set or a cancel needs no delete here.
CREATE TABLE IF NOT EXISTS {{keyspace}}.message_marks_by_due (
    due_bucket  bigint,
    due_at      timestamp,
    mark_id     bigint,
    user_id     bigint,
    kind        text,
    target_id   bigint,
    channel_id  bigint,
    state       text,
    PRIMARY KEY ((due_bucket), due_at, mark_id)
);

-- Per-user-per-channel ring mute (AM6): row presence = muted for that
-- channel's calls. Durable so restarts never re-ring muted members.
-- Partition: the user (all of a user's mutes in one read — the read_state
-- discipline); channel clustering.
CREATE TABLE IF NOT EXISTS {{keyspace}}.notification_mutes (
    user_id    bigint,
    channel_id bigint,
    created_at timestamp,
    PRIMARY KEY ((user_id), channel_id)
) WITH CLUSTERING ORDER BY (channel_id ASC);

-- ---------------------------------------------------------------------------
-- Notification levels (plan U2, R5/R6) — the preference hierarchy.
-- One row per (member, entity) the member has OVERRIDDEN; an absent row means
-- "inherit from the layer above", which is why nothing is written for a
-- default. Partition by the user so the per-message decision costs one
-- partition read (the notification_mutes / read_state discipline).
--
-- `scope` keeps the layers in one table: 0 = the account default (entity_id
-- 0), 1 = a workspace, 2 = a channel. Channel and workspace ids are distinct
-- Snowflakes, so they could share a namespace, but naming the scope keeps the
-- inheritance walk readable and leaves room for a fourth layer.
--
-- `level` is textual and NULLABLE, mirroring channel_media_overrides' NULL =
-- inherit precedent: 'all' | 'mentions' | 'mute'. Nothing is enforced here —
-- the closed set lives in Cytale.Notifications.Preferences, so adding a level
-- is a code change rather than a migration.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Participation index (plan U11, R11) — the channels and threads a member has
-- POSTED in, which is what keeps a broad mute from silencing a reply to them.
--
-- Deliberately a small dedicated index rather than a read of author_messages:
-- that partition holds every message a member ever wrote, and the notification
-- decision runs per message per recipient, so scanning it would put an
-- unbounded read on the fan-out path. This is one row per (member, channel),
-- so the question "have they posted here" stays a bounded partition read.
--
-- Derived from authored messages rather than declared by the member, so the
-- rule cannot drift from reality.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS {{keyspace}}.notification_participations (
    user_id    bigint,
    entity_id  bigint,
    created_at timestamp,
    PRIMARY KEY ((user_id), entity_id)
) WITH CLUSTERING ORDER BY (entity_id ASC);

CREATE TABLE IF NOT EXISTS {{keyspace}}.notification_preferences (
    user_id    bigint,
    scope      int,
    entity_id  bigint,
    -- NULL = inherit
    level      text,
    updated_at timestamp,
    -- scope is part of the clustering key, not a plain column: workspace ids
    -- and channel ids are separate Snowflake namespaces that a caller could
    -- confuse, and clustering on (scope, entity_id) keeps the two layers from
    -- colliding on one row. The account default is (0, 0) by convention.
    PRIMARY KEY ((user_id), scope, entity_id)
) WITH CLUSTERING ORDER BY (scope ASC, entity_id ASC);

-- ---------------------------------------------------------------------------
-- Push subscriptions (R8 PWA web-push delivery — consumed by U9/U10).
-- endpoint is stored flat for dedup lookups; keys blob is the opaque
-- subscription payload the browser registered.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS {{keyspace}}.push_subscriptions (
    user_id           bigint,
    -- sha256(endpoint) — natural dedup key
    subscription_hash text,
    endpoint          text,
    -- JSON: {p256dh, auth}
    keys_blob         text,
    -- 'web' | 'mobile'. Rows written before the column existed read as null
    -- and are treated as 'web' (the only target type that could have written
    -- them). Widening the target set to a second kind of row is what keeps a
    -- mobile device token from needing its own table (notifications plan R14).
    target_type       text,
    created_at        timestamp,
    PRIMARY KEY ((user_id), subscription_hash)
) WITH CLUSTERING ORDER BY (subscription_hash ASC);

-- ---------------------------------------------------------------------------
-- Workspace media settings (calls V2 plan U8, R16/R17). One row per
-- workspace: the MASTER capability toggles plus the "channels may override"
-- flag. Absent row = defaults (everything enabled, overrides disallowed) —
-- no migration, explicit opt-in on first write.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS {{keyspace}}.workspace_media_settings (
    workspace_id      bigint,
    -- master capability switches (call start / camera / screen+screen-audio)
    calls             boolean,
    video             boolean,
    screenshare       boolean,
    -- when false the master values apply everywhere (R16)
    overrides_allowed boolean,
    updated_at        timestamp,
    PRIMARY KEY ((workspace_id))
);

-- Per-channel media overrides (calls V2 plan U8, R16): one row per channel,
-- each capability a NULLABLE tri-state — NULL = inherit the workspace
-- master. Rows are inert while the workspace's overrides_allowed is false
-- (effective resolution consults the master alone then); DM channels never
-- carry a row (DM calls skip capability checks entirely).
CREATE TABLE IF NOT EXISTS {{keyspace}}.channel_media_overrides (
    channel_id  bigint,
    -- NULL = inherit master
    calls       boolean,
    video       boolean,
    screenshare boolean,
    updated_at  timestamp,
    PRIMARY KEY ((channel_id))
);

-- ---------------------------------------------------------------------------
-- SSH certificate surface (U2, R2/R5/R5a/R6): the public keys a member has
-- submitted and the certificates this server issued for them.
--
-- `ssh_keys` is the STORED PUBLIC KEY — the long-lived half. It has no TTL by
-- design: the certificate expires after 24 hours and the member re-issues
-- against the stored key (R6), so a key that aged out with its certificate
-- would break the recurring path. `key_id` is a URL-safe digest of the key
-- blob (base64url of its SHA-256), which is what the member's routes address;
-- `fingerprint` is the OpenSSH-shaped `SHA256:<base64>` the member reads and
-- the bridge compares.
--
-- One partition per account, so "list my keys", "how many have I stored"
-- (the issuance cap), and "remove this key" are single-partition operations.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS {{keyspace}}.ssh_keys (
    account_id  bigint,
    -- base64url(SHA-256(blob)) — URL-safe, route-addressable
    key_id      text,
    fingerprint text,
    -- the OpenSSH public-key LINE as submitted (public material, verbatim)
    public_key  text,
    comment     text,
    created_at  timestamp,
    PRIMARY KEY ((account_id), key_id)
) WITH CLUSTERING ORDER BY (key_id ASC);

-- The issuance rows: one per certificate this server signed. Certificates are
-- SUPERSEDED rather than revoked, so `is_current` marks the newest issuance
-- per key and older rows stay listable (R5) until the retention TTL evicts
-- them. Rows carry the credential epoch recorded at issuance, which is what
-- the bridge compares against the account's current epoch before a mint
-- (R13a: a credential reset ends a session at its next renewal).
CREATE TABLE IF NOT EXISTS {{keyspace}}.ssh_certificates (
    account_id       bigint,
    key_id           text,
    serial           bigint,
    principal        text,
    credential_epoch int,
    issued_at        timestamp,
    valid_after      timestamp,
    valid_before     timestamp,
    -- the newest issuance for this key
    is_current       boolean,
    PRIMARY KEY ((account_id), key_id, serial)
) WITH CLUSTERING ORDER BY (key_id ASC, serial ASC);

-- The bridge's lookup key (R7/R8): the session host asserts a serial and the
-- server resolves it to the issuance it made. A serial is globally unique, so
-- this is a point read with no partition knowledge — the reason the bridge
-- never needs to know which account it is talking about.
CREATE TABLE IF NOT EXISTS {{keyspace}}.ssh_certificates_by_serial (
    serial           bigint,
    account_id       bigint,
    key_id           text,
    fingerprint      text,
    principal        text,
    credential_epoch int,
    valid_after      timestamp,
    valid_before     timestamp,
    PRIMARY KEY ((serial))
);

-- Audit trail (R6a/R8b): every issuance, every bridge mint, and every refusal
-- of either, with its reason. Partitioned by account so an operator can read
-- one member's history in a single partition read; events with no resolved
-- account (an unknown serial, a bad credential) land in partition 0.
--
-- This table is the plan's DETECTION path for a compromise it cannot prevent,
-- so it deliberately outlives the account: the deletion cascade de-identifies
-- the account reference rather than deleting the record.
CREATE TABLE IF NOT EXISTS {{keyspace}}.ssh_certificate_audit (
    account_id  bigint,
    event_id    bigint,
    -- issued | issue_refused | minted | mint_refused | key_removed
    action      text,
    -- ok | refused
    outcome     text,
    -- the refusal reason, when there was one
    reason      text,
    serial      bigint,
    principal   text,
    fingerprint text,
    occurred_at timestamp,
    PRIMARY KEY ((account_id), event_id)
) WITH CLUSTERING ORDER BY (event_id DESC);

-- Bridge assertion replay guard (R8): one row per accepted nonce, written with
-- an LWT so a replayed assertion loses the race and is refused, and with a TTL
-- so the table only ever holds the current acceptance window's worth of rows.
-- The certificate serial is NOT the replay key — one session re-mints on the
-- same serial every access-token lifetime for up to 24 hours, so a
-- serial-keyed record would refuse the first renewal and kill long sessions.
CREATE TABLE IF NOT EXISTS {{keyspace}}.ssh_bridge_nonces (
    nonce      text,
    account_id bigint,
    serial     bigint,
    created_at timestamp,
    PRIMARY KEY ((nonce))
);

-- ---------------------------------------------------------------------------
-- Client-error reports (#88) — the sink behind POST /api/v1/client-errors.
--
-- This is the repo's established call for low-volume append-only events
-- (the same conclusion the audit-trail discussion reached): Scylla alone. No
-- ClickHouse, no third-party collector, no second datastore — a few reports a
-- day per client does not justify one, and a self-hosted sink keeps the
-- privacy decision in this file instead of in a vendor's retention policy.
--
-- Partition: `day` = floor(unix_seconds / 86400), so every read is a bounded
-- range scan over whole days and no partition grows without bound. Rows are
-- written with `USING TTL` of 30 days (Cytale.Observability.ClientErrors) —
-- the retention an operator reads in docs/protocol/rest.md — so a day
-- partition holds at most 30 days of reports.
--
-- Snowflake `report_id` as the DESC clustering key gives newest-first without
-- an ORDER BY (the file-wide convention).
--
-- What is deliberately NOT here: no column can hold message content, a request
-- body, a header or a cookie. `message`/`stack` arrive truncated and redacted,
-- `route` arrives with its ids already replaced by `:id`, and `request_id` is
-- the server's OWN Plug.RequestId value for the failing call — the handle that
-- makes a client report traceable into the server logs instead of a dead end.
-- `account_id` is null for an anonymous report (the login-page crash, which is
-- the most valuable one to capture) and the caller's snowflake otherwise.
--
-- PRIVACY: this is a DIAGNOSIS surface, not a content store. Adding a
-- content-bearing column here is a privacy regression, not a feature.
CREATE TABLE IF NOT EXISTS {{keyspace}}.client_errors (
    day         int,
    report_id   bigint,
    -- null = anonymous (no session at report time)
    account_id  bigint,
    fingerprint text,
    -- web | desktop | mobile
    client      text,
    -- window.onerror | unhandledrejection | error-boundary | api.request | gateway.telemetry
    source      text,
    route       text,
    version     text,
    message     text,
    stack       text,
    -- HTTP status of the failed call; null for a non-api.source
    status      int,
    -- the server's x-request-id for the failing call (the trace handle)
    request_id  text,
    detail      text,
    occurred_at timestamp,
    PRIMARY KEY ((day), report_id)
) WITH CLUSTERING ORDER BY (report_id DESC);

-- ---------------------------------------------------------------------------
-- WebAuthn passkeys (ticket #36) — the second LOGIN credential beside the
-- password. Additive by design: enrollment changes no account semantics
-- (password stays, verification state untouched), and removing a passkey is
-- removing exactly these rows.
--
-- `webauthn_credentials` is the OWNER's list (one partition per account, the
-- ssh_keys discipline): settings reads, excludeCredentials at enrollment, and
-- the "how many" check are single-partition reads.
--
-- `webauthn_credentials_by_id` is the LOGIN lookup: the discoverable
-- (usernameless) assertion arrives naming only a credential id, so resolving
-- it to an account + public key must be one point read with no partition
-- knowledge (the ssh_certificates_by_serial pattern). The public key and
-- sign count are DENORMALIZED here so the verify path never fans out.
--
-- `credential_id` is base64url of the raw credential id on BOTH tables —
-- route-addressable (DELETE /users/@me/webauthn/credentials/:credential_id,
-- like ssh_keys.key_id) and byte-exact after decode. Uniqueness is enforced
-- at the write: the by_id INSERT is a lightweight transaction (IF NOT
-- EXISTS), so two accounts racing the same credential id cannot both win.
--
-- `public_key` is the wax COSE key map serialized with
-- `:erlang.term_to_binary/1` + base64 (wax's own storage recommendation —
-- a plain map of small integers to binaries/integers, safe for
-- `binary_to_term/2` with [:safe]).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS {{keyspace}}.webauthn_credentials (
    user_id        bigint,
    credential_id  text,
    public_key     text,
    -- the authenticator's signature counter at last use (clone detection:
    -- a non-monotonic presentation refuses the login)
    sign_count     bigint,
    -- BE/BS authenticator flags at last use (informational in v1)
    backup_eligible boolean,
    backup_state   boolean,
    -- the user-chosen display name ("" when unnamed)
    name           text,
    created_at     timestamp,
    -- null = never used to log in
    last_used_at   timestamp,
    PRIMARY KEY ((user_id), credential_id)
) WITH CLUSTERING ORDER BY (credential_id ASC);

CREATE TABLE IF NOT EXISTS {{keyspace}}.webauthn_credentials_by_id (
    credential_id text,
    user_id       bigint,
    public_key    text,
    sign_count    bigint,
    created_at    timestamp,
    PRIMARY KEY ((credential_id))
);

-- ---------------------------------------------------------------------------
-- TOTP two-factor enrollment (ticket #127) — the SECOND FACTOR beside the
-- password, armed by the server switch `auth.two_factor_enabled`. ONE
-- enrollment per account in v1 (multiple methods is explicitly later), so
-- the table is one row per account: PRIMARY KEY ((user_id)), every read and
-- write is a single-partition point operation keyed by the account id.
--
-- Confirm-before-persist: `start` writes the CANDIDATE secret with
-- `confirmed = false` and only a confirm whose code actually verifies flips
-- it — an unconfirmed row NEVER arms the gate (the login check reads
-- confirmed rows exclusively), so a candidate abandoned halfway can't
-- lock anyone out.
--
-- `secret` is base32 (RFC 4648, unpadded) of the 20-byte key — the exact
-- form the QR and the manual-entry field carry.
--
-- `last_used_step` is the RFC 6238 time-step of the most recently ACCEPTED
-- code. The ±1-step window means up to three codes verify at once, so
-- replay protection is step-monotonicity: a code whose step is at or below
-- the recorded one is refused even inside its window (a code can never be
-- accepted twice).
--
-- Retention edge (ticket): switching the server switch off stops the
-- challenging but KEEPS the rows — switching back on re-arms them. A
-- password-reset completion deletes the row (email possession is the
-- recovery channel), and account deletion cascades it.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS {{keyspace}}.two_factor_enrollments (
    user_id         bigint,
    secret          text,
    confirmed       boolean,
    created_at      timestamp,
    -- null until the confirm code verified
    confirmed_at    timestamp,
    -- null = never verified a login code
    last_used_at    timestamp,
    -- null = never verified a login code
    last_used_step  bigint,
    PRIMARY KEY ((user_id))
);
