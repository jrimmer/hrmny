/**
 * @cytale/state — central headless store (U17).
 *
 * The layer that turns gateway events (@cytale/protocol dispatches, shared
 * with U15/U28) and REST reads (@cytale/api-client + @cytale/domain) into
 * rendered UI state. Zustand vanilla store — no React imports; apps/web
 * (U18+) consumes it via `createStateStore()` or the module default.
 *
 * Design notes (from the plan's U17 section):
 * - Messages are held per channel and per thread, newest-first (snowflake
 *   id order), cursor-paginated with an `oldestId` cursor and a
 *   `hasCompleteHistory` flag.
 * - `lastSeq` tracks the last applied dispatch sequence; RESUMED replays
 *   apply from seq+1 (see reconcile.ts).
 * - All ids are decimal strings (>53-bit JSON safety, U2 convention) —
 *   never parsed through numbers.
 */

import { createStore } from 'zustand/vanilla';

import type {
  CallSourceState,
  PresenceStatus,
  Snowflake,
} from '@cytale/protocol';
import type {
  Channel,
  CurrentUser,
  Message,
  Thread,
  UploadedAttachment,
  Workspace,
  WorkspaceMember,
} from '@cytale/domain';

import type { NotificationPrefsState } from './notificationPreferences.js';

// ---------------------------------------------------------------------------
// Slice shapes
// ---------------------------------------------------------------------------

/** Per-channel (or per-thread) message window, newest-first. */
export interface MessageSlice {
  /** Newest-first. Optimistic placeholder rows sort among real messages. */
  items: Message[];
  /** Cursor for the next older page (`before=`); null until a page lands. */
  oldestId: Snowflake | null;
  /** True when a short page proved there is no older history. */
  hasCompleteHistory: boolean;
  /**
   * True when the window is DETACHED from the live edge (#9): paging older
   * past `MESSAGE_SLICE_MAX` trimmed rows off the NEWEST end, so newer
   * history exists on the server that the window does not hold. While set, a
   * live message is not slid in (it would sit above a gap); the reader pages
   * forward (`after=`) until a short page re-attaches the window. Absent =
   * attached, the common case.
   */
  hasNewer?: boolean;
  /**
   * The reader is scrolled UP in this window (#9): the oldest rows are the
   * ones on screen, so a full window must not evict them to make room for a
   * live message. Set by the rendering list (`setMessageWindowHold`); while it
   * is set an over-cap live message detaches the window (`hasNewer`) instead.
   */
  holdOldest?: boolean;
}

export interface UnreadState {
  /** Last read message id (null = nothing read). */
  last_read_id: Snowflake | null;
  /** Messages newer than last_read_id, excluding my own. */
  unread_count: number;
  /** Subset of unread that mention me. */
  mention_count: number;
  /**
   * Exclusive read floor (R17 "mark unread"): the message it names and
   * everything after it is UNREAD, whatever the watermark claims — an ack
   * owns `last_read_id` only and must never clear a range the member marked
   * by hand (`apps/server/lib/cytale/messages/read_state.ex`). Folded from
   * READ_STATE_SYNC / MESSAGE_ACK; ELIDED when the server reports none, the
   * way `CallParticipantState.sources` elides its empty case (absent and
   * null mean the same thing here).
   */
  unread_floor?: Snowflake | null;
  /**
   * The server's own unread count for this channel (R22a). It is the ONLY
   * count that covers a channel this client has had no traffic on: the local
   * `unread_count` accrues from live gateway dispatches, so a channel the
   * member has not opened shows zero locally. `null`/absent = the server has
   * not reported one (a row-less channel, or an older server), and the badge
   * falls back to the local count — never to zero.
   *
   * The field is protocol's `ReadStateSyncEntry.unread_count` — reconcile
   * folds it straight off the typed entry, present-or-absent.
   */
  server_unread_count?: number | null;
  /**
   * The server's unread MENTION count for this channel (lane D #2) — the
   * durable "@" half of the badge, reported by READ_STATE_SYNC /
   * READ_STATE_UPDATE. Same contract as `server_unread_count`: `null`/absent
   * = not reported (fall back to the local count), never zero.
   *
   * Both server counts are SNAPSHOTS taken when the sync was computed; the
   * local `unread_count` / `mention_count` then count what arrived AFTER it
   * (the fold resets them when a server count lands), so a badge is always
   * `server ?? 0` + local — see `channelUnreadCount` / `channelMentionCount`.
   */
  server_mention_count?: number | null;
}

