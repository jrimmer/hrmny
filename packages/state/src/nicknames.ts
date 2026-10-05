/**
 * Per-workspace nicknames (#169).
 *
 * A member row (`membersById`) is GLOBAL: one row per person or bot across
 * every workspace this client knows. A nickname belongs to ONE workspace, so
 * it lives here, keyed by workspace then user, and never on the shared row
 * (the writers below store rows with `nickname: null`). A name is resolved
 * for a place: inside a workspace (a channel, its threads, its member list)
 * the nickname wins; with no workspace (a DM, a cross-workspace list) the
 * account's display name does.
 */
import type { WorkspaceMember } from '@cytale/domain';
import type { Snowflake } from '@cytale/protocol';
import { displayNameOf } from '@cytale/domain';

/** workspace id → user id → nickname (only set nicknames are stored). */
export type NicknamesByWorkspace = Record<Snowflake, Record<Snowflake, string>>;

/** The nickname `userId` carries in `workspaceId`, or null. */
export function nicknameIn(
  nicknames: NicknamesByWorkspace | undefined,
  workspaceId: Snowflake | null | undefined,
  userId: Snowflake,
): string | null {
  if (!workspaceId) return null;
  return nicknames?.[workspaceId]?.[userId] ?? null;
}

/**
 * THE name to show for `member` in `workspaceId` (null/undefined = no
 * workspace: a DM or a cross-workspace list): the workspace nickname, else the
 * account's display name, else the username — `displayNameOf` with the
 * nickname for the place it is shown.
 */
export function memberNameIn(
  nicknames: NicknamesByWorkspace | undefined,
  member: WorkspaceMember | null | undefined,
  workspaceId: Snowflake | null | undefined,
  fallback = '',
): string {
  if (!member) return fallback;
  return displayNameOf({ ...member, nickname: nicknameIn(nicknames, workspaceId, member.id) }, fallback);
}

/** `map` with `userId`'s nickname in `workspaceId` set (or removed for null). Same reference when unchanged. */
export function withNickname(
  map: NicknamesByWorkspace,
  workspaceId: Snowflake,
  userId: Snowflake,
  nickname: string | null | undefined,
): NicknamesByWorkspace {
  const current = map[workspaceId]?.[userId] ?? null;
  const next = typeof nickname === 'string' && nickname !== '' ? nickname : null;
  if (current === next) return map;
  const inWs = { ...(map[workspaceId] ?? {}) };
  if (next === null) delete inWs[userId];
  else inWs[userId] = next;
  return { ...map, [workspaceId]: inWs };
}

/** The shared row for a member: everything but the per-workspace nickname. */
export function globalRow(m: WorkspaceMember): WorkspaceMember {
  return m.nickname === null ? m : { ...m, nickname: null };
}

/**
 * The nicknames that apply in `channelId` (a channel, or a thread's parent
 * channel): its workspace's map, or undefined for a DM (no workspace, so no
 * nickname — the display name shows). A store slice, so the reference is
 * stable until that workspace's nicknames change.
 */
export function nicknamesForChannel(
  state: {
    channels: Record<Snowflake, { workspace_id?: Snowflake | null } | undefined>;
    nicknamesByWorkspace: NicknamesByWorkspace;
  },
  channelId: Snowflake | null | undefined,
): Record<Snowflake, string> | undefined {
  if (!channelId) return undefined;
  const ws = state.channels[channelId]?.workspace_id;
  return ws ? state.nicknamesByWorkspace?.[ws] : undefined;
}
