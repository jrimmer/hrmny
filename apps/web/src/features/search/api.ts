/**
 * @cytale/web — Search API wrapper (U24).
 *
 * Thin fetch wrapper against the U13 search contract
 * (`GET /api/v1/workspaces/:id/search?q=&from=&in=&after=&before=`), whose
 * shipped shape lives in
 * `apps/server/lib/cytale_web/controllers/search_controller.ex`:
 *
 *   { "results": [{ "message_id", "channel_id", "thread_id", "score" }],
 *     "next_before": <snowflake cursor | null> }
 *
 * The endpoint answers 501 with the stable `search_not_available` key when the
 * Tantivy index is unavailable — the surface must render a distinct
 * "search unavailable" state rather than a generic error.
 *
 * Local types (not @cytale/domain) because apps/web does not depend on the
 * domain package; the wire shape is the contract and is kept in lockstep with
 * the server controller. This mirrors the U26 people-directory seam.
 */

/** A search hit as served by the workspace search endpoint. */
import { apiUrl } from '../../app/origin.js';

export interface SearchHit {
  message_id: string;
  channel_id: string;
  thread_id: string | null;
  score: number | null;
}

/** The workspace search response envelope. */
export interface SearchPage {
  results: SearchHit[];
  next_before: string | null;
}

/** Filter syntax parsed from the query input (from:/in:/before:/after:). */
export interface SearchFilters {
  from?: string;
  in?: string;
  before?: string;
  after?: string;
}

export interface SearchQuery {
  workspaceId: string;
  /** Free-text keyword (the non-filter remainder of the query). */
  q: string;
  filters: SearchFilters;
  /** Cursor for the next older page (snowflake string). */
  before?: string | null;
  limit?: number;
  /** Bearer token for the authenticated endpoint (U19 authStore seam). */
  token?: string;
}

export interface SearchApiError {
  status: number;
  key?: string;
  message?: string;
}

const DEFAULT_LIMIT = 25;

/**
 * Fetch one page of workspace search results. Throws `SearchApiError` on
 * non-2xx so the surface can render a distinct error state (including the
 * 501 `search_not_available` case) with retry.
 */
export async function fetchSearchPage(query: SearchQuery): Promise<SearchPage> {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.filters.from) params.set('from', query.filters.from);
  if (query.filters.in) params.set('in', query.filters.in);
  if (query.filters.before) params.set('before', query.filters.before);
  if (query.filters.after) params.set('after', query.filters.after);
  if (query.before) params.set('before', query.before);
  params.set('limit', String(query.limit ?? DEFAULT_LIMIT));

  const url = apiUrl(
    `/api/v1/workspaces/${encodeURIComponent(query.workspaceId)}/search?${params.toString()}`,
  );

  const headers: Record<string, string> = { accept: 'application/json' };
  if (query.token) headers.authorization = `Bearer ${query.token}`;

  const res = await fetch(url, { headers });

  if (!res.ok) {
    let key: string | undefined;
    let message: string | undefined;
    try {
      const body = (await res.json()) as { error?: { key?: string; message?: string } };
      key = body.error?.key;
      message = body.error?.message;
    } catch {
      // non-JSON error body — keep status-only
    }
    throw { status: res.status, key, message } satisfies SearchApiError;
  }

  return (await res.json()) as SearchPage;
}

// ---------------------------------------------------------------------------
// Omnisearch (Cmd-K) — GET /api/v1/users/@me/omnisearch?q=
// ---------------------------------------------------------------------------

/** One hydrated hit: where the message lives, who wrote it, and its text. */
export interface OmniHit {
  kind: 'workspace' | 'dm';
  message_id: string;
  channel_id: string;
  thread_id: string | null;
  workspace_id: string | null;
  author_id: string;
  content: string;
  created_at: string;
  score: number | null;
}

export interface OmniPage {
  results: OmniHit[];
}

/**
 * Search the caller's reachable messages: workspace hits pass the
 * per-workspace visible-channel gate, DM hits come from the caller's own
 * per-user index (participation is the authorization). Hydrated rows — a
 * palette that showed bare ids would be unusable. Server-side minimum query
 * length is 2; shorter queries answer empty without touching either segment.
 */
export async function fetchOmnisearch(query: { q: string; token?: string; signal?: AbortSignal }): Promise<OmniPage> {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);

  const headers: Record<string, string> = { accept: 'application/json' };
  if (query.token) headers.authorization = `Bearer ${query.token}`;

  const res = await fetch(apiUrl(`/api/v1/users/@me/omnisearch?${params.toString()}`), {
    headers,
    signal: query.signal,
  });

  if (!res.ok) {
    let key: string | undefined;
    let message: string | undefined;
    try {
      const body = (await res.json()) as { error?: { key?: string; message?: string } };
      key = body.error?.key;
      message = body.error?.message;
    } catch {
      // non-JSON error body — status-only
    }
    throw { status: res.status, key, message } satisfies SearchApiError;
  }

  return (await res.json()) as OmniPage;
}
