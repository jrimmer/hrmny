/**
 * @cytale/web — may the viewer create invites in a workspace?
 *
 * Invite creation needs CREATE_INVITES (server: InviteController). The
 * server enforces it; this gate is what keeps the Invite People entry from
 * being offered to someone who will only ever get a 403. The answer comes
 * from the viewer's effective workspace bits (`GET /workspaces/{id}` →
 * `permissions`); the owner always may. While the answer is unknown (loading,
 * an older server, a failed read) the entry stays, and the dialog's own 403
 * copy carries the refusal.
 */
import { useEffect, useState } from 'react';

import { has, parseBitfield, type PermissionName } from '@cytale/domain';

export interface CanCreateInvitesInput {
  selfId: string | null | undefined;
  ownerId: string | null | undefined;
  /** The viewer's workspace bits (decimal string), or null when unknown. */
  permissions: string | null | undefined;
}

/**
 * May the viewer do what `permission` gates, from their workspace bits?
 * The owner always may; ADMINISTRATOR implies everything. true / false when
 * known; null when the bits are not (yet) known.
 */
export function canFrom(
  permission: PermissionName,
  { selfId, ownerId, permissions }: CanCreateInvitesInput,
): boolean | null {
  if (selfId && ownerId && selfId === ownerId) return true;
  if (typeof permissions !== 'string' || !/^\d+$/.test(permissions)) return null;
  const bits = parseBitfield(permissions);
  return has(bits, permission) || has(bits, 'ADMINISTRATOR');
}

/** true / false when known; null when the bits are not (yet) known. */
export function canCreateInvitesFrom(input: CanCreateInvitesInput): boolean | null {
  return canFrom('CREATE_INVITES', input);
}

/** Invite People: CREATE_INVITES (see `useWorkspaceCan`). */
export function useCanCreateInvites(
  workspaceId: string | null | undefined,
  selfId: string | null | undefined,
  ownerId: string | null | undefined,
  fetchPermissions: (workspaceId: string) => Promise<string | null>,
): boolean | null {
  return useWorkspaceCan('CREATE_INVITES', workspaceId, selfId, ownerId, fetchPermissions);
}

/**
 * The hook form: fetches the viewer's bits for `workspaceId` (skipped for
 * the owner) and re-reads when the workspace changes. Generic over the
 * permission (#169 added MANAGE_NICKNAMES beside CREATE_INVITES).
 */
export function useWorkspaceCan(
  permission: PermissionName,
  workspaceId: string | null | undefined,
  selfId: string | null | undefined,
  ownerId: string | null | undefined,
  fetchPermissions: (workspaceId: string) => Promise<string | null>,
): boolean | null {
  const [permissions, setPermissions] = useState<{ workspaceId: string; bits: string | null } | null>(null);
  const isOwner = !!selfId && !!ownerId && selfId === ownerId;

  useEffect(() => {
    if (!workspaceId || isOwner) return;
    let cancelled = false;
    fetchPermissions(workspaceId).then(
      (bits) => {
        if (!cancelled) setPermissions({ workspaceId, bits });
      },
      () => {
        if (!cancelled) setPermissions({ workspaceId, bits: null });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [workspaceId, isOwner, fetchPermissions]);

  if (!workspaceId) return null;
  const bits = permissions?.workspaceId === workspaceId ? permissions.bits : null;
  return canFrom(permission, { selfId, ownerId, permissions: bits });
}
