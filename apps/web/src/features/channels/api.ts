/**
 * @cytale/web — Channel Sidebar API wrapper (U20).
 *
 * Thin fetch wrappers against the U9 invite contract (join flow F1). The
 * api-client's `resolveInvite` returns the raw envelope; this module parses
 * the documented server shape from `invite_controller.ex` directly so the
 * landing page renders the exact contract. Tests mock `fetch`; this module
 * never touches the network in unit tests.
 */

import { apiUrl } from '../../app/origin.js';

/** Server shape for GET /invites/:code (invite_controller.ex `show/2`). */
export interface ResolvedInvite {
  code: string;
  workspace: { id: string; name: string } | null;
  expires_at: string | null;
  max_uses: number | null;
  use_count: number | null;
}

export interface InviteApiError {
  status: number;
  key?: string;
  message?: string;
}

/**
 * Resolve an invite without auth (public landing). Throws `InviteApiError`
 * on non-2xx so the landing can render distinct empty-states for
 * expired/revoked/invalid codes.
 */
export async function resolveInvite(code: string): Promise<ResolvedInvite> {
  const res = await fetch(apiUrl(`/api/v1/invites/${encodeURIComponent(code)}`), {
    headers: { accept: 'application/json' },
  });

  if (!res.ok) {
    throw await inviteError(res);
  }

  const body = (await res.json()) as { invite: ResolvedInvite };
  return body.invite;
}

/**
 * Accept an invite as the authenticated user (POST /invites/:code). Returns
 * the joined workspace id. Throws `InviteApiError` on non-2xx.
 */
export async function acceptInvite(code: string, token: string): Promise<string> {
  const res = await fetch(apiUrl(`/api/v1/invites/${encodeURIComponent(code)}`), {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    throw await inviteError(res);
  }

  const body = (await res.json()) as { workspace_id: string; joined: boolean };
  return body.workspace_id;
}

async function inviteError(res: Response): Promise<InviteApiError> {
  let key: string | undefined;
  let message: string | undefined;
  try {
    const body = (await res.json()) as { error?: { key?: string; message?: string } };
    key = body.error?.key;
    message = body.error?.message;
  } catch {
    // non-JSON error body — keep status-only
  }
  return { status: res.status, key, message } satisfies InviteApiError;
}
