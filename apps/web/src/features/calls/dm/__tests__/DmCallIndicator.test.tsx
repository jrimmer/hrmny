/**
 * @cytale/web — DmCallIndicator tests (calls plan U10).
 *
 * Unit coverage over every state (states-first DoD): idle Call button,
 * incoming ring (Join/Decline, keyboard), in-call expansion (connecting
 * spinners, connected controls incl. keyboard, ringing-peer note,
 * reconnecting, displaced, voice-unavailable, offline), missed call
 * (derivation + clear-on-view + call-back), and the caller-side transient
 * no-answer note — each with axe (zero violations).
 *
 * Integration coverage drives the REAL engine (createCallEngine over a fake
 * gateway + fake media env, the U8 harness pattern) with gateway events
 * applied through the U6 store: A calls B → B's indicator rings → B joins →
 * both connected → end leaves no artifact; ignore → missed on B only,
 * cleared on view; call-back from the indicator; and the R11 negatives (no
 * call-log region, no timeline marker, no channel-header call affordances
 * for DM conversations — asserted through MessagePane and CallPanel).
 */
import { axe } from 'vitest-axe';
import type { AxeMatchers } from 'vitest-axe/matchers';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyGatewayEvent,
  clearCallRing,
  createStateStore,
  type LiveCall,
  type StateStore,
} from '@cytale/state';
import type { GatewayEvent } from '@cytale/protocol';

declare module 'vitest' {
  interface Assertion<T> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}

import { mobileWidthState } from '../../../../test/setup.js';
import { routeCallSignalEvent } from '../../session-call-signal.js';
import { DmCallIndicator } from '../DmCallIndicator.js';
import { CallPanel } from '../../CallPanel.js';
import {
  createCallEngine,
  type CallEngine,
  type CallEngineSnapshot,
} from '../../useCallMedia.js';
import { initialVoiceState, type VoiceState } from '../../voiceState.js';

// -- fixtures -----------------------------------------------------------------

const CH = '7400000000000000100'; // the DM channel
const ME = '7400000000000000001'; // B — the viewer / ring target
const PEER = '7400000000000000002'; // A — the caller
const CALL_ID = '7400000000000000099';

function dmLiveCall(
  participantIds: string[],
  sources: Record<string, Array<{ source: 'camera' | 'screen' | 'screen_audio'; since?: string }>> = {},
): LiveCall {
  const participants: LiveCall['participants'] = {};
  for (const id of participantIds) {
    participants[id] = {
      user_id: id,
      mute: false,
      deafen: false,
      leg: `L-${id}`,
      ...(sources[id] !== undefined ? { sources: sources[id] } : {}),
    };
  }
  return {
    call_id: CALL_ID,
    thread_id: null, // R11: DM calls keep no thread linkage
    started_by: PEER,
    started_at: '2026-09-06T12:00:00Z',
    participants,
  };
}

function makeStore(opts: { dmCall?: LiveCall; ring?: boolean } = {}): StateStore {
  const store = createStateStore();
  store.setState((s) => ({
    ...s,
    currentUser: { id: ME, username: 'me' },
    channels: {
      ...s.channels,
      [CH]: {
        id: CH,
        workspace_id: null,
        recipients: [
          { id: ME, username: 'me' },
          { id: PEER, username: 'alice' },
        ],
        name: 'alice',
        type: 'dm' as const,
        topic: null,
        position: 0,
        last_message_id: null,
        created_at: '2026-09-06T00:00:00Z',
      },
    },
    membersById: {
      ...s.membersById,
      [PEER]: {
        id: PEER,
        username: 'alice',
        nickname: null,
        joined_at: '',
        roles: [],
      },
    },
    dmCallByChannel: opts.dmCall !== undefined ? { [CH]: opts.dmCall } : {},
    callRingByChannel: opts.ring
      ? { [CH]: { call_id: CALL_ID, from_user: PEER, rang_at: Date.now() } }
      : {},
  }));
  return store;
}

function fakeEngine(overrides: Partial<CallEngineSnapshot> = {}): CallEngine & {
  setSnapshot(next: Partial<CallEngineSnapshot>): void;
  setWant(want: { tiles: number; max_quality?: 'high' | 'medium' | 'low' }): void;
  setVideoTracks(tracks: Map<string, unknown>): void;
  setLocalCameraTrack(track: unknown): void;
} {
  const listeners = new Set<() => void>();
  const videoListeners = new Set<() => void>();
  const wantListeners = new Set<() => void>();
  // Identity-stable (the useSyncExternalStore contract — a fresh Set per
  // call would loop React's store re-render check forever).
  const speaking = new Set<string>();
  let snapshot: CallEngineSnapshot = {
    voice: initialVoiceState(),
    channelId: null,
    muted: false,
    deafened: false,
    listenOnly: false,
    publishing: { camera: false, screen: false, screen_audio: false },
    localVideoRev: 0,
    ...overrides,
  };
  let want: { tiles: number; max_quality?: 'high' | 'medium' | 'low' } = {
    tiles: 9,
    max_quality: 'high',
  };
  let videoTracks: ReadonlyMap<string, unknown> = new Map();
  let localCameraTrack: unknown = null;
  return {
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    getSnapshot: () => snapshot,
    setSnapshot: (next: Partial<CallEngineSnapshot>) => {
      snapshot = { ...snapshot, ...next };
      for (const l of [...listeners]) l();
    },
    setWant: (w: { tiles: number; max_quality?: 'high' | 'medium' | 'low' }) => {
      want = w;
      for (const l of [...wantListeners]) l();
    },
    setVideoTracks: (tracks: Map<string, unknown>) => {
      videoTracks = tracks;
      for (const l of [...videoListeners]) l();
    },
    setLocalCameraTrack: (track: unknown) => {
      localCameraTrack = track;
      snapshot = { ...snapshot, localVideoRev: (snapshot.localVideoRev ?? 0) + 1 };
      for (const l of [...listeners]) l();
    },
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
    retryMic: vi.fn(),
    publishCamera: vi.fn(),
    publishScreen: vi.fn(),
    switchScreenSource: vi.fn(),
    unpublishSource: vi.fn(),
    setPublishQuality: vi.fn(),
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
    getLocalPublishTrack: vi.fn(() => localCameraTrack),
    pollConnectionState: vi.fn(),
    destroy: vi.fn(),
  } as never;
}

