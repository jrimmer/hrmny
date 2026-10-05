/**
 * @cytale/web — usePresence tests (U23).
 *
 * PRESENCE_UPDATE dispatches applied to the U17 store aggregate into the
 * presence map; unknown users default to offline.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';

import { createStateStore, applyGatewayEvent, type StateStore } from '@cytale/state';

import { usePresence, presenceOf } from '../usePresence.js';

const USER_A = '7000000000000001';
const USER_B = '7000000000000002';

function makeStore(): StateStore {
  return createStateStore();
}

function presenceUpdate(userId: string, status: 'online' | 'idle' | 'dnd' | 'offline', seq: number) {
  return {
    op: 0,
    t: 'PresenceUpdate',
    s: seq,
    d: { user_id: userId, status, last_seen_at: '2026-08-30T00:00:00Z' },
  } as never;
}

afterEach(() => {
  // no global mocks to restore
});

describe('usePresence', () => {
  it('aggregates PRESENCE_UPDATE events into the presence map', () => {
    const store = makeStore();
    const { result } = renderHook(() => usePresence(store));

    act(() => {
      applyGatewayEvent(store, presenceUpdate(USER_A, 'online', 1));
      applyGatewayEvent(store, presenceUpdate(USER_B, 'dnd', 2));
    });

    expect(result.current[USER_A]).toBe('online');
    expect(result.current[USER_B]).toBe('dnd');
  });

  it('presenceOf returns offline for unknown users', () => {
    const store = makeStore();
    const { result } = renderHook(() => usePresence(store));

    expect(presenceOf(result.current, '9999999999999999')).toBe('offline');
  });

  it('a later PRESENCE_UPDATE overwrites the prior status', () => {
    const store = makeStore();
    const { result } = renderHook(() => usePresence(store));

    act(() => {
      applyGatewayEvent(store, presenceUpdate(USER_A, 'online', 1));
    });
    expect(result.current[USER_A]).toBe('online');

    act(() => {
      applyGatewayEvent(store, presenceUpdate(USER_A, 'idle', 2));
    });
    expect(result.current[USER_A]).toBe('idle');
  });
});
