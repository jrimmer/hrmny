/**
 * @cytale/domain — client-side channel-permission resolution.
 *
 * Pure BigInt mirror of the server's 8-step Discord-aligned algorithm (U7),
 * used ONLY for affordance hiding — composing the UI before the round trip
 * so members never see controls they cannot use. The server re-evaluates
 * every mutation and remains authoritative; this must never be the sole
 * gate for anything with real effect.
 */

import { ADMINISTRATOR, ALL_PERMISSIONS, type PermissionName, has } from './permissions.js';

/** Overwrite target discriminator (Discord semantics: role vs member). */
export type OverwriteType = 'role' | 'member';

/**
 * A channel permission overwrite: apply `allow`/`deny` decimal-string
 * bitfields to the target identified by (`type`, `id`) after base+roles
 * resolution.
 */
export interface Overwrite {
  /** Target entity id — a role id or a user (member) id. */
  id: string;
  type: OverwriteType;
  allow: string;
  deny: string;
}

/** Role-shaped input: a wire permissions bitfield plus its role id. */
export interface RoleLike {
  id: string;
  permissions: string;
}

/** Wire-form member/user id, used to pick out member overwrites. */
export type UserId = string;

/**
 * Resolve effective channel permissions for a member — the exact 8-step
 * Discord algorithm mirrored from the server:
 *
 * 1. start from base @everyone-role permissions
 * 2. OR in the union of permissions granted by each of the member's roles
 *    (ADMINISTRATOR anywhere here short-circuits to ALL_PERMISSIONS)
 * 3. AND-NOT the @everyone channel-overwrite deny bits
 * 4. OR the @everyone channel-overwrite allow bits
 * 5. AND-NOT the union of per-role deny bits (roles the member holds)
 * 6. OR the union of per-role allow bits (roles the member holds)
 * 7. AND-NOT the member overwrite deny bits
 * 8. OR the member overwrite allow bits
 *
 * A missing/empty @everyone role yields base 0; later steps can still grant
 * bits. Later stages always win over earlier ones on the same bit, matching
 * Discord precedence.
 */
export function resolveChannelPermissions(
  everyoneRole: RoleLike,
  memberRoles: readonly RoleLike[],
  channelOverwrites: readonly Overwrite[],
  memberId?: UserId
): bigint {
  // Steps 1-2: base @everyone, then union every held role.
  let perms = parseBits(everyoneRole.permissions);
  for (const role of memberRoles) {
    perms |= parseBits(role.permissions);
  }

  // ADMINISTRATOR bypasses all channel overwrites (server-mirrored).
  if ((perms & ADMINISTRATOR) === ADMINISTRATOR) {
    return ALL_PERMISSIONS;
  }

  // Steps 3-4: @everyone overwrite (matched by id == the everyone role's id).
  const appliedEveryone = new Set<string>();
  for (const ow of channelOverwrites) {
    if (ow.type === 'role' && ow.id === everyoneRole.id && !appliedEveryone.has(ow.id)) {
      perms = (perms & ~parseBits(ow.deny)) | parseBits(ow.allow);
      appliedEveryone.add(ow.id);
    }
  }

  // Steps 5-6: per-role overwrites for roles the member actually holds.
  const heldRoleIds = new Set(memberRoles.map(role => role.id));
  for (const ow of channelOverwrites) {
    if (ow.type !== 'role') continue;
    if (!heldRoleIds.has(ow.id)) continue; // deny bits of unheld roles are ignored
    perms = (perms & ~parseBits(ow.deny)) | parseBits(ow.allow);
  }

  // Steps 7-8: member overwrite for THIS member only.
  if (memberId !== undefined) {
    for (const ow of channelOverwrites) {
      if (ow.type === 'member' && ow.id === memberId) {
        perms = (perms & ~parseBits(ow.deny)) | parseBits(ow.allow);
      }
    }
  }

  return perms;
}

/** Convenience check: does the resolved bitfield include `permission`? */
export function can(resolved: bigint, permission: PermissionName): boolean {
  return has(resolved, permission);
}

function parseBits(value: string): bigint {
  return /^\d+$/.test(value) ? BigInt(value) : 0n;
}