export interface PresenceEntry {
  status: PresenceStatus;
  last_seen_at: string;
}

// ---------------------------------------------------------------------------
// Voice-call slices (calls plan U6)
// ---------------------------------------------------------------------------

/**
 * One stored voice leg (AM8: one voice state per user per call). Mute/deafen
 * are the server-visible states; `leg` is the latest session discriminator
 * seen for the user on the wire (null when the roster was only projected —
 * CALL_SYNC and GET /channels/{id}/call carry no leg).
 *
 * V2 (calls plan U4): `sources` lists the participant's live published
 * sources (`camera` / `screen` / `screen_audio` — the roster's source
 * state, R3/KTD1). ELIDED when empty: absent and empty mean the same thing
 * (audio-only participant), and omitting keeps V1-shaped snapshots
 * reference-identical for source-less rosters.
 */
export interface CallParticipantState {
  user_id: Snowflake;
  mute: boolean;
  deafen: boolean;
  leg: string | null;
  /** Live published sources; absent/empty = audio-only participant. */
  sources?: CallSourceState[];
}

/**
 * A live call as the store models it. `started_by`/`started_at` are null
 * when the call was learned via CALL_SYNC alone (that snapshot carries only
 * the roster — the boundary metadata rides CALL_START and REST); a
 * same-call_id sync preserves whatever is already known.
 */
export interface LiveCall {
  call_id: Snowflake;
  /** The channel's standing call-log thread; null on DM calls (R11). */
  thread_id: Snowflake | null;
  started_by: Snowflake | null;
  started_at: string | null;
  /** Voice legs keyed by user id. */
  participants: Record<Snowflake, CallParticipantState>;
}

/**
 * Ephemeral ring notification (calls plan U6): never persisted, never
 * derived twice — CALL_RING writes it once per call (call_id dedupe), the
 * ring UX (U11) owns the ~30 s expiry and clears it via `clearCallRing`
 * (U10's missed-call derivation reads it before clearing). Mirrors the
 * typing-indicator model: timestamped, consumer-expired, no timers here.
 */
export interface CallRingEntry {
  call_id: Snowflake;
  from_user: Snowflake;
  /** Unix epoch ms when the ring dispatch arrived (wire carries no clock). */
  rang_at: number;
}

/** Lifecycle of the gateway session feeding this store. */
export type SessionStatus = 'fresh' | 'ready' | 'resumed';

export interface PendingSend {
  /** Placeholder id used in messagesByChannel until confirmation. */
  messageId: Snowflake;
  channel_id: Snowflake;
  thread_id: Snowflake | null;
  content: string;
  status: 'pending';
  /** The inline-reply reference the send carries (retry resends it). */
  reply_to_id?: Snowflake | null;
  /** Already-uploaded attachment descriptors the send binds (retry resends them). */
  attachments?: UploadedAttachment[];
}

export interface FailedSend {
  channel_id: Snowflake;
  thread_id: Snowflake | null;
  content: string;
  error: { key: string; code: number; message: string };
  failedAt: number;
  /** See PendingSend: a retry presents the same reply reference… */
  reply_to_id?: Snowflake | null;
  /** …and the same attachments. */
  attachments?: UploadedAttachment[];
  /**
   * True when the failed row STAYS in its timeline (`holdFailedSend`, the
   * web's Discord-style failed row); absent when the row was removed
   * (`failOptimisticSend`, the mobile/TUI contract).
   */
  held?: boolean;
}

