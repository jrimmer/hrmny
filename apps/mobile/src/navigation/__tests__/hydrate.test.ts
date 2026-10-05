/**
 * `hydrateStore` contract tests (code-review residual 4 + the launch/
 * reconnect cost pass).
 *
 * The bootstrap has exactly ONE non-partial leg: the workspace list. With no
 * workspaces nothing in the shell is usable, so a failure there rejects and
 * the producer (`StoreHydrator` in session.tsx) surfaces it. Channels and
 * people are per-workspace sub-fetches — additive, so a failure there
 * resolves with what did arrive, exactly like the web app's fan-out.
 *
 * The launch-cost half is proven by COUNTING requests from a fake client
 * (proof-first for P1): thread metadata must not be fetched at all, the
 * per-workspace legs must stay inside the pool, the roster must be paged, and
 * a store that already holds the graph must cost nothing.
 */
import type { CytaleApiClient } from '@cytale/api-client';
import type { Channel, Thread, Workspace, WorkspaceMember } from '@cytale/domain';

import { HYDRATION_CONCURRENCY, hydrateStore } from '../hydrate';
import { defaultStore } from '../store';
import { IDS, resetShellStore, seedShellStore } from './support';

const CURSOR = { before: null, after: null, limit: 25 };
const AT = '2026-09-08T00:00:00.000Z';

const WS1: Workspace = {
  id: IDS.ws1,
  name: 'JMC',
  owner_id: IDS.me,
  role_version: 1,
  created_at: AT,
};
const WS2: Workspace = { ...WS1, id: IDS.ws2, name: 'Starbug' };

const GENERAL: Channel = {
  id: IDS.general,
  workspace_id: IDS.ws1,
  name: 'general',
  type: 'text',
  topic: null,
  position: 0,
  last_message_id: null,
  created_at: AT,
};
const OTHER: Channel = { ...GENERAL, id: IDS.other, workspace_id: IDS.ws2, name: 'starbug-general' };

const THREAD: Thread = {
  id: IDS.thread,
  channel_id: IDS.general,
  parent_message_id: null,
  name: 'ship it',
  created_by: IDS.me,
  archived: false,
  created_at: AT,
};

const MEMBER: WorkspaceMember = {
  id: IDS.me,
  username: 'rowan',
  nickname: null,
  joined_at: AT,
  roles: [],
};

function member(index: number, workspaceId: string): WorkspaceMember {
  return {
    ...MEMBER,
    id: `${workspaceId}-${index}`,
    username: `member-${index}`,
  };
}

function workspace(index: number): Workspace {
  return { ...WS1, id: `ws-${index}`, name: `Workspace ${index}` };
}

function channel(index: number, ws: Workspace): Channel {
  return { ...GENERAL, id: `${ws.id}-channel-${index}`, workspace_id: ws.id, name: `channel-${index}` };
}

interface FakeApi {
  listWorkspaces: jest.Mock;
  listChannels: jest.Mock;
  listThreads: jest.Mock;
  listPeople: jest.Mock;
  listAllPeople: jest.Mock;
}

/** What the fake recorded: every request in order, and the pool's high-water mark. */
interface Requests {
  calls: string[];
  maxInFlight: number;
}

/** Responders replace the default shape per method; they are still recorded. */
type Responder = (...args: never[]) => unknown;

