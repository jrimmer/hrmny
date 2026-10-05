/**
 * @cytale/web — ringReducer pure-function tests (calls plan U11).
 *
 * Reducer-level lifecycle independent of the driver: mount/replace, expiry,
 * removal, and the time math (`ringExpiryDelayMs`) that anchors the 30 s
 * window to the slice's `rang_at`.
 */
import { describe, expect, it } from 'vitest';

import { createStateStore } from '@cytale/state';

import {
  isDmRing,
  ringExpiryDelayMs,
  ringReducer,
  RING_TIMEOUT_MS,
  type RingToastState,
} from '../ringReducer.js';

function toast(channelId: string, callId: string, overrides: Partial<RingToastState> = {}): RingToastState {
  return {
    channelId,
    callId,
    fromUser: '7500000000000000002',
    rangAt: 1_000,
    subtle: false,
    ...overrides,
  };
}

describe('ringReducer', () => {
  it('mounts a toast, replaces same-channel, and keeps other channels stacked', () => {
    const a = toast('100', 'c1');
    const b = toast('200', 'c2');

    let state = ringReducer([], { type: 'ring', toast: a });
    expect(state).toEqual([a]);

    state = ringReducer(state, { type: 'ring', toast: b });
    expect(state.map((t) => t.callId)).toEqual(['c1', 'c2']); // stacked

    // A NEW call on channel 100 replaces its old toast, not the stack.
    const a2 = toast('100', 'c3');
    state = ringReducer(state, { type: 'ring', toast: a2 });
    expect(state.map((t) => t.callId)).toEqual(['c2', 'c3']);
  });

  it('expire removes exactly the matching call, not the channel stack', () => {
    const a = toast('100', 'c1');
    const b = toast('200', 'c2');
    let state = ringReducer([a, b], { type: 'ring', toast: b }); // no-op dup channel

    state = ringReducer(state, { type: 'expire', channelId: '100', callId: 'c1' });
    expect(state.map((t) => t.callId)).toEqual(['c2']);

    // An expiry for a stale call id must not drop a newer one.
    state = ringReducer(state, { type: 'ring', toast: toast('100', 'c9') });
    state = ringReducer(state, { type: 'expire', channelId: '100', callId: 'c1' });
    expect(state.map((t) => t.callId)).toEqual(['c2', 'c9']);
  });

  it('remove drops the whole channel', () => {
    const state = ringReducer(
      [toast('100', 'c1'), toast('200', 'c2')],
      { type: 'remove', channelId: '100' },
    );
    expect(state.map((t) => t.channelId)).toEqual(['200']);
  });
});

describe('ringExpiryDelayMs', () => {
  it('anchors the 30 s window to rang_at and clamps old rings to immediate', () => {
    expect(ringExpiryDelayMs(1_000, 1_000)).toBe(RING_TIMEOUT_MS);
    expect(ringExpiryDelayMs(1_000, 10_000)).toBe(RING_TIMEOUT_MS - 9_000);
    // A ring older than the window (delivered late / resumed tab): now.
    expect(ringExpiryDelayMs(1_000, 1_000 + RING_TIMEOUT_MS + 5_000)).toBe(0);
  });
});

describe('isDmRing', () => {
  it('discriminates by the channel record and by the live DM call slice', () => {
    const store = createStateStore();
    store.setState((s) => ({
      channels: {
        ...s.channels,
        hydrated: {
          id: 'hydrated',
          workspace_id: null,
          name: 'alice',
          type: 'dm',
          topic: null,
          position: 0,
          last_message_id: null,
          created_at: '2026-09-06T00:00:00Z',
        },
      },
      dmCallByChannel: { ...s.dmCallByChannel, unhydrated: {
        call_id: 'c1',
        thread_id: null,
        started_by: 'u1',
        started_at: '2026-09-06T12:00:00Z',
        participants: {},
      } },
    }));

    const state = store.getState();
    expect(isDmRing(state, 'hydrated')).toBe(true);
    expect(isDmRing(state, 'unhydrated')).toBe(true);
    expect(isDmRing(state, 'unknown-room')).toBe(false);
  });
});
