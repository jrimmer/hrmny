/**
 * @cytale/web — AccountSection, the gear surface's "My Account" section.
 *
 * Discord's My Account + Sessions, carried only as far as the server
 * substrate honestly supports (audited 2026-09-06):
 *
 *   - Identity rows (username / email / verified / member-since) are real
 *     reads of GET /users/@me; username and email are read-only (no
 *     change-email endpoint exists — nothing fakes editability).
 *   - display_name + avatar_url are the TWO fields PATCH /users/@me accepts.
 *   - "Password" is the reset-email flow (no authenticated change-password
 *     endpoint exists; the reset path does, and completing it revokes every
 *     session — the same protective posture).
 *   - Sessions: refresh tokens store only hash + expiry (no per-device
 *     metadata), so there is no device LIST to fake — the real action is
 *     DELETE /users/@me/sessions (sign out everywhere, this device
 *     included).
 *   - Danger zone: DELETE /account (async soft-delete cascade).
 *
 * Destructive actions use inline two-step confirms (the integrations
 * surface's InlineConfirm pattern) — never window.confirm.
 */

import { useCallback, useEffect, useState } from 'react';

import type { CurrentUser, WebauthnCredential } from '@cytale/api-client';

import { formatShortDate } from '../../app/ui/time.js';
import { Avatar } from '../../app/ui/UserAvatar.js';
import { ImageCropDialog } from '../media/ImageCropDialog.js';
import { PasskeysSection } from './PasskeysSection.js';
import { TwoFactorSection, type TwoFactorSectionProps } from './TwoFactorSection.js';

export interface AccountSectionProps {
  user: CurrentUser | null;
  onSaveProfile(patch: { display_name?: string; avatar_url?: string | null }): Promise<void>;
  /** Avatar upload (POST /users/@me/avatar): 2 MB raster images; the
   *  server sets avatar_url atomically with the upload. */
  onUploadAvatar(file: File): Promise<void>;
  onResendVerification(): Promise<void>;
  onSendPasswordReset(email: string): Promise<void>;
  onSignOutEverywhere(): Promise<void>;
  onDeleteAccount(): Promise<void>;
  /** #36: the passkeys block's API callbacks. `null` (or absent) hides the
   *  section — the honest rendering of a server without the surface. */
  passkeys?: {
    onEnroll(name: string): Promise<WebauthnCredential>;
    onRemove(id: string): Promise<void>;
    onList(): Promise<WebauthnCredential[]>;
  } | null;
  /** #127: the TOTP block's API callbacks. The section self-hides while the
   *  server's switch is off (the mode rides the status read); `null` (or
   *  absent) hides it before any read. */
  twoFactor?: TwoFactorSectionProps | null;
}

const inputClass =
  'min-h-10 w-full rounded-md border border-line bg-surface-strong px-3 py-2 text-sm text-text placeholder:text-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]';

const saveButtonClass =
  'min-h-10 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-text-onaccent transition-[filter] duration-[var(--duration-control)] hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] disabled:cursor-not-allowed disabled:opacity-50';

const subtleButtonClass =
  'min-h-9 rounded-md border border-line bg-surface-strong px-3 py-1.5 text-sm font-medium text-text transition-colors duration-[var(--duration-control)] hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] disabled:cursor-not-allowed disabled:opacity-50';

/* Confirm-required danger ACTION (/40 + fill + semibold); passive danger
   NOTES are /30 — the split is documented in StateBanner.tsx. */
const dangerButtonClass =
  'min-h-9 rounded-md border border-danger/40 bg-danger/10 px-3 py-1.5 text-sm font-semibold text-danger transition-colors duration-[var(--duration-control)] hover:bg-danger/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] disabled:cursor-not-allowed disabled:opacity-50';

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-bold uppercase tracking-wide text-text-muted">{label}</span>
      {children}
      {hint ? <span className="text-xs text-text-muted">{hint}</span> : null}
    </label>
  );
}

