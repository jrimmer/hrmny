/**
 * @cytale/web — the shell's render-count gate and its roster selectors.
 *
 * Plan 1.1's whole point was that a gateway event the shell does not care
 * about must not re-render the 2,000-line `AuthenticatedApp`. The previous
 * fix moved the shell off a whole-store `defaultStore.subscribe(...)`, but a
 * `useSyncExternalStore(subscribe, () => store.getState())` hidden in a hook
 * the shell calls has exactly the same effect — and three of them lived in
 * the shell's body (`useInbox`, `useThreads`, `useChannelCallHeader`).
 *
 * These tests pin the property at the component boundary rather than at the
 * hook seam, because the hook-seam tests in `useShellStore.test.tsx` write
 * ONLY `messagesByChannel` — a property production traffic does not have —
 * and so could not see the shell still re-rendering for real dispatches.
 *
 * ## How the render count is taken
 *
 * `useSettingsRoute` is called exactly once per `AuthenticatedApp` render and
 * by no other mounted component, so wrapping it in a counter is a faithful
 * count of the shell's own renders (a `Profiler` around the tree would also
 * count descendant commits, which is not the property under test).
 *
 * Red-before-green evidence for this file (both captured against the working
 * tree with only the named line reverted):
 *
 *   1. shell body restored to the old whole-store subscription
 *        `useEffect(() => defaultStore.subscribe(() => setStore(defaultStore.getState())), [])`
 *      → "does not re-render for a thread reply in a channel it is not
 *        showing" FAILS: expected 5 to be 0 (see the report).
 *   2. shell body restored to call `useChannelCallHeader(defaultStore,
 *        activeChannelId)` directly → same test FAILS the same way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import React from 'react';

import {
  applyGatewayEvent,
  createStateStore,
  defaultStore,
  nextSyntheticSeq,
  type StateState,
} from '@cytale/state';

import { useStableChannelList } from '../../AuthenticatedApp.js';

/**
 * Executions of `AuthenticatedApp`'s body. Incremented by the
 * `useSettingsRoute` wrapper below; reset per test.
 */
let shellRenders = 0;

vi.mock('../../features/settings/router.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../features/settings/router.js')>();
  return {
    ...actual,
    useSettingsRoute: (...args: Parameters<typeof actual.useSettingsRoute>) => {
      shellRenders += 1;
      return actual.useSettingsRoute(...args);
    },
  };
});

// jsdom has no layout; the list mock renders every row so the pane settles.
vi.mock('react-virtuoso', () => ({
  Virtuoso: React.forwardRef(function VirtuosoMock(
    props: {
      data?: readonly unknown[];
      itemContent: (index: number, data: unknown) => React.ReactNode;
      computeItemKey?: (index: number, data: unknown) => string;
    },
    ref: React.Ref<unknown>,
  ) {
    React.useImperativeHandle(ref, () => ({
      scrollToIndex: () => undefined,
      scrollTo: () => undefined,
      scrollBy: () => undefined,
    }));
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
  }),
}));

import { AuthenticatedApp } from '../../AuthenticatedApp.js';
import { authStore } from '../../features/auth/session.js';

const WS = '1001';
const CHANNEL = '2002';
const OTHER_CHANNEL = '2003';
const DM = '2004';
const THREAD = '4004';
const ME = '7000000000000001';
const PEER = '7000000000000002';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
  } as unknown as Response;
}

/** The shell's boot fetches, all answered with valid-but-empty bodies. */
function installFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (/\/channels\/([^/]+)\/messages(?:\?([^#]*))?$/.test(url)) {
        return jsonResponse(200, { messages: [], oldest_id: null });
      }
      if (/\/people(\?|$)/.test(url) || /\/members(\?|$)/.test(url)) {
        return jsonResponse(200, { people: [], next_before: null });
      }
      if (/\/users\/@me\/inbox/.test(url)) {
        return jsonResponse(200, { items: [], oldest_id: null });
      }
      return jsonResponse(200, {});
    }),
  );
}