export interface StateState {
  // -- identity / session --------------------------------------------------
  currentUser: {
    id: Snowflake;
    username: string;
    /** The account's display name (#168); kept live by UserUpdate. */
    display_name?: string | null;
    avatar_url?: string | null;
  } | null;
  sessionStatus: SessionStatus;
  /**
   * Sequence of the last applied dispatch event.
   *
   * NOT REACTIVE (lane D #17). Every dispatch advances it, so while it rode
   * the store's writes a typing tick (which changes nothing else) notified
   * every subscriber in the app. It is advanced IN PLACE on the live state
   * object (`advanceLastSeq` in reconcile.ts) — `getState().lastSeq` stays the
   * live watermark for every reader (the reaction seams' replay gates, the
   * synthetic-seq allocators, the e2e probes) — and a subscriber can never be
   * notified BY it. Never select it in a React hook: it will look frozen.
   */
  lastSeq: number;
  /**
   * Monotonic count of READY dispatches applied — i.e. fresh gateway
   * sessions on THIS client. Consumers re-hydrate REST state when it
   * advances (anything missed while fully disconnected converges without a
   * reload). Never resets; Resumed does not bump (replay covers the gap).
   */
  sessionEpoch: number;
  /**
   * The server's media-plane master switch (ticket #124, READY's
   * `media_enabled`). Default TRUE: the default deployment behaves exactly
   * as today, and a server predating the switch (field absent on READY)
   * reads as enabled — there, permissions alone govern calls. false hides
   * the Start-call affordances behind an HONEST "calls are off on this
   * server" state (hidden-because-disabled must stay distinguishable from
   * not-built); the authoritative gate is server-side either way.
   */
  mediaEnabled: boolean;

  /**
   * Where the entity roster (workspaces / channels) came from, so a shell can
   * tell "the member has no workspaces" from "nothing has loaded yet"
   * (lane D #3): `'none'` until a roster lands, `'cache'` once a persisted
   * device snapshot was restored (lane D #8), `'server'` once READY's roster
   * or a REST hydration replaced it. Only ever moves forward within a
   * session; `resetForFreshSession` (logout) returns it to `'none'`.
   */
  rosterSource: 'none' | 'cache' | 'server';

  // -- entities -------------------------------------------------------------
  workspaces: Record<Snowflake, Workspace>;
  channels: Record<Snowflake, Channel>;
  threadsById: Record<Snowflake, Thread>;
  threadIdsByChannel: Record<Snowflake, Snowflake[]>;
  membersById: Record<Snowflake, WorkspaceMember>;
  memberIdsByWorkspace: Record<Snowflake, Snowflake[]>;
  /**
   * Per-workspace nicknames (#169): workspace id → user id → nickname. A
   * nickname belongs to one workspace, so it never rides the global member
   * row (whose `nickname` the writers keep null). See `nicknames.ts`.
   */
  nicknamesByWorkspace: Record<Snowflake, Record<Snowflake, string>>;

  // -- messages (channel panes + thread panes) ------------------------------
  messagesByChannel: Record<Snowflake, MessageSlice>;
  messagesByThread: Record<Snowflake, MessageSlice>;
  /**
   * channel -> newest message id this client has seen (gateway MESSAGE_CREATE
   * + REST page merges). A NARROW slice on purpose: the fact used to live on
   * the channel record, so every message re-identified `channels` and every
   * `channels` consumer re-derived per message (the mobile drawer re-filtered
   * and re-sorted every channel in every workspace). Recency surfaces — the
   * home DM column's ordering — subscribe HERE; the `Channel.last_message_id`
   * a REST hydration writes stays as the fallback for channels with no live
   * message yet. Absent = nothing observed; only ever advances.
   */
  lastMessageIdByChannel: Record<Snowflake, Snowflake>;
  /**
   * Most-recently-OPENED channels, newest first (lane D #16). The memory
   * bound for message slices (`touchChannel` trims the channels that fall
   * out of it back to one page) and the set a device snapshot persists
   * messages for (lane D #8). Capped at `RECENT_CHANNELS_MAX`.
   */
  recentChannelIds: Snowflake[];

