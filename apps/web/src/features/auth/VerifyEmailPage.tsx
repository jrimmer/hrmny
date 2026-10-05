/**
 * U19 — verify-email landing: consumes the emailed single-use token from the
 * URL query, offers resend, and renders the view-only banner state.
 */

import { useState, useEffect } from 'react';

import { useAuth } from './useAuth.js';
import {
  authCardClass,
  authHeadingClass,
  authPageClass,
  buttonClass,
  errorClass,
  noticeClass,
} from './formStyles.js';

export function VerifyEmailPage({ token, onNavigate }: { token: string | null; onNavigate?: (to: string) => void }) {
  const { verifyEmail, resendVerification, state } = useAuth();
  const [status, setStatus] = useState<'working' | 'done' | 'error'>(token ? 'working' : 'error');
  const [resendBusy, setResendBusy] = useState(false);
  const [resendDone, setResendDone] = useState(false);
  const [message, setMessage] = useState<string | null>(token ? null : 'No verification token in the link.');

  useEffect(() => {
    if (token === null) return;

    verifyEmail(token)
      .then(() => {
        setStatus('done');
        // WEB-5: the token is single-use and now consumed — take it out of
        // the address bar so screenshots, screen shares and browser history
        // never carry a credential-shaped string. `replaceState` (not a
        // navigation) keeps the app on this exact view with no history entry
        // and no hashchange re-render; the emailed link format itself is
        // untouched (the server mints it). A browser that refuses the
        // rewrite keeps the token visible, where it no longer works.
        try {
          globalThis.history?.replaceState?.(null, '', '#/verify-email');
        } catch {
          /* address bar keeps the consumed token — harmless */
        }
      })
      .catch(() => {
        setStatus('error');
        setMessage('This link is invalid or was already used. Send a new email below.');
      });
  }, [token, verifyEmail]);

  async function onResend() {
    setResendBusy(true);
    try {
      await resendVerification();
      setResendDone(true);
    } catch {
      setMessage('Could not resend the email. Try again shortly.');
    } finally {
      setResendBusy(false);
    }
  }

  const verified = state.emailVerified || status === 'done';

  return (
    <div className={authPageClass} data-testid="verify-email-page">
      <div className={authCardClass}>
        <h1 className={authHeadingClass}>Verify your email</h1>

      {status === 'working' && <div className={noticeClass}>Verifying…</div>}

      {verified && status === 'done' && (
        <div role="status" className={noticeClass}>
          Email verified — your account is unlocked. Welcome aboard.
        </div>
      )}

      {status === 'error' && (
        <div role="alert" className={errorClass}>
          {message ?? 'Verification failed.'}
        </div>
      )}

      {!verified && (
        <div className="mt-4 space-y-3">
          <div className={noticeClass} data-testid="view-only-banner">
            Your account is view-only until verification completes. You can browse, but
            posting is disabled.
          </div>

          {resendDone ? (
            <div role="status" className={noticeClass}>
              Fresh verification email sent — the old link is now invalid.
            </div>
          ) : (
            <button type="button" className={buttonClass} onClick={onResend} disabled={resendBusy}>
              {resendBusy ? 'Sending…' : 'Resend verification email'}
            </button>
          )}

          <button
            type="button"
            className="rounded text-sm text-accent transition-colors duration-[var(--duration-control)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
            onClick={() => onNavigate?.('/login')}
          >
            Back to sign in
          </button>
        </div>
      )}
      </div>
    </div>
  );
}
