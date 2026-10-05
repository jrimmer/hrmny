/**
 * Lane D guarantees for the headless store: READY keeps the member's data
 * (#1), rosters replace in one commit (#5), badges fold the server counts
 * (#2), the optimistic row keeps its identity and position (#12), retries
 * reuse the nonce (#22), bursts commit once (#18), the watermark is not
 * reactive (#17), a disjoint newest page replaces the slice (#23), and slices
 * outside the recency set are trimmed rather than kept whole (#16).
 */
import { beforeEach, describe, expect, it } from 'vitest';

import type { Message, Thread, WorkspaceMember } from '@cytale/domain';
import type { GatewayEvent } from '@cytale/protocol';

import { createStateStore, EVICTED_SLICE_ROWS, RECENT_CHANNELS_MAX, type StateStore } from '../store.js';
import {
  applyGatewayEvent,
  hasLoadedHistory,
  mergeChannelMessages,
  mergeNewestPage,
  resetForFreshSession,
} from '../reconcile.js';
import {
  beginOptimisticSend,
  confirmOptimisticSend,
  failOptimisticSend,
  retryFailedSend,
} from '../optimistic.js';
import { channelMentionCount, channelUnreadCount, markChannelRead } from '../unread.js';
import { withBatchedWrites } from '../batch.js';
import { touchChannel } from '../lru.js';
import { replaceMembers, replaceRoster, replaceThreads } from '../roster.js';

const CHANNEL = '9007199254740993';
const OTHER = '9007199254740994';
const ME = '7000000000000002';
const PEER = '7000000000000001';

let seq = 0;
function dispatch(t: string, d: unknown): GatewayEvent {
  seq += 1;
  return { op: 0, t, s: seq, d } as unknown as GatewayEvent;
}

function msg(id: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    channel_id: CHANNEL,
    thread_id: null,
    author_id: PEER,
    content: `m${id}`,
    created_at: '2026-09-27T00:00:00Z',
    edited_at: null,
    ...overrides,
  };
}

function notifications(store: StateStore, run: () => void): number {
  let n = 0;
  const unsub = store.subscribe(() => {
    n += 1;
  });
  try {
    run();
  } finally {
    unsub();
  }
  return n;
}

beforeEach(() => {
  seq = 0;
});

describe('unread badges fold the server snapshot (#2)', () => {
  it('reads server + live accrual, and a mention count rides the sync', () => {
    const store = createStateStore();
    store.setState({ currentUser: { id: ME, username: 'me' } });
    applyGatewayEvent(
      store,
      dispatch('ReadStateSync', {
        channels: [
          { channel_id: CHANNEL, last_read_id: null, unread_floor: null, unread_count: 7, mention_count: 2 },
        ],
      }),
    );
    let u = store.getState().unreadByChannel[CHANNEL];
    expect(channelUnreadCount(u)).toBe(7);
    expect(channelMentionCount(u)).toBe(2);

    // A live mention after the snapshot lands ON TOP of it.
    applyGatewayEvent(
      store,
      dispatch('MessageCreate', { ...msg('1000000000000009'), content: `hi <@${ME}>` }),
    );
    u = store.getState().unreadByChannel[CHANNEL];
    expect(channelUnreadCount(u)).toBe(8);
    expect(channelMentionCount(u)).toBe(3);

    // Reading the channel answers both halves.
    markChannelRead(store, CHANNEL, '1000000000000009');
    u = store.getState().unreadByChannel[CHANNEL];
    expect(channelUnreadCount(u)).toBe(0);
    expect(channelMentionCount(u)).toBe(0);
  });

  it('keeps the local count when the server reports none (never zero)', () => {
    const store = createStateStore();
    store.setState({
      unreadByChannel: { [CHANNEL]: { last_read_id: null, unread_count: 3, mention_count: 1 } },
    });
    applyGatewayEvent(
      store,
      dispatch('ReadStateSync', {
        channels: [{ channel_id: CHANNEL, last_read_id: null, unread_floor: null, unread_count: null }],
      }),
    );
    expect(channelUnreadCount(store.getState().unreadByChannel[CHANNEL])).toBe(3);
    expect(channelMentionCount(store.getState().unreadByChannel[CHANNEL])).toBe(1);
  });
});