  // -- unread / presence ----------------------------------------------------
  unreadByChannel: Record<Snowflake, UnreadState>;
  unreadByThread: Record<Snowflake, UnreadState>;
  presenceByUser: Record<Snowflake, PresenceEntry>;

  // -- voice calls (calls plan U6) -------------------------------------------
  /** Live room calls by channel; absence = no live call. */
  callByChannel: Record<Snowflake, LiveCall | undefined>;
  /**
   * Live DM calls by channel (same shape, `thread_id: null` — DM calls keep
   * no durable artifact, R11). Listed separately so room surfaces can never
   * mistake a DM call for a channel call.
   */
  dmCallByChannel: Record<Snowflake, LiveCall | undefined>;
  /**
   * channel -> standing call-log thread id (R4/R5 — the security-reviewed
   * exclusion key). Learned from CALL_START / CALL_SYNC thread ids in
   * reconcile AND, on demand, from GET /channels/{id}/call via
   * `setCallLogThread` (U9's log surfaces; the client never guesses it by
   * name). Hydration contract (deliberate — no batch fetch): CALL_SYNC over
   * the gateway covers every visible LIVE call on Identify/Resume; for idle
   * channels the standing thread id arrives exactly when a surface opens
   * the call log (U9 calls getCall). The mapping is durable per channel —
   * it survives CALL_END (the standing thread is reused by every later
   * call) and is only upserted, never cleared per-call. A fresh READY
   * resets it with the rest of the transient state and CALL_SYNC re-seeds
   * the live subset.
   */
  callLogThreadIdByChannel: Record<Snowflake, Snowflake>;
  /**
   * Ephemeral ring notifications by channel (CALL_RING; deduped by call_id —
   * see CallRingEntry). Consumers clear via `clearCallRing`; CALL_END does
   * NOT clear it so the missed-call derivation (U10) can still read it.
   */
  callRingByChannel: Record<Snowflake, CallRingEntry | undefined>;

  // -- optimistic send tracking ----------------------------------------------
  /** nonce -> pending send (nonce keys also index the optimistic row). */
  pendingByNonce: Record<string, PendingSend>;
  failedByNonce: Record<string, FailedSend>;
  /** optimistic placeholder id -> nonce (for getNonce lookups). */
  nonceByMessageId: Record<Snowflake, string>;

  // -- notification preferences (notification controls, 2026-09-27) ----------
  /**
   * The member's stored levels and broadcast switches — the ONE copy every
   * surface reads (see notificationPreferences.ts). Member data: cleared on
   * logout, untouched by a fresh READY (the REST hydrate owns it).
   */
  notificationPrefs: NotificationPrefsState;
}

export type StateStore = ReturnType<typeof createStateStore>;

/** How many recently-opened channels keep their full scrollback (lane D #16). */
export const RECENT_CHANNELS_MAX = 10;

/** Rows an evicted channel keeps: one REST page (lane D #16). */
export const EVICTED_SLICE_ROWS = 50;

// ---------------------------------------------------------------------------
// Message ordering primitives (shared by reconcile.ts and optimistic.ts)
// ---------------------------------------------------------------------------

/** True iff snowflake `a` is strictly newer than `b` (BigInt-free exact compare). */
export function isNewer(a: Snowflake, b: Snowflake): boolean {
  if (a.length !== b.length) return a.length > b.length;
  return a > b;
}

/** Snowflake epoch (Discord's, 2015-01-01) — `@cytale/domain`'s DISCORD_EPOCH. */
const SNOWFLAKE_EPOCH_MS = 1_420_070_400_000;

/** Placeholder rows (`pending_<nonce>`) carry no snowflake of their own. */
function isPlaceholderRowId(id: string): boolean {
  return id.startsWith('pending_');
}

