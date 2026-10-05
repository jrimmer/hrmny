/**
 * #12 — the provider-redirect landing. The browser arrives here from the
 * OIDC provider (the server registered `<origin>/auth/oidc/callback` as the
 * redirect_uri; the SPA fallback serves this app at the path and the boot
 * normalizer moved the query into the hash). This page finishes the ceremony:
 *
 *   POST /auth/oidc/callback {code, state}  →  the SAME token pair the
 *   password and passkey paths hand to `loginWithTokens` — so the session,
 *   the gateway connect, and the signed-out continuation (#114) resume
 *   identically — then continues to `return_to` (the server-validated
 *   relative path the start carried; "/" when there was none).
 *
 * States-first: a busy line while the exchange runs, a visible alert for
 * every refusal (the server's uniform 401 reads as "sign-in failed", a
 * network error as "reach the server"), and a way back to the ordinary
 * sign-in form. The page never renders a half-signed-in state: on success it
 * navigates away under an already-authenticated session.
 *
 * Two guards ride the exchange: the returned `state` must be the one THIS tab
 * remembered at start (`consumeOidcState` — login-CSRF: no finishing a
 * ceremony another browser started), and an account with TOTP enrolled gets
 * the password login's `totp_pending` step before any token is issued.
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';

import { describeAuthError } from './authErrors.js';
import { useAuth } from './useAuth.js';
import { api } from './session.js';
import { consumeOidcState } from './oidc.js';
import {
  authCardClass,
  authHeadingClass,
  authPageClass,
  buttonClass,
  errorClass,
  fieldClass,
  ghostButtonClass,
  labelClass,
} from './formStyles.js';

// 6.4 rename window: keys compare case-insensitively (see LoginPage).
function errorKey(err: unknown): string | undefined {
  const key = (err as { key?: unknown } | null)?.key;
  return typeof key === 'string' ? key.toLowerCase() : undefined;
}

function serverMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'SSO sign-in failed. Please try again.';
}

/** The enrolled account's second step (the password login's `totp_pending`). */
interface TotpStep {
  grant: string;
  username: string;
  returnTo: string | null;
}

export function OidcCallbackPage({ onNavigate }: { onNavigate?: (to: string) => void }) {
  const { loginWithTokens } = useAuth();
  // The exchange runs ONCE: StrictMode double-mounts effects in dev, and the
  // server's transaction is single-use — the second consume would 401.
  const started = useRef(false);

  const [error, setError] = useState<{ message: string; detail: string | null } | null>(null);
  const [totp, setTotp] = useState<TotpStep | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const query = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
    const code = query.get('code');
    const state = query.get('state');

    void (async () => {
      try {
        if (code === null || state === null) {
          // A landing without the provider's query: cancelled at the provider,
          // a mistyped URL, or a stale bookmark — say so, offer the way back.
          setError({
            message: 'The sign-in provider did not return a completion code.',
            detail: null,
          });
          return;
        }

        // Login-CSRF: only finish a ceremony THIS tab started. A callback
        // carrying someone else's state (an attacker's completed ceremony,
        // planted via a link) would otherwise sign this browser in as them.
        if (!consumeOidcState(state)) {
          setError({
            message: 'This sign-in was not started from this browser tab, so it was not completed.',
            detail: 'Start SSO sign-in again from the sign-in page.',
          });
          return;
        }

        const res = await api.oidcCallback({ code, state });
        if ('status' in res) {
          // The account has two-factor authentication enrolled: the same
          // challenge step the password login owes.
          setTotp({ grant: res.grant, username: res.user.username, returnTo: res.return_to });
          return;
        }
        // Success: the same session machinery as password login — the gateway
        // connects and the signed-out continuation resumes via auth state.
        await loginWithTokens(res);
        onNavigate?.(res.return_to ?? '/');
      } catch (err) {
        if (errorKey(err) === 'oidc_link_required') {
          // The provider's email matches a local account that never verified
          // that address: not linked (account-takeover guard). The server's
          // copy names the way forward (password sign-in, then verify).
          setError({ message: serverMessage(err), detail: null });
          return;
        }
        setError(
          describeAuthError(err, {
            fallback: 'SSO sign-in failed. Please try again.',
            context: 'login',
          }),
        );
      }
    })();
    // The ceremony is minted once per landing; the deps are deliberately empty.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onTotpSubmit(e: FormEvent) {
    e.preventDefault();
    if (totp === null) return;
    setError(null);
    setBusy(true);
    try {
      const tokens = await api.twoFactorVerify({ grant: totp.grant, code: totpCode.trim() });
      await loginWithTokens(tokens);
      onNavigate?.(totp.returnTo ?? '/');
    } catch (err) {
      if (errorKey(err) === 'invalid_credentials' || errorKey(err) === 'two_factor_disabled') {
        // The grant is spent on ANY attempt (one code shot per sign-in, the
        // password path's posture): the only way on is a fresh sign-in, and
        // the server's copy says so.
        setTotp(null);
        setError({ message: serverMessage(err), detail: null });
        return;
      }
      setError(
        describeAuthError(err, {
          fallback: 'Could not verify the code. Please sign in again.',
          context: 'oidc-totp',
        }),
      );
    } finally {
      setBusy(false);
    }
  }

  if (totp !== null) {
    return (
      <div className={authPageClass} data-testid="oidc-callback-page">
        <div className={authCardClass}>
          <h1 className={authHeadingClass}>Two-factor authentication</h1>
          <p className="-mt-4 mb-4 text-sm text-text-muted" data-testid="oidc-totp-user">
            Signing in as @{totp.username}
          </p>
          <form onSubmit={onTotpSubmit} className="space-y-4" data-testid="oidc-totp-step">
            <div>
              <label className={labelClass} htmlFor="oidc-totp-code">
                Enter the 6-digit code from your authenticator app.
              </label>
              <input
                id="oidc-totp-code"
                className={fieldClass}
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value.replace(/\s/g, ''))}
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                maxLength={12}
                data-testid="oidc-totp-input"
                required
              />
            </div>

            {error !== null && (
              <div role="alert" className={errorClass} data-testid="oidc-totp-error">
                {error.message}
              </div>
            )}

            <button type="submit" className={buttonClass} disabled={busy || totpCode.trim() === ''}>
              {busy ? 'Verifying…' : 'Verify'}
            </button>
          </form>
          <button
            type="button"
            className={`${ghostButtonClass} mt-4`}
            onClick={() => onNavigate?.('/login')}
          >
            Back to sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={authPageClass} data-testid="oidc-callback-page">
      <div className={authCardClass}>
        <h1 className={authHeadingClass}>Signing you in…</h1>

        {error !== null ? (
          <>
            <div role="alert" className={errorClass} data-testid="oidc-callback-error">
              {error.message}
              {error.detail !== null ? (
                <span className="mt-1 block text-xs opacity-75">{error.detail}</span>
              ) : null}
            </div>
            <button
              type="button"
              className={`${ghostButtonClass} mt-4`}
              onClick={() => onNavigate?.('/login')}
            >
              Back to sign in
            </button>
          </>
        ) : (
          <p className="text-sm text-text-muted" data-testid="oidc-callback-busy">
            Completing your provider sign-in. This only takes a moment.
          </p>
        )}
      </div>
    </div>
  );
}
