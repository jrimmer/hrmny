/**
 * On-device channel permission resolution + the R15 `permission-denied`
 * producer (plan 004; ce-code-review gap A).
 *
 * Three layers are asserted here: the pure resolution (held roles over the
 * synthesized @everyone base, member overwrites applied), the per-workspace
 * role cache (one read, retried after failure), and the hook that publishes
 * `permissionDenied` — including the fail-open rule: an unresolved state
 * never claims denial.
 */
import { renderHook, waitFor } from '@testing-library/react-native';

import { toListResponse, type ListResponse } from '@cytale/api-client';
import { PERMISSIONS, type Overwrite, type Role } from '@cytale/domain';
import { createStateStore, type StateStore } from '@cytale/state';

import {
  loadWorkspaceRoles,
  resetWorkspaceRoles,
  resolveMemberChannelPermissions,
  useChannelPermissions,
  type RolesApi,
} from '../permissions';
import { getSurfaceStates, resetSurfaceStates } from '../shellState';

const IDS = {
  me: '900000000000000001',
  alice: '900000000000000002',
  ws: '800000000000000001',
  /** A second workspace — the moderator role below belongs to `ws` only. */
  wsTwo: '800000000000000002',
  general: '700000000000000001',
  private: '700000000000000002',
  other: '700000000000000003',
  modRole: '500000000000000001',
  otherRole: '500000000000000002',
} as const;

const CURSOR = { before: null, after: null, limit: 50 };

function makeRole(id: string, permissions: bigint, name = 'role'): Role {
  return { id, workspace_id: IDS.ws, name, permissions: permissions.toString(), position: 1, color: null };
}

/** Moderator: MANAGE_MESSAGES on top of the read/post bits. */
const MOD_ROLE = makeRole(
  IDS.modRole,
  PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.SEND_MESSAGES | PERMISSIONS.MANAGE_MESSAGES,
  'Moderator',
);

/** A role the member does not hold — its grants must be ignored. */
const UNHELD_ROLE = makeRole(IDS.otherRole, PERMISSIONS.MANAGE_MESSAGES, 'Other');

function makeApi(roles: readonly Role[]): { api: RolesApi; listRoles: jest.Mock } {
  const listRoles = jest.fn(
    async (_workspaceId: string): Promise<ListResponse<Role>> =>
      toListResponse([...roles], CURSOR),
  );
  return { api: { listRoles }, listRoles };
}

/** A store with `me` holding `roleIds`, and two channels of one workspace. */
function makeStore(roleIds: readonly string[] = []): StateStore {
  const store = createStateStore();
  store.setState({
    currentUser: { id: IDS.me, username: 'rowan' },
    workspaces: {},
    channels: {
      [IDS.general]: {
        id: IDS.general,
        workspace_id: IDS.ws,
        name: 'general',
        type: 'text',
        topic: null,
        position: 0,
        last_message_id: null,
        created_at: '2026-09-08T00:00:00.000Z',
      },
      [IDS.private]: {
        id: IDS.private,
        workspace_id: IDS.ws,
        name: 'private',
        type: 'text',
        topic: null,
        position: 1,
        last_message_id: null,
        created_at: '2026-09-08T00:00:00.000Z',
      },
    },
    membersById: {
      [IDS.me]: {
        id: IDS.me,
        username: 'rowan',
        nickname: null,
        joined_at: '2026-09-08T00:00:00.000Z',
        roles: [...roleIds],
      },
      [IDS.alice]: {
        id: IDS.alice,
        username: 'alice',
        nickname: null,
        joined_at: '2026-09-08T00:00:00.000Z',
        roles: [],
      },
    },
    memberIdsByWorkspace: { [IDS.ws]: [IDS.me, IDS.alice] },
  });
  return store;
}

beforeEach(() => {
  resetWorkspaceRoles();
  resetSurfaceStates();
});

afterEach(() => {
  resetWorkspaceRoles();
  resetSurfaceStates();
});

