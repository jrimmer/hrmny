/**
 * @cytale/tui — the search model (U13; R23, R26a).
 *
 * Three things live here, and all three are pure: the SCOPE a query belongs to,
 * the ROWS a server payload projects to, and the one-line STATES the pane can
 * be in. `columns/SearchView.tsx` only draws what this module computes, which
 * is what makes the wire reader and the states testable without a terminal.
 *
 * ---------------------------------------------------------------------------
 * The two scopes, and where each one goes
 * ---------------------------------------------------------------------------
 *
 * R23 asks for search "within the selected workspace and within their DMs", and
 * those are two index segments with two routes: the active workspace's
 * (`GET /workspaces/:id/search`, the controller's `workspace/2`) and the
 * account-wide DM segment (`GET /dm/search`, `dm/2`). The scope therefore
 * follows column one's MODE, which is the same thing the member is looking at:
 * `channels` → the active workspace, `dms` → their own conversations. There is
 * no third "search everything" mode, because a result set that mixes workspaces
 * with a member's DMs is a set whose rows cannot be labelled with where they
 * came from.
 *
 * The DM segment answers the stable 501 `search_not_available` today (its
 * per-user-pair writer is not wired end to end — the controller says so in
 * place). A client that hid that behind a generic error would be lying about
 * which side is missing, so the 501 becomes its own state (see
 * {@link classifySearchFailure}), and the row reader below is written against
 * the response the route CONTRACT promises so the day the segment lands there
 * is nothing to change here.
 *
 * ---------------------------------------------------------------------------
 * The payload is read, not trusted (the declared type is wrong)
 * ---------------------------------------------------------------------------
 *
 * `CytaleApiClient.searchWorkspace` is declared `Promise<SearchResult>` — the
 * domain's `{items, cursor}` — and the controller serves neither. What the
 * workspace route answers is
 *
 *     { "results": [{ "message_id", "channel_id", "thread_id", "score" }],
 *       "next_before": null }
 *
 * — a different envelope under a different name, and a hit that carries no body,
 * no author, and no timestamp (`result_json/1` in
 * `apps/server/lib/cytale_web/controllers/search_controller.ex`). This module
 * reads the payload it is HANDED, `unknown` by type, and:
 *
 *   * accepts `results` (what the server serves) and `items` (what the declared
 *     type promises), so neither boundary being fixed breaks the pane;
 *   * DROPS a hit it cannot identify — no usable `message_id`, no usable
 *     `channel_id` — rather than drawing a row that cannot be opened;
 *   * completes each row from the SHARED STORE for the two facts the wire does
 *     not carry: the conversation's name (`#general`, or the DM peer) and, when
 *     the message is already loaded, its author, time, and body. A hit whose
 *     message is NOT loaded shows the id instead of inventing one — the id is
 *     what the member can act on, and the pane never states a row it made up.
 *
 * `highlight` is read when the server sends one (the snippet the domain's
 * `SearchHit` declares, and the value KTD10 names). It crosses
 * {@link sanitizeTerminalText} like every other server string, and so do the
 * conversation name, the author, and the server's own error message: R26a is
 * not scoped to message bodies, and a display name can clear a screen as
 * readily from a result row as from a message.
 *
 * ---------------------------------------------------------------------------
 * The states, and why each one exists
 * ---------------------------------------------------------------------------
 *
 *   * `idle` — nothing has been asked. An EMPTY query is this state: the pane
 *     says what to type rather than sending a request that cannot match
 *     anything, which is also why `buildSearchRequest` returns null for it.
 *   * `loading` — a query is in flight. It is a state and not a flag: the shell
 *     guards superseded responses with a monotonic epoch (`app.tsx`), so an
 *     older query landing late is DROPPED rather than rendered over the newer
 *     one. A boolean could not express that.
 *   * `results` / `empty` — rows, or the explicit "no messages match" line.
 *   * `error` — the query failed; the line names the cause and offers the retry.
 *   * `unavailable` — 501 `search_not_available` (the index is down, or the DM
 *     segment is not wired), or a host that wired no search at all. Distinct
 *     from `error` on purpose: nothing the member did is wrong.
 *   * `offline` — the session is reconnecting, so the query is not sent AT ALL.
 *     `app.tsx` decides this before issuing (the same rule U14's reaction
 *     binding follows), which is what "reports the state rather than hanging"
 *     means when the transport underneath cannot complete a request.
 */
import type { Channel } from '@cytale/domain';

