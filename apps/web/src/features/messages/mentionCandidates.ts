/**
 * `@`-mention typeahead: the pure half (#66 follow-up — tokenization).
 *
 * A mention is a TOKEN (`<@id>`) plus a mention ARRAY on the wire; both were
 * missing on the native side, so a typed `@name` was prose that no library
 * could detect. This module decides WHEN the palette opens and WHICH members
 * it offers; the composer plugin does the keyboard work, and `MentionNode`
 * owns the token form.
 *
 * Trigger rule (mirrors the emoji palette's, Discord's shape): an `@token`
 * run ending at the CARET opens the palette (#129 — the caller feeds the text
 * BEFORE the caret, so "trailing" means trailing up to where the user is
 * typing, not the document's tail), with a word boundary before the `@` so
 * `me@example.com` and `foo@bar` never fire. A space after the token closes
 * it — which is why committing a pick appends a space: the palette cannot
 * reopen on the way out.
 */

import type { PrincipalKind } from '@cytale/domain';
import type { StateStore } from '@cytale/state';
import { displayNameOf } from '@cytale/domain';

/** One selectable member. `nickname` is the workspace display name. */
export interface MentionCandidate {
  id: string;
  username: string;
  nickname: string | null;
  /** The account's display name (#168). */
  display_name?: string | null;
  /** Roster avatar and principal kind — the palette row draws the shared Avatar. */
  avatar_url?: string | null;
  kind?: PrincipalKind | null;
}

/** How many options the palette lists (Discord lists ~8; more is noise). */
export const MENTION_LIMIT = 8;

/** Longest username we will treat as an open query (usernames cap at 32). */
const MAX_QUERY = 32;

/**
 * The open `@query` at the end of the given text, or null. The caller passes
 * the composed text up to the caret (#129), so "end of the text" means "at
 * the caret".
 *
 * The query may be EMPTY: a bare `@` before the caret opens the palette with
 * the whole roster, exactly as Discord does. `@` inside a word (email
 * addresses, handles) never opens anything.
 */
export function mentionQueryOf(text: string): string | null {
  const m = new RegExp(`(?:^|\\s)@([\\p{L}\\p{N}._-]{0,${MAX_QUERY}})$`, 'u').exec(text);
  if (!m) return null;
  return m[1] ?? '';
}

/**
 * Rank candidates for a query, Discord's way: prefix matches on the username
 * first, then nickname prefixes, then substring matches anywhere, each band
 * alphabetical. A bare `@` (empty query) offers the roster in name order.
 *
 * Deliberately NOT fuzzy — substring-and-prefix keeps the mapping from what
 * someone typed to who they get predictable, which matters more than reach
 * for a control that inserts an identity.
 */
export function rankMentionCandidates(
  query: string,
  candidates: readonly MentionCandidate[],
  limit: number = MENTION_LIMIT,
): MentionCandidate[] {
  const q = query.toLowerCase();

  const scored: { candidate: MentionCandidate; score: number; name: string }[] = [];

  for (const candidate of candidates) {
    const username = candidate.username.toLowerCase();
    // The names a person is SHOWN by (#168): nickname and display name.
    const shown = [candidate.nickname, candidate.display_name]
      .filter((n): n is string => typeof n === 'string' && n !== '')
      .map((n) => n.toLowerCase());

    let score: number | null = null;

    if (q === '') score = 0;
    else if (username.startsWith(q)) score = 1;
    else if (shown.some((n) => n.startsWith(q))) score = 2;
    else if (username.includes(q)) score = 3;
    else if (shown.some((n) => n.includes(q))) score = 4;

    if (score !== null) scored.push({ candidate, score, name: username });
  }

  scored.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));

  return scored.slice(0, limit).map((row) => row.candidate);
}

/** What the palette shows for a candidate: the shared name rule (#168). */
export function mentionDisplayName(candidate: MentionCandidate): string {
  return displayNameOf(candidate);
}

