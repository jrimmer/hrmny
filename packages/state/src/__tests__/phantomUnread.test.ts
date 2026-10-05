/**
 * The phantom unread badge (#logs, 2026-09-29): a channel showed "3 unread"
 * with nothing in it. Three messages arrived while the member was elsewhere,
 * were deleted, and the badge kept counting them — through the delete, through
 * every reload (the device snapshot restored the count and the session sync,
 * reporting the same watermark, was skipped), and through opening the channel
 * (nothing newer to ack). Each of those three paths now corrects the count.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import type { Message } from '@cytale/domain';
import type { GatewayEvent } from '@cytale/protocol';

import { createStateStore, type StateStore } from '../store.js';
import { applyGatewayEvent, mergeNewestPage } from '../reconcile.js';
import { withBatchedWrites } from '../batch.js';
import {
  channelMentionCount,
  channelUnreadCount,
  deriveTotalBadge,
  settleOpenChannelUnread,
} from '../unread.js';

const CHANNEL = '9007199254740993';
const ME = '7000000000000002';
const PEER = '7000000000000001';
/** The member's watermark: everything above it is unread. */
const READ = '1000000000000100';

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
    created_at: '2026-09-29T07:00:00Z',
    edited_at: null,
    ...overrides,
  };
}

/** A signed-in member whose session sync reported CHANNEL read up to READ. */
function syncedStore(unreadCount = 0): StateStore {
  const store = createStateStore();
  store.setState({ currentUser: { id: ME, username: 'me' } });
  applyGatewayEvent(
    store,
    dispatch('ReadStateSync', {
      channels: [
        { channel_id: CHANNEL, last_read_id: READ, unread_floor: null, unread_count: unreadCount, mention_count: 0 },
      ],
    }),
  );
  return store;
}

const create = (store: StateStore, m: Message) => applyGatewayEvent(store, dispatch('MessageCreate', m));
const del = (store: StateStore, id: string) =>
  applyGatewayEvent(store, dispatch('MessageDelete', { id, channel_id: CHANNEL, thread_id: null }));
const badge = (store: StateStore) => channelUnreadCount(store.getState().unreadByChannel[CHANNEL]);

beforeEach(() => {
  seq = 0;
});

describe('a deleted unread message leaves the badge', () => {
  it('counts up on create and back down on delete of the same message', () => {
    const store = syncedStore();
    create(store, msg('1000000000000201'));
    create(store, msg('1000000000000202'));
    create(store, msg('1000000000000203'));
    expect(badge(store)).toBe(3);

    del(store, '1000000000000202');
    expect(badge(store)).toBe(2);
    // A repeated delivery finds nothing left to remove: no second decrement.
    del(store, '1000000000000202');
    expect(badge(store)).toBe(2);

    del(store, '1000000000000201');
    del(store, '1000000000000203');
    expect(badge(store)).toBe(0);
    expect(deriveTotalBadge(store)).toBe(0);
  });

  it('a bulk purge (many deletes in one commit) clears the whole count', () => {
    const store = syncedStore();
    const ids = ['1000000000000301', '1000000000000302', '1000000000000303', '1000000000000304'];
    for (const id of ids) create(store, msg(id));
    expect(badge(store)).toBe(4);

    withBatchedWrites(store, () => {
      for (const id of ids) del(store, id);
    });
    expect(badge(store)).toBe(0);
    expect(store.getState().messagesByChannel[CHANNEL]?.items).toEqual([]);
  });

  it('deleting a read message or my own leaves the count alone', () => {
    const store = syncedStore();
    mergeNewestPage(store, CHANNEL, [msg('1000000000000050')]); // below the watermark
    create(store, msg('1000000000000401', { author_id: ME }));
    create(store, msg('1000000000000402'));
    expect(badge(store)).toBe(1);

    del(store, '1000000000000050');
    del(store, '1000000000000401');
    expect(badge(store)).toBe(1);
  });

  it('a message the server snapshot counted comes off the snapshot', () => {
    // The sync counted two rows the member has not read; the pane later loaded
    // them, and one is deleted — there is no live accrual to take it from.
    const store = syncedStore(2);
    mergeNewestPage(store, CHANNEL, [msg('1000000000000502'), msg('1000000000000501')]);
    expect(badge(store)).toBe(2);

    del(store, '1000000000000501');
    expect(badge(store)).toBe(1);
    expect(store.getState().unreadByChannel[CHANNEL]?.server_unread_count).toBe(1);
  });

  it('a deleted mention leaves the @ half too', () => {
    const store = syncedStore();
    create(store, msg('1000000000000601', { content: `hey <@${ME}>` }));
    create(store, msg('1000000000000602'));
    expect(channelMentionCount(store.getState().unreadByChannel[CHANNEL])).toBe(1);

    del(store, '1000000000000601');
    expect(badge(store)).toBe(1);
    expect(channelMentionCount(store.getState().unreadByChannel[CHANNEL])).toBe(0);
  });

  it('a deleted unread thread reply leaves the thread badge', () => {
    const store = syncedStore();
    const THREAD = '1000000000000700';
    applyGatewayEvent(
      store,
      dispatch('ThreadMessageCreate', { ...msg('1000000000000701'), thread_id: THREAD }),
    );
    expect(channelUnreadCount(store.getState().unreadByThread[THREAD])).toBe(1);

    applyGatewayEvent(
      store,
      dispatch('MessageDelete', { id: '1000000000000701', channel_id: CHANNEL, thread_id: THREAD }),
    );
    expect(channelUnreadCount(store.getState().unreadByThread[THREAD])).toBe(0);
  });
});

