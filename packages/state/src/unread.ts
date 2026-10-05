/**
 * @cytale/state — unread state (U17 unread).
 *
 * `unreadByChannel` / `unreadByThread` accrue in reconcile.ts as messages
 * land. This module owns clearing (ACK / client scroll) and badge
 * derivation: per-channel counts of messages newer than `last_read_id`
 * (excluding my own) and the summed total badge.
 *
 * Two server-supplied facts fold in here (tui plan U11, R22a):
 *   * `unread_floor` — the EXCLUSIVE floor a hand mark-unread sets: the
 *     message it names and everything after it stays unread even when the
 *     watermark has moved past it.
 *   * `server_unread_count` — the server's count for the channel, the only
 *     signal that covers a channel this client has loaded nothing for.
 */

import { compareSnowflakes } from '@cytale/domain';
import type { Snowflake } from '@cytale/protocol';

import { setStateIfChanged, type MessageSlice, type StateStore, type UnreadState } from './store.js';

function emptyUnread(): UnreadState {
  return { last_read_id: null, unread_count: 0, mention_count: 0 };
}

// ---------------------------------------------------------------------------
// The badge numbers (lane D #2) — ONE rule for every surface
// ---------------------------------------------------------------------------

/**
 * A channel's unread count as every badge must read it: the server's snapshot
 * (READ_STATE_SYNC / READ_STATE_UPDATE) plus what arrived live after it.
 *
 * The sidebar, the workspace rail and Home used to read the LOCAL count alone,
 * and a fresh READY zeroes that — so every badge vanished on reload even
 * though the sync had just reported the real numbers. The fold
 * (`foldServerCounts` in reconcile.ts) restarts the local count when a server
 * count lands, so the sum never counts a message twice; with no server count
 * reported, the local count is the whole answer.
 */
/** The fields the badge rule reads — any read-state row shape satisfies it. */
export interface BadgeCounts {
  unread_count: number;
  mention_count: number;
  server_unread_count?: number | null;
  server_mention_count?: number | null;
}

export function channelUnreadCount(unread: BadgeCounts | undefined): number {
  if (unread === undefined) return 0;
  return (unread.server_unread_count ?? 0) + unread.unread_count;
}

/** The mention half of the badge, by the same rule as `channelUnreadCount`. */
export function channelMentionCount(unread: BadgeCounts | undefined): number {
  if (unread === undefined) return 0;
  return (unread.server_mention_count ?? 0) + unread.mention_count;
}

/**
 * True when `messageId` is unread under the watermark + exclusive floor pair.
 * Shared by every reader of the two fields so the semantics live once: the
 * floor is inclusive of the message it names (that message IS unread) and
 * outranks the watermark.
 */
export function isUnreadByReadState(
  messageId: Snowflake,
  lastReadId: Snowflake | null,
  unreadFloor: Snowflake | null,
): boolean {
  if (unreadFloor !== null && compareSnowflakes(messageId, unreadFloor) >= 0) return true;
  return lastReadId === null || compareSnowflakes(messageId, lastReadId) > 0;
}

/**
 * Clear unread for a channel (MESSAGE_ACK / scroll bottom). Never regresses.
 *
 * The entry is carried through rather than rebuilt: an acknowledgement owns
 * the watermark only, so a `unread_floor` the member set by hand survives it
 * (the server's own ack path skips the floor column for the same reason).
 */
export function markChannelRead(store: StateStore, channelId: Snowflake, messageId: Snowflake): void {
  // The no-change guard lives at the call site: a `return {}` inside the
  // updater still notifies every subscriber (zustand compares the partial).
  setStateIfChanged(store, (s) => {
    const current = s.unreadByChannel[channelId] ?? emptyUnread();
    if (current.last_read_id !== null && compareSnowflakes(messageId, current.last_read_id) <= 0) {
      return {};
    }
    return {
      unreadByChannel: {
        ...s.unreadByChannel,
        [channelId]: {
          ...current,
          last_read_id: messageId,
          unread_count: 0,
          mention_count: 0,
          // Reading the channel answers the server's snapshot too (lane D #2).
          ...(current.server_unread_count != null ? { server_unread_count: 0 } : {}),
          ...(current.server_mention_count != null ? { server_mention_count: 0 } : {}),
        },
      },
    };
  });
}

