/**
 * @cytale/web — PasskeysSection (#36), the Account section's passkeys block.
 *
 * The user-settings half of the bottom-button v1: enroll a named passkey
 * against the signed-in account (the ceremony rides
 * `navigator.credentials.create` via the auth feature's passkeys module),
 * list what is enrolled, and revoke (server-side row removal IS the
 * revocation). Presentation follows AccountSection: real reads only, inline
 * two-step confirms, and every failure state visible — never a silent no-op.
 *
 * The three API callbacks are injected (the section stays DOM-of-the-browser
 * thin and unit-testable); AuthenticatedApp builds them from the api client
 * and the enroll ceremony.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { WebauthnCredential } from '@cytale/api-client';

import { formatShortDate } from '../../app/ui/time.js';
import { InlineConfirm } from './InlineConfirm.js';

export interface PasskeysSectionProps {
  /** Enroll: runs the full options → create → verify ceremony, returns the stored row. */
  onEnroll(name: string): Promise<WebauthnCredential>;
  /** Revoke one credential (204 or a uniform 404 for a foreign id). */
  onRemove(id: string): Promise<void>;
  /** Read the account's list. */
  onList(): Promise<WebauthnCredential[]>;
}

const subtleButtonClass =
  'min-h-9 rounded-md border border-line bg-surface-strong px-3 py-1.5 text-sm font-medium text-text transition-colors duration-[var(--duration-control)] hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] disabled:cursor-not-allowed disabled:opacity-50';

const inputClass =
  'min-h-9 w-56 rounded-md border border-line bg-surface-strong px-3 py-1.5 text-sm text-text placeholder:text-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]';

export function PasskeysSection({ onEnroll, onRemove, onList }: PasskeysSectionProps) {
  const [credentials, setCredentials] = useState<WebauthnCredential[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [enrolling, setEnrolling] = useState(false);
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      const rows = await onList();
      if (alive.current) setCredentials(rows);
    } catch (err) {
      if (alive.current) {
        setCredentials([]);
        setLoadError(err instanceof Error && err.message ? err.message : 'Could not load your passkeys.');
      }
    }
  }, [onList]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
    };
  }, [refresh]);

  const handleEnroll = async () => {
    setEnrolling(true);
    setEnrollError(null);
    try {
      await onEnroll(name.trim() || 'Passkey');
      setName('');
      await refresh();
    } catch (err) {
      if (alive.current) {
        setEnrollError(err instanceof Error && err.message ? err.message : 'Could not add the passkey.');
      }
    } finally {
      if (alive.current) setEnrolling(false);
    }
  };

  const handleRemove = async (id: string) => {
    setRemovingId(id);
    setRemoveError(null);
    try {
      await onRemove(id);
      await refresh();
    } catch (err) {
      if (alive.current) {
        setRemoveError(err instanceof Error && err.message ? err.message : 'Could not remove the passkey.');
      }
    } finally {
      if (alive.current) {
        setRemovingId(null);
      }
    }
  };

  return (
    <section aria-label="Passkeys" className="flex flex-col gap-3" data-testid="settings-passkeys">
      <h2 className="text-sm font-bold uppercase tracking-wide text-text-muted">Passkeys</h2>
      <p className="text-sm text-text-muted">
        Passkeys let you sign in with your fingerprint, face, or device PIN — no password typed. They are additive: your
        password keeps working. Removing one here revokes it everywhere immediately.
      </p>

      {loadError ? (
        <p role="alert" className="text-sm text-danger" data-testid="settings-passkeys-load-error">
          {loadError}
        </p>
      ) : null}

      <ul className="flex flex-col gap-2" data-testid="settings-passkeys-list">
        {(credentials ?? []).map((cred) => (
          <li
            key={cred.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-surface px-3 py-2"
            data-testid="settings-passkeys-row"
          >
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-text" data-testid="settings-passkeys-name">
                {cred.name || 'Passkey'}
              </span>
              <span className="block text-xs text-text-muted" data-testid="settings-passkeys-meta">
                Added {cred.created_at ? formatShortDate(cred.created_at) : '—'}
                {cred.last_used_at ? ` · last used ${formatShortDate(cred.last_used_at)}` : ' · never used'}
              </span>
            </span>
            {/* The app's one inline destructive confirm (InlineConfirm): the
                same trigger → consequence → Cancel/solid-danger Remove every
                settings section uses, instead of a hand-rolled tinted copy. */}
            <InlineConfirm
              label={removingId === cred.id ? 'Removing…' : 'Remove'}
              confirmLabel="Remove"
              consequence="Remove this passkey?"
              tone="danger"
              disabled={removingId !== null}
              onConfirm={() => void handleRemove(cred.id)}
              testId="settings-passkeys-remove"
            />
          </li>
        ))}
        {credentials !== null && credentials.length === 0 ? (
          <li className="text-sm text-text-muted" data-testid="settings-passkeys-empty">
            No passkeys yet.
          </li>
        ) : null}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        <input
          className={inputClass}
          value={name}
          maxLength={64}
          placeholder="Name (e.g. MacBook Touch ID)"
          onChange={(e) => setName(e.target.value)}
          data-testid="settings-passkeys-name-input"
        />
        <button
          type="button"
          className={subtleButtonClass + ' self-start'}
          disabled={enrolling}
          onClick={() => void handleEnroll()}
          data-testid="settings-passkeys-add"
        >
          {enrolling ? 'Waiting for your passkey…' : 'Add a passkey'}
        </button>
      </div>

      {enrollError ? (
        <p role="alert" className="text-sm text-danger" data-testid="settings-passkeys-error">
          {enrollError}
        </p>
      ) : null}
      {removeError ? (
        <p role="alert" className="text-sm text-danger" data-testid="settings-passkeys-remove-error">
          {removeError}
        </p>
      ) : null}
    </section>
  );
}
