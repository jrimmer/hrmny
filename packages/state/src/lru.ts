/**
 * @cytale/state — message-slice memory bound across channels (lane D #16).
 *
 * A channel's slice used to live for the whole session at up to its full
 * window, for EVERY channel ever opened — a long session that browsed many
 * busy channels held all of them. The bound is recency: the channel on
 * screen, the `RECENT_CHANNELS_MAX` most recently opened, and any channel with
 * a send in flight keep what they have; every other slice is trimmed to its
 * newest page (`EVICTED_SLICE_ROWS`) rather than dropped — reopening it still
 * paints at once, and scrolling up pages the rest back in (`hasCompleteHistory`
 * is cleared, `oldestId` moves to the kept tail, so the pager resumes from
 * there).
 *
 * Within-channel windowing (how many rows ONE open channel keeps while it is
 * scrolled) is the list's concern, not this module's.
 */

import type { Snowflake } from '@cytale/protocol';

import {
  EVICTED_SLICE_ROWS,
  RECENT_CHANNELS_MAX,
  setStateIfChanged,
  type MessageSlice,
  type StateState,
  type StateStore,
} from './store.js';

/** Channels with an optimistic send in flight (their rows must not be cut). */
function channelsWithPendingSends(state: StateState): Set<Snowflake> {
  const out = new Set<Snowflake>();
  for (const p of Object.values(state.pendingByNonce)) {
    if (p.thread_id === null) out.add(p.channel_id);
  }
  return out;
}

function trimSlice(slice: MessageSlice): MessageSlice {
  if (slice.items.length <= EVICTED_SLICE_ROWS) return slice;
  const items = slice.items.slice(0, EVICTED_SLICE_ROWS);
  return {
    items,
    oldestId: items[items.length - 1]!.id,
    // Rows were cut, so older history exists again as far as this slice knows.
    hasCompleteHistory: false,
  };
}

/**
 * The trim `touchChannel` applies, as a pure patch: every channel slice
 * outside `keep` cut to its newest page. Exported for tests and for the
 * device snapshot, which persists the same recency set.
 */
export function evictionPatch(state: StateState, keep: ReadonlySet<Snowflake>): Partial<StateState> {
  let messagesByChannel = state.messagesByChannel;
  for (const [id, slice] of Object.entries(state.messagesByChannel)) {
    if (keep.has(id)) continue;
    const trimmed = trimSlice(slice);
    if (trimmed === slice) continue;
    if (messagesByChannel === state.messagesByChannel) messagesByChannel = { ...state.messagesByChannel };
    messagesByChannel[id] = trimmed;
  }
  return messagesByChannel === state.messagesByChannel ? {} : { messagesByChannel };
}

/**
 * Record that `channelId` was opened (moves it to the head of
 * `recentChannelIds`) and trim every slice that fell out of the recency set.
 * One write; a re-touch of the channel already at the head writes nothing.
 */
export function touchChannel(store: StateStore, channelId: Snowflake): void {
  setStateIfChanged(store, (s) => {
    const recent =
      s.recentChannelIds[0] === channelId
        ? s.recentChannelIds
        : [channelId, ...s.recentChannelIds.filter((id) => id !== channelId)].slice(0, RECENT_CHANNELS_MAX);
    const keep = new Set<Snowflake>([...recent, ...channelsWithPendingSends(s)]);
    return {
      ...(recent === s.recentChannelIds ? {} : { recentChannelIds: recent }),
      ...evictionPatch(s, keep),
    };
  });
}