const placeholderSortKeys = new WeakMap<Message, string>();

/**
 * The ordering key of a row: its id for a real message, and for an
 * optimistic placeholder the snowflake a message minted at its `created_at`
 * would carry (lane D #12).
 *
 * The placeholder id `pending_<nonce>` is longer than any snowflake, so under
 * the plain id rule it sorted ABOVE every real row — always the head, even
 * when a message from someone else landed after it was sent. On confirmation
 * the server row then took its real position and the row jumped. Keyed by
 * time instead, the pending row sits where the confirmed one will. The low
 * bits are saturated so a placeholder sorts after every real row minted in
 * the same millisecond (it is the newest thing its author has seen).
 */
export function messageSortKey(message: Message): string {
  if (!isPlaceholderRowId(message.id)) return message.id;
  const cached = placeholderSortKeys.get(message);
  if (cached !== undefined) return cached;
  const ms = Date.parse(message.created_at);
  const key = Number.isFinite(ms)
    ? ((BigInt(Math.max(0, ms - SNOWFLAKE_EPOCH_MS)) << 22n) | 0x3fffffn).toString()
    : // An unparseable timestamp keeps the old rule (the head) rather than
      // guessing a position.
      message.id;
  placeholderSortKeys.set(message, key);
  return key;
}

/**
 * Newest-first comparator for message rows. Exported so every writer of a
 * slice sorts by the SAME rule (`isNewer`'s length-then-lexicographic one over
 * `messageSortKey`) — two comparators over one array would break the insert's
 * binary search.
 */
export function compareNewestFirst(a: Message, b: Message): number {
  const ka = messageSortKey(a);
  const kb = messageSortKey(b);
  if (isNewer(ka, kb)) return -1;
  if (isNewer(kb, ka)) return 1;
  return 0;
}

/**
 * Retained rows per message slice (channel or thread), newest-first — the
 * bound that keeps `insertNewestFirst`'s per-insert copy from growing with a
 * channel's whole history (hardening plan 7.6).
 *
 * One insert copies the array, so an unbounded window makes every inbound
 * message O(n) in everything loaded so far. 500 rows is ten of the clients'
 * shared 50-row REST page (web `MessageList.PAGE_SIZE`, mobile
 * `MESSAGE_PAGE_SIZE`) — comfortably above the multi-page scrollback the
 * product exercises (the web scrollback regression seeds 350 rows / 7 pages)
 * while capping the copy at a known size.
 *
 * A LIVE row that lands OUTSIDE a full window is dropped, not slid in:
 * evicting the oldest row to make room would change the slice's array identity
 * without keeping the incoming row. Newest traffic always wins — an over-cap
 * insert that is NEWER than the window's oldest row evicts that row instead,
 * which `[message, ...items]` already does one row at a time.
 *
 * REST PAGES do not go through that rule (#9): `mergePageIntoWindow` trims the
 * window at the end away from the page, so paging older past the cap keeps
 * working — the window slides toward history and records `hasNewer`.
 */
export const MESSAGE_SLICE_MAX = 500;

/**
 * Insert one row into a NEWEST-FIRST array, keeping it sorted.
 *
 * One O(log n) boundary search plus one O(n) copy — no whole-array compare
 * sweep (the old append-and-sort ran ~2,000 comparator calls per message at
 * 250 rows). Live traffic is newest, so the prepend probe is the common path;
 * a row whose id is already present returns the SAME array reference, letting
 * callers skip the write entirely.
 *
 * Precondition: `items` is sorted by `compareNewestFirst` — every slice writer
 * in this package (reconcile, optimistic) maintains that.
 *
 * The result never exceeds `MESSAGE_SLICE_MAX` (see there for the window rule).
 */
