/**
 * @cytale/tui — the entry point's history and search seams (U7's pagination,
 * U13's search), and the thread pane's seed row (U7's reactions).
 *
 * Three things landed as modules with a seam and no caller, and this file is
 * the proof that `runClient` now uses them:
 *
 *   1. `App`'s `onLoadHistory` (U7) — without it the shell's paging effect
 *      returns on its first line (`onLoadHistory === undefined`) and a channel
 *      or thread pane NEVER fetches a page: the member sees "Loading #general…"
 *      forever in a real session.
 *   2. `App`'s `onSearchQuery` (U13) — without it `/` opens the pane and the
 *      pane says "Search is not available in this session." (`SEARCH_UNWIRED_NOTICE`).
 *   3. `ThreadView`'s seed row (U7's reported bug) — the seed was drawn as
 *      `seedLabel + seed.lines` while `rowCost(seed)` charged a line for its
 *      reactions, so the chips were never drawn and the reserved line was blank.
 *
 * Every assertion is BEHAVIOURAL and as far down the stack as it goes: the
 * harness runs the real `runClient` over a real loopback HTTP fixture with a
 * real `SessionManager` and the entry point's own element, so a "request" here
 * means a socket accepted one. The two seams the client itself cannot own in a
 * test stay stubbed (the gateway, and the host's token descriptor).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cloneElement, createElement, type ReactElement } from 'react';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import type { Channel, Message, Thread, Workspace } from '@cytale/domain';
import type { GatewayClient, GatewayClientOptions } from '@cytale/gateway-client';
import { createStateStore, type StateState, type StateStore } from '@cytale/state';

import { App } from '../app.js';
import { runClient } from '../client.js';
import { buildContentView } from '../columns/ContentColumn.js';
import { ThreadView } from '../columns/ThreadView.js';
import type { TokenDescriptor } from '../session/tokenPipe.js';

// ---------------------------------------------------------------------------
// Ids and fixtures
// ---------------------------------------------------------------------------

const ME = '900000000000000001';
const DANA = '900000000000000002';
const W1 = '100000000000000001';
const C1 = '300000000000000001';
/** The DM whose segment's search route answers 501 by design. */
const DM = '300000000000000009';
const OLD = '800000000000000001';
const MID = '800000000000000002';
const SEED = '800000000000000009';
const REPLY = '800000000000000050';
const THREAD = '500000000000000001';
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlLWE';

const SIZE = { width: 100, height: 30 } as const;

/**
 * An id `steps` below `id`. Snowflakes are decimal strings and an 18-digit one
 * is past `Number`'s exact range, so the arithmetic is BigInt's.
 */
function idBelow(id: string, steps: number): string {
  return String(BigInt(id) - BigInt(steps));
}

/** Test D's top row, and the cursor the full page beneath it reports. */
const PAGE_TOP = '800000000000001000';
const PAGE_SECOND = idBelow(PAGE_TOP, 50);

function workspace(overrides: Partial<Workspace> & Pick<Workspace, 'id' | 'name'>): Workspace {
  return {
    owner_id: ME,
    role_version: 1,
    created_at: '2026-09-13T09:00:00.000Z',
    ...overrides,
  };
}

function channel(overrides: Partial<Channel> & Pick<Channel, 'id' | 'name'>): Channel {
  return {
    workspace_id: W1,
    type: 'text',
    topic: null,
    position: 0,
    last_message_id: null,
    created_at: '2026-09-13T10:00:00.000Z',
    ...overrides,
  };
}

function message(
  overrides: Partial<Message> & Pick<Message, 'id' | 'channel_id' | 'author_id' | 'content'>,
): Message {
  return {
    thread_id: null,
    created_at: '2026-09-13T12:00:00.000Z',
    edited_at: null,
    ...overrides,
  };
}

function threadRecord(overrides: Partial<Thread> = {}): Thread {
  return {
    id: THREAD,
    channel_id: C1,
    parent_message_id: SEED,
    name: 'a thread',
    created_by: DANA,
    archived: false,
    created_at: '2026-09-13T12:05:00.000Z',
    ...overrides,
  };
}

