/**
 * U19 — reset password: consumes the emailed token, sets the new password.
 * Completion revokes ALL sessions server-side (documented behavior) — the
 * messaging here states that before the user continues.
 */

import { useState, type FormEvent } from 'react';

import { describeAuthError } from './authErrors.js';
import { useAuth } from './useAuth.js';
import {
  authCardClass,
  authHeadingClass,
  authPageClass,
  buttonClass,
  errorClass,
  fieldClass,
  labelClass,
  noticeClass,
} from './formStyles.js';

export function ResetPasswordPage({
  token,
  onNavigate,
}: {
  token: string | null;
  onNavigate?: (to: string) => void;
}) {
  const { completePasswordReset } = useAuth();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<{ message: string; detail: string | null } | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (token === null) {
      setError({ message: 'No reset token in the link. Request a fresh email.', detail: null });
      return;
    }

    setBusy(true);

    try {
      await completePasswordReset(token, password);
      setDone(true);
    } catch (err) {
      const key = (err as { key?: string }).key;
      // 6.4 rename window: one case-insensitive comparison covers both
      // spellings (the `isRateLimitError` idiom).
      const normalizedKey = key?.toLowerCase();
      setError(
        normalizedKey === 'token_invalid' || normalizedKey === 'token_consumed'
          ? { message: 'This reset link is invalid or expired. Request a fresh one.', detail: null }
          : describeAuthError(err, {
              fallback: 'Could not reset the password. Try again.',
              context: 'password-reset',
            }),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={authPageClass} data-testid="reset-password-page">
      <div className={authCardClass}>
        <h1 className={authHeadingClass}>Choose a new password</h1>

      <div className={noticeClass}>
        Resetting signs out every session on every device — you will sign in again with
        the new password.
      </div>

      {done ? (
        <div className="mt-4 space-y-3" data-testid="reset-done">
          <div role="status" className={noticeClass}>
            Password updated and all sessions revoked.
          </div>
          <button
            type="button"
            className={buttonClass}
            onClick={() => onNavigate?.('/login')}
          >
            Go to sign in
          </button>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="mt-4 space-y-4">
          <div>
            <label className={labelClass} htmlFor="reset-password">
              New password
            </label>
            <input
              id="reset-password"
              type="password"
              className={fieldClass}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
            />
          </div>

          {error !== null && (
            <div role="alert" className={errorClass} data-testid="reset-error">
              {error.message}
              {error.detail !== null ? (
                <span className="mt-1 block text-xs opacity-75" data-testid="reset-error-detail">
                  {error.detail}
                </span>
              ) : null}
            </div>
          )}

          <button type="submit" className={buttonClass} disabled={busy}>
            {busy ? 'Resetting…' : 'Reset password'}
          </button>
        </form>
      )}
      </div>
    </div>
  );
}
