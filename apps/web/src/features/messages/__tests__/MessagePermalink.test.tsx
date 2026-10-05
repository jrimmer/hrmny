/**
 * @cytale/web — the message permalink route (#114), end to end through the app
 * shell.
 *
 * What is under test is the whole chain a copied link travels: the HASH is
 * parsed by the shared grammar, the shell opens the workspace and channel the
 * address names (including a DM, which has no workspace and lives on Home),
 * the list lands on the row and flashes it, a thread reply opens inside its
 * thread, a message the server no longer has says so, and Copy Link writes the
 * very URL that would have brought the reader here.
 *
 * `AuthenticatedApp` is rendered rather than a slice of it because the point
 * is the ROUTE: the parse, the navigation effects and the pane have to agree,
 * and that agreement is exactly what a component-level test would stub away.
 * react-virtuoso is mocked (jsdom has no layout) with a handle that records
 * `scrollToIndex`, so the landing assertion covers the scroll call AND the
 * highlight; the store is the REAL U17 store the app reads.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, act } from '@testing-library/react';
import React from 'react';

import type { Message } from '@cytale/domain';
import { parsePermalinkPath } from '@cytale/domain';
import { applyGatewayEvent, defaultStore } from '@cytale/state';

// -- Virtuoso mock (records the landing scroll; renders every row) -----------
const scrollCalls: Array<{ index: number }> = [];

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
      scrollToIndex: (opts: { index: number }) => {
        scrollCalls.push(opts);
      },
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

import { AuthenticatedApp } from '../../../AuthenticatedApp.js';
import { api, authStore, session } from '../../auth/session.js';
import { revealMessageActions } from '../../../test/revealActions.js';
import { mintPermalinkUrl } from '../messagePermalink.js';

const WS = '1001';
const CHANNEL = '2002';
const OTHER_CHANNEL = '2003';
const DM = '2004';
const TARGET = '3003';
const REPLY = '3004';
const THREAD = '4004';
const ME = '7000000000000001';

function message(over: Partial<Message> & { id: string }): Message {
  return {
    channel_id: CHANNEL,
    thread_id: null,
    author_id: ME,
    content: `message ${over.id}`,
    created_at: '2026-08-30T12:00:00Z',
    edited_at: null,
    ...over,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
  } as unknown as Response;
}

/**
 * Serve the two message reads the pane makes (`?before=` pages and the
 * single-message resolver) from a fixed newest-first fixture, and an empty
 * object for everything else the shell fetches on mount.
 */
function installFetch(newestFirst: Message[], mint: (url: string) => Response | null = () => null): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      // #118: the Copy Link mint (`POST /permalinks`) is answered by the
      // caller-supplied `mint` — a test decides whether it succeeds, 500s, or
      // is never reached at all.
      if (/\/permalinks$/.test(url) && (init?.method ?? 'GET') === 'POST') {
        const minted = mint(url);
        if (minted !== null) return minted;
      }
      // The #118 resolve (`GET /permalinks/{token}`).
      const resolved = /\/permalinks\/([^/?]+)$/.exec(url);
      if (resolved && (init?.method ?? 'GET') === 'GET') {
        const target = resolverTargets.get(resolved[1]!);
        if (target) return jsonResponse(200, target);
        return jsonResponse(404, {
          error: { key: 'permalink_not_found', code: 40401, message: 'No such permalink' },
        });
      }
      const single = /\/channels\/([^/]+)\/messages\/([^/?]+)$/.exec(url);
      if (single) {
        const found = newestFirst.find((m) => m.id === single[2]);
        if (!found) {
          return jsonResponse(404, {
            error: { key: 'message_not_found', code: 40401, message: 'No message with that id' },
          });
        }
        return jsonResponse(200, { message: found });
      }
      const page = /\/channels\/([^/]+)\/messages(?:\?([^#]*))?$/.exec(url);
      if (page) {
        const params = new URLSearchParams(page[2] ?? '');
        const before = params.get('before');
        const forChannel = newestFirst.filter((m) => m.channel_id === page[1]);
        const start = before ? forChannel.findIndex((m) => m.id === before) + 1 : 0;
        const slice = forChannel.slice(start, start + Number(params.get('limit') ?? 50));
        return jsonResponse(200, { messages: slice, oldest_id: slice.at(-1)?.id ?? null });
      }
      // The rest of the shell fetches as it mounts (the member roster, calls,
      // threads). An empty-but-VALID body keeps those surfaces in their own
      // loaded states instead of crashing the tree this test is about.
      if (/\/people(\?|$)/.test(url) || /\/members(\?|$)/.test(url)) {
        return jsonResponse(200, { people: [], next_before: null });
      }
      return jsonResponse(200, {});
    }),
  );
}