/**
 * The OPEN channel has nothing unread to show: drop its counts to zero.
 *
 * The pane's read-ack moves the watermark to the newest loaded message, which
 * is how opening a channel clears its badge — but only when there is a newer
 * message to move to. A channel whose unread messages were all deleted has
 * none: empty, or its newest row already at the watermark. The ack is then a
 * no-op and a stale count would sit on a channel that visibly holds nothing
 * unread. This settles it from what the member is looking at.
 *
 * It judges only a LOADED window attached to the live edge (a REST page
 * landed — `oldestId`, or a whole-history page that came back empty — and no
 * `hasNewer` gap), and counts that window by the same rule as
 * `deriveChannelBadge`. A hand-set floor is left alone (the floor, not the
 * count, is what the pane settles on leave), and so is any window that still
 * holds an unread row — the ack owns that case. The watermark never moves.
 */
export function settleOpenChannelUnread(store: StateStore, channelId: Snowflake): void {
  setStateIfChanged(store, (s) => {
    const current = s.unreadByChannel[channelId];
    if (current === undefined) return {};
    if ((current.unread_floor ?? null) !== null) return {};
    if (channelUnreadCount(current) === 0 && channelMentionCount(current) === 0) return {};
    const slice = s.messagesByChannel[channelId];
    if (slice === undefined || slice.hasNewer === true) return {};
    if (slice.oldestId === null && !slice.hasCompleteHistory) return {};
    const me = s.currentUser;
    const lastReadId = current.last_read_id ?? null;
    for (const m of slice.items) {
      if (!/^\d{1,19}$/.test(m.id)) continue; // an unsent placeholder
      if (me && m.author_id === me.id) continue;
      if (isUnreadByReadState(m.id, lastReadId, null)) return {};
    }
    return {
      unreadByChannel: {
        ...s.unreadByChannel,
        [channelId]: {
          ...current,
          unread_count: 0,
          mention_count: 0,
          ...(current.server_unread_count != null ? { server_unread_count: 0 } : {}),
          ...(current.server_mention_count != null ? { server_mention_count: 0 } : {}),
        },
      },
    };
  });
}

/**
 * Clear a channel's unread FLOOR locally (#54): the member was shown the
 * floored message — the evidence the server also needs before it clears the
 * floor. The watermark and counts are untouched; the caller acks the server
 * with `unread_floor: null` so every device converges.
 */
export function clearChannelFloor(store: StateStore, channelId: Snowflake): void {
  setStateIfChanged(store, (s) => {
    const current = s.unreadByChannel[channelId];
    if (!current || current.unread_floor == null) return {};
    return {
      unreadByChannel: { ...s.unreadByChannel, [channelId]: { ...current, unread_floor: null } },
    };
  });
}

