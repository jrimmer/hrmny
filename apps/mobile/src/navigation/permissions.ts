/**
 * @cytale/mobile — on-device channel permission resolution (plan 004 R15:
 * the `permission-denied` producer).
 *
 * The shell's `permissionDenied` state had no producer because the store
 * hydrates no roles, so `@cytale/domain`'s resolver could not run on-device.
 * It can now. Three sources combine here:
 *   * the workspace's role rows — `GET /workspaces/{id}/roles`, cached per
 *     workspace (one read per session per workspace, deduped while in
 *     flight), never refetched per render;
 *   * the current member's held role ids — the roster the REST bootstrap
 *     already stores (`WorkspaceMember.roles`, decimal-string snowflakes);
 *   * the channel's overwrites — see the caveat below.
 *
 * Two server truths this module mirrors deliberately:
 *
 *   * `@everyone` is SYNTHETIC. There is no `@everyone` role row anywhere:
 *     the server synthesizes the base at resolve time
 *     (`Cytale.Permissions.Principal.load_member_roles`) as VIEW_CHANNEL +
 *     SEND_MESSAGES + START_CALL + SEND_VIDEO + SHARE_SCREEN. The roles list
 *     endpoint returns real rows only, so the base is synthesized here too —
 *     `EVERYONE_BASE_PERMISSIONS` must track that list.
 *   * Channel overwrites are NOT fetchable from the client today: the
 *     api-client exposes `putChannelOverwrites` with no read counterpart
 *     (the server's `GET /channels/{id}/overwrites` exists, the client
 *     method does not), so production passes an EMPTY overwrite list and
 *     the resolver's steps 3-8 are no-ops. `options.overwrites` is the seam
 *     for the read landing, and for tests. Overwrites are how a channel is
 *     made private server-side (a member overwrite denying VIEW_CHANNEL), so
 *     until the read exists the producer below cannot fire in production —
 *     the wiring is complete and the gap is the read, not the gate.
 *
 * The resolution is an AFFORDANCE GATE ONLY (the resolver's own contract):
 * the server re-evaluates every mutation and stays authoritative. This
 * module never gates a write.
 */
import { useEffect, useMemo, useState } from 'react';

import type { CytaleApiClient } from '@cytale/api-client';
import {
  PERMISSIONS,
  resolveChannelPermissions,
  type Overwrite,
  type Role,
  type RoleLike,
} from '@cytale/domain';

import { setSurfaceStates } from './shellState';
import { useStoreSelector, type StoreLike } from './store';

/**
 * The server's resolve-time `@everyone` base (`principal.ex`): view + send +
 * add_reactions + start_call + send_video + share_screen + change_nickname.
 * Not a stored role — synthesized for every member, channel-overridable
 * through the normal 8-step engine.
 */
export const EVERYONE_BASE_PERMISSIONS: bigint =
  PERMISSIONS.VIEW_CHANNEL |
  PERMISSIONS.SEND_MESSAGES |
  PERMISSIONS.ADD_REACTIONS |
  PERMISSIONS.START_CALL |
  PERMISSIONS.SEND_VIDEO |
  PERMISSIONS.SHARE_SCREEN |
  PERMISSIONS.CHANGE_NICKNAME;

/** No channel overwrites are readable yet (see the module note). */
const NO_OVERWRITES: readonly Overwrite[] = [];

/** The api surface this module needs (structural, so tests pass a stub). */
export type RolesApi = Pick<CytaleApiClient, 'listRoles'>;

// ---------------------------------------------------------------------------
// Role cache (module-level, per workspace)
// ---------------------------------------------------------------------------

/**
 * The server answers `{"roles": [...]}` (`RoleController.index`) while
 * `listRoles` is typed as a `ListResponse<Role>` — the declared `.items` is
 * absent on the wire, so read BOTH shapes rather than trusting one.
 */
function roleItems(page: unknown): readonly Role[] {
  if (page === null || typeof page !== 'object') return [];
  const envelope = page as { items?: readonly Role[]; roles?: readonly Role[] };
  if (Array.isArray(envelope.items)) return envelope.items;
  return Array.isArray(envelope.roles) ? envelope.roles : [];
}