/** Seed the shell's store with the workspace, its channels, and a message set. */
function seedStore(messages: Message[]): void {
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
        last_message_id: messages[0]?.id ?? null,
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
        recipients: [{ id: '7000000000000009', username: 'peer' }],
        created_at: '2026-01-01T00:00:00.000Z',
      },
    } as never,
    messagesByChannel: {} as never,
    threadsById: {} as never,
    threadIdsByChannel: {} as never,
    messagesByThread: {} as never,
    unreadByChannel: {} as never,
    membersById: {} as never,
  });
}

function setHash(path: string): void {
  globalThis.location.hash = path;
}

/**
 * #118 — the resolve answers `GET /permalinks/{token}` gives, per test. A real
 * token is keyed server-side and cannot be read by a client, so a test states
 * the mapping it wants rather than pretending to decode one.
 */
const resolverTargets = new Map<string, { channel_id: string; message_id: string }>();

/** A token shaped exactly like a minted one (30 base62 characters). */
const TOKEN = '3kQm9Xb2Qp7ZtR4vN8wY1cKdQ3uP';

beforeEach(() => {
  scrollCalls.length = 0;
  resolverTargets.clear();
  // jsdom keeps ONE location for the whole file, so the PATH has to be reset
  // too: the #118 landing test arrives on `/m/<token>`.
  globalThis.history.replaceState(null, '', '/');
  globalThis.location.hash = '';
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  globalThis.location.hash = '';
});


/**
 * The hover toolbar mounts on the row's first hover (#14): hover the rows the
 * way a reader's pointer does, then find the control.
 */
async function revealedAction(testId: string): Promise<HTMLElement> {
  await waitFor(() => expect(screen.getAllByTestId('message-item').length).toBeGreaterThan(0));
  revealMessageActions();
  return screen.findByTestId(testId);
}

