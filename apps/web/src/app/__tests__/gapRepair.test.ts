/**
 * Lane D #1 / #23 — the gap repair fetches what a disconnect skipped INTO the
 * cached windows (forward pages from the newest known row), replaces a window
 * the gap outran, and runs on a fresh READY / RESUMED.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Message } from '@cytale/domain';
import { createStateStore, mergeChannelMessages, type StateStore } from '@cytale/state';

import {
  GAP_MAX_PAGES,
  GAP_PAGE_SIZE,
  repairChannel,
  repairTargets,
  startGapRepair,
} from '../gapRepair.js';

const CH = '9000000000000001';
const OTHER = '9000000000000002';

function msg(n: number, channel = CH): Message {
  return {
    id: String(1_000_000_000_000_000 + n),
    channel_id: channel,
    thread_id: null,
    author_id: '7',
    content: `m${n}`,
    created_at: '2026-09-27T00:00:00Z',
    edited_at: null,
  };
}

/** A fake history API over `total` messages in CH (ids 1..total). */
function historyApi(total: number) {
  const calls: { after?: string | null; limit?: number | null }[] = [];
  const getMessagePage = vi.fn(async (_channel: string, params: { after?: string | null; limit?: number | null }) => {
    calls.push(params);
    const limit = params.limit ?? 50;
    const all = Array.from({ length: total }, (_, i) => msg(i + 1)); // oldest first
    let page: Message[];
    if (params.after) {
      const after = BigInt(params.after);
      page = all.filter((m) => BigInt(m.id) > after).slice(0, limit);
    } else {
      page = all.slice(-limit);
    }
    const items = page.reverse(); // newest first
    return { items, cursor: { before: null, after: null, limit } };
  });
  return { api: { getMessagePage } as never, calls };
}

function seeded(ids: number[]): StateStore {
  const store = createStateStore();
  mergeChannelMessages(store, CH, ids.map((n) => msg(n)).reverse());
  return store;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('repairChannel', () => {
  it('pages forward from the newest cached row until a short page', async () => {
    const store = seeded([1, 2, 3]);
    const { api, calls } = historyApi(3 + GAP_PAGE_SIZE + 10);
    await repairChannel(store, api, CH);
    const items = store.getState().messagesByChannel[CH]!.items;
    expect(items).toHaveLength(3 + GAP_PAGE_SIZE + 10);
    expect(calls[0]!.after).toBe(msg(3).id);
    expect(calls).toHaveLength(2);
  });

  it('replaces the window when the gap outruns the forward budget', async () => {
    const store = seeded([1, 2, 3]);
    const { api } = historyApi(3 + GAP_PAGE_SIZE * (GAP_MAX_PAGES + 2));
    await repairChannel(store, api, CH);
    const slice = store.getState().messagesByChannel[CH]!;
    // The newest page is the window; the three stale rows (below a hole) are gone.
    expect(slice.items[slice.items.length - 1]!.id).not.toBe(msg(1).id);
    expect(slice.items[0]!.id).toBe(msg(3 + GAP_PAGE_SIZE * (GAP_MAX_PAGES + 2)).id);
  });
});

describe('repairTargets', () => {
  it('covers the channel on screen and the recent ones that hold a REST window', () => {
    const store = seeded([1]);
    // OTHER only has a live-traffic slice (no REST window) — not a target.
    store.setState((s) => ({
      recentChannelIds: [OTHER, CH],
      messagesByChannel: {
        ...s.messagesByChannel,
        [OTHER]: { items: [msg(9, OTHER)], oldestId: null, hasCompleteHistory: false },
      },
    }));
    expect(repairTargets(store, CH)).toEqual([CH]);
  });
});

describe('startGapRepair', () => {
  it('runs on a fresh session (epoch) and on RESUMED', async () => {
    const store = seeded([1]);
    const { api } = historyApi(1);
    const stop = startGapRepair({ store, api, activeChannelId: () => CH });

    store.setState((s) => ({ sessionEpoch: s.sessionEpoch + 1, sessionStatus: 'ready' }));
    await vi.waitFor(() => expect((api as { getMessagePage: ReturnType<typeof vi.fn> }).getMessagePage).toHaveBeenCalledTimes(1));

    store.setState({ sessionStatus: 'resumed' });
    await vi.waitFor(() => expect((api as { getMessagePage: ReturnType<typeof vi.fn> }).getMessagePage).toHaveBeenCalledTimes(2));
    stop();
  });
});
