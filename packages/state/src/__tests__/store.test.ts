/**
 * @cytale/state — message-slice window bounds (hardening plan 7.6).
 *
 * Every slice writer inserts by COPYING the array (`insertNewestFirst`), so an
 * unbounded window makes each inbound message O(n) in the channel's whole
 * loaded history. These pin the two invariants of `MESSAGE_SLICE_MAX`:
 *
 *   1. the window never exceeds the cap, and
 *   2. a LIVE row that lands OUTSIDE a full window is dropped — returned as
 *      the SAME array, never a slide.
 *
 * REST pages slide the window instead (#9, `mergePageIntoWindow`): an older
 * page sheds the newest end and marks the window detached (`hasNewer`), a
 * newer page sheds the oldest end.
 */
import { describe, expect, it } from 'vitest';

import type { Message } from '@cytale/domain';

import { MESSAGE_SLICE_MAX, createStateStore, insertNewestFirst } from '../store.js';
import {
  applyGatewayEvent,
  mergeChannelMessages,
  mergeThreadMessages,
  setMessageWindowHold,
} from '../reconcile.js';

const CHANNEL = '9007199254740993';
const AUTHOR = '7000000000000001';
/** Base snowflake: all test ids share its 16-digit width, so `isNewer` is lexicographic. */
const BASE = 1_000_000_000_000_000;

function row(offset: number): Message {
  return {
    id: String(BASE + offset),
    channel_id: CHANNEL,
    thread_id: null,
    author_id: AUTHOR,
    content: `row ${offset}`,
    created_at: '2026-08-28T00:00:00Z',
    edited_at: null,
  };
}

describe('insertNewestFirst window cap', () => {
  it('bounds newest-first prepends at MESSAGE_SLICE_MAX rows', () => {
    let items: readonly Message[] = [];
    for (let i = 1; i <= MESSAGE_SLICE_MAX; i++) items = insertNewestFirst(items, row(i));
    expect(items).toHaveLength(MESSAGE_SLICE_MAX);

    // One NEWER row: the newest always wins, so the oldest retained row goes.
    items = insertNewestFirst(items, row(MESSAGE_SLICE_MAX + 1));
    expect(items).toHaveLength(MESSAGE_SLICE_MAX);
    expect(items[0]!.id).toBe(String(BASE + MESSAGE_SLICE_MAX + 1));
    expect(items[items.length - 1]!.id).toBe(String(BASE + 2));
  });

  it('drops a row older than a full window instead of sliding it (identity-stable no-op)', () => {
    let items: readonly Message[] = [];
    for (let i = 1; i <= MESSAGE_SLICE_MAX; i++) items = insertNewestFirst(items, row(i));

    const full = items;
    const dropped = insertNewestFirst(full, row(0)); // older than every retained row
    expect(dropped).toBe(full); // SAME reference: nothing to write, nothing to re-page
  });

  it('still inserts a row that lands inside a full window, evicting the oldest', () => {
    // Odd offsets leave an even gap (BASE + 2) between two retained rows.
    let items: readonly Message[] = [];
    for (let i = 1; i <= MESSAGE_SLICE_MAX; i++) {
      items = insertNewestFirst(items, row(i * 2 - 1));
    }

    const next = insertNewestFirst(items, row(2)); // newest-than(BASE+1), older-than head
    expect(next).toHaveLength(MESSAGE_SLICE_MAX);
    expect(next.some((m) => m.id === String(BASE + 2))).toBe(true);
    expect(next.some((m) => m.id === String(BASE + 1))).toBe(false); // oldest evicted
  });
});

