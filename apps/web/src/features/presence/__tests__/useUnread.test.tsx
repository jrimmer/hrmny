/**
 * @cytale/web — useUnread tests (U23).
 *
 * Badge derivation from the U17 unread store; markChannelRead clears the
 * store badge and sends MESSAGE_ACK through the gateway.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, render, act } from '@testing-library/react';
import React from 'react';

import { createStateStore, applyGatewayEvent, type StateStore } from '@cytale/state';
import type { GatewayClient } from '@cytale/gateway-client';

import { ACK_DEBOUNCE_MS, useDebouncedChannelAck, useUnread } from '../useUnread.js';

const CHANNEL = '9007199254740993';
const ME = '7000000000000002';
const OTHER = '7000000000000001';

class FakeGateway {
  acks: { channel_id: string; message_ids: string[] }[] = [];
  sendMessageAck(payload: { channel_id: string; message_ids: string[] }): void {
    this.acks.push(payload);
  }
}

function makeStore(): StateStore {
  const store = createStateStore();
  store.setState({ currentUser: { id: ME, username: 'me' } });
  return store;
}

function messageCreate(id: string, authorId: string, seq: number) {
  return {
    op: 0,
    t: 'MessageCreate',
    s: seq,
    d: {
      id,
      channel_id: CHANNEL,
      thread_id: null,
      author_id: authorId,
      content: 'hi',
      created_at: '2026-08-30T00:00:00Z',
      edited_at: null,
    },
  } as never;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useUnread', () => {
  it('derives a channel badge from messages newer than last_read_id', () => {
    const store = makeStore();
    const fake = new FakeGateway();
    const { result } = renderHook(() => useUnread(store, fake as unknown as GatewayClient));

    act(() => {
      applyGatewayEvent(store, messageCreate('1000000000000001', OTHER, 1));
      applyGatewayEvent(store, messageCreate('1000000000000002', OTHER, 2));
    });

    expect(result.current.channelBadge(CHANNEL).unread).toBe(2);
  });

  it('excludes my own messages from the badge', () => {
    const store = makeStore();
    const fake = new FakeGateway();
    const { result } = renderHook(() => useUnread(store, fake as unknown as GatewayClient));

    act(() => {
      applyGatewayEvent(store, messageCreate('1000000000000001', OTHER, 1));
      applyGatewayEvent(store, messageCreate('1000000000000002', ME, 2));
    });

    expect(result.current.channelBadge(CHANNEL).unread).toBe(1);
  });

  it('markChannelRead clears the badge and sends MESSAGE_ACK', () => {
    const store = makeStore();
    const fake = new FakeGateway();
    const { result } = renderHook(() => useUnread(store, fake as unknown as GatewayClient));

    act(() => {
      applyGatewayEvent(store, messageCreate('1000000000000001', OTHER, 1));
    });
    expect(result.current.channelBadge(CHANNEL).unread).toBe(1);

    act(() => {
      result.current.markChannelRead(CHANNEL, '1000000000000001');
    });

    expect(result.current.channelBadge(CHANNEL).unread).toBe(0);
    expect(fake.acks).toEqual([{ channel_id: CHANNEL, message_ids: ['1000000000000001'] }]);
  });

  // WEB-3: the hook subscribes with a NARROW snapshot (unread maps + channel
  // message slices + current user), not the whole store — so gateway noise
  // that cannot move a badge (presence flips, seq bumps) must not re-render
  // badge consumers, while an unread-moving event must.
  it('a presence flip does not re-render badge consumers', () => {
    const store = makeStore();
    let renders = 0;
    function Probe(): null {
      renders += 1;
      useUnread(store, null);
      return null;
    }
    render(<Probe />);
    const afterMount = renders;

    act(() => {
      applyGatewayEvent(store, {
        op: 0,
        t: 'PresenceUpdate',
        s: 99,
        d: { user_id: OTHER, status: 'online', last_seen_at: '2026-08-30T00:00:00Z' },
      } as never);
    });

    expect(renders).toBe(afterMount);
  });

  it('a message that accrues unread still re-renders badge consumers', () => {
    const store = makeStore();
    let renders = 0;
    function Probe(): null {
      renders += 1;
      useUnread(store, null);
      return null;
    }
    render(<Probe />);
    const afterMount = renders;

    act(() => {
      applyGatewayEvent(store, messageCreate('1000000000000001', OTHER, 1));
    });

    expect(renders).toBeGreaterThan(afterMount);
  });
});

describe('useDebouncedChannelAck (lane D #20)', () => {
  function setVisibility(state: 'visible' | 'hidden'): void {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    document.dispatchEvent(new Event('visibilitychange'));
  }

  afterEach(() => {
    setVisibility('visible');
    vi.useRealTimers();
  });

  it('acks the open at once, then trailing-debounces live traffic to the newest id', () => {
    vi.useFakeTimers();
    const mark = vi.fn();
    const { rerender } = renderHook(
      ({ newest }: { newest: string }) => useDebouncedChannelAck(CHANNEL, newest, mark),
      { initialProps: { newest: '1000000000000001' } },
    );
    expect(mark).toHaveBeenCalledTimes(1);
    expect(mark).toHaveBeenLastCalledWith(CHANNEL, '1000000000000001');

    rerender({ newest: '1000000000000002' });
    rerender({ newest: '1000000000000003' });
    expect(mark).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(ACK_DEBOUNCE_MS);
    });
    expect(mark).toHaveBeenCalledTimes(2);
    expect(mark).toHaveBeenLastCalledWith(CHANNEL, '1000000000000003');
  });

  it('never acks while the tab is hidden, and flushes when it becomes visible', () => {
    vi.useFakeTimers();
    const mark = vi.fn();
    const { rerender } = renderHook(
      ({ newest }: { newest: string }) => useDebouncedChannelAck(CHANNEL, newest, mark),
      { initialProps: { newest: '1000000000000001' } },
    );
    expect(mark).toHaveBeenCalledTimes(1);
    act(() => setVisibility('hidden'));
    rerender({ newest: '1000000000000009' });
    act(() => {
      vi.advanceTimersByTime(ACK_DEBOUNCE_MS * 4);
    });
    expect(mark).toHaveBeenCalledTimes(1);
    act(() => setVisibility('visible'));
    expect(mark).toHaveBeenCalledTimes(2);
    expect(mark).toHaveBeenLastCalledWith(CHANNEL, '1000000000000009');
  });

  it('skips optimistic placeholders', () => {
    const mark = vi.fn();
    renderHook(() => useDebouncedChannelAck(CHANNEL, 'pending_abc', mark));
    expect(mark).not.toHaveBeenCalled();
  });
});