export function AccountSection({
  user,
  onSaveProfile,
  onUploadAvatar,
  onResendVerification,
  onSendPasswordReset,
  onSignOutEverywhere,
  onDeleteAccount,
  passkeys = null,
  twoFactor = null,
}: AccountSectionProps) {
  // -- profile form ----------------------------------------------------------
  const [displayName, setDisplayName] = useState(user?.display_name ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Re-seed the draft when the underlying user changes (post-save refresh).
  useEffect(() => {
    setDisplayName(user?.display_name ?? '');
  }, [user?.display_name]);

  const dirty = displayName !== (user?.display_name ?? '');

  // The confirmation flash keys on the locally-accepted snapshot (not on the
  // parent refreshing `user`) — it clears as soon as the draft diverges
  // from what was saved.
  const savedVisible = saved != null && !saveError && saved === displayName;

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      // display_name only — the avatar is upload/remove-only (below).
      await onSaveProfile({ display_name: displayName });
      setSaved(displayName);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  // -- avatar upload ---------------------------------------------------------
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const handleUpload = async (file: File) => {
    setUploading(true);
    setUploadError(null);
    try {
      await onUploadAvatar(file);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Could not upload. Please try again.');
    } finally {
      setUploading(false);
    }
  };

  // #48: picking stages into the crop dialog — nothing uploads until
  // Confirm exports the cropped square (cancel discards, no network).
  const [cropFile, setCropFile] = useState<File | null>(null);
  const handleCropConfirm = useCallback(async (blob: Blob, filename: string) => {
    setCropFile(null);
    await handleUpload(new File([blob], filename, { type: 'image/png' }));
  }, []);

  const handleRemoveAvatar = async () => {
    setUploading(true);
    setUploadError(null);
    try {
      // Explicit empty string clears server-side (PATCH semantics).
      await onSaveProfile({ avatar_url: '' });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Could not remove. Please try again.');
    } finally {
      setUploading(false);
    }
  };

  // -- verification ----------------------------------------------------------
  const [verificationSent, setVerificationSent] = useState(false);
  const handleResend = async () => {
    await onResendVerification();
    setVerificationSent(true);
  };

  // -- password reset --------------------------------------------------------
  const [resetSent, setResetSent] = useState(false);
  const handleReset = async () => {
    if (!user?.email) return;
    await onSendPasswordReset(user.email);
    setResetSent(true);
  };

  // -- destructive confirms --------------------------------------------------
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const handleSignOutEverywhere = async () => {
    setSigningOut(true);
    try {
      await onSignOutEverywhere();
    } finally {
      setSigningOut(false);
      setConfirmSignOut(false);
    }
  };

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const handleDelete = async () => {
    setDeleting(true);
    try {
      await onDeleteAccount();
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  // The wire field is the `email_verified` boolean (@me never sends the
  // timestamp the legacy type names); the fallback covers seed shapes.
  const verified = user?.email_verified ?? (user?.email_verified_at != null);

  return (
    <div className="flex flex-col gap-8" data-testid="settings-account">
      {/* Identity card */}
      <section aria-label="Account identity" className="rounded-lg border border-line bg-surface p-4">
        <div className="flex items-center gap-4">
          <Avatar
            id={user?.id ?? user?.username ?? '?'}
            name={user?.display_name || user?.username || '?'}
            src={user?.avatar_url}
            size={64}
          />
          <div className="min-w-0">
            <p className="truncate text-lg font-semibold text-text-primary">
              {user?.display_name || user?.username || '…'}
            </p>
            <p className="truncate text-sm text-text-muted">@{user?.username ?? '…'}</p>
          </div>
        </div>

        <dl className="mt-4">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line py-3">
            <dt className="text-sm font-medium text-text">Username</dt>
            <dd className="text-sm text-text-muted" data-testid="account-username">
              {user?.username ?? '…'}
            </dd>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line py-3">
            <dt className="text-sm font-medium text-text">Email</dt>
            <dd className="flex items-center gap-2 text-sm text-text-muted">
              <span data-testid="account-email">{user?.email ?? '…'}</span>
              {verified ? (
                <span
                  className="rounded-full border border-line bg-surface-strong px-2 py-0.5 text-xs text-text-muted"
                  data-testid="account-verified"
                >
                  Verified
                </span>
              ) : (
                <span
                  className="flex items-center gap-2 rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-xs text-warning"
                  data-testid="account-unverified"
                >
                  Unverified
                  {verificationSent ? (
                    <span>Email sent — check your inbox.</span>
                  ) : (
                    <button
                      type="button"
                      className="font-semibold underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
                      data-testid="account-resend-verification"
                      onClick={handleResend}
                    >
                      Resend email
                    </button>
                  )}
                </span>
              )}
            </dd>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 py-3">
            <dt className="text-sm font-medium text-text">Member since</dt>
            <dd className="text-sm text-text-muted" data-testid="account-created">
              {user?.created_at ? formatShortDate(user.created_at) : '…'}
            </dd>
          </div>
        </dl>
      </section>

      {/* Profile form — the two editable fields */}
      <section aria-label="Profile" className="flex flex-col gap-4">
        <h2 className="text-sm font-bold uppercase tracking-wide text-text-muted">Profile</h2>
        <Field label="Display name" hint="Shown instead of your username where Hrmny displays you.">
          <input
            className={inputClass}
            value={displayName}
            maxLength={100}
            placeholder={user?.username ?? ''}
            onChange={(e) => setDisplayName(e.target.value)}
            data-testid="account-display-name"
          />
        </Field>
        <Field
          label="Avatar"
          hint="PNG, JPEG, GIF, or WebP up to 2 MB. Shown everywhere your messages and profile appear."
        >
          <div className="flex items-center gap-4">
            <Avatar
              id={user?.id ?? '?'}
              name={user?.display_name || user?.username || '?'}
              src={user?.avatar_url}
              size={64}
              data-testid="account-avatar-preview"
            />
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className={subtleButtonClass}
                disabled={uploading}
                data-testid="account-avatar-upload"
                onClick={() => document.getElementById('account-avatar-input')?.click()}
              >
                {uploading ? 'Uploading…' : 'Upload Image'}
              </button>
              {user?.avatar_url ? (
                <button
                  type="button"
                  className={subtleButtonClass}
                  disabled={uploading}
                  data-testid="account-avatar-remove"
                  onClick={handleRemoveAvatar}
                >
                  Remove
                </button>
              ) : null}
              {/* Hidden picker — the visible button keeps keyboard/AT reach. */}
              <input
                id="account-avatar-input"
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                className="hidden"
                data-testid="account-avatar-input"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  // Reset so re-picking the same file re-fires change.
                  e.target.value = '';
                  if (file) setCropFile(file);
                }}
              />
            </div>
          </div>
        </Field>

        {uploadError ? (
          <p role="alert" className="text-sm text-danger" data-testid="account-avatar-error">
            {uploadError}
          </p>
        ) : null}

        {saveError ? (
          <p role="alert" className="text-sm text-danger" data-testid="account-save-error">
            {saveError}
          </p>
        ) : null}

        <div className="flex items-center gap-3">
          <button
            type="button"
            className={saveButtonClass}
            disabled={!dirty || saving}
            data-testid="account-save"
            onClick={handleSave}
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
          {savedVisible ? (
            <p role="status" className="text-sm text-text-muted" data-testid="account-saved">
              Saved.
            </p>
          ) : null}
        </div>
      </section>

      {/* Password */}
      <section aria-label="Password" className="flex flex-col gap-3">
        <h2 className="text-sm font-bold uppercase tracking-wide text-text-muted">Password</h2>
        <p className="text-sm text-text-muted">
          Password changes ride the reset flow: we email a link to your address, and completing it
          signs out every device.
        </p>
        {resetSent ? (
          <p role="status" className="text-sm text-text" data-testid="account-reset-sent">
            Reset link sent — check your inbox.
          </p>
        ) : (
          <button
            type="button"
            className={subtleButtonClass + ' self-start'}
            disabled={!user?.email}
            data-testid="account-send-reset"
            onClick={handleReset}
          >
            Send password reset email
          </button>
        )}
      </section>

      {/* Two-factor (#127) — the TOTP enrollment/status/removal block. The
          section reads the server switch itself (mode off = absent) and sits
          beside the password block it protects. */}
      {twoFactor ? (
        <TwoFactorSection
          onStatus={twoFactor.onStatus}
          onEnrollStart={twoFactor.onEnrollStart}
          onEnrollConfirm={twoFactor.onEnrollConfirm}
          onRemove={twoFactor.onRemove}
        />
      ) : null}

      {/* Passkeys (#36) — additive login credentials; hidden when the server
          does not offer the surface (passkeys === null). */}
      {passkeys ? <PasskeysSection onEnroll={passkeys.onEnroll} onRemove={passkeys.onRemove} onList={passkeys.onList} /> : null}

      {/* Sessions */}
      <section aria-label="Sessions" className="flex flex-col gap-3">
        <h2 className="text-sm font-bold uppercase tracking-wide text-text-muted">Sessions</h2>
        <p className="text-sm text-text-muted">
          You are signed in here. Sessions are 30-day rotating refresh tokens — signing out
          everywhere revokes all of them, including this one, and closes live connections.
        </p>
        {confirmSignOut ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 rounded-md border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning"
            data-testid="account-signout-confirm"
          >
            <span>Sign out on every device, including this one?</span>
            <span className="flex gap-2">
              <button
                type="button"
                className={subtleButtonClass}
                onClick={() => setConfirmSignOut(false)}
                data-testid="account-signout-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                className="min-h-9 rounded-md bg-warning px-3 py-1.5 font-semibold text-surface-strong transition-[filter] duration-[var(--duration-control)] hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] disabled:cursor-not-allowed disabled:opacity-50"
                disabled={signingOut}
                onClick={handleSignOutEverywhere}
                data-testid="account-signout-confirm-yes"
              >
                {signingOut ? 'Signing out…' : 'Sign out everywhere'}
              </button>
            </span>
          </div>
        ) : (
          <button
            type="button"
            className={subtleButtonClass + ' self-start'}
            data-testid="account-signout-everywhere"
            onClick={() => setConfirmSignOut(true)}
          >
            Sign out everywhere
          </button>
        )}
      </section>

      {/* Danger zone */}
      <section aria-label="Danger zone" className="flex flex-col gap-3">
        <h2 className="text-sm font-bold uppercase tracking-wide text-text-muted">Danger zone</h2>
        <p className="text-sm text-text-muted">
          Deleting your account tombstones your identity and sweeps your content asynchronously.
          This cannot be undone.
        </p>
        {confirmDelete ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 rounded-md border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger"
            data-testid="account-delete-confirm"
          >
            <span>Delete your account permanently?</span>
            <span className="flex gap-2">
              <button
                type="button"
                className={subtleButtonClass}
                onClick={() => setConfirmDelete(false)}
                data-testid="account-delete-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                className={dangerButtonClass}
                disabled={deleting}
                onClick={handleDelete}
                data-testid="account-delete-confirm-yes"
              >
                {deleting ? 'Deleting…' : 'Yes, delete my account'}
              </button>
            </span>
          </div>
        ) : (
          <button
            type="button"
            className={dangerButtonClass + ' self-start'}
            data-testid="account-delete"
            onClick={() => setConfirmDelete(true)}
          >
            Delete account
          </button>
        )}
      </section>
    
      {cropFile ? (
        <ImageCropDialog
          file={cropFile}
          mask="circle"
          title="Position your avatar"
          onConfirm={(blob, filename) => void handleCropConfirm(blob, filename)}
          onCancel={() => setCropFile(null)}
        />
      ) : null}
    </div>
  );
}