describe('resolveMemberChannelPermissions', () => {
  it('grants MANAGE_MESSAGES to a member holding the moderator role', () => {
    const bits = resolveMemberChannelPermissions({
      workspaceId: IDS.ws,
      memberId: IDS.me,
      roleIds: [IDS.modRole],
      roles: [MOD_ROLE],
    });
    expect((bits & PERMISSIONS.MANAGE_MESSAGES) === PERMISSIONS.MANAGE_MESSAGES).toBe(true);
    expect((bits & PERMISSIONS.VIEW_CHANNEL) === PERMISSIONS.VIEW_CHANNEL).toBe(true);
  });

  it('leaves MANAGE_MESSAGES off a member without the role (the @everyone base still reads)', () => {
    const bits = resolveMemberChannelPermissions({
      workspaceId: IDS.ws,
      memberId: IDS.me,
      roleIds: [],
      roles: [MOD_ROLE],
    });
    expect((bits & PERMISSIONS.MANAGE_MESSAGES) === PERMISSIONS.MANAGE_MESSAGES).toBe(false);
    expect((bits & PERMISSIONS.VIEW_CHANNEL) === PERMISSIONS.VIEW_CHANNEL).toBe(true);
    expect((bits & PERMISSIONS.SEND_MESSAGES) === PERMISSIONS.SEND_MESSAGES).toBe(true);
  });

  it('ignores a role the member does not hold', () => {
    const bits = resolveMemberChannelPermissions({
      workspaceId: IDS.ws,
      memberId: IDS.me,
      roleIds: [IDS.modRole],
      roles: [MOD_ROLE, UNHELD_ROLE],
    });
    expect((bits & PERMISSIONS.MANAGE_MESSAGES) === PERMISSIONS.MANAGE_MESSAGES).toBe(true);
    // UNHELD_ROLE grants nothing here either — the held role is what granted it.
    const withoutHeld = resolveMemberChannelPermissions({
      workspaceId: IDS.ws,
      memberId: IDS.me,
      roleIds: [],
      roles: [MOD_ROLE, UNHELD_ROLE],
    });
    expect((withoutHeld & PERMISSIONS.MANAGE_MESSAGES) === PERMISSIONS.MANAGE_MESSAGES).toBe(false);
  });

  it('applies a member overwrite that denies VIEW_CHANNEL (the private-channel case)', () => {
    const privateChannel: Overwrite = {
      id: IDS.me,
      type: 'member',
      allow: '0',
      deny: PERMISSIONS.VIEW_CHANNEL.toString(),
    };
    const bits = resolveMemberChannelPermissions({
      workspaceId: IDS.ws,
      memberId: IDS.me,
      roleIds: [],
      roles: [],
      overwrites: [privateChannel],
    });
    expect((bits & PERMISSIONS.VIEW_CHANNEL) === PERMISSIONS.VIEW_CHANNEL).toBe(false);
    // Deny only strips the view bit; the rest of the base survives.
    expect((bits & PERMISSIONS.SEND_MESSAGES) === PERMISSIONS.SEND_MESSAGES).toBe(true);
  });

  it("does not apply another member's overwrite", () => {
    const aliceDeny: Overwrite = {
      id: IDS.alice,
      type: 'member',
      allow: '0',
      deny: PERMISSIONS.VIEW_CHANNEL.toString(),
    };
    const bits = resolveMemberChannelPermissions({
      workspaceId: IDS.ws,
      memberId: IDS.me,
      roleIds: [],
      roles: [],
      overwrites: [aliceDeny],
    });
    expect((bits & PERMISSIONS.VIEW_CHANNEL) === PERMISSIONS.VIEW_CHANNEL).toBe(true);
  });
});