function fakeApi(
  overrides: Partial<Record<keyof FakeApi, Responder>> = {},
): { api: CytaleApiClient; requests: Requests } {
  const requests: Requests = { calls: [], maxInFlight: 0 };
  let inFlight = 0;

  const responders: Record<keyof FakeApi, Responder> = {
    listWorkspaces: () => ({ items: [WS1], cursor: CURSOR }),
    listChannels: () => ({ items: [GENERAL], cursor: CURSOR }),
    listThreads: () => [THREAD],
    listPeople: () => ({ items: [MEMBER], cursor: CURSOR }),
    listAllPeople: () => ({ items: [MEMBER], truncated: false }),
    ...overrides,
  };

  const mocked = (label: string, respond: Responder): jest.Mock =>
    jest.fn(async (...args: never[]) => {
      requests.calls.push(label);
      inFlight += 1;
      requests.maxInFlight = Math.max(requests.maxInFlight, inFlight);
      try {
        // A macrotask hop per request: without it the mocked legs settle
        // inside the first microtask drain and the pool measurement is noise.
        await new Promise((resolve) => setTimeout(resolve, 0));
        return respond(...args);
      } finally {
        inFlight -= 1;
      }
    });

  const api = Object.fromEntries(
    (Object.keys(responders) as (keyof FakeApi)[]).map((key) => [key, mocked(key, responders[key])]),
  );
  return { api: api as unknown as CytaleApiClient, requests };
}

beforeEach(() => {
  resetShellStore();
});

describe('hydrateStore — contract', () => {
  it('writes the workspace graph and resolves on a full success', async () => {
    const { api } = fakeApi();

    await expect(hydrateStore(api, defaultStore)).resolves.toBeUndefined();

    const state = defaultStore.getState();
    expect(Object.keys(state.workspaces)).toEqual([IDS.ws1]);
    expect(Object.keys(state.channels)).toEqual([IDS.general]);
    expect(Object.keys(state.membersById)).toEqual([IDS.me]);
    expect(state.memberIdsByWorkspace[IDS.ws1]).toEqual([IDS.me]);
  });

  it('rejects when the workspace list cannot be fetched — nothing is usable', async () => {
    const { api } = fakeApi({
      listWorkspaces: async () => {
        throw new Error('workspaces unavailable');
      },
    });

    await expect(hydrateStore(api, defaultStore)).rejects.toThrow('workspaces unavailable');

    // The rejection is non-partial: no workspace, and no sub-fetch attempted.
    const state = defaultStore.getState();
    expect(state.workspaces).toEqual({});
    expect(state.channels).toEqual({});
    expect(api.listChannels).not.toHaveBeenCalled();
  });

  it('resolves when one workspace’s channel fetch fails, keeping the other', async () => {
    const { api } = fakeApi({
      listWorkspaces: async () => ({ items: [WS1, WS2], cursor: CURSOR }),
      listChannels: async (workspaceId: string) => {
        if (workspaceId === IDS.ws2) throw new Error('channels unavailable');
        return { items: [GENERAL], cursor: CURSOR };
      },
    });

    await expect(hydrateStore(api, defaultStore)).resolves.toBeUndefined();

    const state = defaultStore.getState();
    expect(Object.keys(state.workspaces).sort()).toEqual([IDS.ws1, IDS.ws2]);
    expect(Object.keys(state.channels)).toEqual([IDS.general]);
    // The roster is a separate leg and still lands for both workspaces.
    expect(api.listAllPeople).toHaveBeenCalledTimes(2);
  });

  it('resolves when the roster sub-fetch fails', async () => {
    const { api } = fakeApi({
      listAllPeople: async () => {
        throw new Error('people unavailable');
      },
    });

    await expect(hydrateStore(api, defaultStore)).resolves.toBeUndefined();

    const state = defaultStore.getState();
    expect(Object.keys(state.channels)).toEqual([IDS.general]);
    expect(state.membersById).toEqual({});
  });
});

