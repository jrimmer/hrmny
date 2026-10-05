/**
 * @cytale/web — useTyping tests (U23).
 *
 * TYPING_START dispatches render a typist; the typist expires after
 * TYPING_TIMEOUT_MS of no fresh events; sendTyping is throttled and
 * thread-scoped typing keys separately from the channel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, render } from '@testing-library/react';
import React from 'react';

import type { GatewayClient } from '@cytale/gateway-client';

import { useTyping, useTypists, TYPING_TIMEOUT_MS, type UseTyping } from '../useTyping.js';

const CHANNEL = '9007199254740993';
const THREAD = '9007199254741000';
const USER_A = '7000000000000001';
const USER_B = '7000000000000002';

/** Minimal fake gateway exposing the U23 surface. */
class FakeGateway {
  handlers = new Map<string, (payload: unknown) => void>();
  typingSent: { channelId: string; threadId?: string }[] = [];

  on(eventName: string, handler: (payload: unknown) => void): () => void {
    this.handlers.set(eventName, handler);
    return () => this.handlers.delete(eventName);
  }

  sendTyping(channelId: string, threadId?: string): boolean {
    this.typingSent.push({ channelId, threadId });
    return true;
  }

  emitTyping(payload: {
    channel_id: string;
    thread_id: string | null;
    user_id: string;
    timestamp: number;
  }): void {
    this.handlers.get('TypingStart')?.(payload);
  }
}

let fake: FakeGateway;

beforeEach(() => {
  fake = new FakeGateway();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useTyping', () => {
  it('renders a typist on TYPING_START and clears after the timeout', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useTyping(fake as unknown as GatewayClient));

    act(() => {
      fake.emitTyping({ channel_id: CHANNEL, thread_id: null, user_id: USER_A, timestamp: 1000 });
    });
    expect(result.current.typists(CHANNEL)).toHaveLength(1);
    expect(result.current.typists(CHANNEL)[0]!.userId).toBe(USER_A);

    act(() => {
      vi.advanceTimersByTime(TYPING_TIMEOUT_MS + 1);
    });
    expect(result.current.typists(CHANNEL)).toHaveLength(0);
  });

  it('keeps a typist alive on fresh events (resets the expiry clock)', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useTyping(fake as unknown as GatewayClient));

    act(() => {
      fake.emitTyping({ channel_id: CHANNEL, thread_id: null, user_id: USER_A, timestamp: 1000 });
    });
    act(() => {
      vi.advanceTimersByTime(TYPING_TIMEOUT_MS - 1000);
    });
    act(() => {
      fake.emitTyping({ channel_id: CHANNEL, thread_id: null, user_id: USER_A, timestamp: 2000 });
    });
    act(() => {
      vi.advanceTimersByTime(TYPING_TIMEOUT_MS - 1000);
    });
    expect(result.current.typists(CHANNEL)).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.typists(CHANNEL)).toHaveLength(0);
  });

  it('orders multiple typists newest-first', () => {
    const { result } = renderHook(() => useTyping(fake as unknown as GatewayClient));

    act(() => {
      fake.emitTyping({ channel_id: CHANNEL, thread_id: null, user_id: USER_A, timestamp: 1000 });
      fake.emitTyping({ channel_id: CHANNEL, thread_id: null, user_id: USER_B, timestamp: 2000 });
    });

    const typists = result.current.typists(CHANNEL);
    expect(typists.map((t) => t.userId)).toEqual([USER_B, USER_A]);
  });

  it('thread-scoped typing keys separately from the channel', () => {
    const { result } = renderHook(() => useTyping(fake as unknown as GatewayClient));

    act(() => {
      fake.emitTyping({ channel_id: CHANNEL, thread_id: null, user_id: USER_A, timestamp: 1000 });
      fake.emitTyping({ channel_id: CHANNEL, thread_id: THREAD, user_id: USER_B, timestamp: 2000 });
    });

    expect(result.current.typists(CHANNEL)).toHaveLength(1);
    expect(result.current.typists(CHANNEL, THREAD)).toHaveLength(1);
    expect(result.current.typists(CHANNEL, THREAD)[0]!.userId).toBe(USER_B);
  });

  it('sendTyping emits through the gateway (throttled by the client)', () => {
    const { result } = renderHook(() => useTyping(fake as unknown as GatewayClient));

    act(() => {
      result.current.sendTyping(CHANNEL);
      result.current.sendTyping(CHANNEL, THREAD);
    });

    expect(fake.typingSent).toEqual([
      { channelId: CHANNEL },
      { channelId: CHANNEL, threadId: THREAD },
    ]);
  });

  it('expires after 7 s — longer than the 5 s emit interval (lane D #21)', () => {
    expect(TYPING_TIMEOUT_MS).toBe(7_000);
  });
});

describe('render isolation (lane D #17)', () => {
  it('a TypingStart re-renders only the surface showing that channel, and never the hook host', () => {
    const OTHER = '9007199254740994';
    const renders = { host: 0, a: 0, b: 0 };
    let typing: UseTyping | null = null;
    const seen: UseTyping[] = [];

    function Line({ t, channelId, tag }: { t: UseTyping; channelId: string; tag: 'a' | 'b' }) {
      renders[tag] += 1;
      const typists = useTypists(t, channelId, null);
      return React.createElement('span', { 'data-testid': tag }, String(typists.length));
    }
    // The composer's shape: it calls useTyping() for emission and hands the
    // object to a child that shows the typists.
    function Host() {
      renders.host += 1;
      const t = useTyping(fake as unknown as GatewayClient);
      typing = t;
      seen.push(t);
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(Line, { t, channelId: CHANNEL, tag: 'a' }),
        React.createElement(Line, { t, channelId: OTHER, tag: 'b' }),
      );
    }

    const view = render(React.createElement(Host));
    const before = { ...renders };

    act(() => {
      fake.emitTyping({ channel_id: CHANNEL, thread_id: null, user_id: USER_A, timestamp: 1000 });
    });

    expect(view.getByTestId('a').textContent).toBe('1');
    expect(view.getByTestId('b').textContent).toBe('0');
    expect(renders.a).toBe(before.a + 1);
    expect(renders.b, 'another channel does not re-render').toBe(before.b);
    expect(renders.host, 'the composer (hook host) does not re-render').toBe(before.host);
    // And the object the composer's callbacks depend on is stable.
    expect(new Set(seen).size).toBe(1);
    expect(typing).not.toBeNull();
  });
});