import { inertText, type ShellMode } from '../columns/layout.js';
import { displayNameFor, describeCause, timeLabel, type MessageSource } from '../format/rows.js';
import { renderMarkdownLines, sanitizeTerminalText } from '../format/markdown.js';

// ---------------------------------------------------------------------------
// Scope and request
// ---------------------------------------------------------------------------

/** Which index segment a query runs against (R23's two halves). */
export type SearchScope = 'workspace' | 'dms';

/** The segment column one's mode searches: its workspace, or the member's DMs. */
export function searchScopeFor(mode: ShellMode): SearchScope {
  return mode === 'dms' ? 'dms' : 'workspace';
}

/** One query, resolved to the segment it runs against. */
export interface SearchRequest {
  readonly scope: SearchScope;
  /** The workspace the query is scoped to; null for the DM segment. */
  readonly workspaceId: string | null;
  /** The text the member asked for, trimmed. Never empty. */
  readonly query: string;
}

/**
 * The request a query means, or null when there is nothing to ask.
 *
 * Two ways to have nothing: an EMPTY (or whitespace-only) query, which is the
 * pane's idle state rather than a search that returns everything, and a
 * workspace scope with no workspace to scope to (an account whose workspace
 * list is still loading, or empty) — a query aimed at nothing is not sent.
 */
export function buildSearchRequest(input: {
  readonly scope: SearchScope;
  readonly workspaceId: string | null;
  readonly query: string;
}): SearchRequest | null {
  const query = input.query.trim();
  if (query === '') return null;
  if (input.scope === 'dms') return { scope: 'dms', workspaceId: null, query };
  if (input.workspaceId === null || input.workspaceId === '') return null;
  return { scope: 'workspace', workspaceId: input.workspaceId, query };
}

// ---------------------------------------------------------------------------
// The wire reader
// ---------------------------------------------------------------------------

/** Cells the snippet is rendered at — the renderer's wrap width, not the pane's. */
export const SEARCH_SNIPPET_CELLS = 200;

/** One result as the pane draws it. Every string here is already inert. */
export interface SearchRow {
  /** The message to open. RAW: it is what the jump addresses. */
  readonly messageId: string;
  /** The conversation to load. RAW: it selects column one's row. */
  readonly channelId: string;
  /** The thread the hit belongs to, when the server named one. */
  readonly threadId: string | null;
  /** The segment this hit came from — which mode column one must be in. */
  readonly scope: SearchScope;
  /** The conversation's name (`#general`, a DM peer), never a bare id. */
  readonly where: string;
  /** The author's display name when the message is loaded; null when it is not. */
  readonly author: string | null;
  /** `HH:MM`, when both the message and its timestamp are known. */
  readonly time: string | null;
  /** One line of context: the server's snippet, else the stored body; else ''. */
  readonly snippet: string;
}

/** The conversation label for a hit: the store's row, or the id it named. */
function whereFor(source: MessageSource, channelId: string, scope: SearchScope): string {
  const channel: Channel | undefined = source.channels[channelId];
  if (channel === undefined) return `channel ${inertText(channelId, 'unknown')}`;
  if (channel.type === 'dm') {
    const viewerId = source.currentUser?.id ?? null;
    const peer = channel.recipients?.find((candidate) => candidate.id !== viewerId);
    return inertText(peer?.username ?? channel.name, 'Conversation');
  }
  return `#${inertText(channel.name, 'unnamed-channel')}`;
}

/** The loaded message a hit names, if this client already holds it. */
function loadedMessage(source: MessageSource, channelId: string, hit: {
  readonly messageId: string;
  readonly threadId: string | null;
}): {
  readonly authorId: string;
  readonly createdAt: string;
  readonly content: string;
} | null {
  const inChannel = source.messagesByChannel?.[channelId]?.items.find(
    (item) => item.id === hit.messageId,
  );
  const stored =
    inChannel ??
    (hit.threadId === null ? undefined : source.messagesByThread?.[hit.threadId]?.items.find(
      (item) => item.id === hit.messageId,
    ));
  if (stored === undefined) return null;
  return { authorId: stored.author_id, createdAt: stored.created_at, content: stored.content ?? '' };
}

/** One line from the server's snippet, or the stored body: inert either way. */
function snippetFor(raw: unknown, stored: string | null): string {
  if (typeof raw === 'string') {
    const clean = sanitizeTerminalText(raw).replace(/\s+/g, ' ').trim();
    if (clean !== '') return clean;
  }
  if (stored === null || stored === '') return '';
  // The body is rendered through the markdown pipeline so a result reads like
  // the message does — its first line, which is what a one-line row can hold.
  return renderMarkdownLines(stored, { width: SEARCH_SNIPPET_CELLS })[0] ?? '';
}