export function insertNewestFirst(items: readonly Message[], message: Message): Message[] {
  const head = items[0];
  if (head === undefined) return [message];
  const key = messageSortKey(message);
  if (isNewer(key, messageSortKey(head))) {
    const next = [message, ...items];
    if (next.length > MESSAGE_SLICE_MAX) next.length = MESSAGE_SLICE_MAX;
    return next;
  }

  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    // "message is newer than items[mid]" holds for every OLDER row, so the
    // first index where it holds is where the message belongs.
    if (isNewer(key, messageSortKey(items[mid]!))) hi = mid;
    else lo = mid + 1;
  }
  // Duplicates are adjacent in a sorted array — checking the boundary's
  // neighbours keeps the probe O(1).
  if (items[lo]?.id === message.id || items[lo - 1]?.id === message.id) {
    return items as Message[];
  }
  // A full window and a row that sorts at/past its oldest entry: outside the
  // window. Drop it by returning the SAME array (see MESSAGE_SLICE_MAX) —
  // sliding would churn identity without ever keeping the row.
  if (items.length >= MESSAGE_SLICE_MAX && lo === items.length) {
    return items as Message[];
  }
  const next = items.slice();
  next.splice(lo, 0, message);
  // A row inside a full window is kept; the oldest retained row makes room.
  if (next.length > MESSAGE_SLICE_MAX) next.length = MESSAGE_SLICE_MAX;
  return next;
}

// ---------------------------------------------------------------------------
// Pending placeholders stay below every real row (optimistic send, 2026-09-28)
// ---------------------------------------------------------------------------

/** The last timestamp handed to a placeholder (see `nextPlaceholderTimestamp`). */
let lastPlaceholderMs = 0;

/**
 * A placeholder's `created_at`: now, but strictly after every placeholder
 * timestamp handed out (or lifted to) before. A burst inside one millisecond
 * would otherwise mint rows with the SAME sort key (`messageSortKey`
 * saturates the low bits), and a tie has no defined order — five rapid sends
 * could draw out of the order they were typed in.
 */
export function nextPlaceholderTimestamp(): string {
  const now = Date.now();
  lastPlaceholderMs = now > lastPlaceholderMs ? now : lastPlaceholderMs + 1;
  return new Date(lastPlaceholderMs).toISOString();
}

/** A snowflake's mint time (ms since the Unix epoch), or null for a non-snowflake. */
function snowflakeMs(id: string): number | null {
  if (!/^\d+$/.test(id)) return null;
  return Number(BigInt(id) >> 22n) + SNOWFLAKE_EPOCH_MS;
}

/**
 * Keep every PENDING placeholder below `anchor`, a real row that just landed
 * in the slice (the Discord rule: what you are still sending sits at the
 * bottom until it is confirmed).
 *
 * A placeholder sorts by the moment it was drawn, a server row by the moment
 * the server minted it — and in a burst the second message is drawn BEFORE
 * the first one reaches the server. The first one's confirmed row then sorted
 * BELOW the still-pending second (rows swapped under the reader, then swapped
 * back when the second confirmed); a peer's message landing mid-send did the
 * same. Placeholders at or below the anchor are re-timed just above it, in
 * their own order, so the confirmed row takes its place and the pending ones
 * stay under it. Held failed rows are left where they are.
 *
 * Returns the SAME array when nothing had to move.
 */
export function liftPendingPlaceholders(items: Message[], anchor: Message): Message[] {
  if (isPlaceholderRowId(anchor.id)) return items;
  const anchorMs = snowflakeMs(anchor.id);
  if (anchorMs === null) return items;
  let lifted: Message[] | null = null;
  const rest: Message[] = [];
  for (const row of items) {
    if (
      isPlaceholderRowId(row.id) &&
      row.send_state === 'pending' &&
      !isNewer(messageSortKey(row), anchor.id)
    ) {
      (lifted ??= []).push(row);
    } else {
      rest.push(row);
    }
  }
  if (lifted === null) return items;
  let t = anchorMs;
  let out = rest;
  // Oldest first, so the lifted rows keep their relative order.
  for (let i = lifted.length - 1; i >= 0; i -= 1) {
    const row = lifted[i]!;
    const own = Date.parse(row.created_at);
    t = Math.max(t + 1, Number.isFinite(own) ? own : 0);
    out = insertNewestFirst(out, { ...row, created_at: new Date(t).toISOString() });
  }
  if (t > lastPlaceholderMs) lastPlaceholderMs = t;
  return out;
}

