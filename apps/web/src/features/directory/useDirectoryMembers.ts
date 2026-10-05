/**
 * @cytale/web — People Directory store seam (U26).
 *
 * The plan reads members/presence from the U17 state store. apps/web does not
 * yet depend on `@cytale/state` (that wiring lands with U19's authStore), so
 * this module defines a MINIMAL local hook over a store-like shape. It is a
 * seam, not a reimplementation: when U19 wires the real store, this hook's
 * input type is satisfied by the U17 `StateState` slices (`membersById`,
 * `memberIdsByWorkspace`, `presenceByUser`) without changing the surface.
 *
 * NOTE (evidence): no `packages/**` edits per task rules — the local hook is
 * the documented seam until U19's authStore lands.
 */

import { useMemo } from 'react';

import type { PrincipalKind } from '@cytale/domain';

import type { PeopleMember, PresenceByUser, PresenceStatus } from './types.js';

/** Minimal store projection the directory reads (U17-compatible shape). */
export interface DirectoryStore {
  membersById: Record<
    string,
    {
      id: string;
      username: string;
      /** The account's display name (#168). */
      display_name?: string | null;
      avatar_url?: string | null;
      nickname?: string | null;
      /** U12 attribution: principal kind + owning human, preserved from the
       * roster projection (@cytale/state WorkspaceMember). */
      kind?: PrincipalKind;
      parent_user_id?: string;
    }
  >;
  memberIdsByWorkspace: Record<string, string[]>;
  /** Per-workspace nicknames (#169); the live source for a row's nickname. */
  nicknamesByWorkspace?: Record<string, Record<string, string>>;
  presenceByUser: Record<string, { status: PresenceStatus }>;
}

/**
 * Derive the member list for a workspace from the store, joined with
 * presence. Falls back to an empty list when the store has no membership for
 * the workspace (loading/empty states are the surface's concern).
 */
export function useDirectoryMembers(
  store: DirectoryStore | null,
  workspaceId: string,
): { members: PeopleMember[]; presence: PresenceByUser } {
  return useMemo(() => {
    if (!store) return { members: [], presence: {} };

    const ids = store.memberIdsByWorkspace[workspaceId] ?? [];
    const members: PeopleMember[] = [];
    const presence: PresenceByUser = {};

    for (const id of ids) {
      const m = store.membersById[id];
      if (!m) continue;
      members.push({
        user: { id: m.id, username: m.username, display_name: m.display_name ?? null, avatar_url: m.avatar_url ?? null },
        // This workspace's nickname (#169), never the shared row's.
        nickname: store.nicknamesByWorkspace?.[workspaceId]?.[id] ?? null,
        joined_at: null,
        roles: [],
        kind: m.kind,
        parent_user_id: m.parent_user_id,
      });
      const p = store.presenceByUser[id];
      presence[id] = p ? p.status : 'offline';
    }

    return { members, presence };
  }, [store, workspaceId]);
}
