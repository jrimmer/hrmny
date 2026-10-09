/**
 * @cytale/domain — shared domain models.
 *
 * TypeScript interfaces for every Cytale entity, matching BOTH the protocol
 * event payloads (@cytale/protocol) and the REST response shapes (U9). All
 * IDs are Snowflake strings (never numbers — >53-bit safe); permission
 * bitfields ride as decimal strings; timestamps are ISO-8601 strings.
 *
 * Several entities exist in two layers:
 *  - Wire-minimal shapes (mirror @cytale/protocol dispatch payloads exactly;
 *    `*_Ref` naming) — what gateway events carry.
 *  - Full REST read models (this file's interfaces) — what list/get endpoints
 *    return. Detail fields not present on the wire degrade to optional.
 */

import type { MessageActionRow, Snowflake } from '@cytale/protocol';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** ISO-8601 timestamp string as emitted by the server. */
export type ISO8601 = string;

/**
 * Serialized permission bitfield (decimal string; preserves bits > 2^53).
 * Structurally an alias of protocol's Snowflake wire discipline.
 */
export type PermissionBits = string;

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/** Canonical user as returned by `/users/@me` and the people directory. */
export interface User {
  id: Snowflake;
  username: string;
  /** Display name, when distinct from username. */
  display_name?: string | null;
  /** Email present only on self reads (`@me`); never on directory entries. */
  email?: string | null;
  avatar_url?: string | null;
  /** Stamped once email verification completes; view-only until then. */
  email_verified_at?: ISO8601 | null;
  /** Account creation timestamp (`@me` carries it; directory rows may omit). */
  created_at?: ISO8601;
}

/** Compact user reference embedded in messages and member events. */
export interface UserRef {
  id: Snowflake;
  username: string;
  /**
   * The account's display name (#168), on roster, people, MemberAdd and
   * DM-recipient rows. Null/absent → the username is the name.
   */
  display_name?: string | null;
  /** Avatar for rendering; present on roster/DM-recipient rows (may be null). */
  avatar_url?: string | null;
}

/** Anything a person or bot can be named from. */
export interface Nameable {
  nickname?: string | null;
  display_name?: string | null;
  username?: string | null;
}

/**
 * The ONE name rule every client uses for a person or bot (#168), Discord's:
 * the workspace nickname, else the account's display name, else the
 * username. Blank values are skipped. `fallback` covers a row with none
 * (an unresolved id).
 */
export function displayNameOf(who: Nameable | null | undefined, fallback = ''): string {
  for (const name of [who?.nickname, who?.display_name, who?.username]) {
    if (typeof name === 'string' && name.trim() !== '') return name;
  }
  return fallback;
}

/**
 * Principal kind (bots plan U5, R6 attribution): "human" for member rows;
 * machine principals are synthesized beside their parent in members/people
 * reads carrying their minted kind.
 */
export type PrincipalKind = 'human' | 'bot' | 'agent' | 'webhook';

/** Row of `GET /workspaces/{id}/people?query=&before=&after=&limit=`. */
export interface WorkspaceMember extends UserRef {
  nickname: string | null;
  joined_at: ISO8601;
  /** Role ids held in this workspace (decimal-string snowflakes). */
  roles: Snowflake[];
  /** Principal kind — present on members/people entries (U5); humans read "human". */
  kind?: PrincipalKind;
  /** Owning human's id — present on machine entries only (R1: membership derives from the parent). */
  parent_user_id?: Snowflake;
  /**
   * WHO this machine principal will hold a DM with (owner direction
   * 2026-09-15): `humans` (the default), `everyone`, `none`. Absent reads as
   * `humans` — the same default the server applies.
   */
  dm_support?: 'humans' | 'everyone' | 'none';
}

