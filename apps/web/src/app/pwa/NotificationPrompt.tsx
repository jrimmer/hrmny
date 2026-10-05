/**
 * @cytale/web — the in-app invitation to turn web push on.
 *
 * ## Why this is a banner and not a browser prompt on load
 *
 * A page CANNOT open the permission dialog by itself. Browsers require a user
 * gesture, and Chrome treats a site that asks without one as hostile — it
 * suppresses the prompt, and repeat offences can get the site blocked from
 * asking ever again. So "the site should prompt" is honestly implemented as an
 * in-app invitation whose button click supplies the gesture, which is also the
 * only shape that lets us explain WHY before the browser's own dialog appears.
 *
 * ## It asks once
 *
 * Three states suppress it entirely, and each is a promise rather than a
 * preference:
 *
 *   * permission already granted — nothing to ask;
 *   * permission DENIED — the member answered, and re-asking is exactly what
 *     browsers punish. The settings surface is where a member who changes
 *     their mind goes;
 *   * dismissed — recorded, so a render or a reload does not bring it back.
 *
 * A platform that cannot deliver (iOS without the app installed) is also
 * silent, because there is no action to offer and an invitation to something
 * impossible is worse than saying nothing.
 *
 * ## Placement
 *
 * Top-centered, and `role="status"` — it is an invitation, not an
 * interruption, so it must not seize a screen reader mid-task the way
 * `role="alert"` would.
 *
 * It OVERLAYS the shell rather than displacing it. Making it a real banner
 * that pushes the content down is a layout change, not a restyle — it has to
 * compose with the topbar, the thread pane, and the responsive column stack —
 * and is tracked separately.
 */

import { useEffect, useState } from 'react';

import { canDeliverNotifications } from '../../features/settings/notificationPermission.js';

/** Where a dismissal is remembered. Per browser, like every client-local pref. */
export const NOTIFICATION_PROMPT_KEY = 'cytale.notification-prompt';

export interface NotificationPromptProps {
  /** The browser's current permission, or 'unknown' where there is none. */
  permission: NotificationPermission | 'unknown';
  /** Whether this surface can deliver at all. Injectable for tests. */
  deliverable?: boolean;
  /**
   * Turn notifications on. Resolves on success, REJECTS on failure — a throw
   * is reported and deliberately NOT recorded as a decision, because the
   * member asked for notifications and did not get them.
   */
  onEnable?: () => Promise<void>;
}

function wasDismissed(): boolean {
  try {
    return localStorage.getItem(NOTIFICATION_PROMPT_KEY) === '1';
  } catch {
    // Storage unavailable: treat as dismissed rather than re-asking on every
    // render. Erring toward silence is the right direction for an invitation.
    return true;
  }
}

/**
 * Clear a recorded dismissal, so the invitation can appear again.
 *
 * The route back for a member who clicked "Not now" by accident. Without it
 * the only way to see the invitation again is clearing browser storage by
 * hand — which no member will do, and which would take their session with it.
 */
export function clearPromptDismissal(): void {
  try {
    localStorage.removeItem(NOTIFICATION_PROMPT_KEY);
  } catch {
    // Storage unavailable; nothing was recorded to clear.
  }
}

function rememberDismissal(): void {
  try {
    localStorage.setItem(NOTIFICATION_PROMPT_KEY, '1');
  } catch {
    // Storage unavailable — it will reappear next session, which is a lesser
    // problem than failing to record the member's answer.
  }
}

export function NotificationPrompt({
  permission,
  deliverable = canDeliverNotifications(),
  onEnable,
}: NotificationPromptProps) {
  const [dismissed, setDismissed] = useState(wasDismissed);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Permission can change under us (the member edits it in the browser's own
  // UI). Reading it on focus keeps this from asking for something already
  // granted, or re-asking after a refusal.
  const [current, setCurrent] = useState(permission);
  useEffect(() => setCurrent(permission), [permission]);

  const shouldShow =
    !dismissed && deliverable && current === 'default';

  if (!shouldShow) return null;

  const accept = async () => {
    if (!onEnable) return;
    setBusy(true);
    setError(null);

    try {
      await onEnable();
      // The permission dialog is now the member's to finish; either answer
      // lands on the settings surface, so this has done its job.
      setDismissed(true);
      rememberDismissal();
    } catch {
      // NOT recorded: they asked for notifications and did not get them, so
      // the invitation should still be there to try again.
      setError('Could not turn on notifications. You can try again from Settings.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="status"
      data-testid="notification-prompt"
      className="fixed inset-x-0 top-4 z-40 mx-auto flex w-[min(94vw,32rem)] flex-col gap-2 rounded-md border border-line bg-surface-strong px-4 py-3 shadow-lg"
    >
      <p className="text-sm text-text-primary">
        Get notified when someone messages you, even when Hrmny is in another tab.
      </p>

      {error ? (
        <p className="text-xs text-text-muted" data-testid="notification-prompt-error">
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void accept()}
          data-testid="notification-prompt-enable"
          className="min-h-9 rounded-md border border-accent bg-surface px-3 text-sm font-medium text-text-primary hover:bg-surface-strong disabled:opacity-60"
        >
          Turn on notifications
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setDismissed(true);
            rememberDismissal();
          }}
          data-testid="notification-prompt-dismiss"
          className="min-h-9 rounded-md px-3 text-sm text-text-muted hover:text-text-primary disabled:opacity-60"
        >
          Not now
        </button>
      </div>
    </div>
  );
}
