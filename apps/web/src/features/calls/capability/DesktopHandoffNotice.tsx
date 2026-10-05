/**
 * @cytale/web — displaced-leg notice for the desktop handoff (calls V2
 * plan U6; R12: "The displaced desktop leg shows 'call continued in your
 * browser'").
 *
 * After the user opens the web app and joins from the browser, AM8
 * one-leg displacement fires against the desktop leg (voiceState's
 * `displaced` notice — the same machinery V1 built for phone-to-desktop).
 * The wiring unit renders THIS variant instead of the stock
 * "You joined this call on another device." whenever
 * `isHandoffInitiated()` is true: the user chose the browser, and the
 * honest copy says so. Markup mirrors CallPanel's displaced notice
 * (role=status, dismissible) so the surfaces read identically.
 */

import { DISPLACED_VIA_HANDOFF_NOTICE } from './copy.js';

const ICON_BUTTON =
  'ml-2 rounded-md px-2 text-sm font-medium ' +
  'transition-colors duration-[var(--duration-control)] hover:bg-surface-hover ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]';

export interface DesktopHandoffNoticeProps {
  /** Clears the notice (the wiring unit's dismiss, like CallPanel's OK). */
  onDismiss: () => void;
}

export function DesktopHandoffNotice({ onDismiss }: DesktopHandoffNoticeProps) {
  return (
    <div
      className="rounded-md border border-line bg-surface-hover px-3 py-2 text-sm text-text-muted"
      role="status"
      data-testid="desktop-handoff-notice"
    >
      {DISPLACED_VIA_HANDOFF_NOTICE}
      <button
        type="button"
        className={ICON_BUTTON + ' text-text-primary'}
        data-testid="desktop-handoff-notice-dismiss"
        onClick={onDismiss}
      >
        OK
      </button>
    </div>
  );
}