describe('the optimistic row (#12, #22)', () => {
  it('keeps one client key from placeholder to confirmed row', () => {
    const store = createStateStore();
    const { nonce } = beginOptimisticSend(store, {
      channel_id: CHANNEL,
      thread_id: null,
      author_id: ME,
      content: 'hello',
    });
    expect(store.getState().messagesByChannel[CHANNEL]!.items[0]!.client_key).toBe(nonce);
    confirmOptimisticSend(store, nonce, msg('1000000000000050', { author_id: ME, content: 'hello' }));
    const row = store.getState().messagesByChannel[CHANNEL]!.items[0]!;
    expect(row.id).toBe('1000000000000050');
    expect(row.client_key).toBe(nonce);
  });

  it('the gateway echo that beats the 201 inherits the key too', () => {
    const store = createStateStore();
    const { nonce } = beginOptimisticSend(store, {
      channel_id: CHANNEL,
      thread_id: null,
      author_id: ME,
      content: 'echo',
    });
    applyGatewayEvent(
      store,
      dispatch('MessageCreate', msg('1000000000000051', { author_id: ME, content: 'echo' })),
    );
    expect(store.getState().messagesByChannel[CHANNEL]!.items.map((m) => m.client_key)).toEqual([nonce]);
    confirmOptimisticSend(store, nonce, msg('1000000000000051', { author_id: ME, content: 'echo' }));
    const items = store.getState().messagesByChannel[CHANNEL]!.items;
    expect(items).toHaveLength(1);
    expect(items[0]!.client_key).toBe(nonce);
  });

  it('sorts the pending row by its send time, not always at the head', () => {
    const store = createStateStore();
    // A peer message minted well AFTER the placeholder's timestamp.
    const future = BigInt(Date.now() + 60_000 - 1_420_070_400_000) << 22n;
    mergeChannelMessages(store, CHANNEL, [msg(future.toString())]);
    beginOptimisticSend(store, { channel_id: CHANNEL, thread_id: null, author_id: ME, content: 'x' });
    const ids = store.getState().messagesByChannel[CHANNEL]!.items.map((m) => m.id);
    expect(ids[0]).toBe(future.toString());
    expect(ids[1]!.startsWith('pending_')).toBe(true);
  });

  it('a retry reuses the failed send\'s nonce', () => {
    const store = createStateStore();
    store.setState({ currentUser: { id: ME, username: 'me' } });
    const { nonce } = beginOptimisticSend(store, {
      channel_id: CHANNEL,
      thread_id: null,
      author_id: ME,
      content: 'again',
    });
    failOptimisticSend(store, nonce, { key: 'timeout', code: 0, message: 'timed out' });
    expect(retryFailedSend(store, nonce).nonce).toBe(nonce);
    // Or explicitly, as the composer does.
    expect(
      beginOptimisticSend(
        store,
        { channel_id: OTHER, thread_id: null, author_id: ME, content: 'x' },
        { nonce: 'fixed-nonce' },
      ).nonce,
    ).toBe('fixed-nonce');
  });
});

describe('a message delivered twice (resume overlap / nonce re-write)', () => {
  it('holds one row and counts ONE unread, whatever the seqs', () => {
    const store = createStateStore();
    store.setState({ currentUser: { id: ME, username: 'me' } });
    const m = msg('1000000000000080');
    applyGatewayEvent(store, dispatch('MessageCreate', m));
    applyGatewayEvent(store, dispatch('MessageCreate', m)); // same id, a later seq
    expect(store.getState().messagesByChannel[CHANNEL]!.items).toHaveLength(1);
    expect(channelUnreadCount(store.getState().unreadByChannel[CHANNEL])).toBe(1);
  });
});

describe('the watermark is not reactive (#17)', () => {
  it('a typing tick advances lastSeq without notifying anyone', () => {
    const store = createStateStore();
    const frame = dispatch('TypingStart', { channel_id: CHANNEL, user_id: PEER, timestamp: 1 });
    expect(notifications(store, () => applyGatewayEvent(store, frame))).toBe(0);
    expect(store.getState().lastSeq).toBe(frame.s);
  });

  it('an identical presence update writes nothing', () => {
    const store = createStateStore();
    const p = { user_id: PEER, status: 'online', last_seen_at: '2026-09-27T00:00:00Z' };
    applyGatewayEvent(store, dispatch('PresenceUpdate', p));
    const before = store.getState().presenceByUser;
    expect(
      notifications(store, () =>
        applyGatewayEvent(store, dispatch('PresenceUpdate', { ...p, last_seen_at: '2026-09-27T00:01:00Z' })),
      ),
    ).toBe(0);
    expect(store.getState().presenceByUser).toBe(before);
  });
});

describe('burst batching (#18)', () => {
  it('a READY burst commits once, and reads inside see the working state', () => {
    const store = createStateStore();
    let sawReady = false;
    const n = notifications(store, () =>
      withBatchedWrites(store, () => {
        applyGatewayEvent(
          store,
          dispatch('Ready', {
            v: 1,
            session_id: 's',
            resume_token: 'r',
            heartbeat_interval: 1,
            user: { id: ME, username: 'me' },
          }),
        );
        sawReady = store.getState().sessionStatus === 'ready';
        applyGatewayEvent(
          store,
          dispatch('PresenceUpdate', { user_id: PEER, status: 'online', last_seen_at: 'x' }),
        );
        applyGatewayEvent(store, dispatch('MessageCreate', msg('1000000000000070')));
      }),
    );
    expect(n).toBe(1);
    expect(sawReady).toBe(true);
    const s = store.getState();
    expect(s.presenceByUser[PEER]?.status).toBe('online');
    expect(s.messagesByChannel[CHANNEL]!.items).toHaveLength(1);
    expect(s.lastSeq).toBe(3);
  });
});

