/**
 * @cytale/mobile — auth failure copy and state (plan 004 M12, R4/R6).
 *
 * The web app's behaviour reference, ported: `LoginPage`/`RegisterPage` map the
 * server's `{error:{key}}` envelope to fixed inline copy, and anything that is
 * not a server envelope (a rejected `fetch`) is a connectivity problem, not a
 * credential problem. The screens render the difference — inline alert vs the
 * offline state with a retry — so the mapping lives here, pure and tested,
 * instead of in JSX branches.
 *
 * Copy is web's verbatim where the state matches.
 */
import { ApiError } from '@cytale/api-client';

export type AuthAction = 'sign-in' | 'sign-up';

export type AuthFailure =
  | { kind: 'invalid-credentials'; message: string }
  | { kind: 'taken'; message: string }
  | { kind: 'server'; message: string }
  | { kind: 'offline'; message: string };

/** The offline copy the retry state renders (web's connectivity language). */
export const OFFLINE_MESSAGE = 'You appear to be offline. Check your connection and try again.';

/**
 * Classify a thrown `login()`/`register()` error.
 *
 * The api-client funnels EVERY failed call into an `ApiError` (#88) — a
 * rejected fetch arrives as `key: 'network_error'` with `status: 0` (the
 * transport shape every catch site narrows on), not as a raw rejection. So
 * connectivity is that shape OR a non-ApiError, and both mean the screens
 * show the offline state with retry rather than a misleading credential
 * error. A real server envelope carries the server's meaning inline.
 */
export function describeAuthFailure(error: unknown, action: AuthAction): AuthFailure {
  if (error instanceof ApiError && (error.key === 'network_error' || error.status === 0)) {
    return { kind: 'offline', message: OFFLINE_MESSAGE };
  }
  if (!(error instanceof ApiError)) {
    return { kind: 'offline', message: OFFLINE_MESSAGE };
  }

  // 6.4 rename window: the server's key moved to lower_snake and a pre-rename
  // build can still be live against it, so ONE case-insensitive comparison
  // covers both spellings — exactly what web's `authErrors.ts` does. This file
  // was missed by the rename and kept matching only the SHOUTY spelling, so a
  // member signing in on mobile got the generic copy for a wrong password.
  const key = error.key?.toLowerCase();
  if (action === 'sign-in') {
    return key === 'invalid_credentials'
      ? { kind: 'invalid-credentials', message: 'Wrong username/email or password.' }
      : { kind: 'server', message: 'Could not sign in. Please try again.' };
  }

  // The server deliberately answers ONE anti-enumeration conflict code for both
  // a taken username and a taken email (S5 hardening) — the copy mirrors web's.
  if (key === 'taken')
    return { kind: 'taken', message: 'That username or email is already registered.' };
  return { kind: 'server', message: 'Could not create the account. Please try again.' };
}
