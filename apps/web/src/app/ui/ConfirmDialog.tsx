/**
 * @cytale/web — ConfirmDialog: the app-styled confirm/alert.
 *
 * Native browser dialogs (window.confirm / alert / prompt) are banned across
 * the app — they ignore the theme, block the event loop, and are suppressed
 * or unstylable on some platforms (iOS suppresses window.prompt outright).
 * This is the one replacement: the same modal shell the house dialogs use
 * (modal-overlay / modal-panel / modal-actions), focus-trapped by Radix,
 * Escape = cancel.
 *
 * Shape: a cancel + confirm pair, or an ALERT (cancelLabel={null}) with a
 * single dismiss button. Destructive confirms tint the primary danger.
 */
import type { ReactNode } from 'react';

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from '../../components/shadcn/dialog.js';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Body copy (a sentence or richer nodes). */
  body?: ReactNode;
  confirmLabel?: string;
  /** null renders the ALERT shape: one dismiss button, no cancel. */
  cancelLabel?: string | null;
  /** Tint the primary button destructive. */
  danger?: boolean;
  /** Disable both actions while the confirm action is in flight. */
  pending?: boolean;
  onConfirm: () => void;
  testId?: string;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  pending = false,
  onConfirm,
  testId = 'confirm-dialog',
}: ConfirmDialogProps) {
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
        data-testid={testId}
      >
          <DialogTitle className="modal-title">{title}</DialogTitle>
          <DialogClose className="modal-close" aria-label="Close" disabled={pending}>
            ✕
          </DialogClose>

          {body !== undefined ? (
            <p className="m-0 text-sm text-text" data-testid={`${testId}-body`}>
              {body}
            </p>
          ) : null}

          <div className="modal-actions">
            {cancelLabel !== null ? (
              <DialogClose asChild>
                <button
                  type="button"
                  className="modal-btn-secondary"
                  data-testid={`${testId}-cancel`}
                  disabled={pending}
                >
                  {cancelLabel}
                </button>
              </DialogClose>
            ) : null}
            <button
              type="button"
              className={danger ? 'modal-btn-danger' : 'modal-btn-primary'}
              data-testid={`${testId}-confirm`}
              disabled={pending}
              onClick={onConfirm}
            >
              {confirmLabel}
            </button>
          </div>
      </DialogContent>
    </Dialog>
  );
}
