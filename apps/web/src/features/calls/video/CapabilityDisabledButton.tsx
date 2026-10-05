/**
 * @cytale/web — the visible-disabled capability affordance (calls V2 plan
 * U5, ratified VM10; shared with U6's desktop handoff and U8's
 * capability-off gates).
 *
 * The "no UI surprises" pattern: where a capability (screenshare on mobile,
 * screenshare in an incapable webview, a disabled workspace/channel media
 * setting) is unavailable, its affordance RENDERS — visibly disabled — and
 * activating it explains the gap in a dialog instead of silently doing
 * nothing or disappearing. Nothing appears or disappears by platform.
 *
 * Implementation notes:
 *   - The trigger is a REAL, focusable button carrying `aria-disabled` (not
 *     the native `disabled` attribute, which would drop it from the tab
 *     order and swallow the click — the explanation IS the action).
 *   - The dialog is the house Radix Dialog (modal-overlay/modal-panel
 *     tokens); Radix returns focus to the trigger on close.
 *   - Default copy is the mobile screenshare case (VM10's own words); the
 *     desktop handoff (U6) overrides title/body/action via props.
 */

import { useRef, useState, type ReactNode } from 'react';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from '../../../components/shadcn/dialog.js';

const ICON_BUTTON =
  'flex h-10 min-w-10 items-center justify-center gap-1.5 rounded-md px-2 text-sm font-medium ' +
  'transition-colors duration-[var(--duration-control)] hover:bg-surface-hover ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]';

/** VM10's ratified copy (mobile screenshare) — the component defaults. */
export const CAPABILITY_DISABLED_DEFAULTS = {
  buttonLabel: 'Share your screen',
  dialogTitle: 'Screen sharing isn\u2019t available',
  dialogBody:
    'Screen sharing isn\u2019t available on this platform. You can still watch shared screens \u2014 ' +
    'to share your own, join the call from the desktop or web app.',
  actionLabel: null,
} as const;

export interface CapabilityDisabledButtonProps {
  /** Accessible name of the affordance ("Share your screen"). */
  label: string;
  /** The affordance's glyph (aria-hidden by the caller's icon). */
  icon: ReactNode;
  /** Dialog heading; defaults to the VM10 screenshare copy. */
  dialogTitle?: string;
  /** Dialog explanation; defaults to the VM10 screenshare copy. */
  dialogBody?: string;
  /** Optional dialog action (U6's "Open the web app" handoff). */
  actionLabel?: string;
  /** Invoked when the dialog's action button is activated. */
  onAction?: () => void;
  /** Stable testid suffix (the owning surface — 'panel' | 'dm' | ...). */
  context: string;
}

export function CapabilityDisabledButton({
  label,
  icon,
  dialogTitle = CAPABILITY_DISABLED_DEFAULTS.dialogTitle,
  dialogBody = CAPABILITY_DISABLED_DEFAULTS.dialogBody,
  actionLabel,
  onAction,
  context,
}: CapabilityDisabledButtonProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className={ICON_BUTTON + ' capability-disabled-btn text-text-muted'}
        aria-disabled="true"
        aria-label={label}
        data-testid={`capability-disabled-${context}`}
        onClick={() => setOpen(true)}
      >
        <span aria-hidden>{icon}</span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        {/* showCloseButton={false}: the house ✕ below keeps its own styling;
            the wrapper's default close would duplicate it. */}
        <DialogContent
            className="modal-panel"
            showCloseButton={false}
            aria-describedby={undefined}
            data-testid={`capability-disabled-dialog-${context}`}
            onCloseAutoFocus={(event) => {
              // UX_SPEC §6: return focus to the trigger on close. Radix's
              // default return is not observable in jsdom; explicit is also
              // deterministic in real browsers.
              event.preventDefault();
              triggerRef.current?.focus();
            }}
          >
            <DialogTitle className="modal-title">{dialogTitle}</DialogTitle>
            <DialogClose className="modal-close" aria-label="Close">
              ✕
            </DialogClose>
            <p className="modal-explainer">{dialogBody}</p>
            <div className="modal-actions">
              {actionLabel ? (
                <button
                  type="button"
                  className="modal-btn-primary"
                  data-testid={`capability-disabled-action-${context}`}
                  onClick={() => {
                    setOpen(false);
                    onAction?.();
                  }}
                >
                  {actionLabel}
                </button>
              ) : null}
              <DialogClose asChild>
                <button
                  type="button"
                  className="modal-btn-secondary"
                  data-testid={`capability-disabled-dismiss-${context}`}
                >
                  Got it
                </button>
              </DialogClose>
            </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