function seedStore(): void {
  authStore.setState({ status: 'authenticated', emailVerified: true } as never);
  defaultStore.setState({
    currentUser: { id: ME, username: 'me', email: 'me@example.com', avatar_url: null } as never,
    sessionStatus: 'ready',
    workspaces: {
      [WS]: {
        id: WS,
        name: 'Workspace',
        icon_url: null,
        description: null,
        owner_id: ME,
        role_version: 0,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    } as never,
    channels: {
      [CHANNEL]: {
        id: CHANNEL,
        workspace_id: WS,
        name: 'general',
        type: 'text',
        topic: null,
        position: 0,
        last_message_id: null,
        created_at: '2026-01-01T00:00:00.000Z',
      },
      [OTHER_CHANNEL]: {
        id: OTHER_CHANNEL,
        workspace_id: WS,
        name: 'elsewhere',
        type: 'text',
        topic: null,
        position: 1,
        last_message_id: null,
        created_at: '2026-01-01T00:00:00.000Z',
      },
      [DM]: {
        id: DM,
        workspace_id: null,
        name: null,
        type: 'dm',
        topic: null,
        position: 0,
        last_message_id: null,
        recipients: [{ id: PEER, username: 'peer' }],
        created_at: '2026-01-01T00:00:00.000Z',
      },
    } as never,
    threadsById: {
      [THREAD]: {
        id: THREAD,
        channel_id: OTHER_CHANNEL,
        parent_message_id: '3001',
        name: 'a thread',
        created_at: '2026-01-01T00:00:00.000Z',
        member_state: null,
      },
    } as never,
    threadIdsByChannel: { [OTHER_CHANNEL]: [THREAD] } as never,
    messagesByChannel: {} as never,
    messagesByThread: {} as never,
    unreadByChannel: {} as never,
    membersById: {} as never,
  });
}

/** A thread reply in `OTHER_CHANNEL` — a channel the shell is NOT showing. */
function dispatchThreadReply(): void {
  applyGatewayEvent(defaultStore, {
    op: 0,
    s: nextSyntheticSeq(),
    t: 'ThreadMessageCreate',
    d: {
      id: '5001',
      thread_id: THREAD,
      channel_id: OTHER_CHANNEL,
      author_id: PEER,
      content: 'thread reply',
      created_at: '2026-09-20T10:00:00.000Z',
      edited_at: null,
    },
  } as never);
}

/** Mount the shell and let its boot REST settle; the shell is on CHANNEL. */
async function mountShell(): Promise<void> {
  render(<AuthenticatedApp />);
  await waitFor(() => expect(screen.getByTestId('channel-header-name')).toBeTruthy());
  // The boot fetches (roster, threads, inbox) resolve a tick later; flushing
  // them here keeps their state updates out of the measured window.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

beforeEach(() => {
  shellRenders = 0;
  globalThis.history.replaceState(null, '', '/');
  globalThis.location.hash = '';
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  globalThis.location.hash = '';
});

describe('the shell does not re-render for traffic it does not read (plan 1.1)', () => {
  it('ignores a thread reply in a channel it is not showing, while the slice updates', async () => {
    seedStore();
    installFetch();
    await mountShell();

    const before = shellRenders;
    act(dispatchThreadReply);

    // The event landed in the store's thread slice...
    expect(defaultStore.getState().messagesByThread[THREAD]?.items[0]?.id).toBe('5001');
    // ...and the shell did not render for it. OLD CODE (whole-store
    // subscription, in the shell body or in useChannelCallHeader) renders
    // here, which is exactly what this assertion catches.
    expect(shellRenders).toBe(before);
  });

  it('ignores reconcile bookkeeping', async () => {
    seedStore();
    installFetch();
    await mountShell();

    const before = shellRenders;
    act(() => {
      defaultStore.setState((s) => ({ lastSeq: s.lastSeq + 1 }));
    });

    expect(shellRenders).toBe(before);
  });

  it('DOES render for a slice it reads — the counter is live', async () => {
    seedStore();
    installFetch();
    await mountShell();

    const before = shellRenders;
    act(() => {
      defaultStore.setState((s) => ({
        channels: {
          ...s.channels,
          [OTHER_CHANNEL]: { ...s.channels[OTHER_CHANNEL]!, name: 'renamed' },
        },
      }));
    });

    // A gate that could never fire would pass the tests around it; this is
    // the control that proves the subscription is real.
    expect(shellRenders).toBeGreaterThan(before);
  });

  it('ignores unread, presence and typing traffic — while the badges still move (lane D #17)', async () => {
    seedStore();
    installFetch();
    await mountShell();

    const before = shellRenders;
    act(() => {
      // A live message in a channel the shell is not showing: recency +
      // unread accrual (the storm `useShellStore` could not filter before).
      applyGatewayEvent(defaultStore, {
        op: 0,
        s: nextSyntheticSeq(),
        t: 'MessageCreate',
        d: {
          id: '6001',
          channel_id: OTHER_CHANNEL,
          thread_id: null,
          author_id: PEER,
          content: 'elsewhere',
          created_at: '2026-09-20T10:00:00.000Z',
          edited_at: null,
        },
      } as never);
      applyGatewayEvent(defaultStore, {
        op: 0,
        s: nextSyntheticSeq(),
        t: 'PresenceUpdate',
        d: { user_id: PEER, status: 'online', last_seen_at: '2026-09-20T10:00:00.000Z' },
      } as never);
      applyGatewayEvent(defaultStore, {
        op: 0,
        s: nextSyntheticSeq(),
        t: 'TypingStart',
        d: { channel_id: CHANNEL, user_id: PEER, timestamp: 1 },
      } as never);
    });

    expect(shellRenders).toBe(before);
    // …and the sidebar row, which subscribes itself, shows the new badge.
    await waitFor(() =>
      expect(screen.getByTestId(`channel-${OTHER_CHANNEL}`).getAttribute('data-unread')).toBe('true'),
    );
  });
});

describe('boot: never Home-then-jump (lane D #3)', () => {
  it('with no roster yet, starts on the remembered channel — not Home', async () => {
    installFetch();
    // A cold store: nothing known yet (READY has not landed).
    defaultStore.setState({
      currentUser: { id: ME, username: 'me' } as never,
      sessionStatus: 'fresh',
      rosterSource: 'none',
      workspaces: {},
      channels: {},
    });
    authStore.setState({
      status: 'authenticated',
      emailVerified: true,
      currentUser: { id: ME, username: 'me', email: null, email_verified_at: null },
    } as never);
    localStorage.setItem(
      `cytale.last-location.${ME}`,
      JSON.stringify({ home: false, workspaceId: WS, channelId: CHANNEL }),
    );

    render(<AuthenticatedApp />);
    // The first frame is NOT the Home dashboard…
    expect(screen.queryByTestId('home-dashboard')).toBeNull();

    // …and when the roster lands, the remembered channel is the one open.
    act(() => {
      seedStore();
      defaultStore.setState({ rosterSource: 'server' });
    });
    await waitFor(() => expect(screen.getByTestId('channel-header-name').textContent).toMatch(/general/));
    expect(screen.queryByTestId('home-dashboard')).toBeNull();
    localStorage.clear();
  });
});

describe('the roster lists are selector-backed, not serialization keys (plan 7.3)', () => {
  /** True for a `JSON.stringify` of a roster: `[[id, name], …]`. */
  function isRosterSerialization(value: unknown): boolean {
    return (
      Array.isArray(value) &&
      value.length > 0 &&
      value.every(
        (entry) =>
          Array.isArray(entry) &&
          entry.length === 2 &&
          typeof entry[0] === 'string' &&
          typeof entry[1] === 'string',
      )
    );
  }

  it('never serializes the channel roster during render', async () => {
    const stringify = vi.spyOn(JSON, 'stringify');
    seedStore();
    installFetch();
    await mountShell();

    // A gated write re-renders the shell; on the old code that render
    // re-serialized `workspaceChannelsKey` and `integrationChannelsKey`.
    act(() => {
      defaultStore.setState((s) => ({
        presenceByUser: {
          ...s.presenceByUser,
          [PEER]: { status: 'online', last_seen_at: '2026-09-20T10:00:00.000Z' },
        },
      }));
    });

    const rosterSerializations = stringify.mock.calls.filter(([value]) =>
      isRosterSerialization(value),
    );
    expect(rosterSerializations).toHaveLength(0);
  });

  it('keeps the derived list identity while its elements are equal, and moves it when they are not', () => {
    const store = createStateStore();
    store.setState({
      channels: {
        [CHANNEL]: { id: CHANNEL, workspace_id: WS, name: 'general', type: 'text' },
        [DM]: { id: DM, workspace_id: null, name: null, type: 'dm' },
      } as never,
    });

    // Identity-stable selector parts, exactly as the shell passes them: a fresh
    // closure per render would lose the hook's skip-the-selector fast path.
    const channelSlice = (s: StateState) => s.channels;
    const workspaceRows = (s: StateState) =>
      Object.values(s.channels).filter((c) => c.workspace_id !== null);
    const sameRow = <T,>(a: T, b: T) => a === b;

    const { result } = renderHook(() =>
      useStableChannelList(store, channelSlice, workspaceRows, sameRow),
    );
    const first = result.current;
    expect(first.map((c) => c.id)).toEqual([CHANNEL]);

    // An unrelated slice write leaves the reference alone.
    act(() => store.setState((s) => ({ lastSeq: s.lastSeq + 1 })));
    expect(result.current).toBe(first);

    // `channels` re-identified by a write that does NOT touch this roster
    // (a DM's recipients) — the exact churn the serialization key existed to
    // absorb — also leaves the reference alone.
    act(() =>
      store.setState((s) => ({
        channels: {
          ...s.channels,
          [DM]: { ...s.channels[DM]!, recipients: [{ id: PEER, username: 'peer' }] },
        } as never,
      })),
    );
    expect(result.current).toBe(first);

    // A rename DOES move it, and the new value is visible.
    act(() =>
      store.setState((s) => ({
        channels: {
          ...s.channels,
          [CHANNEL]: { ...s.channels[CHANNEL]!, name: 'renamed' },
        } as never,
      })),
    );
    expect(result.current).not.toBe(first);
    expect(result.current[0]?.name).toBe('renamed');
  });

  it('does not run the selector at all for a write it cannot read', () => {
    // The reason the hook takes a `source`: the shell's two lists were rebuilt
    // on EVERY store notification — including the `lastSeq` write each gateway
    // dispatch makes, which `SHELL_SLICE_KEYS` deliberately filters — so the
    // selector now runs only when the slice it reads is re-identified. A gate
    // that only checked `result.current` identity would pass on the old code
    // too (the equality check kept identity); this counts the selector itself.
    const store = createStateStore();
    store.setState({
      channels: {
        [CHANNEL]: { id: CHANNEL, workspace_id: WS, name: 'general', type: 'text' },
        [DM]: { id: DM, workspace_id: null, name: null, type: 'dm' },
      } as never,
    });

    let selectorRuns = 0;
    const channelSlice = (s: StateState) => s.channels;
    const counted = (s: StateState) => {
      selectorRuns += 1;
      return Object.values(s.channels).filter((c) => c.workspace_id !== null);
    };
    const sameRow = <T,>(a: T, b: T) => a === b;

    const { result } = renderHook(() =>
      useStableChannelList(store, channelSlice, counted, sameRow),
    );
    const first = result.current;
    const afterMount = selectorRuns;
    expect(afterMount).toBeGreaterThan(0);

    act(() => store.setState((s) => ({ lastSeq: s.lastSeq + 1 })));
    expect(selectorRuns).toBe(afterMount);
    expect(result.current).toBe(first);

    // The control: a write that DOES touch the roster re-runs it, so the gate
    // above cannot pass by the selector never running again.
    act(() =>
      store.setState((s) => ({
        channels: { ...s.channels, [CHANNEL]: { ...s.channels[CHANNEL]!, name: 'renamed' } } as never,
      })),
    );
    expect(selectorRuns).toBeGreaterThan(afterMount);
  });
});