/**
 * Workspace id → in-flight/resolved role rows. The PROMISE is cached, so
 * concurrent mounts share one request and a settled read is never repeated;
 * a rejection is evicted so the next mount retries.
 */
const rolesByWorkspace = new Map<string, Promise<readonly RoleLike[]>>();

/** The workspace's role rows, fetched once per workspace. */
export function loadWorkspaceRoles(api: RolesApi, workspaceId: string): Promise<readonly RoleLike[]> {
  const cached = rolesByWorkspace.get(workspaceId);
  if (cached !== undefined) return cached;

  const pending = api.listRoles(workspaceId).then(
    (page) => roleItems(page).map((role) => ({ id: role.id, permissions: role.permissions })),
    (error: unknown) => {
      rolesByWorkspace.delete(workspaceId);
      throw error;
    },
  );
  rolesByWorkspace.set(workspaceId, pending);
  return pending;
}

/**
 * Drop the role cache (tests; a sign-out that must not leak across users).
 *
 * Roles are workspace-scoped and change rarely, so a settled read is kept for
 * the session; `syncRoleCacheEpoch` below is what makes a mid-session change
 * converge in production.
 */
export function resetWorkspaceRoles(): void {
  rolesByWorkspace.clear();
  epochSeen = null;
}

/**
 * The store's `sessionEpoch` the cache was filled under. A fresh gateway
 * session (READY advances the epoch, reconcile.ts) can carry role changes the
 * client was away for — a grant or a revocation landed while offline. Without
 * an invalidation key the cached rows would keep the stale affordance until
 * the app was relaunched, so the epoch is it: the cache drops the moment the
 * epoch moves and the next render re-reads.
 */
let epochSeen: number | null = null;

/**
 * Drop the cached role rows when the store's session epoch advances. Called by
 * `useChannelPermissions` on every render (cheap: two primitive compares);
 * the FIRST observation only records the epoch, so mounting does not throw
 * away a cache filled earlier in the session.
 */
export function syncRoleCacheEpoch(epoch: number): void {
  if (epochSeen === epoch) return;
  const known = epochSeen !== null;
  epochSeen = epoch;
  if (known) rolesByWorkspace.clear();
}

// ---------------------------------------------------------------------------
// Pure resolution
// ---------------------------------------------------------------------------

export interface MemberChannelPermissionInput {
  /** The channel's workspace — also the synthesized `@everyone` role id. */
  workspaceId: string;
  /** The member whose bits are resolved (the current user on-device). */
  memberId: string;
  /** Role ids the member holds (`WorkspaceMember.roles`). */
  roleIds: readonly string[];
  /** The workspace's role rows (`loadWorkspaceRoles`). */
  roles: readonly RoleLike[];
  /** Channel overwrites; empty until the read exists. */
  overwrites?: readonly Overwrite[];
}

/**
 * Resolve one member's effective channel permissions. Holds only the roles
 * the member actually has (an unheld role's overwrite is ignored — the
 * resolver's step 5-6 rule), over the synthesized `@everyone` base.
 */
export function resolveMemberChannelPermissions(input: MemberChannelPermissionInput): bigint {
  const held = new Set(input.roleIds);
  const memberRoles = input.roles.filter((role) => held.has(role.id));
  const everyone: RoleLike = {
    id: input.workspaceId,
    permissions: EVERYONE_BASE_PERMISSIONS.toString(),
  };
  return resolveChannelPermissions(
    everyone,
    memberRoles,
    input.overwrites ?? NO_OVERWRITES,
    input.memberId,
  );
}

// ---------------------------------------------------------------------------
// React binding + R15 producer
// ---------------------------------------------------------------------------

/** The current user's effective permissions for one channel. */
export interface ChannelPermissions {
  /**
   * Resolved bitfield, or null while the resolution is not definitive
   * (roles still loading, the read failed, a DM channel, the channel is not
   * in the store, or the roster carries no row for the current user).
   */
  permissions: bigint | null;
  /** True only when `permissions` is definitive and includes VIEW_CHANNEL. */
  canViewChannel: boolean;
  canSendMessages: boolean;
  canManageMessages: boolean;
}

