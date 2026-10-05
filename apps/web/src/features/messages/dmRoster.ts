/**
 * @cytale/web — DM participant rows (2026-09-14).
 *
 * A direct message is instance-wide: `GET /users/@me/channels` carries no
 * workspace, and the channel's own `recipients` are the identity of the people
 * in it. Message *content*, though, resolved names through
 * `store.membersById` — the roster of whichever workspace the client happened to
 * hold — so inside a DM a peer who is not in the active workspace rendered as a
 * raw snowflake id, and one who is rendered that workspace's nickname
 * (user report 2026-09-14: "why is the workspace matter for a DM message as
 * it's server-wide and all tags are server and not workspace-unique").
 *
 * This returns those participants in the roster's row shape so a DM's names and
 * avatars resolve from the wire, whatever workspace is active. It deliberately
 * returns an EMPTY map for anything that is not a DM: a workspace channel keeps
 * resolving through the roster, because a nickname there is a workspace-local
 * display choice, not an identity the DM should inherit.
 */
import type { Channel } from '@cytale/domain';

/** The subset of a roster row that a channel's participants can supply. */
export interface DmParticipantRow {
  id: string;
  username: string;
  nickname?: string | null;
  avatar_url?: string | null;
}

/**
 * The active channel's participants, keyed by user id — empty unless the
 * channel is a DM. Safe to spread over a roster: `{ ...roster, ...rows }`.
 */
export function dmParticipants(
  channel: Channel | null | undefined,
): Record<string, DmParticipantRow> {
  const rows: Record<string, DmParticipantRow> = {};
  if (channel == null || channel.type !== 'dm') return rows;
  for (const recipient of channel.recipients ?? []) {
    rows[recipient.id] = {
      id: recipient.id,
      username: recipient.username,
      // A DM carries no nickname: the peer's handle IS their identity here.
      nickname: null,
      avatar_url: recipient.avatar_url ?? null,
    };
  }
  return rows;
}