/**
 * Insert one LIVE row (gateway dispatch, optimistic send) into a slice,
 * respecting the window's two ends (#9):
 *
 *   * a DETACHED window (`hasNewer`) does not take a row newer than its head —
 *     the rows between are not loaded, so the new one would sit above a gap;
 *     forward paging brings it in order. The sender's own placeholder is the
 *     exception: the host jumps the view to the present when it sees one.
 *   * a HELD window (`holdOldest`, the reader scrolled up) that is full does
 *     not evict its oldest row — that is the row on screen — so the incoming
 *     newest row detaches the window instead.
 *
 * Otherwise this is `insertNewestFirst`, and an eviction of the oldest row
 * clears `hasCompleteHistory`: the evicted rows are history again.
 */
export function insertIntoWindow(slice: MessageSlice, message: Message): MessageSlice {
  const head = slice.items[0];
  const newest = head !== undefined && isNewer(messageSortKey(message), messageSortKey(head));
  if (newest && !isPlaceholderRowId(message.id)) {
    if (slice.hasNewer === true) return slice;
    if (slice.holdOldest === true && slice.items.length >= MESSAGE_SLICE_MAX) {
      return { ...slice, hasNewer: true };
    }
  }
  const items = insertNewestFirst(slice.items, message);
  if (items === slice.items) return slice;
  const evicted = items.length === slice.items.length;
  if (!evicted) return { ...slice, items };
  const oldest = items[items.length - 1];
  return {
    ...slice,
    items,
    oldestId: oldest?.id ?? slice.oldestId,
    hasCompleteHistory: false,
  };
}

/** Which end of the window a REST page extends (see `mergePageIntoWindow`). */
export type PageDirection = 'older' | 'newer' | 'newest';

/**
 * Merge a REST page into a slice, trimming the window at the end AWAY from
 * the page (#9). The cap used to be enforced by `insertNewestFirst`, which
 * drops any row older than a full window — so an OLDER page past ten pages
 * merged nothing, the list never saw older history, and its "Loading older…"
 * flashed forever. Now:
 *
 *   * `older`  — rows join the old end; a window over the cap sheds its
 *                NEWEST rows and records `hasNewer` (the reader is deep in
 *                history; the live edge is paged back in on the way down);
 *   * `newer`  — rows join the new end (forward paging); the OLDEST rows are
 *                shed and `hasCompleteHistory` clears; a short page
 *                (`isLastPage`) re-attaches the window to the live edge;
 *   * `newest` — the latest page. On an attached window it merges like a live
 *                burst (oldest shed); on a detached one it REPLACES the window
 *                (the rows between are unknown), keeping unsent placeholders.
 *
 * Existing rows win over their page copy (they may carry richer local state —
 * reactions, a client key), matching the old per-row upsert.
 */
