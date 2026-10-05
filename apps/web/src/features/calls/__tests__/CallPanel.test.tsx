/**
 * @cytale/web — CallPanel tests (calls plan U8; calls V2 plan U5b).
 *
 * States-first coverage on EVERY composite-state surface (AM14/AM18):
 * connecting (both legs), connected (roster + controls + call-log slot),
 * reconnecting, permission-denied (mic guidance + forced removal),
 * voice-unavailable, offline, and the displaced notice — each with axe
 * (zero violations) and keyboard flows for mute/deafen/leave via the panel
 * controls AND the roster's self row. The mobile bottom sheet (forceMobile)
 * verifies the sheet geometry + Esc collapse.
 *
 * V2 (U5b): the video composition — no-share grid fills (VM16), share-live
 * stage dominance + strip demotion + self-view overlay (VM15), most-recent
 * stage-follow with switcher + pin (VM4/VM22), ended-share collapse, stage
 * fullscreen (VM19 auto on mobile), budget shrink → VM18 avatars + polite
 * announcement, spotlight (VM21 tile activation), publish controls w/ VM10
 * capability-disabled dialogs + VM20 pre-denied affordances, quality pickers
 * (sender tiers + receiver ceiling), roster source badges (R3), and the
 * real-engine integration (camera publish → tiles from roster sources via a
 * manifest-bearing offer — fake gateway + stub media, house pattern).
 */
import { axe } from 'vitest-axe';
import type { AxeMatchers } from 'vitest-axe/matchers';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyGatewayEvent, createStateStore, type StateStore } from '@cytale/state';
import type { GatewayEvent, VideoWant } from '@cytale/protocol';

declare module 'vitest' {
  interface Assertion<T> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}

import { mobileWidthState } from '../../../test/setup.js';
import { routeCallSignalEvent } from '../session-call-signal.js';
import { CallPanel, CallPanelSurface } from '../CallPanel.js';
import {
  createCallEngine,
  type CallEngine,
  type CallEngineSnapshot,
} from '../useCallMedia.js';
import { initialVoiceState, type VoiceState } from '../voiceState.js';

// -- fixtures -----------------------------------------------------------------

const CH = '7300000000000000100';
const ME = '7300000000000000001';
const U2 = '7300000000000000002';
const U3 = '7300000000000000003';

type SourcesSpec = Partial<Record<'camera' | 'screen' | 'screen_audio', string>>;

function makeStore(opts: { sources?: Record<string, SourcesSpec> } = {}): StateStore {
  const store = createStateStore();
  const sourcesFor = (userId: string) => {
    const spec = opts.sources?.[userId];
    if (spec === undefined) return undefined;
    const out: Array<{ source: 'camera' | 'screen' | 'screen_audio'; since: string }> = [];
    for (const [source, since] of Object.entries(spec)) {
      out.push({ source: source as 'camera', since: since! });
    }
    return out;
  };
  store.setState((s) => ({
    ...s,
    currentUser: { id: ME, username: 'me' },
    membersById: {
      ...s.membersById,
      [U2]: {
        id: U2,
        username: 'river',
        nickname: null,
        joined_at: '',
        roles: [],
      },
      [U3]: {
        id: U3,
        username: 'lake',
        nickname: null,
        joined_at: '',
        roles: [],
      },
    },
    callByChannel: {
      [CH]: {
        call_id: '99',
        thread_id: '55',
        started_by: ME,
        started_at: '2026-09-06T12:00:00Z',
        participants: {
          [ME]: { user_id: ME, mute: false, deafen: false, leg: 'L1', sources: sourcesFor(ME) },
          [U2]: { user_id: U2, mute: true, deafen: false, leg: 'L2', sources: sourcesFor(U2) },
          [U3]: { user_id: U3, mute: false, deafen: false, leg: 'L3', sources: sourcesFor(U3) },
        },
      },
    },
  }));
  return store;
}

function fakeEngine(overrides: Partial<CallEngineSnapshot> = {}): CallEngine & {
  setSnapshot(next: Partial<CallEngineSnapshot>): void;
  setWant(want: VideoWant): void;
  setLocalCameraTrack(track: unknown): void;
  setVideoTracks(tracks: Map<string, unknown>): void;
} {
  const listeners = new Set<() => void>();
  const speakingListeners = new Set<() => void>();
  const videoListeners = new Set<() => void>();
  const wantListeners = new Set<() => void>();
  let snapshot: CallEngineSnapshot = {
    voice: { ...initialVoiceState(), status: 'connected', pcConnected: true, micGranted: true },
    channelId: CH,
    muted: false,
    deafened: false,
    listenOnly: false,
    publishing: { camera: false, screen: false, screen_audio: false },
    localVideoRev: 0,
    ...overrides,
  };
  // Identity-stable (useSyncExternalStore contract).
  const speakingSet = new Set([U2]);
  let want: VideoWant = { tiles: 9, max_quality: 'high' };
  let videoTracks: ReadonlyMap<string, unknown> = new Map();
  let localCameraTrack: unknown = null;
  const fake = {
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
    setWant: (w: VideoWant) => {
      want = w;
      for (const l of [...wantListeners]) l();
    },
    setLocalCameraTrack: (track: unknown) => {
      localCameraTrack = track;
      snapshot = { ...snapshot, localVideoRev: (snapshot.localVideoRev ?? 0) + 1 };
      for (const l of [...listeners]) l();
    },
    setVideoTracks: (tracks: Map<string, unknown>) => {
      videoTracks = tracks;
      for (const l of [...videoListeners]) l();
    },
    speakingSubscribe: (l: () => void) => {
      speakingListeners.add(l);
      return () => {
        speakingListeners.delete(l);
      };
    },
    getSpeaking: () => speakingSet,
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
    setReceiverMaxQuality: vi.fn((pref: 'high' | 'medium' | 'low') => {
      want = { ...want, max_quality: pref };
      for (const l of [...wantListeners]) l();
    }),
    getPublishQuality: vi.fn(() => 'high'),
    getLocalPublishTrack: vi.fn(() => localCameraTrack),
    pollConnectionState: vi.fn(),
    destroy: vi.fn(),
  };
  return fake as never;
}

function renderPanel(
  engine: ReturnType<typeof fakeEngine>,
  store = makeStore(),
  props: {
    onClose?: () => void;
    mobile?: boolean;
    capabilities?: { calls: boolean; video: boolean; screenshare: boolean };
    fetchCapabilities?: () => Promise<{ calls: boolean; video: boolean; screenshare: boolean } | null>;
    canSendVideo?: boolean;
    canShareScreen?: boolean;
  } = {},
) {
  return render(<CallPanel channelId={CH} store={store} engine={engine} {...props} />);
}

