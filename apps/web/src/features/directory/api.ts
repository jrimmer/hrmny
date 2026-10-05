/**
 * @cytale/web — People Directory API wrapper (U26).
 *
 * Thin fetch wrapper against the U9 people contract. The endpoint is
 * authenticated (Bearer) and cursor-paginated via `before` (newest-first
 * snowflake cursor). Tests mock `fetch`; this module never touches the
 * network in unit tests.
 */

import type { WorkspaceMember } from '@cytale/domain';

import { apiUrl } from '../../app/origin.js';

import type { PeopleMember, PeoplePage } from './types.js';

export interface PeopleQuery {
  workspaceId: string;
  /** Debounced name/handle filter (R14 people search). */
  query?: string;
  /** Cursor for the next older page (snowflake string). */
  before?: string | null;
  limit?: number;
  /**
   * The LOOKUP form (`?ids=`, at most 100): the rows for exactly these ids —
   * how the member resolver names authors beyond the first page. Replaces
   * query/before/limit.
   */
  ids?: readonly string[];
  /** Bearer token for the authenticated endpoint (U19 authStore seam). */
  token?: string;
}

export interface PeopleApiError {
  status: number;
  key?: string;
  message?: string;
}

const DEFAULT_LIMIT = 50;

/**
 * Fetch one page of the people directory. Throws `PeopleApiError` on
 * non-2xx so the surface can render a distinct error state with retry.
 */
export async function fetchPeoplePage(query: PeopleQuery): Promise<PeoplePage> {
  const params = new URLSearchParams();
  if (query.ids) {
    params.set('ids', query.ids.join(','));
  } else {
    if (query.query) params.set('query', query.query);
    if (query.before) params.set('before', query.before);
    params.set('limit', String(query.limit ?? DEFAULT_LIMIT));
  }

  const url = apiUrl(
    `/api/v1/workspaces/${encodeURIComponent(query.workspaceId)}/people?${params.toString()}`,
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
    throw { status: res.status, key, message } satisfies PeopleApiError;
  }

  return (await res.json()) as PeoplePage;
}

/**
 * A people row → the store's roster row. ONE mapping for the boot page and
 * the member resolver's lookups, so a member named on demand is the same row
 * a page read produces: name, avatar, and the principal kind / owner / DM
 * policy every DM and attribution surface reads (owner report 2026-09-15).
 */
export function memberFromPeopleRow(p: PeopleMember): WorkspaceMember {
  return {
    id: p.user.id,
    username: p.user.username,
    display_name: p.user.display_name ?? null,
    avatar_url: p.user.avatar_url ?? null,
    nickname: p.nickname,
    joined_at: p.joined_at ?? '',
    roles: p.roles ?? [],
    kind: p.kind ?? undefined,
    parent_user_id: p.parent_user_id ?? undefined,
    dm_support: p.dm_support ?? undefined,
  };
}
