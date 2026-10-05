/**
 * U19 — forgot password: request the reset email (anti-enumeration: always
 * reports success).
 */

import { useState, type FormEvent } from 'react';

import { useAuth } from './useAuth.js';
import {
  authCardClass,
  authHeadingClass,
  authPageClass,
  buttonClass,
  fieldClass,
  labelClass,
  noticeClass,
} from './formStyles.js';

export function ForgotPasswordPage({ onNavigate }: { onNavigate?: (to: string) => void }) {
  const { requestPasswordReset } = useAuth();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);

    try {
      await requestPasswordReset(email);
      setSent(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={authPageClass} data-testid="forgot-password-page">
      <div className={authCardClass}>
        <h1 className={authHeadingClass}>Reset your password</h1>

      {sent ? (
        <div role="status" className={noticeClass} data-testid="reset-email-notice">
          If that address has an account, a reset link is on its way.
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label className={labelClass} htmlFor="forgot-email">
              Account email
            </label>
            <input
              id="forgot-email"
              type="email"
              className={fieldClass}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          <button type="submit" className={buttonClass} disabled={busy}>
            {busy ? 'Sending…' : 'Send reset link'}
          </button>
        </form>
      )}

      <button
        type="button"
        className="mt-4 rounded text-sm text-accent transition-colors duration-[var(--duration-control)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
        onClick={() => onNavigate?.('/login')}
      >
        Back to sign in
      </button>
      </div>
    </div>
  );
}