describe('hydrateStore — launch cost', () => {
  /** The account the review modelled: 6 workspaces × 30 channels. */
  function modelledAccount(workspaceCount: number, channelsPerWorkspace: number) {
    const workspaces = Array.from({ length: workspaceCount }, (_, i) => workspace(i));
    const channels = workspaces.flatMap((ws) =>
      Array.from({ length: channelsPerWorkspace }, (_, i) => channel(i, ws)),
    );
    return fakeApi({
      listWorkspaces: async () => ({ items: workspaces, cursor: CURSOR }),
      listChannels: async (workspaceId: string) => ({
        items: channels.filter((c) => c.workspace_id === workspaceId),
        cursor: CURSOR,
      }),
    });
  }

  it('costs 1 + W + W requests (13) for 6 workspaces × 30 channels — was 193', async () => {
    const { api, requests } = modelledAccount(6, 30);

    await hydrateStore(api, defaultStore);

    // Before: 1 + Σ_ws (1 listChannels + C listThreads + 1 listPeople) = 193.
    // After: the workspace list, one channels read per workspace, and one
    // (paged) roster read per workspace — the thread walk is gone.
    expect(requests.calls).toHaveLength(13);
    expect(requests.calls.filter((call) => call === 'listWorkspaces')).toHaveLength(1);
    expect(requests.calls.filter((call) => call === 'listChannels')).toHaveLength(6);
    expect(requests.calls.filter((call) => call === 'listAllPeople')).toHaveLength(6);
    expect(Object.keys(defaultStore.getState().channels)).toHaveLength(180);
  });

  it('costs 17 requests for 8 workspaces × 60 channels — was 497', async () => {
    const { api, requests } = modelledAccount(8, 60);

    await hydrateStore(api, defaultStore);

    expect(requests.calls).toHaveLength(17);
    expect(Object.keys(defaultStore.getState().channels)).toHaveLength(480);
  });

  it('never fetches thread metadata on the launch path', async () => {
    const { api } = modelledAccount(2, 3);

    await hydrateStore(api, defaultStore);

    // Thread metadata is fetched on demand when a thread surface opens
    // (`useThreadMeta` → GET /threads/{id}); nothing here reads the channel's
    // thread list, so the launch path must not ask for it.
    expect(api.listThreads).not.toHaveBeenCalled();
    expect(defaultStore.getState().threadIdsByChannel).toEqual({});
  });

  it('keeps the per-workspace fan-out inside the pool', async () => {
    const { api, requests } = modelledAccount(12, 1);

    await hydrateStore(api, defaultStore);

    // 24 legs (channels + roster per workspace) through a pool of 4: never
    // more than the cap in flight, and genuinely parallel (the pool is used).
    expect(requests.maxInFlight).toBe(HYDRATION_CONCURRENCY);
    expect(requests.calls).toHaveLength(25);
    expect(Object.keys(defaultStore.getState().channels)).toHaveLength(12);
  });

  it('does not re-fetch a graph the store already holds', async () => {
    seedShellStore();
    const { api, requests } = fakeApi();

    await expect(hydrateStore(api, defaultStore)).resolves.toBeUndefined();

    // The reconnect path: the shell already renders this graph, so the
    // bootstrap is a no-op instead of another full fan-out.
    expect(requests.calls).toEqual([]);
  });

  it('still fetches when the store is empty — the retry path', async () => {
    seedShellStore();
    resetShellStore(); // a genuine failure left nothing behind
    const { api, requests } = fakeApi();

    await hydrateStore(api, defaultStore);

    expect(requests.calls.filter((call) => call === 'listWorkspaces')).toHaveLength(1);
    expect(Object.keys(defaultStore.getState().workspaces)).toEqual([IDS.ws1]);
  });
});

describe('hydrateStore — people paging', () => {
  it('hydrates a roster larger than one server page', async () => {
    const roster = Array.from({ length: 120 }, (_, i) => member(i, IDS.ws1));
    const { api } = fakeApi({
      listAllPeople: async () => ({ items: roster, truncated: false }),
    });

    await hydrateStore(api, defaultStore);

    const state = defaultStore.getState();
    expect(state.memberIdsByWorkspace[IDS.ws1]).toHaveLength(120);
    expect(Object.keys(state.membersById)).toHaveLength(120);
  });

  it('keeps the partial roster and notes the cap when the walk is truncated', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const roster = Array.from({ length: 500 }, (_, i) => member(i, IDS.ws1));
    const { api } = fakeApi({
      listAllPeople: async () => ({ items: roster, truncated: true }),
    });

    await hydrateStore(api, defaultStore);

    expect(defaultStore.getState().memberIdsByWorkspace[IDS.ws1]).toHaveLength(500);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('partial'));
    warn.mockRestore();
  });
});
