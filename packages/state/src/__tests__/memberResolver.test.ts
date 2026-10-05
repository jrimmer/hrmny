/**
 * @cytale/state — on-demand member resolution (2026-10-02).
 *
 * Boot reads ONE people page per workspace; a workspace of 120 left members
 * #51..#120 out of the roster, and every message they wrote rendered as a
 * raw snowflake. The resolver names the authors actually on screen with a
 * batched lookup, and a reconnect's page read keeps what it named.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Message, Thread, WorkspaceMember } from '@cytale/domain';
import type { GatewayEvent, MessageCreate } from '@cytale/protocol';

import { startMemberResolver, type MemberResolver } from '../memberResolver.js';
import { applyGatewayEvent, mergeChannelMessages } from '../reconcile.js';
import { mergeMembers, replaceMembers } from '../roster.js';
import { createStateStore, type StateStore } from '../store.js';

const WORKSPACE = '6000000000000001';
const OTHER_WS = '6000000000000002';
const CHANNEL = '9007199254740993';
const DM = '9007199254740995';

/** Member #n of a 120-member workspace (ids ascending with n). */
const memberId = (n: number) => String(7000000000000000 + n);

function row(n: number, extra: Partial<WorkspaceMember> = {}): WorkspaceMember {
  return {
    id: memberId(n),
    username: `member${n}`,
    nickname: `Member ${n}`,
    avatar_url: null,
    joined_at: '2026-10-01T00:00:00Z',
    roles: [],
    kind: 'human',
    ...extra,
  };
}

/** The server's people roster: 120 people. */
const ROSTER = new Map(Array.from({ length: 120 }, (_, i) => [memberId(i + 1), row(i + 1)] as const));

/** The first people page: the 50 HIGHEST ids (user_id descending), cursor set. */
const FIRST_PAGE = Array.from({ length: 50 }, (_, i) => row(120 - i));

let seq = 0;
function dispatch(t: string, d: unknown): GatewayEvent {
  seq += 1;
  return { op: 0, t, s: seq, d } as unknown as GatewayEvent;
}

function message(id: string, author: string, channel = CHANNEL): MessageCreate {
  return {
    id,
    channel_id: channel,
    thread_id: null,
    author_id: author,
    content: 'hi',
    created_at: '2026-10-02T00:00:00Z',
    edited_at: null,
  };
}

function seed(store: StateStore): void {
  store.setState({
    workspaces: {
      [WORKSPACE]: { id: WORKSPACE, name: 'Big', owner_id: memberId(120), created_at: '2026-10-01T00:00:00Z' },
    } as never,
    channels: {
      [CHANNEL]: {
        id: CHANNEL,
        workspace_id: WORKSPACE,
        name: 'general',
        type: 'text',
        topic: null,
        position: 0,
        last_message_id: null,
        created_at: '2026-10-01T00:00:00Z',
      },
      [DM]: {
        id: DM,
        workspace_id: null,
        name: '',
        type: 'dm',
        topic: null,
        position: 0,
        last_message_id: null,
        created_at: '2026-10-01T00:00:00Z',
      },
    },
  });
  replaceMembers(store, { [WORKSPACE]: FIRST_PAGE }, new Set([WORKSPACE]));
}

let store: StateStore;
let lookup: ReturnType<typeof vi.fn>;
let resolver: MemberResolver;

beforeEach(() => {
  seq = 0;
  vi.useFakeTimers();
  store = createStateStore();
  seed(store);
  lookup = vi.fn(async (_ws: string, ids: string[]) =>
    ids.map((id) => ROSTER.get(id)).filter((r): r is WorkspaceMember => r !== undefined),
  );
  resolver = startMemberResolver({ store, lookup, debounceMs: 50 });
});

afterEach(() => {
  resolver.stop();
  vi.useRealTimers();
});

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(60);
  await resolver.flush();
}

