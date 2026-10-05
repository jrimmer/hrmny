/**
 * @cytale/web — useCall seam tests (calls plan U8; calls V2 plan U5b).
 *
 * The U7 seam's call sites (channel header Start/Join, the sidebar slot)
 * now drive the REAL engine: intents route to start/join, isJoined stays a
 * store read (U6 slices), and the engine override isolates tests.
 *
 * V2 (U5b): the publish/quality/budget intents route through the engine;
 * the video wiring hooks (useCallVideoStreams/useCallVideoWant) subscribe
 * the engine's manifest-keyed track + want seams; the shared grid/stage
 * helpers are pinned directly (VM3 priority, VM18 degradation, VM22's
 * machine-driving contract lives in stageSelection's own tests).
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStateStore } from '@cytale/state';
import type { VideoWant } from '@cytale/protocol';

import {
  computeGridParticipants,
  mediaStreamForTrack,
  useCall,
  useCallEngineState,
  useCallVideoStreams,
  useCallVideoWant,
} from '../useCall.js';
import { setCallEngineForTests, type CallEngine } from '../useCallMedia.js';

function fakeEngine(): CallEngine & {
  start: ReturnType<typeof vi.fn>;
  join: ReturnType<typeof vi.fn>;
  __setSnapshot(next: unknown): void;
  __setWant(want: VideoWant): void;
  __setVideoTracks(tracks: Map<string, unknown>): void;
} {
  const listeners = new Set<() => void>();
  const videoListeners = new Set<() => void>();
  const wantListeners = new Set<() => void>();
  let snapshot = {
    voice: { status: 'idle', pcConnected: false, micGranted: false, notice: null },
    channelId: null,
    muted: false,
    deafened: false,
    publishing: { camera: false, screen: false, screen_audio: false },
  };
  const speaking = new Set<string>(); // identity-stable (uSES contract)
  let videoTracks: ReadonlyMap<string, unknown> = new Map();
  let want: VideoWant = { tiles: 9, max_quality: 'high' };
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
    videoSubscribe: (l: () => void) => {
      videoListeners.add(l);
      return () => {
        videoListeners.delete(l);
      };
    },
    getVideoTracks: () => videoTracks,
    wantSubscribe: (l: () => void) => {
      wantListeners.add(l);
      return () => {
        wantListeners.delete(l);
      };
    },
    getVideoWant: () => want,
    getReceiverMaxQuality: () => want.max_quality ?? 'high',
    setReceiverMaxQuality: vi.fn(),
    getPublishQuality: vi.fn(() => 'high'),
    getLocalPublishTrack: vi.fn(() => null),
    start: vi.fn(),
    join: vi.fn(),
    leave: vi.fn(),
    toggleMute: vi.fn(),
    toggleDeafen: vi.fn(),
    ring: vi.fn(),
    dismiss: vi.fn(),
    retry: vi.fn(),
    retryMic: vi.fn(),
    publishCamera: vi.fn(),
    publishScreen: vi.fn(),
    switchScreenSource: vi.fn(),
    unpublishSource: vi.fn(),
    setPublishQuality: vi.fn(),
    pollConnectionState: vi.fn(),
    destroy: vi.fn(),
    __setSnapshot(next: typeof snapshot) {
      snapshot = next;
      for (const l of [...listeners]) l();
    },
    __setWant(next: VideoWant) {
      want = next;
      for (const l of [...wantListeners]) l();
    },
    __setVideoTracks(next: Map<string, unknown>) {
      videoTracks = next;
      for (const l of [...videoListeners]) l();
    },
  } as never;
}

afterEach(() => {
  cleanup();
  setCallEngineForTests(null);
});

describe('useCall — engine driving (U8)', () => {
  it('startCall routes through the engine with the ring flag (AM17)', () => {
    const engine = fakeEngine();
    setCallEngineForTests(engine);
    const { result } = renderHook(() => useCall());

    result.current.startCall('c-1');
    result.current.startCall('c-1', { ring: true });

    expect(engine.start).toHaveBeenCalledWith('c-1', undefined);
    expect(engine.start).toHaveBeenCalledWith('c-1', { ring: true });
  });

  it('joinCall routes through the engine (return-vs-join is engine policy)', () => {
    const engine = fakeEngine();
    setCallEngineForTests(engine);
    const { result } = renderHook(() => useCall());

    result.current.joinCall('c-1');
    expect(engine.join).toHaveBeenCalledWith('c-1');
  });

  it('isJoined reads the U6 store slices (gateway-hydrated roster)', () => {
    const store = createStateStore();
    store.setState((s) => ({
      ...s,
      currentUser: { id: 'u-1', username: 'me' },
      callByChannel: {
        'c-1': {
          call_id: '99',
          thread_id: null,
          started_by: 'u-2',
          started_at: '2026-09-06T12:00:00Z',
          participants: {
            'u-2': { user_id: 'u-2', mute: false, deafen: false, leg: 'L2' },
          },
        },
      },
    }));
    const { result } = renderHook(() => useCall(store));

    expect(result.current.isJoined('c-1')).toBe(false);

    store.setState((s) => ({
      callByChannel: {
        'c-1': {
          ...s.callByChannel['c-1']!,
          participants: {
            ...s.callByChannel['c-1']!.participants,
            'u-1': { user_id: 'u-1', mute: false, deafen: false, leg: 'L1' },
          },
        },
      },
    }));
    expect(result.current.isJoined('c-1')).toBe(true);
    expect(result.current.isJoined('c-2')).toBe(false);
  });
});

describe('useCallEngineState — reactive engine snapshot', () => {
  it('re-renders when the engine snapshot changes', () => {
    const engine = fakeEngine();
    setCallEngineForTests(engine);
    const { result } = renderHook(() => useCallEngineState());

    expect(result.current.voice.status).toBe('idle');

    act(() => {
      (
        engine as unknown as { __setSnapshot: (n: typeof result.current) => void }
      ).__setSnapshot({
        voice: {
          status: 'connected',
          pcConnected: true,
          micGranted: true,
          micDenied: false,
          notice: null,
        },
        channelId: 'c-1',
        muted: false,
        deafened: false,
        listenOnly: false,
        publishing: { camera: false, screen: false, screen_audio: false },
      });
    });
    expect(result.current.voice.status).toBe('connected');
    expect(result.current.channelId).toBe('c-1');
  });
});

// ---------------------------------------------------------------------------
// V2 (U5b) — publish/quality/budget intents + the video wiring hooks
// ---------------------------------------------------------------------------

describe('useCall — V2 publish/quality/budget intents (U5b)', () => {
  it('publish/unpublish/quality/receiver intents route through the engine', () => {
    const engine = fakeEngine();
    setCallEngineForTests(engine);
    const { result } = renderHook(() => useCall());

    result.current.publishCamera('low');
    expect(engine.publishCamera).toHaveBeenCalledWith('low');

    result.current.publishScreen({ audio: true, quality: 'high' });
    expect(engine.publishScreen).toHaveBeenCalledWith({ audio: true, quality: 'high' });

    result.current.switchScreenSource();
    expect(engine.switchScreenSource).toHaveBeenCalledTimes(1);

    result.current.unpublishSource('screen');
    expect(engine.unpublishSource).toHaveBeenCalledWith('screen');

    result.current.setPublishQuality('camera', 'medium');
    expect(engine.setPublishQuality).toHaveBeenCalledWith('camera', 'medium');

    result.current.setReceiverMaxQuality('low');
    expect(engine.setReceiverMaxQuality).toHaveBeenCalledWith('low');
  });

  it('enginePublishing/engineVideoWant read the engine (null when no leg)', () => {
    const engine = fakeEngine();
    setCallEngineForTests(engine);
    const { result } = renderHook(() => useCall());

    expect(result.current.enginePublishing()).toBeNull();
    expect(result.current.engineVideoWant()).toBeNull();

    act(() => {
      engine.__setSnapshot({
        voice: {
          status: 'connected',
          pcConnected: true,
          micGranted: true,
          micDenied: false,
          notice: null,
        },
        channelId: 'c-1',
        muted: false,
        deafened: false,
        listenOnly: false,
        publishing: { camera: true, screen: false, screen_audio: false },
      });
      engine.__setWant({ tiles: 4, max_quality: 'medium' });
    });
    expect(result.current.enginePublishing()).toEqual({
      camera: true,
      screen: false,
      screen_audio: false,
    });
    expect(result.current.engineVideoWant()).toEqual({ tiles: 4, max_quality: 'medium' });
  });
});

describe('useCallVideoStreams — the manifest-keyed video seam (U5b)', () => {
  it('subscribes the engine tracks and wraps each as an identity-stable stream', async () => {
    const engine = fakeEngine();
    setCallEngineForTests(engine);
    const trackA = { id: 'a' };
    const { result } = renderHook(() => useCallVideoStreams(engine));
    expect(result.current.size).toBe(0);

    act(() => {
      engine.__setVideoTracks(new Map([['u1:camera', trackA]]));
    });
    expect(result.current.size).toBe(1);
    const stream = result.current.get('u1:camera')!;
    // jsdom has no MediaStream constructor → the track itself (inert attach).
    expect(stream).toBe(mediaStreamForTrack(trackA));
    // The cache keys on track identity: the SAME wrapper every re-render.
    expect(mediaStreamForTrack(trackA)).toBe(stream);
    const trackB = { id: 'b' };
    expect(mediaStreamForTrack(trackB)).not.toBe(stream);
  });
});

describe('useCallVideoWant — the budget seam (U5b)', () => {
  it('re-renders on want emissions (identity-stable between them)', () => {
    const engine = fakeEngine();
    setCallEngineForTests(engine);
    const { result } = renderHook(() => useCallVideoWant(engine));
    const initial = result.current;
    expect(initial.tiles).toBe(9);

    act(() => {
      engine.__setWant({ tiles: 1, max_quality: 'low' });
    });
    expect(result.current.tiles).toBe(1);
    expect(result.current.max_quality).toBe('low');
  });
});

describe('computeGridParticipants — VM3/VM18 derivation (U5b)', () => {
  const base = {
    nameOf: (id: string) => id,
    viewerId: 'me',
    streams: new Map<string, unknown>(),
    localCameraStream: null,
    speaking: new Set<string>(),
    budget: 9,
  };
  const pubs = (ids: string[]) => ids.map((user_id) => ({ user_id, source: 'camera' as const, since: 't' }));

  it('non-publishers render camera-off; publishers live with a stream, loading without', () => {
    const { participants, liveCount } = computeGridParticipants({
      ...base,
      rosterIds: ['me', 'u1', 'u2'],
      cameraPublishers: pubs(['u1', 'u2']),
      streams: new Map([['u1:camera', { id: 's' }]]),
    });
    expect(participants.map((p) => [p.userId, p.state])).toEqual([
      ['me', 'camera-off'],
      ['u1', 'live'],
      ['u2', 'loading'],
    ]);
    expect(liveCount).toBe(1);
  });

  it('beyond-budget publishers degrade to connection-paused; speakers outrank recency (VM3/VM18)', () => {
    const { participants } = computeGridParticipants({
      ...base,
      rosterIds: ['u1', 'u2', 'u3'],
      cameraPublishers: pubs(['u1', 'u2', 'u3']), // most-recent-first input
      speaking: new Set(['u3']),
      budget: 1,
      streams: new Map([
        ['u1:camera', { id: 's1' }],
        ['u2:camera', { id: 's2' }],
        ['u3:camera', { id: 's3' }],
      ]),
    });
    expect(participants.find((p) => p.userId === 'u3')!.state).toBe('live');
    expect(participants.find((p) => p.userId === 'u1')!.state).toBe('connection-paused');
    expect(participants.find((p) => p.userId === 'u2')!.state).toBe('connection-paused');
  });

  it('self never consumes the budget and mirrors (VM15); excludeSelf drops it (overlay mode)', () => {
    const withSelf = computeGridParticipants({
      ...base,
      rosterIds: ['me', 'u1'],
      cameraPublishers: pubs(['me', 'u1']),
      localCameraStream: { id: 'local' },
      budget: 0, // floor: the local tile stays live regardless
    });
    expect(withSelf.participants.find((p) => p.userId === 'me')!.state).toBe('live');
    expect(withSelf.participants.find((p) => p.userId === 'me')!.isSelf).toBe(true);

    const excluded = computeGridParticipants({
      ...base,
      rosterIds: ['me', 'u1'],
      cameraPublishers: pubs(['me', 'u1']),
      localCameraStream: { id: 'local' },
      budget: 9,
      excludeSelf: true,
    });
    expect(excluded.participants.find((p) => p.userId === 'me')).toBeUndefined();
  });
});