describe('the server count wins over a stale local one', () => {
  it('a sync at the SAME watermark overrides a count restored from the device snapshot', () => {
    // What the device snapshot restores: the watermark the member acked, plus
    // three live-accrued messages that have since been deleted.
    const store = createStateStore();
    store.setState({
      currentUser: { id: ME, username: 'me' },
      unreadByChannel: { [CHANNEL]: { last_read_id: READ, unread_count: 3, mention_count: 1 } },
    });
    expect(badge(store)).toBe(3);

    applyGatewayEvent(
      store,
      dispatch('ReadStateSync', {
        channels: [
          { channel_id: CHANNEL, last_read_id: READ, unread_floor: null, unread_count: 0, mention_count: 0 },
        ],
      }),
    );
    expect(badge(store)).toBe(0);
    expect(channelMentionCount(store.getState().unreadByChannel[CHANNEL])).toBe(0);
    expect(store.getState().unreadByChannel[CHANNEL]?.last_read_id).toBe(READ);
  });

  it('a local watermark strictly AHEAD of the server is still kept (an ack in flight)', () => {
    const store = createStateStore();
    store.setState({
      unreadByChannel: { [CHANNEL]: { last_read_id: '1000000000000900', unread_count: 0, mention_count: 0 } },
    });
    applyGatewayEvent(
      store,
      dispatch('ReadStateSync', {
        channels: [{ channel_id: CHANNEL, last_read_id: READ, unread_floor: null, unread_count: 4 }],
      }),
    );
    expect(store.getState().unreadByChannel[CHANNEL]?.last_read_id).toBe('1000000000000900');
    expect(badge(store)).toBe(0);
  });
});

describe('opening a channel with nothing unread in it clears its badge', () => {
  function staleStore(): StateStore {
    const store = createStateStore();
    store.setState({
      currentUser: { id: ME, username: 'me' },
      unreadByChannel: {
        [CHANNEL]: {
          last_read_id: READ,
          unread_count: 3,
          mention_count: 0,
          server_unread_count: 2,
          server_mention_count: 1,
        },
      },
    });
    return store;
  }

  it('an empty channel (its whole history came back empty) settles to zero', () => {
    const store = staleStore();
    expect(badge(store)).toBe(5);
    mergeNewestPage(store, CHANNEL, [], { isLastPage: true });
    settleOpenChannelUnread(store, CHANNEL);
    expect(badge(store)).toBe(0);
    expect(channelMentionCount(store.getState().unreadByChannel[CHANNEL])).toBe(0);
    expect(store.getState().unreadByChannel[CHANNEL]?.last_read_id).toBe(READ);
  });

  it('a channel whose newest message is already read settles to zero', () => {
    const store = staleStore();
    mergeNewestPage(store, CHANNEL, [msg(READ), msg('1000000000000090')], { isLastPage: true });
    settleOpenChannelUnread(store, CHANNEL);
    expect(badge(store)).toBe(0);
  });

  it('a window that still holds an unread row is left to the ack', () => {
    const store = staleStore();
    mergeNewestPage(store, CHANNEL, [msg('1000000000000200'), msg(READ)], { isLastPage: true });
    settleOpenChannelUnread(store, CHANNEL);
    expect(badge(store)).toBe(5);
  });

  it('nothing is judged before a page has loaded, or under a hand-set floor', () => {
    const store = staleStore();
    settleOpenChannelUnread(store, CHANNEL); // no slice at all
    expect(badge(store)).toBe(5);

    create(store, msg('1000000000000050', { author_id: ME })); // a live-only slice, no page
    settleOpenChannelUnread(store, CHANNEL);
    expect(badge(store)).toBe(5);

    const floored = staleStore();
    floored.setState((s) => ({
      unreadByChannel: { [CHANNEL]: { ...s.unreadByChannel[CHANNEL]!, unread_floor: READ } },
    }));
    mergeNewestPage(floored, CHANNEL, [], { isLastPage: true });
    settleOpenChannelUnread(floored, CHANNEL);
    expect(badge(floored)).toBe(5);
  });
});
