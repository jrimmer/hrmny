/**
 * @cytale/domain — permission bitfield + client-side resolution tests.
 *
 * Fixtures encode the plan's representative cases (U7 mirror): base+roles
 * OR, channel deny overriding role allow, ADMINISTRATOR bypass, and the
 * member deny/allow final steps. Permission bit positions match the
 * Discord-aligned server set; all values are decimal-string wire form.
 */
import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  disable,
  enable,
  has,
  parseBitfield,
  toNames,
  toWireFormat,
} from '../permissions.js';
import {
  can,
  resolveChannelPermissions,
  type Overwrite,
  type RoleLike,
} from '../channel-permissions.js';
import type { PermissionName } from '../permissions.js';

// ---------------------------------------------------------------------------
// Fixture vocabulary (mirrors the U7 test cases)
// ---------------------------------------------------------------------------

const EVERYONE_ID = '1000000000000000001';
const MODERATOR_ROLE_ID = '1000000000000000002';
const MEMBER_ID = '2000000000000000001';

const base: RoleLike = { id: EVERYONE_ID, permissions: '7' }; // V|SEND|HISTORY

const modRole: RoleLike = {
  id: MODERATOR_ROLE_ID,
  permissions: String((1n << 3n) | (1n << 13n)), // MANAGE_CHANNELS|MANAGE_THREADS
};

const adminRole: RoleLike = {
  id: '1000000000000000009',
  permissions: String(1n << 11n), // ADMINISTRATOR only
};

const memberOverwrite: Overwrite = {
  id: MEMBER_ID,
  type: 'member',
  allow: String((1n << 3n) | (1n << 13n)),
  deny: '0',
};

// ---------------------------------------------------------------------------
// Bitfield primitives
// ---------------------------------------------------------------------------

describe('permission bitfield primitives', () => {
  it('exposes distinct power-of-two bits for every named permission', () => {
    const seen = new Set<string>();
    for (const bit of Object.values(PERMISSIONS)) {
      expect(bit > 0n).toBe(true);
      expect((bit & (bit - 1n)).toString()).toBe('0'); // single-bit
      expect(seen.has(bit.toString())).toBe(false); // pairwise distinct
      seen.add(bit.toString());
    }
  });

  // Mirror of the server pin (apps/server/test/cytale/permissions/
  // bitfield_test.exs @ts_contract): the two sides cannot drift.
  it('pins the set at 21 bits with START_CALL at 1<<16 (voice plan U3 + calls V2 U2 + #169 nicknames)', () => {
    expect(Object.keys(PERMISSIONS)).toHaveLength(21);
    expect(PERMISSIONS.START_CALL).toBe(1n << 16n);
    expect(PERMISSIONS.ADD_REACTIONS).toBe(1n << 15n); // gap-free before it
  });

  // Calls V2 plan U2 (R13/VM7): the two media bits consume the next free
  // positions above START_CALL — 1<<17 and 1<<18 were free (START_CALL at
  // 1<<16 topped the field before), and the set stays gap-free.
  it('pins SEND_VIDEO at 1<<17 and SHARE_SCREEN at 1<<18 (calls V2 plan U2)', () => {
    expect(PERMISSIONS.SEND_VIDEO).toBe(1n << 17n);
    expect(PERMISSIONS.SHARE_SCREEN).toBe(1n << 18n);
    // Gap-free adjacency: each new bit is exactly double the previous.
    expect(PERMISSIONS.SEND_VIDEO).toBe(PERMISSIONS.START_CALL * 2n);
    expect(PERMISSIONS.SHARE_SCREEN).toBe(PERMISSIONS.SEND_VIDEO * 2n);
  });

  // #169: the nickname bits take the next free positions, gap-free.
  it('pins CHANGE_NICKNAME at 1<<19 and MANAGE_NICKNAMES at 1<<20', () => {
    expect(PERMISSIONS.CHANGE_NICKNAME).toBe(1n << 19n);
    expect(PERMISSIONS.MANAGE_NICKNAMES).toBe(1n << 20n);
    expect(PERMISSIONS.CHANGE_NICKNAME).toBe(PERMISSIONS.SHARE_SCREEN * 2n);
    // Nothing rides above MANAGE_NICKNAMES yet.
    const maxBit = Object.values(PERMISSIONS).reduce((a, b) => (a > b ? a : b));
    expect(maxBit).toBe(PERMISSIONS.MANAGE_NICKNAMES);
  });

  it('round-trips decimal-string wire format through BigInt', () => {
    const value = ALL_PERMISSIONS;
    const decoded = parseBitfield(toWireFormat(value));
    expect(decoded).toBe(value);
    expect(has(decoded, 'ADMINISTRATOR')).toBe(true);
  });

  it('rejects non-decimal garbage in wire input', () => {
    expect(() => parseBitfield('0x1f')).toThrow(TypeError);
    expect(() => parseBitfield('')).toThrow(TypeError);
    expect(() => parseBitfield('-4')).toThrow(TypeError);
  });

  it('enable/disable compose as set operations', () => {
    let bits = 0n;
    bits = enable(bits, 'VIEW_CHANNEL');
    bits = enable(bits, 'READ_MESSAGE_HISTORY');
    expect(has(bits, 'VIEW_CHANNEL')).toBe(true);
    expect(has(bits, 'SEND_MESSAGES')).toBe(false);
    bits = disable(bits, 'VIEW_CHANNEL');
    expect(has(bits, 'VIEW_CHANNEL')).toBe(false);
  });

  it('toNames enumerates exactly the set bits', () => {
    const names = toNames(parseBitfield('7'));
    expect([...names].sort()).toEqual(['READ_MESSAGE_HISTORY', 'SEND_MESSAGES', 'VIEW_CHANNEL']);
  });
});

