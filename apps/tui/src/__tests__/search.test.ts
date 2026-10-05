/**
 * @cytale/tui — search (U13; R23, R26a).
 *
 * Search is the shell's own surface: `/` opens a query pane in column two, the
 * query reaches the server over the real `/api/v1` search routes, and opening a
 * result loads that conversation and puts the CURSOR on the message — not merely
 * on its channel.
 *
 * Every assertion here is behavioural and as far down the stack as it can be: a
 * real loopback HTTP fixture serving the shapes
 * `apps/server/lib/cytale_web/controllers/search_controller.ex` actually
 * answers, a real `CytaleApiClient` (so the METHOD and the PATH are asserted
 * rather than assumed), a real `@cytale/state` store, and keystrokes through
 * `stdin`.
 *
 * ---------------------------------------------------------------------------
 * The two scenarios the unit calls out as easy to fake, asserted the hard way
 * ---------------------------------------------------------------------------
 *
 *   * **"opening one renders its channel with the cursor on that message."**
 *     The rendered frame is checked for the cursor MARKER on the target's own
 *     gutter line, and then the cursor's exact message ID is read off the far
 *     end of the stack: `u` (mark-unread) writes the floor through the real ack
 *     route, so the recorded body names the message the cursor was on. A test
 *     that only asserted "the channel rendered" would pass with the cursor back
 *     at the newest row.
 *   * **"resolves to the latest, not to whichever returns first."** The fixture
 *     makes the EARLIER query the SLOW one, the later query is answered
 *     immediately, and then the earlier one is given time to land. The later
 *     query's rows must still be what the pane shows.
 *
 * ---------------------------------------------------------------------------
 * The wire, and the one place this unit does not trust a declared type
 * ---------------------------------------------------------------------------
 *
 * `CytaleApiClient.searchWorkspace` is declared `Promise<SearchResult>` (the
 * domain's `{items, cursor}`), and the controller serves neither: the workspace
 * route answers
 *
 *     { "results": [{ "message_id", "channel_id", "thread_id", "score" }],
 *       "next_before": null }
 *
 * — no `items`, no body text, and a hit carries no author or timestamp. The
 * pane therefore projects rows from the payload it is HANDED (`compose/search.ts`
 * reads `results`, tolerates `items`, and drops a hit it cannot identify), and
 * falls back to the store for the two facts the wire does not carry: the
 * conversation's name and — when the message is already loaded — its author,
 * time, and body. DM search rides the api-client's `searchDMs`
 * (`/users/@me/search`); the server's DM segment answers the stable 501
 * `search_not_available`, which renders as its own state rather than as a
 * generic failure, and the same route answers rows if the segment is ever
 * wired, so both halves are pinned below.
 *
 * R26a: every string a row draws — the conversation name, the author, the
 * snippet, the server's error message — is made inert at projection time. A
 * hostile display name or highlight is asserted to reach no cell, which is the
 * reason a snippet is sanitized rather than trusted.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createElement } from 'react';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { CytaleApiClient, createInMemoryTokenProvider } from '@cytale/api-client';
import type { Channel, Message, Workspace, WorkspaceMember } from '@cytale/domain';
import { createStateStore, mergeChannelMessages, type StateStore, type StateState } from '@cytale/state';

import { App, type ConnectionPhase } from '../app.js';
import {
  buildSearchRequest,
  classifySearchFailure,
  idleSearchPane,
  jumpUnresolvedNotice,
  loadingSearchPane,
  readSearchRows,
  resultsSearchPane,
  searchEmptyNotice,
  searchRowText,
  searchScopeFor,
  searchWindow,
} from '../compose/search.js';
import type { MessageSource } from '../format/rows.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ME = '900000000000000001';
const OTHER = '900000000000000002';
const W1 = '100000000000000001';
/** #general — the channel column one selects on landing. */
const C1 = '300000000000000001';
/** #random — the channel a result opens. */
const C2 = '300000000000000002';
/** A DM conversation. */
const D1 = '300000000000000009';
/** The account-wide DM row, in recency order. */
const M1 = '800000000000000001';
const M2 = '800000000000000002';
const M3 = '800000000000000003';
const M4 = '800000000000000004';
const M5 = '800000000000000005';
/** A channel id no store in this suite holds. */
const UNKNOWN = '399999999999999999';
/** The message a result points at, in C2 — with a NEWER row above it, so a
 * cursor left to itself (the newest row) is not already on the target. */
const HIT = '800000000000000011';
const NEWEST = '800000000000000013';
/** A message the server indexes but the conversation no longer holds. */
const GONE = '800000000000000012';
/** Hits whose channel is not in the store: the row falls back to naming the id. */
const SLOW_HIT = '800000000000000021';
const FAST_HIT = '800000000000000022';

const GENERAL_TEXT = 'the deploy window is friday';
const RANDOM_TEXT = 'the random channel has a deploy of its own';
/** C2 is paged around the hit: a NEWER row is what a cursor left to itself lands on. */
const NEWER_TEXT = 'something newer than the hit';
const OLDER_TEXT = 'something older than the hit';
const HOSTILE = '\u001b[2J\u001b[31m own every terminal';

