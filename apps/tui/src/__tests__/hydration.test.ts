/**
 * @cytale/tui — U12's REST hydration: the one owned load path that gives column
 * one its data (R15, R16, R17).
 *
 * The servers here are real HTTP servers on loopback, read through a real
 * `@cytale/api-client`, and every assertion is taken off the real
 * `@cytale/state` store — so "column one has data to render" means the shared
 * store holds rows in the shape U6's column renders from, not that a stub was
 * called. Two of those shapes are NOT what the api-client's own types claim,
 * which is why the normalizers in `hydration.ts` exist and are asserted here
 * against payloads copied from the controllers that serve them:
 *
 *   * `GET /users/@me/channels` (`DmController.index`) answers DM rows with no
 *     `type`, no `workspace_id`, and no `name` at all. Written through
 *     verbatim they fail the DM column's `type === 'dm'` filter — the drawer
 *     renders "no conversations" against a live session.
 *   * `GET /workspaces/{id}/people` (`UserController.people`) NESTS the user
 *     under `user` (the shape apps/web's directory API consumes). Read as the
 *     flat `WorkspaceMember` the api-client declares, every member id is
 *     `undefined` and the roster map is keyed by one junk entry.
 *
 * The column RENDER is U6's; this file asserts the store that column reads,
 * plus the snapshot a shell renders its loading/empty/error state from.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { CytaleApiClient, PEOPLE_PAGE_CAP, createInMemoryTokenProvider } from '@cytale/api-client';
import type { GatewayEvent } from '@cytale/protocol';
import { applyGatewayEvent, createStateStore, type StateStore } from '@cytale/state';

import {
  HYDRATION_CONCURRENCY,
  createHydrator,
  noWorkspacesNotice,
  type HydrationPhase,
  type Hydrator,
} from '../session/hydration.js';

// ---------------------------------------------------------------------------
// Fixture: a real Cytale-shaped server
// ---------------------------------------------------------------------------

/** The server's numeric type column: 0 = text, 1 = category. */
interface ChannelFixture {
  id: string;
  name: string;
  type?: 0 | 1;
  parent_id?: string | null;
  position?: number;
  last_message_id?: string | null;
}

interface PersonFixture {
  id: string;
  username: string;
}

interface WorkspaceFixture {
  id: string;
  name: string;
  channels: ChannelFixture[];
  people: PersonFixture[];
}

interface DmFixture {
  id: string;
  peer: { id: string; username: string };
  last_message_id?: string | null;
}

interface Fixture {
  readonly origin: string;
  /** Every path the server answered, in order. */
  readonly requests: readonly string[];
  /** Peak concurrent in-flight requests the server observed. */
  peakConcurrency(): number;
  /** Answer `path` with `status` (500 by default) instead of its fixture body. */
  fail(path: string, status?: number): void;
  close(): Promise<void>;
}

interface FixtureOptions {
  workspaces: WorkspaceFixture[];
  dms?: DmFixture[];
  /**
   * Serve roster pages of this size, each with an ADVANCING `next_before`
   * cursor — the shape that walks `listAllPeople` into its page cap.
   */
  peoplePageSize?: number;
  /** Hold every response this long, so overlapping legs are observable. */
  delayMs?: number;
}

const alive = new Set<Server>();

