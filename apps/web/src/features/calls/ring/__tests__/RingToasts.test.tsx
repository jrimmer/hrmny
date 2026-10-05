/**
 * @cytale/web — ring toast lifecycle tests (calls plan U11, R7/AM6/AM19).
 *
 * Scenarios per the plan's test matrix:
 *   happy path — a room-channel ring mounts one toast (sound started),
 *     auto-expires 30 s FROM rang_at (a 10 s-old ring expires in 20 s),
 *     Join routes + fires the join intent, Dismiss clears the slice.
 *   edge — two simultaneous rings in different channels stack distinctly;
 *     a re-delivered call_id never remounts or extends the window; a ring
 *     while in another call = subtle toast, NO sound (in-call courtesy);
 *     a DM-channel ring mounts NOTHING (U10's DmCallIndicator owns it) and
 *     the slice stays readable.
 *   error path — a muted channel suppresses every surface and clears the
 *     slice (client-side belt over U4's server filter).
 *   integration — the AM19 no-op seam never throws while hidden.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStateStore, type StateStore } from '@cytale/state';

import { RingToasts } from '../RingToast.js';
import type { RingDriverDeps } from '../ringReducer.js';
import { RING_TIMEOUT_MS } from '../ringReducer.js';
import type { RingSoundController, RingSoundStartResult } from '../RingSound.js';
import type { CallEngine } from '../../useCallMedia.js';
import { setCallEngineForTests } from '../../useCallMedia.js';

// -- fixtures -----------------------------------------------------------------

const ROOM_A = '7500000000000000100';
const ROOM_B = '7500000000000000200';
const DM_CH = '7500000000000000300';
const ME = '7500000000000000001';
const CALLER = '7500000000000000002';
const CALL_A = '7500000000000000091';
const CALL_B = '7500000000000000092';
const CALL_DM = '7500000000000000093';
const BASE = Date.UTC(2026, 8, 6, 12, 0, 0);

function channel(id: string, name: string, type: 'text' | 'dm' = 'text') {
  return {
    id,
    workspace_id: type === 'dm' ? null : '7500000000000050001',
    name,
    type,
    topic: null,
    position: 0,
    last_message_id: null,
    created_at: '2026-09-06T00:00:00Z',
  };
}

function makeStore(): StateStore {
  const store = createStateStore();
  store.setState((s) => ({
    ...s,
    currentUser: { id: ME, username: 'me' },
    channels: {
      ...s.channels,
      [ROOM_A]: channel(ROOM_A, 'general'),
      [ROOM_B]: channel(ROOM_B, 'random'),
      [DM_CH]: channel(DM_CH, 'alice', 'dm'),
    },
    membersById: {
      ...s.membersById,
      [CALLER]: {
        id: CALLER,
        username: 'alice',
        nickname: null,
        joined_at: '',
        roles: [],
      },
    },
  }));
  return store;
}

function ring(
  channelId: string,
  callId: string,
  rangAt: number,
): { channel_id: string; call_id: string; from_user: string; rang_at: number } {
  return { channel_id: channelId, call_id: callId, from_user: CALLER, rang_at: rangAt };
}

function fakeSound(result: RingSoundStartResult = { audible: true }): RingSoundController {
  return {
    start: vi.fn(async () => result),
    stop: vi.fn(),
  };
}

function fakeEngine(): CallEngine {
  const listeners = new Set<() => void>();
  const speaking = new Set<string>();
  const snapshot = {
    voice: {
      status: 'idle',
      pcConnected: false,
      micGranted: false,
      notice: null,
    },
    channelId: null,
    muted: false,
    deafened: false,
  };
  return {
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    getSnapshot: () => snapshot,
    speakingSubscribe: () => () => undefined,
    getSpeaking: () => speaking,
    start: vi.fn(),
    join: vi.fn(),
    leave: vi.fn(),
    toggleMute: vi.fn(),
    toggleDeafen: vi.fn(),
    ring: vi.fn(),
    dismiss: vi.fn(),
    retry: vi.fn(),
    pollConnectionState: vi.fn(),
    destroy: vi.fn(),
  } as never;
}

function baseDeps(sound: ReturnType<typeof fakeSound>): RingDriverDeps {
  return {
    sound,
    isViewerInCall: () => false,
    isChannelMuted: () => false,
    isDocumentHidden: () => false,
    now: () => Date.now(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE);
});

afterEach(() => {
  cleanup();
  setCallEngineForTests(null);
  vi.useRealTimers();
});

function toasts(): HTMLElement[] {
  return screen.queryAllByTestId('ring-toast');
}

describe('ring toast lifecycle (happy path)', () => {
  it('mounts one toast per room-channel ring and starts the sound', async () => {
    const store = makeStore();
    const sound = fakeSound();
    render(<RingToasts store={store} deps={baseDeps(sound)} />);

    act(() => {
      store.setState((s) => ({
        callRingByChannel: { ...s.callRingByChannel, [ROOM_A]: ring(ROOM_A, CALL_A, Date.now()) },
      }));
    });

    const toast = screen.getByTestId('ring-toast');
    expect(toast.getAttribute('data-call-id')).toBe(CALL_A);
    expect(screen.getByTestId('ring-toast-title').textContent).toContain('general');
    expect(screen.getByTestId('ring-toast-title').textContent).toContain('alice');
    expect(screen.queryByTestId('ring-toast-subtle-note')).toBeNull();
    await act(async () => {
      await Promise.resolve(); // flush the sound-start promise chain
    });
    expect(sound.start).toHaveBeenCalledTimes(1);
  });

  it('auto-expires 30 s from rang_at (a 10 s-old ring goes in 20 s) and clears the slice', async () => {
    const store = makeStore();
    const sound = fakeSound();
    render(<RingToasts store={store} deps={baseDeps(sound)} />);

    act(() => {
      store.setState((s) => ({
        callRingByChannel: {
          ...s.callRingByChannel,
          [ROOM_A]: ring(ROOM_A, CALL_A, Date.now() - 10_000),
        },
      }));
    });
    expect(toasts()).toHaveLength(1);

    // 19.9 s later: still ringing.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RING_TIMEOUT_MS - 10_000 - 100);
    });
    expect(toasts()).toHaveLength(1);

    // The remaining 100 ms: expired, slice cleared, sound stopped.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(toasts()).toHaveLength(0);
    expect(store.getState().callRingByChannel[ROOM_A]).toBeUndefined();
    expect(sound.stop).toHaveBeenCalled();
  });

  it('Join navigates to the channel and fires the join intent; Dismiss clears', async () => {
    const store = makeStore();
    const engine = fakeEngine();
    setCallEngineForTests(engine);
    const onJoinChannel = vi.fn();
    render(
      <RingToasts store={store} deps={baseDeps(fakeSound())} onJoinChannel={onJoinChannel} />,
    );

    act(() => {
      store.setState((s) => ({
        callRingByChannel: { ...s.callRingByChannel, [ROOM_A]: ring(ROOM_A, CALL_A, Date.now()) },
      }));
    });

    fireEvent.click(screen.getByTestId('ring-toast-join'));
    expect(onJoinChannel).toHaveBeenCalledWith(ROOM_A);
    expect(engine.join).toHaveBeenCalledWith(ROOM_A);
    expect(store.getState().callRingByChannel[ROOM_A]).toBeUndefined();
    expect(toasts()).toHaveLength(0);

    // Dismiss path on a fresh ring.
    act(() => {
      store.setState((s) => ({
        callRingByChannel: {
          ...s.callRingByChannel,
          [ROOM_B]: ring(ROOM_B, CALL_B, Date.now()),
        },
      }));
    });
    fireEvent.click(screen.getByTestId('ring-toast-dismiss'));
    expect(store.getState().callRingByChannel[ROOM_B]).toBeUndefined();
    expect(toasts()).toHaveLength(0);
  });
});

describe('ring toast lifecycle (edge cases)', () => {
  it('stacks two simultaneous rings in different channels distinctly', () => {
    const store = makeStore();
    render(<RingToasts store={store} deps={baseDeps(fakeSound())} />);

    act(() => {
      store.setState((s) => ({
        callRingByChannel: {
          ...s.callRingByChannel,
          [ROOM_A]: ring(ROOM_A, CALL_A, Date.now()),
          [ROOM_B]: ring(ROOM_B, CALL_B, Date.now()),
        },
      }));
    });

    const cards = toasts();
    expect(cards).toHaveLength(2);
    expect(new Set(cards.map((c) => c.dataset.callId))).toEqual(new Set([CALL_A, CALL_B]));
    expect(screen.getByTestId('ring-toast-region').children).toHaveLength(2);
  });

  it('never remounts or extends the window on a same-call re-delivery', async () => {
    const store = makeStore();
    render(<RingToasts store={store} deps={baseDeps(fakeSound())} />);

    // A ring that arrived 25 s ago expires in 5 s (30 s from rang_at).
    act(() => {
      store.setState((s) => ({
        callRingByChannel: {
          ...s.callRingByChannel,
          [ROOM_A]: ring(ROOM_A, CALL_A, Date.now() - 25_000),
        },
      }));
    });
    expect(toasts()).toHaveLength(1);

    // The wire re-delivers the same call 2 s later: the store's dedupe
    // preserved rang_at, so the toast must still expire at t+5 s — never
    // re-arm to t+32 s.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    act(() => {
      store.setState((s) => ({
        callRingByChannel: {
          ...s.callRingByChannel,
          [ROOM_A]: s.callRingByChannel[ROOM_A]!,
        },
      }));
    });
    expect(toasts()).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    expect(toasts()).toHaveLength(1); // 4.5 s since mount — still up

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(toasts()).toHaveLength(0); // expired 30 s after the ORIGINAL stamp
  });

  it('renders a subtle toast with NO sound while the viewer is in another call', async () => {
    const store = makeStore();
    const sound = fakeSound();
    const deps: RingDriverDeps = { ...baseDeps(sound), isViewerInCall: () => true };
    render(<RingToasts store={store} deps={deps} />);

    act(() => {
      store.setState((s) => ({
        callRingByChannel: { ...s.callRingByChannel, [ROOM_A]: ring(ROOM_A, CALL_A, Date.now()) },
      }));
    });

    const toast = screen.getByTestId('ring-toast');
    expect(toast.getAttribute('data-subtle')).toBe('true');
    expect(screen.getByTestId('ring-toast-subtle-note')).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(sound.start).not.toHaveBeenCalled(); // in-call courtesy: no sound
  });

  it('stays silent on DM rings (U10 owns the surface) and leaves the slice readable', () => {
    const store = makeStore();
    const sound = fakeSound();
    render(<RingToasts store={store} deps={baseDeps(sound)} />);

    act(() => {
      store.setState((s) => ({
        callRingByChannel: {
          ...s.callRingByChannel,
          [DM_CH]: ring(DM_CH, CALL_DM, Date.now()),
        },
      }));
    });

    expect(toasts()).toHaveLength(0);
    expect(sound.start).not.toHaveBeenCalled();
    // The missed-call derivation (U10) still reads the entry.
    expect(store.getState().callRingByChannel[DM_CH]?.call_id).toBe(CALL_DM);
  });

  it('also treats an unhydrated channel with a live DM call as a DM ring', () => {
    const store = makeStore();
    const sound = fakeSound();
    render(<RingToasts store={store} deps={baseDeps(sound)} />);

    act(() => {
      store.setState((s) => ({
        dmCallByChannel: {
          ...s.dmCallByChannel,
          [ROOM_B]: {
            call_id: CALL_B,
            thread_id: null,
            started_by: CALLER,
            started_at: '2026-09-06T12:00:00Z',
            participants: {},
          },
        },
        callRingByChannel: {
          ...s.callRingByChannel,
          [ROOM_B]: ring(ROOM_B, CALL_B, Date.now()),
        },
      }));
    });

    expect(toasts()).toHaveLength(0);
    expect(sound.start).not.toHaveBeenCalled();
  });

  it('falls back to visual-only when audio cannot start (autoplay blocked)', async () => {
    const store = makeStore();
    const sound = fakeSound({ audible: false, reason: 'autoplay-blocked' });
    render(<RingToasts store={store} deps={baseDeps(sound)} />);

    act(() => {
      store.setState((s) => ({
        callRingByChannel: { ...s.callRingByChannel, [ROOM_A]: ring(ROOM_A, CALL_A, Date.now()) },
      }));
    });

    // The visual surface is fully functional without the sound.
    expect(toasts()).toHaveLength(1);
    expect((screen.getByTestId('ring-toast-join') as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RING_TIMEOUT_MS + 1_000);
    });
    expect(toasts()).toHaveLength(0); // expiry never depended on the audio
  });
});

describe('ring toast lifecycle (error + AM19 paths)', () => {
  it('suppresses every surface for a muted channel and clears the slice', () => {
    const store = makeStore();
    const sound = fakeSound();
    const deps: RingDriverDeps = {
      ...baseDeps(sound),
      isChannelMuted: (channelId) => channelId === ROOM_A,
    };
    render(<RingToasts store={store} deps={deps} />);

    act(() => {
      store.setState((s) => ({
        callRingByChannel: {
          ...s.callRingByChannel,
          [ROOM_A]: ring(ROOM_A, CALL_A, Date.now()),
        },
      }));
    });

    expect(toasts()).toHaveLength(0);
    expect(sound.start).not.toHaveBeenCalled();
    // Suppression also cleared the slice so the sidebar emphasis drops.
    expect(store.getState().callRingByChannel[ROOM_A]).toBeUndefined();
  });

  it('calls the AM19 background seam without throwing while document.hidden', () => {
    const store = makeStore();
    const sound = fakeSound();
    const deps: RingDriverDeps = {
      ...baseDeps(sound),
      isDocumentHidden: () => true,
    };
    expect(() => {
      render(<RingToasts store={store} deps={deps} />);
      act(() => {
        store.setState((s) => ({
          callRingByChannel: {
            ...s.callRingByChannel,
            [ROOM_A]: ring(ROOM_A, CALL_A, Date.now()),
          },
        }));
      });
    }).not.toThrow();
    // The documented V1 disposition: the toast is still the surface.
    expect(toasts()).toHaveLength(1);
  });
});
