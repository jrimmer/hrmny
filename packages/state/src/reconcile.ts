/**
 * @cytale/state — gateway event application + REST merge (U17 reconcile).
 *
 * Every gateway dispatch (from @cytale/protocol's exhaustive EventPayloadMap)
 * mutates the store through `applyGatewayEvent`. Wire encode/decode stays in
 * @cytale/protocol — this module never redefines payload shapes, so the U28
 * harness and this consumer cannot drift.
 *
 * Ordering guarantees:
 * - `lastSeq` gates replays: a dispatch whose `s` is <= the applied lastSeq
 *   is dropped (idempotent resume replay — AE2's "no duplicates").
 * - Synthetic-space events (s > SYNTHETIC_SEQ_FLOOR, stamped by this
 *   package's `nextSyntheticSeq()` — see syntheticSeq.ts) always apply and
 *   never advance `lastSeq`, so a local reconcile can never raise the
 *   watermark above the real stream (#143).
 * - Message rows are kept newest-first by snowflake id (ids sort by
 *   generation time), so out-of-order arrival renders correctly.
 * - Fresh READY resets only SESSION-scoped state (the sequence, calls, rings,
 *   presence); entity and message slices stay as stale data until their
 *   replacement lands whole (lane D #1). RESUMED only marks the session.
 */

import type {
  CallParticipant,
  CallSourceState,
  CallUpdate,
  GatewayEvent,
  MemberAdd,
  ReadStateSyncEntry,
  Snowflake,
} from '@cytale/protocol';
import { compareSnowflakes, normalizeChannelType } from '@cytale/domain';
import type { Message, Thread, WorkspaceMember } from '@cytale/domain';

import { messageAddressesMe } from './notificationPreferences.js';
import { rosterFromReady, rosterPatch } from './roster.js';
import {
  hasChanges,
  insertIntoWindow,
  isNewer,
  liftPendingPlaceholders,
  mergePageIntoWindow,
  type PageDirection,
  type CallParticipantState,
  type LiveCall,
  type MessageSlice,
  type StateState,
  type StateStore,
  type UnreadState,
} from './store.js';
import { SYNTHETIC_SEQ_FLOOR } from './syntheticSeq.js';
import { isUnreadByReadState, resetChannelBadgeMemo } from './unread.js';
import { withNickname } from './nicknames.js';

// ---------------------------------------------------------------------------
// The non-reactive watermark (lane D #17)
// ---------------------------------------------------------------------------

/**
 * Advance `lastSeq` IN PLACE on the live state object — no store write, no
 * notification (see `StateState.lastSeq`). Every dispatch advances it, so as a
 * store write it made a typing tick (which changes nothing else the store
 * models) notify every subscriber in the app. Readers still see the live value
 * through `getState().lastSeq`; the next real commit copies it forward
 * (zustand builds the next state from the current object).
 */
export function advanceLastSeq(store: StateStore, seq: number): void {
  (store.getState() as { lastSeq: number }).lastSeq = seq;
}

// ---------------------------------------------------------------------------
// Message slice primitives (ordering lives in store.ts — one rule, one owner)
// ---------------------------------------------------------------------------

function emptySlice(): MessageSlice {
  return { items: [], oldestId: null, hasCompleteHistory: false };
}

/**
 * Insert a message into a slice, newest-first, dropping exact id duplicates.
 * Returns the same slice when the id is already present (`insertNewestFirst`
 * hands back the same array), so a duplicate dispatch changes nothing. The
 * window's ends are respected (`insertIntoWindow`, #9).
 */
function upsertMessage(slice: MessageSlice, message: Message): MessageSlice {
  return insertIntoWindow(slice, message);
}

/** True when a reply at `at` is strictly newer than the summary's latest (none = newer). */
function isNewerReply(at: string, latest: string | null | undefined): boolean {
  if (!latest) return true;
  const a = Date.parse(at);
  const b = Date.parse(latest);
  return Number.isNaN(a) || Number.isNaN(b) ? at > latest : a > b;
}

/**
 * A thread's seed message from a ThreadCreate / ThreadUpdate: the anchor the
 * event STATES wins; an event that leaves the key out (a server that predates
 * it) keeps the one already held. Absent means "not stated", never "none".
 */
function anchorOf(
  event: { parent_message_id?: string | null },
  existing: Thread | undefined,
): string | null {
  return event.parent_message_id ?? existing?.parent_message_id ?? null;
}

/** Remove a message by id; returns the same slice reference when absent. */
function removeMessage(slice: MessageSlice, id: string): MessageSlice {
  if (!slice.items.some((m) => m.id === id)) return slice;
  return { ...slice, items: slice.items.filter((m) => m.id !== id) };
}

function patchMessage(slice: MessageSlice, id: string, patch: Partial<Message>): MessageSlice {
  return {
    ...slice,
    items: slice.items.map((m) => (m.id === id ? { ...m, ...patch } : m)),
  };
}

// ---------------------------------------------------------------------------
// Unread accrual (write-through here; derivation helpers in unread.ts)
// ---------------------------------------------------------------------------

function accrueUnreadForMessage(
  writer: DispatchWriter,
  key: 'unreadByChannel' | 'unreadByThread',
  id: string,
  message: Message,
): void {
  const state = writer.state();
  const me = state.currentUser;
  if (me && message.author_id === me.id) return; // my own messages never accrue

  const current = state[key][id];
  // "Addressed to me" is the badge's @ half: a direct mention, or (2026-09-27)
  // an @everyone/@here in a workspace the member has not suppressed — the
  // same rule the server's inbox recorder applies, so a live count and the
  // count a reload hydrates agree. A thread reply may arrive before its
  // thread's first page, so its channel falls back to the thread record.
  const channelId =
    message.channel_id ||
    (message.thread_id ? (state.threadsById[message.thread_id]?.channel_id ?? '') : '');
  const mentionsMe = messageAddressesMe(state, { ...message, channel_id: channelId });

  writer.write((s) => ({
    [key]: {
      ...s[key],
      [id]: {
        // Carried through, not rebuilt: a new message must not drop the
        // exclusive floor (or the server's count) the entry already holds.
        ...current,
        last_read_id: current?.last_read_id ?? null,
        unread_count: (current?.unread_count ?? 0) + 1,
        mention_count: (current?.mention_count ?? 0) + (mentionsMe ? 1 : 0),
      },
    },
  }));
}

/**
 * The inverse of `accrueUnreadForMessage`, for a deleted row this store held:
 * when the row was still unread for me (not mine, above the watermark or at
 * the floor), its unit comes back off the badge — and off the @ half when it
 * addressed me. The live accrual is spent first; once it is exhausted the
 * unit comes off the server's snapshot, which counted the rows that predate
 * it. Neither count goes below zero. Returns the map unchanged (same
 * reference) when nothing moves, so an unaffected delete writes nothing.
 */
function releaseDeletedUnread(
  state: StateState,
  map: Record<Snowflake, UnreadState>,
  id: Snowflake,
  row: Message,
): Record<Snowflake, UnreadState> {
  const current = map[id];
  if (current === undefined) return map;
  const me = state.currentUser;
  if (me && row.author_id === me.id) return map; // mine never accrued
  if (!isUnreadByReadState(row.id, current.last_read_id ?? null, current.unread_floor ?? null)) return map;

  const take = (local: number, server: number | null | undefined): [number, number | null | undefined] =>
    local > 0 ? [local - 1, server] : server != null && server > 0 ? [local, server - 1] : [local, server];

  const [unread_count, server_unread_count] = take(current.unread_count, current.server_unread_count);
  const channelId = row.channel_id || (row.thread_id ? (state.threadsById[row.thread_id]?.channel_id ?? '') : '');
  const [mention_count, server_mention_count] = messageAddressesMe(state, { ...row, channel_id: channelId })
    ? take(current.mention_count, current.server_mention_count)
    : [current.mention_count, current.server_mention_count];

  if (
    unread_count === current.unread_count &&
    server_unread_count === current.server_unread_count &&
    mention_count === current.mention_count &&
    server_mention_count === current.server_mention_count
  ) {
    return map;
  }
  const next: UnreadState = { ...current, unread_count, mention_count };
  if (server_unread_count !== undefined) next.server_unread_count = server_unread_count;
  if (server_mention_count !== undefined) next.server_mention_count = server_mention_count;
  return { ...map, [id]: next };
}

// ---------------------------------------------------------------------------
// The server's own unread count (tui plan U11, R22a)
// ---------------------------------------------------------------------------

/**
 * The server's unread count for one READ_STATE_SYNC entry, or null when it did
 * not report one.
 *
 * The entry shape is @cytale/protocol's `ReadStateSyncEntry` — the type the
 * dispatch payload already carries — field-for-field. `unread_count` is
 * optional on the wire, so the read stays present-or-absent rather than
 * trusting a widened cast: a missing field (an older server) or a non-number is
 * "not reported", and the badge then falls back to the locally accrued count
 * rather than to zero.
 */
