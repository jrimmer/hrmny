/**
 * @cytale/web — the mention inbox contract and its merge rules (#117).
 *
 * The inbox is the one Home surface backed by STORAGE rather than by the
 * session's unread slices: the server records a row per message that
 * addressed the member (`DELETE/GET /api/v1/users/@me/inbox`, #117), so the
 * answer to "where was I needed" survives a reload. This module owns the
 * three pieces the surface must not improvise:
 *
 *   * the row shape the API returns;
 *   * the thin REST wrapper (fetch / dismiss / sweep);
 *   * the pure MERGE and PRUNE rules, exported so they are testable on their
 *     own — the merge is the one thing here that a wrong implementation can
 *     make worse than no feature at all (a replace would erase mentions that
 *     arrived while the hydrate was in flight).
 *
 * ## Why it merges instead of replacing
 *
 * A hydrate result is a SNAPSHOT of the backlog as storage saw it when the
 * request was served. A mention can land in the store between issuing that
 * request and applying its response — the live `MessageCreate` path accrues
 * one — so replacing the slice with the snapshot would silently drop the
 * newest mention, which is exactly the bug the ticket exists to fix ("nothing
 * re-hydrates it" becomes "the re-hydrate clobbers it"). The merge is a union
 * keyed by message id: local rows survive an incoming set that does not
 * mention them, and the incoming row wins when both hold the same id (the
 * server's copy is the recorded event).
 *
 * ## Why the read watermark prunes
 *
 * "Done" on another device converges without a second mechanism: the server
 * deletes the rows an acknowledgement covers, and the client derives the same
 * conclusion from the ONE watermark it already has. So a row disappears when
 * the member's read state covers it — the channel's watermark for a channel
 * mention, the THREAD's watermark for a thread mention (a channel ack never
 * answers a thread mention, on either side, because the timeline hides
 * replies). That is a VIEW of `read_state`, not a second tracker.
 */

import { compareSnowflakes } from '@cytale/domain';

import { apiUrl } from '../../app/origin.js';

/** One row of `GET /api/v1/users/@me/inbox`. */
export interface InboxItem {
  /** The message that addressed the member — the permalink target (#114). */
  message_id: string;
  channel_id: string;
  /** The thread the message lives in, when it is a reply. */
  thread_id?: string | null;
  author_id: string;
  author_username?: string | null;
  /** The event class: `'mention'` (a direct `<@id>`) or `'broadcast'` (@everyone/@here, 2026-09-27). */
  kind?: string;
  /** The addressed text as it was recorded (server-capped). */
  excerpt: string;
  created_at?: string | null;
}

export interface InboxPage {
  items: InboxItem[];
  oldest_id: string | null;
}

export interface InboxApiError {
  status: number;
  key?: string;
  message?: string;
}

async function readError(res: Response): Promise<InboxApiError> {
  let key: string | undefined;
  let message: string | undefined;
  try {
    const body = (await res.json()) as { error?: { key?: string; message?: string } };
    key = body.error?.key;
    message = body.error?.message;
  } catch {
    // non-JSON error body — keep status-only
  }
  return { status: res.status, key, message } satisfies InboxApiError;
}

function authHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

/** The member's own backlog, newest first. Throws `InboxApiError` on non-2xx. */
export async function fetchInbox(
  opts: { token?: string; limit?: number; before?: string | null } = {},
): Promise<InboxPage> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.before) params.set('before', opts.before);
  const query = params.toString();

  const res = await fetch(
    apiUrl(`/api/v1/users/@me/inbox${query ? `?${query}` : ''}`),
    { headers: authHeaders(opts.token) },
  );

  if (!res.ok) throw await readError(res);
  const body = (await res.json()) as Partial<InboxPage> | null;
  // A page with no list is a MALFORMED page, not an empty one — but it must
  // not be a crash either. This client runs at the shell's boot on every
  // surface (`AuthenticatedApp` owns the single `useInbox`), and the body was
  // being cast to `InboxPage` unchecked, so a payload without `items` threw
  // "incoming is not iterable" out of `mergeInbox` and took the whole app to
  // the error boundary. Found 2026-09-15 through the e2e fixtures, which stub
  // unmatched routes with `{}` and so turned every spec red at sign-in.
  return {
    items: Array.isArray(body?.items) ? body.items : [],
    oldest_id: typeof body?.oldest_id === 'string' ? body.oldest_id : null,
  };
}