// ---------------------------------------------------------------------------
// Client-side resolution (U7 8-step algorithm mirror)
// ---------------------------------------------------------------------------

describe('resolveChannelPermissions', () => {
  it('step 1-2 happy path: ORs @everyone base with held-role grants', () => {
    // no overwrites at all — pure workspace-level accumulation:
    // base (V|SEND|HISTORY = 7) OR modRole (MANAGE_CHANNELS|MANAGE_THREADS = 8200).
    const resolved = resolveChannelPermissions(base, [modRole], [], MEMBER_ID);
    expect(resolved).toBe(parseBitfield('8207'));
  });

  it('channel @everyone deny strips a workspace-level allow', () => {
    // channel overwrite denies READ_MESSAGE_HISTORY for @everyone
    const resolved = resolveChannelPermissions(
      base,
      [],
      [{ id: EVERYONE_ID, type: 'role', allow: '0', deny: '4' }],
      MEMBER_ID
    );
    expect(can(resolved, 'VIEW_CHANNEL')).toBe(true);
    expect(can(resolved, 'SEND_MESSAGES')).toBe(true);
    expect(can(resolved, 'READ_MESSAGE_HISTORY')).toBe(false);
  });

  it('channel @everyone allow grants a bit the roles never had', () => {
    const viewOnly: RoleLike = { id: EVERYONE_ID, permissions: '1' };
    const resolved = resolveChannelPermissions(
      viewOnly,
      [],
      [{ id: EVERYONE_ID, type: 'role', allow: '4', deny: '0' }],
      MEMBER_ID
    );
    expect(can(resolved, 'READ_MESSAGE_HISTORY')).toBe(true);
    expect(can(resolved, 'SEND_MESSAGES')).toBe(false);
  });

  it('channel deny for @everyone overrides a role-level allow', () => {
    // role grants SEND_MESSAGES (bit 2), channel @everyone denies it
    const senderRole: RoleLike = { id: MODERATOR_ROLE_ID, permissions: '6' };
    const resolved = resolveChannelPermissions(
      base,
      [senderRole],
      [{ id: EVERYONE_ID, type: 'role', allow: '0', deny: '2' }],
      MEMBER_ID
    );
    expect(can(resolved, 'SEND_MESSAGES')).toBe(false);
  });

  it('per-role channel allow re-grants after an @everyone deny', () => {
    const resolved = resolveChannelPermissions(
      base,
      [],
      [
        { id: EVERYONE_ID, type: 'role', allow: '0', deny: '2' },
        { id: MODERATOR_ROLE_ID, type: 'role', allow: '2', deny: '0' },
      ],
      MEMBER_ID
    );
    // The member holds NO moderator role here, so steps 5-6 skip the
    // moderator overwrite entirely; the everyone-deny sticks.
    expect(can(resolved, 'SEND_MESSAGES')).toBe(false);
  });

  it('held-role channel allow restores a bit denied to @everyone', () => {
    const senderRole: RoleLike = { id: MODERATOR_ROLE_ID, permissions: '6' };
    const resolved = resolveChannelPermissions(
      base,
      [senderRole],
      [
        { id: EVERYONE_ID, type: 'role', allow: '0', deny: '2' },
        { id: MODERATOR_ROLE_ID, type: 'role', allow: '2', deny: '0' },
      ],
      MEMBER_ID
    );
    // steps 5-6: role-deny is empty so nothing stripped; role-allow re-grants.
    expect(can(resolved, 'SEND_MESSAGES')).toBe(true);
  });

  it('per-role deny strips a workspace allow from that same role', () => {
    const senderRole: RoleLike = { id: MODERATOR_ROLE_ID, permissions: '6' };
    const resolved = resolveChannelPermissions(
      base,
      [senderRole],
      [{ id: MODERATOR_ROLE_ID, type: 'role', allow: '0', deny: '2' }],
      MEMBER_ID
    );
    // role grants SEND (step 2) then its channel overwrite denies it (step 5).
    expect(can(resolved, 'SEND_MESSAGES')).toBe(false);
    expect(can(resolved, 'READ_MESSAGE_HISTORY')).toBe(true); // from role bit 4
  });

  it('ADMINISTRATOR bypasses every channel overwrite', () => {
    const resolved = resolveChannelPermissions(
      base,
      [adminRole],
      [
        { id: EVERYONE_ID, type: 'role', allow: '0', deny: String(ALL_PERMISSIONS) },
        { id: '9999999999999999999', type: 'member', allow: '0', deny: String(ALL_PERMISSIONS) },
      ],
      MEMBER_ID
    );
    expect(resolved).toBe(ALL_PERMISSIONS);
  });

  it('member overwrite deny strips a role-granted bit (step 7)', () => {
    const denyManage: Overwrite = {
      id: MEMBER_ID,
      type: 'member',
      allow: '0',
      deny: String((1n << 3n) | (1n << 13n)),
    };
    const resolved = resolveChannelPermissions(base, [modRole], [denyManage], MEMBER_ID);
    // modRole granted MANAGE_CHANNELS|MANAGE_THREADS at workspace level;
    // the member-targeted channel deny strips both.
    const denied = (1n << 3n) | (1n << 13n);
    expect((resolved & denied).toString()).toBe('0');
    expect(can(resolved, 'SEND_MESSAGES')).toBe(true); // untouched bits survive
  });

  it('member overwrite allow adds bits on top (step 8)', () => {
    const resolved = resolveChannelPermissions(base, [], [memberOverwrite], MEMBER_ID);
    expect(can(resolved, 'MANAGE_CHANNELS')).toBe(true);
    expect(can(resolved, 'MANAGE_THREADS')).toBe(true);
  });

  it('member overwrite with same-bit allow+deny nets to allow (step 8 applied after step 7)', () => {
    const ow: Overwrite = { id: MEMBER_ID, type: 'member', allow: '8', deny: '8' };
    const resolved = resolveChannelPermissions(base, [], [ow], MEMBER_ID);
    expect(can(resolved, 'MANAGE_CHANNELS')).toBe(true);
  });

  it('member overwrite applies ONLY to its target user', () => {
    // Grants MANAGE_CHANNELS to a DIFFERENT member; MANAGE_CHANNELS is absent
    // from base (7), so any appearance would mean cross-member leakage.
    const otherMemberOw: Overwrite = { id: '2999999999999999999', type: 'member', allow: '8', deny: '0' };
    const resolved = resolveChannelPermissions(base, [], [otherMemberOw], MEMBER_ID);
    expect(can(resolved, 'MANAGE_CHANNELS')).toBe(false);
    expect(can(resolved, 'SEND_MESSAGES')).toBe(true); // base grants untouched

    const targetResolved = resolveChannelPermissions(base, [], [otherMemberOw], '2999999999999999999');
    expect(can(targetResolved, 'MANAGE_CHANNELS')).toBe(true);
  });

  it('missing memberId ignores member overwrites entirely', () => {
    const resolved = resolveChannelPermissions(base, [], [memberOverwrite]);
    const manageBits = (1n << 3n) | (1n << 13n);
    expect((resolved & manageBits).toString()).toBe('0');
  });

  it('overwrites for unheld roles are ignored', () => {
    const resolved = resolveChannelPermissions(
      base,
      [],
      [{ id: MODERATOR_ROLE_ID, type: 'role', allow: '8200', deny: '0' }],
      MEMBER_ID
    );
    expect(can(resolved, 'MANAGE_CHANNELS')).toBe(false);
    expect(can(resolved, 'MANAGE_THREADS')).toBe(false);
  });

  it('full pipeline: representative mixed fixture resolves step-by-step', () => {
    // A "support" role granting MANAGE_MESSAGES (bit 64).
    const supportRole: RoleLike = { id: '1000000000000000005', permissions: '64' };
    const resolved = resolveChannelPermissions(
      base,
      [modRole, supportRole],
      [
        // @everyone: mute announcements-only style — deny SEND at channel level
        { id: EVERYONE_ID, type: 'role', allow: '128', deny: '2' }, // MENTION_EVERYONE allowed
        // moderator channel grant: SEND restored, threads managed
        { id: MODERATOR_ROLE_ID, type: 'role', allow: '2', deny: '0' },
        // this member personally muted FROM attachments
        { id: MEMBER_ID, type: 'member', allow: '0', deny: String(1n << 14n) },
      ],
      MEMBER_ID
    );

    expect(can(resolved, 'VIEW_CHANNEL')).toBe(true);
    expect(can(resolved, 'SEND_MESSAGES')).toBe(true); // role-allow restore won
    expect(can(resolved, 'MENTION_EVERYONE')).toBe(true); // everyone-allow
    expect(can(resolved, 'MANAGE_CHANNELS')).toBe(true); // from modRole
    expect(can(resolved, 'UPLOAD_ATTACHMENTS')).toBe(false); // member deny
    expect(can(resolved, 'BAN_MEMBERS')).toBe(false); // never granted anywhere
  });
});

// ---------------------------------------------------------------------------
// Type-level contracts
// ---------------------------------------------------------------------------

describe('permission types', () => {
  it('PermissionName covers the canonical names', () => {
    expectTypeOf<PermissionName>().toMatchTypeOf<string>();
    const sample: PermissionName[] = [
      'VIEW_CHANNEL',
      'SEND_MESSAGES',
      'READ_MESSAGE_HISTORY',
      'MANAGE_CHANNELS',
      'MANAGE_ROLES',
      'ADMINISTRATOR',
    ];
    expect(sample.length).toBeGreaterThan(0);
  });

  it('Overwrite discriminator accepts role and member variants', () => {
    const ow: Overwrite = { id: '123', type: 'role', allow: '1', deny: '0' };
    expectTypeOf(ow.type).toEqualTypeOf<'role' | 'member'>();
    const rl: RoleLike = { id: '456', permissions: '7' };
    expectTypeOf(rl.permissions).toEqualTypeOf<string>();
  });
});
