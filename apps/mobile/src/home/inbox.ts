/**
 * @cytale/mobile — the mention inbox contract and merge rules (#117 port).
 *
 * Ported from apps/web/src/features/home/inbox.ts so both clients share ONE
 * contract: the row shape, the REST wrapper (origin-resolved for the mobile
 * session), and the pure MERGE / PRUNE rules — the merge is the piece a
 * wrong implementation makes worse than no feature (a replace would erase
 * mentions that arrived while the hydrate was in flight). The web module's
 * docs are the authoritative explanation; this file keeps the same names
 * and semantics so the two cannot drift silently.
 */
import { compareSnowflakes } from '@cytale/domain';

import { currentServerOrigin } from '../navigation/session';

/** One row of `GET /api/v1/users/@me/inbox`. */
export interface InboxItem {
  message_id: string;
  channel_id: string;
  thread_id?: string | null;
  author_id: string;
  author_username?: string | null;
  kind?: string;
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

/** The origin-resolved API URL (the mobile session's login-time server). */
function apiUrl(path: string): string {
  const origin = currentServerOrigin();
  return origin === undefined ? path : `${origin}${path}`;
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
  const params: string[] = [];
  if (opts.limit !== undefined) params.push(`limit=${String(opts.limit)}`);
  if (opts.before) params.push(`before=${encodeURIComponent(opts.before)}`);
  const query = params.length > 0 ? `?${params.join('&')}` : '';

  const res = await fetch(apiUrl(`/api/v1/users/@me/inbox${query}`), {
    headers: authHeaders(opts.token),
  });

  if (!res.ok) throw await readError(res);
  const body = (await res.json()) as Partial<InboxPage> | null;
  // A page with no list is MALFORMED, not empty — and must not crash the app
  // (the web port's 2026-09-15 lesson, kept here verbatim).
  return {
    items: Array.isArray(body?.items) ? body.items : [],
    oldest_id: typeof body?.oldest_id === 'string' ? body.oldest_id : null,
  };
}

/** Answer one mention. Idempotent server-side; a repeat is not an error. */
export async function dismissInboxItem(messageId: string, token?: string): Promise<void> {
  const res = await fetch(
    apiUrl(`/api/v1/users/@me/inbox/${encodeURIComponent(messageId)}`),
    { method: 'DELETE', headers: authHeaders(token) },
  );
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

/** Union by message id, newest first — the hydrate path must MERGE, not replace. */
export function mergeInbox(
  local: readonly InboxItem[],
  incoming: readonly InboxItem[] | null | undefined,
): InboxItem[] {
  const byId = new Map<string, InboxItem>();
  for (const item of local ?? []) byId.set(item.message_id, item);
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
  const tier =
    item.thread_id != null
      ? watermarks.thread[item.thread_id]
      : watermarks.channel[item.channel_id];
  const lastRead = tier?.last_read_id ?? null;
  if (lastRead === null) return false;
  return compareSnowflakes(item.message_id, lastRead) <= 0;
}

/** The surface's view: merged backlog minus answered and session-dismissed. */
export function openInbox(
  items: readonly InboxItem[],
  watermarks: ReadWatermarks,
  dismissed: ReadonlySet<string>,
): InboxItem[] {
  return items.filter((item) => !dismissed.has(item.message_id) && !isAnswered(item, watermarks));
}

/** Discord-style `<@id>` / `<@!id>` tokens — the server's own grammar. */
const MENTION_RE = /<@!?(\d{1,19})>/g;

/** Does `content` address `userId`? The server's grammar, both token forms. */
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
