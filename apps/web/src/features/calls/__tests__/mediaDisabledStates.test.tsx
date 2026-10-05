/**
 * @cytale/web — the media master switch's UI states (ticket #124).
 *
 * The server declares `media_enabled` on READY → the store's `mediaEnabled`.
 * These tests pin the honest states-first rendering: with the switch off the
 * Start-call affordances NEVER silently vanish — they render visible-disabled
 * with the "calls are off on this server" title, distinguishable from
 * not-built; a live call's join affordances do the same (the call itself runs
 * out naturally); a viewer already holding a leg keeps their return/join
 * affordance (re-binds survive a disable — the standing-call edge). Default
 * (flag true) renders exactly today's affordances — the regression pin.
 *
 * The authoritative gate is server-side; this is the honest cosmetics layer.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createStateStore,
  defaultStore,
  type LiveCall,
  type StateStore,
} from '@cytale/state';

import { setCallEngineForTests, type CallEngine, type CallEngineSnapshot } from '../useCallMedia.js';
import { initialVoiceState } from '../voiceState.js';
import { CallSlot } from '../CallSlot.js';
import { DmCallIndicator } from '../dm/DmCallIndicator.js';
import { MessagePane } from '../../messages/MessagePane.js';
import type { UseMessages } from '../../messages/useMessages.js';

const CHANNEL = '9007199254740993';
const ME = '7000000000000002';
const PEER = '7000000000000003';
const CALL_ID = '5000000000000001';

const MEDIA_DISABLED_TITLE = 'Calls are turned off on this server';

// -- Virtuoso mock (jsdom has no layout; MessagePane.test's contract) ----------
vi.mock('react-virtuoso', async () => {
  const React = await import('react');
  const Virtuoso = React.forwardRef(function Virtuoso(
    props: {
      data?: readonly unknown[];
      itemContent: (index: number, data: unknown) => React.ReactNode;
      computeItemKey?: (index: number, data: unknown) => string;
    },
    ref: React.Ref<unknown>,
  ) {
    React.useImperativeHandle(ref, () => ({ scrollToIndex: () => {}, scrollTo: () => {}, scrollBy: () => {} }));
    const items = props.data ?? [];
    return (
      <div data-testid="virtuoso-mock">
        {items.map((item, i) => (
          <div key={props.computeItemKey?.(i, item) ?? i} data-testid="virtuoso-item">
            {props.itemContent(i, item)}
          </div>
        ))}
      </div>
    );
  });
  return { Virtuoso };
});

// -- engine fake (CallSlot.test's shape — idle snapshot is all these need) -----
function fakeEngine(overrides: Partial<CallEngineSnapshot> = {}): CallEngine {
  const listeners = new Set<() => void>();
  const speaking = new Set<string>();
  const snapshot: CallEngineSnapshot = {
    voice: initialVoiceState(),
    channelId: null,
    muted: false,
    deafened: false,
    listenOnly: false,
    publishing: { camera: false, screen: false, screen_audio: false },
    localVideoRev: 0,
    ...overrides,
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
    retryMic: vi.fn(),
    pollConnectionState: vi.fn(),
    destroy: vi.fn(),
  } as never;
}

// -- fixtures -------------------------------------------------------------------

function participant(id: string) {
  return { user_id: id, mute: false, deafen: false, leg: `L-${id}` };
}

function liveCall(): LiveCall {
  return {
    call_id: CALL_ID,
    thread_id: null,
    started_by: PEER,
    started_at: '2026-09-06T12:00:00Z',
    participants: Object.fromEntries([participant(PEER)].map((p) => [p.user_id, p])),
  };
}

function makeStore(opts: { mediaEnabled?: boolean; live?: boolean } = {}): StateStore {
  const store = createStateStore();
  store.setState((s) => ({
    ...s,
    currentUser: { id: ME, username: 'me' },
    mediaEnabled: opts.mediaEnabled ?? true,
    callByChannel: opts.live ? { [CHANNEL]: liveCall() } : {},
  }));
  return store;
}

/** The UseMessages test double (MessagePane.test's shape). */
function makeMessages(store: StateStore): UseMessages {
  return {
    messages: (channelId: string) => store.getState().messagesByChannel[channelId]?.items ?? [],
    send: vi.fn(async () => {}),
    edit: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    toggleReaction: vi.fn(async () => {}),
    reactionError: () => null,
    clearReactionError: () => {},
    currentUserId: () => ME,
  };
}

beforeEach(() => {
  // The messages page fetch never resolves — the pane renders its loading
  // state while the HEADER (the surface under test) is fully present.
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  setCallEngineForTests(fakeEngine());
});

