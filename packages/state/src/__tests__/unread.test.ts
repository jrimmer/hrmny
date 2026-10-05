/**
 * @cytale/state — unread!.ts tests (U17).
 *
 * Unread state: last_read_id + mention_count per channel and per thread;
 * accrue on MESSAGE_CREATE; clear on ACK/scroll; derive badge counts.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { createStateStore } from '../store.js';
import { applyGatewayEvent } from '../reconcile.js';
import {
  markChannelRead,
  markThreadRead,
  deriveChannelBadge,
  deriveTotalBadge,
  resetChannelBadgeMemoForTests,
  channelBadgeComputationsForTests,
} from '../unread.js';

const CHANNEL = '9007199254740993';
const THREAD = '9007199254741000';
const USER_ME = '7000000000000002';
const USER_OTHER = '7000000000000001';

// Monotonic per-test dispatch sequence — the store's seq gate drops any
// dispatch with s <= lastSeq (duplicate/replay protection), so seeds must
// advance s. Reset per test via nextSeq().
let seqCounter = 0;
function nextSeq(): number {
  return ++seqCounter;
}

beforeEach(() => {
  seqCounter = 0; // fresh store per test gets a fresh sequence
});

function seedChannelWithMessages(
  store: ReturnType<typeof createStateStore>,
  ids: string[],
  mention = false,
  author: string = USER_OTHER,
) {
  for (const id of ids) {
    applyGatewayEvent(store, {
      op: 0,
      t: 'MessageCreate',
      s: nextSeq(),
      d: {
        id,
        channel_id: CHANNEL,
        thread_id: null,
        author_id: author,
        content: mention ? `ping <@${USER_ME}>` : 'hello',
        created_at: '2026-08-28T00:00:00Z',
        edited_at: null,
      },
    } as never);
  }
}

describe('unread accrual on MESSAGE_CREATE', () => {
  it('accrues an unread message for messages newer than last_read_id', () => {
    const store = createStateStore();
    store.setState({ currentUser: { id: USER_ME, username: 'me' } });
    seedChannelWithMessages(store, ['1000000000000201', '1000000000000202']);
    const u = store.getState().unreadByChannel[CHANNEL];
    expect(u!.last_read_id).toBeNull();
    // unread count accrues (exact derivation asserted in badge tests)
    expect(u!.mention_count).toBe(0);
  });

  it('does not accrue unread for my own messages', () => {
    const store = createStateStore();
    store.setState({ currentUser: { id: USER_ME, username: 'me' } });
    seedChannelWithMessages(store, ['1000000000000203'], false, USER_ME);
    // The accrual rule excludes own-author messages entirely.
    const items = store.getState().messagesByChannel[CHANNEL]!.items;
    expect(items).toHaveLength(1);
    // With me as author, unread count derivation yields 0.
    expect(deriveChannelBadge(store, CHANNEL)).toBe(0);
  });

  it('increments mention_count separately from the unread count', () => {
    const store = createStateStore();
    store.setState({ currentUser: { id: USER_ME, username: 'me' } });
    seedChannelWithMessages(store, ['1000000000000211', '1000000000000212'], true);
    expect(store.getState().unreadByChannel[CHANNEL]!.mention_count).toBe(2);
  });
});

describe('ack / scroll clears unread', () => {
  it('markChannelRead advances last_read_id and zeroes counts', () => {
    const store = createStateStore();
    store.setState({ currentUser: { id: USER_ME, username: 'me' } });
    // one mention among two messages
    seedChannelWithMessages(store, ['1000000000000221'], true);
    seedChannelWithMessages(store, ['1000000000000222']);
    expect(store.getState().unreadByChannel[CHANNEL]!.mention_count).toBe(1);

    markChannelRead(store, CHANNEL, '1000000000000222');
    const u = store.getState().unreadByChannel[CHANNEL];
    expect(u!.last_read_id).toBe('1000000000000222');
    expect(u!.mention_count).toBe(0);
    expect(deriveChannelBadge(store, CHANNEL)).toBe(0);
  });

  it('markChannelRead never regresses last_read_id to an older message', () => {
    const store = createStateStore();
    markChannelRead(store, CHANNEL, '1000000000000300');
    markChannelRead(store, CHANNEL, '1000000000000200'); // older
    expect(store.getState().unreadByChannel[CHANNEL]!.last_read_id).toBe('1000000000000300');
  });

  it('markThreadRead clears the thread unread tier without touching the parent channel', () => {
    const store = createStateStore();
    store.setState((s) => ({
      unreadByThread: {
        ...s.unreadByThread,
        [THREAD]: { last_read_id: null, mention_count: 2, unread_count: 5 },
      },
      unreadByChannel: {
        ...s.unreadByChannel,
        [CHANNEL]: { last_read_id: null, mention_count: 1, unread_count: 7 },
      },
    }));
    markThreadRead(store, THREAD, '1000000000000400');
    expect(store.getState().unreadByThread[THREAD]).toEqual({
      last_read_id: '1000000000000400',
      mention_count: 0,
      unread_count: 0,
    });
    expect(store.getState().unreadByChannel[CHANNEL]!.unread_count).toBe(7);
  });
});

describe('badge derivation', () => {
  it('derives a per-channel badge counting messages newer than last_read_id, excluding my own', () => {
    const store = createStateStore();
    store.setState({ currentUser: { id: USER_ME, username: 'me' } });
    applyGatewayEvent(store, {
      op: 0,
      t: 'Ready',
      s: nextSeq(),
      d: {
        v: 1,
        session_id: 's',
        resume_token: 'r',
        heartbeat_interval: 41250,
        user: { id: USER_ME, username: 'me' },
      },
    } as never);
    seedChannelWithMessages(store, [
      '1000000000000501',
      '1000000000000502',
      '1000000000000503',
    ]);
    // my own message should not count (it lands in the store but never accrues)
    applyGatewayEvent(store, {
      op: 0,
      t: 'MessageCreate',
      s: nextSeq(),
      d: {
        id: '1000000000000504',
        channel_id: CHANNEL,
        thread_id: null,
        author_id: USER_ME,
        content: 'mine',
        created_at: '2026-08-28T00:00:00Z',
        edited_at: null,
      },
    } as never);

    expect(deriveChannelBadge(store, CHANNEL)).toBe(3);
    markChannelRead(store, CHANNEL, '1000000000000502');
    expect(deriveChannelBadge(store, CHANNEL)).toBe(1);
  });

  it('derives a total badge across channels and threads', () => {
    const store = createStateStore();
    store.setState((s) => ({
      unreadByChannel: {
        ...s.unreadByChannel,
        ['9100000000000001']: { last_read_id: null, mention_count: 0, unread_count: 2 },
        ['9100000000000002']: { last_read_id: null, mention_count: 0, unread_count: 3 },
      },
      unreadByThread: {
        ...s.unreadByThread,
        ['9200000000000001']: { last_read_id: null, mention_count: 0, unread_count: 4 },
      },
    }));
    expect(deriveTotalBadge(store)).toBe(9);
  });

  it('returns zero badges for unknown channels', () => {
    const store = createStateStore();
    expect(deriveChannelBadge(store, '9999999999999999')).toBe(0);
    expect(deriveTotalBadge(store)).toBe(0);
  });
});

describe('badge derivation memoization (WEB-4)', () => {
  beforeEach(() => {
    // Fresh memo + counter per case: CHANNEL ids are reused across suites.
    resetChannelBadgeMemoForTests();
  });

  it('reuses the cached result while slice and read state are unchanged', () => {
    const store = createStateStore();
    store.setState({ currentUser: { id: USER_ME, username: 'me' } });
    seedChannelWithMessages(store, ['1000000000000301', '1000000000000302']);

    expect(deriveChannelBadge(store, CHANNEL)).toBe(2);
    expect(channelBadgeComputationsForTests()).toBe(1);

    // Store writes that touch NO derivation dep (presence churn, session
    // epoch) must not re-trigger the scan: same slice reference, same read
    // state. (A lastSeq bump here would gate the next seed's dispatch.)
    store.setState({
      presenceByUser: {
        [USER_OTHER]: { status: 'online', last_seen_at: '2026-08-28T00:00:00Z' },
      },
      sessionEpoch: 1,
    });
    expect(deriveChannelBadge(store, CHANNEL)).toBe(2);
    expect(channelBadgeComputationsForTests()).toBe(1);

    // A new message replaces the slice → exactly one recomputation.
    seedChannelWithMessages(store, ['1000000000000303']);
    expect(deriveChannelBadge(store, CHANNEL)).toBe(3);
    expect(channelBadgeComputationsForTests()).toBe(2);

    // Moving the watermark recomputes, even with the slice untouched.
    markChannelRead(store, CHANNEL, '1000000000000302');
    expect(deriveChannelBadge(store, CHANNEL)).toBe(1);
    expect(channelBadgeComputationsForTests()).toBe(3);
  });
});