function voice(status: VoiceState['status'], notice: VoiceState['notice'] = null): VoiceState {
  return { ...initialVoiceState(), status, notice, pcConnected: true, micGranted: true };
}

function renderIndicator(
  store: StateStore,
  engine: CallEngine = fakeEngine(),
) {
  return render(<DmCallIndicator channelId={CH} store={store} engine={engine} />);
}

/** Drive one gateway dispatch into the store (seq-gated like the session). */
function drive(store: StateStore, t: GatewayEvent['t'], d: unknown): void {
  drive.seq += 1;
  applyGatewayEvent(store, { op: 0, t, s: drive.seq, d } as GatewayEvent);
}
drive.seq = 0;

afterEach(() => {
  cleanup();
  mobileWidthState.mobile = false;
});

// -- idle ----------------------------------------------------------------------

describe('DmCallIndicator — idle', () => {
  it('renders the Call button; clicking starts op-22 on the DM channel (no ring flag — AM7 server default)', async () => {
    const store = makeStore();
    const engine = fakeEngine();
    renderIndicator(store, engine);

    expect(screen.getByTestId('dm-call-start')).toBeTruthy();
    expect(screen.getByTestId('dm-call-indicator').getAttribute('data-state')).toBe('idle');

    // Plan 7.7: the header phone is now the shared `PhoneIcon` at this site's
    // 16px — pin the rendered size so the unification is not a restyle.
    const phone = screen.getByTestId('dm-call-start').querySelector('svg')!;
    expect(phone.getAttribute('width')).toBe('16');
    expect(phone.getAttribute('height')).toBe('16');

    await userEvent.click(screen.getByTestId('dm-call-start'));
    expect(engine.start).toHaveBeenCalledWith(CH);
    // AM7: DM ring defaults ON server-side — the client never passes a ring
    // flag (exactly one argument on the start intent).
    expect((engine.start as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([CH]);
  });

  it('is keyboard-operable (Enter starts the call)', async () => {
    const store = makeStore();
    const engine = fakeEngine();
    renderIndicator(store, engine);

    screen.getByTestId('dm-call-start').focus();
    await userEvent.keyboard('{Enter}');
    expect(engine.start).toHaveBeenCalledTimes(1);
  });
});

// -- incoming ring --------------------------------------------------------------

describe('DmCallIndicator — incoming ring', () => {
  it('surfaces the ringing state with Join/Decline while the DM call is live', () => {
    const store = makeStore({ dmCall: dmLiveCall([PEER]), ring: true });
    renderIndicator(store);

    expect(screen.getByTestId('dm-call-indicator').getAttribute('data-state')).toBe('ringing');
    expect(screen.getByTestId('dm-call-incoming')).toBeTruthy();
    expect(screen.getByTestId('dm-call-incoming-join')).toBeTruthy();
    expect(screen.getByTestId('dm-call-incoming-decline')).toBeTruthy();
    // The expansion's Join phone is the 14px call site (plan 7.7).
    const phone = screen.getByTestId('dm-call-incoming-join').querySelector('svg')!;
    expect(phone.getAttribute('width')).toBe('14');
    expect(phone.getAttribute('height')).toBe('14');
    expect(screen.getByText(/Incoming call from alice/i)).toBeTruthy();
  });

  it('Join clears the ring entry and joins via the engine (keyboard path)', async () => {
    const store = makeStore({ dmCall: dmLiveCall([PEER]), ring: true });
    const engine = fakeEngine();
    renderIndicator(store, engine);

    screen.getByTestId('dm-call-incoming-join').focus();
    await userEvent.keyboard('{Enter}');
    expect(engine.join).toHaveBeenCalledWith(CH);
    expect(store.getState().callRingByChannel[CH]).toBeUndefined();
  });

  it('Decline clears the ring entry without joining (declined ≠ missed)', async () => {
    const store = makeStore({ dmCall: dmLiveCall([PEER]), ring: true });
    const engine = fakeEngine();
    renderIndicator(store, engine);

    await userEvent.click(screen.getByTestId('dm-call-incoming-decline'));
    expect(engine.join).not.toHaveBeenCalled();
    expect(store.getState().callRingByChannel[CH]).toBeUndefined();

    // The call stays joinable: AM17's live flip.
    expect(screen.getByTestId('dm-call-join')).toBeTruthy();
  });

  it('has no axe violations on the incoming surface', async () => {
    const store = makeStore({ dmCall: dmLiveCall([PEER]), ring: true });
    const { container } = renderIndicator(store);
    expect(await axe(container)).toHaveNoViolations();
  });
});

// -- live, not joined ------------------------------------------------------------

describe('DmCallIndicator — live DM call this client is not in', () => {
  it('flips the affordance to Join (AM17) — e.g. a SYNC-learned call with no ring', async () => {
    const store = makeStore({ dmCall: dmLiveCall([PEER]) });
    const engine = fakeEngine();
    renderIndicator(store, engine);

    await userEvent.click(screen.getByTestId('dm-call-join'));
    expect(engine.join).toHaveBeenCalledWith(CH);
  });
});

// -- in-call expansion -----------------------------------------------------------

describe('DmCallIndicator — in-call expansion (AM18 compact controls)', () => {
  it('connected: the VM17 media block hosts the tile pair + the control set; clicks route through the engine', async () => {
    const store = makeStore({ dmCall: dmLiveCall([ME, PEER]) });
    const engine = fakeEngine({ voice: voice('connected'), channelId: CH });
    renderIndicator(store, engine);

    // VM17: connected renders the inline media block (not the compact strip).
    expect(screen.getByTestId('dm-media-block')).toBeTruthy();
    expect(screen.getByTestId('dm-media-controls')).toBeTruthy();
    expect(screen.getAllByTestId('video-tile')).toHaveLength(2);
    // Peer joined → no ringing note.
    expect(screen.queryByTestId('dm-call-ringing-peer')).toBeNull();

    await userEvent.click(screen.getByTestId('call-mute-dm'));
    expect(engine.toggleMute).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByTestId('call-deafen-dm'));
    expect(engine.toggleDeafen).toHaveBeenCalledTimes(1);
  });

  it('leave is keyboard-operable from the media block foot', async () => {
    const store = makeStore({ dmCall: dmLiveCall([ME, PEER]) });
    const engine = fakeEngine({ voice: voice('connected'), channelId: CH });
    renderIndicator(store, engine);

    screen.getByTestId('call-leave-dm').focus();
    await userEvent.keyboard('{Enter}');
    expect(engine.leave).toHaveBeenCalledTimes(1);
  });

  it('connected while the peer has not joined: the media block carries the Ringing note (phone semantics)', () => {
    const store = makeStore({ dmCall: dmLiveCall([ME]) });
    const engine = fakeEngine({ voice: voice('connected'), channelId: CH });
    renderIndicator(store, engine);

    expect(screen.getByTestId('dm-media-block')).toBeTruthy();
    expect(screen.getByTestId('dm-call-ringing-peer')).toBeTruthy();
    expect(screen.getByText(/Ringing alice/i)).toBeTruthy();
  });

  it('connecting: spinner surfaces in the expansion (both connecting legs)', async () => {
    const store = makeStore({ dmCall: dmLiveCall([ME, PEER]) });
    const engine = fakeEngine({ voice: voice('connecting-signaling'), channelId: CH });
    renderIndicator(store, engine);
    expect(screen.getByTestId('dm-call-state-connecting-signaling')).toBeTruthy();

    engine.setSnapshot({ voice: voice('connecting-media') });
    await waitFor(() =>
      expect(screen.getByTestId('dm-call-state-connecting-media')).toBeTruthy(),
    );
  });

  it('reconnecting: persistent status banner renders', () => {
    const store = makeStore({ dmCall: dmLiveCall([ME, PEER]) });
    const engine = fakeEngine({ voice: voice('reconnecting'), channelId: CH });
    renderIndicator(store, engine);
    expect(screen.getByTestId('dm-call-state-reconnecting')).toBeTruthy();
  });

  it('displaced: the joined-elsewhere notice renders and dismisses (AM8)', async () => {
    const store = makeStore(); // roster gone — the engine notice owns the state
    const engine = fakeEngine({
      voice: { ...initialVoiceState(), notice: 'displaced' },
      channelId: CH,
    });
    renderIndicator(store, engine);

    expect(screen.getByTestId('dm-call-state-displaced')).toBeTruthy();
    await userEvent.click(screen.getByTestId('dm-call-dismiss'));
    expect(engine.dismiss).toHaveBeenCalledTimes(1);
  });

  it('voice-unavailable: alert with Retry/Dismiss routes through the engine', async () => {
    const store = makeStore();
    const engine = fakeEngine({ voice: voice('voice-unavailable'), channelId: CH });
    renderIndicator(store, engine);

    expect(screen.getByTestId('dm-call-state-voice-unavailable')).toBeTruthy();
    await userEvent.click(screen.getByTestId('dm-call-retry'));
    expect(engine.retry).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByTestId('dm-call-dismiss'));
    expect(engine.dismiss).toHaveBeenCalledTimes(1);
  });

  it('offline: the teardown notice renders with OK', async () => {
    const store = makeStore();
    const engine = fakeEngine({ voice: voice('offline', 'offline'), channelId: CH });
    renderIndicator(store, engine);

    expect(screen.getByTestId('dm-call-state-offline')).toBeTruthy();
    await userEvent.click(screen.getByTestId('dm-call-dismiss'));
    expect(engine.dismiss).toHaveBeenCalledTimes(1);
  });

  it('has no axe violations on the in-call expansion (connected, alone)', async () => {
    const store = makeStore({ dmCall: dmLiveCall([ME]) });
    const engine = fakeEngine({ voice: voice('connected'), channelId: CH });
    const { container } = renderIndicator(store, engine);
    expect(await axe(container)).toHaveNoViolations();
  });
});