const SIZE = { width: 100, height: 30 } as const;
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlLWE';

const KEYS = {
  enter: '\r',
  escape: '\u001b',
  backspace: '\u007f',
} as const;

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

/** The roster row for the other member — the name a result row draws. */
const member = (overrides: Partial<WorkspaceMember> = {}): WorkspaceMember => ({
  id: OTHER,
  username: 'ana',
  avatar_url: null,
  nickname: null,
  joined_at: '2026-09-13T09:30:00.000Z',
  roles: [],
  ...overrides,
});

const authors = { [OTHER]: member() };

/** The store a real boot leaves behind: identity, one workspace, two channels. */
function seed(overrides: Partial<StateState> = {}): Partial<StateState> {
  return {
    currentUser: { id: ME, username: 'tester' },
    workspaces: { [W1]: workspace({ id: W1, name: 'Acme' }) },
    channels: {
      [C1]: channel({ id: C1, name: 'general', position: 0 }),
      [C2]: channel({ id: C2, name: 'random', position: 1 }),
    },
    membersById: authors,
    memberIdsByWorkspace: { [W1]: [ME, OTHER] },
    ...overrides,
  };
}

const generalSlice = (items: readonly Message[] = []): StateState['messagesByChannel'] => ({
  [C1]: { items: [...items], oldestId: items[items.length - 1]?.id ?? null, hasCompleteHistory: true },
});

const generalRows: Message[] = [
  message({ id: M5, channel_id: C1, author_id: OTHER, content: 'newest in general' }),
  message({ id: M4, channel_id: C1, author_id: OTHER, content: 'fourth' }),
  message({ id: M3, channel_id: C1, author_id: OTHER, content: 'third' }),
  message({ id: M2, channel_id: C1, author_id: ME, content: 'second' }),
  message({ id: M1, channel_id: C1, author_id: ME, content: GENERAL_TEXT }),
];

// ---------------------------------------------------------------------------
// The fixture server: the real search envelopes, the history page, the ack route
// ---------------------------------------------------------------------------

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly body: Record<string, unknown>;
}

/** One hit as the controller serves it (`result_json/1`). */
interface HitRow {
  readonly message_id: string;
  readonly channel_id: string;
  readonly thread_id: string | null;
  /** The Tantivy snippet the domain's `SearchHit` declares; the controller omits it today. */
  readonly highlight?: string | null;
}

interface Failure {
  readonly status: number;
  readonly key: string;
  readonly message: string;
}

interface FixtureOptions {
  /** Per-query latency. The out-of-order test makes the EARLIER query the slow one. */
  readonly delayMsFor?: (q: string) => number;
  readonly workspaceRows?: (q: string) => readonly HitRow[];
  readonly workspaceFailure?: Failure;
  readonly dmRows?: (q: string) => readonly HitRow[];
  readonly dmFailure?: Failure;
  /** The history route's pages, keyed by channel id, NEWEST-FIRST. */
  readonly pages?: Record<string, readonly Message[]>;
}

/** The shipped DM segment: `SearchController.dm/2` answers the stable 501. */
const DM_NOT_AVAILABLE: Failure = {
  status: 501,
  key: 'search_not_available',
  message: 'Search indexing is unavailable; the route contract is stable.',
};

interface Fixture {
  readonly origin: string;
  readonly recorded: Recorded[];
  /** Every workspace-scope query the server was asked, in order. */
  readonly workspaceQueries: () => string[];
  /** Every DM-scope query the server was asked, in order. */
  readonly dmQueries: () => string[];
  readonly searchRequests: () => Recorded[];
  readonly acks: () => Recorded[];
  close(): Promise<void>;
}

const alive = new Set<Server>();

afterEach(async () => {
  cleanup();
  for (const server of [...alive]) {
    alive.delete(server);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});

const sleep = async (ms: number): Promise<void> => {
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => resolve(raw));
  });
}

