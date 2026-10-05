/**
 * @cytale/state — the unread floor and the server-supplied count (tui plan U11,
 * R22a; the same fields the message-marks plan folds through).
 *
 * Two facts the READ_STATE_SYNC frame already carries reach the store here:
 *
 *   * `unread_floor` — the EXCLUSIVE floor a hand mark-unread sets. The
 *     handler used to DROP it, so a store entry could not distinguish "read up
 *     to here" from "this message and everything after it is unread", and an
 *     acknowledgement (which owns the watermark only) could not tell whether it
 *     was clearing a range the member marked by hand.
 *   * `unread_count` — the server's own count for the channel. @cytale/protocol
 *     does not declare this field yet (that edit is U2's), so reconcile reads
 *     it off the frame present-or-absent.
 *
 * The derived badge (unread.ts) then honours the floor in its local
 * derivation, and prefers the server count for a channel whose messages are
 * NOT loaded — the one case the local count cannot answer, because it accrues
 * from live gateway traffic and a channel the member never opened has none.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import type { GatewayEvent } from '@cytale/protocol';

import { createStateStore, type StateStore } from '../store.js';
import { applyGatewayEvent } from '../reconcile.js';
import {
  channelUnreadCount,
  clearChannelFloor,
  deriveChannelBadge,
  deriveTotalBadge,
  markChannelRead,
} from '../unread.js';

const CHANNEL = '3000000000000000001';
const CHANNEL_2 = '3000000000000000002';
const USER_ME = '7000000000000002';
const USER_OTHER = '7000000000000001';

// Snowflakes are decimal strings (>53-bit safe); length 16 here, so the
// package's length-then-lexicographic comparison orders them numerically.
const M1 = '1000000000000001';
const M2 = '1000000000000002';
const M3 = '1000000000000003';

let seq = 0;
function dispatch(t: string, d: unknown): GatewayEvent {
  seq += 1;
  return { op: 0, t, s: seq, d } as unknown as GatewayEvent;
}

beforeEach(() => {
  seq = 0;
});

function seedStore(): StateStore {
  const store = createStateStore();
  store.setState({ currentUser: { id: USER_ME, username: 'me' } });
  return store;
}

/** Apply a READ_STATE_SYNC frame for one channel. */
function syncReadState(
  store: StateStore,
  channelId: string,
  entry: { last_read_id: string | null; unread_floor?: string | null; unread_count?: number },
): void {
  applyGatewayEvent(
    store,
    dispatch('ReadStateSync', {
      channels: [{ channel_id: channelId, ...entry }],
    }),
  );
}

/** Land a live message in a channel's slice (and its unread accrual). */
function seedMessages(store: StateStore, ids: string[]): void {
  for (const id of ids) {
    applyGatewayEvent(
      store,
      dispatch('MessageCreate', {
        id,
        channel_id: CHANNEL,
        thread_id: null,
        author_id: USER_OTHER,
        content: 'hello',
        created_at: '2026-09-13T00:00:00Z',
        edited_at: null,
      }),
    );
  }
}

describe('READ_STATE_SYNC folds the watermark, the floor, and the server count', () => {
  it('populates all three fields for a channel the client has never seen', () => {
    const store = seedStore();

    syncReadState(store, CHANNEL, { last_read_id: M2, unread_floor: M1, unread_count: 4 });

    const entry = store.getState().unreadByChannel[CHANNEL];
    expect(entry).toMatchObject({
      last_read_id: M2,
      unread_floor: M1,
      server_unread_count: 4,
    });
  });

  it('reads the count defensively: an older server that omits it reports none', () => {
    const store = seedStore();

    syncReadState(store, CHANNEL, { last_read_id: M2, unread_floor: null });

    const entry = store.getState().unreadByChannel[CHANNEL];
    expect(entry!.server_unread_count).toBeNull();
    // Not zero, and not "unknown" leaking into the badge: the local count stands in.
    expect(entry!.unread_count).toBe(0);
  });

  it('ignores a non-numeric count rather than trusting it', () => {
    const store = seedStore();

    syncReadState(store, CHANNEL, {
      last_read_id: M2,
      unread_floor: null,
      unread_count: 'lots' as unknown as number,
    });

    expect(store.getState().unreadByChannel[CHANNEL]!.server_unread_count).toBeNull();
  });
});

describe('the floor excludes the message it names from the read set', () => {
  it('counts the floored message and everything newer, whatever the watermark says', () => {
    const store = seedStore();
    seedMessages(store, [M1, M2, M3]);

    // The watermark claims everything through M3 is read; the floor says M2
    // and everything after it is unread — the floor is what wins.
    syncReadState(store, CHANNEL, { last_read_id: M3, unread_floor: M2, unread_count: 2 });

    expect(deriveChannelBadge(store, CHANNEL)).toBe(2);
  });

  it('is what makes the difference: no floor, same watermark, no badge', () => {
    const store = seedStore();
    seedMessages(store, [M1, M2, M3]);

    syncReadState(store, CHANNEL, { last_read_id: M3, unread_floor: null, unread_count: 0 });

    expect(deriveChannelBadge(store, CHANNEL)).toBe(0);
  });

  it('an acknowledgement clears the counts but keeps the floor', () => {
    const store = seedStore();
    seedMessages(store, [M1, M2, M3]);
    syncReadState(store, CHANNEL, { last_read_id: M1, unread_floor: M2, unread_count: 2 });

    markChannelRead(store, CHANNEL, M3);

    const entry = store.getState().unreadByChannel[CHANNEL]!;
    expect(entry.last_read_id).toBe(M3);
    expect(entry.unread_floor).toBe(M2);
    // The hand-marked range survives the ack: M2 and M3 are still unread.
    expect(deriveChannelBadge(store, CHANNEL)).toBe(2);
  });
});