/** Current-user profile (`GET /users/@me`). */
export interface CurrentUser extends User {
  email: string | null;
  email_verified_at: ISO8601 | null;
  /**
   * The wire truth from `@me` (the server sends this boolean, not the
   * timestamp). Optional because legacy seeds/tests construct the older
   * shape; prefer this field when present.
   */
  email_verified?: boolean;
  /**
   * Platform-operator flag (#121): the client-side signal for operator-only
   * UI (the Server Settings entry under the Home gear). It only decides
   * whether the AFFORDANCE renders — the routes stay gated server-side.
   */
  is_operator?: boolean;
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

export interface Workspace {
  id: Snowflake;
  name: string;
  icon_url?: string | null;
  description?: string | null;
  owner_id: Snowflake;
  /**
   * Lazy cache-invalidation counter bumped on every role/overwrite mutation
   * (U7). Bump ⇒ clients re-resolve channel permissions.
   */
  role_version: number;
  created_at: ISO8601;
  updated_at?: ISO8601 | null;
}

/** Creation/update bodies (REST write models). */
export interface CreateWorkspaceBody {
  name: string;
  description?: string;
}

export type UpdateWorkspaceBody = Partial<Pick<Workspace, 'name' | 'description' | 'icon_url'>>;

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/**
 * The exact channel-type vocabulary the Cytale wire carries (every server
 * emission grepped 2026-09-08):
 *
 *  - `0` — text channel; `1` — category. `Workspaces.create_channel/3` stores
 *    the integer column (`@type channel_type :: 0 | 1`) and
 *    `ChannelController.channel_json/1` emits it verbatim.
 *  - `'dm'` — a DM read through `GET /channels/{id}`
 *    (`ChannelController.dm_channel_json/2` sends the `:dm` atom).
 *
 * Two wire facts no union member can spell, and consumers must not guess at:
 *
 *  - DM list/create payloads (`GET /users/@me/channels`,
 *    `POST /users/{user_id}/channels`) and every gateway Channel event OMIT
 *    the key entirely;
 *  - there is no group-DM or voice channel kind server-side: group DMs do not
 *    exist (`Workspaces.open_dm/2` is strictly 1:1) and voice is a call-room
 *    surface, not a channel type.
 */
export type ChannelTypeWire = 0 | 1 | 'dm';

/**
 * Normalized channel type — what every consumer sees once the api-client
 * boundary has run (`normalizeChannelType`). One member per wire value:
 * `0` → `'text'`, `1` → `'category'`, `'dm'` → `'dm'`. The legacy
 * `'group_dm'` member is gone: no server surface ever produced it.
 */
export type ChannelType = 'text' | 'category' | 'dm';

/**
 * Wire → domain channel type. The REST payload is NOT uniform: workspace
 * channels carry the server's numeric column (0 = text, 1 = category) while
 * DM reads carry the string 'dm'. Normalizing at the api-client boundary
 * keeps every consumer on this union.
 */
export function normalizeChannelType(raw: unknown): ChannelType {
  if (raw === 1 || raw === 'category') return 'category';
  if (raw === 'dm') return 'dm';
  return 'text';
}

/**
 * True when the channel is a text channel (the kind that carries messages).
 * Accepts either spelling — the normalized `ChannelType`, or a raw wire value
 * that has not crossed the api-client boundary yet (numeric `0`) — so
 * consumers never re-derive the mapping themselves. A DM or category channel
 * is never a text channel.
 */
export function isTextChannel(channel: { type?: unknown } | null | undefined): boolean {
  const raw = channel?.type;
  return raw === 'text' || raw === 0;
}

export interface Channel {
  id: Snowflake;
  /** Absent/null for DM channels (no parent workspace). */
  workspace_id: Snowflake | null;
  /** DM channels carry recipient refs instead of a workspace. */
  recipients?: UserRef[] | null;
  name: string;
  type: ChannelType;
  /** Category this channel is filed under (null/absent = ungrouped).
   *  The api-client normalizes it to `string | null` on every read. */
  parent_id?: Snowflake | null;
  topic: string | null;
  position: number;
  last_message_id: Snowflake | null;
  created_at: ISO8601;
  updated_at?: ISO8601 | null;
}

/** Minimal channel projection riding gateway CHANNEL_CREATE events. */
export interface ChannelRef {
  id: Snowflake;
  workspace_id: Snowflake;
  name: string;
  position: number;
  created_at: ISO8601;
}

export interface CreateChannelBody {
  name: string;
  /** Text channels carry messages; categories group them. Defaults to text. */
  type?: Extract<ChannelType, 'text' | 'category'>;
  /** File the new channel under this category (text channels only). */
  parent_id?: Snowflake | null;
  topic?: string;
  position?: number;
}

/** PATCH /channels/{id} — partial update, absent keys unchanged. */
export interface UpdateChannelBody {
  name?: string;
  topic?: string | null;
  /** Move the channel into a category (null clears the grouping). */
  parent_id?: Snowflake | null;
}

/** POST /workspaces/{id}/channels/reorder — full desired order. */
export interface ReorderChannelsBody {
  /** Channel ids in their new display order. */
  order: Snowflake[];
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * Canonical message — matches protocol MessageCreate plus REST detail
 * fields (edited tracking aligns with MessageUpdate's edited_at).
 */
/** Snapshot of the message an inline reply references (Discord's
 * referenced_message subset Cytale renders: identity + snippet). */
export interface ReferencedMessage {
  message_id: Snowflake;
  author_id: Snowflake;
  author_username: string | null;
  /** First ~80 chars of the original content. */
  content: string;
}

export interface Message {
  id: Snowflake;
  channel_id: Snowflake;
  /** Set when the message lives inside a thread; null for channel messages. */
  thread_id: Snowflake | null;
  /** Inline-reply reference (Discord message_reference); null = none. */
  reply_to_id?: Snowflake | null;
  /** Receiver-side snapshot of the referenced message (renders the reply
   * context line without a fetch). Absent on old rows. */
  referenced?: ReferencedMessage | null;
  author_id: Snowflake;
  content: string;
  created_at: ISO8601;
  edited_at: ISO8601 | null;
  /** Attachment metadata (ids + metadata), after upload binds them. */
  attachments?: Attachment[] | null;
  /** Action rows (components plan, R2): present only on machine-authored
   * messages that stored components; absent = none (the embeds precedent).
   * Verbatim bot JSON — U4 renders it defensively, never executes it. */
  components?: MessageActionRow[] | null;
  /**
   * CLIENT-ONLY, never on the wire: the optimistic send's nonce, kept on the
   * row through confirmation (lane D #12). The placeholder's id is
   * `pending_<nonce>` and the confirmed row's is the server snowflake, so a
   * list keyed by id remounted the row at the moment it confirmed; keyed by
   * `client_key ?? id` it keeps its identity across the swap.
   */
  client_key?: string;
  /**
   * CLIENT-ONLY, never on the wire: where an optimistic send stands while its
   * row is still the local placeholder (`pending_<nonce>`). `pending` = in
   * flight or queued behind an earlier send; `failed` = the server refused it
   * or it could not be sent; `unconfirmed` = no answer in time (a timeout — it
   * may have landed, and a retry under the same nonce is safe); `waiting` =
   * it could not go out because the connection is down, and it goes out on
   * its own (same nonce) when the connection returns. Absent on every
   * confirmed row: the server row that replaces the placeholder never
   * carries it.
   */
  send_state?: 'pending' | 'failed' | 'unconfirmed' | 'waiting';
  /** CLIENT-ONLY: why a `failed`/`unconfirmed`/`waiting` send stands where it does. */
  send_error?: { key: string; message: string } | null;
}

/**
 * Wire-exact message shape — structurally identical to protocol's
 * MessageCreate so `Message` satisfies it without field drift.
 */
export interface MessageWireRef {
  id: Snowflake;
  channel_id: Snowflake;
  thread_id: Snowflake | null;
  author_id: Snowflake;
  content: string;
  created_at: ISO8601;
  edited_at: ISO8601 | null;
}

export interface CreateMessageBody {
  /** Inline-reply reference: message id being replied to. */
  reply_to_id?: Snowflake;
  content: string;
  /**
   * Thread-scoped send on the CHANNEL endpoint: `POST /channels/{id}/messages`
   * accepts `thread_id` (`message_controller.ex` create/2) so a reply can be
   * posted into a thread without the `/threads/{id}/messages` route. Omit for
   * a channel-timeline message; `null` is equivalent to absent.
   */
  thread_id?: Snowflake | null;
  /** Idempotency-Key rides as a header, generated client-side per POST. */
  nonce?: string;
  /** Upload descriptors (uploadChannelAttachment results) bound at create time. */
  attachments?: UploadedAttachment[];
}

export interface UpdateMessageBody {
  content: string;
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

export interface Thread {
  id: Snowflake;
  /** Parent channel this thread hangs off. */
  channel_id: Snowflake;
  /** The message that started the thread (U12 thread model). */
  parent_message_id: Snowflake | null;
  name: string;
  created_by: Snowflake;
  archived: boolean;
  /** Replies so far (seed message excluded) — the indicator's count. */
  message_count?: number;
  /** Most recent reply time (null when no replies yet). */
  latest_reply_at?: ISO8601 | null;
  /** Thread-membership flags for the current user (unread badge tiers). */
  member_state?: {
    notify: boolean;
    last_read_id: Snowflake | null;
  } | null;
  created_at: ISO8601;
  updated_at?: ISO8601 | null;
  /**
   * The message the thread was started from (the channel roster read only;
   * null when that message is gone).
   */
  starter?: ThreadMessagePreview | null;
  /** The newest reply (the channel roster read only; null with no replies). */
  latest_reply?: ThreadMessagePreview | null;
}

/** One message as the thread roster previews it. */
export interface ThreadMessagePreview {
  id: Snowflake;
  author_id: Snowflake;
  /** A webhook's per-message name, which the roster cannot resolve. */
  author_name: string | null;
  /** Raw markdown, cut to 300 characters. */
  content: string;
  /** The first embed's title, for a message that is only a card. */
  embed_title: string | null;
  attachment_count: number;
  created_at: ISO8601;
}

/** Wire-exact thread shape (mirrors protocol ThreadCreate). */
export interface ThreadRef {
  id: Snowflake;
  channel_id: Snowflake;
  name: string;
  created_by: Snowflake;
  created_at: ISO8601;
}

export interface CreateThreadBody {
  channel_id: Snowflake;
  name: string;
  parent_message_id?: Snowflake;
}

export interface UpdateThreadBody {
  name?: string;
  archived?: boolean;
}

// ---------------------------------------------------------------------------
// Roles & permissions
// ---------------------------------------------------------------------------

/**
 * A workspace role. Permission bitfield serialized as decimal string
 * (>53-bit safe); `position` drives strict hierarchy enforcement (higher
 * number = more senior; actor must strictly exceed target).
 */
export interface Role {
  id: Snowflake;
  workspace_id: Snowflake;
  name: string;
  permissions: string;
  position: number;
  color: number | null;
}

export interface CreateRoleBody {
  name: string;
  /** Decimal-string permission bitfield. */
  permissions: string;
  color?: number | null;
}

export interface UpdateRoleBody {
  name?: string;
  permissions?: string;
  position?: number;
  color?: number | null;
}

/** Per-channel allow/deny overwrite pair attached to a role or member. */
export interface PermissionOverwrite {
  id: Snowflake; // role id or user id
  type: 'role' | 'member';
  allow: string;
  deny: string;
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

export interface Invite {
  code: string;
  workspace_id: Snowflake;
  channel_id: Snowflake | null;
  inviter_id: Snowflake;
  /** Cap on total uses; 0 = unlimited. */
  max_uses: number;
  uses: number;
  /** Absolute expiry instant; null = never expires. */
  expires_at: ISO8601 | null;
  revoked_at: ISO8601 | null;
  created_at: ISO8601;
}

export interface CreateInviteBody {
  max_uses?: number;
  /**
   * Lifetime seconds — the wire param is `max_age_s` (invite_controller
   * `create/2`, protocol.md); any other spelling silently falls back to the
   * server's 600s default.
   */
  max_age_s?: number;
  channel_id?: Snowflake;
}

/** Public, unauthenticated invite resolution (join flow, U20). */
export interface PublicInvite {
  code: string;
  workspace_name: string;
  workspace_icon_url?: string | null;
  inviter_username: string;
  member_count?: number | null;
  expires_at: ISO8601 | null;
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export interface Attachment {
  id: Snowflake;
  message_id: Snowflake | null;
  filename: string;
  content_type: string;
  size: number;
  url: string;
  uploaded_at?: ISO8601 | null;
  /**
   * Pixel dimensions the upload sniffed (PNG/GIF/JPEG only) — integers on
   * the wire, ABSENT for everything else. Lets a renderer reserve the
   * image's aspect-ratio box before the bytes load.
   */
  width?: number;
  height?: number;
}

/**
 * Multipart upload response (the server's attachment descriptor): the
 * relative `url` is the content-addressed blob path; `width`/`height` ride
 * along when the bytes parsed as PNG/GIF/JPEG.
 */
export interface UploadedAttachment {
  filename: string;
  content_type: string;
  size: number;
  url: string;
  width?: number;
  height?: number;
}

// ---------------------------------------------------------------------------
// Push subscriptions
// ---------------------------------------------------------------------------

export interface PushSubscription {
  id: Snowflake;
  endpoint: string;
  keys: Record<string, string>;
  user_agent?: string | null;
  created_at: ISO8601;
}

/** Standard web-push `PushSubscriptionJSON` body posted by clients. */
export type CreatePushSubscriptionBody = {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
};

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// List pagination envelope
// ---------------------------------------------------------------------------

/** Cursor metadata returned by every list endpoint (snowflake-cursor based). */
export interface ListCursor {
  /** Newest id in the returned window, for paging deeper into history. */
  before: string | null;
  /** Oldest id in the returned window, for paging toward newer messages. */
  after: string | null;
  /** Effective page size applied by the server. */
  limit: number;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** Parsed filter syntax (`from:` / `in:` / `before:` / `after:`). */
export interface SearchFilters {
  from?: string;
  in?: string;
  before?: string;
  after?: string;
}

export interface SearchHit {
  message_id: Snowflake;
  channel_id: Snowflake;
  thread_id: Snowflake | null;
  author_id: Snowflake;
  /** Tantivy snippet with highlight fragments. */
  highlight?: string | null;
  score?: number | null;
  created_at: ISO8601;
}

export interface SearchResult {
  items: SearchHit[];
  total_count?: number | null;
  /** Present when more pages remain (same envelope as list endpoints). */
  cursor?: ListCursor | null;
}

// ---------------------------------------------------------------------------
// Accounts & auth
// ---------------------------------------------------------------------------

export interface AuthTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  /**
   * The signed-in account in the `@me` shape (lane D #4). Every token-pair
   * response of a current server carries it, so the client adopts it instead
   * of paying a `/users/@me` round trip. Optional: an older server sends a
   * reduced shape or none, and the client then reads `@me`.
   */
  user?: CurrentUser;
}

export interface RegisterBody {
  username: string;
  email: string;
  password: string;
  /**
   * The invite the visitor arrived through. A server with closed sign-up
   * registers ONLY a body carrying a valid one, and the new account joins
   * that workspace (security Tier 2 #5); an open server honours a valid code
   * the same way.
   */
  invite_code?: string;
}

export interface LoginBody {
  /** Username or email — the server resolves either identifier. */
  identifier: string;
  password: string;
}

export interface PasswordResetRequestBody {
  email: string;
}

export interface PasswordResetCompleteBody {
  token: string;
  new_password: string;
}

// ---------------------------------------------------------------------------
// Notification preferences (notifications plan U2)
//
// A stored row is an OVERRIDE. An entity with no row inherits from the layer
// above it, which is what lets a surface distinguish "you chose this" from
// "this is what reached you".
// ---------------------------------------------------------------------------

/** The layers a notification level can be stored at. */
export type NotificationPreferenceScope = 'account' | 'workspace' | 'channel' | 'thread';

/**
 * What a level permits.
 *
 * The names describe what they override rather than a position in a cascade,
 * so an override reads correctly on its own without the whole hierarchy in
 * view — which is the property Discord's bare All/Mentions/Nothing lacks.
 */
export type NotificationPreferenceLevel = 'all' | 'mentions' | 'mute';

export interface NotificationPreference {
  scope: NotificationPreferenceScope;
  entity_id: string;
  level: NotificationPreferenceLevel;
}

/**
 * Everything `GET /users/@me/notification-preferences` returns.
 *
 * `suppress_broadcasts` is the per-workspace "Suppress @everyone and @here"
 * switch (2026-09-27): the workspace ids where the member opted out of
 * broadcasts. It is its own list rather than a row in `preferences` because
 * it is a boolean, not a level — "Mentions only" INCLUDES broadcasts unless a
 * workspace is listed here. Absent (an older server) reads as empty.
 */
export interface NotificationPreferenceSet {
  preferences: NotificationPreference[];
  suppress_broadcasts: string[];
}

/**
 * What happened when a member asked to be notified on purpose
 * (`POST /users/@me/notifications/test`).
 *
 * A TRANSPORT report, not a delivery verdict: it deliberately skips policy,
 * focus and the preference ladder, because the question it answers is "can
 * this account's devices be reached at all". `targets` is how many
 * registrations the account has; `sent` is how many accepted the push;
 * `outcomes` names what happened to each, one entry per target, so the three
 * failure modes (never registered, endpoint retired, could not sign or reach
 * the push service) stay distinguishable. `note` is present only where there
 * is no per-target outcome to report — currently, zero targets.
 */
export interface NotificationTestResult {
  targets: number;
  sent: number;
  outcomes: string[];
  note?: string | null;
}