/** Clear unread for a thread pane without touching the parent channel tier. */
export function markThreadRead(store: StateStore, threadId: Snowflake, messageId: Snowflake): void {
  setStateIfChanged(store, (s) => {
    const current = s.unreadByThread[threadId] ?? emptyUnread();
    if (current.last_read_id !== null && compareSnowflakes(messageId, current.last_read_id) <= 0) {
      return {};
    }
    return {
      unreadByThread: {
        ...s.unreadByThread,
        [threadId]: { ...current, last_read_id: messageId, unread_count: 0, mention_count: 0 },
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Per-channel badge memoization (WEB-4)
// ---------------------------------------------------------------------------

/**
 * Everything `deriveChannelBadge` reads for one channel. The derivation scans
 * the channel's message slice, and it runs per consumer per render — with
 * slices never trimmed that is O(channels × messages) on every store notify.
 * The cache keys on `channelId` and recomputes only when a dep moves: the
 * slice by REFERENCE (every slice writer builds a new array, so reference
 * equality is exactly "the loaded messages did not change") and the
 * read-state fields by value.
 *
 * Held PER STORE (lane D #16): a module-level map retained every slice it had
 * ever memoized — including a signed-out member's — for the life of the
 * process. Keyed by the store in a WeakMap, it goes with its store, and
 * `resetForFreshSession` clears it outright.
 */
interface ChannelBadgeDeps {
  /** The channel's message slice, undefined while nothing is loaded. */
  slice: MessageSlice | undefined;
  lastReadId: Snowflake | null;
  unreadFloor: Snowflake | null;
  /** Server-reported count — the answer only while no history is loaded. */
  serverUnreadCount: number | null | undefined;
  /** Locally accrued count — the fallback while no slice is loaded. */
  localUnreadCount: number | undefined;
  /** Author exclusion: my own messages never count. */
  viewerId: Snowflake | null;
  /** The whole read-state row (its identity moves whenever any field does). */
  unread: UnreadState | undefined;
}

interface ChannelBadgeMemo extends ChannelBadgeDeps {
  result: number;
}

const badgeMemoByStore = new WeakMap<StateStore, Map<Snowflake, ChannelBadgeMemo>>();

function badgeMemoFor(store: StateStore): Map<Snowflake, ChannelBadgeMemo> {
  let memo = badgeMemoByStore.get(store);
  if (memo === undefined) {
    memo = new Map();
    badgeMemoByStore.set(store, memo);
  }
  return memo;
}

/** Drop a store's badge memo (logout / a fresh session). */
export function resetChannelBadgeMemo(store: StateStore): void {
  badgeMemoByStore.get(store)?.clear();
}

/** Recomputations since the last reset — the test probe for the memo contract. */
let badgeComputations = 0;

/**
 * Test-only: reset the computation counter between cases. The memo itself is
 * per store (a fresh store starts with none); pass the store to clear its memo.
 */
export function resetChannelBadgeMemoForTests(store?: StateStore): void {
  if (store !== undefined) resetChannelBadgeMemo(store);
  badgeComputations = 0;
}

/** Test-only: how many times the derivation actually recomputed. */
export function channelBadgeComputationsForTests(): number {
  return badgeComputations;
}

/**
 * Derive the per-channel badge: messages newer than `last_read_id` minus my
 * own — recomputed from the live message slice so gateway/REST drift and
 * accrual races self-heal — with the exclusive floor honoured (`isUnreadByReadState`).
 *
 * A channel with no message slice is NOT zero: its count is the server's
 * snapshot plus the live accrual since (`channelUnreadCount` — the one rule
 * every surface shares, R22a / lane D #2). The server count is deliberately
 * not consulted for a channel with a slice: there the live slice is
 * authoritative and self-healing (it honours a hand-set floor row by row),
 * which is what the three shipping clients render today.
 *
 * Memoized per channel (see `ChannelBadgeDeps`): repeated calls between
 * dep changes return the cached result without rescanning the slice.
 */
export function deriveChannelBadge(store: StateStore, channelId: Snowflake): number {
  const state = store.getState();
  const me = state.currentUser;
  const unread = state.unreadByChannel[channelId];
  const slice = state.messagesByChannel[channelId];

  const viewerId = me?.id ?? null;
  const lastReadId = unread?.last_read_id ?? null;
  const unreadFloor = unread?.unread_floor ?? null;
  const serverUnreadCount = unread?.server_unread_count;
  const localUnreadCount = unread?.unread_count;

  const memoByChannel = badgeMemoFor(store);
  const memo = memoByChannel.get(channelId);
  if (
    memo !== undefined &&
    memo.slice === slice &&
    memo.viewerId === viewerId &&
    memo.lastReadId === lastReadId &&
    memo.unreadFloor === unreadFloor &&
    memo.serverUnreadCount === serverUnreadCount &&
    memo.localUnreadCount === localUnreadCount &&
    memo.unread === unread
  ) {
    return memo.result;
  }

  badgeComputations += 1;

  let result: number;
  if (!slice) {
    result = channelUnreadCount(unread);
  } else {
    let count = 0;
    for (const m of slice.items) {
      if (me && m.author_id === me.id) continue;
      if (!isUnreadByReadState(m.id, lastReadId, unreadFloor)) continue;
      count += 1;
    }
    result = count;
  }

  memoByChannel.set(channelId, {
    slice,
    viewerId,
    lastReadId,
    unreadFloor,
    serverUnreadCount,
    localUnreadCount,
    unread,
    result,
  });
  return result;
}

/** Total badge across every channel + thread the store tracks. */
export function deriveTotalBadge(store: StateStore): number {
  const state = store.getState();
  let total = 0;
  for (const id of Object.keys(state.unreadByChannel)) {
    total += deriveChannelBadge(store, id);
  }
  for (const u of Object.values(state.unreadByThread)) {
    total += channelUnreadCount(u);
  }
  return total;
}