describe('workspace role cache', () => {
  it('reads the workspace once, however many times the roles are asked for', async () => {
    const { api, listRoles } = makeApi([MOD_ROLE]);

    const first = await loadWorkspaceRoles(api, IDS.ws);
    const second = await loadWorkspaceRoles(api, IDS.ws);

    expect(first).toEqual([{ id: IDS.modRole, permissions: MOD_ROLE.permissions }]);
    expect(second).toBe(first);
    expect(listRoles).toHaveBeenCalledTimes(1);
    expect(listRoles).toHaveBeenCalledWith(IDS.ws);
  });

  it('retries after a failed read (a failure is never cached)', async () => {
    let attempt = 0;
    const listRoles = jest.fn(async (_workspaceId: string): Promise<ListResponse<Role>> => {
      attempt += 1;
      if (attempt === 1) throw new Error('offline');
      return toListResponse([MOD_ROLE], CURSOR);
    });

    await expect(loadWorkspaceRoles({ listRoles }, IDS.ws)).rejects.toThrow('offline');
    await expect(loadWorkspaceRoles({ listRoles }, IDS.ws)).resolves.toHaveLength(1);
    expect(listRoles).toHaveBeenCalledTimes(2);
  });

  it('unwraps the live server envelope ({roles}, not the declared .items)', async () => {
    // `RoleController.index` answers `{"roles": [...]}` while `listRoles` is
    // typed `ListResponse<Role>` — the declared `.items` is undefined on the
    // wire, so the reader must accept both.
    const listRoles = jest.fn(async (_workspaceId: string) => ({ roles: [MOD_ROLE] }));
    const api = { listRoles } as unknown as RolesApi;

    await expect(loadWorkspaceRoles(api, IDS.ws)).resolves.toEqual([
      { id: IDS.modRole, permissions: MOD_ROLE.permissions },
    ]);
  });

  it('refetches after resetWorkspaceRoles (sign-out / test hygiene)', async () => {
    const { api, listRoles } = makeApi([MOD_ROLE]);

    await loadWorkspaceRoles(api, IDS.ws);
    resetWorkspaceRoles();
    await loadWorkspaceRoles(api, IDS.ws);

    expect(listRoles).toHaveBeenCalledTimes(2);
  });
});

