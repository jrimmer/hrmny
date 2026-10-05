/**
 * #169 — per-workspace nicknames in the store.
 *
 * A member row is shared across workspaces; a nickname belongs to one. The
 * writers (people pages, on-demand lookups, MemberAdd/Update/Remove) keep it
 * in `nicknamesByWorkspace`, never on the shared row, and a name resolves for
 * the place it is shown.
 */
import { describe, expect, it } from 'vitest';

import type { GatewayEvent, MemberAdd, MemberRemove, MemberUpdate } from '@cytale/protocol';
import type { WorkspaceMember } from '@cytale/domain';

import { createStateStore } from '../store.js';
import { applyGatewayEvent } from '../reconcile.js';
import { mergeMembers, replaceMembers } from '../roster.js';
import { memberNameIn, nicknamesForChannel } from '../nicknames.js';

const WS_A = '6000000000000001';
const WS_B = '6000000000000002';
const LIDDY = '7000000000000001';
const HUNT = '7000000000000002';

let seq = 0;
const dispatch = (t: string, d: unknown) => ({ op: 0, t, s: ++seq, d }) as unknown as GatewayEvent;

const row = (id: string, username: string, extra: Partial<WorkspaceMember> = {}): WorkspaceMember => ({
  id,
  username,
  display_name: null,
  nickname: null,
  joined_at: '2026-10-04T00:00:00Z',
  roles: [],
  ...extra,
});

describe('per-workspace nicknames', () => {
  it('a people page stores nicknames per workspace and keeps them off the shared row', () => {
    const store = createStateStore();
    replaceMembers(store, {
      [WS_A]: [row(LIDDY, 'liddy', { display_name: 'G. Gordon Liddy', nickname: 'Gemstone' })],
      [WS_B]: [row(LIDDY, 'liddy', { display_name: 'G. Gordon Liddy' })],
    });
    const s = store.getState();
    expect(s.membersById[LIDDY]?.nickname).toBeNull();
    expect(s.nicknamesByWorkspace[WS_A]?.[LIDDY]).toBe('Gemstone');
    expect(s.nicknamesByWorkspace[WS_B]?.[LIDDY]).toBeUndefined();

    const liddy = s.membersById[LIDDY];
    expect(memberNameIn(s.nicknamesByWorkspace, liddy, WS_A)).toBe('Gemstone');
    expect(memberNameIn(s.nicknamesByWorkspace, liddy, WS_B)).toBe('G. Gordon Liddy');
    // No workspace (a DM): the display name.
    expect(memberNameIn(s.nicknamesByWorkspace, liddy, null)).toBe('G. Gordon Liddy');
  });

  it('a full page drops nicknames of members it no longer lists; an on-demand lookup adds without removing', () => {
    const store = createStateStore();
    replaceMembers(store, {
      [WS_A]: [row(LIDDY, 'liddy', { nickname: 'Gemstone' }), row(HUNT, 'hunt', { nickname: 'Eduardo' })],
    });
    replaceMembers(store, { [WS_A]: [row(LIDDY, 'liddy', { nickname: 'Gemstone' })] });
    expect(store.getState().nicknamesByWorkspace[WS_A]).toEqual({ [LIDDY]: 'Gemstone' });

    mergeMembers(store, WS_A, [row(HUNT, 'hunt', { nickname: 'Eduardo' })]);
    expect(store.getState().nicknamesByWorkspace[WS_A]).toEqual({ [LIDDY]: 'Gemstone', [HUNT]: 'Eduardo' });
  });

  it('MemberAdd, MemberUpdate and MemberRemove keep the map live, one workspace at a time', () => {
    const store = createStateStore();
    applyGatewayEvent(
      store,
      dispatch('MemberAdd', {
        workspace_id: WS_A,
        user: { id: LIDDY, username: 'liddy', display_name: 'G. Gordon Liddy' },
        joined_at: '2026-10-04T00:00:00Z',
        nickname: 'Gemstone',
      } satisfies MemberAdd),
    );
    expect(store.getState().membersById[LIDDY]?.nickname).toBeNull();
    expect(store.getState().nicknamesByWorkspace[WS_A]?.[LIDDY]).toBe('Gemstone');

    applyGatewayEvent(
      store,
      dispatch('MemberUpdate', { workspace_id: WS_A, user_id: LIDDY, nickname: 'Gordo' } satisfies MemberUpdate),
    );
    expect(store.getState().nicknamesByWorkspace[WS_A]?.[LIDDY]).toBe('Gordo');

    // Another workspace's update does not touch this one.
    applyGatewayEvent(
      store,
      dispatch('MemberUpdate', { workspace_id: WS_B, user_id: LIDDY, nickname: 'Elsewhere' } satisfies MemberUpdate),
    );
    expect(store.getState().nicknamesByWorkspace[WS_A]?.[LIDDY]).toBe('Gordo');

    // Cleared.
    applyGatewayEvent(
      store,
      dispatch('MemberUpdate', { workspace_id: WS_A, user_id: LIDDY, nickname: null } satisfies MemberUpdate),
    );
    expect(store.getState().nicknamesByWorkspace[WS_A]?.[LIDDY]).toBeUndefined();

    // Leaving a workspace takes its nickname with it.
    applyGatewayEvent(
      store,
      dispatch('MemberRemove', { workspace_id: WS_B, user_id: LIDDY } satisfies MemberRemove),
    );
    expect(store.getState().nicknamesByWorkspace[WS_B]?.[LIDDY]).toBeUndefined();
  });

  it('a UserUpdate never writes a nickname, a bot rename included', () => {
    const store = createStateStore();
    applyGatewayEvent(
      store,
      dispatch('MemberAdd', {
        workspace_id: WS_A,
        user: { id: HUNT, username: 'tapedeck', display_name: 'Tape Deck' },
        joined_at: '2026-10-04T00:00:00Z',
        nickname: 'The Recorder',
        kind: 'bot',
        parent_user_id: LIDDY,
      } satisfies MemberAdd),
    );
    applyGatewayEvent(store, dispatch('UserUpdate', { id: HUNT, username: 'tapedeck', display_name: 'Tape Deck II' }));
    const s = store.getState();
    expect(s.membersById[HUNT]?.display_name).toBe('Tape Deck II');
    expect(s.membersById[HUNT]?.nickname).toBeNull();
    expect(s.nicknamesByWorkspace[WS_A]?.[HUNT]).toBe('The Recorder');
  });

  it('nicknamesForChannel reads the channel workspace map; a DM has none', () => {
    const store = createStateStore();
    replaceMembers(store, { [WS_A]: [row(LIDDY, 'liddy', { nickname: 'Gemstone' })] });
    store.setState({
      channels: {
        c1: { id: 'c1', workspace_id: WS_A, name: 'general', type: 'text' } as never,
        d1: { id: 'd1', workspace_id: null, type: 'dm' } as never,
      },
    });
    const s = store.getState();
    expect(nicknamesForChannel(s, 'c1')?.[LIDDY]).toBe('Gemstone');
    expect(nicknamesForChannel(s, 'd1')).toBeUndefined();
    expect(nicknamesForChannel(s, 'missing')).toBeUndefined();
  });
});