describe('a channel whose messages are not loaded renders the server-supplied count', () => {
  it('prefers the server count over a locally accrued one (R22a)', () => {
    const store = seedStore();
    // Live gateway traffic on a channel whose slice this store never built:
    // the local accrual says 2, the server says 9.
    store.setState({
      unreadByChannel: {
        [CHANNEL]: { last_read_id: null, unread_count: 2, mention_count: 0 },
      },
    });

    syncReadState(store, CHANNEL, { last_read_id: null, unread_floor: null, unread_count: 9 });

    expect(store.getState().messagesByChannel[CHANNEL]).toBeUndefined();
    // Lane D #2: the server's count is a snapshot that already covers what
    // was accrued locally before it, so the local count restarts at zero and
    // counts only what arrives after — the badge never counts one twice.
    expect(store.getState().unreadByChannel[CHANNEL]!.unread_count).toBe(0);
    expect(deriveChannelBadge(store, CHANNEL)).toBe(9);
    expect(deriveTotalBadge(store)).toBe(9);
  });

  it('counts live traffic that lands AFTER the server snapshot on top of it (lane D #2)', () => {
    const store = seedStore();
    syncReadState(store, CHANNEL, { last_read_id: null, unread_floor: null, unread_count: 9 });
    store.setState((s) => ({
      unreadByChannel: {
        [CHANNEL]: { ...s.unreadByChannel[CHANNEL]!, unread_count: 1 },
      },
    }));
    expect(deriveChannelBadge(store, CHANNEL)).toBe(10);
    expect(channelUnreadCount(store.getState().unreadByChannel[CHANNEL])).toBe(10);
  });

  it('falls back to the local count — never to zero — when the server reported none', () => {
    const store = seedStore();
    store.setState({
      unreadByChannel: {
        [CHANNEL]: { last_read_id: null, unread_count: 2, mention_count: 0 },
      },
    });

    syncReadState(store, CHANNEL, { last_read_id: null, unread_floor: null });

    expect(deriveChannelBadge(store, CHANNEL)).toBe(2);
  });

  it('is still zero for a channel neither the server nor the store knows about', () => {
    const store = seedStore();

    expect(deriveChannelBadge(store, CHANNEL_2)).toBe(0);
    expect(deriveTotalBadge(store)).toBe(0);
  });

  it('does NOT override a loaded channel: the live slice stays authoritative', () => {
    // The three shipping clients render this derivation today; the server
    // count is a fallback for the unloaded case, not a replacement.
    const store = seedStore();
    seedMessages(store, [M1, M2, M3]);

    syncReadState(store, CHANNEL, { last_read_id: M1, unread_floor: null, unread_count: 99 });

    expect(deriveChannelBadge(store, CHANNEL)).toBe(2);
  });
});

describe('ReadStateUpdate — a fired reminder (#54)', () => {
  let seqN = 900;
  const update = (d: Record<string, unknown>): GatewayEvent =>
    ({ op: 0, t: 'ReadStateUpdate', s: ++seqN, d }) as unknown as GatewayEvent;

  it('a cold client (no row) still gets the floor and the server count', () => {
    const store = createStateStore();
    applyGatewayEvent(
      store,
      update({ channel_id: CHANNEL, last_read_id: '3000000000000000050', unread_floor: '3000000000000000040', unread_count: 3 }),
    );
    const row = store.getState().unreadByChannel[CHANNEL]!;
    expect(row.unread_floor).toBe('3000000000000000040');
    expect(row.server_unread_count).toBe(3);
    expect(deriveChannelBadge(store, CHANNEL)).toBe(3);
  });

  it('applies when the watermark did not move (the sync would skip it), and never regresses the watermark', () => {
    const store = createStateStore();
    markChannelRead(store, CHANNEL, '3000000000000000060');
    applyGatewayEvent(
      store,
      update({ channel_id: CHANNEL, last_read_id: '3000000000000000050', unread_floor: '3000000000000000040', unread_count: 5 }),
    );
    const row = store.getState().unreadByChannel[CHANNEL]!;
    expect(row.unread_floor).toBe('3000000000000000040');
    expect(row.last_read_id).toBe('3000000000000000060');
  });

  it('a null floor clears it (another device read it); clearChannelFloor clears locally', () => {
    const store = createStateStore();
    applyGatewayEvent(store, update({ channel_id: CHANNEL, last_read_id: null, unread_floor: '3000000000000000040', unread_count: 1 }));
    applyGatewayEvent(store, update({ channel_id: CHANNEL, last_read_id: null, unread_floor: null, unread_count: 0 }));
    expect(store.getState().unreadByChannel[CHANNEL]!.unread_floor).toBeNull();

    applyGatewayEvent(store, update({ channel_id: CHANNEL, last_read_id: null, unread_floor: '3000000000000000040', unread_count: 1 }));
    clearChannelFloor(store, CHANNEL);
    expect(store.getState().unreadByChannel[CHANNEL]!.unread_floor).toBeNull();
  });
});
