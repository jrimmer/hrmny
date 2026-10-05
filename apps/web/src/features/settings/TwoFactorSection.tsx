/**
 * @cytale/web — TwoFactorSection (#127), the Account section's TOTP block.
 *
 * Visible ONLY while the server's 2FA switch is on (`mode_enabled` off = the
 * feature is absent client-side too, exactly like the login page's other
 * surfaces). Three states:
 *
 *   * not enrolled — the enroll walk: start mints a candidate secret, the QR
 *     (rendered client-side from the otpauth URI) and the base32 secret
 *     (manual entry) are both shown, and a valid 6-digit code confirms.
 *   * enrolled — the confirmed date + last use, and Remove behind the inline
 *     two-step confirm. Removing while the switch is on is allowed BY DESIGN:
 *     the next password login simply re-prompts (no self-lockout). The copy
 *     states the recovery trade: a password reset also clears 2FA (email
 *     possession is the channel).
 *
 * The four API callbacks are injected (the DOM-of-the-browser-thin,
 * unit-testable pattern PasskeysSection established); AuthenticatedApp builds
 * them from the api client.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { TwoFactorEnrollStart, TwoFactorStatus } from '@cytale/api-client';

import { formatShortDate } from '../../app/ui/time.js';
import { InlineConfirm } from './InlineConfirm.js';
import { QrSvg } from '../../app/ui/QrSvg.js';

export interface TwoFactorSectionProps {
  /** GET /users/@me/two-factor — the mode + this account's enrollment. */
  onStatus(): Promise<TwoFactorStatus>;
  /** POST /auth/2fa/enroll/start (Bearer) — the candidate secret + otpauth URI. */
  onEnrollStart(): Promise<TwoFactorEnrollStart>;
  /** POST /auth/2fa/enroll/confirm (Bearer) — verifies the code against the candidate. */
  onEnrollConfirm(code: string): Promise<unknown>;
  /** DELETE /users/@me/two-factor. */
  onRemove(): Promise<void>;
}

const subtleButtonClass =
  'min-h-9 rounded-md border border-line bg-surface-strong px-3 py-1.5 text-sm font-medium text-text transition-colors duration-[var(--duration-control)] hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] disabled:cursor-not-allowed disabled:opacity-50';

const inputClass =
  'min-h-9 w-40 rounded-md border border-line bg-surface-strong px-3 py-1.5 text-sm text-text placeholder:text-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]';

type Phase = 'idle' | 'confirming';