describe('newest-page merge (#23, #24)', () => {
  it('replaces a slice the page does not overlap (no permanent hole)', () => {
    const store = createStateStore();
    mergeChannelMessages(store, CHANNEL, [msg('1000000000000002'), msg('1000000000000001')]);
    mergeNewestPage(store, CHANNEL, [msg('1000000000000200'), msg('1000000000000100')]);
    const slice = store.getState().messagesByChannel[CHANNEL]!;
    expect(slice.items.map((m) => m.id)).toEqual(['1000000000000200', '1000000000000100']);
    expect(slice.oldestId).toBe('1000000000000100');
  });

  it('merges an overlapping page', () => {
    const store = createStateStore();
    mergeChannelMessages(store, CHANNEL, [msg('1000000000000002'), msg('1000000000000001')]);
    mergeNewestPage(store, CHANNEL, [msg('1000000000000003'), msg('1000000000000002')]);
    expect(store.getState().messagesByChannel[CHANNEL]!.items).toHaveLength(3);
  });

  it('a slice live traffic created is not "loaded history"', () => {
    const store = createStateStore();
    applyGatewayEvent(store, dispatch('MessageCreate', msg('1000000000000300')));
    expect(hasLoadedHistory(store.getState(), CHANNEL)).toBe(false);
    mergeChannelMessages(store, CHANNEL, [msg('1000000000000299')]);
    expect(hasLoadedHistory(store.getState(), CHANNEL)).toBe(true);
  });
});

describe('recency bound across channels (#16)', () => {
  it('trims channels that fall out of the recent set to one page', () => {
    const store = createStateStore();
    const many = Array.from({ length: EVICTED_SLICE_ROWS + 30 }, (_, i) =>
      msg(String(1000000000001000 + i)),
    );
    mergeChannelMessages(store, CHANNEL, many, { isLastPage: true });
    touchChannel(store, CHANNEL);
    for (let i = 0; i < RECENT_CHANNELS_MAX; i++) touchChannel(store, `8000000000000${100 + i}`);
    const slice = store.getState().messagesByChannel[CHANNEL]!;
    expect(slice.items).toHaveLength(EVICTED_SLICE_ROWS);
    expect(slice.hasCompleteHistory).toBe(false);
    expect(slice.oldestId).toBe(slice.items[slice.items.length - 1]!.id);
    expect(store.getState().recentChannelIds).toHaveLength(RECENT_CHANNELS_MAX);
  });
});

describe('roster replacement (#1, #5)', () => {
  const ws = { id: 'W1', name: 'one', owner_id: ME, role_version: 0, created_at: 'x' };
  const ch = {
    id: 'C1',
    workspace_id: 'W1',
    name: 'general',
    type: 'text' as const,
    parent_id: null,
    topic: null,
    position: 0,
    last_message_id: null,
    created_at: 'x',
  };

  it('an unchanged roster keeps every identity and writes nothing', () => {
    const store = createStateStore();
    replaceRoster(store, { workspaces: [ws], channels: [ch], dmChannels: [] });
    const before = store.getState();
    const n = notifications(store, () =>
      replaceRoster(store, { workspaces: [{ ...ws }], channels: [{ ...ch }], dmChannels: [] }),
    );
    expect(n).toBe(0);
    expect(store.getState().channels).toBe(before.channels);
  });

  it('threads and members replace per channel/workspace in one write each', () => {
    const store = createStateStore();
    const t = (id: string): Thread =>
      ({ id, channel_id: 'C1', parent_message_id: null, name: id, created_by: ME, archived: false, created_at: 'x' }) as Thread;
    replaceThreads(store, { C1: [t('T1'), t('T2')] });
    expect(notifications(store, () => replaceThreads(store, { C1: [t('T2')] }))).toBe(1);
    expect(store.getState().threadIdsByChannel['C1']).toEqual(['T2']);
    expect(store.getState().threadsById['T1']).toBeUndefined();

    const m = (id: string): WorkspaceMember =>
      ({ id, username: id, nickname: null, joined_at: '', roles: [] }) as WorkspaceMember;
    replaceMembers(store, { W1: [m('U1'), m('U2')] });
    expect(store.getState().memberIdsByWorkspace['W1']).toEqual(['U1', 'U2']);
  });

  it('logout clears the member data READY keeps', () => {
    const store = createStateStore();
    replaceRoster(store, { workspaces: [ws], channels: [ch], dmChannels: [] });
    resetForFreshSession(store);
    expect(store.getState().workspaces).toEqual({});
    expect(store.getState().rosterSource).toBe('none');
  });
});
