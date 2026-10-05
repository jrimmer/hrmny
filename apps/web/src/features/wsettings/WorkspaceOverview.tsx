/**
 * @cytale/web — WorkspaceOverview, the workspace settings surface's single
 * Overview section: workspace image + name.
 *
 * Admin-scoped controls (the MANAGE_WORKSPACE tier — owner at launch) are
 * visible-disabled for non-admins with the reason on the control (the
 * no-UI-surprises doctrine); the server enforces the real gate either way.
 * The image rides the same upload contract as avatars (2 MB raster-only,
 * atomic set-with-upload); clearing goes through the rename PATCH's
 * explicit icon_url clear.
 */

import { useCallback, useEffect, useState } from 'react';

import type { Workspace } from '@cytale/domain';

import { Avatar } from '../../app/ui/UserAvatar.js';
import { ImageCropDialog } from '../media/ImageCropDialog.js';

export interface WorkspaceOverviewProps {
  workspace: Workspace | null;
  /** True when the viewer holds the workspace admin tier (owner at launch). */
  isAdmin: boolean;
  onUploadIcon(file: File): Promise<void>;
  onRename(name: string): Promise<void>;
  onRemoveIcon(): Promise<void>;
}

const inputClass =
  'min-h-10 w-full rounded-md border border-line bg-surface-strong px-3 py-2 text-sm text-text placeholder:text-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] disabled:cursor-not-allowed disabled:opacity-50';

const buttonClass =
  'min-h-9 rounded-md border border-line bg-surface-strong px-3 py-1.5 text-sm font-medium text-text transition-colors duration-[var(--duration-control)] hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] disabled:cursor-not-allowed disabled:opacity-50';

const saveButtonClass =
  'min-h-10 self-start rounded-md bg-accent px-4 py-2 text-sm font-semibold text-text-onaccent transition-[filter] duration-[var(--duration-control)] hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] disabled:cursor-not-allowed disabled:opacity-50';

export function WorkspaceOverview({
  workspace,
  isAdmin,
  onUploadIcon,
  onRename,
  onRemoveIcon,
}: WorkspaceOverviewProps) {
  const [name, setName] = useState(workspace?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  // Re-seed the draft when the underlying workspace changes (post-save).
  useEffect(() => {
    setName(workspace?.name ?? '');
  }, [workspace?.name]);

  const dirty = name !== (workspace?.name ?? '');

  const handleSave = async () => {
    setBusy(true);
    setError(null);
    try {
      await onRename(name);
      setSaved(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const handleUpload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      await onUploadIcon(file);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not upload. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  // #48: picking stages into the crop dialog — nothing uploads until
  // Confirm exports the cropped square (cancel discards, no network).
  const [cropFile, setCropFile] = useState<File | null>(null);
  const handleCropConfirm = useCallback(async (blob: Blob, filename: string) => {
    setCropFile(null);
    await handleUpload(new File([blob], filename, { type: 'image/png' }));
  }, []);

  const handleRemove = async () => {
    setBusy(true);
    setError(null);
    try {
      await onRemoveIcon();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  if (!workspace) {
    return (
      <p role="status" className="text-sm text-text-muted" data-testid="wsettings-loading">
        Loading workspace…
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-8" data-testid="wsettings-overview">
      <section aria-label="Workspace image" className="flex flex-col gap-4">
        <h2 className="text-sm font-bold uppercase tracking-wide text-text-muted">
          Workspace image
        </h2>
        <div className="flex items-center gap-4">
          <Avatar
            id={workspace.id}
            name={workspace.name}
            src={workspace.icon_url}
            size={64}
            // The rail's tile is one character (WorkspaceSwitcher RailIcon);
            // the preview of it shows the same one, not the two a person gets.
            maxInitials={1}
            className="workspace-icon-avatar"
            data-testid="wsettings-icon-preview"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={buttonClass}
              disabled={!isAdmin || busy}
              title={isAdmin ? undefined : 'Only workspace admins can change the image.'}
              data-testid="wsettings-icon-upload"
              onClick={() => document.getElementById('wsettings-icon-input')?.click()}
            >
              {busy ? 'Working…' : 'Upload Image'}
            </button>
            {workspace.icon_url ? (
              <button
                type="button"
                className={buttonClass}
                disabled={!isAdmin || busy}
                title={isAdmin ? undefined : 'Only workspace admins can change the image.'}
                data-testid="wsettings-icon-remove"
                onClick={handleRemove}
              >
                Remove
              </button>
            ) : null}
            {/* Hidden picker — the visible button keeps keyboard/AT reach. */}
            <input
              id="wsettings-icon-input"
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              className="hidden"
              data-testid="wsettings-icon-input"
              disabled={!isAdmin}
              onChange={(e) => {
                const file = e.target.files?.[0];
                // Reset so re-picking the same file re-fires change.
                e.target.value = '';
                if (file) setCropFile(file);
              }}
            />
          </div>
        </div>
        <p className="text-xs text-text-muted">
          PNG, JPEG, GIF, or WebP up to 2 MB. Shown on the workspace switcher and home.
        </p>
      </section>

      <section aria-label="Workspace name" className="flex flex-col gap-4">
        <h2 className="text-sm font-bold uppercase tracking-wide text-text-muted">
          Workspace name
        </h2>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-bold uppercase tracking-wide text-text-muted">Name</span>
          <input
            className={inputClass}
            value={name}
            maxLength={100}
            disabled={!isAdmin}
            title={isAdmin ? undefined : 'Only workspace admins can rename.'}
            onChange={(e) => setName(e.target.value)}
            data-testid="wsettings-name-input"
          />
        </label>

        {error ? (
          <p role="alert" className="text-sm text-danger" data-testid="wsettings-error">
            {error}
          </p>
        ) : null}

        <div className="flex items-center gap-3">
          <button
            type="button"
            className={saveButtonClass}
            disabled={!isAdmin || !dirty || busy || name.trim().length < 2}
            data-testid="wsettings-name-save"
            onClick={handleSave}
          >
            Save changes
          </button>
          {saved != null && !error && saved === name ? (
            <p role="status" className="text-sm text-text-muted" data-testid="wsettings-saved">
              Saved.
            </p>
          ) : null}
        </div>
      </section>
    
      {cropFile ? (
        <ImageCropDialog
          file={cropFile}
          mask="rounded"
          title="Position the workspace image"
          onConfirm={(blob, filename) => void handleCropConfirm(blob, filename)}
          onCancel={() => setCropFile(null)}
        />
      ) : null}
    </div>
  );
}
