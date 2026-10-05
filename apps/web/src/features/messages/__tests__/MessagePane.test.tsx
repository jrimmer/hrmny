/**
 * @cytale/web — MessagePane tests (U21 slice 3).
 *
 * Assembles MessageList + MessageCompose for the active channel and owns the
 * states-first DoD: loading / empty / error+retry / offline / view-only /
 * permission-denied / no-channel. Gateway events are applied to the store by
 * the auth session's onAny hook, so the pane reads the store through
 * MessageList — tests drive the store directly to simulate them.
 *
 * react-virtuoso is mocked (jsdom has no layout) to render items in order and
 * expose startReached; the fetch mock serves paginated history.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import type { AxeMatchers } from 'vitest-axe/matchers';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

declare module 'vitest' {
  interface Assertion<T> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}

import type { Message } from '@cytale/domain';
import { createStateStore, mergeChannelMessages, type LiveCall, type StateStore } from '@cytale/state';

import { applyGatewayEvent } from '@cytale/state';
import type { GatewayEvent } from '@cytale/protocol';
import { setCallEngineForTests, type CallEngine } from '../../calls/useCallMedia.js';

import { authStore, api } from '../../auth/session.js';
import { MessagePane } from '../MessagePane.js';
import { revealMessageActions } from '../../../test/revealActions.js';
import type { UseMessages } from '../useMessages.js';

const CHANNEL = '9007199254740993';
const ME = '7000000000000002';

// -- Virtuoso mock (same contract as MessageList.test) ------------------------
let startReachedCb: (() => void) | null = null;
interface ScrollToIndexCall {
  index: number;
  align?: string;
}
/** Every landing the list issued (the #104 boundary jump is one of these). */
const scrollToIndexCalls: ScrollToIndexCall[] = [];
vi.mock('react-virtuoso', async () => {
  const React = await import('react');
  const Virtuoso = React.forwardRef(function Virtuoso(
    props: {
      data?: readonly unknown[];
      itemContent: (index: number, data: unknown) => React.ReactNode;
      computeItemKey?: (index: number, data: unknown) => string;
      startReached?: () => void;
    },
    ref: React.Ref<unknown>,
  ) {
    React.useImperativeHandle(ref, () => ({
      scrollToIndex: (params: ScrollToIndexCall) => {
        scrollToIndexCalls.push(params);
      },
      scrollTo: () => {},
      scrollBy: () => {},
    }));
    startReachedCb = props.startReached ?? null;
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

// -- fetch mock ---------------------------------------------------------------
const ALL_MESSAGES: Message[] = Array.from({ length: 60 }, (_, i) => {
  const id = String(1000000000000000 + i);
  return {
    id,
    channel_id: CHANNEL,
    thread_id: null,
    author_id: ME,
    content: `message ${i}`,
    created_at: `2026-08-30T12:00:${String(i % 60).padStart(2, '0')}Z`,
    edited_at: null,
  };
});
const NEWEST_FIRST = [...ALL_MESSAGES].reverse();

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
  } as unknown as Response;
}

function installFetch(empty = false): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const m = /\/channels\/[^/]+\/messages(?:\?([^#]*))?$/.exec(url);
      if (!m) return jsonResponse(404, { error: { key: 'not_found', code: 40404, message: 'no route' } });
      const params = new URLSearchParams(m[1] ?? '');
      const before = params.get('before');
      const limit = Number(params.get('limit') ?? 50);
      let page: Message[];
      if (empty) {
        page = [];
      } else if (!before) {
        page = NEWEST_FIRST.slice(0, limit);
      } else {
        const idx = NEWEST_FIRST.findIndex((msg) => msg.id === before);
        page = idx >= 0 ? NEWEST_FIRST.slice(idx + 1, idx + 1 + limit) : [];
      }
      const oldest = page.length > 0 ? page[page.length - 1]!.id : null;
      return jsonResponse(200, {
        items: page,
        cursor: { before: oldest, after: page[0]?.id ?? null, limit },
      });
    }),
  );
}

function makeStore(): StateStore {
  const store = createStateStore();
  store.setState({ currentUser: { id: ME, username: 'me' } });
  return store;
}

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
  startReachedCb = null;
  scrollToIndexCalls.length = 0;
  installFetch();
  authStore.getState().reset();
  authStore.getState().setStatus('authenticated');
  authStore.getState().setVerified(true);
  authStore.getState().setUser({
    id: ME,
    username: 'me',
    email: 'me@example.com',
    email_verified_at: '2026-08-30T00:00:00Z',
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});


describe('MessagePane — drag-drop upload wiring (#47)', () => {
  it('a file drag shows the overlay; drop stages the upload through the composer', async () => {
    const upload = vi.spyOn(api, 'uploadChannelAttachment').mockResolvedValue({ filename: 'cat.png', content_type: 'image/png', size: 4, url: '/api/v1/attachments/x' });
    const store = makeStore();
    render(<MessagePane channelId={CHANNEL} store={store} messages={makeMessages(store)} />);
    await waitFor(() => expect(screen.getByTestId('message-pane')).toBeTruthy());

    const pane = screen.getByTestId('message-pane');
    fireEvent.dragEnter(pane, { dataTransfer: { types: ['Files'] } });
    expect(screen.getByTestId('pane-drop-overlay')).toBeTruthy();

    const file = new File(['bits'], 'cat.png', { type: 'image/png' });
    fireEvent.drop(pane, { dataTransfer: { types: ['Files'], files: [file] } });
    expect(screen.queryByTestId('pane-drop-overlay')).toBeNull();

    await waitFor(() => expect(upload).toHaveBeenCalledWith(CHANNEL, file));
    expect(screen.getByTestId('attachment-tray')).toBeTruthy();
    upload.mockRestore();
  });

  it('a non-file drag (text selection) never trips the overlay', () => {
    const store = makeStore();
    render(<MessagePane channelId={CHANNEL} store={store} messages={makeMessages(store)} />);
    const pane = screen.getByTestId('message-pane');
    fireEvent.dragEnter(pane, { dataTransfer: { types: ['text/plain'] } });
    expect(screen.queryByTestId('pane-drop-overlay')).toBeNull();
  });
});

describe('MessagePane — states', () => {
  it('no channel selected renders the empty shell state', () => {
    const store = makeStore();
    render(<MessagePane channelId={null} store={store} messages={makeMessages(store)} />);
    expect(screen.getByTestId('no-channel-selected')).toBeTruthy();
  });

  it('shows loading then the newest 50 messages on open', async () => {
    const store = makeStore();
    render(<MessagePane channelId={CHANNEL} store={store} messages={makeMessages(store)} />);

    // Loading state is announced while the fetch is in flight.
    expect(screen.getByTestId('pane-loading')).toBeTruthy();

    await waitFor(() => {
      expect(store.getState().messagesByChannel[CHANNEL]?.items).toHaveLength(50);
    });
    expect(screen.queryByTestId('pane-loading')).toBeNull();
    expect(screen.queryByTestId('pane-empty')).toBeNull();
  });

  // STALE-WHILE-REVALIDATE (user direction 2026-09-11, after "switching
  // between channels the entire screen's gray... jarring"): a channel whose
  // messages are already in the store renders them at once and refreshes
  // underneath — no loading placeholder, because the pane answers that state
  // with a full-area placeholder and the conversation appeared to vanish on
  // every switch, including back to a channel just loaded.
  it('renders cached messages immediately on revisit — no loading state', async () => {
    // The fetch NEVER resolves: the render must not depend on it.
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const store = makeStore();
    // Seed the slice the way a previous visit would have left it.
    store.setState({
      messagesByChannel: {
        // A REST window (lane D #24: `oldestId` is what marks it cached).
        [CHANNEL]: {
          items: NEWEST_FIRST.slice(0, 3),
          oldestId: NEWEST_FIRST[2]!.id,
          hasCompleteHistory: false,
        },
      } as never,
    });
    render(<MessagePane channelId={CHANNEL} store={store} messages={makeMessages(store)} />);

    // The cached rows are on screen in the very first frame...
    expect(screen.queryByTestId('pane-loading')).toBeNull();
    expect(screen.getAllByTestId('message-item').length).toBeGreaterThan(0);
  });

  it('a refresh failure on a cached channel keeps the messages and says so', async () => {
    installFetch();
    const store = makeStore();
    store.setState({
      messagesByChannel: {
        // A REST window (lane D #24: `oldestId` is what marks it cached).
        [CHANNEL]: {
          items: NEWEST_FIRST.slice(0, 3),
          oldestId: NEWEST_FIRST[2]!.id,
          hasCompleteHistory: false,
        },
      } as never,
    });
    const { rerender } = render(
      <MessagePane channelId={CHANNEL} store={store} messages={makeMessages(store)} />,
    );
    expect(screen.getAllByTestId('message-item').length).toBeGreaterThan(0);

    // The refresh (and only the refresh) fails.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(500, { error: { key: 'boom', code: 50000, message: 'boom' } })),
    );
    rerender(
      <MessagePane channelId={CHANNEL} store={store} messages={makeMessages(store)} />,
    );

    await waitFor(() => expect(screen.getByTestId('list-error')).toBeTruthy());
    // …and the conversation is still there — no error slab replacing it.
    expect(screen.queryByTestId('pane-error')).toBeNull();
    expect(screen.getAllByTestId('message-item').length).toBeGreaterThan(0);
  });

  it('an empty channel shows content-shaped skeleton rows, not a text slab', async () => {
    // Hold the fetch open so the loading state is observable.
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const store = makeStore();
    render(<MessagePane channelId={CHANNEL} store={store} messages={makeMessages(store)} />);

    const loading = screen.getByTestId('pane-loading');
    expect(loading.getAttribute('role')).toBe('progressbar');
    expect(loading.getAttribute('aria-busy')).toBe('true');
    // Announced for assistive tech…
    expect(loading.textContent).toContain('Loading messages…');
    // …but drawn as placeholder rows: pulsing shapes, hidden from the tree.
    const shapes = loading.querySelectorAll('.animate-pulse');
    expect(shapes.length).toBeGreaterThanOrEqual(3);
    expect(loading.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(0);
  });

  it('renders the empty state when the channel has no messages', async () => {
    installFetch(true);
    const store = makeStore();
    render(<MessagePane channelId={CHANNEL} store={store} messages={makeMessages(store)} />);

    await waitFor(() => {
      expect(screen.getByTestId('pane-empty')).toBeTruthy();
    });
  });

  it('no state overlay carries the pane wash; error/empty stay opaque', () => {
    // The col-3 gray→black wash is a BACKGROUND layer (`.pane::before`,
    // behind content): content surfaces own their own paint and never
    // participate in it (user direction 2026-09-10, correcting an earlier
    // attempt to paint the wash onto the overlays). Error/empty are opaque —
    // the pane's own `bg-surface-emphasized` token. The LOADING state is the
    // exception by design: it renders content-shaped skeleton rows on the
    // pane's surface instead of an opaque slab, because the slab made every
    // channel switch flash an empty conversation (user direction 2026-09-11).
    const src = readFileSync(join(__dirname, '..', 'MessagePane.tsx'), 'utf8');
    expect(src).not.toContain('pane-state');
    for (const testid of ['pane-error', 'pane-empty']) {
      const at = src.indexOf(`data-testid="${testid}"`);
      expect(at, `${testid} present`).toBeGreaterThan(-1);
      const before = src.slice(Math.max(0, at - 400), at);
      const cls = before.slice(before.lastIndexOf('className='));
      expect(cls, `${testid} is opaque`).toContain('bg-surface-emphasized');
      expect(cls, `${testid} carries no wash`).not.toContain('pane-wash');
      expect(cls, `${testid} carries no gradient`).not.toContain('gradient');
    }
  });

  it('renders an error state with retry that reloads', async () => {
    const store = makeStore();
    // First fetch fails, retry succeeds.
    let fail = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (fail) {
          fail = false;
          return jsonResponse(500, { error: { key: 'server_error', code: 50001, message: 'boom' } });
        }
        const url = String(input);
        const m = /\/channels\/[^/]+\/messages(?:\?([^#]*))?$/.exec(url);
        const params = new URLSearchParams(m?.[1] ?? '');
        const before = params.get('before');
        const limit = Number(params.get('limit') ?? 50);
        const page = before ? [] : NEWEST_FIRST.slice(0, limit);
        const oldest = page.length > 0 ? page[page.length - 1]!.id : null;
        return jsonResponse(200, {
          items: page,
          cursor: { before: oldest, after: page[0]?.id ?? null, limit },
        });
      }),
    );

    render(<MessagePane channelId={CHANNEL} store={store} messages={makeMessages(store)} />);

    await waitFor(() => {
      expect(screen.getByTestId('pane-error')).toBeTruthy();
    });

    act(() => {
      screen.getByTestId('pane-retry').click();
    });

    await waitFor(() => {
      expect(store.getState().messagesByChannel[CHANNEL]?.items).toHaveLength(50);
    });
    expect(screen.queryByTestId('pane-error')).toBeNull();
  });

  it('leaves the offline indicator to the shell (one banner, not two)', () => {
    // Simulate offline: navigator.onLine = false before mount. The shell's
    // bar (AppShell `offline-banner`) owns this state; the pane used to stack
    // a second strip with the same copy under it.
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    const store = makeStore();
    render(<MessagePane channelId={CHANNEL} store={store} messages={makeMessages(store)} />);
    expect(screen.queryByTestId('pane-offline')).toBeNull();
    expect(screen.queryByText(/you are offline/i)).toBeNull();
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  });

  it('renders permission-denied replacing the pane', () => {
    const store = makeStore();
    render(
      <MessagePane
        channelId={CHANNEL}
        store={store}
        messages={makeMessages(store)}
        permissionDenied="You do not have access to this channel."
      />,
    );
    expect(screen.getByTestId('pane-permission-denied')).toBeTruthy();
    expect(screen.queryByTestId('message-compose')).toBeNull();
  });

  it('renders the view-only composer banner when the account is unverified', () => {
    authStore.getState().setVerified(false);
    const store = makeStore();
    render(<MessagePane channelId={CHANNEL} store={store} messages={makeMessages(store)} />);
    expect(screen.getByTestId('composer-banner')).toBeTruthy();
  });

  it('has no axe violations in the ready state (states-first DoD)', async () => {
    const store = makeStore();
    const { container } = render(
      <MessagePane channelId={CHANNEL} store={store} messages={makeMessages(store)} />,
    );
    await waitFor(() => {
      expect(store.getState().messagesByChannel[CHANNEL]?.items).toHaveLength(50);
    });
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('MessagePane — gateway events append', () => {
  it('a new MESSAGE_CREATE merged into the store renders in the list', async () => {
    const store = makeStore();
    render(<MessagePane channelId={CHANNEL} store={store} messages={makeMessages(store)} />);

    await waitFor(() => {
      expect(store.getState().messagesByChannel[CHANNEL]?.items).toHaveLength(50);
    });

    const newest: Message = {
      id: '1000000000000060',
      channel_id: CHANNEL,
      thread_id: null,
      author_id: ME,
      content: 'from gateway',
      created_at: '2026-08-30T12:01:00Z',
      edited_at: null,
    };
    act(() => {
      mergeChannelMessages(store, CHANNEL, [newest]);
    });

    await waitFor(() => {
      const items = store.getState().messagesByChannel[CHANNEL]!.items;
      expect(items).toHaveLength(51);
      expect(items[0]!.id).toBe('1000000000000060');
    });
  });
});

// ---------------------------------------------------------------------------
// Calls plan U7 — channel header call affordances (AM17/AM18)
// ---------------------------------------------------------------------------

function makeLiveCall(participantIds: string[]): LiveCall {
  return {
    call_id: '5000000000000001',
    thread_id: null,
    started_by: participantIds[0] ?? null,
    started_at: '2026-09-06T12:00:00Z',
    participants: Object.fromEntries(
      participantIds.map((id) => [id, { user_id: id, mute: false, deafen: false, leg: null }]),
    ),
  };
}

describe('MessagePane — timeline live-call marker (calls plan U9, R5)', () => {
  it('renders the marker while a call is live: starter, count, and Join; idle renders none', async () => {
    const onJoinCall = vi.fn();
    const store = makeStore();
    store.setState({
      membersById: {
        [ME]: { id: ME, username: 'me', nickname: null, joined_at: '', roles: [] },
        ['7000000000000009']: {
          id: '7000000000000009',
          username: 'river',
          nickname: null,
          joined_at: '',
          roles: [],
        },
      },
    });
    render(
      <MessagePane
        channelId={CHANNEL}
        store={store}
        messages={makeMessages(store)}
        onJoinCall={onJoinCall}
      />,
    );

    // Idle: no marker (R3's no-slot-when-idle reading for the timeline).
    await waitFor(() => {
      expect(store.getState().messagesByChannel[CHANNEL]?.items).toHaveLength(50);
    });
    expect(screen.queryByTestId('timeline-call-marker')).toBeNull();

    // A live call lands (river started it; two participants).
    act(() => {
      store.setState({
        callByChannel: {
          [CHANNEL]: makeLiveCall(['7000000000000009', ME]),
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('timeline-call-marker')).toBeTruthy();
    });
    expect(screen.getByTestId('timeline-call-marker').textContent).toContain('started by river');
    expect(screen.getByTestId('timeline-call-marker').textContent).toContain('2 people in call');

    await userEvent.click(screen.getByTestId('marker-join-call'));
    expect(onJoinCall).toHaveBeenCalledTimes(1);

    // CALL_END clears the slice — the marker disappears with no dead row.
    act(() => {
      store.setState({ callByChannel: {} });
    });
    await waitFor(() => {
      expect(screen.queryByTestId('timeline-call-marker')).toBeNull();
    });
  });

  it('the marker\'s Join is keyboard-operable (Enter)', async () => {
    const onJoinCall = vi.fn();
    const store = makeStore();
    render(
      <MessagePane
        channelId={CHANNEL}
        store={store}
        messages={makeMessages(store)}
        onJoinCall={onJoinCall}
      />,
    );
    act(() => {
      store.setState({ callByChannel: { [CHANNEL]: makeLiveCall([ME]) } });
    });
    await waitFor(() => {
      expect(screen.getByTestId('marker-join-call')).toBeTruthy();
    });

    screen.getByTestId('marker-join-call').focus();
    await userEvent.keyboard('{Enter}');
    expect(onJoinCall).toHaveBeenCalledTimes(1);
  });

  it('axe: zero violations with the live marker row', async () => {
    const store = makeStore();
    const { container } = render(
      <MessagePane channelId={CHANNEL} store={store} messages={makeMessages(store)} />,
    );
    await waitFor(() => {
      expect(store.getState().messagesByChannel[CHANNEL]?.items).toHaveLength(50);
    });
    act(() => {
      store.setState({ callByChannel: { [CHANNEL]: makeLiveCall([ME, '7000000000000009']) } });
    });
    await waitFor(() => {
      expect(screen.getByTestId('timeline-call-marker')).toBeTruthy();
    });
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('MessagePane — channel header call affordances', () => {
  it('idle + permitted: Start call button, options caret, and Call log render; start fires silent intent', async () => {
    const onStartCall = vi.fn();
    const store = makeStore();
    render(
      <MessagePane
        channelId={CHANNEL}
        store={store}
        messages={makeMessages(store)}
        canStartCall
        onStartCall={onStartCall}
      />,
    );

    const start = screen.getByTestId('header-start-call');
    expect(start.getAttribute('aria-label')).toBe('Start call');
    expect(screen.getByTestId('header-start-call-options')).toBeTruthy();
    // Unwired hosts hide the header Call log affordance (the rail owns it).
    expect(screen.queryByTestId('header-call-log')).toBeNull();

    await userEvent.click(start);
    expect(onStartCall).toHaveBeenCalledWith({ ring: false });
  });

  it('"Start and ring" rides the options menu (pointer path)', async () => {
    const onStartCall = vi.fn();
    const store = makeStore();
    render(
      <MessagePane
        channelId={CHANNEL}
        store={store}
        messages={makeMessages(store)}
        canStartCall
        onStartCall={onStartCall}
      />,
    );

    await userEvent.click(screen.getByTestId('header-start-call-options'));
    const menu = screen.getByTestId('start-call-menu');
    expect(menu.getAttribute('role')).toBe('menu');
    expect(screen.getByTestId('start-call-menu-silent').textContent).toContain('Start call');
    expect(screen.getByTestId('start-call-menu-ring').textContent).toContain('Start and ring');

    await userEvent.click(screen.getByTestId('start-call-menu-ring'));
    expect(onStartCall).toHaveBeenCalledWith({ ring: true });
    // Choosing closes the menu.
    expect(screen.queryByTestId('start-call-menu')).toBeNull();
  });

  it('the options menu is fully keyboard-operable and Escape restores focus', async () => {
    const onStartCall = vi.fn();
    const store = makeStore();
    render(
      <MessagePane
        channelId={CHANNEL}
        store={store}
        messages={makeMessages(store)}
        canStartCall
        onStartCall={onStartCall}
      />,
    );

    const trigger = screen.getByTestId('header-start-call-options');
    trigger.focus();
    await userEvent.keyboard('{Enter}'); // open
    expect(screen.getByTestId('start-call-menu')).toBeTruthy();

    // ArrowDown to "Start and ring", Enter to activate.
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('{Enter}');
    expect(onStartCall).toHaveBeenCalledWith({ ring: true });

    // Reopen, then Escape closes and returns focus to the trigger.
    await userEvent.click(trigger);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('start-call-menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('flips to Join when the call goes live in the channel (store-driven)', async () => {
    const onJoinCall = vi.fn();
    const onStartCall = vi.fn();
    const store = makeStore();
    render(
      <MessagePane
        channelId={CHANNEL}
        store={store}
        messages={makeMessages(store)}
        canStartCall
        onStartCall={onStartCall}
        onJoinCall={onJoinCall}
      />,
    );
    expect(screen.getByTestId('header-start-call')).toBeTruthy();

    // A live call lands in the U6 call slice (CALL_START/CALL_UPDATE path).
    act(() => {
      store.setState({ callByChannel: { [CHANNEL]: makeLiveCall([ME, '7000000000000009']) } });
    });

    await waitFor(() => {
      expect(screen.getByTestId('header-join-call')).toBeTruthy();
    });
    expect(screen.queryByTestId('header-start-call')).toBeNull();
    expect(screen.queryByTestId('header-start-call-options')).toBeNull();

    await userEvent.click(screen.getByTestId('header-join-call'));
    expect(onJoinCall).toHaveBeenCalledTimes(1);
    expect(onStartCall).not.toHaveBeenCalled();
  });

  it('permission-hidden: no phone affordance without START_CALL, Call log stays available', () => {
    const store = makeStore();
    render(
      <MessagePane
        channelId={CHANNEL}
        store={store}
        messages={makeMessages(store)}
        canStartCall={false}
      />,
    );

    expect(screen.queryByTestId('header-start-call')).toBeNull();
    expect(screen.queryByTestId('header-start-call-options')).toBeNull();
    expect(screen.queryByTestId('header-join-call')).toBeNull();
    // The Call log entry lives in the rail now; a wired host renders it.
    expect(screen.queryByTestId('header-call-log')).toBeNull();
  });

  it('Call log click fires the U9 seam callback when wired; hidden when not', async () => {
    const onOpenCallLog = vi.fn();
    const store = makeStore();
    const wired = render(
      <MessagePane
        channelId={CHANNEL}
        store={store}
        messages={makeMessages(store)}
        onOpenCallLog={onOpenCallLog}
      />,
    );
    await userEvent.click(screen.getByTestId('header-call-log'));
    expect(onOpenCallLog).toHaveBeenCalledTimes(1);
    wired.unmount();

    // Unwired: the button is absent — the right rail's tab owns the entry.
    render(
      <MessagePane channelId={CHANNEL} store={makeStore()} messages={makeMessages(store)} />,
    );
    expect(screen.queryByTestId('header-call-log')).toBeNull();
  });

  it('has no axe violations with the header actions idle and the options menu open', async () => {
    const store = makeStore();
    const { container } = render(
      <MessagePane
        channelId={CHANNEL}
        store={store}
        messages={makeMessages(store)}
        canStartCall
      />,
    );
    await waitFor(() => {
      expect(store.getState().messagesByChannel[CHANNEL]?.items).toHaveLength(50);
    });
    expect(await axe(container)).toHaveNoViolations();

    await userEvent.click(screen.getByTestId('header-start-call-options'));
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations in the live (Join) state', async () => {
    const store = makeStore();
    store.setState({ callByChannel: { [CHANNEL]: makeLiveCall([ME]) } });
    const { container } = render(
      <MessagePane
        channelId={CHANNEL}
        store={store}
        messages={makeMessages(store)}
        canStartCall
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('header-join-call')).toBeTruthy();
    });
    expect(await axe(container)).toHaveNoViolations();
  });
});

// ---------------------------------------------------------------------------
// Calls plan U10 — the DM header surface (R11: indicator, no channel
// affordances, no timeline marker; DM text continues during a call)
// ---------------------------------------------------------------------------


const PEER = '7000000000000009';

function dmChannelStore(): StateStore {
  const store = createStateStore();
  store.setState((s) => ({
    ...s,
    currentUser: { id: ME, username: 'me' },
    channels: {
      ...s.channels,
      [CHANNEL]: {
        id: CHANNEL,
        workspace_id: null,
        recipients: [
          { id: ME, username: 'me' },
          { id: PEER, username: 'peer' },
        ],
        name: 'peer',
        type: 'dm' as const,
        topic: null,
        position: 0,
        last_message_id: null,
        created_at: '2026-08-30T00:00:00Z',
      },
    },
    membersById: {
      ...s.membersById,
      [PEER]: { id: PEER, username: 'peer', nickname: null, joined_at: '', roles: [] },
    },
  }));
  return store;
}

function dmEngineFake(): CallEngine {
  const listeners = new Set<() => void>();
  // Identity-stable speaking set (the useSyncExternalStore contract).
  const speaking = new Set<string>();
  const snapshot = {
    voice: { status: 'idle', pcConnected: false, micGranted: false, notice: null },
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

describe('MessagePane — DM header (calls plan U10)', () => {
  afterEach(() => {
    setCallEngineForTests(null);
  });

  it('renders the DM call indicator and NONE of the channel call affordances (@ sigil, no Call log)', async () => {
    setCallEngineForTests(dmEngineFake());
    const store = dmChannelStore();
    const { container } = render(
      <MessagePane channelId={CHANNEL} store={store} messages={makeMessages(store)} />,
    );
    await waitFor(() => {
      expect(store.getState().messagesByChannel[CHANNEL]?.items).toHaveLength(50);
    });

    expect(screen.getByTestId('dm-call-indicator')).toBeTruthy();
    expect(screen.getByTestId('dm-call-start')).toBeTruthy();
    expect(screen.queryByTestId('channel-header-actions')).toBeNull();
    expect(screen.queryByTestId('header-start-call')).toBeNull();
    expect(screen.queryByTestId('header-join-call')).toBeNull();
    expect(screen.queryByTestId('header-call-log')).toBeNull();
    // Discord's DM sigil.
    expect(screen.getByTestId('channel-header').getAttribute('data-dm')).toBe('true');
    expect(screen.getByTestId('channel-header-name').textContent).toContain('@');

    expect(await axe(container)).toHaveNoViolations();
  });

  it('a live DM call renders NO timeline marker; the composer and timeline keep working (same stream)', async () => {
    setCallEngineForTests(dmEngineFake());
    const store = dmChannelStore();
    // A live DM call in the DM slice — the room slice stays empty, so the
    // R5 marker must not appear (R11 negative).
    store.setState((s) => ({
      ...s,
      dmCallByChannel: {
        [CHANNEL]: {
          call_id: '99',
          thread_id: null,
          started_by: PEER,
          started_at: '2026-09-06T12:00:00Z',
          participants: {
            [PEER]: { user_id: PEER, mute: false, deafen: false, leg: 'L1' },
          },
        },
      },
      callRingByChannel: {
        [CHANNEL]: { call_id: '99', from_user: PEER, rang_at: Date.now() },
      },
    }));
    render(
      <MessagePane channelId={CHANNEL} store={store} messages={makeMessages(store)} />,
    );
    await waitFor(() => {
      expect(store.getState().messagesByChannel[CHANNEL]?.items).toHaveLength(50);
    });

    // Ringing state on the indicator; NO marker, NO log.
    expect(screen.getByTestId('dm-call-indicator').getAttribute('data-state')).toBe('ringing');
    expect(screen.queryByTestId('timeline-call-marker')).toBeNull();

    // DM text continues uninterrupted: a MESSAGE_CREATE during the call
    // lands in the same stream and the composer is present.
    expect(screen.getByTestId('message-compose')).toBeTruthy();
    applyGatewayEvent(store, {
      op: 0,
      t: 'MessageCreate',
      s: 999001,
      d: {
        id: '9990000000000001',
        channel_id: CHANNEL,
        thread_id: null,
        author_id: PEER,
        content: 'mid-call text',
        created_at: '2026-09-06T12:00:05Z',
        edited_at: null,
      },
    } as GatewayEvent);
    expect(await screen.findByText('mid-call text')).toBeTruthy();
    // The call wrote no artifact: no thread storage, no log-thread linkage.
    expect(Object.keys(store.getState().messagesByThread)).toHaveLength(0);
    expect(store.getState().callLogThreadIdByChannel[CHANNEL]).toBeUndefined();
  });

  it('the isDm prop asserts DM-ness for channels the store has not hydrated', () => {
    setCallEngineForTests(dmEngineFake());
    const store = makeStore(); // no channel record at all
    render(
      <MessagePane
        channelId={CHANNEL}
        store={store}
        messages={makeMessages(store)}
        isDm
      />,
    );
    expect(screen.getByTestId('dm-call-indicator')).toBeTruthy();
    expect(screen.queryByTestId('channel-header-actions')).toBeNull();
  });
});

describe('MessagePane — reply bar name resolution', () => {
  it('a self-reply shows the username even when the members roster never hydrated', async () => {
    const store = makeStore();
    // Roster fetch failed this session: membersById stays EMPTY, but the
    // store still knows the signed-in identity — never render a snowflake.
    store.setState((s) => ({ ...s, membersById: {} }));
    render(
      <MessagePane
        channelId={CHANNEL}
        store={store}
        messages={makeMessages(store)}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('message-pane')).toBeTruthy());

    // Click Reply on the (own) message row via the hover toolbar.
    await waitFor(() => expect(screen.getAllByTestId('message-item').length).toBeGreaterThan(0));
    revealMessageActions();
    fireEvent.click(screen.getAllByTestId('action-reply')[0]!);
    const bar = await waitFor(() => screen.getByTestId('reply-bar'));
    expect(bar.textContent).toContain('me');
    expect(bar.textContent).not.toContain(ME);
  });

  it('a DM reply names the peer from the channel recipients, not a snowflake (owner report 2026-09-15)', async () => {
    const store = makeStore();
    // A DM channel whose peer is an AGENT (not in any workspace roster — the
    // failing case: membersById has nothing for it).
    const PEER = '92725293357203456';
    const DM_CH = '910000000070';
    store.setState((s) => ({
      ...s,
      membersById: {},
      channels: {
        ...s.channels,
        [DM_CH]: {
          ...s.channels[CHANNEL]!,
          id: DM_CH,
          workspace_id: null,
          type: 'dm' as const,
          recipients: [{ id: PEER, username: 'max' }],
        },
      },
    }));
    const dmRows = NEWEST_FIRST.slice(0, 2).map((m, i) => ({
      ...m,
      id: `${91000000110 + i}`,
      channel_id: DM_CH,
      author_id: PEER,
      // A mention token in the previewed content: the bar must show the NAME,
      // never the raw <@snowflake>.
      content: `agent says <@${ME}> thing ${i}`,
      thread_id: null,
    }));
    store.setState((s) => ({
      ...s,
      messagesByChannel: {
        ...s.messagesByChannel,
        [DM_CH]: { items: dmRows, oldestId: dmRows[dmRows.length - 1]!.id, hasCompleteHistory: false },
      } as never,
    }));
    // The shared fetch mock answers EVERY channel with CHANNEL's rows; a
    // newest page that does not overlap the cached window now REPLACES it
    // (lane D #23), so this DM's refresh must answer as the DM would: nothing new.
    installFetch(true);
    render(
      <MessagePane channelId={DM_CH} store={store} messages={makeMessages(store)} />,
    );
    await waitFor(() => expect(screen.getByTestId('message-pane')).toBeTruthy());

    await waitFor(() => expect(screen.getAllByTestId('message-item').length).toBeGreaterThan(0));
    revealMessageActions();
    fireEvent.click(screen.getAllByTestId('action-reply')[0]!);
    const bar = await waitFor(() => screen.getByTestId('reply-bar'));
    expect(bar.textContent).toContain('max');
    expect(bar.textContent).not.toContain(PEER);
    // The snippet's self-mention resolved to the username, not the token.
    expect(bar.textContent).not.toContain('<@');
    expect(bar.textContent).toContain('me');
  });
});

describe('MessagePane — unread boundary capture (#104)', () => {
  const OTHER = '7000000000000009';
  /** A channel of its own, so no other fixture's rows mix in. */
  const UNREAD_CH = '9007199254740999';

  /**
   * Eleven rows, 100 (oldest) → 110 (newest); the newest two are a
   * colleague's, and nothing but them is unread.
   */
  function seedRows(store: StateStore): void {
    mergeChannelMessages(
      store,
      UNREAD_CH,
      Array.from({ length: 11 }, (_, i) => ({
        id: String(100 + i),
        channel_id: UNREAD_CH,
        thread_id: null,
        author_id: i >= 9 ? OTHER : ME,
        content: `unread msg ${100 + i}`,
        created_at: `2026-08-30T12:00:${String(i).padStart(2, '0')}Z`,
        edited_at: null,
      })),
      { isLastPage: true },
    );
  }

  /** The unread slice the pane captures BEFORE its read-ack clears it. */
  function seedUnread(store: StateStore): void {
    store.setState({
      unreadByChannel: {
        [UNREAD_CH]: { last_read_id: '108', unread_count: 2, mention_count: 0 },
      },
    });
  }

  /** The row the NEW rule is drawn above, by its message id. */
  function ruledRowId(): string | null {
    const host = screen
      .getAllByTestId('virtuoso-item')
      .find((el) => el.querySelector('[data-testid="unread-divider"]') !== null);
    return (
      host
        ?.querySelector<HTMLElement>('[data-testid="message-item"]')
        ?.getAttribute('data-message-id') ?? null
    );
  }

  function renderPane(store: StateStore) {
    return render(
      <MessagePane channelId={UNREAD_CH} store={store} messages={makeMessages(store)} />,
    );
  }

  beforeEach(() => {
    // This channel's newest page is empty over the wire: the rows come from
    // the store, so the slice under test is the only unread state in play.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (/\/channels\/[^/]+\/messages/.test(url)) {
          return jsonResponse(200, {
            items: [],
            cursor: { before: null, after: null, limit: 50 },
          });
        }
        return jsonResponse(404, { error: { key: 'not_found', code: 40404 } });
      }),
    );
  });

  it('leaving a channel whose floored message was shown clears the floor, with the evidence ack (#54)', async () => {
    const store = makeStore();
    seedRows(store);
    store.setState({
      unreadByChannel: {
        [UNREAD_CH]: { last_read_id: '110', unread_count: 0, mention_count: 0, unread_floor: '109' },
      },
    });
    const view = renderPane(store);
    await waitFor(() => expect(ruledRowId()).toBe('109'));

    view.unmount();

    await waitFor(() => {
      const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls as [RequestInfo | URL, RequestInit?][];
      const ack = calls.find(([u, init]) => /\/channels\/[^/]+\/ack$/.test(String(u)) && init?.method === 'POST');
      expect(ack).toBeTruthy();
      expect(JSON.parse(String(ack![1]!.body))).toMatchObject({ unread_floor: null });
    });
    expect(store.getState().unreadByChannel[UNREAD_CH]!.unread_floor).toBeNull();
  });

  it('a floor the pane never loaded is left set — no evidence, no clear (#54)', async () => {
    const store = makeStore();
    seedRows(store);
    store.setState({
      unreadByChannel: {
        [UNREAD_CH]: { last_read_id: '110', unread_count: 0, mention_count: 0, unread_floor: '50' },
      },
    });
    const view = renderPane(store);
    await waitFor(() => expect(screen.getAllByTestId('virtuoso-item').length).toBeGreaterThan(0));
    view.unmount();

    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls as [RequestInfo | URL, RequestInit?][];
    expect(calls.some(([u]) => /\/ack$/.test(String(u)))).toBe(false);
    expect(store.getState().unreadByChannel[UNREAD_CH]!.unread_floor).toBe('50');
  });

  it('lands the open on the boundary captured before the ack — the ack clears the slice, the rule stays', async () => {
    const store = makeStore();
    seedRows(store);
    seedUnread(store);
    renderPane(store);

    // The pane's ack ran: nothing is unread in the store any more...
    await waitFor(() => {
      expect(store.getState().unreadByChannel[UNREAD_CH]?.unread_count).toBe(0);
    });
    // ...and the boundary it captured first is still the one on screen, with
    // the landing pointed at it (two rows of context above, at the pane top).
    await waitFor(() => {
      expect(ruledRowId()).toBe('109');
    });
    // Every landing the list issued targets the same row (it re-asserts across
    // Virtuoso's settle, exactly as the bottom pin does) — two rows of context
    // above the rule, at the top of the pane.
    expect(scrollToIndexCalls.length).toBeGreaterThan(0);
    expect(new Set(scrollToIndexCalls.map((c) => `${c.index}:${c.align}`))).toEqual(
      new Set(['7:start']),
    );
  });

  it('a fully read channel keeps the ack, draws no rule, and lands at the newest (no boundary jump)', async () => {
    const store = makeStore();
    seedRows(store);
    store.setState({
      unreadByChannel: {
        [UNREAD_CH]: { last_read_id: '110', unread_count: 0, mention_count: 0 },
      },
    });
    renderPane(store);

    await waitFor(() => {
      expect(store.getState().unreadByChannel[UNREAD_CH]?.unread_count).toBe(0);
    });
    expect(screen.queryByTestId('unread-divider')).toBeNull();
    expect(scrollToIndexCalls).toEqual([]);
  });
});