// -- missed call -----------------------------------------------------------------

describe('DmCallIndicator — missed call (AM7/R11)', () => {
  it('a ring whose call ended without this client joining renders the missed indicator with Call back', async () => {
    // B is viewing the DM when the ring lands (indicator mounted, incoming
    // state), ignores it, and the call ends — the miss arrives while open.
    const store = makeStore({ dmCall: dmLiveCall([PEER]), ring: true });
    const engine = fakeEngine();
    renderIndicator(store, engine);
    expect(screen.getByTestId('dm-call-incoming')).toBeTruthy();

    act(() => {
      drive(store, 'CallEnd', {
        channel_id: CH,
        call_id: CALL_ID,
        reason: 'last_left',
        ended_at: '2026-09-06T12:01:00Z',
      });
    });

    expect(screen.getByTestId('dm-call-indicator').getAttribute('data-state')).toBe('missed');
    expect(screen.getByTestId('dm-call-missed')).toBeTruthy();
    expect(screen.getByTestId('dm-call-missed-panel')).toBeTruthy();
    expect(screen.getByText(/Missed call from alice/i)).toBeTruthy();

    await userEvent.click(screen.getByTestId('dm-call-callback'));
    expect(engine.start).toHaveBeenCalledWith(CH);
    expect(store.getState().callRingByChannel[CH]).toBeUndefined();
    // Calling back consumed the notice.
    await waitFor(() =>
      expect(screen.queryByTestId('dm-call-missed-panel')).toBeNull(),
    );
  });

  it('missed indicator is keyboard-operable (Enter on the header button calls back)', async () => {
    const store = makeStore({ dmCall: dmLiveCall([PEER]), ring: true });
    const engine = fakeEngine();
    renderIndicator(store, engine);
    act(() => {
      drive(store, 'CallEnd', {
        channel_id: CH,
        call_id: CALL_ID,
        reason: 'swept',
        ended_at: '2026-09-06T12:02:00Z',
      });
    });

    screen.getByTestId('dm-call-missed').focus();
    await userEvent.keyboard('{Enter}');
    expect(engine.start).toHaveBeenCalledTimes(1);
    expect(store.getState().callRingByChannel[CH]).toBeUndefined();
  });

  it('cleared on view: arriving at the DM consumes a missed state already present', async () => {
    // The miss happened while B was elsewhere — the ring entry persisted
    // (CALL_END deliberately leaves it readable). Opening the conversation
    // mounts the indicator: "view" = the DM channel being active.
    const store = makeStore({ ring: true });
    renderIndicator(store, fakeEngine());

    await waitFor(() => {
      expect(store.getState().callRingByChannel[CH]).toBeUndefined();
      expect(screen.queryByTestId('dm-call-missed-panel')).toBeNull();
    });
    expect(screen.getByTestId('dm-call-start')).toBeTruthy();
  });

  it('clear-on-view never eats an incoming ring (the call is still live)', () => {
    const store = makeStore({ dmCall: dmLiveCall([PEER]), ring: true });
    renderIndicator(store, fakeEngine());

    expect(store.getState().callRingByChannel[CH]).toBeDefined();
    expect(screen.getByTestId('dm-call-incoming')).toBeTruthy();
  });

  it('a client that joined never sees missed (its Join consumed the ring)', async () => {
    const store = makeStore({ dmCall: dmLiveCall([PEER]), ring: true });
    const engine = fakeEngine();
    renderIndicator(store, engine);
    await userEvent.click(screen.getByTestId('dm-call-incoming-join'));

    act(() => {
      drive(store, 'CallEnd', {
        channel_id: CH,
        call_id: CALL_ID,
        reason: 'last_left',
        ended_at: '2026-09-06T12:03:00Z',
      });
    });

    expect(screen.getByTestId('dm-call-indicator').getAttribute('data-state')).toBe('idle');
    expect(screen.queryByTestId('dm-call-missed-panel')).toBeNull();
  });

  it('has no axe violations on the missed surface', async () => {
    const store = makeStore({ dmCall: dmLiveCall([PEER]), ring: true });
    const { container } = renderIndicator(store, fakeEngine());
    act(() => {
      drive(store, 'CallEnd', {
        channel_id: CH,
        call_id: CALL_ID,
        reason: 'last_left',
        ended_at: '2026-09-06T12:04:00Z',
      });
    });
    expect(screen.getByTestId('dm-call-missed-panel')).toBeTruthy();
    expect(await axe(container)).toHaveNoViolations();
  });
});