export function TwoFactorSection({ onStatus, onEnrollStart, onEnrollConfirm, onRemove }: TwoFactorSectionProps) {
  // `null` = not known yet: the section renders NOTHING until the read lands
  // (an unknown mode must not flash a feature that may not exist).
  const [status, setStatus] = useState<TwoFactorStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [phase, setPhase] = useState<Phase>('idle');
  const [start, setStart] = useState<TwoFactorEnrollStart | null>(null);
  const [code, setCode] = useState('');
  const [enrollBusy, setEnrollBusy] = useState(false);
  const [enrollError, setEnrollError] = useState<string | null>(null);

  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const alive = useRef(true);

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      const row = await onStatus();
      if (alive.current) setStatus(row);
    } catch (err) {
      if (alive.current) {
        setStatus(null);
        setLoadError(
          err instanceof Error && err.message ? err.message : 'Could not load your two-factor status.',
        );
      }
    }
  }, [onStatus]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
    };
  }, [refresh]);

  const handleStart = async () => {
    setEnrollBusy(true);
    setEnrollError(null);
    try {
      const s = await onEnrollStart();
      if (alive.current) {
        setStart(s);
        setPhase('confirming');
        setCode('');
      }
    } catch (err) {
      if (alive.current) {
        setEnrollError(
          err instanceof Error && err.message ? err.message : 'Could not start the setup.',
        );
      }
    } finally {
      if (alive.current) setEnrollBusy(false);
    }
  };

  const handleConfirm = async () => {
    setEnrollBusy(true);
    setEnrollError(null);
    try {
      await onEnrollConfirm(code.trim());
      // The enrollment stuck: back to the enrolled state via a fresh read
      // (it carries the confirmed/last-used dates the confirm does not).
      setPhase('idle');
      setStart(null);
      setCode('');
      await refresh();
    } catch (err) {
      if (alive.current) {
        // The server's own copy is authoritative (wrong code, stale
        // candidate): show it and keep the walk — a typo must not lose the QR.
        setEnrollError(
          err instanceof Error && err.message ? err.message : 'Could not confirm the code.',
        );
      }
    } finally {
      if (alive.current) setEnrollBusy(false);
    }
  };

  const handleCancel = () => {
    setPhase('idle');
    setStart(null);
    setCode('');
    setEnrollError(null);
  };

  const handleRemove = async () => {
    setRemoving(true);
    setRemoveError(null);
    try {
      await onRemove();
      if (alive.current) {
        // Removal completes (the section stays while the switch is on — the
        // next password login re-prompts), so flip to the enroll state
        // locally; the server's row is gone.
        setStatus((s) => (s ? { ...s, enrolled: false, confirmed_at: null, last_used_at: null } : s));
      }
    } catch (err) {
      if (alive.current) {
        setRemoveError(
          err instanceof Error && err.message ? err.message : 'Could not remove two-factor authentication.',
        );
      }
    } finally {
      if (alive.current) setRemoving(false);
    }
  };

  // The read failed: the failure is visible (below) rather than silently
  // swallowed. Nothing known yet: render nothing.
  if (status === null) {
    if (loadError === null) return null;
    return (
      <section aria-label="Two-factor authentication" className="flex flex-col gap-3">
        <h2 className="text-sm font-bold uppercase tracking-wide text-text-muted">Two-factor authentication</h2>
        <p role="alert" className="text-sm text-danger" data-testid="settings-twofactor-load-error">
          {loadError}
        </p>
      </section>
    );
  }

  // The switch is OFF (or was flipped off mid-session): the feature is ABSENT
  // client-side too — no enrollment surface, no prompts, even for an account
  // that still holds a retained enrollment (off keeps rows, stops challenging).
  if (!status.mode_enabled) return null;

  const enrolled = status.enrolled;
  const confirmedAt = status.confirmed_at ?? null;
  const lastUsedAt = status.last_used_at ?? null;

  return (
    <section aria-label="Two-factor authentication" className="flex flex-col gap-3" data-testid="settings-twofactor">
      <h2 className="text-sm font-bold uppercase tracking-wide text-text-muted">Two-factor authentication</h2>
      <p className="text-sm text-text-muted">
        Two-factor adds a 6-digit code from an authenticator app on top of your password. If you ever
        lose the app, completing a password reset also clears two-factor authentication.
      </p>

      {enrolled ? (
        <>
          <p className="text-sm text-text" data-testid="settings-twofactor-state">
            Two-factor authentication is <strong>on</strong>
            {confirmedAt ? ` — since ${formatShortDate(confirmedAt)}` : ''}
            {lastUsedAt ? `, last used ${formatShortDate(lastUsedAt)}` : ''}.
          </p>
          {/* The app's one inline destructive confirm (InlineConfirm), not a
              hand-rolled tinted panel — same shape as every settings section. */}
          <span className="self-start">
            <InlineConfirm
              label={removing ? 'Removing…' : 'Remove two-factor'}
              confirmLabel="Remove"
              consequence="Turn off two-factor authentication? Your next password sign-in will ask you to set it up again."
              tone="danger"
              disabled={removing}
              onConfirm={() => void handleRemove()}
              testId="settings-twofactor-remove"
            />
          </span>
          {removeError ? (
            <p role="alert" className="text-sm text-danger" data-testid="settings-twofactor-remove-error">
              {removeError}
            </p>
          ) : null}
        </>
      ) : phase === 'confirming' && start !== null ? (
        <>
          <p className="text-sm text-text-muted">
            Scan with your authenticator app — or enter the code below it manually — then confirm with the
            6-digit code it shows.
          </p>
          <div className="flex flex-col items-start gap-3" data-testid="settings-twofactor-setup">
            <QrSvg
              value={start.otpauth_uri}
              label="QR code with the two-factor setup URI — scan it with an authenticator app"
              testId="settings-twofactor-qr"
            />
            <span
              className="break-all rounded border border-line bg-surface-strong px-2 py-1 font-mono text-xs text-text"
              data-testid="settings-twofactor-secret"
            >
              {start.secret}
            </span>
            <div className="flex items-center gap-2">
              <input
                className={inputClass}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\s/g, ''))}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={12}
                placeholder="123456"
                aria-label="6-digit confirmation code"
                data-testid="settings-twofactor-code-input"
              />
              <button
                type="button"
                className={subtleButtonClass}
                disabled={enrollBusy || code.trim() === ''}
                onClick={handleConfirm}
                data-testid="settings-twofactor-confirm"
              >
                {enrollBusy ? 'Verifying…' : 'Confirm'}
              </button>
              <button
                type="button"
                className={subtleButtonClass}
                disabled={enrollBusy}
                onClick={handleCancel}
                data-testid="settings-twofactor-cancel"
              >
                Cancel
              </button>
            </div>
            {enrollError ? (
              <p role="alert" className="text-sm text-danger" data-testid="settings-twofactor-error">
                {enrollError}
              </p>
            ) : null}
          </div>
        </>
      ) : (
        <>
          <p className="text-sm text-text" data-testid="settings-twofactor-state">
            Two-factor authentication is <strong>off</strong> for your account. Your next password sign-in
            will require setting it up.
          </p>
          <button
            type="button"
            className={subtleButtonClass + ' self-start'}
            disabled={enrollBusy}
            onClick={handleStart}
            data-testid="settings-twofactor-start"
          >
            {enrollBusy ? 'Starting…' : 'Set up two-factor'}
          </button>
          {enrollError ? (
            <p role="alert" className="text-sm text-danger" data-testid="settings-twofactor-error">
              {enrollError}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