afterEach(() => {
  cleanup();
  mobileWidthState.mobile = false;
  vi.unstubAllGlobals();
});

// -- connected surface ---------------------------------------------------------

describe('CallPanel — connected', () => {
  it('renders the roster with names, speaking rings, and mute/deafen indicators', () => {
    const engine = fakeEngine();
    renderPanel(engine);

    // Plan 7.7: the header phone is now the shared `PhoneIcon` at this site's
    // 16px — pin the rendered size so the unification is not a restyle.
    const phone = screen.getByTestId('call-header').querySelector('svg')!;
    expect(phone.getAttribute('width')).toBe('16');
    expect(phone.getAttribute('height')).toBe('16');

    const rows = screen.getAllByTestId('call-roster-row');
    expect(rows).toHaveLength(3);
    // "You" now appears twice (roster self row + the self video tile's name
    // label) — the roster's copy is the row-scoped assertion.
    expect(
      rows.find((r) => r.getAttribute('data-user-id') === ME)!.textContent,
    ).toContain('You');
    expect(
      rows.find((r) => r.getAttribute('data-user-id') === U2)!.textContent,
    ).toContain('river');
    expect(
      rows.find((r) => r.getAttribute('data-user-id') === U3)!.textContent,
    ).toContain('lake');

    // U2 (engine speaking set) has the ring; U3 doesn't; U2 is roster-muted.
    expect(screen
      .getAllByTestId('call-roster-row')
      .find((r) => r.getAttribute('data-user-id') === U2)!
      .getAttribute('data-speaking')).toBe('true');
    expect(screen
      .getAllByTestId('call-roster-row')
      .find((r) => r.getAttribute('data-user-id') === U3)!
      .getAttribute('data-speaking')).toBeNull();
    expect(screen.getByTestId('roster-muted')).toBeTruthy();
  });

  it('toggles mute/deafen via the panel controls and the roster self row (keyboard)', async () => {
    const engine = fakeEngine();
    renderPanel(engine);

    await userEvent.click(screen.getByTestId('call-mute-panel'));
    expect(engine.toggleMute).toHaveBeenCalledTimes(1);

    // The roster's self row carries the same controls — keyboard only.
    await userEvent.tab(); // into the panel region
    const rosterMute = screen.getByTestId('call-mute-roster');
    rosterMute.focus();
    await userEvent.keyboard('{Enter}');
    expect(engine.toggleMute).toHaveBeenCalledTimes(2);

    await userEvent.click(screen.getByTestId('call-deafen-panel'));
    expect(engine.toggleDeafen).toHaveBeenCalledTimes(1);

    screen.getByTestId('call-leave-roster').focus();
    await userEvent.keyboard('{Enter}');
    expect(engine.leave).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByTestId('call-leave-panel'));
    expect(engine.leave).toHaveBeenCalledTimes(2);
  });

  it('renders the alone-in-call empty state with the ring-the-room action (AM17)', async () => {
    const engine = fakeEngine();
    const store = makeStore();
    // Only the viewer remains.
    store.setState((s) => ({
      callByChannel: {
        [CH]: {
          ...s.callByChannel[CH]!,
          participants: { [ME]: s.callByChannel[CH]!.participants[ME]! },
        },
      },
    }));
    renderPanel(engine, store);

    expect(screen.getByTestId('call-alone-empty')).toBeTruthy();
    expect(screen.getByText(/only one here/i)).toBeTruthy();

    await userEvent.click(screen.getByTestId('call-ring-room'));
    expect(engine.ring).toHaveBeenCalledTimes(1);
  });

  it('embeds U9\'s call-log pane in the reserved region (no placeholder)', async () => {
    // REST for the pane's hydration: standing thread + boundaries.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes(`/channels/${CH}/call`)) {
          return {
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            json: async () => ({
              thread_id: '55',
              live: null,
              recently_ended: [],
            }),
          } as unknown as Response;
        }
        if (url.includes('/threads/55/messages')) {
          return {
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            json: async () => ({ messages: [] }),
          } as unknown as Response;
        }
        return { ok: false, status: 404, headers: { get: () => 'application/json' }, json: async () => ({}) } as unknown as Response;
      }),
    );
    renderPanel(fakeEngine());
    expect(screen.getByTestId('call-log-slot')).toBeTruthy();
    expect(screen.getByText('Call log')).toBeTruthy();
    // The real pane renders inside the region (U9), not the old placeholder.
    await waitFor(() => {
      expect(screen.getByTestId('call-log-rows')).toBeTruthy();
    });
    expect(screen.queryByTestId('call-log-empty-placeholder')).toBeNull();
  });

  it('keyboard flow: panel controls → embedded log → composer (U9, no pointer)', async () => {
    // REST for the pane's hydration (standing thread, empty log).
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes(`/channels/${CH}/call`)) {
          return {
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            json: async () => ({ thread_id: '55', live: null, recently_ended: [] }),
          } as unknown as Response;
        }
        if (url.includes('/threads/55/messages')) {
          return {
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            json: async () => ({ messages: [] }),
          } as unknown as Response;
        }
        return { ok: false, status: 404, headers: { get: () => 'application/json' }, json: async () => ({}) } as unknown as Response;
      }),
    );
    renderPanel(fakeEngine());
    await waitFor(() => {
      expect(screen.getByTestId('call-log-rows')).toBeTruthy();
    });

    // Tab-walk from the panel's mute control into the log's composer
    // editable — keyboard reaches log → composer without any pointer.
    const start = screen.getByTestId('call-mute-panel');
    start.focus();
    const editable = screen.getByRole('combobox');
    for (let i = 0; i < 40 && document.activeElement !== editable; i++) {
      await userEvent.tab();
    }
    expect(document.activeElement).toBe(editable);
  });

  it('has no axe violations when connected (full roster)', async () => {
    const { container } = renderPanel(fakeEngine());
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations when alone in call', async () => {
    const engine = fakeEngine();
    const store = makeStore();
    store.setState((s) => ({
      callByChannel: {
        [CH]: {
          ...s.callByChannel[CH]!,
          participants: { [ME]: s.callByChannel[CH]!.participants[ME]! },
        },
      },
    }));
    const { container } = renderPanel(engine, store);
    expect(await axe(container)).toHaveNoViolations();
  });
});

// -- every other composite state surface ----------------------------------------