/** One hit as a row, or null when the value cannot address a message. */
function readHit(hit: unknown, source: MessageSource, scope: SearchScope): SearchRow | null {
  if (typeof hit !== 'object' || hit === null) return null;
  const raw = hit as {
    message_id?: unknown;
    channel_id?: unknown;
    thread_id?: unknown;
    highlight?: unknown;
  };
  if (typeof raw.message_id !== 'string' || raw.message_id === '') return null;
  if (typeof raw.channel_id !== 'string' || raw.channel_id === '') return null;
  const threadId =
    typeof raw.thread_id === 'string' && raw.thread_id !== '' ? raw.thread_id : null;
  const message = loadedMessage(source, raw.channel_id, {
    messageId: raw.message_id,
    threadId,
  });

  return {
    messageId: raw.message_id,
    channelId: raw.channel_id,
    threadId,
    scope,
    where: whereFor(source, raw.channel_id, scope),
    author:
      message === null
        ? null
        : displayNameFor(source, message.authorId, source.channels[raw.channel_id]),
    time: message === null ? null : (timeLabel(message.createdAt) || null),
    snippet: snippetFor(raw.highlight, message?.content ?? null),
  };
}

/**
 * The rows a search payload projects to.
 *
 * The envelope is read in the two spellings that exist (`results` — what the
 * controller serves — then `items` — what the declared type promises), and
 * anything else is an empty result set rather than an exception: a payload this
 * client cannot read is not a reason to blow up the shell that asked for it.
 */
