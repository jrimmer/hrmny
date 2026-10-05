/**
 * @cytale/web — closing the gaps a reconnect leaves (lane D #1 / #23).
 *
 * The store holds channel windows across disconnects now (a READY no longer
 * wipes them), so whatever happened while this client was away has to be
 * fetched INTO those windows — otherwise the stale window is simply wrong.
 * Before, a fresh READY remounted every pane (the `epoch-N` key) to force a
 * refetch; that flashed the whole conversation and still missed every cached
 * channel that was not on screen.
 *
 * The repair is a FORWARD read (#152's `after=` cursor) from the newest row
 * each cached channel holds, paging forward until a short page. It runs when
 * the stream may have skipped something:
 *
 *   * a fresh READY (`sessionEpoch` advances) — nothing was replayed;
 *   * a RESUMED — the replay covers the session's buffer, but a client that
 *     slept past the buffer's window, or a cached window restored from the
 *     device snapshot (#8), is still behind;
 *   * the browser coming back `online`, and the window regaining focus (a
 *     laptop that slept with the socket half-open).
 *
 * Scope: the channel on screen and the recently opened ones that hold a REST
 * window (`hasLoadedHistory`) — the only windows a member will look at without
 * a fresh open (which reads the newest page anyway). A gap longer than the
 * forward budget is not paged through: the newest page REPLACES the window
 * (`mergeNewestPage`), and older history pages back in on scroll.
 */

import type { CytaleApiClient } from '@cytale/api-client';
import {
  hasLoadedHistory,
  mergeChannelMessages,
  mergeNewestPage,
  type StateStore,
} from '@cytale/state';

/** One forward page (the list's own page size). */
export const GAP_PAGE_SIZE = 50;

/** Forward pages per channel before the window is replaced instead. */
export const GAP_MAX_PAGES = 3;

/** Focus/online triggers closer together than this are one repair. */
export const GAP_TRIGGER_MIN_INTERVAL_MS = 10_000;

export interface GapRepairOptions {
  store: StateStore;
  api: Pick<CytaleApiClient, 'getMessagePage'>;
  /** The channel on screen (repaired first). */
  activeChannelId: () => string | null;
  /** Clock seam (tests). */
  now?: () => number;
}

/** The channels a repair covers: the one on screen, then the recent ones. */
export function repairTargets(store: StateStore, activeChannelId: string | null): string[] {
  const state = store.getState();
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of [activeChannelId, ...state.recentChannelIds]) {
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    if (hasLoadedHistory(state, id)) out.push(id);
  }
  return out;
}

/** Bring one channel's window up to date (forward pages, or a replace). */
export async function repairChannel(
  store: StateStore,
  api: GapRepairOptions['api'],
  channelId: string,
): Promise<void> {
  for (let page = 0; page < GAP_MAX_PAGES; page++) {
    const newest = store
      .getState()
      .messagesByChannel[channelId]?.items.find((m) => !m.id.startsWith('pending_'));
    if (newest === undefined) return;
    const result = await api.getMessagePage(channelId, { after: newest.id, limit: GAP_PAGE_SIZE });
    if (result.items.length > 0) {
      // An `after=` page extends the window's newer end (the windowed merge
      // keeps a detached window detached until the live edge is reached).
      mergeChannelMessages(store, channelId, result.items, {
        direction: 'newer',
        isLastPage: result.items.length < GAP_PAGE_SIZE,
      });
    }
    if (result.items.length < GAP_PAGE_SIZE) return;
  }
  // Still behind after the budget: the gap is large — take the newest page
  // as the window (the disjoint-page rule replaces it) rather than paging on.
  const newestPage = await api.getMessagePage(channelId, { limit: GAP_PAGE_SIZE });
  mergeNewestPage(store, channelId, newestPage.items, {
    direction: 'newest',
    isLastPage: newestPage.items.length < GAP_PAGE_SIZE,
  });
}

/**
 * Start the repair triggers; returns the stop function. Repairs never
 * overlap (a trigger during a run queues exactly one more run) and never
 * throw — a failed channel is left for the next trigger.
 */
export function startGapRepair(options: GapRepairOptions): () => void {
  const { store, api, activeChannelId } = options;
  const now = options.now ?? (() => Date.now());
  let running = false;
  let queued = false;
  let stopped = false;
  let lastRunAt = -Infinity;

  const run = async (): Promise<void> => {
    if (stopped) return;
    if (running) {
      queued = true;
      return;
    }
    running = true;
    lastRunAt = now();
    try {
      for (const channelId of repairTargets(store, activeChannelId())) {
        if (stopped) return;
        try {
          await repairChannel(store, api, channelId);
        } catch {
          // Left for the next trigger; the window keeps what it has.
        }
      }
    } finally {
      running = false;
      if (queued && !stopped) {
        queued = false;
        void run();
      }
    }
  };

  const throttled = () => {
    if (now() - lastRunAt < GAP_TRIGGER_MIN_INTERVAL_MS) return;
    void run();
  };

  let epoch = store.getState().sessionEpoch;
  let status = store.getState().sessionStatus;
  const unsubscribe = store.subscribe((state) => {
    const epochMoved = state.sessionEpoch !== epoch;
    const resumed = state.sessionStatus === 'resumed' && status !== 'resumed';
    epoch = state.sessionEpoch;
    status = state.sessionStatus;
    if (epochMoved || resumed) void run();
  });

  const onFocus = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    throttled();
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('online', throttled);
    window.addEventListener('focus', onFocus);
  }

  return () => {
    stopped = true;
    unsubscribe();
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', throttled);
      window.removeEventListener('focus', onFocus);
    }
  };
}