export function mergePageIntoWindow(
  slice: MessageSlice,
  page: readonly Message[],
  direction: PageDirection,
  isLastPage: boolean,
  /** The caller KNOWS this is the latest page (not an inferred direction, and
   *  not an `after=` page, which is newer than the window by construction). */
  latestPage = false,
): MessageSlice {
  // A newest page REPLACES the window when the window is detached, or when
  // the page does not reach it (its oldest row is newer than the newest one
  // held — lane D #23): either way the rows between are unknown, and merging
  // would splice two windows around a hole no pager can find.
  const newestHeld = slice.items.find((m) => !isPlaceholderRowId(m.id));
  const pageOldest = page[page.length - 1];
  const disjoint =
    newestHeld !== undefined && pageOldest !== undefined && isNewer(pageOldest.id, newestHeld.id);
  const detached = slice.hasNewer === true || (direction === 'newest' && latestPage && disjoint);
  const base =
    direction === 'newest' && detached
      ? slice.items.filter((m) => isPlaceholderRowId(m.id))
      : slice.items;
  const known = new Set(base.map((m) => m.id));
  const fresh: Message[] = [];
  for (const m of page) {
    if (known.has(m.id)) continue;
    known.add(m.id);
    fresh.push(m);
  }
  let items: Message[] = fresh.length === 0 ? (base as Message[]) : [...base, ...fresh].sort(compareNewestFirst);
  let hasNewer = direction === 'newest' ? false : slice.hasNewer === true;
  let hasCompleteHistory =
    direction === 'newest' && detached ? isLastPage : slice.hasCompleteHistory;
  // A short older page, or a short LATEST page (the channel's whole history
  // fits in one page), proves there is nothing older.
  if (direction !== 'newer' && isLastPage) hasCompleteHistory = true;
  if (direction === 'newer' && isLastPage) hasNewer = false;

  if (items.length > MESSAGE_SLICE_MAX) {
    if (direction === 'older') {
      items = items.slice(items.length - MESSAGE_SLICE_MAX);
      hasNewer = true;
    } else {
      items = items.slice(0, MESSAGE_SLICE_MAX);
      hasCompleteHistory = false;
    }
  }
  if (
    items === slice.items &&
    hasNewer === (slice.hasNewer === true) &&
    hasCompleteHistory === slice.hasCompleteHistory
  ) {
    return slice;
  }
  const oldest = items[items.length - 1];
  const next: MessageSlice = {
    ...slice,
    items,
    oldestId: oldest?.id ?? slice.oldestId,
    hasCompleteHistory,
  };
  if (hasNewer) next.hasNewer = true;
  else delete next.hasNewer;
  return next;
}

/**
 * Write a partial only when it actually changes something.
 *
 * zustand 5 compares the PARTIAL handed to `setState`, not the state it
 * produces: an updater returning `{}` — or the same slice references — still
 * allocates a fresh top-level state and notifies every subscriber, and every
 * subscriber then re-runs its selector. Callers whose updater can decide "no
 * change" (an already-read channel, an unknown thread) must therefore skip
 * `setState` altogether; that guard cannot live in the updater, so it lives
 * here.
 */
export function setStateIfChanged(
  store: StateStore,
  updater: (state: StateState) => Partial<StateState>,
): void {
  const state = store.getState();
  const partial = updater(state);
  if (hasChanges(state, partial)) store.setState(partial);
}

/** True when any key of `partial` differs (by reference or value) from `state`. */
export function hasChanges(state: StateState, partial: Partial<StateState>): boolean {
  const base = state as unknown as Record<string, unknown>;
  const next = partial as unknown as Record<string, unknown>;
  for (const key of Object.keys(next)) {
    if (!Object.is(next[key], base[key])) return true;
  }
  return false;
}

export function createStateStore() {
  return createStore<StateState>()((_) => ({
    currentUser: null,
    sessionStatus: 'fresh',
    lastSeq: 0,
    sessionEpoch: 0,
    mediaEnabled: true,
    rosterSource: 'none',

    workspaces: {},
    channels: {},
    threadsById: {},
    threadIdsByChannel: {},
    membersById: {},
    memberIdsByWorkspace: {},
    nicknamesByWorkspace: {},

    messagesByChannel: {},
    messagesByThread: {},
    lastMessageIdByChannel: {},
    recentChannelIds: [],

    unreadByChannel: {},
    unreadByThread: {},
    presenceByUser: {},

    callByChannel: {},
    dmCallByChannel: {},
    callLogThreadIdByChannel: {},
    callRingByChannel: {},

    pendingByNonce: {},
    failedByNonce: {},
    nonceByMessageId: {},

    // Inline rather than `emptyNotificationPrefs()`: that module imports this
    // one, and a value import back would make the pair a runtime cycle.
    notificationPrefs: { overrides: {}, suppressBroadcasts: {}, status: 'idle' },
  }));
}