describe('#114 — the hash route opens the message', () => {
  it('opens the channel an address names and lands on the row (scroll + flash)', async () => {
    // The address names CHANNEL; the shell's own default would otherwise
    // open OTHER_CHANNEL (the first id in the roster), which is the mistake
    // this test exists to catch.
    const newestFirst = [message({ id: '3002', content: 'newer' }), message({ id: TARGET })];
    seedStore(newestFirst);
    installFetch(newestFirst);
    setHash(`/workspace/${WS}/channel/${CHANNEL}/message/${TARGET}`);

    render(<AuthenticatedApp />);

    // The right channel is open…
    await waitFor(() =>
      expect(screen.getByTestId('channel-header-name').textContent).toContain('general'),
    );

    // …the list scrolled to the target's index (chat order is oldest-first:
    // 3002, then the target)…
    await waitFor(() => expect(scrollCalls.length).toBeGreaterThan(0));
    expect(scrollCalls[0]!.index).toBe(1);

    // …and THAT row is flashed (the visible half of "you are here"), while
    // its neighbour — the row a plain channel open would have shown at the
    // bottom — is not.
    await waitFor(() =>
      expect(document.querySelector(`[data-message-id="${TARGET}"]`)?.className).toContain(
        'message-focus-flash',
      ),
    );
    expect(document.querySelector('[data-message-id="3002"]')?.className).not.toContain(
      'message-focus-flash',
    );
  });

  it('resolves a message outside the loaded window through the REST read', async () => {
    // The store holds only the newest message; the target is older and must
    // be fetched by id (the resolver #114 wires).
    const newestFirst = [message({ id: '3002', content: 'newest' })];
    const old = message({ id: TARGET, content: 'old but real' });
    seedStore(newestFirst);
    installFetch([...newestFirst, old]);
    setHash(`/workspace/${WS}/channel/${CHANNEL}/message/${TARGET}`);

    render(<AuthenticatedApp />);

    await waitFor(() =>
      expect(document.querySelector(`[data-message-id="${TARGET}"]`)?.className).toContain(
        'message-focus-flash',
      ),
    );
    expect(document.querySelector(`[data-message-id="${TARGET}"]`)?.textContent).toContain(
      'old but real',
    );
  });

  it('says the message is gone when the resolver answers 404', async () => {
    const newestFirst = [message({ id: '3002', content: 'newest' })];
    seedStore(newestFirst);
    installFetch(newestFirst); // TARGET is not in the fixture → 404
    setHash(`/workspace/${WS}/channel/${CHANNEL}/message/${TARGET}`);

    render(<AuthenticatedApp />);

    // Honest degradation: the pane says so, and does NOT pretend the newest
    // page is what the link pointed at.
    const gone = await screen.findByTestId('message-gone');
    expect(gone.textContent).toMatch(/gone/i);
    expect(document.querySelector(`[data-message-id="${TARGET}"]`)).toBeNull();
  });

  it('opens a DM address (no workspace segment) in Home', async () => {
    const dmMessage = message({ id: TARGET, channel_id: DM });
    seedStore([dmMessage]);
    installFetch([dmMessage]);
    setHash(`/channel/${DM}/message/${TARGET}`);

    render(<AuthenticatedApp />);

    await waitFor(() =>
      expect(document.querySelector(`[data-message-id="${TARGET}"]`)).not.toBeNull(),
    );
    // Home is the surface a DM renders on…
    expect(screen.getByTestId('rail-home').getAttribute('data-active')).toBe('true');
    // …and it is still the DM pane, not a workspace channel that happens to
    // share the roster.
    expect(screen.queryByTestId('channel-header-name')?.textContent ?? '').not.toContain('general');
  });
});

describe('#114 — a thread reply opens inside its thread', () => {
  it('lands on the reply in the thread panel', async () => {
    const root = message({ id: '3002', content: 'thread root' });
    const reply = message({ id: REPLY, thread_id: THREAD, content: 'the reply in question' });
    seedStore([message({ id: '3001' }), root]);
    installFetch([root]);
    // The thread + its reply are what the panel loads (and what the store
    // already knows about, the way a live session would).
    defaultStore.setState((s) => ({
      threadsById: {
        [THREAD]: {
          id: THREAD,
          channel_id: CHANNEL,
          parent_message_id: root.id,
          name: 'thread root',
          created_by: ME,
          archived: false,
          member_state: { notify: true, last_read_id: null },
          created_at: '2026-08-30T12:00:00Z',
        },
      },
      threadsByChannelMutex: undefined,
    }) as never);
    vi.spyOn(api, 'getThreadMessages').mockResolvedValue([reply]);

    setHash(`/workspace/${WS}/channel/${CHANNEL}/thread/${THREAD}/message/${REPLY}`);
    render(<AuthenticatedApp />);

    // The dock is open…
    const panel = await screen.findByTestId('thread-replies');
    // …and the reply inside it is the flashed row (the landing target), not
    // the thread's newest reply by default.
    await waitFor(() =>
      expect(
        document.querySelector(`[data-message-id="${REPLY}"]`)?.className ?? '',
      ).toContain('message-focus-flash'),
    );
    expect(panel).toBeTruthy();
  });
});

