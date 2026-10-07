/**
 * @cytale/web — auth-form error classification (diagnosability hardening).
 *
 * Why this exists: every auth page used to collapse any non-specific failure
 * into "Could not sign in. Please try again." and never logged the cause — so
 * a wedged client, an unreachable API, or a rate limit all looked identical
 * and were invisible to both the user and triage (2026-09-10 incident: a
 * successful server-side login whose client aborted mid-flow produced that
 * generic message with nothing to go on).
 *
 * Contract:
 *   * ALWAYS `console.error` the real error with a page context (support and
 *     the browser console are the two places triage starts).
 *   * Classify the error into a user-facing message: network failures get an
 *     actionable connection message instead of the generic one.
 *   * A 429 is NEVER rendered as a credential failure: it says "slow down"
 *     with the server's own retry hint (#90). Behind a NAT a whole team shares
 *     one IP budget, so "too many attempts from this network — try again in
 *     12 seconds" is the truthful message; the generic sign-in failure it used
 *     to show made users conclude their password had stopped working.
 *   * Carry a muted `detail` line (machine key · code · HTTP status) so the
 *     rendered error is self-identifying without opening devtools.
 */

export interface AuthErrorInfo {
  /** Primary user-facing message. */
  message: string;
  /** Muted secondary line: machine key/code/status; null when unknown. */
  detail: string | null;
}

/** True for transport-level failures (fetch rejected, offline, DNS, TLS). */
export function isNetworkError(err: unknown): boolean {
  if (err instanceof TypeError) return true; // fetch reject ("Failed to fetch")
  if (typeof err === 'object' && err !== null) {
    const e = err as { key?: unknown; status?: unknown };
    if (e.key === 'network_error' || e.status === 0) return true;
  }
  return false;
}

/**
 * True for a rate-limit rejection: HTTP 429, or the server's `rate_limited`
 * error key. Both spellings are checked — the native surface emits the
 * lower-case key documented in docs/protocol/rest.md, older fixtures carry the
 * upper-case one.
 *
 * @param err the caught error (ApiError, anything)
 */
export function isRateLimitError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { key?: unknown; status?: unknown };
  if (e.status === 429) return true;
  return typeof e.key === 'string' && e.key.toLowerCase() === 'rate_limited';
}

const NETWORK_MESSAGE =
  "Couldn't reach the server — check your connection and try again.";

/** Last-resort retry copy when the server sent no message of its own. */
const RATE_LIMIT_MESSAGE =
  'Too many attempts from this network — wait a moment and try again.';

/**
 * Classify one auth-flow failure.
 *
 * @param err      the caught error (ApiError, TypeError, anything)
 * @param fallback page-specific generic message (used for non-network,
 *                 non-classified errors — the caller keeps its own copy)
 * @param context  short page label for the console line, e.g. 'login'
 */
export function describeAuthError(
  err: unknown,
  { fallback, context }: { fallback: string; context: string },
): AuthErrorInfo {
  // eslint-disable-next-line no-console
  console.error(`[auth] ${context} failed`, err);

  if (isNetworkError(err)) {
    return { message: NETWORK_MESSAGE, detail: null };
  }

  const e = err as { key?: unknown; code?: unknown; status?: unknown; message?: unknown } | null;
  const parts: string[] = [];
  if (typeof e?.key === 'string' && e.key) parts.push(e.key);
  if (typeof e?.code === 'number') parts.push(String(e.code));
  if (typeof e?.status === 'number' && e.status > 0) parts.push(`HTTP ${e.status}`);
  const detail = parts.length > 0 ? parts.join(' · ') : null;

  if (isRateLimitError(err)) {
    // The server's 429 message names the limit that tripped (account vs the
    // shared per-IP one) and the retry hint; show it verbatim so the user is
    // told to slow down rather than to check their password.
    const message = typeof e?.message === 'string' && e.message ? e.message : RATE_LIMIT_MESSAGE;
    return { message, detail };
  }

  if (isServerUnavailableError(err)) {
    // The server's own 503 copy says why ("out of storage", "busy"); the
    // page fallback would send the user to retype a password that is fine.
    const message = typeof e?.message === 'string' && e.message ? e.message : fallback;
    return { message, detail };
  }

  return { message: fallback, detail };
}

/** The server's own 503 keys (docs/protocol/rest.md), whose messages are written for users. */
const SERVER_UNAVAILABLE_KEYS = new Set(['service_unavailable', 'service_busy', 'storage_full']);

/**
 * True for a 503 the server itself sent with one of its documented keys. A
 * 503 from a proxy in front of it carries no such key and keeps the fallback.
 *
 * @param err the caught error (ApiError, anything)
 */
export function isServerUnavailableError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { key?: unknown; status?: unknown };
  return e.status === 503 && typeof e.key === 'string' && SERVER_UNAVAILABLE_KEYS.has(e.key.toLowerCase());
}
