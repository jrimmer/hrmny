/**
 * Thread-window primitives (plan 004 M9, R12).
 *
 * `mergeThreadMessages` is the thread twin of `@cytale/state`'s
 * `mergeChannelMessages` — the store exports no thread merge, so the mobile
 * thread surface owns one that goes through `applyGatewayEvent`'s
 * `ThreadMessageCreate` branch (the same path web's `useThreads.loadReplies`
 * uses). Two contracts are asserted here that no UI test can see:
 *
 *   * the synthetic sequence stamps must stay ABOVE the store's `lastSeq`
 *     (the dispatcher's replay gate drops `s <= lastSeq`), including after a
 *     real gateway session has advanced the sequence past the counter's
 *     starting point — a per-module constant would silently drop history;
 *   * a partial page marks the window complete, so `loadOlder` stops asking
 *     for history that does not exist.
 */
import { beginOptimisticSend } from '@cytale/state';

import { mergeThreadMessages, nextSyntheticSeq, resetSyntheticSeq } from '../threadWindow';
import { IDS, makeReply, makeStore, replyId, seedThreadWindow, windowIds } from './support';

beforeEach(() => {
  resetSyntheticSeq();
});

describe('mergeThreadMessages', () => {
  it('merges a REST page into messagesByThread newest-first', () => {
    const store = makeStore();

    mergeThreadMessages(store, IDS.thread, [makeReply(3), makeReply(2), makeReply(1)]);

    // Store order is newest-first; the list flips it.
    expect(store.getState().messagesByThread[IDS.thread]!.items.map((m) => m.id)).toEqual([
      replyId(3),
      replyId(2),
      replyId(1),
    ]);
    expect(windowIds(store)).toEqual([replyId(1), replyId(2), replyId(3)]);
    expect(store.getState().messagesByThread[IDS.thread]!.oldestId).toBe(replyId(1));
    expect(store.getState().messagesByThread[IDS.thread]!.hasCompleteHistory).toBe(false);
  });

  it('marks the window complete on a partial page', () => {
    const store = makeStore();

    mergeThreadMessages(store, IDS.thread, [makeReply(2), makeReply(1)], { isLastPage: true });

    expect(store.getState().messagesByThread[IDS.thread]!.hasCompleteHistory).toBe(true);
  });

  it('dedupes a page replayed twice (no duplicate rows)', () => {
    const store = makeStore();
    const page = [makeReply(2), makeReply(1)];

    mergeThreadMessages(store, IDS.thread, page);
    mergeThreadMessages(store, IDS.thread, page);

    expect(store.getState().messagesByThread[IDS.thread]!.items).toHaveLength(2);
  });

  it('reconciles an optimistic placeholder with the row the gateway confirms', () => {
    const store = makeStore();
    beginOptimisticSend(store, {
      channel_id: IDS.channel,
      thread_id: IDS.thread,
      author_id: IDS.me,
      content: 'sending now',
    });
    expect(windowIds(store)).toHaveLength(1);
    expect(windowIds(store)[0]).toMatch(/^pending_/);

    // The gateway's ThreadMessageCreate for the confirmed row lands while the
    // REST confirm is still in flight — one row survives, the server id.
    mergeThreadMessages(store, IDS.thread, [
      makeReply(9, { author_id: IDS.me, content: 'sending now' }),
    ]);

    expect(windowIds(store)).toEqual([replyId(9)]);
  });

  it('keeps applying pages after a real gateway session advanced lastSeq', () => {
    const store = makeStore();
    // A long-lived session's replay cursor sits far above the counter's
    // starting point; a synthetic stamp below it would be dropped silently.
    store.setState({ lastSeq: 5_000_000 });

    expect(nextSyntheticSeq(store)).toBeGreaterThan(5_000_000);
    mergeThreadMessages(store, IDS.thread, [makeReply(1)]);
    expect(windowIds(store)).toEqual([replyId(1)]);
  });

  it('prepends an older page and moves the oldest cursor down with it', () => {
    const store = makeStore();
    seedThreadWindow(store, [makeReply(10), makeReply(9)]);

    mergeThreadMessages(store, IDS.thread, [makeReply(8), makeReply(7)]);

    expect(windowIds(store)).toEqual([replyId(7), replyId(8), replyId(9), replyId(10)]);
    expect(store.getState().messagesByThread[IDS.thread]!.oldestId).toBe(replyId(7));
  });
});