describe('#118 — Copy Link mints an opaque link', () => {
  /** The mint stub: `POST /permalinks` answers with a token, or with a failure. */
  const mintOk = () => jsonResponse(200, { token: TOKEN, url: `https://cytale.test/m/${TOKEN}` });
  const mintFails = () =>
    jsonResponse(500, { error: { key: 'internal', code: 50001, message: 'boom' } });

  it('mints and writes the /m/<token> URL to the clipboard', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...globalThis.navigator, clipboard: { writeText } });

    const newestFirst = [message({ id: TARGET, content: 'copy me' })];
    seedStore(newestFirst);
    installFetch(newestFirst, mintOk);
    setHash(`/workspace/${WS}/channel/${CHANNEL}/message/${TARGET}`);

    render(<AuthenticatedApp />);

    const button = await revealedAction('action-copy-link');
    await act(async () => {
      button.click();
    });

    // The EXACT string a second browser opens: the origin, the page path, and
    // the token the server minted. No hash, no grammar, no ids.
    const expected = `${globalThis.location.origin}/m/${TOKEN}`;
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expected));

    expect(expected).not.toContain('#');
    expect(expected).not.toContain('channel');
    expect(expected).not.toContain(CHANNEL);
    expect(expected).not.toContain(TARGET);

    // The click made ONE round trip, and it carried the two ids the server
    // needs (the pair the old client used to spell into the URL itself).
    const posts = (globalThis.fetch as unknown as { mock: { calls: [unknown, RequestInit?][] } }).mock.calls.filter(
      ([url, init]) => /\/permalinks$/.test(String(url)) && init?.method === 'POST',
    );
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0]![1]?.body))).toEqual({
      channel_id: CHANNEL,
      message_id: TARGET,
    });

    // …and a silent copy is the bug report the ticket names, so the outcome is
    // announced.
    const notice = await screen.findByTestId('copy-link-notice');
    expect(notice.textContent).toBe('Link copied');
    expect(notice.getAttribute('role')).toBe('status');
  });

  it('reports a failed MINT as a failure, and writes nothing to the clipboard', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...globalThis.navigator, clipboard: { writeText } });

    const newestFirst = [message({ id: TARGET })];
    seedStore(newestFirst);
    installFetch(newestFirst, mintFails);
    setHash(`/workspace/${WS}/channel/${CHANNEL}/message/${TARGET}`);

    render(<AuthenticatedApp />);

    const button = await revealedAction('action-copy-link');
    await act(async () => {
      button.click();
    });

    const notice = await screen.findByTestId('copy-link-notice');
    expect(notice.textContent).toMatch(/could not copy/i);
    // Not "nothing on the clipboard silently": nothing at all, and the user
    // was told. A stale/legacy fallback URL is exactly what is NOT allowed.
    expect(writeText).not.toHaveBeenCalled();
  });

  it('reports a failed clipboard write instead of claiming success', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('denied');
    });
    vi.stubGlobal('navigator', { ...globalThis.navigator, clipboard: { writeText } });

    const newestFirst = [message({ id: TARGET })];
    seedStore(newestFirst);
    installFetch(newestFirst, mintOk);
    setHash(`/workspace/${WS}/channel/${CHANNEL}/message/${TARGET}`);

    render(<AuthenticatedApp />);

    const button = await revealedAction('action-copy-link');
    await act(async () => {
      button.click();
    });

    const notice = await screen.findByTestId('copy-link-notice');
    expect(notice.textContent).toMatch(/could not copy/i);
  });

  it('puts Copy Link in the config-driven hover toolbar, after Reply', async () => {
    const newestFirst = [message({ id: TARGET })];
    seedStore(newestFirst);
    installFetch(newestFirst);
    setHash(`/workspace/${WS}/channel/${CHANNEL}/message/${TARGET}`);

    render(<AuthenticatedApp />);

    const toolbar = await revealedAction('message-actions');
    const ids = Array.from(toolbar.querySelectorAll('[data-testid^="action-"]')).map((el) =>
      el.getAttribute('data-testid'),
    );
    // Position follows the toolbars' own configuration (DOM order; the
    // left-rail placement re-orders the same markup in CSS): Copy Link sits
    // directly after Reply, before the author/moderator controls.
    expect(ids.indexOf('action-copy-link')).toBe(ids.indexOf('action-reply') + 1);
    expect(ids.indexOf('action-copy-link')).toBeLessThan(ids.indexOf('action-edit'));
  });

  /**
   * A REPLY's token is keyed `(parent channel, message)` — the pair that makes
   * the landing resolve the reply INSIDE its thread. This pins the half that
   * would silently break it: the id the store stamps on a reply row. A reply
   * dispatched as `ThreadMessageCreate` takes its `channel_id` from the thread
   * record (`threadsById`), which is the PARENT channel — never the thread id —
   * and that is exactly what `copyLinkFor` mints with
   * (`mintPermalinkUrl(message.channel_id, message.id)`).
   *
   * (Asserted at the store/mint boundary, which is the contract every surface
   * shares: the thread PANEL wires the same `onCopyLink` seam now, and proves
   * its own click-to-mint path in ThreadSidePanel.test.tsx against a reply
   * dispatched exactly this way.)
   */
  it('a thread reply mints with its PARENT channel id, never the thread id', async () => {
    seedStore([message({ id: '3002', content: 'thread root' })]);
    installFetch([], mintOk);
    defaultStore.setState((s) => ({
      ...s,
      threadsById: {
        [THREAD]: {
          id: THREAD,
          channel_id: CHANNEL,
          parent_message_id: '3002',
          name: 'thread root',
          created_by: ME,
          archived: false,
          member_state: { notify: true, last_read_id: null },
          created_at: '2026-08-30T12:00:00Z',
        },
      },
    }) as never);

    // The store's own rule for a reply (the gateway dispatch the socket sends).
    // The sequence must land ABOVE the store's replay cursor — the store is
    // module-global, so earlier tests in this file have moved it (the
    // `nextSyntheticSeq` rule, client-side).
    const seq = defaultStore.getState().lastSeq + 1;
    applyGatewayEvent(defaultStore, {
      op: 0,
      t: 'ThreadMessageCreate',
      s: seq,
      d: {
        id: REPLY,
        channel_id: CHANNEL,
        thread_id: THREAD,
        author_id: ME,
        content: 'the reply in question',
        created_at: '2026-08-30T12:00:00Z',
        edited_at: null,
      },
    } as never);

    const row = defaultStore.getState().messagesByThread[THREAD]?.items.find((m) => m.id === REPLY);
    expect(row?.channel_id).toBe(CHANNEL);
    expect(row?.channel_id).not.toBe(THREAD);

    // …and Copy Link posts that pair — the parent channel + the reply.
    await mintPermalinkUrl(row!.channel_id, row!.id);

    const posts = (globalThis.fetch as unknown as { mock: { calls: [unknown, RequestInit?][] } }).mock.calls.filter(
      ([url, init]) => /\/permalinks$/.test(String(url)) && init?.method === 'POST',
    );
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0]![1]?.body))).toEqual({
      channel_id: CHANNEL,
      message_id: REPLY,
    });
  });
});