/**
 * The workspace's members as palette candidates, read LAZILY from the store
 * (no subscription): the palette asks once per keystroke while it is open, so
 * an idle composer costs nothing and a roster update is picked up on the next
 * keystroke rather than re-rendering the composer.
 */
export function mentionCandidatesFor(
  store: StateStore,
  workspaceId: string | null | undefined,
): MentionCandidate[] {
  if (!workspaceId) return [];

  const state = store.getState();
  const ids = state.memberIdsByWorkspace[workspaceId] ?? [];

  const candidates: MentionCandidate[] = [];

  for (const id of ids) {
    const member = state.membersById[id];
    if (!member) continue;
    candidates.push({
      id: member.id,
      username: member.username,
      // This workspace's nickname (#169), never the shared row's.
      nickname: state.nicknamesByWorkspace?.[workspaceId]?.[id] ?? null,
      display_name: member.display_name ?? null,
      avatar_url: member.avatar_url ?? null,
      kind: member.kind ?? null,
    });
  }

  return candidates;
}

/**
 * The member's TAG — their `@username` — for the composer's mention pill.
 * The palette lists display names to pick from, but what the pill shows is
 * the handle the token stands for (owner, 2026-09-27: "include the tag rather
 * than the full name"). Undefined when the roster cannot name the id.
 */
export function mentionTagFor(store: StateStore, userId: string): string | undefined {
  const state = store.getState();
  const member = state.membersById[userId];
  if (member) return member.username;
  if (state.currentUser && state.currentUser.id === userId) return state.currentUser.username;
  return undefined;
}

// ---------------------------------------------------------------------------
// `#`-channel typeahead: the same caret rule and ranking bands as `@`, over
// the workspace's channel list. The pick inserts Discord's `<#id>` token.
// ---------------------------------------------------------------------------

/** One selectable channel. */
export interface ChannelCandidate {
  id: string;
  name: string;
}

/** Longest channel name treated as an open query. */
const MAX_CHANNEL_QUERY = 100;

/**
 * The open `#query` at the end of the given (pre-caret) text, or null. Same
 * boundary rule as `@`: `C#`, `issue#4` and URL fragments never fire, and a
 * bare `#` offers the whole list. A `# ` heading at line start closes it on
 * the space, so the markdown heading shortcut is untouched.
 */
export function channelQueryOf(text: string): string | null {
  const m = new RegExp(`(?:^|\\s)#([\\p{L}\\p{N}._-]{0,${MAX_CHANNEL_QUERY}})$`, 'u').exec(text);
  if (!m) return null;
  return m[1] ?? '';
}

/** Prefix matches first, then substring matches, each band alphabetical. */
export function rankChannelCandidates(
  query: string,
  candidates: readonly ChannelCandidate[],
  limit: number = MENTION_LIMIT,
): ChannelCandidate[] {
  const q = query.toLowerCase();
  const scored: { candidate: ChannelCandidate; score: number; name: string }[] = [];

  for (const candidate of candidates) {
    const name = candidate.name.toLowerCase();
    let score: number | null = null;
    if (q === '') score = 0;
    else if (name.startsWith(q)) score = 1;
    else if (name.includes(q)) score = 2;
    if (score !== null) scored.push({ candidate, score, name });
  }

  scored.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return scored.slice(0, limit).map((row) => row.candidate);
}

/**
 * The workspace's text channels as palette candidates, read lazily like the
 * roster. Categories and DMs are not linkable channels. The store holds only
 * channels this member can see, so the list can never offer a private
 * channel they are outside of.
 */
export function channelCandidatesFor(
  store: StateStore,
  workspaceId: string | null | undefined,
): ChannelCandidate[] {
  if (!workspaceId) return [];
  const candidates: ChannelCandidate[] = [];
  for (const channel of Object.values(store.getState().channels)) {
    if (channel.workspace_id !== workspaceId || channel.type !== 'text') continue;
    candidates.push({ id: channel.id, name: channel.name });
  }
  return candidates;
}
