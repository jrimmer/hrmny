/**
 * @cytale/state — draftThread.ts tests (2026-10-01).
 *
 * A draft thread's first reply is drawn in the draft's own window, and the
 * created thread takes that window over in ONE write: same rows (same list
 * keys), every send record re-aimed, nothing left under the draft key.
 */
import { describe, expect, it } from 'vitest';

import type { Thread } from '@cytale/domain';

import { createStateStore } from '../store.js';
import { beginOptimisticSend, holdFailedSend } from '../optimistic.js';
import {
  draftThreadKey,
  dropEmptyDraftThread,
  isDraftThreadKey,
  promoteDraftThread,
  seedDraftThread,
} from '../draftThread.js';

const CHANNEL = '9007199254740993';
const PARENT = '1000000000000001';
const THREAD = '1000000000000009';
const ME = '7000000000000002';

const CREATED: Thread = {
  id: THREAD,
  channel_id: CHANNEL,
  parent_message_id: PARENT,
  name: 'Deploy talk',
  created_by: ME,
  archived: false,
  message_count: 0,
  created_at: '2026-10-01T12:00:00Z',
};

describe('draft threads', () => {
  it('a draft key is a client key, never a server id', () => {
    const key = draftThreadKey(CHANNEL, PARENT);
    expect(isDraftThreadKey(key)).toBe(true);
    expect(isDraftThreadKey(THREAD)).toBe(false);
    expect(isDraftThreadKey(null)).toBe(false);
  });

  it('a seeded draft window is complete (no history to page) and empty', () => {
    const store = createStateStore();
    const key = draftThreadKey(CHANNEL, PARENT);
    seedDraftThread(store, key);
    expect(store.getState().messagesByThread[key]).toEqual({
      items: [],
      oldestId: null,
      hasCompleteHistory: true,
    });
    dropEmptyDraftThread(store, key);
    expect(store.getState().messagesByThread[key]).toBeUndefined();
  });

  it('promotion moves the window, its rows and its send records to the thread in one write', () => {
    const store = createStateStore();
    const key = draftThreadKey(CHANNEL, PARENT);
    seedDraftThread(store, key);
    const first = beginOptimisticSend(store, {
      channel_id: CHANNEL,
      thread_id: key,
      author_id: ME,
      content: 'first',
    });
    const second = beginOptimisticSend(store, {
      channel_id: CHANNEL,
      thread_id: key,
      author_id: ME,
      content: 'second',
    });
    holdFailedSend(store, second.nonce, { key: 'internal', code: 50000, message: 'x' });
    const before = store.getState().messagesByThread[key]!.items;

    let writes = 0;
    const unsub = store.subscribe(() => (writes += 1));
    promoteDraftThread(store, key, CREATED);
    unsub();

    const s = store.getState();
    expect(writes).toBe(1);
    expect(s.messagesByThread[key]).toBeUndefined();
    const slice = s.messagesByThread[THREAD]!;
    expect(slice.hasCompleteHistory).toBe(true);
    expect(slice.items.map((m) => m.client_key)).toEqual(before.map((m) => m.client_key));
    expect(slice.items.every((m) => m.thread_id === THREAD)).toBe(true);
    expect(s.pendingByNonce[first.nonce]?.thread_id).toBe(THREAD);
    expect(s.failedByNonce[second.nonce]?.thread_id).toBe(THREAD);
    expect(s.threadsById[THREAD]).toEqual(CREATED);
    expect(s.threadIdsByChannel[CHANNEL]).toEqual([THREAD]);
  });

  it('a thread record the gateway already delivered is kept; a bare id re-aims sends only', () => {
    const store = createStateStore();
    const key = draftThreadKey(CHANNEL, PARENT);
    const richer = { ...CREATED, member_state: { notify: true, last_read_id: null } };
    store.setState({ threadsById: { [THREAD]: richer }, threadIdsByChannel: { [CHANNEL]: [THREAD] } });
    seedDraftThread(store, key);
    const sent = beginOptimisticSend(store, {
      channel_id: CHANNEL,
      thread_id: key,
      author_id: ME,
      content: 'late',
    });
    promoteDraftThread(store, key, THREAD);
    const s = store.getState();
    expect(s.threadsById[THREAD]).toBe(richer);
    expect(s.threadIdsByChannel[CHANNEL]).toEqual([THREAD]);
    expect(s.pendingByNonce[sent.nonce]?.thread_id).toBe(THREAD);
    expect(s.messagesByThread[THREAD]?.items.map((m) => m.content)).toEqual(['late']);
  });
});