// -- caller-side no-answer (offline ringing-then-unavailable) ----------------------

describe('DmCallIndicator — caller no-answer note (transient)', () => {
  it('a caller whose ring was never joined sees the unavailable note when the call ends', async () => {
    // The caller (ME started it — engine holds the leg, roster holds ME only).
    const store = makeStore({ dmCall: dmLiveCall([ME]) });
    const engine = fakeEngine({ voice: voice('connected'), channelId: CH });
    renderIndicator(store, engine);
    expect(screen.getByTestId('dm-call-ringing-peer')).toBeTruthy();

    act(() => {
      drive(store, 'CallEnd', {
        channel_id: CH,
        call_id: CALL_ID,
        reason: 'swept',
        ended_at: '2026-09-06T12:05:00Z',
      });
      // The real engine lands Idle on CALL_END (no notice).
      engine.setSnapshot({ voice: initialVoiceState(), channelId: null });
    });

    expect(screen.getByTestId('dm-call-no-answer')).toBeTruthy();
    expect(screen.getByText(/didn't answer/i)).toBeTruthy();

    await userEvent.click(screen.getByTestId('dm-call-no-answer-dismiss'));
    expect(screen.queryByTestId('dm-call-no-answer')).toBeNull();
  });

  it('a peer who joined suppresses the note; a new call replaces it', async () => {
    const store = makeStore({ dmCall: dmLiveCall([ME, PEER]) });
    const engine = fakeEngine({ voice: voice('connected'), channelId: CH });
    renderIndicator(store, engine);

    act(() => {
      drive(store, 'CallEnd', {
        channel_id: CH,
        call_id: CALL_ID,
        reason: 'last_left',
        ended_at: '2026-09-06T12:06:00Z',
      });
      engine.setSnapshot({ voice: initialVoiceState(), channelId: null });
    });
    expect(screen.queryByTestId('dm-call-no-answer')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration — the REAL engine against gateway events (A calls B)
// ---------------------------------------------------------------------------

/** The U8 fake-media stack (see useCallMedia.test) in miniature. */
class FakePc {
  connectionState = 'new';
  ontrack: ((e: { track: { stop(): void; enabled: boolean }; transceiver?: { mid: string } }) => void) | null = null;
  onicecandidate: ((e: { candidate: null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  closed = false;
  addTrack(): unknown {
    return {};
  }
  async setRemoteDescription(d: { sdp: string }): Promise<void> {
    const mids = [...d.sdp.matchAll(/a=mid:(\d+)/g)].map((m) => m[1]!);
    let first = true;
    for (const mid of mids) {
      if (first) {
        first = false; // m-line 0 is the server's ingest
        continue;
      }
      this.ontrack?.({ track: { stop: () => undefined, enabled: true }, transceiver: { mid } });
    }
  }
  // V2 engine surface (manifest binding + ladder): no transceivers/stats in
  // this harness — the offers are V1-shaped (empty manifest), so binding is
  // a no-op and getStats reports no inbound video.
  getTransceivers(): Array<never> {
    return [];
  }
  async getStats(): Promise<Array<Record<string, unknown>>> {
    return [];
  }
  async createAnswer(): Promise<{ type: string; sdp: string }> {
    return { type: 'answer', sdp: 'v=0\nm=audio 9 RTP/AVP 111\na=mid:0\na=recvonly\na=rtpmap:111 opus/48000/2\n' };
  }
  async setLocalDescription(): Promise<void> {}
  async addIceCandidate(): Promise<void> {}
  close(): void {
    this.closed = true;
  }
  simulate(state: string): void {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

function integrationHarness() {
  const store = makeStore();
  const sentState: Array<{ channel_id: string; action: string; ring?: boolean }> = [];
  // The U8 FakeGateway shape: records ops AND dispatches to the engine's
  // subscriptions (the engine listens on the gateway, not the store).
  const handlers = new Map<string, Set<(p: unknown) => void>>();
  const gateway = {
    connectionState: 'ready',
    sendCallState: (p: { channel_id: string; action: string; ring?: boolean }) => {
      sentState.push(p);
    },
    sendCallSignal: () => undefined,
    on: (event: string, handler: (p: never) => void) => {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(handler as (p: unknown) => void);
      return () => {
        set!.delete(handler as (p: unknown) => void);
      };
    },
  };
  const pcs: FakePc[] = [];
  const engine = createCallEngine({
    store,
    gateway: () => gateway as never,
    pollMs: 0,
    // Hermetic ICE fetch (U12): no network in jsdom — the loopback default.
    fetchIceServers: () => Promise.resolve([]),
    media: {
      getUserMedia: () =>
        Promise.resolve({
          getAudioTracks: () => [{ stop: () => undefined, enabled: true }],
          getVideoTracks: () => [],
        }),
      createPeerConnection: () => {
        const pc = new FakePc();
        pcs.push(pc);
        return pc as never;
      },
      createStream: (tracks) => ({ getAudioTracks: () => tracks, getVideoTracks: () => [] }),
      attachAudio: () => ({ setMuted: () => undefined, stop: () => undefined }),
    },
  });

  let seq = 0;
  const event = (t: 'CallUpdate' | 'CallEnd', d: unknown) => {
    seq += 1;
    act(() => {
      applyGatewayEvent(store, { op: 0, t, s: seq, d } as GatewayEvent);
      for (const handler of handlers.get(t) ?? []) handler(d);
    });
  };
  const eventStoreOnly = (t: string, d: unknown) => {
    seq += 1;
    act(() => {
      applyGatewayEvent(store, { op: 0, t, s: seq, d } as GatewayEvent);
    });
  };
  const signal = (sdp: string) => {
    seq += 1;
    act(() => {
      routeCallSignalEvent({
        op: 0,
        t: 'CallSignal',
        s: seq,
        d: { channel_id: CH, body: JSON.stringify({ type: 'offer', sdp }) },
      });
    });
  };

  return { store, engine, sentState, pcs, event, eventStoreOnly, signal };
}

const OFFER_SDP = [
  'v=0',
  'm=audio 9 RTP/AVP 111',
  'a=mid:0',
  'a=recvonly',
  'a=rtpmap:111 opus/48000/2',
].join('\n');

describe('DmCallIndicator — integration (A calls B, real engine)', () => {
  it('A calls B: B rings (CALL_RING + dm_calls-shaped sync), joins, connects; end leaves no artifact', async () => {
    const h = integrationHarness();
    render(<DmCallIndicator channelId={CH} store={h.store} engine={h.engine} />);
    expect(screen.getByTestId('dm-call-start')).toBeTruthy();

    // A starts the DM call: CALL_START (thread_id null → DM slice) + A's leg.
    h.eventStoreOnly('CallStart', {
      channel_id: CH,
      call_id: CALL_ID,
      thread_id: null,
      started_by: PEER,
      started_at: '2026-09-06T12:00:00Z',
    });
    h.event('CallUpdate', {
      channel_id: CH,
      call_id: CALL_ID,
      user_id: PEER,
      leg: 'L-A',
      state: 'joined',
    });
    // The ring reaches B (user-keyed dispatch).
    h.eventStoreOnly('CallRing', { channel_id: CH, call_id: CALL_ID, from_user: PEER });

    expect(screen.getByTestId('dm-call-indicator').getAttribute('data-state')).toBe('ringing');

    // B joins from the indicator.
    await userEvent.click(screen.getByTestId('dm-call-incoming-join'));
    expect(h.sentState).toContainEqual({ channel_id: CH, action: 'join' });
    expect(h.store.getState().callRingByChannel[CH]).toBeUndefined();

    // The room confirms B's leg, pushes the offer, the PC comes up.
    h.event('CallUpdate', {
      channel_id: CH,
      call_id: CALL_ID,
      user_id: ME,
      leg: 'L-B',
      state: 'joined',
    });
    h.signal(OFFER_SDP);
    await act(async () => {
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });
    act(() => {
      h.pcs[0]!.simulate('connected');
    });

    expect(h.engine.getSnapshot().voice.status).toBe('connected');
    // V2: the connected expansion is the VM17 media block.
    expect(screen.getByTestId('dm-media-block')).toBeTruthy();
    expect(screen.getByTestId('call-mute-dm')).toBeTruthy();

    // R11: no message artifact anywhere — no thread linkage learned, no
    // channel-surface chatter, no unread accrual.
    const s = h.store.getState();
    expect(s.callLogThreadIdByChannel[CH]).toBeUndefined();
    expect(Object.keys(s.messagesByThread)).toHaveLength(0);
    expect(s.messagesByChannel[CH]).toBeUndefined();
    expect(s.unreadByChannel[CH]).toBeUndefined();

    // The call ends: indicator collapses to idle, roster gone.
    h.event('CallEnd', {
      channel_id: CH,
      call_id: CALL_ID,
      reason: 'last_left',
      ended_at: '2026-09-06T12:01:00Z',
    });
    expect(h.store.getState().dmCallByChannel[CH]).toBeUndefined();
    // B joined → NOT missed.
    expect(screen.queryByTestId('dm-call-missed-panel')).toBeNull();
    expect(screen.queryByTestId('dm-call-no-answer')).toBeNull();
  });

  it('B ignores the ring: missed indicator on B only, cleared on re-view; call-back starts op-22', async () => {
    const h = integrationHarness();
    render(<DmCallIndicator channelId={CH} store={h.store} engine={h.engine} />);

    h.eventStoreOnly('CallStart', {
      channel_id: CH,
      call_id: CALL_ID,
      thread_id: null,
      started_by: PEER,
      started_at: '2026-09-06T12:00:00Z',
    });
    h.event('CallUpdate', {
      channel_id: CH,
      call_id: CALL_ID,
      user_id: PEER,
      leg: 'L-A',
      state: 'joined',
    });
    h.eventStoreOnly('CallRing', { channel_id: CH, call_id: CALL_ID, from_user: PEER });

    // B does nothing; A gives up and the call sweeps.
    h.event('CallEnd', {
      channel_id: CH,
      call_id: CALL_ID,
      reason: 'swept',
      ended_at: '2026-09-06T12:01:00Z',
    });

    expect(screen.getByTestId('dm-call-indicator').getAttribute('data-state')).toBe('missed');
    expect(screen.getByTestId('dm-call-missed-panel')).toBeTruthy();

    // Call back from the indicator: op-22 start on the DM channel.
    await userEvent.click(screen.getByTestId('dm-call-callback'));
    expect(h.sentState).toContainEqual({ channel_id: CH, action: 'start' });

    // Re-view (navigate away and back = unmount + remount) clears the miss.
    const store2 = h.store;
    h.eventStoreOnly('CallRing', { channel_id: CH, call_id: '7400000000000000177', from_user: PEER });
    h.event('CallEnd', {
      channel_id: CH,
      call_id: '7400000000000000177',
      reason: 'swept',
      ended_at: '2026-09-06T12:02:00Z',
    });
    expect(screen.getByTestId('dm-call-missed-panel')).toBeTruthy();
    cleanup();
    render(<DmCallIndicator channelId={CH} store={store2} engine={h.engine} />);
    await waitFor(() => {
      expect(screen.queryByTestId('dm-call-missed-panel')).toBeNull();
    });
    expect(store2.getState().callRingByChannel[CH]).toBeUndefined();
  });

  it('offline recipient: the caller sees ringing-then-unavailable (transient note)', async () => {
    const h = integrationHarness();
    render(<DmCallIndicator channelId={CH} store={h.store} engine={h.engine} />);

    // B (the viewer) starts the call — the recipient is offline.
    await userEvent.click(screen.getByTestId('dm-call-start'));
    expect(h.sentState).toContainEqual({ channel_id: CH, action: 'start' });

    h.eventStoreOnly('CallStart', {
      channel_id: CH,
      call_id: CALL_ID,
      thread_id: null,
      started_by: ME,
      started_at: '2026-09-06T12:00:00Z',
    });
    h.event('CallUpdate', {
      channel_id: CH,
      call_id: CALL_ID,
      user_id: ME,
      leg: 'L-B',
      state: 'joined',
    });
    h.event('CallUpdate', {
      channel_id: CH,
      call_id: CALL_ID,
      user_id: ME,
      leg: 'L-B',
      state: 'joined',
    });
    h.signal(OFFER_SDP);
    await act(async () => {
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });
    act(() => {
      h.pcs[0]!.simulate('connected');
    });

    // Ringing (peer never joins), then the call is swept.
    expect(screen.getByTestId('dm-call-ringing-peer')).toBeTruthy();
    h.event('CallEnd', {
      channel_id: CH,
      call_id: CALL_ID,
      reason: 'swept',
      ended_at: '2026-09-06T12:02:00Z',
    });

    expect(screen.getByTestId('dm-call-no-answer')).toBeTruthy();
    expect(screen.getByText(/didn't answer/i)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// R11 negatives — no slot, no log, no marker for DM calls
// ---------------------------------------------------------------------------

describe('DmCallIndicator — R11 negatives', () => {
  it('CallPanel renders NO call-log region for a DM-flavored channel (belt-and-braces on the shell gate)', () => {
    const store = makeStore({ dmCall: dmLiveCall([ME, PEER]) });
    const engine = fakeEngine({ voice: voice('connected'), channelId: CH });
    render(<CallPanel channelId={CH} store={store} engine={engine} />);

    expect(screen.getByTestId('call-panel')).toBeTruthy();
    expect(screen.queryByTestId('call-log-slot')).toBeNull();
    expect(screen.queryByTestId('call-log-loading')).toBeNull();
  });

  it('clearCallRing is the sole ring-removal path — CALL_END leaves the entry readable (U6 contract)', () => {
    const store = makeStore({ dmCall: dmLiveCall([PEER]), ring: true });
    drive(store, 'CallEnd', {
      channel_id: CH,
      call_id: CALL_ID,
      reason: 'last_left',
      ended_at: '2026-09-06T12:00:00Z',
    });
    expect(store.getState().callRingByChannel[CH]).toBeDefined();

    clearCallRing(store, CH);
    expect(store.getState().callRingByChannel[CH]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// V2 (U5b) — the VM17 inline media block (KDV1/R10: DM calls carry full media)
// ---------------------------------------------------------------------------

const DT = '2026-09-07T12:00:05Z';

describe('DmCallIndicator — VM17 inline media block', () => {
  it('renders the tile pair with engine video: peer live from the attributed track, self mirrored from the local capture (VM15)', () => {
    const store = makeStore({
      dmCall: dmLiveCall([ME, PEER], {
        [PEER]: [{ source: 'camera', since: DT }],
      }),
    });
    const engine = fakeEngine({
      voice: voice('connected'),
      channelId: CH,
      publishing: { camera: true, screen: false, screen_audio: false },
    });
    engine.setVideoTracks(new Map([[`${PEER}:camera`, { id: 's-peer' }]]));
    engine.setLocalCameraTrack({ id: 's-self' });
    renderIndicator(store, engine);

    const tiles = screen.getAllByTestId('video-tile');
    expect(tiles).toHaveLength(2);
    const peerTile = tiles.find((t) => t.getAttribute('data-user-id') === PEER)!;
    const selfTile = tiles.find((t) => t.getAttribute('data-user-id') === ME)!;
    expect(peerTile.getAttribute('data-state')).toBe('live');
    expect(selfTile.getAttribute('data-state')).toBe('live');
    expect(selfTile.className).toContain('video-mirrored');
    expect(peerTile.className).not.toContain('video-mirrored');
  });

  it('a live share stacks the stage above the tile pair (VM17 geometry); the grid demotes to the strip', () => {
    const store = makeStore({
      dmCall: dmLiveCall([ME, PEER], {
        [PEER]: [
          { source: 'screen', since: DT },
          { source: 'screen_audio', since: DT },
        ],
      }),
    });
    const engine = fakeEngine({ voice: voice('connected'), channelId: CH });
    engine.setVideoTracks(new Map([[`${PEER}:screen`, { id: 's-screen' }]]));
    renderIndicator(store, engine);

    const stage = screen.getByTestId('video-stage');
    expect(stage.getAttribute('data-stage-state')).toBe('live');
    expect(screen.getByTestId('stage-presenter').textContent).toContain('alice');
    expect(screen.getByTestId('stage-share-audio-badge')).toBeTruthy(); // VM9
    expect(screen.getByTestId('video-grid').getAttribute('data-variant')).toBe('strip');
  });

  it('dismissible: collapse returns to the compact indicator strip with the control set (VM17); a fresh leg un-dismisses', async () => {
    const store = makeStore({ dmCall: dmLiveCall([ME, PEER]) });
    const engine = fakeEngine({ voice: voice('connected'), channelId: CH });
    const { rerender } = renderIndicator(store, engine);
    expect(screen.getByTestId('dm-media-block')).toBeTruthy();

    await userEvent.click(screen.getByTestId('dm-media-collapse'));
    // The compact expansion (AM18) is the dismissed surface — controls remain.
    expect(screen.queryByTestId('dm-media-block')).toBeNull();
    expect(screen.getByTestId('dm-call-expansion')).toBeTruthy();
    expect(screen.getByTestId('dm-call-controls')).toBeTruthy();

    // A fresh leg un-dismisses (new call → the media block returns).
    engine.setSnapshot({ voice: initialVoiceState(), channelId: null });
    rerender(<DmCallIndicator channelId={CH} store={store} engine={engine} />);
    engine.setSnapshot({ voice: voice('connected'), channelId: CH });
    rerender(<DmCallIndicator channelId={CH} store={store} engine={engine} />);
    await waitFor(() => {
      expect(screen.getByTestId('dm-media-block')).toBeTruthy();
    });
  });

  it('publish affordances ride the media block foot: camera toggles, share carries share-audio (VM9)', async () => {
    const store = makeStore({ dmCall: dmLiveCall([ME, PEER]) });
    const engine = fakeEngine({ voice: voice('connected'), channelId: CH });
    renderIndicator(store, engine);

    await userEvent.click(screen.getByTestId('call-camera-dm'));
    expect(engine.publishCamera).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByTestId('call-share-dm'));
    expect(engine.publishScreen).toHaveBeenCalledWith({ audio: true });

    engine.setSnapshot({
      voice: voice('connected'),
      channelId: CH,
      publishing: { camera: false, screen: true, screen_audio: true },
    });
    await userEvent.click(screen.getByTestId('call-share-dm'));
    expect(engine.unpublishSource).toHaveBeenCalledWith('screen');
  });

  it('receiver max-quality picker rides the DM foot (R9)', async () => {
    const store = makeStore({ dmCall: dmLiveCall([ME, PEER]) });
    const engine = fakeEngine({ voice: voice('connected'), channelId: CH });
    renderIndicator(store, engine);

    const receiverPicker = screen
      .getAllByTestId('quality-picker-dm')
      .find((p) => p.getAttribute('data-kind') === 'receiver')!;
    await userEvent.click(receiverPicker.querySelector('[data-testid="quality-trigger-dm"]')!);
    const low = screen
      .getAllByTestId('quality-option-dm')
      .find((o) => o.getAttribute('data-quality') === 'low')!;
    await userEvent.click(low);
    expect(engine.setReceiverMaxQuality).toHaveBeenCalledWith('low');
  });

  it('VM10 mobile: the share affordance renders visible-disabled with the mobile dialog — the ONLY gating path in DMs', async () => {
    mobileWidthState.mobile = true;
    const store = makeStore({ dmCall: dmLiveCall([ME, PEER]) });
    const engine = fakeEngine({ voice: voice('connected'), channelId: CH });
    renderIndicator(store, engine);

    // Camera publish stays a real control on mobile (VM10 gates screenshare).
    expect(screen.getByTestId('call-camera-dm')).toBeTruthy();
    const share = screen.getByTestId('capability-disabled-dm');
    expect(share.getAttribute('aria-disabled')).toBe('true');
    await userEvent.click(share);
    expect(screen.getAllByText(/Screen sharing isn.t available/).length).toBeGreaterThan(0);
    expect(screen.getByTestId('capability-disabled-dialog-dm').textContent).toContain(
      'join the call from the desktop or web app',
    );
  });

  it('R11 negatives hold with media live: no slot, no log, no thread, no message artifacts from the media block', () => {
    const store = makeStore({
      dmCall: dmLiveCall([ME, PEER], {
        [PEER]: [{ source: 'screen', since: DT }],
      }),
    });
    const engine = fakeEngine({ voice: voice('connected'), channelId: CH });
    engine.setVideoTracks(new Map([[`${PEER}:screen`, { id: 's-screen' }]]));
    renderIndicator(store, engine);
    expect(screen.getByTestId('video-stage')).toBeTruthy();

    const s = store.getState();
    expect(s.callLogThreadIdByChannel[CH]).toBeUndefined();
    expect(Object.keys(s.messagesByThread)).toHaveLength(0);
    expect(s.messagesByChannel[CH]).toBeUndefined();
    expect(s.unreadByChannel[CH]).toBeUndefined();
    // No log region mounts anywhere in the DM indicator's tree.
    expect(screen.queryByTestId('call-log-slot')).toBeNull();
    expect(screen.queryByText('Call log')).toBeNull();
  });

  it('axe: zero violations on the media block (share-live pair, dismissed compact, mobile)', async () => {
    const cases: Array<{
      sources?: Record<string, Array<{ source: 'camera' | 'screen' | 'screen_audio'; since?: string }>>;
      mobile?: boolean;
      dismissed?: boolean;
    }> = [
      { sources: { [PEER]: [{ source: 'camera', since: DT }] } },
      {
        sources: {
          [PEER]: [
            { source: 'screen', since: DT },
            { source: 'screen_audio', since: DT },
          ],
        },
      },
      { dismissed: true },
      { sources: { [PEER]: [{ source: 'screen', since: DT }] }, mobile: true },
    ];
    for (const c of cases) {
      cleanup();
      mobileWidthState.mobile = c.mobile === true;
      const store = makeStore({ dmCall: dmLiveCall([ME, PEER], c.sources) });
      const engine = fakeEngine({ voice: voice('connected'), channelId: CH });
      if (c.sources?.[PEER]?.some((s) => s.source === 'screen')) {
        engine.setVideoTracks(new Map([[`${PEER}:screen`, { id: 's' }]]));
      }
      const utils = renderIndicator(store, engine);
      if (c.dismissed === true) {
        await userEvent.click(screen.getByTestId('dm-media-collapse'));
      }
      expect(await axe(utils.container)).toHaveNoViolations();
    }
    mobileWidthState.mobile = false;
  });
});