describe('#118 — the /m/<token> page path', () => {
  it('resolves the token, opens the channel and lands on the message (#114 reused)', async () => {
    const newestFirst = [message({ id: TARGET, content: 'linked' })];
    seedStore(newestFirst);
    installFetch(newestFirst);
    resolverTargets.set(TOKEN, { channel_id: CHANNEL, message_id: TARGET });
    globalThis.history.replaceState(null, '', `/m/${TOKEN}`);

    render(<AuthenticatedApp />);

    // The channel the token names is open…
    await waitFor(() =>
      expect(screen.getByTestId('channel-header-name').textContent).toContain('general'),
    );
    // …and #114's landing did the rest: the row is the flashed one.
    await waitFor(() =>
      expect(
        document.querySelector(`[data-message-id="${TARGET}"]`)?.className ?? '',
      ).toContain('message-focus-flash'),
    );

    // The address is the ordinary hash route now — one decode at the edge,
    // and a reload replays nothing (no second resolve, no second mint). The
    // ids are spelled the way the shared grammar WRITES them (base62: 1001 →
    // qj, 2002 → Gs, 3003 → WB) and `parsePermalinkPath` normalizes them back.
    await waitFor(() =>
      expect(globalThis.location.hash).toBe('#/workspace/qj/channel/Gs/message/WB'),
    );
    expect(globalThis.location.pathname).toBe('/');
    expect(parsePermalinkPath(globalThis.location.hash.slice(1))).toMatchObject({
      kind: 'message',
      workspaceId: WS,
      channelId: CHANNEL,
      messageId: TARGET,
    });
  });

  it('says so when the token does not resolve, and leaves the app usable', async () => {
    const newestFirst = [message({ id: TARGET })];
    seedStore(newestFirst);
    // No resolverTargets entry: the route answers 404 — the same body it
    // answers for a token for a channel this reader cannot see.
    installFetch(newestFirst);
    globalThis.history.replaceState(null, '', `/m/${TOKEN}`);

    render(<AuthenticatedApp />);

    const notice = await screen.findByTestId('permalink-notice');
    expect(notice.getAttribute('role')).toBe('alert');
    expect(notice.textContent).toMatch(/doesn.t work/i);
    // The one message, never a distinction the server refused to make.
    expect(notice.textContent).toMatch(/may be gone, or you may not have access/i);
  });
});

