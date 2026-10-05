/**
 * U19 — register: creates a view-only account, then routes to verify-email.
 *
 * Invite-only servers (security Tier 2 #5): the invite landing parks the code
 * in sessionStorage before routing here; it rides the register body, and a
 * server with closed sign-up accepts ONLY such a body (the new account joins
 * that workspace in the same call, so the parked code is spent and cleared).
 * Without one, a closed server answers `registration_closed`, which renders
 * as an invite-only explanation rather than a generic failure.
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
} from './formStyles.js';

/** Where the invite landing parks the code across the register hop. */
export const PENDING_INVITE_KEY = 'cytale.pending-invite';

function readPendingInvite(): string | undefined {
  try {
    return sessionStorage.getItem(PENDING_INVITE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function clearPendingInvite(): void {
  try {
    sessionStorage.removeItem(PENDING_INVITE_KEY);
  } catch {
    // storage unavailable — nothing was parked
  }
}

const REGISTRATION_CLOSED_MESSAGE =
  'Sign-up on this server is by invitation only. Open an invite link from a workspace member to create an account.';
const INVITE_INVALID_MESSAGE =
  'The invite you arrived with is no longer valid (it expired or was used up). Ask for a new invite link.';

export function RegisterPage({
  onNavigate,
  inviteCode = readPendingInvite(),
}: {
  onNavigate?: (to: string) => void;
  /** The invite code to register with (defaults to the parked one). */
  inviteCode?: string;
}) {
  const { register } = useAuth();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<{ message: string; detail: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);

    try {
      await register(username, email, password, inviteCode);
      // The server joined the invite's workspace in the same call: the parked
      // code is spent, so the post-auth app must not offer to accept it again.
      if (inviteCode) clearPendingInvite();
      onNavigate?.('/verify-email'); // view-only until the emailed token lands
    } catch (err) {
      const key = (err as { key?: string }).key;
      setError(
        // S5: the server answers ONE code for both (anti-enumeration — it
        // must not reveal which of the two is registered), so the UI message
        // names neither.
        key === 'taken'
          ? { message: 'That username or email is already registered.', detail: null }
          : key === 'registration_closed'
            ? { message: REGISTRATION_CLOSED_MESSAGE, detail: null }
            : key === 'invite_invalid'
              ? { message: INVITE_INVALID_MESSAGE, detail: null }
              : describeAuthError(err, {
              fallback: 'Could not create the account. Please try again.',
              context: 'register',
            }),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={authPageClass} data-testid="register-page">
      <div className={authCardClass}>
        <h1 className={authHeadingClass}>Create your account</h1>
        {inviteCode ? (
          <p className="mb-4 text-sm text-text-muted" data-testid="register-invite-note">
            You're signing up with an invite — you'll join its workspace when your account is created.
          </p>
        ) : null}

        <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label className={labelClass} htmlFor="register-username">
            Username
          </label>
          <input
            id="register-username"
            className={fieldClass}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
          />
        </div>

        <div>
          <label className={labelClass} htmlFor="register-email">
            Email
          </label>
          <input
            id="register-email"
            type="email"
            className={fieldClass}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
        </div>

        <div>
          <label className={labelClass} htmlFor="register-password">
            Password
          </label>
          <input
            id="register-password"
            type="password"
            className={fieldClass}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            required
          />
        </div>

        {error !== null && (
          <div role="alert" className={errorClass} data-testid="register-error">
            {error.message}
            {error.detail !== null ? (
              <span className="mt-1 block text-xs opacity-75" data-testid="register-error-detail">
                {error.detail}
              </span>
            ) : null}
          </div>
        )}

        <button type="submit" className={buttonClass} disabled={busy}>
          {busy ? 'Creating…' : 'Create account'}
        </button>
      </form>

        <p className="mt-4 text-sm text-text-muted">
          Accounts start view-only — verify your email to post.
        </p>
      </div>
    </div>
  );
}