afterEach(async () => {
  for (const hydrator of hydrators.splice(0)) hydrator.stop();
  for (const server of [...alive]) {
    alive.delete(server);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});

const hydrators: Hydrator[] = [];

async function startFixture(options: FixtureOptions): Promise<Fixture> {
  const failures = new Map<string, number>();
  const requests: string[] = [];
  const servedPages = new Map<string, number>();
  const delayMs = options.delayMs ?? 0;
  const pageSize = options.peoplePageSize ?? null;

  let inFlight = 0;
  let peak = 0;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    requests.push(path);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    res.on('finish', () => {
      inFlight -= 1;
    });

    const send = (status: number, body: unknown): void => {
      setTimeout(() => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      }, delayMs);
    };

    const refusal = failures.get(path);
    if (refusal !== undefined) {
      send(refusal, {
        error: { key: 'internal_error', code: 50001, message: 'the fixture refused this read' },
      });
      return;
    }

    // UserController.index — the workspaces of the caller.
    if (path === '/api/v1/users/@me/workspaces') {
      send(200, {
        workspaces: options.workspaces.map((w) => ({
          id: w.id,
          name: w.name,
          owner_id: '1',
          created_at: '2026-09-01T00:00:00Z',
          icon_url: null,
        })),
      });
      return;
    }

    // DmController.index — DM rows carry no `type`, no `workspace_id`, no `name`.
    if (path === '/api/v1/users/@me/channels') {
      send(200, {
        channels: (options.dms ?? []).map((dm) => ({
          id: dm.id,
          user_ids: [dm.peer.id, '1'],
          recipients: [{ id: dm.peer.id, username: dm.peer.username, avatar_url: null }],
          created_at: '2026-09-01T00:00:00Z',
          last_message_id: dm.last_message_id ?? null,
        })),
      });
      return;
    }

    const channels = /^\/api\/v1\/workspaces\/([^/]+)\/channels$/.exec(path);
    if (channels !== null) {
      const workspace = options.workspaces.find((w) => w.id === channels[1]);
      send(200, {
        channels: (workspace?.channels ?? []).map((c) => ({
          id: c.id,
          workspace_id: workspace?.id ?? null,
          name: c.name,
          type: c.type ?? 0,
          parent_id: c.parent_id ?? null,
          topic: null,
          position: c.position ?? 0,
          last_message_id: c.last_message_id ?? null,
        })),
      });
      return;
    }

    // UserController.people — the user is NESTED under `user`.
    const people = /^\/api\/v1\/workspaces\/([^/]+)\/people$/.exec(path);
    if (people !== null) {
      const workspaceId = people[1] as string;
      const workspace = options.workspaces.find((w) => w.id === workspaceId);
      const page = servedPages.get(workspaceId) ?? 0;
      servedPages.set(workspaceId, page + 1);
      const rows: PersonFixture[] =
        pageSize === null
          ? (workspace?.people ?? [])
          : Array.from({ length: pageSize }, (_, i) => ({
              id: `${workspaceId}-${page}-${i}`,
              username: `member${i}`,
            }));
      send(200, {
        people: rows.map((p) => ({
          user: { id: p.id, username: p.username, avatar_url: null },
          nickname: null,
          joined_at: '2026-09-01T00:00:00Z',
          roles: [],
          kind: 'human',
        })),
        next_before: pageSize === null ? null : (rows[rows.length - 1]?.id ?? null),
      });
      return;
    }

    send(404, { error: { key: 'not_found', code: 40401, message: 'no route' } });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  alive.add(server);
  const address = server.address() as AddressInfo | null;
  if (address === null) throw new Error('the fixture server did not bind');

  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    peakConcurrency: () => peak,
    fail: (path, status = 500) => failures.set(path, status),
    close: async () => {
      alive.delete(server);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

// ---------------------------------------------------------------------------
// The graph the standard fixture serves
// ---------------------------------------------------------------------------

const ALPHA = '900000000000000010';
const BETA = '900000000000000011';
const DM_ONE = '900000000000000200';
const PEER = '900000000000000300';

const DM_FIXTURE: DmFixture[] = [{ id: DM_ONE, peer: { id: PEER, username: 'dee' } }];

function standardWorkspaces(): WorkspaceFixture[] {
  return [
    {
      id: ALPHA,
      name: 'Alpha',
      channels: [
        { id: '100', name: 'general', type: 0, position: 0 },
        { id: '101', name: 'Projects', type: 1, position: 1 },
        { id: '102', name: 'dev', type: 0, parent_id: '101', position: 0 },
      ],
      people: [
        { id: '1000', username: 'ace' },
        { id: '1001', username: 'boa' },
      ],
    },
    {
      id: BETA,
      name: 'Beta',
      channels: [{ id: '110', name: 'general', type: 0, position: 0 }],
      people: [{ id: '1002', username: 'cy' }],
    },
  ];
}

function makeApi(origin: string): CytaleApiClient {
  return new CytaleApiClient({
    baseUrl: `${origin}/api/v1`,
    tokens: createInMemoryTokenProvider({
      access_token: 'test-access-token',
      refresh_token: '',
      expires_in: 900,
    }),
  });
}

/** A hydrator over a fresh store, registered for teardown in `afterEach`. */
function makeHydrator(fixture: Fixture): { store: StateStore; hydrator: Hydrator } {
  const store = createStateStore();
  const hydrator = createHydrator({ api: makeApi(fixture.origin), store, origin: fixture.origin });
  hydrators.push(hydrator);
  return { store, hydrator };
}

/** One graph slice, sorted so two loads are comparable — duplicate rows included. */
type GraphSlice = Array<[string, unknown]>;

interface Graph {
  workspaces: GraphSlice;
  channels: GraphSlice;
  membersById: GraphSlice;
  memberIdsByWorkspace: GraphSlice;
}

/** The graph slices, sorted so two loads are comparable (and duplicate rows visible). */
function graphOf(store: StateStore): Graph {
  const state = store.getState();
  const byKey = (record: Record<string, unknown>): GraphSlice =>
    Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    workspaces: byKey(state.workspaces),
    channels: byKey(state.channels),
    membersById: byKey(state.membersById),
    memberIdsByWorkspace: byKey(state.memberIdsByWorkspace),
  };
}

function readyEvent(s: number): GatewayEvent {
  return {
    op: 0,
    t: 'Ready',
    s,
    d: {
      v: 1,
      session_id: 'session-1',
      resume_token: 'resume-1',
      heartbeat_interval: 30,
      user: { id: '1', username: 'tester' },
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  throw new Error('timed out waiting for the load');
}

// ---------------------------------------------------------------------------
// The boot load: column one's data (R15, R16, R17)
// ---------------------------------------------------------------------------

describe('the boot load', () => {
  it('gives column one its workspaces, grouped channels, roster, and DMs', async () => {
    const fixture = await startFixture({ workspaces: standardWorkspaces(), dms: DM_FIXTURE });
    const { store, hydrator } = makeHydrator(fixture);

    expect(hydrator.snapshot().phase).toBe('idle');
    const snapshot = await hydrator.start();

    expect(snapshot.phase).toBe('ready');
    expect(snapshot.notice).toBeNull();
    expect(snapshot.error).toBeNull();
    expect(snapshot.errorDetail).toBeNull();
    expect(snapshot.channelsFailed).toEqual([]);
    expect(snapshot.membersFailed).toEqual([]);
    expect(snapshot.rostersTruncated).toEqual([]);
    expect(snapshot.dmsFailed).toBe(false);

    const state = store.getState();
    // Workspaces (R15: the shell has something to switch between).
    expect(Object.keys(state.workspaces).sort()).toEqual([ALPHA, BETA].sort());
    expect(state.workspaces[ALPHA]?.name).toBe('Alpha');

    // R16: the active workspace's channels, category included, groupable by
    // `parent_id` (U6 groups on it) and typed by the shared union.
    expect(Object.keys(state.channels).sort()).toEqual(['100', '101', '102', '110', DM_ONE].sort());
    expect(state.channels['101']).toMatchObject({ name: 'Projects', type: 'category', workspace_id: ALPHA });
    expect(state.channels['102']).toMatchObject({ name: 'dev', type: 'text', parent_id: '101' });
    expect(state.channels['100']?.parent_id).toBeNull();

    // The roster: real member rows, indexed per workspace, in read order.
    expect(state.membersById['1000']).toMatchObject({ id: '1000', username: 'ace', roles: [] });
    expect(state.memberIdsByWorkspace[ALPHA]).toEqual(['1000', '1001']);
    expect(state.memberIdsByWorkspace[BETA]).toEqual(['1002']);

    // R17: DMs are account-wide rows in the same map — and typed, or the DM
    // column's `type === 'dm'` filter never sees them.
    expect(state.channels[DM_ONE]).toMatchObject({
      type: 'dm',
      workspace_id: null,
      last_message_id: null,
    });
    expect(state.channels[DM_ONE]?.recipients).toEqual([
      { id: PEER, username: 'dee', avatar_url: null },
    ]);

    // One owned load path: exactly one read per leg.
    expect(fixture.requests.filter((p) => p === '/api/v1/users/@me/workspaces')).toHaveLength(1);
    expect(fixture.requests.filter((p) => p === '/api/v1/users/@me/channels')).toHaveLength(1);
    expect(fixture.requests.filter((p) => p === `/api/v1/workspaces/${ALPHA}/channels`)).toHaveLength(1);
    expect(fixture.requests.filter((p) => p === `/api/v1/workspaces/${BETA}/channels`)).toHaveLength(1);
    expect(fixture.requests.filter((p) => p.endsWith('/people'))).toHaveLength(2);
  });

  it('reports idle before a load, loading while it runs, and notifies subscribers', async () => {
    const fixture = await startFixture({ workspaces: standardWorkspaces(), dms: DM_FIXTURE, delayMs: 20 });
    const { hydrator } = makeHydrator(fixture);

    const seen: HydrationPhase[] = [];
    hydrator.subscribe((snapshot) => seen.push(snapshot.phase));
    expect(hydrator.snapshot().phase).toBe('idle');

    const running = hydrator.start();
    // Published synchronously, before the first response can land.
    expect(hydrator.snapshot().phase).toBe('loading');

    await running;
    expect(seen).toEqual(['loading', 'ready']);
    expect(hydrator.snapshot().phase).toBe('ready');
  });

  it('readies a single-workspace member with no selection step to take', async () => {
    const fixture = await startFixture({ workspaces: [standardWorkspaces()[0] as WorkspaceFixture] });
    const { store, hydrator } = makeHydrator(fixture);

    const snapshot = await hydrator.start();

    // Not the zero-workspace state: the shell has exactly one candidate for
    // U6's client-local "pick the first" rule, so nothing is asked of the member.
    expect(snapshot.phase).toBe('ready');
    expect(snapshot.notice).toBeNull();
    expect(Object.keys(store.getState().workspaces)).toEqual([ALPHA]);
  });
});

// ---------------------------------------------------------------------------
// Reconnect: the load is bound to the session
// ---------------------------------------------------------------------------

describe('a fresh gateway session', () => {
  it('re-runs the load and converges on the same graph, with no duplicated rows', async () => {
    const fixture = await startFixture({ workspaces: standardWorkspaces(), dms: DM_FIXTURE });
    const { store, hydrator } = makeHydrator(fixture);

    await hydrator.start();
    const first = graphOf(store);
    const requestsPerLoad = fixture.requests.length;
    expect(requestsPerLoad).toBe(6); // workspaces + 2 channels + 2 rosters + DMs

    // A fresh READY: the store's graph STAYS as stale content (lane D #1 —
    // the wipe-then-refill painted an empty column one on every reconnect);
    // the epoch re-runs the load, which replaces it whole.
    applyGatewayEvent(store, readyEvent(1));
    expect(graphOf(store)).toEqual(first);

    // Wait for the re-run itself (the graph never emptied, so the slices
    // alone cannot say it happened), then for every slice: a leg the server
    // has answered but the store has not been written from would race the
    // compare.
    await waitFor(() => fixture.requests.length === requestsPerLoad * 2);
    await waitFor(() => {
      const state = store.getState();
      return (
        hydrator.snapshot().phase === 'ready' &&
        Object.keys(state.workspaces).length === 2 &&
        Object.keys(state.channels).length === 5 &&
        Object.keys(state.membersById).length === 3 &&
        Object.keys(state.memberIdsByWorkspace).length === 2
      );
    });

    // Converged: the same graph, row for row — the id-keyed maps replace
    // rather than accumulate, so a second load cannot double the column.
    expect(graphOf(store)).toEqual(first);
    for (const ids of Object.values(store.getState().memberIdsByWorkspace)) {
      expect(new Set(ids).size).toBe(ids.length);
    }
    expect(fixture.requests.length).toBe(requestsPerLoad * 2);
    expect(hydrator.snapshot().phase).toBe('ready');
  });

  it('stops following the session once stopped', async () => {
    const fixture = await startFixture({ workspaces: standardWorkspaces(), dms: DM_FIXTURE });
    const { store, hydrator } = makeHydrator(fixture);
    await hydrator.start();
    hydrator.stop();

    const before = fixture.requests.length;
    applyGatewayEvent(store, readyEvent(1));
    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });

    expect(fixture.requests.length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Empty results are not failures
// ---------------------------------------------------------------------------

describe('empty results', () => {
  it('names the browser URL for a member with no workspaces, and still loads DMs', async () => {
    const fixture = await startFixture({ workspaces: [], dms: DM_FIXTURE });
    const { store, hydrator } = makeHydrator(fixture);

    const snapshot = await hydrator.start();

    // Not the generic failure state: an invite-pending member is in a correct
    // state, and the message says where to go rather than what went wrong.
    expect(snapshot.phase).toBe('empty');
    expect(snapshot.error).toBeNull();
    expect(snapshot.notice).toBe(noWorkspacesNotice(fixture.origin));
    expect(snapshot.notice).toContain(fixture.origin);
    expect(snapshot.notice).toContain('browser');

    // R17 holds with no workspace at all.
    expect(store.getState().workspaces).toEqual({});
    expect(store.getState().channels[DM_ONE]?.type).toBe('dm');
  });

  it('treats an empty workspace as a usable shell, not a failed read', async () => {
    const fixture = await startFixture({
      workspaces: [{ id: ALPHA, name: 'Alpha', channels: [], people: [] }],
    });
    const { store, hydrator } = makeHydrator(fixture);

    const snapshot = await hydrator.start();

    expect(snapshot.phase).toBe('ready');
    expect(snapshot.channelsFailed).toEqual([]);
    expect(snapshot.membersFailed).toEqual([]);
    expect(snapshot.notice).toBeNull();
    expect(store.getState().channels).toEqual({});
    expect(store.getState().memberIdsByWorkspace[ALPHA]).toEqual([]);
  });

  it('reports a roster that hit the page cap instead of silently dropping members', async () => {
    const fixture = await startFixture({
      workspaces: [standardWorkspaces()[0] as WorkspaceFixture],
      peoplePageSize: 50,
    });
    const { hydrator } = makeHydrator(fixture);

    const snapshot = await hydrator.start();

    expect(snapshot.phase).toBe('ready');
    expect(snapshot.rostersTruncated).toEqual([ALPHA]);
    expect(fixture.requests.filter((p) => p.endsWith('/people'))).toHaveLength(PEOPLE_PAGE_CAP);
  });
});

// ---------------------------------------------------------------------------
// The fan-out is bounded
// ---------------------------------------------------------------------------

describe('the fan-out', () => {
  it('bounds concurrent legs at HYDRATION_CONCURRENCY, and still runs parallel', async () => {
    const workspaces: WorkspaceFixture[] = Array.from({ length: 6 }, (_, i) => ({
      id: `30000000000000000${i}`,
      name: `W${i}`,
      channels: [{ id: `40000000000000000${i}`, name: 'general', type: 0 }],
      people: [{ id: `50000000000000000${i}`, username: `u${i}` }],
    }));
    const fixture = await startFixture({ workspaces, dms: DM_FIXTURE, delayMs: 40 });
    const { hydrator } = makeHydrator(fixture);

    const snapshot = await hydrator.start();

    expect(snapshot.phase).toBe('ready');
    // 1 workspaces read + 6 channel reads + 6 roster reads + 1 DM read.
    expect(fixture.requests).toHaveLength(14);
    // Observed on the wire, not read off the constant: 14 legs against 40 ms
    // responses saturate a 4-wide pool (measured peak: 4). An unbounded fan
    // peaks at 14 here and a serial one at 1, so both regressions are visible.
    expect(fixture.peakConcurrency()).toBeGreaterThan(1);
    expect(fixture.peakConcurrency()).toBeLessThanOrEqual(HYDRATION_CONCURRENCY);
  });
});

// ---------------------------------------------------------------------------
// Partial failure: the workspace list is fatal, the sub-fetches degrade
// ---------------------------------------------------------------------------

describe('partial failure', () => {
  it('fails fatally, and writes nothing, when the workspace list cannot be read', async () => {
    const fixture = await startFixture({ workspaces: standardWorkspaces(), dms: DM_FIXTURE });
    const { store, hydrator } = makeHydrator(fixture);
    fixture.fail('/api/v1/users/@me/workspaces');

    const snapshot = await hydrator.start();

    expect(snapshot.phase).toBe('failed');
    expect(snapshot.error).toContain('Could not load your workspaces');
    expect(snapshot.errorDetail).toContain('refused this read');
    expect(snapshot.notice).toBeNull();
    // Nothing usable arrived, so nothing was written — and no sub-fetch was
    // issued against a workspace list that does not exist.
    expect(store.getState().workspaces).toEqual({});
    expect(store.getState().channels).toEqual({});
    expect(fixture.requests).toHaveLength(1);
  });

  it('degrades a failed channel or roster read without touching the others', async () => {
    const fixture = await startFixture({ workspaces: standardWorkspaces(), dms: DM_FIXTURE });
    const { store, hydrator } = makeHydrator(fixture);
    fixture.fail(`/api/v1/workspaces/${BETA}/channels`);
    fixture.fail(`/api/v1/workspaces/${ALPHA}/people`);

    const snapshot = await hydrator.start();

    // Column one only: the shell is ready, and it knows exactly which reads
    // failed rather than rendering an empty workspace as "no channels".
    expect(snapshot.phase).toBe('ready');
    expect(snapshot.error).toBeNull();
    expect(snapshot.channelsFailed).toEqual([BETA]);
    expect(snapshot.membersFailed).toEqual([ALPHA]);
    expect(store.getState().channels['100']).toBeDefined();
    expect(store.getState().channels['110']).toBeUndefined();
    expect(store.getState().memberIdsByWorkspace[BETA]).toEqual(['1002']);
    expect(store.getState().memberIdsByWorkspace[ALPHA]).toBeUndefined();
    // The account-wide legs are independent of both.
    expect(store.getState().channels[DM_ONE]?.type).toBe('dm');
  });

  it('keeps the channel graph when the DM read fails', async () => {
    const fixture = await startFixture({ workspaces: standardWorkspaces(), dms: DM_FIXTURE });
    const { store, hydrator } = makeHydrator(fixture);
    fixture.fail('/api/v1/users/@me/channels');

    const snapshot = await hydrator.start();

    expect(snapshot.phase).toBe('ready');
    expect(snapshot.dmsFailed).toBe(true);
    expect(store.getState().channels[DM_ONE]).toBeUndefined();
    expect(store.getState().channels['100']).toBeDefined();
  });

  it('keeps a rendered graph when a re-run fails, rather than blanking column one', async () => {
    const fixture = await startFixture({ workspaces: standardWorkspaces(), dms: DM_FIXTURE });
    const { store, hydrator } = makeHydrator(fixture);
    await hydrator.start();

    fixture.fail('/api/v1/users/@me/workspaces');
    const snapshot = await hydrator.run();

    // The retry failed, and the member is told — but the graph that is already
    // rendered stays rendered (the session will retry it again on reconnect).
    expect(snapshot.phase).toBe('ready');
    expect(snapshot.error).toContain('Could not load your workspaces');
    expect(store.getState().channels['100']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Integration: the gateway folds its events into the graph this load wrote
// ---------------------------------------------------------------------------

describe('the loaded graph and the gateway', () => {
  it('holds one record per row as the gateway folds its own events in', async () => {
    const fixture = await startFixture({ workspaces: standardWorkspaces(), dms: DM_FIXTURE });
    const { store, hydrator } = makeHydrator(fixture);
    await hydrator.start();

    // A channel the load never saw.
    applyGatewayEvent(store, {
      op: 0,
      t: 'ChannelCreate',
      s: 1,
      d: { id: '120', workspace_id: ALPHA, name: 'new', position: 5, created_at: '2026-09-13T00:00:00Z' },
    });
    // A rename lands on the SAME row the load wrote — not a second record.
    applyGatewayEvent(store, { op: 0, t: 'ChannelUpdate', s: 2, d: { id: '102', name: 'dev-renamed' } });
    // A member-add for someone the roster already holds does not duplicate the id.
    applyGatewayEvent(store, {
      op: 0,
      t: 'MemberAdd',
      s: 3,
      d: { workspace_id: ALPHA, joined_at: '2026-09-13T00:00:00Z', user: { id: '1000', username: 'ace' } },
    });
    // A peer's profile change reaches the DM row the load normalized.
    applyGatewayEvent(store, { op: 0, t: 'UserUpdate', s: 4, d: { id: PEER, username: 'dee-renamed' } });

    const state = store.getState();
    expect(Object.keys(state.channels).sort()).toEqual(['100', '101', '102', '110', '120', DM_ONE].sort());
    // REST-only fields survive an event that patched the same row.
    expect(state.channels['102']).toMatchObject({ name: 'dev-renamed', type: 'text', parent_id: '101' });
    expect(state.channels['120']).toMatchObject({ name: 'new', type: 'text', workspace_id: ALPHA });
    expect(state.memberIdsByWorkspace[ALPHA]).toEqual(['1000', '1001']);
    // The normalization is stable under the store's own event folding: the DM
    // row is still a DM row, with the peer summary patched in place.
    expect(state.channels[DM_ONE]).toMatchObject({ type: 'dm' });
    expect(state.channels[DM_ONE]?.recipients).toEqual([
      { id: PEER, username: 'dee-renamed', avatar_url: null },
    ]);
  });
});