/** The store a real boot leaves behind: identity, one workspace, one channel. */
function seed(overrides: Partial<StateState> = {}): Partial<StateState> {
  return {
    currentUser: { id: ME, username: 'tester' },
    workspaces: { [W1]: workspace({ id: W1, name: 'Acme' }) },
    channels: { [C1]: channel({ id: C1, name: 'general' }) },
    membersById: {
      [ME]: { id: ME, username: 'tester', nickname: null, joined_at: '', roles: [] },
      [DANA]: { id: DANA, username: 'dana', nickname: null, joined_at: '', roles: [] },
    },
    memberIdsByWorkspace: { [W1]: [ME, DANA] },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The fixture server: the boot load, the two paging routes, and the two
// search routes (one of which answers the server's own 501 by design).
// ---------------------------------------------------------------------------

interface Recorded {
  readonly method: string;
  readonly url: string;
}

interface Fixture {
  readonly origin: string;
  readonly recorded: Recorded[];
  close(): Promise<void>;
}

const alive = new Set<Server>();

/** One FULL page (50 rows, newest-first) of the ids immediately below `top`. */
function fullPage(top: string): Message[] {
  return Array.from({ length: 50 }, (_unused, offset) => {
    const id = idBelow(top, offset + 1);
    return message({ id, channel_id: C1, author_id: DANA, content: `line ${id}` });
  });
}

afterEach(async () => {
  cleanup();
  for (const server of [...alive]) {
    alive.delete(server);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});

async function startFixture(): Promise<Fixture> {
  const recorded: Recorded[] = [];
  const server = createServer((req, res) => {
    const url = req.url ?? '';
    recorded.push({ method: req.method ?? '', url });
    const json = (status: number, payload: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const send = (status: number): void => {
      res.writeHead(status);
      res.end();
    };
    const query = (): URLSearchParams => new URL(url, 'http://127.0.0.1').searchParams;

    // The two search routes, BEFORE the `/users/@me` catch-all below.
    if (url.startsWith(`/api/v1/workspaces/${W1}/search`)) {
      json(200, {
        results: [{ message_id: MID, channel_id: C1, thread_id: null, score: 1 }],
        next_before: null,
      });
      return;
    }
    if (url.startsWith('/api/v1/users/@me/search')) {
      // The server's DM segment answers 501 `search_not_available` by design
      // (the api-client's own path for it is not served at all — see U13's
      // report). Either way the pane must show the reason, not hang.
      json(501, {
        error: { key: 'search_not_available', code: 50101, message: 'DM search is not available' },
      });
      return;
    }

    // The boot load (U12), in the server's own envelopes.
    if (url === '/api/v1/users/@me/workspaces') {
      json(200, {
        workspaces: [
          {
            id: W1,
            name: 'Acme',
            description: null,
            icon_url: null,
            owner_id: ME,
            created_at: '2026-01-01T00:00:00Z',
            member_count: 2,
          },
        ],
      });
      return;
    }
    if (url === '/api/v1/users/@me/channels') {
      json(200, { channels: [] });
      return;
    }
    if (url === `/api/v1/workspaces/${W1}/channels`) {
      json(200, {
        channels: [
          {
            id: C1,
            workspace_id: W1,
            name: 'general',
            type: 0,
            parent_id: null,
            topic: null,
            position: 0,
            last_message_id: null,
            created_at: '2026-01-01T00:00:00Z',
          },
        ],
      });
      return;
    }
    if (url === `/api/v1/workspaces/${W1}/people`) {
      json(200, {
        people: [
          { user: { id: DANA, username: 'dana', avatar_url: null }, nickname: null, joined_at: '', roles: [] },
        ],
        next_before: null,
      });
      return;
    }
    if (url === '/api/v1/users/@me') {
      json(200, { user: { id: ME, username: 'tester', email: null, email_verified_at: null } });
      return;
    }
    if (url === '/api/v1/auth/logout') {
      send(204);
      return;
    }

    // U7's channel route: `{"messages": […], "oldest_id": …}` — the one route
    // that carries a cursor.
    if (url.startsWith(`/api/v1/channels/${C1}/messages`) && req.method === 'GET') {
      const before = query().get('before');
      if (before === null) {
        json(200, { messages: [message({ id: MID, channel_id: C1, author_id: DANA, content: 'mid from the server' })], oldest_id: MID });
        return;
      }
      if (before === MID) {
        json(200, { messages: [message({ id: OLD, channel_id: C1, author_id: DANA, content: 'old from the server' })], oldest_id: OLD });
        return;
      }
      // A FULL page (50 rows, so `isLastPage` stays false and the pane keeps
      // paging) with the server's own `oldest_id` for the page after it — the
      // cursor a client that owned the cursor would record.
      if (before === PAGE_TOP) {
        json(200, { messages: fullPage(PAGE_TOP), oldest_id: PAGE_SECOND });
        return;
      }
      if (before === PAGE_SECOND) {
        json(200, { messages: fullPage(PAGE_SECOND), oldest_id: idBelow(PAGE_SECOND, 50) });
        return;
      }
      json(200, { messages: [], oldest_id: null });
      return;
    }

    // U7's thread route: `{"messages": […]}` and NO cursor — a short page here
    // does not prove the replies are exhausted (see the paging tests).
    if (url.startsWith(`/api/v1/threads/${THREAD}/messages`) && req.method === 'GET') {
      const before = query().get('before');
      if (before === null) {
        json(200, {
          messages: [
            message({ id: REPLY, channel_id: C1, thread_id: THREAD, author_id: DANA, content: 'reply from the thread route' }),
          ],
        });
        return;
      }
      json(200, { messages: [] });
      return;
    }

    // U10's watermark + floor route, for whichever conversation is selected.
    if (/^\/api\/v1\/channels\/.+\/ack$/.test(url)) {
      send(204);
      return;
    }

    json(404, { error: { key: 'not_found', code: 40401, message: 'no route' } });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  alive.add(server);
  const address = server.address() as AddressInfo | null;
  if (address === null) throw new Error('the fixture server did not bind');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    recorded,
    close: async () => {
      alive.delete(server);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

// ---------------------------------------------------------------------------
// The two client-side seams this suite stubs: the descriptor and the gateway
// ---------------------------------------------------------------------------

interface ScriptedDescriptor extends TokenDescriptor {
  write(bytes: string): void;
}

function scriptedDescriptor(): ScriptedDescriptor {
  const queued: string[] = [];
  const waiters: Array<(value: string | null) => void> = [];
  let ended = false;
  return {
    write(bytes: string) {
      if (ended) return;
      const resolve = waiters.shift();
      if (resolve === undefined) queued.push(bytes);
      else resolve(bytes);
    },
    read() {
      const buffered = queued.shift();
      if (buffered !== undefined) return Promise.resolve(buffered);
      if (ended) return Promise.resolve(null);
      return new Promise<string | null>((resolve) => {
        waiters.push(resolve);
      });
    },
    close() {
      ended = true;
      for (const resolve of waiters.splice(0)) resolve(null);
    },
  };
}

function stubGateway(): (options: GatewayClientOptions) => GatewayClient {
  let options: GatewayClientOptions | null = null;
  return (next: GatewayClientOptions): GatewayClient => {
    options = next;
    return {
      connect: async () => {
        options?.onStateChange?.({ from: 'connecting', to: 'connected' });
      },
      disconnect: () => undefined,
      destroy: () => undefined,
      onAny: () => () => undefined,
    } as unknown as GatewayClient;
  };
}

// ---------------------------------------------------------------------------
// Booting the client, and mounting the element it hands the renderer
// ---------------------------------------------------------------------------

interface Booted {
  readonly store: StateStore;
  readonly fixture: Fixture;
  readonly elements: ReactElement[];
  readonly running: Promise<number>;
  quit(): void;
}

type Instance = ReturnType<typeof render>;

/** The client's own element, captured from the renderer seam. */
interface ClientProps {
  readonly view?: { phase?: string };
  readonly onLoadHistory?: unknown;
  readonly onSearchQuery?: (request: { scope: string; workspaceId: string | null; query: string }) => Promise<unknown>;
  readonly onQuit?: () => void;
}

async function boot(store: StateStore): Promise<Booted> {
  const fixture = await startFixture();
  const descriptor = scriptedDescriptor();
  descriptor.write(`{"access_token":"${TOKEN}","expires_in":900}\n`);
  const elements: ReactElement[] = [];
  const sink = { write: (): boolean => true };

  const running = runClient({
    argv: [],
    env: { CYTALE_TOKEN_FD: '3', CYTALE_ORIGIN: fixture.origin },
    stdout: sink,
    stderr: sink,
    deps: {
      descriptor,
      createGatewayClient: stubGateway(),
      store,
      render: (node: ReactElement) => {
        elements.push(node);
        return {
          rerender: (next: ReactElement) => {
            elements.push(next);
          },
          unmount: () => undefined,
        };
      },
    },
  });

  // The session is ESTABLISHED: the online view exists only once the gateway
  // does, so a shell mounted after this wait is a shell over a live session
  // (a token, an authenticated status, and the session's pre-dispatch seat).
  await waitFor(() => clientProps(elements).view?.phase === 'online');
  return {
    store,
    fixture,
    elements,
    running,
    quit: () => clientProps(elements).onQuit?.(),
  };
}

function clientProps(elements: ReactElement[]): ClientProps {
  const latest = elements[elements.length - 1] as ReactElement<ClientProps> | undefined;
  return (latest?.props ?? {}) as ClientProps;
}

/**
 * Mount the element the CLIENT built — every prop is the entry point's own —
 * with only the terminal geometry added.
 */
function shell(elements: ReactElement[]): Instance {
  const node = elements[elements.length - 1] as ReactElement<Record<string, unknown>> | undefined;
  if (node === undefined) throw new Error('the client has not rendered yet');
  return render(cloneElement(node, { width: SIZE.width, height: SIZE.height }));
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  throw new Error('timed out waiting for the client');
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

async function press(instance: Instance, input: string): Promise<void> {
  instance.stdin.write(input);
  await tick();
}

/**
 * Press a key `times` in a row, with ONE tick after the last. The shell's
 * reducer reads its previous state from a ref, so a burst advances the cursor
 * the same way a member holding the key down would.
 */
async function pressTimes(instance: Instance, input: string, times: number): Promise<void> {
  for (let index = 0; index < times; index += 1) instance.stdin.write(input);
  await tick();
}

const frame = (instance: Instance): string => instance.lastFrame() ?? '';

const urls = (fixture: Fixture): string[] => fixture.recorded.map((entry) => entry.url);

// ---------------------------------------------------------------------------
// A. U7 — the entry point loads history
// ---------------------------------------------------------------------------

describe('A. the entry point loads history (U7)', () => {
  it('asks for the first page of a channel whose slice the store does not hold', async () => {
    const store = createStateStore();
    store.setState(seed({ messagesByChannel: {} }));
    const booted = await boot(store);
    try {
      const instance = shell(booted.elements);
      // The seam is WIRED at the element the client builds — the pre-wiring
      // characterization: before this, the prop was absent and the paging
      // effect returned on its first line, so no request was ever made.
      expect(typeof clientProps(booted.elements).onLoadHistory).toBe('function');

      await waitFor(() => urls(booted.fixture).includes(`/api/v1/channels/${C1}/messages?limit=50`));
      // The page lands in the SHARED store (the pane reads it there, not from
      // the loader's return value).
      await waitFor(() => (store.getState().messagesByChannel[C1]?.items ?? []).length === 1);
      expect(store.getState().messagesByChannel[C1]?.items[0]?.id).toBe(MID);
      await waitFor(() => frame(instance).includes('mid from the server'));
    } finally {
      booted.quit();
      expect(await booted.running).toBe(0);
    }
  });

  it('pages OLDER from the store’s own cursor when the pane reaches its oldest row', async () => {
    const store = createStateStore();
    store.setState(
      seed({
        messagesByChannel: {
          [C1]: {
            items: [message({ id: MID, channel_id: C1, author_id: DANA, content: 'mid line' })],
            oldestId: MID,
            hasCompleteHistory: false,
          },
        },
      }),
    );
    const booted = await boot(store);
    try {
      const instance = shell(booted.elements);
      // One row and the cursor opens on it, so the top of the pane is already
      // reached: the page is asked for with the store's `before=` cursor — the
      // id of the OLDEST loaded message, not the channel or anything re-derived.
      await waitFor(() =>
        urls(booted.fixture).includes(`/api/v1/channels/${C1}/messages?before=${MID}&limit=50`),
      );
      await waitFor(() => (store.getState().messagesByChannel[C1]?.items ?? []).length === 2);
      const items = store.getState().messagesByChannel[C1]?.items ?? [];
      // Newest-first, deduped, and the older row went to the END of the slice.
      expect(items.map((row) => row.id)).toEqual([MID, OLD]);
      await waitFor(() => frame(instance).includes('old from the server'));
    } finally {
      booted.quit();
      expect(await booted.running).toBe(0);
    }
  });

  it('loads a thread’s replies from the thread route, and a short page completes it (#152)', async () => {
    const store = createStateStore();
    store.setState(
      seed({
        messagesByChannel: {
          [C1]: {
            items: [message({ id: SEED, channel_id: C1, author_id: DANA, content: 'the seed line' })],
            oldestId: SEED,
            hasCompleteHistory: true,
          },
        },
        threadsById: { [THREAD]: threadRecord() },
        threadIdsByChannel: { [C1]: [THREAD] },
      }),
    );
    const booted = await boot(store);
    try {
      const instance = shell(booted.elements);
      await press(instance, 't');
      await waitFor(() => urls(booted.fixture).includes(`/api/v1/threads/${THREAD}/messages?limit=50`));
      await waitFor(() => (store.getState().messagesByThread[THREAD]?.items ?? []).length === 1);
      await waitFor(() => frame(instance).includes('reply from the thread route'));

      // The session's own 201–204 channel writes are not what filled this
      // slice: it was the thread route, and only it.
      expect(store.getState().messagesByChannel[C1]?.items).toHaveLength(1);

      // The thread route is thread-scoped (#152), so the short page (1 of 50)
      // IS proof of completeness: the history completes on it, and the pane
      // never spends a second request asking for an empty page.
      await waitFor(() => store.getState().messagesByThread[THREAD]?.hasCompleteHistory === true);
      await waitFor(() => frame(instance).includes('beginning of the thread'));
      expect(urls(booted.fixture)).not.toContain(`/api/v1/threads/${THREAD}/messages?before=${REPLY}&limit=50`);
    } finally {
      booted.quit();
      expect(await booted.running).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// B. U13 — the entry point runs search
// ---------------------------------------------------------------------------

describe('B. the entry point runs search (U13)', () => {
  const withLoadedChannel = (extra: Partial<StateState> = {}): StateStore => {
    const store = createStateStore();
    store.setState(
      seed({
        messagesByChannel: {
          [C1]: {
            items: [message({ id: MID, channel_id: C1, author_id: DANA, content: 'mid from the server' })],
            oldestId: MID,
            hasCompleteHistory: true,
          },
        },
        ...extra,
      }),
    );
    return store;
  };

  it('sends a workspace-scope query to the workspace search route and draws the hit', async () => {
    const store = withLoadedChannel();
    const booted = await boot(store);
    try {
      const instance = shell(booted.elements);
      await waitFor(() => frame(instance).includes('#general'));

      // `/` opens the pane, `i` hands it the keyboard (the client's two-step
      // text model), and the query goes out as the member types it.
      await press(instance, '/');
      await press(instance, 'i');
      await press(instance, 'hello');
      // Pre-wiring this request never happened, and the pane said "Search is
      // not available in this session." instead of the hit below.
      await waitFor(() => urls(booted.fixture).includes(`/api/v1/workspaces/${W1}/search?q=hello`));

      // The hit is projected against the store, which is where the conversation
      // name, the author, and the body the wire omits come from.
      await waitFor(() => frame(instance).includes('mid from the server'));
      expect(frame(instance)).toContain('#general · dana');
      expect(frame(instance)).not.toContain('Search is not available in this session.');
    } finally {
      booted.quit();
      expect(await booted.running).toBe(0);
    }
  });

  it('sends a DM-scope query to the DM search route, and its 501 surfaces as unavailable', async () => {
    const store = withLoadedChannel({
      channels: {
        [C1]: channel({ id: C1, name: 'general' }),
        [DM]: channel({ id: DM, name: '', type: 'dm', recipients: [{ id: DANA, username: 'dana' }] }),
      },
    });
    const booted = await boot(store);
    try {
      const instance = shell(booted.elements);
      await waitFor(() => frame(instance).includes('#general'));
      // The scope follows column one's mode (R23's two halves).
      await press(instance, 'm');
      await press(instance, '/');
      await press(instance, 'i');
      await press(instance, 'hello');

      await waitFor(() => urls(booted.fixture).includes('/api/v1/users/@me/search?q=hello'));
      // The server's own 501 is its own state — nothing the member did is
      // wrong — and it is DRAWN rather than swallowed or left hanging.
      await waitFor(() => frame(instance).includes('Search is unavailable right now'));
      expect(frame(instance)).toContain('your direct messages');
    } finally {
      booted.quit();
      expect(await booted.running).toBe(0);
    }
  });

  it('refuses a workspace query with no workspace, instead of aiming it at an empty path', async () => {
    const booted = await boot(withLoadedChannel());
    try {
      const onSearchQuery = clientProps(booted.elements).onSearchQuery;
      expect(typeof onSearchQuery).toBe('function');
      // The shell's contract is that this never happens (`buildSearchRequest`
      // answers null for a workspace scope with no workspace); a violation is
      // reported rather than turned into a request against `/workspaces//`.
      await expect(
        onSearchQuery?.({ scope: 'workspace', workspaceId: null, query: 'hello' }),
      ).rejects.toThrowError('no workspace');
      expect(urls(booted.fixture).some((url) => url.includes('/workspaces//search'))).toBe(false);
    } finally {
      booted.quit();
      expect(await booted.running).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// C. U7's reported bug: the thread seed's reaction chips
// ---------------------------------------------------------------------------

describe('C. the thread pane’s seed row (U7)', () => {
  /** The seed message the store holds: the pane projects it as context. */
  function seedWithReactions(withReactions: boolean): Message {
    return {
      ...message({ id: SEED, channel_id: C1, author_id: DANA, content: 'the seed line' }),
      ...(withReactions ? { reactions: [{ emoji: '👍', count: 1, me: false }] } : {}),
    } as Message;
  }

  function threadView(withReactions: boolean, height = 20): Instance {
    const store = createStateStore();
    store.setState(
      seed({
        messagesByChannel: {
          [C1]: { items: [seedWithReactions(withReactions)], oldestId: SEED, hasCompleteHistory: true },
        },
        threadsById: { [THREAD]: threadRecord() },
        threadIdsByChannel: { [C1]: [THREAD] },
        messagesByThread: {
          [THREAD]: {
            items: [
              message({ id: REPLY, channel_id: C1, thread_id: THREAD, author_id: DANA, content: 'a reply' }),
            ],
            oldestId: REPLY,
            hasCompleteHistory: true,
          },
        },
      }),
    );
    const view = buildContentView({
      source: store.getState(),
      conversationId: C1,
      openThreadMessageId: SEED,
      width: 80,
    });
    return render(createElement(ThreadView, { view, width: 80, height }));
  }

  it('draws the seed’s reaction chips, so the line `rowCost` charges is a line it draws', () => {
    const drawn = frame(threadView(true));
    // The seed is context, its body is drawn, and its chips are drawn: the
    // charge (`rowCost`) counts a chip row whenever the seed has reactions.
    expect(drawn).toContain('── seed');
    expect(drawn).toContain('the seed line');
    expect(drawn).toContain('👍 1');
    // The replies are still under it, with their own budget.
    expect(drawn).toContain('a reply');
  });

  it('draws no chip line for a seed with no reactions (the charge is absent too)', () => {
    const drawn = frame(threadView(false));
    expect(drawn).toContain('the seed line');
    expect(drawn).not.toContain('👍');
  });
});

// ---------------------------------------------------------------------------
// D. A finding OUTSIDE this wave's file set (reported, not fixed here)
// ---------------------------------------------------------------------------

describe('D. the paging cursor the shared merge keeps (reported upstream, now fixed)', () => {
  it('walks further back instead of re-asking for the page it already holds', async () => {
    const store = createStateStore();
    store.setState(
      seed({
        messagesByChannel: {
          [C1]: {
            items: [message({ id: PAGE_TOP, channel_id: C1, author_id: DANA, content: 'top line' })],
            oldestId: PAGE_TOP,
            hasCompleteHistory: false,
          },
        },
      }),
    );
    const booted = await boot(store);
    try {
      const instance = shell(booted.elements);
      // The single seeded row is the cursor's row, so the pane asks for the
      // page older than it on mount. It comes back FULL, so the history is NOT
      // complete and the `oldest_id` the route reported (`PAGE_SECOND`) is the
      // cursor the next page belongs behind.
      await waitFor(() => (store.getState().messagesByChannel[C1]?.items ?? []).length === 51);
      // The page was PREPENDED, so the shell anchored the cursor on the message
      // it was on and moved it by the same delta: it now sits at the bottom of
      // 51 rows and the top has to be walked back to (column two writes, so the
      // keyboard goes there first).
      await press(instance, '\t');
      await pressTimes(instance, 'k', 50);

      // Any keystroke releases the shell's one-request-per-(pane, cursor,
      // keystroke) block, so reaching the top asks again.
      await tick();
      await tick();

      // `before=` is the slice's `oldestId`, so this only walks back if the
      // merge ADVANCES the cursor on the second page. It used to latch the
      // first page's value forever (`existing.oldestId !== null && … ?
      // existing.oldestId : oldest`), so the pane re-requested the page it
      // already held, the merge deduped it away, and history stalled at two
      // pages with no error and no further movement. The route had reported
      // `PAGE_SECOND` the whole time and nothing consumed it.
      //
      // The visible clients never hit this because they page from the oldest
      // ROW; the terminal reads the slice cursor, which is what
      // `packages/state/src/store.ts` documents it to be. Fixed in
      // `mergeChannelMessages` (`oldestId: oldest ?? existing.oldestId`).
      const asked = urls(booted.fixture).filter((url) => url.includes('/messages?before='));
      expect(asked).toEqual([
        `/api/v1/channels/${C1}/messages?before=${PAGE_TOP}&limit=50`,
        `/api/v1/channels/${C1}/messages?before=${PAGE_SECOND}&limit=50`,
      ]);
      // Two full pages merged, and the oldest row agrees with the cursor.
      expect(store.getState().messagesByChannel[C1]?.items).toHaveLength(101);
      expect(store.getState().messagesByChannel[C1]?.oldestId).toBe(
        idBelow(PAGE_SECOND, 50),
      );
    } finally {
      booted.quit();
      expect(await booted.running).toBe(0);
    }
  });
});
