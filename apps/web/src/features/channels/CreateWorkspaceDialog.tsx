/**
 * @cytale/web — Create Workspace dialog (Discord parity).
 *
 * Discord's "Create My Own" flow for a fresh install: with no workspace
 * active, the server-header menu and the ＋ action both land here. The
 * server enforces a 2–100 byte name and seats the creator as the owner
 * member, so the client mirrors that rule for inline validation.
 */

import { useEffect, useState } from 'react';

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from '../../components/shadcn/dialog.js';

import type { Workspace } from '@cytale/domain';

import { dialogErrorMessage } from './dialogError.js';

export interface CreateWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Creates the workspace; the caller stores + selects it. */
  onCreateWorkspace: (input: { name: string }) => Promise<Workspace>;
}

export function CreateWorkspaceDialog({
  open,
  onOpenChange,
  onCreateWorkspace,
}: CreateWorkspaceDialogProps) {
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fresh form every time the dialog opens.
  useEffect(() => {
    if (open) {
      setName('');
      setPending(false);
      setError(null);
    }
  }, [open]);

  const submit = async () => {
    const trimmed = name.trim();
    if (trimmed.length < 2 || trimmed.length > 100) {
      setError('Workspace name must be 2-100 characters.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onCreateWorkspace({ name: trimmed });
      onOpenChange(false);
    } catch (err) {
      setError(
        dialogErrorMessage(err, "You can't create this workspace.", 'Could not create the workspace. Try again.'),
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!pending) onOpenChange(o);
      }}
    >
      {/* showCloseButton={false}: the house ✕ below keeps its own styling
          and pending-disable; the wrapper's default close would duplicate. */}
      <DialogContent
        className="modal-panel"
        showCloseButton={false}
        aria-describedby={undefined}
        data-testid="create-workspace-dialog"
      >
          <DialogTitle className="modal-title">Create Workspace</DialogTitle>
          <DialogClose className="modal-close" aria-label="Close" disabled={pending}>
            ✕
          </DialogClose>
          <p className="modal-explainer">
            Your workspace is where your team's channels and conversations live.
          </p>

          <label className="modal-label" htmlFor="create-workspace-name-input">
            Workspace name
          </label>
          <input
            id="create-workspace-name-input"
            data-testid="create-workspace-name"
            className="modal-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Team"
            maxLength={100}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void submit();
              }
            }}
          />

          {error ? (
            <p role="alert" data-testid="create-workspace-error" className="modal-error">
              {error}
            </p>
          ) : null}

          <div className="modal-actions">
            <DialogClose asChild>
              <button
                type="button"
                className="modal-btn-secondary"
                data-testid="create-workspace-cancel"
                disabled={pending}
              >
                Cancel
              </button>
            </DialogClose>
            <button
              type="button"
              className="modal-btn-primary"
              data-testid="create-workspace-submit"
              disabled={pending}
              onClick={() => void submit()}
            >
              {pending ? 'Creating…' : 'Create Workspace'}
            </button>
          </div>
      </DialogContent>
    </Dialog>
  );
}