describe('member resolver: naming authors beyond the first people page', () => {
  it('a message from a member beyond the first page (#40 of 120) resolves to their name with no reload', async () => {
    // The page is the 50 highest ids (71..120); 1..70 are beyond it.
    const far = memberId(40);
    expect(store.getState().membersById[far]).toBeUndefined();

    applyGatewayEvent(store, dispatch('MessageCreate', message('1000000000000001', far)));
    await settle();

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith(WORKSPACE, [far]);
    expect(store.getState().membersById[far]).toMatchObject({ username: 'member40' });
    // The nickname is this workspace's (#169), kept off the shared row.
    expect(store.getState().nicknamesByWorkspace[WORKSPACE]?.[far]).toBe('Member 40');
    expect(store.getState().memberIdsByWorkspace[WORKSPACE]).toContain(far);

    // Named once: a second message by the same author asks nothing.
    applyGatewayEvent(store, dispatch('MessageCreate', message('1000000000000002', far)));
    await settle();
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('member #110 of 120, beyond a page that holds the first 50: named the same way', async () => {
    // Which 50 the first page holds is the server's ordering; whoever it
    // leaves out is named by the same path.
    const s2 = createStateStore();
    seed(s2);
    replaceMembers(s2, { [WORKSPACE]: Array.from({ length: 50 }, (_, i) => row(i + 1)) });
    const r2 = startMemberResolver({ store: s2, lookup, debounceMs: 50 });
    applyGatewayEvent(s2, dispatch('MessageCreate', message('1000000000000003', memberId(110))));
    await vi.advanceTimersByTimeAsync(60);
    await r2.flush();
    expect(s2.getState().nicknamesByWorkspace[WORKSPACE]?.[memberId(110)]).toBe('Member 110');
    r2.stop();
  });

  it('a history page of many unknown authors is ONE batched lookup, chunked at 100', async () => {
    const page: Message[] = Array.from({ length: 70 }, (_, i) => ({
      ...message(String(2000000000000000 + i), memberId(i + 1)),
    })) as unknown as Message[];
    mergeChannelMessages(store, CHANNEL, page, { direction: 'newest' });
    await settle();

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup.mock.calls[0]![1]).toHaveLength(70);
    for (let n = 1; n <= 70; n++) expect(store.getState().membersById[memberId(n)]).toBeDefined();

    const small = startMemberResolver({ store: createStateStore(), lookup, maxBatch: 100 });
    const many = Array.from({ length: 230 }, (_, i) => String(8000000000000000 + i));
    small.request(WORKSPACE, many);
    await small.flush();
    expect(lookup.mock.calls.slice(1).map((c) => (c[1] as string[]).length)).toEqual([100, 100, 30]);
    small.stop();
  });

  it('an id the server cannot name is asked once, not on every render', async () => {
    const gone = '7000000000099999';
    applyGatewayEvent(store, dispatch('MessageCreate', message('1000000000000004', gone)));
    await settle();
    applyGatewayEvent(store, dispatch('MessageCreate', message('1000000000000005', gone)));
    await settle();
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(store.getState().membersById[gone]).toBeUndefined();
  });

  it('a failed lookup backs off, then retries', async () => {
    lookup.mockRejectedValueOnce(new Error('offline'));
    const far = memberId(12);
    applyGatewayEvent(store, dispatch('MessageCreate', message('1000000000000006', far)));
    await settle();
    expect(store.getState().membersById[far]).toBeUndefined();

    resolver.request(WORKSPACE, [far]);
    await settle();
    expect(lookup).toHaveBeenCalledTimes(1); // still backing off

    await vi.advanceTimersByTimeAsync(16_000);
    resolver.request(WORKSPACE, [far]);
    await settle();
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(store.getState().membersById[far]).toBeDefined();
  });

  it('names a thread starter beyond the page', async () => {
    const starter = memberId(3);
    const thread = {
      id: '9007199254741000',
      channel_id: CHANNEL,
      name: 't',
      created_by: starter,
      created_at: '2026-10-02T00:00:00Z',
      message_count: 0,
      latest_reply_at: null,
    } as unknown as Thread;
    store.setState({ threadsById: { [thread.id]: thread } });
    await settle();
    expect(store.getState().nicknamesByWorkspace[WORKSPACE]?.[starter]).toBe('Member 3');
  });

  it('DM messages are not looked up against a workspace', async () => {
    applyGatewayEvent(store, dispatch('MessageCreate', message('1000000000000007', memberId(5), DM)));
    await settle();
    expect(lookup).not.toHaveBeenCalled();
  });

  // #169: a row another workspace loaded names the person, but not their
  // nickname HERE — every request resolves an id this workspace does not list
  // (what `membership` alone used to do), so the nickname arrives.
  it('an id named elsewhere but not listed here is resolved, nickname included', async () => {
    mergeMembers(store, OTHER_WS, [row(9)]);
    resolver.request(WORKSPACE, [memberId(9)]);
    await settle();
    expect(lookup).toHaveBeenCalledWith(WORKSPACE, [memberId(9)]);
    expect(store.getState().memberIdsByWorkspace[WORKSPACE]).toContain(memberId(9));
    expect(store.getState().nicknamesByWorkspace[WORKSPACE]?.[memberId(9)]).toBe('Member 9');

    // Listed now: asking again costs nothing.
    resolver.request(WORKSPACE, [memberId(9)], { membership: true });
    await settle();
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});

describe('replaceMembers with a partial page (a reconnect keeps what was named on demand)', () => {
  it('keeps ids beyond the page, drops what the page proves gone', () => {
    mergeMembers(store, WORKSPACE, [row(10), row(20)]);
    const bot = row(200, { kind: 'bot', parent_user_id: memberId(120), nickname: 'Hermes' });
    const farBot = row(201, { kind: 'bot', parent_user_id: memberId(10), nickname: 'Far bot' });
    mergeMembers(store, WORKSPACE, [bot, farBot]);

    // Reconnect: member #100 left (inside the page's range), the owner of
    // `bot` is on the page without it (grant revoked meanwhile).
    const page = FIRST_PAGE.filter((m) => m.id !== memberId(100));
    replaceMembers(store, { [WORKSPACE]: page }, new Set([WORKSPACE]));

    const ids = store.getState().memberIdsByWorkspace[WORKSPACE]!;
    expect(ids.slice(0, page.length)).toEqual(page.map((m) => m.id));
    expect(ids).toContain(memberId(10));
    expect(ids).toContain(memberId(20));
    expect(ids).toContain(farBot.id); // its owner is beyond the page
    expect(ids).not.toContain(memberId(100));
    expect(ids).not.toContain(bot.id);
  });

  it('a complete page still REPLACES (a departed member goes)', () => {
    mergeMembers(store, WORKSPACE, [row(10)]);
    replaceMembers(store, { [WORKSPACE]: FIRST_PAGE });
    expect(store.getState().memberIdsByWorkspace[WORKSPACE]).not.toContain(memberId(10));
  });
});
