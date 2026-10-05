/**
 * @cytale/domain — Cytale permission bitfield.
 *
 * Bit positions are the shared contract with the server-side engine (U7's
 * `apps/server/lib/cytale/permissions/bitfield.ex`, Discord-aligned set named
 * in the plan). Serialized over REST and gateway events as a decimal STRING
 * (preserves bits above 2^53 — JavaScript numbers silently round there), so
 * every runtime helper here decodes through BigInt.
 */

/** Object mapping permission names to their bit values. */
export const PERMISSIONS = {
  /** Entry gate: without it a member sees nothing in the workspace. */
  VIEW_CHANNEL: 1n << 0n,
  SEND_MESSAGES: 1n << 1n,
  READ_MESSAGE_HISTORY: 1n << 2n,
  MANAGE_CHANNELS: 1n << 3n,
  MANAGE_ROLES: 1n << 4n,
  MANAGE_WORKSPACE: 1n << 5n,
  MANAGE_MESSAGES: 1n << 6n,
  MENTION_EVERYONE: 1n << 7n,
  CREATE_INVITES: 1n << 8n,
  KICK_MEMBERS: 1n << 9n,
  BAN_MEMBERS: 1n << 10n,
  ADMINISTRATOR: 1n << 11n,
  CREATE_THREADS: 1n << 12n,
  MANAGE_THREADS: 1n << 13n,
  UPLOAD_ATTACHMENTS: 1n << 14n,
  ADD_REACTIONS: 1n << 15n,
  /** Start (and ring) voice calls in a channel; default-on for @everyone. */
  START_CALL: 1n << 16n,
  /** Publish camera video in a call (calls V2 plan R13/VM7 — default-on for
   * @everyone, channel-overridable; receiving video rides VIEW_CHANNEL). */
  SEND_VIDEO: 1n << 17n,
  /** Publish a screen share and its optional share-audio track (calls V2
   * plan R13/VM7/KTD3 — one bit gates BOTH `screen` and `screen_audio`;
   * share-audio is at least as sensitive as the screen, never ungated). */
  SHARE_SCREEN: 1n << 18n,
  /** Set your OWN workspace nickname (#169); default-on for @everyone. */
  CHANGE_NICKNAME: 1n << 19n,
  /** Set other members' workspace nicknames, below you in the role
   * hierarchy (#169). */
  MANAGE_NICKNAMES: 1n << 20n,
} as const;

export type PermissionName = keyof typeof PERMISSIONS;

/**
 * Fully-populated bitfield (every defined permission, OR-ed together).
 * ADMINISTRATOR bypass semantics make this equivalent to "all permissions".
 */
export const ALL_PERMISSIONS: bigint = Object.values(PERMISSIONS).reduce(
  (acc, bit) => acc | bit,
  0n
);

/** The administrator override flag. */
export const ADMINISTRATOR: bigint = PERMISSIONS.ADMINISTRATOR;

// ---------------------------------------------------------------------------
// Low-level bitfield helpers (BigInt-backed; wire form is decimal strings)
// ---------------------------------------------------------------------------

/** Decode a decimal-string bitfield from the wire into BigInt bits. */
export function parseBitfield(value: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new TypeError(`permission bitfield must be a decimal string, got ${JSON.stringify(value)}`);
  }
  return BigInt(value);
}

/** Encode BigInt bits into the canonical decimal-string wire form. */
export function toWireFormat(bits: bigint): string {
  return bits.toString(10);
}

/** True iff `bits` contains permission `name`. */
export function has(bits: bigint, name: PermissionName): boolean {
  return (bits & PERMISSIONS[name]) === PERMISSIONS[name];
}

/** Return a new bitfield with permission `name` set. */
export function enable(bits: bigint, name: PermissionName): bigint {
  return bits | PERMISSIONS[name];
}

/** Return a new bitfield with permission `name` cleared. */
export function disable(bits: bigint, name: PermissionName): bigint {
  return bits & ~PERMISSIONS[name];
}

/** Set of every permission name contained in `bits`. */
export function toNames(bits: bigint): ReadonlySet<PermissionName> {
  const out = new Set<PermissionName>();
  for (const [name, bit] of Object.entries(PERMISSIONS)) {
    if ((bits & bit) === bit) out.add(name as PermissionName);
  }
  return out;
}