describe('mergeChannelMessages respects the window', () => {
  it('bounds a large page at the cap, newest rows kept', () => {
    const store = createStateStore();
    const big = Array.from({ length: MESSAGE_SLICE_MAX + 50 }, (_, i) => row(i + 1));
    mergeChannelMessages(store, CHANNEL, big);
    const full = store.getState().messagesByChannel[CHANNEL]!;
    expect(full.items).toHaveLength(MESSAGE_SLICE_MAX);
    expect(full.items[0]!.id).toBe(String(BASE + MESSAGE_SLICE_MAX + 50));
    expect(full.hasNewer).toBeUndefined();
  });

  // #9: an older page past a full window used to merge NOTHING (the insert
  // dropped every row older than the window), so history stopped at ~10 pages
  // and the list's "Loading older…" flashed forever. The window now slides.
  it('slides a full window toward history on an older page, shedding the newest end', () => {
    const store = createStateStore();
    mergeChannelMessages(
      store,
      CHANNEL,
      Array.from({ length: MESSAGE_SLICE_MAX }, (_, i) => row(i + 1)),
    );
    mergeChannelMessages(
      store,
      CHANNEL,
      Array.from({ length: 50 }, (_, i) => row(-i)),
      { direction: 'older' },
    );
    const slid = store.getState().messagesByChannel[CHANNEL]!;
    expect(slid.items).toHaveLength(MESSAGE_SLICE_MAX);
    expect(slid.items[slid.items.length - 1]!.id).toBe(String(BASE - 49));
    expect(slid.oldestId).toBe(String(BASE - 49));
    // The newest 50 went; the window knows newer history exists.
    expect(slid.items[0]!.id).toBe(String(BASE + MESSAGE_SLICE_MAX - 50));
    expect(slid.hasNewer).toBe(true);
    // A short older page proves the start of history.
    mergeChannelMessages(store, CHANNEL, [row(-60)], { direction: 'older', isLastPage: true });
    expect(store.getState().messagesByChannel[CHANNEL]!.hasCompleteHistory).toBe(true);
  });

  it('pages newer on a detached window, shedding the oldest end, and re-attaches on a short page', () => {
    const store = createStateStore();
    mergeChannelMessages(store, CHANNEL, Array.from({ length: MESSAGE_SLICE_MAX }, (_, i) => row(i + 1)));
    mergeChannelMessages(store, CHANNEL, Array.from({ length: 50 }, (_, i) => row(-i)), {
      direction: 'older',
      isLastPage: true,
    });
    expect(store.getState().messagesByChannel[CHANNEL]!.hasNewer).toBe(true);

    const newer = Array.from({ length: 50 }, (_, i) => row(MESSAGE_SLICE_MAX - 49 + i));
    mergeChannelMessages(store, CHANNEL, newer, { direction: 'newer', isLastPage: true });
    const back = store.getState().messagesByChannel[CHANNEL]!;
    expect(back.items).toHaveLength(MESSAGE_SLICE_MAX);
    expect(back.items[0]!.id).toBe(String(BASE + MESSAGE_SLICE_MAX));
    expect(back.hasNewer).toBeUndefined();
    // The oldest rows went back to being history.
    expect(back.hasCompleteHistory).toBe(false);
  });

  it('a detached window does not take a live message; an attached held full one detaches', () => {
    const store = createStateStore();
    mergeChannelMessages(store, CHANNEL, Array.from({ length: MESSAGE_SLICE_MAX }, (_, i) => row(i + 1)));
    // Reader scrolled up in a full window: the oldest rows are on screen.
    setMessageWindowHold(store, { channelId: CHANNEL }, true);
    const held = store.getState().messagesByChannel[CHANNEL]!;
    const live = { op: 0, t: 'MessageCreate', s: 1, d: row(MESSAGE_SLICE_MAX + 1) } as never;
    applyGatewayEvent(store, live);
    const after = store.getState().messagesByChannel[CHANNEL]!;
    expect(after.items).toBe(held.items); // nothing evicted from the top
    expect(after.hasNewer).toBe(true);
    // Detached: the next one is not slid in either.
    applyGatewayEvent(store, { op: 0, t: 'MessageCreate', s: 2, d: row(MESSAGE_SLICE_MAX + 2) } as never);
    expect(store.getState().messagesByChannel[CHANNEL]!.items).toBe(held.items);
    // The recency fact still moves (badges, jump-to-present).
    expect(store.getState().lastMessageIdByChannel[CHANNEL]).toBe(String(BASE + MESSAGE_SLICE_MAX + 2));
  });

  it('evicting the oldest row of a complete window re-opens its history', () => {
    const store = createStateStore();
    mergeChannelMessages(store, CHANNEL, Array.from({ length: MESSAGE_SLICE_MAX }, (_, i) => row(i + 1)), {
      isLastPage: true,
    });
    expect(store.getState().messagesByChannel[CHANNEL]!.hasCompleteHistory).toBe(true);
    applyGatewayEvent(store, { op: 0, t: 'MessageCreate', s: 1, d: row(MESSAGE_SLICE_MAX + 1) } as never);
    const slice = store.getState().messagesByChannel[CHANNEL]!;
    expect(slice.items).toHaveLength(MESSAGE_SLICE_MAX);
    expect(slice.hasCompleteHistory).toBe(false);
  });

  it('a jump page replaces the window and detaches it', () => {
    const store = createStateStore();
    mergeChannelMessages(store, CHANNEL, Array.from({ length: 50 }, (_, i) => row(1000 + i)));
    mergeChannelMessages(store, CHANNEL, [row(5), row(4), row(3)], { direction: 'jump' });
    const slice = store.getState().messagesByChannel[CHANNEL]!;
    expect(slice.items.map((m) => m.id)).toEqual([row(5).id, row(4).id, row(3).id]);
    expect(slice.hasNewer).toBe(true);
  });

  it('the newest page on a detached window replaces it (the rows between are unknown)', () => {
    const store = createStateStore();
    mergeChannelMessages(store, CHANNEL, [row(5), row(4)], { direction: 'jump' });
    mergeChannelMessages(store, CHANNEL, [row(900), row(899)], { direction: 'newest' });
    const slice = store.getState().messagesByChannel[CHANNEL]!;
    expect(slice.items.map((m) => m.id)).toEqual([row(900).id, row(899).id]);
    expect(slice.hasNewer).toBeUndefined();
  });
});

