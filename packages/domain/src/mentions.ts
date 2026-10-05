/**
 * @cytale/domain — the mention token grammar, shared by every client.
 *
 * The token is the wire's storage form: `<@id>` stays raw inside message
 * content and every surface parses it. Before this module there were FOUR
 * hand-rolled copies of the pattern across the repo (`state/reconcile`,
 * `markdown/parse`, `web/features/messages/threadName`, `web/features/home/inbox`)
 * plus the server's own — and they had already drifted: some accept the
 * nickname form `<@!id>`, some do not, and the server's does not. A member
 * mentioned with a nickname token was therefore tellable on one surface and
 * invisible on another, which is the class of bug where somebody is visibly
 * mentioned and never notified.
 *
 * One grammar, imported everywhere. The server keeps its own copy for now
 * (its `apps/server/lib/cytale/notifications/mentions.ex` also owns `@everyone`
 * and `@here`, which a client has no use for), and the two are cross-checked by
 * a test rather than hoped into agreement.
 *
 * ## Why a bare `@name` is NOT a mention
 *
 * Name matching false-fires on ordinary prose — a message containing the word
 * "max" is not addressed to Max — while an id token cannot. The id is the
 * signal.
 */

/** A user mention: `<@id>` or the nickname form `<@!id>`. */
const MENTION_TOKEN = /<@!?(\d{1,19})>/g;

/** The id shape a mention token can carry — shared by both predicates below. */
const PLAIN_ID_RE = /^\d{1,19}$/;

/** Broadcast tokens, which are distinct from a direct mention. */
const EVERYONE = '@everyone';
const HERE = '@here';

/**
 * Every user id mentioned in the content, de-duplicated and in first-appearance
 * order. Absent content yields `[]` rather than throwing — an attachment-only
 * message is not an error.
 */
export function mentionedUserIds(content: string | null | undefined): string[] {
  if (typeof content !== 'string' || content.length === 0) return [];

  const ids: string[] = [];
  // `matchAll` needs the global flag; the regex is module-level and stateless
  // because it carries no `lastIndex` of its own between calls.
  for (const match of content.matchAll(MENTION_TOKEN)) {
    const id = match[1];
    if (id !== undefined && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Whether the content mentions this user id, in either token form. */
export function mentionsUser(content: string | null | undefined, userId: string): boolean {
  if (typeof content !== 'string' || content.length === 0) return false;
  return mentionedUserIds(content).includes(userId);
}

/**
 * The PLAIN token form only (`<@id>`, never `<@!id>`) — the allocation-free
 * check for hot paths that must not build a match array per candidate.
 *
 * It lives here, beside `mentionsUser`, because the `\d{1,19}` bound and the
 * closing-`>` rule ARE the grammar: a copy in another package would drift the
 * moment the token shape changes. The nickname form's exclusion is a contract,
 * not an oversight — `state/reconcile`'s unread accrual matches the form the
 * SERVER stores (plain), while rendering is the surface that accepts both.
 *
 * The closing `>` is what makes a longer id (`<@…21>` vs `<@…2>`) and a bare
 * `<@…2` non-matches, and the id guard keeps an id no capture could hold from
 * matching either. So this agrees with `mentionsUser` for every plain-token
 * input and answers `false` where that one accepts a nickname token.
 */
export function mentionsPlainUser(content: string | null | undefined, userId: string): boolean {
  if (typeof content !== 'string' || content.length === 0) return false;
  return PLAIN_ID_RE.test(userId) && content.includes(`<@${userId}>`);
}

/**
 * Whether the content addresses everyone, bounded so `@everyoneelse` is
 * ordinary text rather than a workspace-wide broadcast.
 */
export function mentionsEveryone(content: string | null | undefined): boolean {
  return hasBoundedToken(content, EVERYONE);
}

/** Whether the content addresses the members currently active. Bounded like `mentionsEveryone`. */
export function mentionsHere(content: string | null | undefined): boolean {
  return hasBoundedToken(content, HERE);
}

function hasBoundedToken(content: string | null | undefined, token: string): boolean {
  if (typeof content !== 'string' || content.length === 0) return false;

  const at = content.indexOf(token);
  if (at === -1) return false;

  const after = at + token.length;
  if (after === content.length) return true;

  // A word character immediately after means this is a longer word that merely
  // starts with the token.
  return !/[A-Za-z0-9_]/.test(content[after] as string);
}
