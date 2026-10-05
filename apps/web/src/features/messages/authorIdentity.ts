/**
 * @cytale/web — the ONE author resolver (2026-10-02).
 *
 * Every surface that shows who wrote something — the timeline, thread replies,
 * the thread's "X started this thread" line, the reply-context quote, the reply
 * bar, inbox and search rows, notifications — names the author through this
 * function. People and machines resolve the same way: the roster row (which a
 * bot reaches exactly as a person does, by `MemberAdd`) supplies the display
 * name, the @tag, the avatar and the kind badge, and the owning person for a
 * machine's "via <owner>".
 *
 * Before it, each surface did its own `membersById[id]` lookup with its own
 * fallbacks. They drifted: one fell back to the raw snowflake, one to the
 * viewer, one dropped the badge. A bot granted after the viewer's client
 * hydrated showed as "99587434064379904" in its own thread, and the thread
 * header — falling back to the seed message's author when the starter was
 * unknown — told the viewer THEY had started it (owner report 2026-10-02).
 *
 * Order, most specific first:
 *   1. a message's per-message identity override (a WEBHOOK execute): the
 *      override's name and the webhook badge come from the MESSAGE, never the
 *      roster, so a webhook posting under a member's name is never read as
 *      that member. Its avatar stays unrendered (stored-only — MessageItem);
 *   2. the roster row (workspace members + a DM's own participants);
 *   3. the session's own record (your own messages, even with no roster);
 *   4. a wire-supplied name (`referenced.author_username`, an inbox row's
 *      `author_username`);
 *   5. nothing — `known: false`. The name is then the raw id, the long-standing
 *      last resort for a message row; a sentence that ATTRIBUTES something
 *      (the thread header) must check `known` and say "Someone" instead.
 */
import type { PrincipalKind } from '@cytale/domain';
import { displayNameOf } from '@cytale/domain';

/** The roster fields attribution reads (a member row or a DM participant). */
export interface AuthorRosterRow {
  username: string;
  nickname?: string | null;
  display_name?: string | null;
  avatar_url?: string | null;
  kind?: PrincipalKind | null;
  parent_user_id?: string | null;
}

/** The session user, for the self fallback. */
export interface AuthorSelf {
  id: string;
  username: string;
  avatar_url?: string | null;
}

/** A message's per-message identity override (webhook execute). */
export interface AuthorOverrideLike {
  username: string;
  avatar_url?: string | null;
  kind?: 'webhook';
}

export interface ResolveAuthorOptions {
  self?: AuthorSelf | null;
  override?: AuthorOverrideLike | null;
  /**
   * A second roster consulted when the first cannot name the id — a DM's own
   * participants where the first is the workspace roster (search, chips).
   */
  fallbackRoster?: AuthorRoster | null;
  /** A name the wire carried alongside the id (used only when the roster cannot name it). */
  wireName?: string | null;
  /**
   * The nicknames of the workspace the name is shown in (#169) — one entry of
   * the store's `nicknamesByWorkspace`. Absent (a DM, a cross-workspace list):
   * no nickname applies and the display name shows.
   */
  nicknames?: Readonly<Record<string, string>> | null;
}

export interface AuthorIdentity {
  /** The display name to show; the raw id only when `known` is false. */
  name: string;
  /** The @handle, when there is an account behind the name. */
  tag: string | undefined;
  avatarUrl: string | null;
  /** The principal kind — the badge. undefined when unknown. */
  kind: PrincipalKind | undefined;
  /** A machine's owning person, for "via <owner>". */
  parentName: string | undefined;
  /** False when nothing could name the id. */
  known: boolean;
}

export type AuthorRoster = Readonly<Record<string, AuthorRosterRow | undefined>>;

function displayName(row: AuthorRosterRow, id: string, nicknames: ResolveAuthorOptions['nicknames']): string {
  return displayNameOf({ ...row, nickname: nicknames?.[id] ?? row.nickname ?? null });
}

/** Resolve one author id to the identity every surface renders. */
export function resolveAuthor(
  roster: AuthorRoster | null | undefined,
  authorId: string,
  options: ResolveAuthorOptions = {},
): AuthorIdentity {
  const { self, override, wireName, fallbackRoster, nicknames } = options;

  if (override && typeof override.username === 'string') {
    return {
      name: override.username,
      tag: undefined,
      avatarUrl: null,
      kind: override.kind ?? 'webhook',
      parentName: undefined,
      known: true,
    };
  }

  const row = roster?.[authorId] ?? fallbackRoster?.[authorId];
  if (row) {
    const parent = row.parent_user_id
      ? (roster?.[row.parent_user_id] ?? fallbackRoster?.[row.parent_user_id])
      : undefined;
    return {
      name: displayName(row, authorId, nicknames),
      tag: row.username,
      avatarUrl: row.avatar_url ?? null,
      kind: row.kind ?? undefined,
      parentName: parent ? displayName(parent, row.parent_user_id!, nicknames) : undefined,
      known: true,
    };
  }

  if (self && self.id === authorId) {
    return {
      name: self.username,
      tag: self.username,
      avatarUrl: self.avatar_url ?? null,
      kind: undefined,
      parentName: undefined,
      known: true,
    };
  }

  if (wireName) {
    return { name: wireName, tag: undefined, avatarUrl: null, kind: undefined, parentName: undefined, known: true };
  }

  return { name: authorId, tag: undefined, avatarUrl: null, kind: undefined, parentName: undefined, known: false };
}

/** The neutral subject for an attribution sentence whose actor is unknown. */
export const UNKNOWN_ACTOR = 'Someone';

/**
 * The name for a sentence that ATTRIBUTES an act ("X started this thread"):
 * the resolved author, or the neutral "Someone" — never the raw id, and never
 * a stand-in such as the viewer or the seed message's author.
 */
export function actorName(
  roster: AuthorRoster | null | undefined,
  actorId: string | null | undefined,
  self?: AuthorSelf | null,
): string {
  if (!actorId) return UNKNOWN_ACTOR;
  const who = resolveAuthor(roster, actorId, { self });
  return who.known ? who.name : UNKNOWN_ACTOR;
}