async function startFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const recorded: Recorded[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? '';
      const raw = await readBody(req);
      let body: Record<string, unknown> = {};
      try {
        body = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
      } catch {
        body = {};
      }
      recorded.push({ method: req.method ?? '', url, body });

      const at = url.indexOf('?');
      const path = at === -1 ? url : url.slice(0, at);
      const query = new URLSearchParams(at === -1 ? '' : url.slice(at + 1));
      const q = query.get('q') ?? '';

      const json = (status: number, payload: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const failure = (spec: Failure): void => {
        json(spec.status, { error: { key: spec.key, code: spec.status * 100 + 1, message: spec.message } });
      };
      const search = async (
        spec: Failure | undefined,
        rows: (query: string) => readonly HitRow[],
      ): Promise<void> => {
        if (spec !== undefined) {
          failure(spec);
          return;
        }
        await sleep(options.delayMsFor?.(q) ?? 0);
        json(200, { results: rows(q), next_before: null });
      };

      if (path === `/api/v1/workspaces/${W1}/search` && req.method === 'GET') {
        await search(options.workspaceFailure, options.workspaceRows ?? (() => []));
        return;
      }
      if (path === '/api/v1/users/@me/search' && req.method === 'GET') {
        await search(options.dmFailure, options.dmRows ?? (() => []));
        return;
      }

      const history = /^\/api\/v1\/channels\/([^/]+)\/messages$/.exec(path);
      if (history !== null && req.method === 'GET') {
        const rows = options.pages?.[history[1] ?? ''] ?? [];
        json(200, {
          messages: rows,
          oldest_id: rows.length > 0 ? (rows[rows.length - 1]?.id ?? null) : null,
        });
        return;
      }
      if (/^\/api\/v1\/channels\/[^/]+\/ack$/.test(path) && req.method === 'POST') {
        res.writeHead(204);
        res.end();
        return;
      }

      json(404, { error: { key: 'not_found', code: 40401, message: 'no route' } });
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  alive.add(server);
  const address = server.address() as AddressInfo | null;
  if (address === null) throw new Error('the fixture server did not bind');

  const origin = `http://127.0.0.1:${address.port}`;
  const searchRequests = (): Recorded[] =>
    recorded.filter((entry) => entry.url.includes('/search'));
  return {
    origin,
    recorded,
    searchRequests,
    workspaceQueries: () =>
      recorded
        .filter((entry) => entry.url.startsWith(`/api/v1/workspaces/${W1}/search`))
        .map((entry) => new URLSearchParams(entry.url.split('?')[1] ?? '').get('q') ?? ''),
    dmQueries: () =>
      recorded
        .filter((entry) => entry.url.startsWith('/api/v1/users/@me/search'))
        .map((entry) => new URLSearchParams(entry.url.split('?')[1] ?? '').get('q') ?? ''),
    acks: () => recorded.filter((entry) => entry.url.endsWith('/ack')),
    close: async () => {
      alive.delete(server);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

// ---------------------------------------------------------------------------
// The harness: the real api client over the fixture, the shell over both
// ---------------------------------------------------------------------------

interface HarnessOptions {
  readonly store: StateStore;
  readonly fixture: Fixture;
  readonly phase?: ConnectionPhase;
  /** Build the search seam some other way (the "host wired nothing" cases). */
  readonly searchSeam?: boolean;
  /** A read callback, for the test that proves `/` does not swallow keys. */
  readonly onMarkRead?: (conversationId: string) => void;
}

interface Harness {
  readonly store: StateStore;
  readonly fixture: Fixture;
  readonly instance: ReturnType<typeof render>;
  readonly api: CytaleApiClient;
}

function mount(options: HarnessOptions): Harness {
  const { store, fixture } = options;
  const api = new CytaleApiClient({
    baseUrl: fixture.origin,
    tokens: createInMemoryTokenProvider({
      access_token: TOKEN,
      refresh_token: 'r',
      expires_in: 900,
    }),
  });

  // The seams a host wires (`apps/tui/src/client.ts` holds the same api): the
  // search request itself, the page a pane still owes, and the read floor that
  // makes the cursor's message id observable at the far end of the stack.
  const instance = render(
    createElement(App, {
      view: {
        phase: options.phase ?? 'online',
        headline: `Connected to ${fixture.origin}`,
      },
      mode: 'ssh',
      origin: fixture.origin,
      store,
      width: SIZE.width,
      height: SIZE.height,
      ...(options.searchSeam === false
        ? {}
        : {
            onSearchQuery: (request: { scope: string; workspaceId: string | null; query: string }) =>
              request.scope === 'dms'
                ? api.searchDMs(request.query)
                : api.searchWorkspace(request.workspaceId ?? '', request.query),
          }),
      onLoadHistory: async (request: { channelId: string; before: string | null }) => {
        const page = await api.getMessagePage(request.channelId, {
          ...(request.before === null ? {} : { before: request.before }),
        });
        mergeChannelMessages(store, request.channelId, page.items, {
          isLastPage: page.items.length < 25,
        });
      },
      onMarkUnread: (messageId: string, conversationId: string) => {
        void api.ackChannel(conversationId, messageId, { unreadFloor: messageId });
      },
      ...(options.onMarkRead === undefined ? {} : { onMarkRead: options.onMarkRead }),
    }),
  );

  return { store, fixture, instance, api };
}

type Instance = ReturnType<typeof render>;

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

/**
 * Open the pane and give its query line the keyboard: `/` puts the pane on
 * screen (leaving the columns typing) and `i` — the client's write key — hands
 * the query line the keystrokes.
 */
async function openSearch(instance: Instance): Promise<void> {
  await press(instance, '/');
  await press(instance, 'i');
}

async function press(instance: Instance, input: string): Promise<void> {
  instance.stdin.write(input);
  await tick();
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  throw new Error('timed out waiting for the shell');
}

const frame = (instance: Instance): string => instance.lastFrame() ?? '';
const lines = (instance: Instance): string[] => frame(instance).split('\n');

/** The physical line the target's body was drawn on. */
const bodyLine = (instance: Instance, text: string): number =>
  lines(instance).findIndex((line) => line.includes(text));

// ---------------------------------------------------------------------------
// A. The happy path: a query, its results, and opening one
// ---------------------------------------------------------------------------

describe('A. a query reaches the server and opening a result lands on the message (R23)', () => {
  it('renders the result and puts the cursor on its message id', async () => {
    const store = createStateStore();
    store.setState(seed({ messagesByChannel: generalSlice(generalRows) }));
    const fixture = await startFixture({
      workspaceRows: () => [{ message_id: HIT, channel_id: C2, thread_id: null }],
      pages: {
        [C2]: [
          message({ id: NEWEST, channel_id: C2, author_id: OTHER, content: NEWER_TEXT }),
          message({ id: HIT, channel_id: C2, author_id: OTHER, content: RANDOM_TEXT }),
          message({ id: M3, channel_id: C2, author_id: OTHER, content: OLDER_TEXT }),
        ],
      },
    });
    const { instance } = mount({ store, fixture });

    await waitFor(() => frame(instance).includes('#general'));

    // `/` — the keyboard entry point (R28) — opens the query surface.
    await openSearch(instance);
    await waitFor(() => frame(instance).includes('Search'));
    await press(instance, 'deploy');
    await waitFor(() => fixture.workspaceQueries().includes('deploy'));

    // The hit is drawn in column two, naming the message it points at (the wire
    // carries no body for a channel this client has not loaded).
    await waitFor(() => frame(instance).includes(`message ${HIT}`));

    // Enter opens the highlighted result: its channel loads over the wire…
    await press(instance, KEYS.enter);
    await waitFor(() =>
      fixture.recorded.some(
        (entry) => entry.method === 'GET' && entry.url.startsWith(`/api/v1/channels/${C2}/messages`),
      ),
    );
    await waitFor(() => frame(instance).includes(RANDOM_TEXT));

    // …and the CURSOR is on the searched message, not on the newest row: the
    // marker sits on the target's own gutter line, and NOT on the row above it.
    const body = bodyLine(instance, RANDOM_TEXT);
    expect(body).toBeGreaterThan(0);
    expect(lines(instance)[body - 1]).toContain('▸');
    const newer = bodyLine(instance, NEWER_TEXT);
    expect(newer).toBeGreaterThan(0);
    expect(lines(instance)[newer - 1]).not.toContain('▸');

    // The cursor's exact message id, read at the far end of the stack: `u`
    // writes the floor through the real channel-scoped ack route.
    await press(instance, 'u');
    await waitFor(() =>
      fixture.acks().some((entry) => entry.url === `/api/v1/channels/${C2}/ack`),
    );
    const ack = fixture.acks().find((entry) => entry.url === `/api/v1/channels/${C2}/ack`);
    expect(ack?.body.unread_floor).toBe(HIT);
  });
});

describe('B. DM search scopes to the member’s conversations', () => {
  it('searches the DM segment, not the workspace, and opens the conversation', async () => {
    const store = createStateStore();
    store.setState(
      seed({
        channels: {
          [C1]: channel({ id: C1, name: 'general', position: 0 }),
          [D1]: channel({
            id: D1,
            name: '',
            type: 'dm',
            workspace_id: null,
            recipients: [{ id: OTHER, username: 'ana' }],
          }),
        },
        messagesByChannel: generalSlice(generalRows),
      }),
    );
    const fixture = await startFixture({
      dmRows: () => [{ message_id: M3, channel_id: D1, thread_id: null }],
      pages: {
        [D1]: [message({ id: M3, channel_id: D1, author_id: OTHER, content: 'annual review notes' })],
      },
    });
    const { instance } = mount({ store, fixture });

    await waitFor(() => frame(instance).includes('#general'));
    // `m` switches to DMs mode; the DM column is account-wide (R17).
    await press(instance, 'm');
    await waitFor(() => frame(instance).includes('ana'));

    await openSearch(instance);
    await press(instance, 'annual');
    await waitFor(() => fixture.dmQueries().includes('annual'));

    // The workspace segment was never asked: the scope follows the mode.
    expect(fixture.workspaceQueries()).toEqual([]);
    // The DM segment's results are drawn in column two, with the context the
    // store holds for the conversation.
    await waitFor(() => frame(instance).includes('annual review notes'));

    await press(instance, KEYS.enter);
    // Opening the DM hit lands on the DM conversation — the `m` switch above
    // already selected it, so this is the cursor half of the jump: `u` reports
    // the message the cursor is on, through the real channel-scoped ack route.
    await waitFor(() => frame(instance).includes('annual review notes'));
    await press(instance, 'u');
    await waitFor(() => fixture.acks().some((entry) => entry.url === `/api/v1/channels/${D1}/ack`));
    expect(
      fixture.acks().find((entry) => entry.url === `/api/v1/channels/${D1}/ack`)?.body.unread_floor,
    ).toBe(M3);
  });

  it('answers the shipped DM 501 with its own unavailable state', async () => {
    const store = createStateStore();
    store.setState(
      seed({
        channels: {
          [C1]: channel({ id: C1, name: 'general', position: 0 }),
          [D1]: channel({
            id: D1,
            name: '',
            type: 'dm',
            workspace_id: null,
            recipients: [{ id: OTHER, username: 'ana' }],
          }),
        },
        messagesByChannel: generalSlice(generalRows),
      }),
    );
    // The server's DM segment is not wired yet: it answers the stable 501 that
    // clients feature-detect (`search_controller.ex`'s `dm/2`).
    const fixture = await startFixture({ dmFailure: DM_NOT_AVAILABLE });
    const { instance } = mount({ store, fixture });

    await waitFor(() => frame(instance).includes('#general'));
    await press(instance, 'm');
    await waitFor(() => frame(instance).includes('ana'));
    await openSearch(instance);
    await press(instance, 'annual');
    await waitFor(() => fixture.dmQueries().includes('annual'));

    await waitFor(() => frame(instance).includes('Search is unavailable'));
    // Distinct from a generic failure: the member is told the index is down,
    // not that their query failed.
    expect(frame(instance)).not.toContain('Search failed');
  });
});

// ---------------------------------------------------------------------------
// C. Edge cases: an empty query, and a query with nothing to show
// ---------------------------------------------------------------------------

describe('C. the query surface’s states', () => {
  it('issues nothing for an empty query and says so, then renders the no-results state', async () => {
    const store = createStateStore();
    store.setState(seed({ messagesByChannel: generalSlice(generalRows) }));
    const fixture = await startFixture({ workspaceRows: () => [] });
    const { instance } = mount({ store, fixture });

    await waitFor(() => frame(instance).includes('#general'));
    await openSearch(instance);
    await tick();
    // An empty query is not a search: nothing is sent, and the pane says what
    // to do rather than showing an empty list.
    expect(fixture.searchRequests()).toEqual([]);
    expect(frame(instance)).toContain('Type to search');

    await press(instance, 'zzz');
    await waitFor(() => fixture.workspaceQueries().includes('zzz'));
    await waitFor(() => frame(instance).includes('No messages match "zzz"'));
  });

  it('resolves to the latest query, not to whichever request returns first', async () => {
    const store = createStateStore();
    store.setState(seed({ messagesByChannel: generalSlice(generalRows) }));
    // The EARLIER query is the slow one: a boolean `loading` flag would render
    // `alpha`'s rows here, because they arrive last.
    const fixture = await startFixture({
      delayMsFor: (q) => (q === 'alpha' ? 300 : 0),
      workspaceRows: (q) =>
        q === 'beta' ? [{ message_id: FAST_HIT, channel_id: C2, thread_id: null }] : [{ message_id: SLOW_HIT, channel_id: C2, thread_id: null }],
    });
    const { instance } = mount({ store, fixture });

    await waitFor(() => frame(instance).includes('#general'));
    await openSearch(instance);
    await press(instance, 'alpha');
    await waitFor(() => fixture.workspaceQueries().includes('alpha'));

    // Replace the query while `alpha` is still in flight.
    for (let i = 0; i < 'alpha'.length; i += 1) await press(instance, KEYS.backspace);
    await press(instance, 'beta');
    await waitFor(() => frame(instance).includes(`message ${FAST_HIT}`));

    // Give the superseded request more than enough time to land: it must be
    // dropped, not rendered over the query the member actually asked.
    await sleep(500);
    expect(frame(instance)).toContain(`message ${FAST_HIT}`);
    expect(frame(instance)).not.toContain(`message ${SLOW_HIT}`);
  });
});

// ---------------------------------------------------------------------------
// D. Error paths: a failed query, and no connection at all
// ---------------------------------------------------------------------------

describe('D. search failures', () => {
  it('renders an inline error and leaves the previous view intact', async () => {
    const store = createStateStore();
    store.setState(seed({ messagesByChannel: generalSlice(generalRows) }));
    const fixture = await startFixture({
      workspaceFailure: { status: 500, key: 'internal_error', message: 'the index caught fire' },
    });
    const { instance } = mount({ store, fixture });

    await waitFor(() => frame(instance).includes(GENERAL_TEXT));
    await openSearch(instance);
    await press(instance, 'deploy');
    await waitFor(() => fixture.workspaceQueries().includes('deploy'));

    await waitFor(() => frame(instance).includes('Search failed'));
    expect(frame(instance)).toContain('the index caught fire');

    // The failure is the pane's, not the session's: column one still lists the
    // workspace, the loaded slice is untouched, and Escape returns to it.
    await press(instance, KEYS.escape);
    await waitFor(() => frame(instance).includes(GENERAL_TEXT));
    expect(frame(instance)).toContain('#random');
    expect(store.getState().messagesByChannel[C1]?.items).toHaveLength(generalRows.length);
  });

  it('reports the offline state instead of hanging', async () => {
    const store = createStateStore();
    store.setState(seed({ messagesByChannel: generalSlice(generalRows) }));
    const fixture = await startFixture({
      workspaceRows: () => [{ message_id: HIT, channel_id: C2, thread_id: null }],
    });
    const { instance } = mount({ store, fixture, phase: 'offline' });

    await waitFor(() => frame(instance).includes('#general'));
    await openSearch(instance);
    await press(instance, 'deploy');
    await tick();

    // Nothing is sent, and the reason is on screen: a request that cannot
    // complete must say why rather than leave the member watching a spinner.
    await waitFor(() => frame(instance).includes('Search needs a live connection'));
    expect(fixture.searchRequests()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// E. Integration: a hit whose message is gone
// ---------------------------------------------------------------------------

describe('E. a result for a message that no longer exists', () => {
  it('renders a clear state over the conversation rather than an empty pane', async () => {
    const store = createStateStore();
    store.setState(seed({ messagesByChannel: generalSlice(generalRows) }));
    const fixture = await startFixture({
      workspaceRows: () => [{ message_id: GONE, channel_id: C1, thread_id: null }],
    });
    const { instance } = mount({ store, fixture });

    await waitFor(() => frame(instance).includes(GENERAL_TEXT));
    await openSearch(instance);
    await press(instance, 'gone');
    await waitFor(() => frame(instance).includes(`message ${GONE}`));
    await press(instance, KEYS.enter);

    // The message is gone and the CHANNEL is not: the pane keeps drawing the
    // conversation it opened, and one line says what could not be found.
    await waitFor(() => frame(instance).includes('no longer in #general'));
    expect(frame(instance)).toContain(GENERAL_TEXT);
  });
});

// ---------------------------------------------------------------------------
// F. The remaining pane states, and the two ways a result can refuse to open
// ---------------------------------------------------------------------------

describe('F. the pane’s other states', () => {
  it('shows the in-flight state while the query is on the wire', async () => {
    const store = createStateStore();
    store.setState(seed({ messagesByChannel: generalSlice(generalRows) }));
    const fixture = await startFixture({
      delayMsFor: () => 250,
      workspaceRows: () => [{ message_id: HIT, channel_id: C2, thread_id: null }],
    });
    const { instance } = mount({ store, fixture });

    await waitFor(() => frame(instance).includes('#general'));
    await openSearch(instance);
    await press(instance, 'deploy');
    // The query is out and not back: the pane says it is working rather than
    // showing an empty list the member would read as "no results".
    await waitFor(() => frame(instance).includes('… Searching'));
    expect(frame(instance)).not.toContain('No messages match');
    await waitFor(() => frame(instance).includes(`message ${HIT}`));
  });

  it('closes on Escape and forgets the query it had', async () => {
    const store = createStateStore();
    store.setState(seed({ messagesByChannel: generalSlice(generalRows) }));
    const fixture = await startFixture({
      workspaceRows: () => [{ message_id: HIT, channel_id: C2, thread_id: null }],
    });
    const { instance } = mount({ store, fixture });

    await waitFor(() => frame(instance).includes(GENERAL_TEXT));
    await openSearch(instance);
    await press(instance, 'deploy');
    await waitFor(() => frame(instance).includes(`message ${HIT}`));
    await press(instance, KEYS.escape);
    await waitFor(() => frame(instance).includes(GENERAL_TEXT));

    await openSearch(instance);
    // A fresh pane: idle, and nothing re-issued for the old query.
    await waitFor(() => frame(instance).includes('Type to search this workspace.'));
    expect(fixture.workspaceQueries()).toEqual(['deploy']);
  });

  it('opens without swallowing the next keystroke, and `i` gives the query the keyboard', async () => {
    const store = createStateStore();
    store.setState(seed({ messagesByChannel: generalSlice(generalRows) }));
    const fixture = await startFixture({
      workspaceRows: () => [{ message_id: HIT, channel_id: C2, thread_id: null }],
    });
    const marked: string[] = [];
    const { instance } = mount({ store, fixture, onMarkRead: (id) => marked.push(id) });

    await waitFor(() => frame(instance).includes('#general'));
    await press(instance, '/');
    await waitFor(() => frame(instance).includes('Search ·'));
    // The pane is on screen and its query line is NOT focused, so the columns
    // still hold the keyboard: `r` is mark-read, not the first letter of a
    // query. An accidental `/` must not eat the member's next keystroke.
    expect(frame(instance)).toContain('i writes a query');
    await press(instance, 'r');
    await waitFor(() => marked.length > 0);
    expect(marked).toEqual([C1]);

    // `i` hands the query line the keyboard and the same keys become text.
    await press(instance, 'i');
    await press(instance, 'deploy');
    await waitFor(() => fixture.workspaceQueries().includes('deploy'));
    expect(frame(instance)).toContain('deploy');
    expect(marked).toEqual([C1]);
  });

  it('says so when the host wired no search at all', async () => {
    const store = createStateStore();
    store.setState(seed({ messagesByChannel: generalSlice(generalRows) }));
    const fixture = await startFixture({});
    const { instance } = mount({ store, fixture, searchSeam: false });

    await waitFor(() => frame(instance).includes('#general'));
    await openSearch(instance);
    await press(instance, 'deploy');
    await waitFor(() => frame(instance).includes('Search is not available in this session.'));
    expect(fixture.searchRequests()).toEqual([]);
  });

  it('renders a hostile snippet, channel name, and author as inert text (R26a)', async () => {
    const store = createStateStore();
    store.setState(
      seed({
        workspaces: { [W1]: workspace({ id: W1, name: `Acme${HOSTILE}` }) },
        channels: {
          [C1]: channel({ id: C1, name: 'general', position: 0 }),
          [C2]: channel({ id: C2, name: `random${HOSTILE}`, position: 1 }),
        },
        membersById: { [OTHER]: member({ username: `ana${HOSTILE}` }) },
        messagesByChannel: generalSlice(generalRows),
      }),
    );
    // The hit's own message is NOT loaded, so the snippet drawn is the server's
    // highlight — the value KTD10 names as a terminal-injection surface.
    const fixture = await startFixture({
      workspaceRows: () => [
        { message_id: HIT, channel_id: C2, thread_id: null, highlight: `deploy${HOSTILE} window` },
      ],
    });
    const { instance } = mount({ store, fixture });

    await waitFor(() => frame(instance).includes('#general'));
    await openSearch(instance);
    await press(instance, 'deploy');
    await waitFor(() => frame(instance).includes('deploy'));

    const drawn = frame(instance);
    expect(drawn).toContain('#random');
    expect(drawn).toContain('window');
    // Not one escape sequence reached a cell, from the name, the author, the
    // workspace band, or the snippet.
    expect(drawn).not.toContain('\u001b');
  });

  it('reports a result whose conversation column one does not hold', async () => {
    const store = createStateStore();
    store.setState(seed({ messagesByChannel: generalSlice(generalRows) }));
    // The DM segment indexes a conversation this client's (empty) DM list does
    // not have: opening the row NEXT to it would be a different result.
    const fixture = await startFixture({
      dmRows: () => [{ message_id: M3, channel_id: D1, thread_id: null }],
    });
    const { instance } = mount({ store, fixture });

    await waitFor(() => frame(instance).includes('#general'));
    await press(instance, 'm');
    await waitFor(() => frame(instance).includes('No direct messages yet'));
    await openSearch(instance);
    await press(instance, 'annual');
    await waitFor(() => fixture.dmQueries().includes('annual'));
    await waitFor(() => frame(instance).includes(`message ${M3}`));

    await press(instance, KEYS.enter);
    await waitFor(() => frame(instance).includes('is not in column one'));
    // Nothing else was opened: the selection is where the member left it.
    expect(frame(instance)).toContain('No direct messages yet');
  });
});

// ---------------------------------------------------------------------------
// G. The model itself (pure): the envelope, the scope, the states, the window
// ---------------------------------------------------------------------------

describe('G. the search model', () => {
  const source: MessageSource = {
    channels: {
      [C1]: channel({ id: C1, name: 'general' }),
      [D1]: channel({
        id: D1,
        name: '',
        type: 'dm',
        workspace_id: null,
        recipients: [{ id: OTHER, username: 'ana' }],
      }),
    },
    membersById: { [OTHER]: member() },
    currentUser: { id: ME, username: 'tester' },
    messagesByChannel: {
      [C1]: { items: [...generalRows], oldestId: M1, hasCompleteHistory: true },
    },
  };

  it('scopes by column one’s mode', () => {
    expect(searchScopeFor('channels')).toBe('workspace');
    expect(searchScopeFor('dms')).toBe('dms');
  });

  it('asks nothing for an empty query, a whitespace-only one, or no workspace', () => {
    expect(buildSearchRequest({ scope: 'workspace', workspaceId: W1, query: '' })).toBeNull();
    expect(buildSearchRequest({ scope: 'workspace', workspaceId: W1, query: '   ' })).toBeNull();
    expect(buildSearchRequest({ scope: 'workspace', workspaceId: null, query: 'hi' })).toBeNull();
    expect(buildSearchRequest({ scope: 'dms', workspaceId: null, query: 'hi' })).toEqual({
      scope: 'dms',
      workspaceId: null,
      query: 'hi',
    });
    // The query travels trimmed: leading spaces are not part of what was asked.
    expect(buildSearchRequest({ scope: 'workspace', workspaceId: W1, query: '  hi ' })).toEqual({
      scope: 'workspace',
      workspaceId: W1,
      query: 'hi',
    });
  });

  it('reads the server’s envelope, tolerates the declared one, and drops what it cannot open', () => {
    // M3 is authored by the other member, so the author comes from the roster.
    const hit = { message_id: M3, channel_id: C1, thread_id: null };
    const rows = readSearchRows({ results: [hit, { message_id: M1 }] }, {
      source,
      scope: 'workspace',
    });
    // The second entry names no channel: a row that cannot be opened is not drawn.
    expect(rows.map((row) => row.messageId)).toEqual([M3]);
    // The name, the author and the time come from the STORE (the wire has none).
    expect(rows[0]?.where).toBe('#general');
    expect(rows[0]?.author).toBe('ana');
    expect(rows[0]?.time).toMatch(/^\d{2}:\d{2}$/);
    expect(rows[0]?.snippet).toBe('third');

    // The spelling the api-client's declared `SearchResult` promises.
    expect(
      readSearchRows({ items: [hit] }, { source, scope: 'workspace' }).map((row) => row.messageId),
    ).toEqual([M3]);
    // Anything else is an empty result set, not an exception.
    expect(readSearchRows(null, { source, scope: 'workspace' })).toEqual([]);
    expect(readSearchRows({ results: 'nope' }, { source, scope: 'workspace' })).toEqual([]);
  });

  it('names a DM by its peer and a message it does not hold by its id', () => {
    const rows = readSearchRows(
      { results: [{ message_id: GONE, channel_id: D1, thread_id: null, highlight: ' a  b ' }] },
      { source, scope: 'dms' },
    );
    expect(rows[0]?.where).toBe('ana');
    expect(rows[0]?.author).toBeNull();
    // The server's snippet wins when it sends one, with its runs collapsed.
    expect(rows[0]?.snippet).toBe('a b');
    expect(searchRowText(rows[0]!)).toBe('ana · a b');

    const bare = readSearchRows({ results: [{ message_id: M2, channel_id: UNKNOWN }] }, {
      source,
      scope: 'workspace',
    })[0]!;
    // A hit whose conversation the store does not hold is named by its id
    // rather than by a label this client cannot vouch for.
    expect(searchRowText({ ...bare, snippet: '', author: null })).toBe(
      `channel ${UNKNOWN} · message ${M2}`,
    );
  });

  it('makes every server string inert, the snippet included (R26a)', () => {
    const rows = readSearchRows(
      {
        results: [
          { message_id: M2, channel_id: D1, thread_id: null, highlight: `x${HOSTILE} y` },
        ],
      },
      {
        source: {
          ...source,
          channels: {
            [D1]: channel({
              id: D1,
              name: '',
              type: 'dm',
              workspace_id: null,
              recipients: [{ id: OTHER, username: `ana${HOSTILE}` }],
            }),
          },
        },
        scope: 'dms',
      },
    );
    expect(rows[0]?.where).toBe('ana own every terminal');
    expect(rows[0]?.snippet).not.toMatch(/\u001b/);
    expect(searchRowText(rows[0]!)).not.toMatch(/\u001b/);
    // The name survives as TEXT — the sanitizer removes sequences, it never
    // invents or truncates a value.
    expect(searchRowText(rows[0]!)).toContain('ana own every terminal');
  });

  it('tells the index being down apart from the query failing', () => {
    expect(classifySearchFailure({ status: 501, key: 'search_not_available' }).status).toBe(
      'unavailable',
    );
    expect(classifySearchFailure({ key: 'search_not_available' }).status).toBe('unavailable');
    const failed = classifySearchFailure(new Error('the index caught fire'));
    expect(failed.status).toBe('error');
    expect(failed.notice).toContain('the index caught fire');
    // The cause is inert too: a transport message can be server-supplied.
    expect(classifySearchFailure(`x${HOSTILE}`).notice).not.toMatch(/\u001b/);
  });

  it('keeps the cursor inside the window it draws', () => {
    expect(searchWindow(0, 0, 3)).toEqual({ start: 0, count: 0 });
    expect(searchWindow(10, 0, 3)).toEqual({ start: 0, count: 3 });
    expect(searchWindow(10, 9, 3)).toEqual({ start: 7, count: 3 });
    expect(searchWindow(2, 1, 5)).toEqual({ start: 0, count: 2 });
    // A cursor past the end (a shrunken result set) is clamped, never dropped.
    expect(searchWindow(2, 9, 5)).toEqual({ start: 0, count: 2 });
  });

  it('states the two ways a jump cannot land, and names the conversation', () => {
    expect(jumpUnresolvedNotice({ where: '#general', atStart: true })).toContain(
      'no longer in #general',
    );
    expect(jumpUnresolvedNotice({ where: '#general', atStart: false })).toContain(
      'loaded history',
    );
    // A hostile channel name cannot ride into the line.
    expect(jumpUnresolvedNotice({ where: HOSTILE, atStart: true })).not.toMatch(/\u001b/);
  });

  it('builds the idle and empty panes with the words the member needs', () => {
    expect(idleSearchPane('workspace').notice).toBe('Type to search this workspace.');
    expect(idleSearchPane('dms').notice).toBe('Type to search your direct messages.');
    expect(loadingSearchPane('x').status).toBe('loading');
    expect(resultsSearchPane('x', []).status).toBe('empty');
    expect(searchEmptyNotice(HOSTILE)).not.toMatch(/\u001b/);
  });
});
