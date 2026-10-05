/**
 * @cytale/web — the shared mention resolver (#128).
 *
 * `markdown.tsx`'s contract: a resolver maps a `<@snowflake>` user id to a
 * display name, and `undefined` leaves the raw id showing in the pill.
 * `MessageList` built that chain inline (roster nickname/username, then the
 * session self) and passed it to its rows — but the thread side-panel renders
 * the same `MessageItem` directly and built none, so every mention inside a
 * thread fell back to the raw snowflake (#128). ONE chain, two consumers: the
 * channel list and the thread panel resolve identically and cannot drift.
 */

import type { MentionResolver } from '@cytale/markdown';

import type { DmParticipantRow } from './dmRoster.js';
import { displayNameOf } from '@cytale/domain';

/** The subset of a roster row the chain reads (WorkspaceMember ⊇ this). */
export interface MentionRosterRow {
  nickname?: string | null;
  username: string;
}

/** The subset of the session user the chain reads (StateState['currentUser']). */
export interface MentionSelfUser {
  id: string;
  username: string;
}

/**
 * Build the resolver: roster nickname → username, then the session self,
 * `undefined` last (the raw id stays in the pill). `membersById` may carry
 * DM participant rows merged over the roster (see `dmRoster.ts`) — the shape
 * is structural, so the merged map passes unchanged.
 */
export function createMentionResolver(
  membersById: Readonly<Record<string, MentionRosterRow | DmParticipantRow | undefined>>,
  selfUser: MentionSelfUser | null | undefined,
  /** The workspace's nicknames for the place the mention renders (#169); absent in a DM. */
  nicknames?: Readonly<Record<string, string>> | null,
): MentionResolver {
  return (id: string): string | undefined => {
    const m = membersById[id];
    if (m) return displayNameOf({ ...m, nickname: nicknames?.[id] ?? m.nickname ?? null });
    if (selfUser && selfUser.id === id) return selfUser.username;
    return undefined;
  };
}
