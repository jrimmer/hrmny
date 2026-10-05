/**
 * U19 — view-only gate affordance. Rendered wherever a composer would be
 * when the account is unverified. ACCOUNT_UNVERIFIED from any send attempt
 * routes here as a resend prompt — the raw 403 never reaches the user.
 */

import { useAuth } from './useAuth.js';
import { warningClass } from './formStyles.js';

export function ComposerBanner({ force = false }: { force?: boolean }) {
  const { resendVerification, state } = useAuth();
  const emailVerified = state.emailVerified;

  if (emailVerified && !force) return null;

  return (
    <div className="px-4 py-3" data-testid="composer-banner" role="status">
      <div className={warningClass}>
        <p className="font-medium text-warning">Verify your email to post</p>
        <p className="mt-1 text-text-muted">
          Your account is view-only.{' '}
          <button
            type="button"
            className="rounded text-accent transition-colors duration-[var(--duration-control)] underline hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
            data-testid="composer-resend"
            onClick={() => void resendVerification()}
          >
            Resend the verification email
          </button>
        </p>
      </div>
    </div>
  );
}