afterEach(() => {
  cleanup();
  setCallEngineForTests(null);
  defaultStore.setState({ mediaEnabled: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// -- MessagePane header ------------------------------------------------------------

describe('MessagePane — media master switch (#124)', () => {
  it('default (media enabled): the Start-call affordance renders exactly as today', () => {
    const store = makeStore({ mediaEnabled: true });
    render(<MessagePane channelId={CHANNEL} store={store} messages={makeMessages(store)} />);

    expect(screen.getByTestId('header-start-call')).toBeTruthy();
    expect(screen.queryByTestId('header-call-disabled')).toBeNull();
  });

  it('media off: the honest visible-disabled state replaces Start/Join — never a silent absence', () => {
    const store = makeStore({ mediaEnabled: false, live: true });
    render(<MessagePane channelId={CHANNEL} store={store} messages={makeMessages(store)} />);

    const disabled = screen.getByTestId('header-call-disabled');
    expect(disabled.getAttribute('title')).toBe(MEDIA_DISABLED_TITLE);
    expect(disabled.hasAttribute('disabled')).toBe(true);
    // Distinguishable from not-built AND from the permission-denied hide:
    // the affordance is present, labelled, and inert.
    expect(disabled.getAttribute('aria-label')).toBe(MEDIA_DISABLED_TITLE);
    expect(screen.queryByTestId('header-start-call')).toBeNull();
    expect(screen.queryByTestId('header-join-call')).toBeNull();

    // The live call keeps its timeline marker, but its Join is honest-disabled
    // too (the call runs out naturally; NEW joins refuse server-side).
    const marker = screen.getByTestId('timeline-call-marker');
    expect(marker).toBeTruthy();
    const join = screen.getByTestId('marker-join-call-disabled');
    expect(join.getAttribute('title')).toBe(MEDIA_DISABLED_TITLE);
    expect(join.hasAttribute('disabled')).toBe(true);
  });
});

// -- CallSlot (the sidebar standing-call slot) ---------------------------------------

describe('CallSlot — media master switch (#124)', () => {
  it('media off: the slot stays visible (the live call is not torn down) with an honest disabled join', () => {
    // CallSlot reads the module-default store (it takes no store prop).
    defaultStore.setState({ mediaEnabled: false });
    render(
      <ul>
        <CallSlot channelId={CHANNEL} roster={[participant(PEER)]} />
      </ul>,
    );

    const slot = screen.getByTestId(`call-slot-${CHANNEL}`);
    expect(slot.getAttribute('data-media-disabled')).toBe('true');
    expect(slot.getAttribute('title')).toBe(MEDIA_DISABLED_TITLE);
    expect(slot.hasAttribute('disabled')).toBe(true);
    // The roster stays readable — the call itself is still live.
    expect(screen.getAllByTestId('call-slot-avatar')).toHaveLength(1);
  });

  it('media off: a viewer holding a leg keeps the return affordance (the standing-call edge)', () => {
    defaultStore.setState({ mediaEnabled: false });
    render(
      <ul>
        <CallSlot channelId={CHANNEL} roster={[participant(ME)]} joined />
      </ul>,
    );

    const slot = screen.getByTestId(`call-slot-${CHANNEL}`);
    expect(slot.hasAttribute('disabled')).toBe(false);
    expect(slot.getAttribute('aria-label')).toBe('Return to call — 1 participant');
  });
});

// -- DmCallIndicator (the DM call surface) ---------------------------------------------

function dmStore(opts: { mediaEnabled?: boolean; ring?: boolean } = {}): StateStore {
  const store = createStateStore();
  store.setState((s) => ({
    ...s,
    currentUser: { id: ME, username: 'me' },
    mediaEnabled: opts.mediaEnabled ?? true,
    channels: {
      ...s.channels,
      [CHANNEL]: {
        id: CHANNEL,
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
      [PEER]: { id: PEER, username: 'alice', nickname: null, joined_at: '', roles: [] },
    },
    callRingByChannel: opts.ring
      ? { [CHANNEL]: { call_id: CALL_ID, from_user: PEER, rang_at: Date.now() } }
      : {},
  }));
  return store;
}

describe('DmCallIndicator — media master switch (#124)', () => {
  it('media off: the idle Call affordance renders the honest disabled state', () => {
    const store = dmStore({ mediaEnabled: false });
    render(<DmCallIndicator channelId={CHANNEL} store={store} />);

    const disabled = screen.getByTestId('dm-call-disabled');
    expect(disabled.getAttribute('title')).toBe(MEDIA_DISABLED_TITLE);
    expect(disabled.hasAttribute('disabled')).toBe(true);
    expect(screen.queryByTestId('dm-call-start')).toBeNull();
  });

  it('media off: an incoming ring renders with its Join honest-disabled', () => {
    const store = dmStore({ mediaEnabled: false, ring: true });
    store.setState({ dmCallByChannel: { [CHANNEL]: liveCall() } });
    render(<DmCallIndicator channelId={CHANNEL} store={store} />);

    expect(screen.getByTestId('dm-call-incoming')).toBeTruthy();
    const join = screen.getByTestId('dm-call-incoming-join');
    expect(join.hasAttribute('disabled')).toBe(true);
    expect(join.getAttribute('title')).toBe(MEDIA_DISABLED_TITLE);
  });

  it('default (media enabled): the idle Call affordance renders exactly as today', () => {
    const store = dmStore({ mediaEnabled: true });
    render(<DmCallIndicator channelId={CHANNEL} store={store} />);

    expect(screen.getByTestId('dm-call-start')).toBeTruthy();
    expect(screen.queryByTestId('dm-call-disabled')).toBeNull();
  });
});