describe('mergeThreadMessages (#15)', () => {
  const THREAD = '1100000000000001';
  it('lands a page whole, in one write, and moves the summary once', () => {
    const store = createStateStore();
    store.setState({
      threadsById: {
        [THREAD]: {
          id: THREAD,
          channel_id: CHANNEL,
          parent_message_id: row(1).id,
          name: 't',
          created_by: AUTHOR,
          created_at: '2026-08-28T00:00:00Z',
          message_count: 0,
          latest_reply_at: null,
        } as never,
      },
    });
    let writes = 0;
    const unsub = store.subscribe(() => {
      writes += 1;
    });
    const replies = [3, 2].map((i) => ({
      ...row(i),
      thread_id: THREAD,
      created_at: `2026-08-28T00:00:0${i}Z`,
      attachments: [
        { id: 'a', message_id: row(i).id, filename: 'f.png', content_type: 'image/png', size: 1, url: '/f' },
      ],
      referenced: { message_id: row(1).id, author_id: AUTHOR, author_username: 'me', content: 'seed' },
    }));
    mergeThreadMessages(store, THREAD, replies);
    unsub();
    expect(writes).toBe(1);
    const items = store.getState().messagesByThread[THREAD]!.items;
    expect(items.map((m) => m.id)).toEqual([row(3).id, row(2).id]);
    expect(items[0]!.attachments).toHaveLength(1);
    expect(items[0]!.referenced?.message_id).toBe(row(1).id);
    const t = store.getState().threadsById[THREAD]!;
    expect(t.message_count).toBe(2);
    expect(t.latest_reply_at).toBe('2026-08-28T00:00:03Z');
    // A replay of the same page counts nothing.
    mergeThreadMessages(store, THREAD, replies);
    expect(store.getState().threadsById[THREAD]!.message_count).toBe(2);
  });

  it('a live ThreadMessageCreate keeps the whole wire row', () => {
    const store = createStateStore();
    applyGatewayEvent(store, {
      op: 0,
      t: 'ThreadMessageCreate',
      s: 1,
      d: {
        ...row(9),
        thread_id: THREAD,
        reply_to_id: row(8).id,
        attachments: [
          { id: 'a', message_id: row(9).id, filename: 'f.png', content_type: 'image/png', size: 1, url: '/f' },
        ],
      },
    } as never);
    const m = store.getState().messagesByThread[THREAD]!.items[0]!;
    expect(m.attachments).toHaveLength(1);
    expect(m.reply_to_id).toBe(row(8).id);
    expect(m.channel_id).toBe(CHANNEL);
  });
});
