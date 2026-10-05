/**
 * @cytale/web — PasskeyEnrollmentPrompt, the shell's "set up a passkey?" ask.
 *
 * Owner direction 2026-09-15: the owner was never ASKED to set a passkey,
 * which they consider part of passkeys being on. So after a successful
 * PASSWORD login (never after a passkey or SSO login — the client gates on
 * which path just succeeded, because the server cannot tell) an account with
 * zero passkeys is offered one here:
 *
 *   * Set up → the Account section's enroll ceremony, reused verbatim
 *     (`enrollPasskey` via the shell's api wiring); success resolves the
 *     prompt to a brief confirmation and it disappears;
 *   * Not now → persisted to localStorage (`cytale.passkey-prompt-dismissed`)
 *     — dismissed means this browser is never asked again; the settings
 *     surface (Account → Passkeys) is the way back in.
 *
 * Posture mirrors NotificationPrompt: an invitation, never an interruption —
 * `role="status"`, non-modal, overlaid on the shell, shown at most once per
 * login, never on the login page itself, and a failed credential-list read
 * stays silent rather than nag over a broken moment.
 */

import { useEffect, useRef, useState } from 'react';

import type { WebauthnCredential } from '@cytale/api-client';

import { describePasskeyError } from './passkeys.js';
import {
  consumePasswordLoginForPasskeyPrompt,
  isPasskeyPromptDismissed,
  rememberDismissal,
} from './passkeyPrompt.js';

export interface PasskeyEnrollmentPromptProps {
  /** Read the signed-in account's credentials (gates "no passkey yet"). */
  onListCredentials(): Promise<WebauthnCredential[]>;
  /** The Account section's enroll ceremony (options → create → verify). */
  onEnroll(name: string): Promise<WebauthnCredential>;
  /**
   * Injectable for tests: whether a password login just completed. Absent →
   * the module flag (set by LoginPage, consumed once) decides.
   */
  pendingPasswordLogin?: boolean;
}

type Phase = 'checking' | 'offer' | 'enrolling' | 'done' | 'idle';

export function PasskeyEnrollmentPrompt({
  onListCredentials,
  onEnroll,
  pendingPasswordLogin,
}: PasskeyEnrollmentPromptProps) {
  const [phase, setPhase] = useState<Phase>('checking');
  const [error, setError] = useState<string | null>(null);
  // The flag is consumed ONCE per login. StrictMode runs this effect twice
  // in dev (state and refs survive between the two runs), so the consumed
  // value parks in a ref: a plain local would make the second run see an
  // empty flag and silently never ask — the exact bug this feature fixes.
  const pendingRef = useRef<boolean | null>(null);

  // Once per mount (a mount IS one login): consume the password-login flag,
  // respect a recorded dismissal, then gate on the account actually having
  // no passkey. Everything that says "don't ask" stays silent — this is an
  // invitation, and it must never block the shell or nag.
  useEffect(() => {
    if (pendingRef.current === null) {
      pendingRef.current = pendingPasswordLogin ?? consumePasswordLoginForPasskeyPrompt();
    }
    if (!pendingRef.current) return;
    if (isPasskeyPromptDismissed()) return;
    let alive = true;
    void (async () => {
      try {
        const credentials = await onListCredentials();
        if (alive && credentials.length === 0) setPhase('offer');
      } catch {
        // A failed read never promotes an ask over a broken moment.
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The confirmation is a beat, not a fixture: it lets the ceremony's end be
  // seen, then removes itself.
  useEffect(() => {
    if (phase !== 'done') return;
    const timer = setTimeout(() => setPhase('idle'), 4000);
    return () => clearTimeout(timer);
  }, [phase]);

  if (phase === 'checking' || phase === 'idle') return null;

  const handleSetup = async () => {
    setPhase('enrolling');
    setError(null);
    try {
      // The same default name the Account section's enroll uses when the
      // member types nothing — the ceremony names the row, not this ask.
      await onEnroll('Passkey');
      setPhase('done');
    } catch (err) {
      // Visible and RETRYABLE, and deliberately NOT recorded as a dismissal:
      // they asked for a passkey and did not get one.
      setError(describePasskeyError(err));
      setPhase('offer');
    }
  };

  const handleNotNow = () => {
    rememberDismissal();
    setPhase('idle');
  };

  return (
    <div
      role="status"
      data-testid="passkey-prompt"
      className="fixed inset-x-0 top-28 z-40 mx-auto flex w-[min(94vw,32rem)] flex-col gap-2 rounded-md border border-line bg-surface-strong px-4 py-3 shadow-lg"
    >
      {phase === 'done' ? (
        <p className="text-sm text-text-primary" data-testid="passkey-prompt-done">
          Passkey ready — next sign-in can use it, no password typed.
        </p>
      ) : (
        <>
          <p className="text-sm text-text-primary">Set up a passkey for faster sign-in?</p>
          {error ? (
            <p className="text-xs text-text-muted" data-testid="passkey-prompt-error">
              {error}
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={phase === 'enrolling'}
              onClick={() => void handleSetup()}
              data-testid="passkey-prompt-setup"
              className="min-h-9 rounded-md border border-accent bg-surface px-3 text-sm font-medium text-text-primary hover:bg-surface-strong disabled:opacity-60"
            >
              {phase === 'enrolling' ? 'Waiting for your passkey…' : 'Set up'}
            </button>
            <button
              type="button"
              disabled={phase === 'enrolling'}
              onClick={handleNotNow}
              data-testid="passkey-prompt-notnow"
              className="min-h-9 rounded-md px-3 text-sm text-text-muted hover:text-text-primary disabled:opacity-60"
            >
              Not now
            </button>
          </div>
        </>
      )}
    </div>
  );
}