export interface UseChannelPermissionsOptions {
  /**
   * Channel overwrites to resolve with. Defaults to empty: the api-client
   * has no overwrites read yet (module note). Tests inject denials here.
   */
  overwrites?: readonly Overwrite[];
}

const UNRESOLVED: ChannelPermissions = {
  permissions: null,
  canViewChannel: false,
  canSendMessages: false,
  canManageMessages: false,
};

/**
 * The current user's channel permissions, resolved on-device, plus the
 * shell's `permissionDenied` producer.
 *
 * Publishes `permissionDenied` (through `setSurfaceStates`) exactly when the
 * resolution is DEFINITIVE and lacks VIEW_CHANNEL; an unresolved state fails
 * open so a transient role-read failure can never lock a member out of a
 * channel the server would let them read. Switching channels (or unmounting)
 * clears a denial this hook published.
 */
export function useChannelPermissions(
  api: RolesApi,
  store: StoreLike,
  channelId: string | null,
  options: UseChannelPermissionsOptions = {},
): ChannelPermissions {
  const { overwrites = NO_OVERWRITES } = options;

  // Selectors are PURE functions of state (the lookup is hoisted out, the way
  // `useChannel` does it) so a channel switch can never be served from a cache
  // entry computed for the channel before it.
  const channels = useStoreSelector(store, (state) => state.channels);
  const channel = channelId === null ? undefined : channels[channelId];
  const currentUserId = useStoreSelector(store, (state) => state.currentUser?.id ?? null);
  const membersById = useStoreSelector(store, (state) => state.membersById);
  const sessionEpoch = useStoreSelector(store, (state) => state.sessionEpoch);

  // Roles survive a whole session, but a fresh READY (epoch bump) may carry a
  // mid-session grant or revocation — drop the cache before the effect below
  // re-reads (a stale affordance must not outlive the session it was read in).
  syncRoleCacheEpoch(sessionEpoch);

  const workspaceId = channel?.workspace_id ?? null;
  const member = currentUserId === null ? undefined : membersById[currentUserId];
  const roleIds = member?.roles;

  // Roles are read once per workspace; the effect re-runs only when the api
  // instance, the workspace or the session epoch changes (not per render).
  const [roles, setRoles] = useState<readonly RoleLike[] | null>(null);
  useEffect(() => {
    if (workspaceId === null) {
      setRoles(null);
      return;
    }
    let live = true;
    setRoles(null);
    loadWorkspaceRoles(api, workspaceId).then(
      (loaded) => {
        if (live) setRoles(loaded);
      },
      () => {
        // Fail open: a failed read resolves nothing and claims nothing.
        if (live) setRoles(null);
      },
    );
    return () => {
      live = false;
    };
  }, [api, workspaceId, sessionEpoch]);

  const permissions = useMemo(() => {
    if (workspaceId === null || currentUserId === null) return null;
    if (roles === null || roleIds === undefined) return null;
    return resolveMemberChannelPermissions({
      workspaceId,
      memberId: currentUserId,
      roleIds,
      roles,
      overwrites,
    });
  }, [currentUserId, overwrites, roleIds, roles, workspaceId]);

  const channelName = channel?.name ?? channelId ?? '';
  const denial =
    permissions !== null && (permissions & PERMISSIONS.VIEW_CHANNEL) !== PERMISSIONS.VIEW_CHANNEL
      ? `You do not have access to #${channelName}.`
      : null;

  useEffect(() => {
    if (permissions === null) return;
    setSurfaceStates({ permissionDenied: denial });
    return () => {
      // The surface this hook resolved for is gone (channel switch, unmount):
      // a denial it published must not outlive it.
      if (denial !== null) setSurfaceStates({ permissionDenied: null });
    };
  }, [denial, permissions]);

  if (permissions === null) return UNRESOLVED;
  return {
    permissions,
    canViewChannel: (permissions & PERMISSIONS.VIEW_CHANNEL) === PERMISSIONS.VIEW_CHANNEL,
    canSendMessages: (permissions & PERMISSIONS.SEND_MESSAGES) === PERMISSIONS.SEND_MESSAGES,
    canManageMessages: (permissions & PERMISSIONS.MANAGE_MESSAGES) === PERMISSIONS.MANAGE_MESSAGES,
  };
}