export function readSearchRows(
  payload: unknown,
  input: { readonly source: MessageSource; readonly scope: SearchScope },
): SearchRow[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const envelope = payload as { results?: unknown; items?: unknown };
  const hits = Array.isArray(envelope.results)
    ? envelope.results
    : Array.isArray(envelope.items)
      ? envelope.items
      : [];
  const rows: SearchRow[] = [];
  for (const hit of hits) {
    const row = readHit(hit, input.source, input.scope);
    if (row !== null) rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// The pane's states
// ---------------------------------------------------------------------------

export type SearchStatus =
  | 'idle'
  | 'loading'
  | 'results'
  | 'empty'
  | 'error'
  | 'unavailable'
  | 'offline';

export interface SearchPane {
  readonly status: SearchStatus;
  /** The query the rows answer: the ISSUED one, not the one being typed. */
  readonly query: string;
  readonly rows: readonly SearchRow[];
  /** The highlighted row, clamped to the rows that exist. */
  readonly cursor: number;
  /** The one line a pane with no rows shows. Already inert; null when none. */
  readonly notice: string | null;
}

/** What to type: the idle state, which is where an empty query leaves the pane. */
export function searchIdleNotice(scope: SearchScope): string {
  return scope === 'dms' ? 'Type to search your direct messages.' : 'Type to search this workspace.';
}

/** Nothing matched. Explicit, and named with the query the member asked. */
export function searchEmptyNotice(query: string): string {
  return `No messages match "${inertText(query, 'that query')}".`;
}

/**
 * The failure line, with the retry spelled out: Enter with no rows re-issues
 * the query the member is on (`app.tsx`), so "try again" is a key that exists
 * rather than a hope.
 */
export function searchErrorNotice(cause: string): string {
  return `✖ Search failed.${cause === '' ? '' : ` (${cause})`} Press Enter to try again.`;
}

/**
 * The index is not answering, or the segment is not wired: nothing the member
 * did is wrong, so this is not `searchErrorNotice`'s wording.
 */
export const SEARCH_UNAVAILABLE_NOTICE =
  '✖ Search is unavailable right now — the server’s search index is not answering.';

/** The session is reconnecting: the query is not sent at all. */
export const SEARCH_OFFLINE_NOTICE =
  '✖ Search needs a live connection — this session is reconnecting.';

/** This shell was given no search seam at all. Stated, never faked. */
export const SEARCH_UNWIRED_NOTICE = '✖ Search is not available in this session.';

/** One line: the pane's subject, from the scope. */
export function searchSubject(scope: SearchScope, workspaceName: string | null): string {
  return scope === 'dms' ? 'your direct messages' : inertText(workspaceName, 'this workspace');
}

export function idleSearchPane(scope: SearchScope): SearchPane {
  return { status: 'idle', query: '', rows: [], cursor: 0, notice: searchIdleNotice(scope) };
}

/** A query is in flight. The marker is the banner's own "in flight" glyph. */
export const SEARCH_LOADING_NOTICE = '… Searching';

export function loadingSearchPane(query: string): SearchPane {
  return { status: 'loading', query, rows: [], cursor: 0, notice: SEARCH_LOADING_NOTICE };
}

export function resultsSearchPane(query: string, rows: readonly SearchRow[]): SearchPane {
  if (rows.length === 0) {
    return { status: 'empty', query, rows: [], cursor: 0, notice: searchEmptyNotice(query) };
  }
  return { status: 'results', query, rows, cursor: 0, notice: null };
}

/** A pane for a state that has no rows: the notice is the whole surface. */
export function noticeSearchPane(
  status: 'idle' | 'error' | 'unavailable' | 'offline',
  query: string,
  notice: string,
): SearchPane {
  return { status, query, rows: [], cursor: 0, notice };
}

/**
 * What a failed search means. A 501 — or the `search_not_available` key the
 * controller answers with — is the index being unavailable, which is a state of
 * the server rather than of the query; everything else is the query's failure
 * and carries the transport's cause, made inert (R26a).
 */
export function classifySearchFailure(error: unknown): {
  readonly status: 'error' | 'unavailable';
  readonly notice: string;
} {
  const key = typeof (error as { key?: unknown } | null)?.key === 'string'
    ? ((error as { key: string }).key)
    : '';
  const status =
    typeof (error as { status?: unknown } | null)?.status === 'number'
      ? ((error as { status: number }).status)
      : 0;
  if (status === 501 || key === 'search_not_available') {
    return { status: 'unavailable', notice: SEARCH_UNAVAILABLE_NOTICE };
  }
  return { status: 'error', notice: searchErrorNotice(describeCause(error)) };
}

/**
 * A result whose message is no longer there.
 *
 * `atStart` is whether the pane proved it holds the whole conversation (U7's
 * `hasCompleteHistory`), and it decides the wording, because the two facts are
 * different: a message that is absent from a COMPLETE history was deleted,
 * while one absent from a page might simply be older than what is loaded — and
 * the member's remedy for that is the paging key they already have.
 */
export function jumpUnresolvedNotice(input: {
  readonly where: string;
  readonly atStart: boolean;
}): string {
  const where = inertText(input.where, 'this conversation');
  if (input.atStart) return `✖ That message is no longer in ${where} — it may have been deleted.`;
  return `✖ That message is not in ${where}’s loaded history — press k at the top to load older messages.`;
}

/**
 * A result whose conversation column one cannot select — the hit was indexed
 * against a channel this client's list does not hold (a stale channel list, or
 * a DM list whose own read failed). The message is not opened, because opening
 * the conversation NEXT to it would be a different result than the one the
 * member chose.
 */
export function jumpMissingNotice(where: string): string {
  return `✖ ${inertText(where, 'That result’s conversation')} is not in column one’s list — it may be out of date.`;
}

// ---------------------------------------------------------------------------
// Drawing geometry (one result is one line, so no wrapping is involved)
// ---------------------------------------------------------------------------

/** Lines the pane spends on itself: the header, the query line, the hint line. */
export const SEARCH_CHROME_ROWS = 3;

/**
 * The rows of the result list the budget fits, ALWAYS including the cursor's —
 * the same rule `MessageList`'s window follows, for the same reason: a cursor
 * the pane cannot show is a cursor the member cannot see.
 */
export function searchWindow(
  rowCount: number,
  cursor: number,
  budget: number,
): { readonly start: number; readonly count: number } {
  if (rowCount <= 0) return { start: 0, count: 0 };
  const size = Math.max(1, Math.floor(budget));
  const at = Math.min(Math.max(0, cursor), rowCount - 1);
  const start = Math.max(0, Math.min(at - size + 1, rowCount - size));
  return { start, count: Math.min(size, rowCount - start) };
}

/**
 * One result's line: where it lives, who wrote it (when known), and what it
 * says. A hit whose message this client does not hold names the message id
 * instead of a body — the wire's hit carries no text, and the id is the fact
 * that is true.
 */
export function searchRowText(row: SearchRow): string {
  const parts = [row.where];
  if (row.author !== null) parts.push(row.time === null ? row.author : `${row.author} ${row.time}`);
  if (row.snippet !== '') parts.push(row.snippet);
  else if (row.author === null) parts.push(`message ${inertText(row.messageId, 'unknown')}`);
  return parts.join(' · ');
}