describe('useChannelPermissions', () => {
  interface PermissionsProps {
    channelId: string;
    overwrites?: readonly Overwrite[];
  }

  function renderPermissions(api: RolesApi, store: StateStore, initial: PermissionsProps) {
    return renderHook(
      ({ channelId, overwrites }: PermissionsProps) =>
        useChannelPermissions(api, store, channelId, overwrites === undefined ? {} : { overwrites }),
      { initialProps: initial },
    );
  }

  it('resolves MANAGE_MESSAGES for a moderator and not for a plain member', async () => {
    const moderator = await renderPermissions(makeApi([MOD_ROLE]).api, makeStore([IDS.modRole]), {
      channelId: IDS.general,
    });
    await waitFor(() => expect(moderator.result.current.canManageMessages).toBe(true));
    expect(moderator.result.current.canViewChannel).toBe(true);
    expect(getSurfaceStates().permissionDenied ?? null).toBeNull();

    const plain = await renderPermissions(makeApi([MOD_ROLE]).api, makeStore(), {
      channelId: IDS.general,
    });
    await waitFor(() => expect(plain.result.current.permissions).not.toBeNull());
    expect(plain.result.current.canManageMessages).toBe(false);
    expect(plain.result.current.canViewChannel).toBe(true);
  });

  it('publishes permissionDenied when the member overwrite denies VIEW_CHANNEL', async () => {
    const overwrites: readonly Overwrite[] = [
      { id: IDS.me, type: 'member', allow: '0', deny: PERMISSIONS.VIEW_CHANNEL.toString() },
    ];
    const { result } = await renderPermissions(makeApi([MOD_ROLE]).api, makeStore(), {
      channelId: IDS.private,
      overwrites,
    });

    await waitFor(() =>
      expect(getSurfaceStates().permissionDenied).toBe('You do not have access to #private.'),
    );
    expect(result.current.canViewChannel).toBe(false);
  });

  it('fails open while the roles read is unresolved', async () => {
    let settle: (page: ListResponse<Role>) => void = () => undefined;
    const listRoles = jest.fn(
      (_workspaceId: string) =>
        new Promise<ListResponse<Role>>((resolve) => {
          settle = resolve;
        }),
    );
    const overwrites: readonly Overwrite[] = [
      { id: IDS.me, type: 'member', allow: '0', deny: PERMISSIONS.VIEW_CHANNEL.toString() },
    ];
    const { result } = await renderPermissions({ listRoles }, makeStore(), {
      channelId: IDS.private,
      overwrites,
    });

    // The read has not answered: no claim either way.
    expect(result.current.permissions).toBeNull();
    expect(getSurfaceStates().permissionDenied ?? null).toBeNull();

    settle(toListResponse([], CURSOR));
    await waitFor(() => expect(result.current.permissions).not.toBeNull());
    expect(getSurfaceStates().permissionDenied).toBe('You do not have access to #private.');
  });

  it('clears a published denial when the surface moves to a viewable channel', async () => {
    const overwrites: readonly Overwrite[] = [
      { id: IDS.me, type: 'member', allow: '0', deny: PERMISSIONS.VIEW_CHANNEL.toString() },
    ];
    const { result, rerender } = await renderPermissions(makeApi([MOD_ROLE]).api, makeStore(), {
      channelId: IDS.private,
      overwrites,
    });
    await waitFor(() =>
      expect(getSurfaceStates().permissionDenied).toBe('You do not have access to #private.'),
    );

    // The same workspace, without the deny: the cached roles resolve it at once.
    await rerender({ channelId: IDS.general, overwrites: [] });
    await waitFor(() => expect(result.current.canViewChannel).toBe(true));
    expect(getSurfaceStates().permissionDenied).toBeNull();
  });

  it('resolves the NEW channel when the prop switches with no store write (stale-selector regression)', async () => {
    const listRoles = jest.fn(
      async (workspaceId: string): Promise<ListResponse<Role>> =>
        toListResponse(workspaceId === IDS.ws ? [MOD_ROLE] : [], CURSOR),
    );
    const store = makeStore([IDS.modRole]);
    // A channel of a SECOND workspace: the member's moderator role is in `ws`,
    // so the other workspace's channel must resolve WITHOUT MANAGE_MESSAGES.
    store.setState((s) => ({
      channels: {
        ...s.channels,
        [IDS.other]: {
          id: IDS.other,
          workspace_id: IDS.wsTwo,
          name: 'other',
          type: 'text',
          topic: null,
          position: 2,
          last_message_id: null,
          created_at: '2026-09-08T00:00:00.000Z',
        },
      },
    }));

    // A stable api identity: an inline object would re-run the roles effect
    // every render (the effect keys on `api`).
    const api: RolesApi = { listRoles };
    const { result, rerender } = await renderHook(
      ({ channelId }: { channelId: string }) => useChannelPermissions(api, store, channelId),
      { initialProps: { channelId: IDS.general } },
    );
    await waitFor(() => expect(result.current.canManageMessages).toBe(true));

    // Channel switch with NO store write in between: the shell does not key
    // the channel screen by id, so the prop is all that moves.
    await rerender({ channelId: IDS.other });
    await waitFor(() => expect(result.current.canManageMessages).toBe(false));
    expect(result.current.canViewChannel).toBe(true);
  });

  it('re-reads the workspace roles when the session epoch advances (a mid-session grant converges)', async () => {
    // The server's role rows change while this client is away: the next fresh
    // gateway session (READY) must pick them up instead of keeping the
    // session-old read until relaunch.
    let granted = false;
    const listRoles = jest.fn(
      async (_workspaceId: string): Promise<ListResponse<Role>> =>
        toListResponse(granted ? [MOD_ROLE] : [], CURSOR),
    );
    const store = makeStore([]);
    const api: RolesApi = { listRoles };
    const { result } = await renderHook(() => useChannelPermissions(api, store, IDS.general));
    await waitFor(() => expect(result.current.permissions).not.toBeNull());
    expect(result.current.canManageMessages).toBe(false);
    expect(listRoles).toHaveBeenCalledTimes(1);

    granted = true;
    store.setState((s) => ({
      sessionEpoch: s.sessionEpoch + 1,
      membersById: {
        ...s.membersById,
        [IDS.me]: { ...s.membersById[IDS.me]!, roles: [IDS.modRole] },
      },
    }));

    await waitFor(() => expect(result.current.canManageMessages).toBe(true));
    expect(listRoles).toHaveBeenCalledTimes(2);
  });

  it('clears a published denial when the surface unmounts', async () => {
    const overwrites: readonly Overwrite[] = [
      { id: IDS.me, type: 'member', allow: '0', deny: PERMISSIONS.VIEW_CHANNEL.toString() },
    ];
    const { unmount } = await renderPermissions(makeApi([MOD_ROLE]).api, makeStore(), {
      channelId: IDS.private,
      overwrites,
    });
    await waitFor(() =>
      expect(getSurfaceStates().permissionDenied).toBe('You do not have access to #private.'),
    );

    await unmount();
    await waitFor(() => expect(getSurfaceStates().permissionDenied).toBeNull());
  });
});
