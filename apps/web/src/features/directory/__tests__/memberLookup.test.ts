/**
 * @cytale/web — naming members beyond the first people page (2026-10-02).
 *
 * Boot reads one people page (50) per workspace. In a workspace of 120, an
 * author beyond it used to render as a raw snowflake everywhere the author
 * resolver ran. The shell now runs the state package's member resolver with
 * the people endpoint's `?ids=` lookup; this pins the wiring end to end on
 * the web side: the lookup's URL, the row mapping, and the name the author
 * resolver produces once the row lands.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyGatewayEvent, createStateStore, replaceMembers, startMemberResolver } from '@cytale/state';
import type { GatewayEvent } from '@cytale/protocol';

import { resolveAuthor } from '../../messages/authorIdentity.js';
import { fetchPeoplePage, memberFromPeopleRow } from '../api.js';
import type { PeopleMember } from '../types.js';

const WS = '6000000000000001';
const CHANNEL = '9007199254740993';
const id = (n: number) => String(7000000000000000 + n);

function person(n: number): PeopleMember {
  return {
    user: { id: id(n), username: `member${n}`, avatar_url: null },
    nickname: `Member ${n}`,
    joined_at: '2026-10-01T00:00:00Z',
    roles: [],
    kind: 'human',
  };
}

const ALL = new Map(Array.from({ length: 120 }, (_, i) => [id(i + 1), person(i + 1)] as const));

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (url: string) => {
    const ids = new URL(url, 'http://x').searchParams.get('ids')?.split(',') ?? [];
    return {
      ok: true,
      json: async () => ({ people: ids.flatMap((i) => (ALL.has(i) ? [ALL.get(i)!] : [])), next_before: null }),
    };
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('people lookup (?ids=)', () => {
  it('asks for exactly the ids — no limit, no cursor — with the bearer token', async () => {
    const page = await fetchPeoplePage({ workspaceId: WS, ids: [id(110), id(3)], token: 'tok' });
    const [url, init] = fetchMock.mock.calls[0]!;
    const params = new URL(url as string, 'http://x').searchParams;
    expect(params.get('ids')).toBe(`${id(110)},${id(3)}`);
    expect(params.has('limit')).toBe(false);
    expect(params.has('before')).toBe(false);
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer tok' });
    expect(page.people.map(memberFromPeopleRow).map((m) => m.nickname)).toEqual(['Member 110', 'Member 3']);
  });

  it('a 120-member workspace: a message from member #110 shows their name, not digits, with no reload', async () => {
    const store = createStateStore();
    store.setState({
      channels: {
        [CHANNEL]: {
          id: CHANNEL,
          workspace_id: WS,
          name: 'general',
          type: 'text',
          topic: null,
          position: 0,
          last_message_id: null,
          created_at: '2026-10-01T00:00:00Z',
        },
      },
    });
    // The boot page: 50 of the 120 — #110 is not among them.
    replaceMembers(
      store,
      { [WS]: Array.from({ length: 50 }, (_, i) => memberFromPeopleRow(person(i + 1))) },
      new Set([WS]),
    );
    expect(resolveAuthor(store.getState().membersById, id(110)).name).toBe(id(110));

    const resolver = startMemberResolver({
      store,
      debounceMs: 0,
      lookup: async (workspaceId, ids) =>
        (await fetchPeoplePage({ workspaceId, ids })).people.map(memberFromPeopleRow),
    });
    applyGatewayEvent(store, {
      op: 0,
      t: 'MessageCreate',
      s: 1,
      d: {
        id: '1000000000000001',
        channel_id: CHANNEL,
        thread_id: null,
        author_id: id(110),
        content: 'hello from beyond the first page',
        created_at: '2026-10-02T00:00:00Z',
        edited_at: null,
      },
    } as unknown as GatewayEvent);
    await new Promise((r) => setTimeout(r, 5));
    await resolver.flush();

    // Named for the place it shows: the channel's workspace nicknames (#169).
    const who = resolveAuthor(store.getState().membersById, id(110), {
      nicknames: store.getState().nicknamesByWorkspace[WS],
    });
    expect(who).toMatchObject({ name: 'Member 110', tag: 'member110', known: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolver.stop();
  });
});