describe('CallPanel — composite state surfaces', () => {
  function surface(voice: VoiceState): { container: HTMLElement; engine: ReturnType<typeof fakeEngine> } {
    const engine = fakeEngine({ voice });
    const utils = renderPanel(engine);
    return { container: utils.container, engine };
  }

  it('connecting-signaling: spinner + text, role=status', () => {
    const { container } = surface({ ...initialVoiceState(), status: 'connecting-signaling' });
    const el = screen.getByTestId('call-state-connecting-signaling');
    expect(el.getAttribute('role')).toBe('status');
    expect(el.textContent).toContain('Connecting to the call');
    expect(container.querySelector('[data-testid="call-spinner"]')).toBeTruthy();
  });

  it('connecting-media: spinner + text, roster already visible', () => {
    surface({ ...initialVoiceState(), status: 'connecting-media', micGranted: true });
    expect(screen.getByTestId('call-state-connecting-media').textContent).toContain(
      'Establishing voice',
    );
    expect(screen.getAllByTestId('call-roster-row')).toHaveLength(3);
  });

  it('reconnecting: persistent status banner; roster + controls remain', () => {
    const { engine } = surface({
      ...initialVoiceState(),
      status: 'reconnecting',
      pcConnected: true,
      micGranted: true,
    });
    expect(screen.getByTestId('call-state-reconnecting').getAttribute('role')).toBe('status');
    expect(screen.getAllByTestId('call-roster-row')).toHaveLength(3);
    expect(screen.getByTestId('call-mute-panel')).toBeTruthy();
    void engine;
  });

  it('listen-only (VM5): status guidance + in-place mic retry, roster + controls remain', async () => {
    const engine = fakeEngine({
      voice: {
        ...initialVoiceState(),
        status: 'connected',
        pcConnected: true,
        micDenied: true,
      },
      listenOnly: true, // the engine derives this from voice.micDenied
    });
    renderPanel(engine);
    const banner = screen.getByTestId('call-state-listen-only');
    expect(banner.getAttribute('role')).toBe('status');
    expect(banner.textContent).toContain('Listening only');
    expect(screen.getAllByTestId('call-roster-row')).toHaveLength(3);
    await userEvent.click(screen.getByTestId('call-retry-mic'));
    expect(engine.retryMic).toHaveBeenCalledTimes(1);
  });

  it('share-unavailable (F5): mid-call notice with the KDV3 web-app handoff, leg unaffected', async () => {
    const engine = fakeEngine({
      voice: {
        ...initialVoiceState(),
        status: 'connected',
        pcConnected: true,
        micGranted: true,
        notice: 'share-unavailable',
      },
    });
    renderPanel(engine);
    const banner = screen.getByTestId('call-notice-share-unavailable');
    expect(banner.getAttribute('role')).toBe('status');
    expect(banner.textContent).toContain("isn't available in this app");
    expect(screen.getAllByTestId('call-roster-row')).toHaveLength(3);

    const handoff = screen.getByTestId('call-notice-share-unavailable-handoff');
    expect(handoff.getAttribute('aria-label')).toBe(
      'Open the web app to share your screen',
    );
    await userEvent.click(screen.getByText('OK'));
    expect(engine.dismiss).toHaveBeenCalled();
  });

  it('share-ended (VM8): mid-call notice while the leg stays connected', async () => {
    const engine = fakeEngine({
      voice: {
        ...initialVoiceState(),
        status: 'connected',
        pcConnected: true,
        micGranted: true,
        notice: 'share-ended',
      },
    });
    renderPanel(engine);
    const banner = screen.getByTestId('call-notice-share-ended');
    expect(banner.getAttribute('role')).toBe('status');
    expect(banner.textContent).toContain('screen share ended');
    expect(screen.getAllByTestId('call-roster-row')).toHaveLength(3);
    await userEvent.click(screen.getByText('OK'));
    expect(engine.dismiss).toHaveBeenCalledTimes(1);
  });

  it('permission-denied (forced removal): removal copy', () => {
    surface({ ...initialVoiceState(), status: 'permission-denied', notice: 'forced-leave' });
    const alert = screen.getByTestId('call-state-permission-denied');
    expect(alert.textContent).toContain("don't have permission");
    expect(alert.textContent).not.toContain('Microphone access');
  });

  it('voice-unavailable: alert + retry', async () => {
    const { engine } = surface({ ...initialVoiceState(), status: 'voice-unavailable' });
    const alert = screen.getByTestId('call-state-voice-unavailable');
    expect(alert.getAttribute('role')).toBe('alert');
    await userEvent.click(screen.getByTestId('call-retry'));
    expect(engine.retry).toHaveBeenCalledTimes(1);
  });

  it('offline: teardown notice alert + dismiss', async () => {
    const { engine } = surface({ ...initialVoiceState(), status: 'offline', notice: 'offline' });
    expect(screen.getByTestId('call-state-offline').getAttribute('role')).toBe('alert');
    await userEvent.click(screen.getByTestId('call-dismiss'));
    expect(engine.dismiss).toHaveBeenCalledTimes(1);
  });

  it('idle + displaced: "joined elsewhere" notice with dismiss', async () => {
    const { engine } = surface({ ...initialVoiceState(), notice: 'displaced' });
    expect(screen.getByTestId('call-state-displaced').textContent).toContain(
      'joined this call on another device',
    );
    await userEvent.click(screen.getByTestId('call-dismiss'));
    expect(engine.dismiss).toHaveBeenCalledTimes(1);
  });

  it('axe: zero violations on every state surface', async () => {
    const surfaces: Array<{ voice: VoiceState; snapshot?: Partial<CallEngineSnapshot> }> = [
      { voice: { ...initialVoiceState(), status: 'connecting-signaling' } },
      { voice: { ...initialVoiceState(), status: 'connecting-media', micGranted: true } },
      { voice: { ...initialVoiceState(), status: 'reconnecting', pcConnected: true, micGranted: true } },
      {
        voice: { ...initialVoiceState(), status: 'connected', pcConnected: true, micDenied: true },
        snapshot: { listenOnly: true },
      },
      {
        voice: { ...initialVoiceState(), status: 'connected', pcConnected: true, micGranted: true, notice: 'share-ended' },
      },
      { voice: { ...initialVoiceState(), status: 'permission-denied', notice: 'forced-leave' } },
      { voice: { ...initialVoiceState(), status: 'voice-unavailable' } },
      { voice: { ...initialVoiceState(), status: 'offline', notice: 'offline' } },
      { voice: { ...initialVoiceState(), notice: 'displaced' } },
    ];
    for (const s of surfaces) {
      cleanup();
      const engine = fakeEngine({ voice: s.voice, ...s.snapshot });
      const utils = renderPanel(engine);
      expect(await axe(utils.container)).toHaveNoViolations();
    }
  });
});

