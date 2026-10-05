/**
 * @cytale/state — member attribution preservation (bots plan U5).
 *
 * The members/people payloads now carry `kind` and (for machine principals)
 * `parent_user_id` (R6 attribution). This pins that rows merged into
 * `membersById` keep those fields through store updates and gateway-event
 * reconcile passes — the fields are inert for rendering until U12's badge.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import type { GatewayEvent, MemberAdd, MessageCreate, PresenceUpdate } from '@cytale/protocol';

import { createStateStore } from '../store.js';
import { applyGatewayEvent } from '../reconcile.js';

const CHANNEL = '9007199254740993'; // 2^53 + 1 — unsafe as a JS number
const OWNER = '7000000000000001';
const AGENT = '7000000000000009';
const WORKSPACE = '6000000000000001';
const PARENT = OWNER; // the agent's parent (R1: membership derives from it)

let seq = 0;
function dispatch(t: string, d: unknown): GatewayEvent {
  seq += 1;
  return { op: 0, t, s: seq, d } as unknown as GatewayEvent;
}

beforeEach(() => {
  seq = 0;
});

describe('member attribution (kind / parent_user_id)', () => {
  it('member rows carrying kind/parent_user_id survive unrelated store updates + reconcile', () => {
    const store = createStateStore();

    // REST people/members merge — the row shape the server now returns.
    store.setState((s) => ({
      membersById: {
        ...s.membersById,
        [OWNER]: {
          id: OWNER,
          username: 'owner',
          nickname: null,
          joined_at: '2026-09-04T00:00:00Z',
          roles: [],
          kind: 'human',
        },
        [AGENT]: {
          id: AGENT,
          username: 'Ops Agent',
          nickname: null,
          joined_at: '2026-09-04T00:01:00Z',
          roles: [],
          kind: 'agent',
          parent_user_id: PARENT,
        },
      },
      memberIdsByWorkspace: {
        ...s.memberIdsByWorkspace,
        [WORKSPACE]: [OWNER, AGENT],
      },
    }));

    // A burst of unrelated dispatches: message traffic, presence, a human join.
    applyGatewayEvent(
      store,
      dispatch('MessageCreate', {
        id: '1000000000000001',
        channel_id: CHANNEL,
        thread_id: null,
        author_id: AGENT,
        content: 'agent says hi',
        created_at: '2026-09-04T00:02:00Z',
        edited_at: null,
      } satisfies MessageCreate),
    );
    applyGatewayEvent(
      store,
      dispatch('PresenceUpdate', {
        user_id: AGENT,
        status: 'online',
        last_seen_at: '2026-09-04T00:02:01Z',
      } satisfies PresenceUpdate),
    );
    applyGatewayEvent(
      store,
      dispatch('MemberAdd', {
        workspace_id: WORKSPACE,
        user: { id: '7000000000000002', username: 'joiner' },
        joined_at: '2026-09-04T00:03:00Z',
      } satisfies MemberAdd),
    );

    const members = store.getState().membersById;
    expect(members[OWNER]).toMatchObject({ id: OWNER, kind: 'human' });
    expect(members[OWNER]!.parent_user_id).toBeUndefined();
    expect(members[AGENT]).toMatchObject({
      id: AGENT,
      kind: 'agent',
      parent_user_id: PARENT,
    });
    expect(members[AGENT]!.username).toBe('Ops Agent');
    // The synthesized agent rides the roster list like any member (R4).
    expect(store.getState().memberIdsByWorkspace[WORKSPACE]).toContain(AGENT);
  });

  it('member rows without kind (older servers / gateway-synthesized joins) stay valid', () => {
    const store = createStateStore();

    applyGatewayEvent(
      store,
      dispatch('MemberAdd', {
        workspace_id: WORKSPACE,
        user: { id: OWNER, username: 'owner' },
        joined_at: '2026-09-04T00:00:00Z',
      } satisfies MemberAdd),
    );

    const member = store.getState().membersById[OWNER]!;
    expect(member).toMatchObject({ id: OWNER, username: 'owner' });
    expect(member.kind).toBeUndefined();
    expect(member.parent_user_id).toBeUndefined();
  });
});