function serverUnreadCount(entry: ReadStateSyncEntry): number | null {
  const value = entry.unread_count;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The server's mention count for one entry (lane D #2); null = not reported. */
function serverMentionCount(entry: ReadStateSyncEntry): number | null {
  const value = entry.mention_count;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * One server read-state entry folded over the local row (lane D #2).
 *
 * The server's counts are a SNAPSHOT of everything unread when the entry was
 * computed — which includes whatever this client had already accrued locally
 * from live traffic before the entry arrived (the stream is ordered: a message
 * delivered before the sync is one the sync counted). So when the server
 * reports a count, the local accrual RESTARTS at zero and from then on counts
 * only what arrives after — badge = server + local (`channelUnreadCount`).
 * When it reports none (`null` — a storage blip, an older server) the local
 * count is kept as the only signal, never cleared.
 */
function foldServerCounts(
  current: UnreadState | undefined,
  entry: ReadStateSyncEntry,
  lastRead: Snowflake | null,
): UnreadState {
  const unread = serverUnreadCount(entry);
  const mentions = serverMentionCount(entry);
  return {
    last_read_id: lastRead,
    unread_count: unread !== null ? 0 : (current?.unread_count ?? 0),
    mention_count: mentions !== null ? 0 : (current?.mention_count ?? 0),
    unread_floor: entry.unread_floor ?? null,
    server_unread_count: unread,
    server_mention_count: mentions,
  };
}

// ---------------------------------------------------------------------------
// Dispatch write economy
// ---------------------------------------------------------------------------

/**
 * Dispatch-scoped write accumulator. zustand 5 compares the PARTIAL handed to
 * `setState`, not the state it produces, so a branch whose updater returns `{}`
 * — or returns the same slice references — still allocates a fresh top-level
 * state and notifies every subscriber, and each subscriber then re-runs its
 * selector. A dispatch therefore writes through this accumulator and commits
 * ONCE, with the sequence number folded into the same write; keys whose value
 * is reference-identical to the committed state are dropped, so a branch that
 * changed nothing notifies nobody.
 */
interface DispatchWriter {
  /** Committed state with this dispatch's staged writes applied. */
  state(): StateState;
  /** Stage a partial; unchanged keys (and empty results) stage nothing. */
  write(updater: (state: StateState) => Partial<StateState>): void;
  /** True once this dispatch has staged a real change. */
  changed(): boolean;
  /** Commit everything staged as ONE store write (nothing staged = no write). */
  flush(): void;
}

function createDispatchWriter(store: StateStore): DispatchWriter {
  let pending: Partial<StateState> | null = null;
  let staged = false;

  const current = (): StateState => {
    const base = store.getState();
    return pending === null ? base : { ...base, ...pending };
  };

  return {
    state: current,
    write(updater) {
      const base = current();
      const partial = updater(base);
      if (!hasChanges(base, partial)) return;
      pending = { ...(pending ?? {}), ...partial };
      staged = true;
    },
    // Survives the flush: the watermark advance reads it after the commit.
    changed: () => staged,
    flush() {
      const partial = pending;
      pending = null;
      if (partial !== null) store.setState(partial);
    },
  };
}

// ---------------------------------------------------------------------------
// Optimistic-row guard
// ---------------------------------------------------------------------------

/**
 * A gateway MESSAGE_CREATE whose id collides with an optimistic placeholder
 * is ignored — the server row wins when the REST 201 confirms (optimistic.ts
 * replaces the placeholder wholesale).
 */
function isPlaceholderId(id: string): boolean {
  return id.startsWith('pending_');
}

/**
 * The optimistic placeholder a gateway echo of our OWN send stands for.
 *
 * EXACT when the echo carries the send's `nonce` (servers since send
 * reliability B1 echo it on the create's MessageCreate / ThreadMessageCreate):
 * the placeholder is `pending_<nonce>`, and it is the only row that may match.
 * An echo whose nonce names no placeholder here — another member's send, a
 * send from this account's other device, a row already settled — matches
 * NOTHING; it never falls through to the content heuristic, which is what
 * lets two identical in-flight messages ("ok", "ok") settle each on its own
 * row.
 *
 * FALLBACK, for an echo without the key (a server that predates it): the
 * author and the exact content, with two rules that make a burst behave:
 *  - OLDEST first. Sends leave one at a time, in order (the web's per-scope
 *    send queue), so their echoes arrive in order too; with two identical
 *    bodies in flight the first echo belongs to the first send.
 *  - IN-FLIGHT before HELD. A failed/unconfirmed row that is still on screen
 *    (the Discord failed row) is matched only when no in-flight row is: a
 *    fresh "ok" must not retire an earlier failed "ok" the member has not
 *    retried. A held row that IS matched is proof its POST landed after all.
 * (With the key, a held row's own echo is matched exactly — the same proof.)
 */
function findShadowedPlaceholder(
  items: readonly Message[],
  m: { author_id: string; content: string; nonce?: string | null },
): Message | undefined {
  if (typeof m.nonce === 'string' && m.nonce !== '') {
    const id = `pending_${m.nonce}`;
    return items.find((it) => it.id === id && it.author_id === m.author_id);
  }
  let held: Message | undefined;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i]!;
    if (!it.id.startsWith('pending_') || it.author_id !== m.author_id || it.content !== m.content) {
      continue;
    }
    if (it.send_state === 'failed' || it.send_state === 'unconfirmed' || it.send_state === 'waiting') {
      held ??= it;
      continue;
    }
    return it;
  }
  return held;
}

/**
 * A real row that lands while this member has sends in flight: the pending
 * placeholders stay below it (`liftPendingPlaceholders`). Free when nothing
 * is pending — the common case.
 */
function liftAbovePending(s: StateState, slice: MessageSlice, row: Message): MessageSlice {
  if (Object.keys(s.pendingByNonce).length === 0) return slice;
  const items = liftPendingPlaceholders(slice.items, row);
  return items === slice.items ? slice : { ...slice, items };
}

/**
 * A HELD failed/unconfirmed row retired by its echo: the send landed, so its
 * failure record and nonce mapping go in the same write as the row.
 */
function settleHeldFailure(
  s: StateState,
  shadowed: Message,
): Partial<Pick<StateState, 'failedByNonce' | 'nonceByMessageId'>> {
  const nonce = s.nonceByMessageId[shadowed.id] ?? shadowed.client_key;
  if (nonce === undefined || s.failedByNonce[nonce] === undefined) return {};
  const { [nonce]: _landed, ...failedByNonce } = s.failedByNonce;
  const { [shadowed.id]: _id, ...nonceByMessageId } = s.nonceByMessageId;
  return { failedByNonce, nonceByMessageId };
}

// ---------------------------------------------------------------------------
// Call-log exclusion (calls plan U6, R5 — the security-reviewed fix)
// ---------------------------------------------------------------------------

/**
 * True when `threadId` is `channelId`'s standing call-log thread: the message
 * is call-log chatter and must never touch channel surfaces. The mapping is
 * learned from CALL_START / CALL_SYNC thread ids and REST hydration
 * (`setCallLogThread`) — never guessed by thread name.
 */
function isCallLogThreadMessage(
  state: StateState,
  channelId: Snowflake,
  threadId: Snowflake | null,
): boolean {
  return threadId !== null && state.callLogThreadIdByChannel[channelId] === threadId;
}

/** Pure upsert of one channel's standing-thread mapping (durable — R4). */
function withCallLogThread(
  mapping: Record<Snowflake, Snowflake>,
  channelId: Snowflake,
  threadId: Snowflake,
): Record<Snowflake, Snowflake> {
  if (mapping[channelId] === threadId) return mapping;
  return { ...mapping, [channelId]: threadId };
}

// ---------------------------------------------------------------------------
// Voice-call leg transitions (calls plan U6 — AM8 one voice state per user)
// ---------------------------------------------------------------------------

/**
 * Apply one CALL_UPDATE leg transition to a call's participant map.
 *
 * - joined: upsert the leg with fresh server-visible defaults (mute/deafen
 *   false — the wire carries no initial state on join) and NO sources (a
 *   fresh leg has published nothing; re-publishes arrive as source states).
 * - muted/unmuted/deafened/undeafened: flip the server-visible flag and
 *   refresh the leg discriminator; a transition for an unknown leg is a
 *   no-op (replay gap — CALL_SYNC owns roster repair).
 * - camera_on…screen_audio_off (calls V2 plan U4 — the U2 bridge is real
 *   now): mutate that participant's `sources` slice — `*_on` adds the
 *   source (idempotent), `*_off` removes it. The wire event carries no
 *   `since`, so adds synthesize the arrival time (the CallRing precedent:
 *   the store is the only place a wire-less clock lives) — stage-follows
 *   recency (VM4) reads it; CALL_SYNC's authoritative `since` replaces it
 *   wholesale on every sync.
 * - left/displaced/forced_leave: remove the leg (its sources go with it).
 *   Removing the LAST leg does NOT delete the call — CALL_END owns that
 *   (the empty-sweep window, R8).
 *
 * Returns the same map reference when nothing changed (identity-stable).
 */
function applyLegTransition(
  participants: Record<Snowflake, CallParticipantState>,
  update: CallUpdate,
): Record<Snowflake, CallParticipantState> {
  const existing = participants[update.user_id];
  switch (update.state) {
    case 'joined':
      return {
        ...participants,
        [update.user_id]: {
          user_id: update.user_id,
          mute: false,
          deafen: false,
          leg: update.leg,
        },
      };
    case 'muted':
    case 'unmuted':
    case 'deafened':
    case 'undeafened': {
      if (existing === undefined) return participants;
      return {
        ...participants,
        [update.user_id]: {
          ...existing,
          // V1 review-fix 12 (landed with calls V2 U4): deafen IMPLIES
          // self-mute (AM12) — the roster row of a deafened participant
          // never renders unmuted. `undeafened` leaves mute alone: the
          // server emits the paired `unmuted` transition exactly when the
          // composite mute flag dropped (explicit mute keeps it set).
          mute:
            update.state === 'muted' || update.state === 'deafened'
              ? true
              : update.state === 'unmuted'
                ? false
                : existing.mute,
          deafen:
            update.state === 'deafened' ? true : update.state === 'undeafened' ? false : existing.deafen,
          leg: update.leg,
        },
      };
    }
    case 'camera_on':
    case 'screen_on':
    case 'screen_audio_on': {
      if (existing === undefined) return participants;
      return {
        ...participants,
        [update.user_id]: withSource(existing, update, true),
      };
    }
    case 'camera_off':
    case 'screen_off':
    case 'screen_audio_off': {
      if (existing === undefined) return participants;
      return {
        ...participants,
        [update.user_id]: withSource(existing, update, false),
      };
    }
    case 'left':
    case 'displaced':
    case 'forced_leave': {
      if (existing === undefined) return participants;
      const { [update.user_id]: _removed, ...rest } = participants;
      return rest;
    }
  }
}

/** Source-state half of the transition (see applyLegTransition). */
function withSource(
  existing: CallParticipantState,
  update: CallUpdate,
  on: boolean,
): CallParticipantState {
  const source = update.source;
  const current = existing.sources ?? [];
  let next: CallSourceState[];
  if (source === undefined) {
    // Malformed (source-less source state): refresh the leg only.
    return existing.leg === update.leg ? existing : { ...existing, leg: update.leg };
  }
  if (on) {
    if (current.some((s) => s.source === source)) {
      next = current;
    } else {
      // Date.now (not bare `new Date()`) — the one clock seam the store
      // owns, spy-able in tests exactly like CallRing's rang_at.
      next = [...current, { source, since: new Date(Date.now()).toISOString() }];
    }
  } else {
    next = current.filter((s) => s.source !== source);
  }
  const unchangedSources = next === current;
  if (unchangedSources && existing.leg === update.leg) return existing;
  const patched: CallParticipantState = { ...existing, leg: update.leg };
  if (next.length > 0) patched.sources = next;
  else delete patched.sources; // elided-when-empty (see store.ts)
  return patched;
}

/** Build the LiveCall roster from a projected (leg-less) wire roster. */
/**
 * A `MemberAdd` → the roster row the people page would have produced for the
 * same member: name, avatar, kind badge and owner ride the event (additive
 * keys), so a member who joins — or a bot its owner grants — after this client
 * hydrated is named and badged at once, the same lookup every surface uses.
 * An older server's event carries only `user.id`/`username`; the fields it
 * does not carry keep what an existing row already knew.
 */
function memberFromAdd(m: MemberAdd, existing: WorkspaceMember | undefined): WorkspaceMember {
  const row: WorkspaceMember = {
    ...existing,
    id: m.user.id,
    username: m.user.username,
    // Never the workspace nickname: the row is shared (#169, nicknames.ts).
    nickname: null,
    joined_at: m.joined_at,
    roles: m.roles ?? existing?.roles ?? [],
  };
  if (m.user.avatar_url !== undefined) row.avatar_url = m.user.avatar_url;
  if (m.user.display_name !== undefined) row.display_name = m.user.display_name;
  if (m.kind !== undefined) row.kind = m.kind;
  if (m.parent_user_id !== undefined) row.parent_user_id = m.parent_user_id;
  if (m.dm_support !== undefined) row.dm_support = m.dm_support;
  return row;
}

function rosterFromProjection(
  participants: CallParticipant[],
): Record<Snowflake, CallParticipantState> {
  const out: Record<Snowflake, CallParticipantState> = {};
  // Explicit field projection: V2 wire rosters carry `sources` (calls V2
  // plan R3/KTD1) — copied through (absent/empty stays elided, the store's
  // audio-only convention), never spread through.
  for (const p of participants) {
    const sources =
      p.sources !== undefined && p.sources.length > 0 ? p.sources.map((s) => ({ ...s })) : undefined;
    out[p.user_id] =
      sources === undefined
        ? { user_id: p.user_id, mute: p.mute, deafen: p.deafen, leg: null }
        : { user_id: p.user_id, mute: p.mute, deafen: p.deafen, leg: null, sources };
  }
  return out;
}

// ---------------------------------------------------------------------------
// The dispatcher
// ---------------------------------------------------------------------------

/**
 * Apply one gateway dispatch event to the store. Safe to call for every
 * inbound dispatch; events the store does not model are accepted no-ops so
 * the caller can pipe the full dispatch stream without filtering.
 *
 * Seq gate: dispatches with `s <= lastSeq` are dropped — this is what makes
 * RESUMED replay from seq+1 duplicate-free.
 */
export function applyGatewayEvent(store: StateStore, event: GatewayEvent): void {
  const { lastSeq } = store.getState();

  if (event.op !== 0 || typeof event.s !== 'number') return; // not a dispatch frame
  // Synthetic-space events (local REST reconciles, stamped by
  // `nextSyntheticSeq()` — the same module as the floor) are local facts, not
  // replay-stream members: they always apply (#143) and never touch the
  // watermark — see the advance guard at the bottom.
  const synthetic = event.s > SYNTHETIC_SEQ_FLOOR;
  if (!synthetic && event.s <= lastSeq && event.t !== 'Ready' && event.t !== 'Resumed') {
    return; // replay / duplicate — already applied
  }

  const writer = createDispatchWriter(store);
  // Set by the accepted-but-unmodelled frames whose effects live OUTSIDE this
  // store (see the pass-through cases below): they must still advance lastSeq.
  let externallyReconciled = false;

  switch (event.t) {
    // -- messages ------------------------------------------------------------
    case 'MessageCreate': {
      const m = event.d;
      if (isPlaceholderId(m.id)) return;
      // Calls plan U6 (R5 — security-reviewed fix): a MessageCreate whose
      // thread_id is the channel's standing call-log thread is call-log
      // chatter. The server suppresses the channel-anchored emission for
      // call-log threads entirely (U4 single-emission); this skip is the
      // client-side belt-and-braces for replayed/gapped traffic — no channel
      // timeline upsert, no channel unread accrual, no last_message_id bump.
      // Thread-side storage + thread unread accrue via ThreadMessageCreate.
      // Thread replies never ride the CHANNEL timeline (Discord semantics;
      // the server's channel read filters them the same way) — the thread
      // slice owns them, and the channel shows the seed + its indicator.
      if (m.thread_id != null) {
        break; // still a real dispatch — lastSeq advances below
      }
      if (isCallLogThreadMessage(store.getState(), m.channel_id, m.thread_id)) {
        break; // still a real dispatch — lastSeq advances below
      }
      // ONE write for the whole dispatch: the timeline upsert, the per-channel
      // recency fact and (below) the unread accrual + sequence number all land
      // together — three notifications used to reach every mounted subscriber
      // per message, each one re-running its selector.
      //
      // The same message id can legitimately arrive twice under DIFFERENT
      // seqs (a resume overlapping the route join, a stalled send's nonce
      // re-write — lane S): the upsert dedupes by id, and the unread accrual
      // below runs only when this dispatch actually added the row, so a
      // duplicate never counts as a second unread message.
      let isNewRow = false;
      writer.write((s) => {
        const slice = s.messagesByChannel[m.channel_id] ?? emptySlice();
        // The echo of our own optimistic send carries the real id while the
        // `pending_*` placeholder is still unconfirmed (the gateway fan-out
        // routinely beats the REST round-trip). Retire the shadowed
        // placeholder — same author + content — in the SAME write so the
        // message never renders twice; confirmOptimisticSend stays
        // idempotent (unknown-nonce no-op) on top of this.
        const shadowed = findShadowedPlaceholder(slice.items, m);
        const base = shadowed
          ? { ...slice, items: slice.items.filter((it) => it.id !== shadowed.id) }
          : slice;
        const settled = shadowed ? settleHeldFailure(s, shadowed) : {};
        // Lane D #12: the echo inherits the placeholder's client key, so the
        // row a list keyed by `client_key ?? id` renders keeps its identity.
        const row: Message =
          shadowed?.client_key !== undefined ? { ...m, client_key: shadowed.client_key } : m;
        // Recency lives in its OWN narrow slice (store.ts) — never on the
        // channel record, whose identity every `channels` consumer watches.
        // Only advances: stale/out-of-order deliveries never regress it.
        const recency = s.lastMessageIdByChannel[m.channel_id];
        const upserted = liftAbovePending(s, upsertMessage(base, row), row);
        isNewRow = !slice.items.some((it) => it.id === m.id);
        return {
          ...settled,
          messagesByChannel: {
            ...s.messagesByChannel,
            [m.channel_id]: upserted,
          },
          lastMessageIdByChannel:
            recency !== undefined && !isNewer(m.id, recency)
              ? s.lastMessageIdByChannel
              : { ...s.lastMessageIdByChannel, [m.channel_id]: m.id },
        };
      });
      if (isNewRow) accrueUnreadForMessage(writer, 'unreadByChannel', m.channel_id, m);
      break;
    }

    case 'ThreadMessageCreate': {
      const m = event.d;
      if (isPlaceholderId(m.id)) return;
      // Same duplicate-delivery rule as MessageCreate: a reply already held
      // is not a second unread one.
      const alreadyHeld =
        store.getState().messagesByThread[m.thread_id]?.items.some((it) => it.id === m.id) === true;
      writer.write((s) => {
        const slice = s.messagesByThread[m.thread_id] ?? emptySlice();
        // Same optimistic-echo shadowing as MessageCreate (see there).
        const shadowed = findShadowedPlaceholder(slice.items, m);
        const base = shadowed
          ? { ...slice, items: slice.items.filter((it) => it.id !== shadowed.id) }
          : slice;
        const settled = shadowed ? settleHeldFailure(s, shadowed) : {};
        // The WHOLE wire row (#15 consistency): a reply is the same message a
        // channel row is — attachments, the reply reference, action rows ride
        // `Messages.Message.to_wire/1` for both. This used to rebuild a
        // stripped row (id/author/content/timestamps), so a thread reply lost
        // its attachments, its reply bar and everything else the channel
        // renders. Only the parent channel is filled when the frame omits it.
        const full = {
          ...(m as unknown as Message),
          channel_id: m.channel_id || (s.threadsById[m.thread_id]?.channel_id ?? ''),
          thread_id: m.thread_id,
        } as Message;
        return {
          ...settled,
          messagesByThread: {
            ...s.messagesByThread,
            [m.thread_id]: liftAbovePending(
              s,
              upsertMessage(
                base,
                shadowed?.client_key !== undefined ? { ...full, client_key: shadowed.client_key } : full,
              ),
              full,
            ),
          },
        };
      });
      if (!alreadyHeld) accrueUnreadForMessage(writer, 'unreadByThread', m.thread_id, {
        ...m,
        channel_id: writer.state().messagesByThread[m.thread_id]?.items[0]?.channel_id ?? '',
        thread_id: m.thread_id,
      });
      // The thread summary the seed indicator renders (#106). This event has
      // THREE sources — a live reply, the sender's own echo, and loadReplies()
      // replaying a page of history — so a plain `+1` double-counts. The guard is
      // recency: only a reply strictly newer than the summary's latest_reply_at
      // is one the summary has not counted yet. A replay is at or behind it, and
      // an echo of a reply already applied equals it, so both are no-ops.
      writer.write((s) => {
        const thread = s.threadsById[m.thread_id];
        if (!thread || !isNewerReply(m.created_at, thread.latest_reply_at)) return {};
        return {
          threadsById: {
            ...s.threadsById,
            [m.thread_id]: {
              ...thread,
              message_count: (thread.message_count ?? 0) + 1,
              latest_reply_at: m.created_at,
            },
          },
        };
      });
      break;
    }

    case 'MessageUpdate': {
      const u = event.d;
      writer.write((s) => {
        const patch: Partial<Message> = { content: u.content, edited_at: u.edited_at };
        // Components plan U3 (R2): an update carrying the message's CURRENT
        // action rows (the approval-card flip) patches them; an update
        // WITHOUT the key (a plain content edit) leaves stored rows intact.
        if (u.components !== undefined) patch.components = u.components;
        // The card flip's embeds ride the same rule ("Approved by X" swaps the
        // embed; `[]` clears it): present → replace, absent → unchanged. The
        // domain Message does not declare `embeds` (the web's MessageWithBots
        // does), so the key rides the row structurally, as it does on create.
        if (u.embeds !== undefined) (patch as Record<string, unknown>).embeds = u.embeds;
        // The Markdown image proxy map belongs to the CONTENT, which every
        // update carries whole: it is replaced with the update's own map, and
        // an update without one (the edit removed the images) clears it.
        (patch as Record<string, unknown>).content_proxy_urls = u.content_proxy_urls;
        const chSlice = s.messagesByChannel[u.channel_id];
        const thSlice = u.thread_id ? s.messagesByThread[u.thread_id] : undefined;
        const messagesByChannel =
          !u.thread_id && chSlice
            ? {
                ...s.messagesByChannel,
                [u.channel_id]: patchMessage(chSlice, u.id, patch),
              }
            : s.messagesByChannel;
        const messagesByThread = thSlice
          ? {
              ...s.messagesByThread,
              [u.thread_id!]: patchMessage(thSlice, u.id, patch),
            }
          : s.messagesByThread;
        return { messagesByChannel, messagesByThread };
      });
      break;
    }

    case 'MessageDelete': {
      const d = event.d;
      writer.write((s) => {
        const chSlice = s.messagesByChannel[d.channel_id];
        const thSlice = d.thread_id ? s.messagesByThread[d.thread_id] : undefined;
        const messagesByChannel =
          !d.thread_id && chSlice
            ? {
                ...s.messagesByChannel,
                [d.channel_id]: removeMessage(chSlice, d.id),
              }
            : s.messagesByChannel;
        const messagesByThread = thSlice
          ? {
              ...s.messagesByThread,
              [d.thread_id!]: removeMessage(thSlice, d.id),
            }
          : s.messagesByThread;
        // A deleted reply leaves the thread's count (#106; the server decrements
        // the same field). When the replies are loaded, only a delete that
        // actually removed one counts, so a repeated delivery cannot take two.
        // latest_reply_at stays: it is the last ACTIVITY, and that happened.
        // A deleted message that was still UNREAD leaves the badge with it:
        // the accrual counted it on create, so the delete takes it back
        // (otherwise a channel whose unread messages were all deleted shows a
        // count with nothing behind it). Only a row this store held can be
        // judged — its author and position decide — and only once, since a
        // repeated delivery finds nothing left to remove.
        const chRow = !d.thread_id ? chSlice?.items.find((it) => it.id === d.id) : undefined;
        const thRow = d.thread_id ? thSlice?.items.find((it) => it.id === d.id) : undefined;
        const unreadByChannel = chRow
          ? releaseDeletedUnread(s, s.unreadByChannel, d.channel_id, chRow)
          : s.unreadByChannel;
        const unreadByThread = thRow
          ? releaseDeletedUnread(s, s.unreadByThread, d.thread_id!, thRow)
          : s.unreadByThread;
        const thread = d.thread_id ? s.threadsById[d.thread_id] : undefined;
        const removed = thSlice ? messagesByThread[d.thread_id!] !== thSlice : true;
        const threadsById =
          thread && removed && (thread.message_count ?? 0) > 0
            ? {
                ...s.threadsById,
                [thread.id]: { ...thread, message_count: (thread.message_count ?? 0) - 1 },
              }
            : s.threadsById;
        return { messagesByChannel, messagesByThread, threadsById, unreadByChannel, unreadByThread };
      });
      break;
    }

    // -- threads ---------------------------------------------------------------
    case 'ThreadCreate': {
      const t = event.d;
      writer.write((s) => {
        const existing = s.threadsById[t.id];
        return {
          threadsById: {
            ...s.threadsById,
            [t.id]: {
              // A reply can land before its thread's ThreadCreate (the creator's
              // own compose applies the reply first); keep what it recorded.
              ...existing,
              id: t.id,
              channel_id: t.channel_id,
              // The anchor the EVENT states wins: it is how a thread someone
              // else started (a bot, a webhook, another member or device) finds
              // its seed message here — the roster read is not re-run for it.
              // An event that does not state one (an older server) never erases
              // an anchor already held.
              parent_message_id: anchorOf(t, existing),
              name: t.name,
              created_by: t.created_by,
              // A replayed create (resume overlap, duplicate publish) must not
              // un-archive what a later ThreadUpdate archived.
              archived: existing?.archived ?? false,
              // A new thread has no replies yet. An explicit 0 (not absent) is
              // what keeps the seed bare until the first reply counts itself.
              message_count: existing?.message_count ?? 0,
              created_at: t.created_at,
            } satisfies Thread,
          },
          threadIdsByChannel: {
            ...s.threadIdsByChannel,
            [t.channel_id]: (s.threadIdsByChannel[t.channel_id] ?? []).includes(t.id)
              ? (s.threadIdsByChannel[t.channel_id] ?? [])
              : [...(s.threadIdsByChannel[t.channel_id] ?? []), t.id],
          },
        };
      });
      break;
    }

    case 'ThreadUpdate': {
      const u = event.d;
      writer.write((s) => {
        const existing = s.threadsById[u.id];
        if (!existing) return {};
        return {
          threadsById: {
            ...s.threadsById,
            [u.id]: {
              ...existing,
              parent_message_id: anchorOf(u, existing),
              ...(u.name !== undefined ? { name: u.name } : {}),
              ...(u.archived !== undefined ? { archived: u.archived } : {}),
            },
          },
        };
      });
      break;
    }

    case 'ThreadDelete': {
      const d = event.d;
      writer.write((s) => {
        const thread = s.threadsById[d.id];
        if (!thread) return {};
        const { [d.id]: _removed, ...threadsById } = s.threadsById;
        return {
          threadsById,
          threadIdsByChannel: thread.channel_id
            ? {
                ...s.threadIdsByChannel,
                [thread.channel_id]: (s.threadIdsByChannel[thread.channel_id] ?? []).filter(
                  (id) => id !== d.id,
                ),
              }
            : s.threadIdsByChannel,
        };
      });
      break;
    }

    // -- channels ---------------------------------------------------------------
    case 'ChannelCreate': {
      const c = event.d;
      // The row is built from the payload rather than a fixed skeleton. It used
      // to hardcode `type: 'text'` and drop everything else, which was wrong
      // twice over: a CATEGORY created mid-session rendered as a text channel,
      // and a channel created inside one lost `parent_id` and sat ungrouped
      // until a reload replaced the row with the REST reading (found
      // 2026-09-15 — the server now sends both, see `channel_json`).
      //
      // `type` is normalized here because the api-client boundary — which does
      // this for every REST read — never sees a gateway dispatch. `undefined`
      // is still read as text so an older server stays compatible.
      writer.write((s) => ({
        channels: {
          ...s.channels,
          [c.id]: {
            id: c.id,
            workspace_id: c.workspace_id ?? null,
            name: c.name,
            type: normalizeChannelType(c.type),
            ...(c.parent_id != null ? { parent_id: c.parent_id } : {}),
            topic: c.topic ?? null,
            position: c.position,
            last_message_id: c.last_message_id ?? null,
            created_at: c.created_at,
          },
        },
      }));
      break;
    }

    case 'ChannelUpdate': {
      const u = event.d;
      writer.write((s) => {
        const existing = s.channels[u.id];
        if (!existing) return {};
        return {
          channels: {
            ...s.channels,
            [u.id]: {
              ...existing,
              ...(u.name !== undefined ? { name: u.name } : {}),
              ...(u.topic !== undefined ? { topic: u.topic } : {}),
              ...(u.position !== undefined ? { position: u.position } : {}),
            },
          },
        };
      });
      break;
    }

    case 'ChannelDelete': {
      const d = event.d;
      writer.write((s) => {
        if (!s.channels[d.id]) return {};
        const { [d.id]: _removed, ...channels } = s.channels;
        return { channels };
      });
      break;
    }

    // -- workspace membership ---------------------------------------------------
    case 'MemberAdd': {
      const m = event.d;
      writer.write((s) => ({
        membersById: {
          ...s.membersById,
          [m.user.id]: memberFromAdd(m, s.membersById[m.user.id]),
        },
        // The nickname is this workspace's (#169), never the shared row's.
        nicknamesByWorkspace:
          m.nickname !== undefined
            ? withNickname(s.nicknamesByWorkspace, m.workspace_id, m.user.id, m.nickname)
            : s.nicknamesByWorkspace,
        memberIdsByWorkspace: (() => {
          const existing = s.memberIdsByWorkspace[m.workspace_id] ?? [];
          return {
            ...s.memberIdsByWorkspace,
            [m.workspace_id]: existing.includes(m.user.id)
              ? existing
              : [...existing, m.user.id],
          };
        })(),
      }));
      break;
    }

    // A workspace nickname changed (#169): this workspace's only.
    case 'MemberUpdate': {
      const m = event.d;
      writer.write((s) => {
        const nicknamesByWorkspace = withNickname(s.nicknamesByWorkspace, m.workspace_id, m.user_id, m.nickname);
        return nicknamesByWorkspace === s.nicknamesByWorkspace ? {} : { nicknamesByWorkspace };
      });
      break;
    }

    case 'MemberRemove': {
      const m = event.d;
      writer.write((s) => {
        const nicknamesByWorkspace = withNickname(s.nicknamesByWorkspace, m.workspace_id, m.user_id, null);
        const memberIdsByWorkspace = {
          ...s.memberIdsByWorkspace,
          [m.workspace_id]: (s.memberIdsByWorkspace[m.workspace_id] ?? []).filter(
            (id) => id !== m.user_id,
          ),
        };
        // `membersById` is global: a principal still listed in another
        // workspace keeps its row, or every message it wrote there would
        // lose its name and badge to one workspace's removal.
        const elsewhere = Object.values(memberIdsByWorkspace).some((ids) => ids.includes(m.user_id));
        if (elsewhere) return { memberIdsByWorkspace, nicknamesByWorkspace };
        const { [m.user_id]: _removed, ...membersById } = s.membersById;
        return { membersById, memberIdsByWorkspace, nicknamesByWorkspace };
      });
      break;
    }

    // Live profile propagation (avatar render pass): apply the public user
    // shape to every roster row the user occupies, plus the self record
    // when the event is about us (our own REST response usually landed
    // first — re-applying is idempotent).
    //
    // ONE shape for people and machines (2026-10-02): `username` is always
    // the account's HANDLE (the @tag) and `display_name` the name it shows.
    // Every row stores `display_name` (#168: the name rule reads nickname →
    // display_name → username), a machine's label included. Nicknames are
    // per-workspace state the event does not carry (#169), so they stay
    // untouched. A key the event does not carry (an older server's
    // `display_name`, an absent `avatar_url`) never clobbers what the row
    // already holds.
    case 'UserUpdate': {
      const u = event.d;
      const carriesAvatar = u.avatar_url !== undefined;
      const avatar = u.avatar_url ?? null;
      const carriesDisplayName = u.display_name !== undefined;
      const displayName = u.display_name ?? null;
      writer.write((s) => {
        const existing = s.membersById[u.id];
        let membersById = s.membersById;
        if (existing !== undefined) {
          const next: WorkspaceMember = { ...existing, username: u.username };
          if (carriesAvatar) next.avatar_url = avatar;
          if (carriesDisplayName) next.display_name = displayName;
          // Same-reference no-change signal: our own REST converge applied
          // first and the gateway re-delivers the same values (resume replay
          // too) — a no-op re-apply must not allocate a fresh membersById.
          const changed =
            next.username !== existing.username ||
            (next.avatar_url ?? null) !== (existing.avatar_url ?? null) ||
            (next.display_name ?? null) !== (existing.display_name ?? null) ||
            next.nickname !== existing.nickname;
          if (changed) membersById = { ...s.membersById, [u.id]: next };
        }

        const currentUser =
          s.currentUser &&
          s.currentUser.id === u.id &&
          (s.currentUser.username !== u.username ||
            (carriesAvatar && (s.currentUser.avatar_url ?? null) !== avatar) ||
            (carriesDisplayName && (s.currentUser.display_name ?? null) !== displayName))
            ? {
                ...s.currentUser,
                username: u.username,
                ...(carriesAvatar ? { avatar_url: avatar } : {}),
                ...(carriesDisplayName ? { display_name: displayName } : {}),
              }
            : s.currentUser;

        // DM channel rows carry the peer summary (recipients) — keep the
        // home DM column fresh without a refetch.
        let channels = s.channels;
        for (const [id, ch] of Object.entries(s.channels)) {
          if (ch.type !== 'dm') continue;
          const idx = (ch.recipients ?? []).findIndex((r) => r.id === u.id);
          if (idx === -1) continue;
          const recipients = [...(ch.recipients ?? [])];
          const prev = recipients[idx]!;
          if (
            prev.username === u.username &&
            (!carriesAvatar || (prev.avatar_url ?? null) === avatar) &&
            (!carriesDisplayName || (prev.display_name ?? null) === displayName)
          )
            continue;
          if (channels === s.channels) channels = { ...s.channels };
          recipients[idx] = {
            ...prev,
            username: u.username,
            ...(carriesAvatar ? { avatar_url: avatar } : {}),
            ...(carriesDisplayName ? { display_name: displayName } : {}),
          };
          channels[id] = { ...ch, recipients };
        }

        if (membersById === s.membersById && currentUser === s.currentUser && channels === s.channels) {
          return {};
        }

        return { membersById, currentUser, channels };
      });
      break;
    }

    // -- presence -----------------------------------------------------------------
    case 'PresenceUpdate': {
      const p = event.d;
      writer.write((s) => {
        // Same-status guard (lane D #17): the join snapshot and every
        // workspace a user shares with us re-announce the SAME status, and a
        // rewrite copied the whole map and notified every presence reader for
        // nothing. `last_seen_at` alone moving is not a presence change any
        // surface renders.
        const current = s.presenceByUser[p.user_id];
        if (current !== undefined && current.status === p.status) return {};
        return {
          presenceByUser: {
            ...s.presenceByUser,
            [p.user_id]: { status: p.status, last_seen_at: p.last_seen_at },
          },
        };
      });
      break;
    }

    // -- session lifecycle ---------------------------------------------------------
    case 'Ready': {
      const r = event.d;
      // Lane D #1: READY resets only what belongs to the gateway SESSION —
      // never the entity or message slices. Those stay on screen as stale
      // data and are replaced whole: the roster right here when READY
      // carries it (lane D #5), the rest by the consumer's refresh. Wiping
      // them made every reconnect (and every boot) paint an empty shell
      // before the refill landed.
      //
      // `media_enabled` (ticket #124) is additive/optional: a server predating
      // the switch omits it, and absence reads as enabled — there, permissions
      // alone govern calls, exactly as before.
      const roster = rosterFromReady(r);
      writer.write((s) => ({
        ...sessionResetPatch(),
        ...(roster !== null ? rosterPatch(s, roster) : {}),
        currentUser:
          s.currentUser !== null &&
          s.currentUser.id === r.user.id &&
          s.currentUser.username === r.user.username
            ? s.currentUser
            : r.user,
        sessionStatus: 'ready',
        sessionEpoch: s.sessionEpoch + 1,
        mediaEnabled: r.media_enabled ?? true,
      }));
      break;
    }

    case 'Resumed': {
      writer.write(() => ({ sessionStatus: 'resumed' }));
      break;
    }

    case 'MessageAck': {
      // Read acknowledgement from any of the user's devices (thread acks
      // carry the thread's id in channel_id — same id space, clear both).
      const a = event.d;
      const ids = (a.message_ids ?? []) as string[];
      const lastRead = ids.length > 0 ? ids[ids.length - 1]! : null;
      // The server's snapshot counts clear with the local ones (lane D #2):
      // a read on another device answers them too.
      const clear = (slice: UnreadState | undefined): UnreadState | undefined =>
        slice === undefined
          ? undefined
          : {
              ...slice,
              unread_count: 0,
              mention_count: 0,
              ...(slice.server_unread_count != null ? { server_unread_count: 0 } : {}),
              ...(slice.server_mention_count != null ? { server_mention_count: 0 } : {}),
              last_read_id: lastRead ?? slice.last_read_id,
            };

      writer.write((s) => {
        const ch = clear(s.unreadByChannel[a.channel_id]);
        const th = clear(s.unreadByThread[a.channel_id]);
        if (ch === undefined && th === undefined) return {};
        return {
          unreadByChannel: ch === undefined ? s.unreadByChannel : { ...s.unreadByChannel, [a.channel_id]: ch },
          unreadByThread: th === undefined ? s.unreadByThread : { ...s.unreadByThread, [a.channel_id]: th },
        };
      });
      break;
    }

    // -- events the store accepts but does not model yet ---------------------------
    // Reaction dispatches are reconciled by the apps/web reactions seam
    // (features/messages/reactions.ts), which runs BEFORE applyGatewayEvent
    // and patches the message rows itself — the shared dispatcher treats
    // them as pass-through no-ops.
    case 'MessageReactionAdd':
    case 'MessageReactionRemove':
    case 'MessageReactionRemoveAll':
    case 'TypingStart':
    case 'ThreadMemberAdd':
    case 'ThreadMemberRemove':
    case 'ThreadListSync':
    case 'RoleCreate':
    case 'RoleUpdate':
    case 'RoleDelete':
    case 'AccountDelete':
    case 'InteractionCreate':
    case 'InteractionModal':
    case 'InteractionSuccess':
      // Bot-addressed dispatch (bots plan U8); the human client never receives
      // it today — the composer surface (U9) owns any future handling.
      // InteractionModal (#30) and InteractionSuccess ARE human-addressed,
      // but they are UI state, not store state: the web modal host and the
      // component-click tracker take them from the gateway.
      //
      // Their effects live OUTSIDE this store (the reaction seams), so the
      // frame still advances lastSeq: those seams drop replays with the same
      // `s <= lastSeq` rule and read the pre-dispatch value, so a replayed
      // frame must never be applied twice.
      externallyReconciled = true;
      break;
    // -- voice calls (calls plan U6) --------------------------------------------
    case 'CallStart': {
      const c = event.d;
      writer.write((s) => {
        const call: LiveCall = {
          call_id: c.call_id,
          thread_id: c.thread_id,
          started_by: c.started_by,
          started_at: c.started_at,
          participants: {},
        };
        // DM calls (thread_id null) keep no durable artifact (R11) — they
        // live in the separate DM slice so room surfaces can never see them.
        if (c.thread_id === null) {
          return { dmCallByChannel: { ...s.dmCallByChannel, [c.channel_id]: call } };
        }
        return {
          callByChannel: { ...s.callByChannel, [c.channel_id]: call },
          callLogThreadIdByChannel: withCallLogThread(
            s.callLogThreadIdByChannel,
            c.channel_id,
            c.thread_id,
          ),
        };
      });
      break;
    }

    case 'CallUpdate': {
      const u = event.d;
      writer.write((s) => {
        // Route by where THIS call lives (call_id match — a stale update
        // from an ended call must never resurrect or mutate a newer one).
        const room = s.callByChannel[u.channel_id];
        const dm = s.dmCallByChannel[u.channel_id];
        if (room !== undefined && room.call_id === u.call_id) {
          const participants = applyLegTransition(room.participants, u);
          if (participants === room.participants) return {};
          return {
            callByChannel: {
              ...s.callByChannel,
              [u.channel_id]: { ...room, participants },
            },
          };
        }
        if (dm !== undefined && dm.call_id === u.call_id) {
          const participants = applyLegTransition(dm.participants, u);
          if (participants === dm.participants) return {};
          return {
            dmCallByChannel: {
              ...s.dmCallByChannel,
              [u.channel_id]: { ...dm, participants },
            },
          };
        }
        // Out-of-order (END seen first / replay gap): idempotent no-op —
        // CALL_SYNC owns roster repair.
        return {};
      });
      break;
    }

    case 'CallEnd': {
      const d = event.d;
      writer.write((s) => {
        const patch: Partial<StateState> = {};
        const room = s.callByChannel[d.channel_id];
        if (room !== undefined && room.call_id === d.call_id) {
          const { [d.channel_id]: _ended, ...callByChannel } = s.callByChannel;
          patch.callByChannel = callByChannel;
        }
        const dm = s.dmCallByChannel[d.channel_id];
        if (dm !== undefined && dm.call_id === d.call_id) {
          const { [d.channel_id]: _endedDm, ...dmCallByChannel } = s.dmCallByChannel;
          patch.dmCallByChannel = dmCallByChannel;
        }
        // The standing-thread mapping survives the call (R4 — reused by the
        // next call). Idempotent: an already-absent entry clears nothing; a
        // stale call_id never deletes a newer call on the same channel.
        return patch;
      });
      break;
    }

    case 'ReadStateUpdate': {
      // ONE channel's read state, and AUTHORITATIVE (#54): a fired reminder
      // or a floor set/cleared on another device. Unlike the session sync it
      // applies when the watermark did NOT move (a fire moves only the floor),
      // and it creates the row for a channel this client holds nothing for —
      // a cold client must not drop the reminder. The watermark still never
      // regresses: a server value behind the local one keeps the local one.
      const entry = event.d;
      writer.write((s) => {
        const current = s.unreadByChannel[entry.channel_id];
        const localRead = current?.last_read_id ?? null;
        const serverRead = entry.last_read_id;
        const lastRead =
          serverRead != null && (localRead == null || compareSnowflakes(serverRead, localRead) > 0)
            ? serverRead
            : localRead;
        return {
          unreadByChannel: {
            ...s.unreadByChannel,
            [entry.channel_id]: foldServerCounts(current, entry, lastRead),
          },
        };
      });
      break;
    }

    case 'ReadStateSync': {
      const sync = event.d;
      writer.write((s) => {
        // Hydrate the member's read state so a reload stops losing it. Before
        // this, the unread slices were wiped on every READY and nothing
        // refilled them — so a reconnect re-showed messages the member had
        // already read, and the badge disagreed with the notification decision
        // about the same message.
        //
        // NOT a full replace, unlike CallSync: the server sends only rows the
        // member has (a channel never opened has none, and there is nothing to
        // hydrate there), while the client may have accrued unread locally
        // between READY and this frame. An existing entry is therefore kept
        // only when the client's watermark is STRICTLY further along (a local
        // ack the server has not recorded yet — its count would overcount).
        //
        // An EQUAL watermark is the common case after any ack, and there the
        // server's snapshot wins: the local counts can be stale — a restored
        // device snapshot, or live accrual for messages deleted since — and
        // nothing else would ever correct them. Skipping the equal case is how
        // a channel whose unread messages had all been deleted kept a phantom
        // "3" across every reload.
        //
        // Two fields folded through here (tui plan U11): `unread_floor`, the
        // exclusive floor a hand mark-unread sets (this handler used to DROP
        // it, so the store could not tell a read range from a marked-unread
        // one), and the server's own `unread_count`, which is the only count
        // that covers a channel this client has loaded nothing for (R22a).
        const unreadByChannel = { ...s.unreadByChannel };
        for (const entry of sync.channels) {
          const current = unreadByChannel[entry.channel_id];
          const serverRead = entry.last_read_id;

          if (
            current?.last_read_id != null &&
            serverRead != null &&
            compareSnowflakes(serverRead, current.last_read_id) < 0
          ) {
            continue;
          }

          unreadByChannel[entry.channel_id] = foldServerCounts(
            current,
            entry,
            serverRead ?? current?.last_read_id ?? null,
          );
        }
        return { unreadByChannel };
      });
      break;
    }

    case 'CallSync': {
      const sync = event.d;
      writer.write((s) => {
        // Full replace of BOTH call slices (R9): the server already
        // visibility-filtered the snapshot per recipient, so an absent
        // channel means "no live call visible to me" — merge semantics
        // would drift forever. Entries for channels the client doesn't know
        // yet (late hydration) are simply stored.
        const callByChannel: Record<Snowflake, LiveCall | undefined> = {};
        let callLogThreadIdByChannel = s.callLogThreadIdByChannel;
        for (const entry of sync.calls) {
          const prev = s.callByChannel[entry.channel_id];
          const sameCall = prev !== undefined && prev.call_id === entry.call_id;
          callByChannel[entry.channel_id] = {
            call_id: entry.call_id,
            thread_id: entry.thread_id,
            // The sync snapshot carries no boundary metadata — keep what a
            // same-call CALL_START already taught us, else null (U9 reads
            // boundaries from REST, never from this slice).
            started_by: sameCall ? prev.started_by : null,
            started_at: sameCall ? prev.started_at : null,
            participants: rosterFromProjection(entry.participants),
          };
          callLogThreadIdByChannel = withCallLogThread(
            callLogThreadIdByChannel,
            entry.channel_id,
            entry.thread_id,
          );
        }
        const dmCallByChannel: Record<Snowflake, LiveCall | undefined> = {};
        for (const entry of sync.dm_calls) {
          const prev = s.dmCallByChannel[entry.channel_id];
          const sameCall = prev !== undefined && prev.call_id === entry.call_id;
          dmCallByChannel[entry.channel_id] = {
            call_id: entry.call_id,
            thread_id: null,
            started_by: sameCall ? prev.started_by : null,
            started_at: sameCall ? prev.started_at : null,
            participants: rosterFromProjection(entry.participants),
          };
        }
        return { callByChannel, dmCallByChannel, callLogThreadIdByChannel };
      });
      break;
    }

    case 'CallRing': {
      const r = event.d;
      writer.write((s) => {
        // Ephemeral slot, never in the call slices (the typing-indicator
        // model: stored on arrival, consumer-owned expiry). Dedupe by
        // call_id — one ring per call, and a re-delivery must NOT extend
        // the 30 s window (original rang_at preserved).
        const existing = s.callRingByChannel[r.channel_id];
        if (existing !== undefined && existing.call_id === r.call_id) return {};
        return {
          callRingByChannel: {
            ...s.callRingByChannel,
            [r.channel_id]: {
              call_id: r.call_id,
              from_user: r.from_user,
              rang_at: Date.now(),
            },
          },
        };
      });
      break;
    }

    case 'CallSignal':
      // Media signaling is ephemeral and addressed to one leg: it routes
      // through the session pre-processing seam (calls plan U8 wires a
      // CALL_SIGNAL handler ahead of this dispatcher, mirroring the
      // reactions seam) — the store never models it. Deliberate no-op that
      // still advances lastSeq (see the pass-through cases above).
      externallyReconciled = true;
      break;

    default: {
      // Compile-time exhaustiveness: adding a protocol event without a case
      // (or without a deliberate no-op above) fails the build.
      const _exhaustive: never = event;
      void _exhaustive;
    }
  }

  // The sequence number rides in the SAME write as the dispatch's effects —
  // it costs every subscriber a selector re-run of its own otherwise. A
  // branch that changed nothing the store models writes nothing at all, so an
  // update for an unknown message (or a call transition for an ended call)
  // notifies nobody; the externally-reconciled frames above are the one
  // exception, because their seams gate replays on lastSeq.
  writer.flush();
  // Lane D #17: the watermark advances IN PLACE, never as a store write — a
  // frame that changed nothing else (a typing tick, a reaction handled by its
  // seam) notifies nobody. READY/RESUMED adopt the frame's seq outright.
  if (event.t === 'Ready' || event.t === 'Resumed') {
    advanceLastSeq(store, event.s);
  } else if (!synthetic && (writer.changed() || externallyReconciled)) {
    // Synthetic stamps are excluded (#143): advancing lastSeq into the
    // synthetic range (>= SYNTHETIC_SEQ_FLOOR + 1) would leave every
    // subsequent REAL dispatch — per-session seqs counting from 1 — below
    // the watermark, dropped by the gate until the next Ready/Resumed.
    advanceLastSeq(store, event.s);
  }
}

// ---------------------------------------------------------------------------
// REST merge
// ---------------------------------------------------------------------------

export interface MergeOptions {
  /** True when this page came back short (nothing further in its direction). */
  isLastPage?: boolean;
  /**
   * Which end of the window the page extends (#9, see `mergePageIntoWindow`):
   * `older` (a `before=` page), `newer` (an `after=` page), `newest` (the
   * latest page), or `jump` — a page AROUND a message outside the window (a
   * permalink landing), which replaces the window and detaches it from the
   * live edge. Omitted: inferred — a page wholly older than the window is
   * `older`, anything else `newest`.
   */
  direction?: PageDirection | 'jump';
}

/** Resolve the page direction (explicit, or inferred from the rows). */
function pageDirection(
  slice: MessageSlice,
  page: readonly Message[],
  direction: MergeOptions['direction'],
): PageDirection | 'jump' {
  if (direction !== undefined) return direction;
  const oldest = slice.items[slice.items.length - 1];
  if (oldest === undefined || page.length === 0) return 'newest';
  return page.every((m) => isNewer(oldest.id, m.id)) ? 'older' : 'newest';
}

/** Apply one REST page to a slice (the shared core of the channel/thread merges). */
function applyPage(
  slice: MessageSlice,
  page: readonly Message[],
  options: MergeOptions,
): MessageSlice {
  const direction = pageDirection(slice, page, options.direction);
  if (direction === 'jump') {
    // The rows between the window and the target are not loaded: the window
    // is REPLACED by the target's neighbourhood and detached (`hasNewer`) —
    // merging it in would leave a gap the list renders as adjacent rows.
    const fresh = mergePageIntoWindow(
      { items: [], oldestId: null, hasCompleteHistory: false },
      page,
      'older',
      options.isLastPage === true,
    );
    const jumped: MessageSlice = { ...fresh, hasNewer: true };
    if (slice.holdOldest === true) jumped.holdOldest = true;
    return jumped;
  }
  return mergePageIntoWindow(
    slice,
    page,
    direction,
    options.isLastPage === true,
    options.direction === 'newest',
  );
}

/**
 * Merge a REST page of channel messages into the store, deduped against
 * gateway-applied rows; updates the `before=` pagination cursor.
 *
 * Calls plan U6 (R5, belt-and-braces): rows whose `thread_id` is the
 * channel's standing call-log thread are filtered out before merging — the
 * server already excludes them from channel history (U4), so this guard
 * only exists so a replay or eviction path can never leak call-log chatter
 * into the channel timeline.
 */
export function mergeChannelMessages(
  store: StateStore,
  channelId: string,
  messages: Message[],
  options: MergeOptions = {},
): void {
  store.setState((s) => {
    const standingThread = s.callLogThreadIdByChannel[channelId];
    const existing = s.messagesByChannel[channelId] ?? emptySlice();
    const rows =
      standingThread === undefined
        ? messages
        : messages.filter((m) => m.thread_id !== standingThread);
    const merged = applyPage(existing, rows, options);
    const oldest = merged.items.length > 0 ? merged.items[merged.items.length - 1]!.id : null;
    // Same narrow recency slice the gateway hot path writes: a REST page is
    // the other place the newest-known-message fact is learned. Optimistic
    // placeholders never carry it (they are not server truth).
    const newest = merged.items.find((m) => !isPlaceholderId(m.id));
    const recency = s.lastMessageIdByChannel[channelId];
    return {
      messagesByChannel: {
        ...s.messagesByChannel,
        [channelId]: {
          ...merged,
          // Track the oldest merged row. This used to latch the FIRST page's
          // cursor forever, so a second page never advanced it and a consumer
          // that paged by `oldestId` (the terminal client does) re-requested
          // the page it already held — the merge deduped it away and paging
          // stalled silently at two pages. The visible clients never hit it
          // because they page from the oldest *row*; this makes the field mean
          // what `store.ts` says it means. A page that contributes no older
          // row (everything filtered, or an empty page) keeps the cursor
          // rather than clearing it.
          oldestId: oldest ?? existing.oldestId,
        },
      },
      lastMessageIdByChannel:
        newest === undefined || (recency !== undefined && !isNewer(newest.id, recency))
          ? s.lastMessageIdByChannel
          : { ...s.lastMessageIdByChannel, [channelId]: newest.id },
    };
  });
}

/**
 * Merge a channel's NEWEST page (the page an open or a refresh reads), and
 * REPLACE the cached slice when the page does not overlap it (lane D #23).
 *
 * A newest page whose oldest row is still newer than the newest row this
 * client holds means messages were missed in between (the client was away
 * longer than one page of traffic). Merging it would splice the two windows
 * into one slice with a hole the pager can never find — `loadOlder` pages
 * from the OLDEST row, far below the gap — so the hole was permanent. The
 * stale window is dropped instead and the page becomes the slice (older
 * history pages back in from its tail). Placeholder rows of sends still in
 * flight are kept.
 */
export function mergeNewestPage(
  store: StateStore,
  channelId: string,
  messages: Message[],
  options: MergeOptions = {},
): void {
  const existing = store.getState().messagesByChannel[channelId];
  const newestCached = existing?.items.find((m) => !isPlaceholderId(m.id));
  const pageOldest = messages.length > 0 ? messages[messages.length - 1]!.id : null;
  const disjoint =
    newestCached !== undefined && pageOldest !== null && isNewer(pageOldest, newestCached.id);
  if (!disjoint) {
    mergeChannelMessages(store, channelId, messages, options);
    return;
  }
  store.setState((s) => {
    const kept = (s.messagesByChannel[channelId]?.items ?? []).filter((m) => isPlaceholderId(m.id));
    return {
      messagesByChannel: {
        ...s.messagesByChannel,
        [channelId]: { items: kept, oldestId: null, hasCompleteHistory: false },
      },
    };
  });
  mergeChannelMessages(store, channelId, messages, options);
}

/**
 * True when a channel's slice holds a REST-read window (lane D #24) — the
 * test for "this channel is cached", as opposed to "live traffic created a
 * slice holding the one or two messages that arrived while it was never
 * opened". Only a REST merge sets `oldestId`; a live MessageCreate never does.
 */
export function hasLoadedHistory(state: StateState, channelId: string): boolean {
  return (state.messagesByChannel[channelId]?.oldestId ?? null) !== null;
}

/**
 * Merge a REST page of thread replies into `messagesByThread` in ONE write
 * (#15). The panel used to replay a page as fifty synthetic
 * ThreadMessageCreate dispatches — fifty store writes, fifty notifications to
 * every subscriber — and the replay stripped each reply to
 * id/author/content/timestamps on the way. The rows land whole here.
 *
 * The thread's summary (the seed indicator's count, #106) catches up the same
 * way the replay made it: only replies strictly newer than the summary's
 * `latest_reply_at` are ones it has not counted. History is NOT new traffic,
 * so nothing here accrues unread (the replay did, once per load).
 */
export function mergeThreadMessages(
  store: StateStore,
  threadId: string,
  messages: Message[],
  options: MergeOptions = {},
): void {
  const state = store.getState();
  const existing = state.messagesByThread[threadId] ?? emptySlice();
  const channelId = state.threadsById[threadId]?.channel_id ?? '';
  const rows = messages.map((m) =>
    m.thread_id === threadId && (m.channel_id || channelId === '')
      ? m
      : ({ ...m, thread_id: threadId, channel_id: m.channel_id || channelId } as Message),
  );
  const merged = applyPage(existing, rows, options);
  const thread = state.threadsById[threadId];
  let threadsById = state.threadsById;
  if (thread) {
    const before = thread.latest_reply_at ?? null;
    let count = thread.message_count ?? 0;
    let latest = before;
    for (const m of rows) {
      if (isPlaceholderId(m.id) || !isNewerReply(m.created_at, before)) continue;
      count += 1;
      if (isNewerReply(m.created_at, latest)) latest = m.created_at;
    }
    if (count !== (thread.message_count ?? 0) || latest !== before) {
      threadsById = {
        ...state.threadsById,
        [threadId]: { ...thread, message_count: count, latest_reply_at: latest },
      };
    }
  }
  if (merged === existing && threadsById === state.threadsById) return;
  store.setState((s) => ({
    messagesByThread: { ...s.messagesByThread, [threadId]: merged },
    ...(threadsById === state.threadsById ? {} : { threadsById }),
  }));
}

/**
 * Tell the store whether the reader is scrolled up in a window (#9 — see
 * `MessageSlice.holdOldest`). Written only on a CHANGE, so a scroll that does
 * not cross the at-bottom line costs nothing.
 */
export function setMessageWindowHold(
  store: StateStore,
  scope: { channelId: string } | { threadId: string },
  hold: boolean,
): void {
  const key = 'threadId' in scope ? 'messagesByThread' : 'messagesByChannel';
  const id = 'threadId' in scope ? scope.threadId : scope.channelId;
  const slice = store.getState()[key][id];
  if (!slice || (slice.holdOldest === true) === hold) return;
  const next: MessageSlice = { ...slice };
  if (hold) next.holdOldest = true;
  else delete next.holdOldest;
  store.setState((s) => ({ [key]: { ...s[key], [id]: next } }));
}

// ---------------------------------------------------------------------------
// Call-log mapping hydration (calls plan U6)
// ---------------------------------------------------------------------------

/**
 * Learn a channel's standing call-log thread id from REST
 * (GET /channels/{id}/call — `thread_id` is always present; DM channels
 * carry null and learn nothing). Upsert-only: the mapping is durable per
 * channel (R4 — the standing thread is reused by every later call), so it
 * is never cleared on call end. Consumers: reconcile (CALL_START /
 * CALL_SYNC wire it inline) and on-demand REST readers (U9's log surfaces
 * call this after getCall; no per-channel batch fetch exists by design —
 * CALL_SYNC covers live calls on every Identify/Resume).
 */
export function setCallLogThread(
  store: StateStore,
  channelId: Snowflake,
  threadId: Snowflake | null,
): void {
  if (threadId === null) return;
  store.setState((s) => ({
    callLogThreadIdByChannel: withCallLogThread(s.callLogThreadIdByChannel, channelId, threadId),
  }));
}

// ---------------------------------------------------------------------------
// Session reset
// ---------------------------------------------------------------------------

/**
 * Clear EVERYTHING the store holds for the signed-in member (logout, a failed
 * restore, a user switch). Unlike a READY — which keeps the member's data as
 * stale content — this is the one place the entity and message slices go:
 * the next member must never see the previous one's workspaces or messages.
 */
export function resetForFreshSession(store: StateStore): void {
  resetChannelBadgeMemo(store);
  store.setState({
    ...memberDataResetPatch(),
    ...sessionResetPatch(),
    sessionStatus: 'fresh',
    lastSeq: 0,
    currentUser: null,
    rosterSource: 'none',
    recentChannelIds: [],
  });
}

/**
 * The GATEWAY-SESSION state a fresh READY clears (lane D #1): live calls and
 * rings (CALL_SYNC re-seeds the live subset immediately after), and presence
 * (the join snapshot refills it — with the READY burst batched, in the same
 * commit). The call-log standing-thread mapping is durable per channel and
 * survives; optimistic sends are REST requests still in flight, not session
 * state, so their rows and markers survive too — clearing them orphaned the
 * confirm and left the placeholder on screen forever.
 */
function sessionResetPatch(): Partial<StateState> {
  return {
    presenceByUser: {},
    callByChannel: {},
    dmCallByChannel: {},
    callRingByChannel: {},
  };
}

/** Everything that belongs to the signed-in MEMBER — cleared only on logout. */
function memberDataResetPatch(): Partial<StateState> {
  return {
    messagesByChannel: {},
    messagesByThread: {},
    lastMessageIdByChannel: {},
    threadsById: {},
    threadIdsByChannel: {},
    channels: {},
    workspaces: {},
    membersById: {},
    memberIdsByWorkspace: {},
    nicknamesByWorkspace: {},
    unreadByChannel: {},
    unreadByThread: {},
    callLogThreadIdByChannel: {},
    pendingByNonce: {},
    failedByNonce: {},
    nonceByMessageId: {},
    // A previous account's levels must never shape the next one's badges.
    notificationPrefs: { overrides: {}, suppressBroadcasts: {}, status: 'idle' },
  };
}