// -- mobile bottom sheet ----------------------------------------------------------

describe('CallPanelSurface — mobile bottom sheet (AM18)', () => {
  it('renders as a dialog sheet over the pane and collapses on Esc', async () => {
    const engine = fakeEngine();
    const onClose = vi.fn();
    render(
      <CallPanelSurface
        channelId={CH}
        store={makeStore()}
        engine={engine}
        forceMobile
        onClose={onClose}
      />,
    );

    expect(screen.getByTestId('call-sheet')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Call' })).toBeTruthy();
    // The panel content is inside the sheet (portal → document).
    expect(screen.getByTestId('call-panel')).toBeTruthy();

    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('desktop geometry renders the docked form (no dialog)', () => {
    render(
      <CallPanelSurface
        channelId={CH}
        store={makeStore()}
        engine={fakeEngine()}
        forceMobile={false}
      />,
    );
    expect(screen.getByTestId('call-dock')).toBeTruthy();
    expect(screen.queryByTestId('call-sheet')).toBeNull();
  });

  it('has no axe violations in the mobile sheet', async () => {
    render(
      <CallPanelSurface
        channelId={CH}
        store={makeStore()}
        engine={fakeEngine()}
        forceMobile
      />,
    );
    expect(await axe(document.body)).toHaveNoViolations();
  });
});

// ---------------------------------------------------------------------------
// V2 (U5b) — the video composition (VM15/VM16/VM18–VM22)
// ---------------------------------------------------------------------------

const T1 = '2026-09-07T12:00:03Z';
const T2 = '2026-09-07T12:00:05Z';

function tileOf(userId: string): HTMLElement {
  return screen.getAllByTestId('video-tile').find(
    (t) => t.getAttribute('data-user-id') === userId,
  )!;
}

describe('CallPanel — V2 video composition', () => {
  it('no share: the grid fills the media area (VM16); roster members without camera render camera-off tiles', () => {
    const engine = fakeEngine();
    renderPanel(engine);

    const grid = screen.getByTestId('video-grid');
    expect(grid.getAttribute('data-variant')).toBe('grid');
    expect(screen.queryByTestId('video-stage')).toBeNull();
    expect(screen.getAllByTestId('video-tile')).toHaveLength(3);
    for (const tile of screen.getAllByTestId('video-tile')) {
      expect(tile.getAttribute('data-state')).toBe('camera-off');
    }
    // The named empty grid state only fires with no participants at all —
    // camera-off tiles ARE the honest surface for an audio-only roster.
    expect(screen.queryByTestId('video-grid-empty')).toBeNull();
  });

  it('camera publishers render live tiles from the manifest-attributed engine tracks; unattached publishers load', () => {
    const engine = fakeEngine();
    const store = makeStore({
      sources: { [U2]: { camera: T1 }, [U3]: { camera: T2 } },
    });
    engine.setVideoTracks(new Map([[`${U2}:camera`, { id: 's-cam-2' }]]));
    renderPanel(engine, store);

    expect(tileOf(U2).getAttribute('data-state')).toBe('live');
    expect(tileOf(U2).querySelector('[data-testid="tile-video"]')).toBeTruthy();
    expect(tileOf(U3).getAttribute('data-state')).toBe('loading'); // roster-first arrival
    expect(tileOf(ME).getAttribute('data-state')).toBe('camera-off');
    // Speaking overlays ride the tiles from the speaking monitor (U2 speaks).
    expect(tileOf(U2).getAttribute('data-speaking')).toBe('true');
    expect(tileOf(U3).getAttribute('data-speaking')).toBeNull();
  });

  it('self tile: publishing camera renders the MIRRORED live tile from the local capture (VM15)', () => {
    const engine = fakeEngine({
      publishing: { camera: true, screen: false, screen_audio: false },
    });
    engine.setLocalCameraTrack({ id: 's-self' });
    renderPanel(engine);

    const self = tileOf(ME);
    expect(self.getAttribute('data-state')).toBe('live');
    expect(self.className).toContain('video-mirrored');
    expect(tileOf(U2).className).not.toContain('video-mirrored');
  });

  it('share-live: the stage dominates with the presenter bar, the grid demotes to the strip, self demotes to the overlay (VM15/VM16)', () => {
    const engine = fakeEngine({
      publishing: { camera: true, screen: false, screen_audio: false },
    });
    engine.setLocalCameraTrack({ id: 's-self' });
    const store = makeStore({ sources: { [U2]: { screen: T1 } } });
    engine.setVideoTracks(new Map([[`${U2}:screen`, { id: 's-screen-2' }]]));
    renderPanel(engine, store);

    const stage = screen.getByTestId('video-stage');
    expect(stage.getAttribute('data-stage-state')).toBe('live');
    expect(screen.getByTestId('stage-presenter').textContent).toContain('river');
    expect(screen.getByTestId('stage-video')).toBeTruthy();
    expect(screen.getByTestId('video-grid').getAttribute('data-variant')).toBe('strip');
    // VM15: self-view is the corner overlay — NOT a member of the strip grid
    // (the only ME-labeled tile is the overlay's own).
    expect(screen.getByTestId('self-view').getAttribute('data-variant')).toBe('overlay');
    expect(
      screen
        .getByTestId('video-grid')
        .querySelectorAll('[data-testid="video-tile"][data-user-id="' + ME + '"]'),
    ).toHaveLength(0);
    // No share-audio source → no badge (VM9).
    expect(screen.queryByTestId('stage-share-audio-badge')).toBeNull();
  });

  it('VM9: the presenter bar badges a live share-audio track', () => {
    const engine = fakeEngine();
    const store = makeStore({
      sources: { [U2]: { screen: T1, screen_audio: T1 } },
    });
    engine.setVideoTracks(new Map([[`${U2}:screen`, { id: 's-screen-2' }]]));
    renderPanel(engine, store);
    expect(screen.getByTestId('stage-share-audio-badge').textContent).toContain(
      'Sharing audio',
    );
  });

  it('multi-share: the stage follows the most-recent sharer (VM4); the switcher lists all (VM22)', async () => {
    const engine = fakeEngine();
    const store = makeStore({
      sources: { [U2]: { screen: T2 }, [U3]: { screen: T1 } }, // U2 newest
    });
    engine.setVideoTracks(
      new Map([
        [`${U2}:screen`, { id: 's-screen-2' }],
        [`${U3}:screen`, { id: 's-screen-3' }],
      ]),
    );
    renderPanel(engine, store);

    // Follow-recent stages U2 (river); the trigger names the live count.
    expect(screen.getByTestId('video-stage').getAttribute('data-share-id')).toBe(U2);
    expect(screen.getByTestId('share-switcher-trigger').getAttribute('aria-label')).toContain(
      '2 live',
    );

    // Switcher select → viewer-selected, holds across a newer share (VM22).
    await userEvent.click(screen.getByTestId('share-switcher-trigger'));
    expect(screen.getAllByTestId('share-switcher-option')).toHaveLength(2);
    await userEvent.click(
      screen.getAllByTestId('share-switcher-option').find(
        (o) => o.getAttribute('data-share-id') === U3,
      )!,
    );
    expect(screen.getByTestId('video-stage').getAttribute('data-share-id')).toBe(U3);
    expect(screen.getByTestId('share-switcher-root').getAttribute('data-mode')).toBe(
      'viewer-selected',
    );

    store.setState((s) => ({
      callByChannel: {
        [CH]: {
          ...s.callByChannel[CH]!,
          participants: {
            ...s.callByChannel[CH]!.participants,
            [ME]: {
              ...s.callByChannel[CH]!.participants[ME]!,
              sources: [{ source: 'screen', since: '2026-09-07T12:00:09Z' }],
            },
          },
        },
      },
    }));
    await waitFor(() => {
      // Viewer-selected HOLDS against the newcomer.
      expect(screen.getByTestId('video-stage').getAttribute('data-share-id')).toBe(U3);
    });
    // The switcher's trigger count grew to 3 live shares.
    expect(screen.getByTestId('share-switcher-trigger').getAttribute('aria-label')).toContain(
      '3 live',
    );
  });

  it('pin: overrides everything; unpin resumes follow-recent; a pinned share ending falls back (VM4/VM22)', async () => {
    const engine = fakeEngine();
    const store = makeStore({ sources: { [U2]: { screen: T2 }, [U3]: { screen: T1 } } });
    renderPanel(engine, store);
    expect(screen.getByTestId('video-stage').getAttribute('data-share-id')).toBe(U2);

    // Pin U2 (the staged share).
    await userEvent.click(screen.getByTestId('stage-pin'));
    expect(screen.getByTestId('video-stage').getAttribute('data-pinned')).toBe('true');

    // A newer share arrives — pinned holds.
    store.setState((s) => ({
      callByChannel: {
        [CH]: {
          ...s.callByChannel[CH]!,
          participants: {
            ...s.callByChannel[CH]!.participants,
            [ME]: {
              ...s.callByChannel[CH]!.participants[ME]!,
              sources: [{ source: 'screen', since: '2026-09-07T12:00:09Z' }],
            },
          },
        },
      },
    }));
    await waitFor(() => {
      expect(screen.getByTestId('share-switcher-trigger').getAttribute('aria-label')).toContain(
        '3 live',
      );
    });
    expect(screen.getByTestId('video-stage').getAttribute('data-share-id')).toBe(U2);

    // The pinned share ends → follow-recent (the newest survivor).
    store.setState((s) => ({
      callByChannel: {
        [CH]: {
          ...s.callByChannel[CH]!,
          participants: {
            ...s.callByChannel[CH]!.participants,
            [U2]: { ...s.callByChannel[CH]!.participants[U2]!, sources: undefined },
          },
        },
      },
    }));
    await waitFor(() => {
      expect(screen.getByTestId('video-stage').getAttribute('data-pinned')).toBeNull();
    });
    expect(screen.getByTestId('video-stage').getAttribute('data-share-id')).toBe(ME);
  });

  it('ended-share: the LAST share ending surfaces the ended card; Back to grid collapses (VM22)', async () => {
    const engine = fakeEngine();
    const store = makeStore({ sources: { [U2]: { screen: T1 } } });
    renderPanel(engine, store);
    expect(screen.getByTestId('video-stage').getAttribute('data-stage-state')).toBe('live');

    store.setState((s) => ({
      callByChannel: {
        [CH]: {
          ...s.callByChannel[CH]!,
          participants: {
            ...s.callByChannel[CH]!.participants,
            [U2]: { ...s.callByChannel[CH]!.participants[U2]!, sources: undefined },
          },
        },
      },
    }));

    await waitFor(() => {
      expect(screen.getByTestId('video-stage').getAttribute('data-stage-state')).toBe(
        'ended',
      );
    });
    // U2 is still in the roster → "stopped" copy.
    expect(screen.getByTestId('stage-ended').textContent).toContain(
      'The screen share ended.',
    );

    await userEvent.click(screen.getByTestId('stage-collapse'));
    expect(screen.queryByTestId('video-stage')).toBeNull();
    expect(screen.getByTestId('video-grid').getAttribute('data-variant')).toBe('grid');
  });

  it('ended-share: presenter-left names the departed presenter', async () => {
    const engine = fakeEngine();
    const store = makeStore({ sources: { [U2]: { screen: T1 } } });
    renderPanel(engine, store);

    store.setState((s) => {
      const { [U2]: _gone, ...participants } = s.callByChannel[CH]!.participants;
      return { callByChannel: { [CH]: { ...s.callByChannel[CH]!, participants } } };
    });
    await waitFor(() => {
      expect(screen.getByTestId('stage-ended').textContent).toContain(
        'river left the call — their screen share ended.',
      );
    });
  });

  it('fullscreen (VM16 desktop): the enlarge affordance toggles stage fullscreen', async () => {
    const engine = fakeEngine();
    const store = makeStore({ sources: { [U2]: { screen: T1 } } });
    renderPanel(engine, store, { mobile: false });

    expect(screen.getByTestId('video-stage').getAttribute('data-fullscreen')).toBeNull();
    await userEvent.click(screen.getByTestId('stage-enlarge'));
    expect(screen.getByTestId('video-stage').getAttribute('data-fullscreen')).toBe('true');
    await userEvent.click(screen.getByTestId('stage-enlarge'));
    expect(screen.getByTestId('video-stage').getAttribute('data-fullscreen')).toBeNull();
  });

  it('VM19 mobile: a live share auto-expands the stage fullscreen with the strip grid', () => {
    const engine = fakeEngine();
    const store = makeStore({ sources: { [U2]: { screen: T1 } } });
    renderPanel(engine, store, { mobile: true });

    expect(screen.getByTestId('video-stage').getAttribute('data-fullscreen')).toBe('true');
    expect(screen.getByTestId('video-grid').getAttribute('data-variant')).toBe('strip');
  });

  it('budget shrink: beyond-budget publishers degrade to VM18 connection-paused avatars + the polite announcement; speakers keep live slots (VM3/VM18)', async () => {
    const engine = fakeEngine();
    const store = makeStore({
      sources: { [U2]: { camera: T1 }, [U3]: { camera: T2 } },
    });
    engine.setVideoTracks(
      new Map([
        [`${U2}:camera`, { id: 's-cam-2' }],
        [`${U3}:camera`, { id: 's-cam-3' }],
      ]),
    );
    renderPanel(engine, store);
    expect(tileOf(U2).getAttribute('data-state')).toBe('live');
    expect(tileOf(U3).getAttribute('data-state')).toBe('live');

    // The ladder steps down to a single tile.
    act(() => {
      engine.setWant({ tiles: 1, max_quality: 'low' });
    });
    // U2 is the current speaker (the fake's speaking set) → keeps the slot.
    expect(tileOf(U2).getAttribute('data-state')).toBe('live');
    expect(tileOf(U3).getAttribute('data-state')).toBe('connection-paused');
    expect(screen.getAllByTestId('tile-paused-connection')).toHaveLength(1);
    // VM18's distinction: no PUBLISHER renders as camera-off here — the only
    // camera-off tile is ME (the publisher's own choice, not the budget's).
    expect(tileOf(ME).getAttribute('data-state')).toBe('camera-off');
    expect(
      screen.getAllByTestId('tile-camera-off').every(
        (c) => c.closest('[data-user-id]')?.getAttribute('data-user-id') === ME,
      ),
    ).toBe(true);
    expect(screen.getByTestId('video-grid-announce').textContent).toContain(
      'Connection slowed — showing 1 live video tile',
    );

    // Recovery announces too (the ladder's slow upshift).
    act(() => {
      engine.setWant({ tiles: 2, max_quality: 'high' });
    });
    expect(tileOf(U3).getAttribute('data-state')).toBe('live');
    expect(screen.getByTestId('video-grid-announce').textContent).toContain(
      'Connection recovered — showing 2 live video tiles',
    );
  });

  it('reconnecting: live tiles carry the freeze hint (the offline grid surface)', () => {
    const engine = fakeEngine({
      voice: { ...initialVoiceState(), status: 'reconnecting', pcConnected: true, micGranted: true },
    });
    const store = makeStore({ sources: { [U2]: { camera: T1 } } });
    engine.setVideoTracks(new Map([[`${U2}:camera`, { id: 's-cam-2' }]]));
    renderPanel(engine, store);
    expect(screen.getByTestId('tile-freeze-hint')).toBeTruthy();
  });

  it('spotlight (VM21): tile activation enlarges one participant; Back to grid returns', async () => {
    const engine = fakeEngine();
    const store = makeStore({ sources: { [U2]: { camera: T1 } } });
    engine.setVideoTracks(new Map([[`${U2}:camera`, { id: 's-cam-2' }]]));
    renderPanel(engine, store);

    await userEvent.click(tileOf(U2));
    expect(screen.getByTestId('call-spotlight-bar-panel')).toBeTruthy();
    // The spotlight surface announces whom it enlarges.
    expect(screen.getByTestId('call-spotlight-bar-panel').textContent).toContain('river');

    await userEvent.click(screen.getByTestId('spotlight-back-panel'));
    expect(screen.queryByTestId('call-spotlight-bar-panel')).toBeNull();
    expect(screen.getAllByTestId('video-tile')).toHaveLength(3);
  });

  it('keyboard: a tile focuses and Enter spotlights (VM21 activation semantics)', async () => {
    const engine = fakeEngine();
    const store = makeStore({ sources: { [U2]: { camera: T1 } } });
    engine.setVideoTracks(new Map([[`${U2}:camera`, { id: 's-cam-2' }]]));
    renderPanel(engine, store);

    tileOf(U2).focus();
    expect(tileOf(U2).getAttribute('aria-label')).toContain('river, camera on');
    await userEvent.keyboard('{Enter}');
    expect(screen.getByTestId('call-spotlight-bar-panel')).toBeTruthy();
  });

  it('R3: roster rows badge live published sources', () => {
    const engine = fakeEngine();
    const store = makeStore({
      sources: { [U2]: { screen: T1, screen_audio: T1 }, [U3]: { camera: T2 } },
    });
    renderPanel(engine, store);

    const badges = screen.getAllByTestId('roster-source');
    expect(
      badges.filter((b) => b.closest('[data-user-id]')?.getAttribute('data-user-id') === U2)
        .length,
    ).toBe(2);
    expect(
      badges.find((b) => b.closest('[data-user-id]')?.getAttribute('data-user-id') === U3)!
        .getAttribute('data-source'),
    ).toBe('camera');
  });

  it('axe: zero violations on the composed media surfaces', async () => {
    const cases: Array<Parameters<typeof renderPanel>[1] extends never ? never : {
      name: string;
      sources?: Record<string, SourcesSpec>;
      overrides?: Partial<CallEngineSnapshot>;
      tracks?: Map<string, unknown>;
      selfTrack?: unknown;
      props?: { mobile?: boolean; capabilities?: { calls: boolean; video: boolean; screenshare: boolean } };
    }> = [
      { name: 'no-share grid' },
      {
        name: 'camera tiles (live + loading + camera-off)',
        sources: { [U2]: { camera: T1 }, [U3]: { camera: T2 } },
        tracks: new Map([[`${U2}:camera`, { id: 's' }]]),
      },
      {
        name: 'share-live (stage + strip + self overlay)',
        sources: { [U2]: { screen: T1, screen_audio: T1 } },
        overrides: { publishing: { camera: true, screen: false, screen_audio: false } },
        tracks: new Map([[`${U2}:screen`, { id: 's' }]]),
        selfTrack: { id: 'self' },
      },
      {
        name: 'multi-share + switcher + pinned',
        sources: { [U2]: { screen: T2 }, [U3]: { screen: T1 } },
      },
      {
        name: 'mobile share-live (VM19)',
        sources: { [U2]: { screen: T1 } },
        props: { mobile: true },
      },
    ];
    for (const c of cases) {
      cleanup();
      const engine = fakeEngine(c.overrides);
      if (c.tracks) engine.setVideoTracks(c.tracks);
      if (c.selfTrack !== undefined) engine.setLocalCameraTrack(c.selfTrack);
      const utils = renderPanel(engine, makeStore({ sources: c.sources }), c.props);
      expect(await axe(utils.container), c.name).toHaveNoViolations();
    }
  });
});

// ---------------------------------------------------------------------------
// V2 (U5b) — publish controls, capability gating (VM10/VM20), pickers (R2/R9)
// ---------------------------------------------------------------------------

describe('CallPanel — V2 publish controls + gating', () => {
  it('camera toggle publishes / unpublishes through the engine; screen rides share-audio (VM9)', async () => {
    const engine = fakeEngine();
    renderPanel(engine);

    await userEvent.click(screen.getByTestId('call-camera-panel'));
    expect(engine.publishCamera).toHaveBeenCalledTimes(1);

    engine.setSnapshot({ publishing: { camera: true, screen: false, screen_audio: false } });
    await userEvent.click(screen.getByTestId('call-camera-panel'));
    expect(engine.unpublishSource).toHaveBeenCalledWith('camera');

    await userEvent.click(screen.getByTestId('call-share-panel'));
    expect(engine.publishScreen).toHaveBeenCalledWith({ audio: true });

    engine.setSnapshot({ publishing: { camera: false, screen: true, screen_audio: true } });
    await userEvent.click(screen.getByTestId('call-share-panel'));
    expect(engine.unpublishSource).toHaveBeenCalledWith('screen');
    // VM13 switch affordance on a live share.
    await userEvent.click(screen.getByTestId('call-switch-share-panel'));
    expect(engine.switchScreenSource).toHaveBeenCalledTimes(1);
  });

  it('quality pickers: sender tier per live source + the receiver ceiling (R2/R9)', async () => {
    const engine = fakeEngine({
      publishing: { camera: true, screen: true, screen_audio: false },
    });
    renderPanel(engine);

    const cameraPicker = screen
      .getAllByTestId('quality-picker-panel')
      .find((p) => p.getAttribute('data-kind') === 'sender' && p.getAttribute('data-source') === 'camera')!;
    await userEvent.click(cameraPicker.querySelector('[data-testid="quality-trigger-panel"]')!);
    const option = screen
      .getAllByTestId('quality-option-panel')
      .find((o) => o.getAttribute('data-quality') === 'medium')!;
    await userEvent.click(option);
    expect(engine.setPublishQuality).toHaveBeenCalledWith('camera', 'medium');

    const receiverPicker = screen
      .getAllByTestId('quality-picker-panel')
      .find((p) => p.getAttribute('data-kind') === 'receiver')!;
    await userEvent.click(receiverPicker.querySelector('[data-testid="quality-trigger-panel"]')!);
    const low = screen
      .getAllByTestId('quality-option-panel')
      .find((o) => o.getAttribute('data-quality') === 'low')!;
    await userEvent.click(low);
    expect(engine.setReceiverMaxQuality).toHaveBeenCalledWith('low');
  });

  it('VM20: SEND_VIDEO/SHARE_SCREEN-denied controls render pre-disabled with explanatory titles', () => {
    const engine = fakeEngine();
    renderPanel(engine, makeStore(), { canSendVideo: false, canShareScreen: false });

    const camera = screen.getByTestId('call-camera-panel') as HTMLButtonElement;
    expect(camera.disabled).toBe(true);
    expect(camera.getAttribute('title')).toContain("don't have permission to send video");
    const share = screen.getByTestId('call-share-panel') as HTMLButtonElement;
    expect(share.disabled).toBe(true);
    expect(share.getAttribute('title')).toContain("don't have permission to share your screen");
  });

  it('VM10/R17: capability-off affordances render visible-disabled with the explanatory dialog', async () => {
    const engine = fakeEngine();
    renderPanel(engine, makeStore(), {
      capabilities: { calls: true, video: false, screenshare: false },
    });

    // Visible, aria-disabled, activating EXPLAINS (never hidden, never 403).
    const affordances = screen.getAllByTestId('capability-disabled-panel');
    expect(affordances).toHaveLength(2); // camera + share — neither disappears
    const camera = affordances[0]!;
    expect(camera.getAttribute('aria-disabled')).toBe('true');
    await userEvent.click(camera);
    expect(screen.getByTestId('capability-disabled-dialog-panel')).toBeTruthy();
    expect(screen.getByText(/Video isn.t available/)).toBeTruthy();
    await userEvent.click(screen.getByTestId('capability-disabled-dismiss-panel'));

    const share = affordances[1]!;
    await userEvent.click(share);
    expect(screen.getByText(/Screen sharing isn.t available/)).toBeTruthy();
  });

  it('the capabilities arrive from GET /channels/:id/call (the REST seam)', async () => {
    const engine = fakeEngine();
    renderPanel(engine, makeStore(), {
      fetchCapabilities: () =>
        Promise.resolve({ calls: true, video: false, screenshare: true }),
    });
    await waitFor(() => {
      expect(screen.getByTestId('capability-disabled-panel')).toBeTruthy();
    });
  });

  it('VM10 mobile: the share affordance renders visible-disabled with the mobile dialog copy', async () => {
    const engine = fakeEngine();
    renderPanel(engine, makeStore(), { mobile: true });

    // Only the share affordance is capability-gated on mobile (VM10); the
    // camera affordance stays a real publish control.
    const share = screen.getByTestId('capability-disabled-panel');
    expect(screen.getByTestId('call-camera-panel')).toBeTruthy();
    await userEvent.click(share);
    // The title AND body both carry the phrase — the dialog explains.
    expect(screen.getAllByText(/Screen sharing isn.t available/).length).toBeGreaterThan(0);
    expect(screen.getByTestId('capability-disabled-dialog-panel').textContent).toContain(
      'join the call from the desktop or web app',
    );
  });

  it('VM20 camera picker carries the denied title while pre-disabled', () => {
    const engine = fakeEngine({
      publishing: { camera: true, screen: false, screen_audio: false },
    });
    renderPanel(engine, makeStore(), { canSendVideo: false });

    const cameraPicker = screen
      .getAllByTestId('quality-picker-panel')
      .find((p) => p.getAttribute('data-kind') === 'sender' && p.getAttribute('data-source') === 'camera')!;
    expect(cameraPicker.getAttribute('data-disabled')).toBe('true');
    expect(
      cameraPicker.querySelector('[data-testid="quality-trigger-panel"]')!.getAttribute('title'),
    ).toContain("don't have permission to send video");
  });
});

// ---------------------------------------------------------------------------
// V2 (U5b) — integration: the REAL engine (fake gateway + stub media, the
// U8/V2 harness pattern) — camera publish → tiles from roster sources
// ---------------------------------------------------------------------------

/** The V2 fake PC: manifest m-lines fire ontrack; senders bind by mid. */
class FakeV2Pc {
  connectionState = 'new';
  closed = false;
  ontrack:
    | ((e: {
        track: { stop(): void; enabled: boolean; contentHint?: string; onended?: null };
        transceiver?: { mid: string };
      }) => void)
    | null = null;
  onicecandidate: ((e: { candidate: null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  private mids: string[] = [];
  private bound = new Map<string, unknown>();

  addTrack(): unknown {
    return {};
  }

  async setRemoteDescription(d: { sdp: string }): Promise<void> {
    this.mids = [...d.sdp.matchAll(/a=mid:(\d+)/g)].map((m) => m[1]!);
    for (const mid of this.mids) {
      this.ontrack?.({
        track: { stop: () => undefined, enabled: true, onended: null },
        transceiver: { mid },
      });
    }
  }

  getTransceivers(): Array<{
    mid: string | null;
    direction?: string;
    sender: { replaceTrack(t: unknown): Promise<void> };
  }> {
    return this.mids.map((mid) => ({
      mid,
      direction: 'sendrecv',
      sender: {
        replaceTrack: async (track: unknown) => {
          this.bound.set(mid, track);
        },
      },
    }));
  }

  /** Test probe: what the manifest binding attached at `mid`. */
  boundTrack(mid: string): unknown {
    return this.bound.get(mid);
  }

  async getStats(): Promise<Array<Record<string, unknown>>> {
    return [];
  }

  async createAnswer(): Promise<{ type: string; sdp: string }> {
    return {
      type: 'answer',
      sdp:
        'v=0\r\nm=audio 9 RTP/AVP 111\r\na=mid:0\r\na=rtpmap:111 opus/48000/2\r\n' +
        'm=video 9 RTP/AVP 96\r\na=mid:1\r\na=rtpmap:96 VP8/90000\r\n',
    };
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

const V2_OFFER_SDP = [
  'v=0',
  'm=audio 9 RTP/AVP 111',
  'a=mid:0',
  'a=rtpmap:111 opus/48000/2',
  'm=video 9 RTP/AVP 96',
  'a=mid:1',
  'a=rtpmap:96 VP8/90000',
].join('\n');

describe('CallPanel — V2 integration (real engine, manifest offer)', () => {
  function integrationHarness() {
    const store = makeStore();
    const sentState: Array<Record<string, unknown>> = [];
    const handlers = new Map<string, Set<(p: unknown) => void>>();
    const gateway = {
      connectionState: 'ready',
      sendCallState: (p: Record<string, unknown>) => {
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
    const pcs: FakeV2Pc[] = [];
    const micTracks = [{ stop: () => undefined, enabled: true }];
    const cameraTracks = [{ stop: () => undefined, enabled: true }];
    const engine = createCallEngine({
      store,
      gateway: () => gateway as never,
      pollMs: 0,
      fetchIceServers: () => Promise.resolve([]),
      publishDebounceMs: 0,
      adaptiveBudget: null, // no ladder: the want stays at its declared default
      media: {
        getUserMedia: () =>
          Promise.resolve({
            getAudioTracks: () => micTracks,
            getVideoTracks: () => [],
          }),
        createPeerConnection: () => {
          const pc = new FakeV2Pc();
          pcs.push(pc);
          return pc as never;
        },
        createStream: (tracks) => ({
          getAudioTracks: () => tracks,
          getVideoTracks: () => [],
        }),
        attachAudio: () => ({ setMuted: () => undefined, stop: () => undefined }),
      },
      captureEnv: {
        getUserMedia: () =>
          Promise.resolve({
            getAudioTracks: () => [],
            getVideoTracks: () => cameraTracks,
          }),
        getDisplayMedia: () =>
          Promise.resolve({
            getAudioTracks: () => [],
            getVideoTracks: () => [{ stop: () => undefined, enabled: true }],
          }),
      },
    });

    let seq = 0;
    const event = (t: 'CallUpdate', d: unknown) => {
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
    const signalEnvelope = () => {
      seq += 1;
      act(() => {
        routeCallSignalEvent({
          op: 0,
          t: 'CallSignal',
          s: seq,
          d: {
            channel_id: CH,
            body: JSON.stringify({
              v: 2,
              type: 'offer',
              sdp: V2_OFFER_SDP,
              tracks: [
                { mid: '0', user_id: ME, source: 'mic' },
                { mid: '1', user_id: U2, source: 'camera' },
              ],
            }),
          },
        });
      });
    };
    const flush = async () => {
      await act(async () => {
        for (let i = 0; i < 12; i++) await Promise.resolve();
      });
    };
    return { store, engine, sentState, pcs, event, eventStoreOnly, signalEnvelope, flush };
  }

  it('manifest offer → remote camera tile live; own camera publishes (op-22) and tiles from roster sources; receiver want rides video_want', async () => {
    const h = integrationHarness();
    act(() => {
      h.engine.join(CH);
    });
    h.event('CallUpdate', {
      channel_id: CH,
      call_id: '99',
      user_id: ME,
      leg: 'L1',
      state: 'joined',
    });
    h.signalEnvelope();
    await h.flush();
    act(() => {
      h.pcs[0]!.simulate('connected');
    });

    // The engine attributed mid 1 → (U2, camera): the video-track seam has it.
    expect(h.engine.getVideoTracks().get(`${U2}:camera`)).toBeTruthy();
    // The mic bound by manifest mid on the send side (KTD1).
    expect(h.pcs[0]!.boundTrack('0')).toBeTruthy();

    // Roster learns U2's camera (CALL_UPDATE camera_on) → the tile is live.
    h.event('CallUpdate', {
      channel_id: CH,
      call_id: '99',
      user_id: U2,
      leg: 'L2',
      state: 'camera_on',
      source: 'camera',
    });
    renderPanel(h.engine as never, h.store);
    expect(tileOf(U2).getAttribute('data-state')).toBe('live');

    // Own camera publish: stub capture → op-22 publish (participant-gated on
    // the confirmed leg) → roster camera_on for ME → self tile live.
    act(() => {
      h.engine.publishCamera('low');
    });
    await h.flush();
    expect(h.sentState).toContainEqual({
      channel_id: CH,
      action: 'publish',
      source: 'camera',
    });
    h.event('CallUpdate', {
      channel_id: CH,
      call_id: '99',
      user_id: ME,
      leg: 'L1',
      state: 'camera_on',
      source: 'camera',
    });
    await waitFor(() => {
      expect(tileOf(ME).getAttribute('data-state')).toBe('live');
    });
    expect(tileOf(ME).className).toContain('video-mirrored');

    // R9: the receiver ceiling rides op-22 video_want immediately.
    act(() => {
      h.engine.setReceiverMaxQuality('low');
    });
    expect(h.sentState).toContainEqual({
      channel_id: CH,
      action: 'state',
      video_want: { tiles: 9, max_quality: 'low' },
    });

    act(() => {
      h.engine.destroy();
    });
  });
});