/** Answer one mention. Idempotent server-side; a repeat is not an error. */
export async function dismissInboxItem(messageId: string, token?: string): Promise<void> {
  const res = await fetch(apiUrl(`/api/v1/users/@me/inbox/${encodeURIComponent(messageId)}`), {
    method: 'DELETE',
    headers: authHeaders(token),
  });

  if (!res.ok) throw await readError(res);
}

/** Sweep the backlog; returns how many rows the server cleared. */
export async function sweepInbox(token?: string): Promise<number> {
  const res = await fetch(apiUrl('/api/v1/users/@me/inbox'), {
    method: 'DELETE',
    headers: authHeaders(token),
  });

  if (!res.ok) throw await readError(res);

  const body = (await res.json()) as { done_count?: number };
  return body.done_count ?? 0;
}

/** Newest first (decimal-string snowflakes). */
export function sortInbox(items: readonly InboxItem[]): InboxItem[] {
  return [...items].sort((a, b) => compareSnowflakes(b.message_id, a.message_id));
}

/**
 * Union by message id, newest first — the merge the hydrate path must use.
 *
 * `incoming` (the server's snapshot) wins on an id both sides hold, because
 * the server's row IS the recorded event. A local row the snapshot does not
 * contain SURVIVES: it can only be newer than the snapshot, and dropping it
 * is the clobbering this function exists to prevent.
 */
export function mergeInbox(
  local: readonly InboxItem[],
  incoming: readonly InboxItem[] | null | undefined,
): InboxItem[] {
  const byId = new Map<string, InboxItem>();
  for (const item of local ?? []) byId.set(item.message_id, item);
  // Total on purpose: a missing snapshot list means "nothing new from the
  // server", never a thrown app. See `fetchInbox` for how a missing list
  // reached here as a boot-time crash.
  for (const item of incoming ?? []) byId.set(item.message_id, item);
  return sortInbox([...byId.values()]);
}

/** The two watermark maps the prune reads (structural — a store slice subset). */
export interface ReadWatermarks {
  channel: Record<string, { last_read_id?: string | null } | undefined>;
  thread: Record<string, { last_read_id?: string | null } | undefined>;
}

/** True when the member's read state already covers this item. */
export function isAnswered(item: InboxItem, watermarks: ReadWatermarks): boolean {
  // A thread mention is answered by the THREAD's watermark only: the channel
  // ack speaks about the timeline, which hides replies (the server's rule,
  // mirrored here so the two cannot disagree).
  const tier =
    item.thread_id != null
      ? watermarks.thread[item.thread_id]
      : watermarks.channel[item.channel_id];

  const lastRead = tier?.last_read_id ?? null;
  if (lastRead === null) return false;
  return compareSnowflakes(item.message_id, lastRead) <= 0;
}

/**
 * What the surface renders: the merged backlog minus
 *   * rows the member's read state already answers, and
 *   * rows dismissed in THIS session (the server deleted them; the local
 *     session remembers so a live accrual of the same message cannot bring
 *     one back before the next hydrate).
 */
export function openInbox(
  items: readonly InboxItem[],
  watermarks: ReadWatermarks,
  dismissed: ReadonlySet<string>,
): InboxItem[] {
  return items.filter((item) => !dismissed.has(item.message_id) && !isAnswered(item, watermarks));
}

/** Discord-style `<@id>` / `<@!id>` tokens — the server's own grammar. */
const MENTION_RE = /<@!?(\d{1,19})>/g;

/**
 * Does `content` address `userId`? The client's local accrual must use the
 * SAME grammar the server records with (both token forms), or a live mention
 * would appear for a session and vanish on the next hydrate.
 */
export function mentionsUser(content: string | null | undefined, userId: string | null): boolean {
  if (!content || userId === null) return false;
  for (const match of content.matchAll(MENTION_RE)) {
    if (match[1] === userId) return true;
  }
  return false;
}

/** Render `content` with mention tokens resolved to names (plain text). */
export function renderExcerpt(content: string, nameFor: (userId: string) => string): string {
  return content.replace(MENTION_RE, (_token, id: string) => `@${nameFor(id)}`);
}