describe('#118 — legacy links keep working forever', () => {
  it('a DECIMAL #/… URL still lands on the message', async () => {
    const newestFirst = [message({ id: TARGET, content: 'old link' })];
    seedStore(newestFirst);
    installFetch(newestFirst);
    setHash(`/workspace/${WS}/channel/${CHANNEL}/message/${TARGET}`);

    render(<AuthenticatedApp />);

    await waitFor(() =>
      expect(
        document.querySelector(`[data-message-id="${TARGET}"]`)?.className ?? '',
      ).toContain('message-focus-flash'),
    );
  });

  it('a BASE62 #/… URL (the short-lived #118 fragment form) still lands too', async () => {
    const newestFirst = [message({ id: TARGET, content: 'short link' })];
    seedStore(newestFirst);
    installFetch(newestFirst);
    // 1001 → qj, 2002 → Gs, 3003 → WB: hard-coded so the expectation cannot be
    // re-derived from the encoder under test.
    setHash('/workspace/qj/channel/Gs/message/WB');

    render(<AuthenticatedApp />);

    await waitFor(() =>
      expect(
        document.querySelector(`[data-message-id="${TARGET}"]`)?.className ?? '',
      ).toContain('message-focus-flash'),
    );
    expect(screen.getByTestId('channel-header-name').textContent).toContain('general');
  });
});

describe('#114 — signed out, the address survives the login hop', () => {
  it('keeps the permalink in the URL while signed out, then continues to it after sign-in', async () => {
    const newestFirst = [message({ id: TARGET, content: 'waiting' })];
    seedStore(newestFirst);
    installFetch(newestFirst);
    const path = `/workspace/${WS}/channel/${CHANNEL}/message/${TARGET}`;
    setHash(path);

    // Signed out: the shell renders the login page (main.tsx's branch) and
    // nothing clears the address — the hash IS the pending target, which is
    // why no extra "resume" storage exists for this case.
    authStore.setState({ status: 'unauthenticated' } as never);
    expect(parsePermalinkPath(location.hash.slice(1))).toMatchObject({
      kind: 'message',
      messageId: TARGET,
    });

    // The same URL, one sign-in later: the authenticated shell mounts and
    // continues to the message.
    await act(async () => {
      authStore.setState({ status: 'authenticated', emailVerified: true } as never);
    });
    render(<AuthenticatedApp />);
    await waitFor(() =>
      expect(screen.getByTestId('channel-header-name').textContent).toContain('general'),
    );
    await waitFor(() =>
      expect(document.querySelector(`[data-message-id="${TARGET}"]`)).not.toBeNull(),
    );
    // Nothing dropped the target along the way.
    expect(location.hash).toBe(`#${path}`);
    void session;
  });
});
