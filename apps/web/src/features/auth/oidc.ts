/**
 * #12 — the WEB half of the instance OIDC federated sign-in. The server owns
 * every secret and every validation (state/nonce/PKCE live in a server-side
 * single-use transaction; the ID token never touches this code); this module
 * is the browser choreography:
 *
 *   1. `startOidcSignIn` — POST /auth/oidc/start (carrying the signed-out
 *      continuation, #114's pending-route seam, which a full-page provider
 *      redirect would otherwise lose), then send the BROWSER to the
 *      provider's authorize URL (a location assignment, never fetch).
 *   2. The provider redirects back to `/auth/oidc/callback?code=…&state=…` —
 *      a PATH, not a hash fragment (OAuth forbids fragment redirect URIs) —
 *      and the SPA fallback serves the app there. `normalizeOidcProviderRedirect`
 *      (installed at boot) rewrites that into the hash router's shape and
 *      clears the address, so a reload can never replay the single-use code.
 *   3. `OidcCallbackPage` POSTs {code, state} — the server exchanges, validates
 *      and resolves — and feeds the returned pair through the SAME
 *      `loginWithTokens` seam the password and passkey paths use, then
 *      restores `return_to`.
 */

import type { OidcCallbackResponse, OidcStartBody } from '@cytale/api-client';

/** The narrow server-facing surface this module needs (injection keeps the api client out of the unit tests). */
export interface OidcApi {
  oidcStart(body: OidcStartBody): Promise<{ authorize_url: string }>;
  oidcCallback(body: { code: string; state: string }): Promise<OidcCallbackResponse>;
}

/** The SPA route the provider's redirect lands on (registered as the redirect_uri). */
export const OIDC_CALLBACK_PATH = '/auth/oidc/callback';

/**
 * Boot-time normalization (installed once in main.tsx): when the app boots at
 * the provider-redirect PATH, move its query into the hash router's shape and
 * replace the history entry so the single-use code is not replayed on reload.
 * A no-op everywhere else (tests included — no location).
 */
export function normalizeOidcProviderRedirect(): void {
  if (typeof window === 'undefined') return;
  if (window.location.pathname !== OIDC_CALLBACK_PATH) return;

  const search = window.location.search;
  // History-level replace: the address loses both the code and the path it
  // rode in on before the callback page ever mounts.
  window.history.replaceState(null, '', '/');

  if (search !== '') {
    window.location.hash = OIDC_CALLBACK_PATH + search;
  }
}

/**
 * The button's action: mint the ceremony server-side and send the browser to
 * the provider. `returnTo` is the current signed-out route (the hash), which
 * the server sanitizes (relative paths only) and hands back on success.
 */
export async function startOidcSignIn(api: OidcApi, returnTo: string | null): Promise<void> {
  const body: OidcStartBody = {};
  if (returnTo !== null && returnTo !== '') {
    body.return_to = returnTo;
  }

  const { authorize_url } = await api.oidcStart(body);
  // Login-CSRF binding: the server's single-use `state` proves the ceremony
  // is REAL, not that THIS browser started it. Remember it tab-locally so the
  // callback can refuse a landing whose state some other browser minted (an
  // attacker's own completed ceremony, planted to sign the victim in as the
  // attacker).
  rememberOidcState(stateOf(authorize_url));
  window.location.assign(authorize_url);
}

/** sessionStorage key holding the state of the ceremony THIS tab started. */
export const OIDC_STATE_KEY = 'cytale.oidc.state';

function stateOf(authorizeUrl: string): string | null {
  try {
    return new URL(authorizeUrl).searchParams.get('state');
  } catch {
    return null;
  }
}

function rememberOidcState(state: string | null): void {
  try {
    if (state === null || state === '') {
      sessionStorage.removeItem(OIDC_STATE_KEY);
    } else {
      sessionStorage.setItem(OIDC_STATE_KEY, state);
    }
  } catch {
    // Storage blocked: the callback will refuse (no remembered state), which
    // is the safe failure.
  }
}

/**
 * Consume the remembered state and say whether the callback's `state` is the
 * one this tab started. Single-use: the stored value is removed either way,
 * so a second landing (reload, replay) can never match.
 */
export function consumeOidcState(returned: string): boolean {
  let expected: string | null = null;
  try {
    expected = sessionStorage.getItem(OIDC_STATE_KEY);
    sessionStorage.removeItem(OIDC_STATE_KEY);
  } catch {
    expected = null;
  }
  return expected !== null && expected !== '' && expected === returned;
}

/** The current route as a return_to candidate: the hash path, if it looks like one. */
export function currentReturnTo(): string | null {
  if (typeof window === 'undefined') return null;

  const hash = window.location.hash;
  if (!hash.startsWith('#/')) return null;

  const path = hash.slice(1);
  // The auth pages themselves are never continuations.
  if (
    path.startsWith('/login') ||
    path.startsWith('/register') ||
    path.startsWith('/verify-email') ||
    path.startsWith('/forgot-password') ||
    path.startsWith('/reset-password') ||
    path.startsWith(OIDC_CALLBACK_PATH)
  ) {
    return null;
  }

  return path;
}
