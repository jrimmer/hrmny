/**
 * @cytale/web — NotificationsSection, the gear surface's notifications hub.
 *
 * The whole point of this surface is LEGIBILITY, not configurability. Discord
 * computes a member's effective notification state across four or five layers
 * and never displays the resolved outcome, so the only way to know what will
 * reach you is to hold the whole cascade in your head — which is how members
 * end up with two settings that each look right and cancel each other
 * invisibly.
 *
 * So every row here shows the RESOLVED level and names the layer that decided
 * it. A row the member never touched still says what it resolves to and where
 * that came from, because "you haven't overridden this" is information, not an
 * empty cell.
 *
 * Delivery state is reported honestly rather than optimistically: a permission
 * the member refused, a platform that cannot deliver, and an installed-PWA
 * requirement all render as themselves. A control that cannot work is worse
 * than no control, and a member who believes they will be told — and is not —
 * is the exact failure this feature exists to remove.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { PaneErrorBanner, PaneSkeleton } from '../../app/ui/PaneStates.js';
import { webPushBlocker, type WebPushBlocker } from '../../app/pwa/index.js';
import type { NotificationTestResult } from '@cytale/api-client';

// The level vocabulary and the inheritance walk live in `notificationLevels.ts`
// (lane D #7): the notification-sound coordinator runs on every dispatch and
// imported them from here, which put this whole surface in the ENTRY chunk.
export {
  DEFAULT_LEVEL,
  overrideKey,
  resolveFromOverrides,
  type NotificationLevel,
  type NotificationRow,
  type NotificationScope,
  type ResolveInput,
} from './notificationLevels.js';
import {
  resolveFromOverrides,
  type NotificationLevel,
  type NotificationRow,
  type NotificationScope,
} from './notificationLevels.js';

/** A workspace row and the channel rows beneath it, in render order. */
export interface NotificationTree {
  /**
   * Rows that stand on their own: the account default, plus any row whose
   * parent is not in the list (a channel in a workspace the member has left
   * mid-session must still be editable rather than silently dropped).
   */
  roots: NotificationRow[];
  /** Channels by their parent workspace id, in the order they arrived. */
  childrenByParent: Map<string, NotificationRow[]>;
}

/**
 * Fold the flat row list into the tree the surface renders.
 *
 * The rows stay flat on the wire because the SERVER's list is the resolved
 * ladder, not a layout — grouping belongs to the surface that draws it. A
 * channel whose parent is absent is promoted to a root rather than dropped:
 * a row silently disappearing is indistinguishable from a setting that does
 * not exist, which is the failure mode this whole surface exists to remove.
 */
export function buildNotificationTree(rows: NotificationRow[]): NotificationTree {
  const ids = new Set(rows.map((r) => r.id));
  const roots: NotificationRow[] = [];
  const childrenByParent = new Map<string, NotificationRow[]>();

  for (const row of rows) {
    const parentId = row.scope === 'channel' ? row.parentId : undefined;
    if (parentId !== undefined && parentId !== row.id && ids.has(parentId)) {
      const siblings = childrenByParent.get(parentId);
      if (siblings) siblings.push(row);
      else childrenByParent.set(parentId, [row]);
      continue;
    }
    roots.push(row);
  }

  return { roots, childrenByParent };
}

/**
 * The one line a COLLAPSED workspace shows about the rows inside it: how many
 * channels it holds, and how many of those the member has actually set.
 *
 * This is the exception-based idea seeded early — a member should be able to
 * see WHERE their exceptions live without expanding every workspace, because
 * the alternative (expand nine workspaces to find the one channel you muted
 * last month) is exactly the "even a tree gets cumbersome over time" problem
 * the owner named.
 */
export function describeChildren(children: NotificationRow[]): string {
  const total = children.length;
  const set = children.filter((child) => child.overridden).length;
  const channels = `${total} channel${total === 1 ? '' : 's'}`;
  if (set === 0) return `${channels} · all following the workspace`;
  return `${channels} · ${set} set here`;
}

/** What the delivery channel will actually do here. */
export type DeliveryState =
  | 'enabled'
  | 'granted-not-enabled'
  | 'needs-permission'
  /**
   * The BROWSER is blocking notifications for this site. Distinct from a
   * platform block because there IS a way out — in the browser's own site
   * settings — and a surface that showed nothing here would leave the member
   * with no idea that one exists.
   */
  | 'browser-blocked'
  | 'blocked';

export interface NotificationsSectionProps {
  /** Loads the rows. Injected so the section never imports the API client. */
  load: () => Promise<NotificationRow[]>;
  /** Set a level for one row. */
  setLevel: (id: string, level: NotificationLevel) => Promise<void>;
  /**
   * Re-run `load` whenever the preferences change ANYWHERE (notification
   * controls, 2026-09-27): the header control, the channel and workspace
   * menus and this surface all write the one shared store, so an overview
   * left open while the member mutes a channel from its header must move with
   * it. Returns the unsubscribe. Absent = load once (the old contract).
   */
  subscribe?: (onChange: () => void) => () => void;
  /**
   * Flip a workspace row's "Suppress @everyone and @here" switch. Absent =
   * the switch is not offered. Rows carry the current value in
   * `suppressBroadcasts`.
   */
  setSuppressBroadcasts?: (id: string, suppress: boolean) => Promise<void>;
  /** Current browser/shell notification permission, when known. */
  permission?: NotificationPermission | 'unknown';
  /** Blocks delivery regardless of the member's choice. */
  blocker?: WebPushBlocker | null;
  /** Turn notifications on for this browser. Absent = no action offered. */
  onEnable?: () => Promise<void>;
  /** Turn them off. Absent = no action offered. */
  onDisable?: () => Promise<void>;
  /**
   * Bring the in-app invitation back, for a member who dismissed it and
   * changed their mind. Without this the only route back to it is manually
   * clearing browser storage — a thing no member will do.
   */
  onRestorePrompt?: () => void;
  /**
   * Fire a test notification at this member's own devices. Absent = the
   * button is not offered (the probe needs a transport, and a control that
   * cannot work is worse than no control).
   */
  onSendTest?: (message?: string) => Promise<NotificationTestResult>;
  /**
   * Whether THIS browser holds a live push subscription. The host probes it
   * (see `hasPushSubscription`); `undefined` means it did not, and the surface
   * falls back to reading permission alone.
   */
  subscribed?: boolean;
  /**
   * Whether this surface can deliver at all. Injected rather than probed
   * inside the component so the render is driven by its inputs — the probe
   * reads real globals (`serviceWorker`, `PushManager`), which makes an
   * un-injected component untestable in any environment that lacks them.
   * Defaults to `canDeliverNotifications()`, which is the real probe.
   */
  deliverable?: boolean;
}

// One vocabulary with the header control and the menus (2026-09-27).
import { LEVEL_LABEL } from './notificationLevels.js';

/**
 * The layer names, phrased so an override says what it overrides. This is the
 * vocabulary that makes a level self-describing instead of a value you need
 * the cascade to interpret.
 */
const DECIDED_BY_LABEL: Record<NotificationRow['decidedBy'], string> = {
  account: 'your account default',
  workspace: 'this workspace',
  channel: 'this channel',
  thread: 'this thread',
  participation: 'because you posted here',
};

export function describeRow(row: NotificationRow): string {
  if (row.decidedBy === 'participation') {
    return `${LEVEL_LABEL[row.level]} — ${DECIDED_BY_LABEL.participation}`;
  }
  const source = row.overridden ? DECIDED_BY_LABEL[row.decidedBy] : `inherited from ${DECIDED_BY_LABEL[row.decidedBy]}`;
  return `${LEVEL_LABEL[row.level]} — ${source}`;
}

/** The honest delivery description for a state, or null when it just works. */
export function describeDelivery(state: DeliveryState, blocker: WebPushBlocker | null | undefined): string | null {
  if (state === 'enabled') return null;

  if (blocker === 'ios_install') {
    return 'On iPhone and iPad, notifications need the app added to your home screen.';
  }
  if (blocker === 'ios_update') {
    return 'This needs iOS 16.4 or newer.';
  }
  if (blocker === 'insecure') {
    return 'Notifications need a secure (HTTPS) connection.';
  }
  if (state === 'needs-permission') {
    return 'Your browser has not allowed notifications for this site yet.';
  }
  if (state === 'browser-blocked') {
    return 'Your browser is blocking notifications for this site. Open this site\'s permissions in your browser settings, set Notifications to Allow, then turn them on again here.';
  }
  if (state === 'granted-not-enabled') {
    return 'Your browser allows notifications, but this account has none registered yet.';
  }
  return 'This platform cannot deliver notifications.';
}

/** Whether this surface has any delivery path at all (the real probe). */
export { canDeliverNotifications } from './notificationPermission.js';
import { canDeliverNotifications } from './notificationPermission.js';

/**
 * What to say after a self-test.
 *
 * The three outcomes have three different fixes, so they get three different
 * sentences rather than one "something went wrong": no target registered means
 * the member never turned this browser on (or turned it off on another
 * device); "gone" means the registration is dead and the server has pruned it,
 * so turning it on again is the fix; anything else is the instance failing to
 * sign or reach the push service, which the member cannot fix and an operator
 * must.
 */
export function describeTestResult(result: NotificationTestResult): string {
  if (result.targets === 0) {
    return 'This account has no browsers registered yet — turn notifications on above, then try again.';
  }

  if (result.sent > 0) {
    const plural = result.targets === 1 ? '' : 's';
    return `Sent to ${result.sent} of your ${result.targets} registered browser${plural}. Nothing appeared? Check Do Not Disturb and your system notification settings.`;
  }

  const gone = result.outcomes.filter((outcome) => outcome.includes('gone')).length;
  if (gone > 0 && gone === result.targets) {
    return 'Every registered browser has stopped accepting notifications — turn notifications off and on again to re-register.';
  }

  return `None of your ${result.targets} registered browsers accepted it. This instance could not reach the push service — an operator can see why in the server logs.`;
}

export function NotificationsSection({
  load,
  setLevel,
  subscribe,
  setSuppressBroadcasts,
  permission = 'unknown',
  blocker = null,
  deliverable = canDeliverNotifications(),
  onEnable,
  onDisable,
  onRestorePrompt,
  onSendTest,
  subscribed,
}: NotificationsSectionProps) {
  const [rows, setRows] = useState<NotificationRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<NotificationTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  /**
   * Which workspaces are open. Collapsed is the DEFAULT and the empty set is
   * how that is expressed — the owner's report was that a flat list of every
   * channel in every workspace is unreadable at a glance, and a tree that
   * opened expanded would only have moved the problem behind a scrollbar.
   * Expansion is per-visit state, not persisted: a workspace you opened to fix
   * something is not one you want open forever.
   */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  // A failed save must not leave the row looking saved. `saveError` names the
  // row so only that row carries the message.
  const [saveError, setSaveError] = useState<{ id: string; message: string } | null>(null);

  const runToggle = useCallback(
    async (action: (() => Promise<void>) | undefined) => {
      if (!action) return;
      setToggling(true);
      setToggleError(null);
      try {
        await action();
      } catch {
        // A failed toggle must be visible: a member who believes notifications
        // are on and is never told anything is the failure this surface exists
        // to prevent.
        setToggleError('Could not change your notification setting. Try again.');
      } finally {
        setToggling(false);
      }
    },
    [],
  );

  const runTest = useCallback(async () => {
    if (!onSendTest) return;
    setTesting(true);
    setTestError(null);
    setTestResult(null);
    try {
      setTestResult(await onSendTest());
    } catch {
      setTestError('Could not send the test notification. Try again.');
    } finally {
      setTesting(false);
    }
  }, [onSendTest]);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setRows(await load());
    } catch (err) {
      setError(err);
    }
  }, [load]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live: a level changed from any other surface re-derives the rows.
  useEffect(() => {
    if (!subscribe) return undefined;
    return subscribe(() => void refresh());
  }, [subscribe, refresh]);

  const onSuppress = useCallback(
    async (id: string, suppress: boolean) => {
      if (!setSuppressBroadcasts) return;
      setSaving(id);
      setSaveError(null);
      try {
        await setSuppressBroadcasts(id, suppress);
        await refresh();
      } catch {
        setSaveError({ id, message: 'Could not save that. Try again.' });
      } finally {
        setSaving(null);
      }
    },
    [setSuppressBroadcasts, refresh],
  );

  const onPick = useCallback(
    async (id: string, level: NotificationLevel) => {
      setSaving(id);
      setSaveError(null);
      try {
        await setLevel(id, level);
        await refresh();
      } catch {
        setSaveError({ id, message: 'Could not save that. Try again.' });
      } finally {
        setSaving(null);
      }
    },
    [setLevel, refresh],
  );

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const tree = useMemo(() => buildNotificationTree(rows ?? []), [rows]);

  const deliveryState: DeliveryState = computeDeliveryState(
    permission,
    blocker,
    deliverable,
    subscribed,
  );
  const deliveryNote = describeDelivery(deliveryState, blocker);

  return (
    <div className="flex flex-col gap-8" data-testid="settings-notifications">
      <section aria-label="Delivery" className="flex flex-col gap-3">
        <h2 className="text-sm font-bold uppercase tracking-wide text-text-muted">Delivery</h2>

        <div
          className="rounded-md border border-line bg-surface px-4 py-3 text-sm"
          data-testid="notifications-delivery-state"
          data-state={deliveryState}
        >
          <p className="font-medium text-text-primary">
            {deliveryState === 'enabled' ? 'Notifications are on' : 'Notifications are not active'}
          </p>
          {deliveryNote ? <p className="mt-1 text-text-muted">{deliveryNote}</p> : null}

          {toggleError ? (
            <p className="mt-2 text-text-muted" role="alert" data-testid="notifications-toggle-error">
              {toggleError}
            </p>
          ) : null}

          {deliveryState === 'browser-blocked' && onRestorePrompt ? (
            <button
              type="button"
              onClick={onRestorePrompt}
              data-testid="notifications-restore-prompt"
              className="mt-3 min-h-9 rounded-md border border-line px-3 text-sm font-medium text-text-primary hover:bg-surface-strong"
            >
              Show me the notification invite again
            </button>
          ) : null}

          {/* A CHECKBOX, not a button pair. The owner's read was right: this
              is a single on/off state, and two buttons made it look like two
              competing actions rather than one switch. Disabled rather than
              hidden when the platform blocks it — a control that vanishes
              leaves the member wondering what changed. */}
          {onEnable || onDisable ? (
            <label
              className={
                'mt-3 flex min-h-11 items-center gap-3 text-sm ' +
                (deliveryState === 'blocked' || deliveryState === 'browser-blocked'
                  ? 'cursor-not-allowed opacity-60'
                  : 'cursor-pointer')
              }
              data-testid="notifications-browser-toggle"
            >
              <input
                type="checkbox"
                className="h-4 w-4 accent-[var(--color-accent)]"
                checked={deliveryState === 'enabled'}
                disabled={
                  toggling ||
                  deliveryState === 'blocked' ||
                  deliveryState === 'browser-blocked'
                }
                onChange={(event) => {
                  void runToggle(event.target.checked ? onEnable : onDisable);
                }}
                data-testid="notifications-browser-checkbox"
              />
              <span className="font-medium text-text-primary">
                Notifications on this browser
              </span>
            </label>
          ) : null}

          {/* The owner asked for a way to TEST this from here, and it is the
              right place for it: every state above is a claim about what will
              happen, and a claim the member cannot check is exactly what makes
              "I never got notified" unfalsifiable. Deliberately left enabled
              in the not-yet-on states — the answer ("no browsers registered")
              is the diagnosis, and disabling the button would hide it. */}
          {onSendTest ? (
            <div className="mt-3 border-t border-line pt-3">
              <button
                type="button"
                className="min-h-9 rounded-md border border-line px-3 text-sm font-medium text-text-primary hover:bg-surface-strong disabled:opacity-60"
                disabled={testing}
                onClick={() => void runTest()}
                data-testid="notifications-send-test"
              >
                {testing ? 'Sending…' : 'Send me a test notification'}
              </button>

              {testError ? (
                <p className="mt-2 text-xs text-danger" role="alert" data-testid="notifications-test-error">
                  {testError}
                </p>
              ) : null}

              {testResult ? (
                <p
                  className="mt-2 text-xs text-text-muted"
                  role="status"
                  data-testid="notifications-test-result"
                  data-sent={testResult.sent}
                  data-targets={testResult.targets}
                >
                  {describeTestResult(testResult)}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      <section aria-label="Levels" className="flex flex-col gap-3">
        <h2 className="text-sm font-bold uppercase tracking-wide text-text-muted">
          What reaches you
        </h2>
        <p className="text-sm text-text-muted">
          Each row shows what it resolves to and which layer decided it.
        </p>

        {rows === null && error === null ? (
          <PaneSkeleton label="Loading your notification settings" testId="notifications-loading" rows={2} />
        ) : null}

        {error !== null ? (
          // The shared pane states: one banner, one Retry (this was a bordered
          // box with its own "Try again" and no focus ring).
          <PaneErrorBanner
            testId="notifications-error"
            retryTestId="notifications-retry"
            message="Could not load your notification settings."
            onRetry={() => void refresh()}
          />
        ) : null}

        {rows !== null && rows.length === 0 ? (
          <p className="text-sm text-text-muted" data-testid="notifications-empty">
            You have no channels or workspaces yet, so there is nothing to configure.
          </p>
        ) : null}

        {rows !== null && rows.length > 0 ? (
          <ul className="flex flex-col gap-2" data-testid="notifications-list">
            {tree.roots.map((row) => {
              const children = tree.childrenByParent.get(row.id) ?? [];
              const open = expanded.has(row.id);
              return (
                <li
                  key={row.id}
                  className="rounded-md border border-line bg-surface"
                  data-testid={`notifications-node-${row.id}`}
                >
                  <div
                    className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                    data-testid={`notifications-row-${row.id}`}
                  >
                    <div className="flex min-w-0 items-start gap-2">
                      {children.length > 0 ? (
                        <Disclosure
                          open={open}
                          label={row.label}
                          testId={`notifications-toggle-${row.id}`}
                          onToggle={() => toggleExpanded(row.id)}
                        />
                      ) : (
                        /* The account default has no children, but it must sit
                           on the same left edge as the workspaces below it. */
                        <span className="w-6 shrink-0" aria-hidden="true" />
                      )}
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-text-primary">{row.label}</p>
                        <p
                          className="text-xs text-text-muted"
                          data-testid={`notifications-resolved-${row.id}`}
                        >
                          {describeRow(row)}
                        </p>
                        {/* The collapsed workspace's own readout: how many
                            channels are inside, and how many are exceptions.
                            Without it, collapsed workspaces hide the very
                            thing the member opened this surface to find. */}
                        {children.length > 0 && !open ? (
                          <p
                            className="mt-0.5 text-xs text-text-muted"
                            data-testid={`notifications-children-summary-${row.id}`}
                          >
                            {describeChildren(children)}
                          </p>
                        ) : null}
                      </div>
                    </div>

                    <LevelControl row={row} saving={saving} onPick={onPick} />
                  </div>

                  {/* The workspace's broadcast switch (2026-09-27): "Mentions
                      only" includes @everyone/@here unless this is on. */}
                  {row.scope === 'workspace' && row.suppressBroadcasts !== undefined && setSuppressBroadcasts ? (
                    <label
                      className="flex min-h-9 cursor-pointer items-center gap-3 px-4 pb-3 pl-12 text-xs text-text-primary"
                      data-testid={`notifications-suppress-${row.id}`}
                    >
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-[var(--color-accent)]"
                        checked={row.suppressBroadcasts}
                        disabled={saving === row.id}
                        onChange={(event) => void onSuppress(row.id, event.target.checked)}
                        data-testid={`notifications-suppress-checkbox-${row.id}`}
                      />
                      <span>Suppress @everyone and @here</span>
                    </label>
                  ) : null}

                  {saveError && saveError.id === row.id ? (
                    <p
                      className="px-4 pb-3 text-xs text-danger"
                      role="alert"
                      data-testid={`notifications-save-error-${row.id}`}
                    >
                      {saveError.message}
                    </p>
                  ) : null}

                  {open && children.length > 0 ? (
                    <ul
                      className="flex flex-col gap-2 border-t border-line px-4 py-3 pl-10"
                      data-testid={`notifications-children-${row.id}`}
                    >
                      {children.map((child) => (
                        <li
                          key={child.id}
                          className="flex flex-wrap items-center justify-between gap-3"
                          data-testid={`notifications-row-${child.id}`}
                        >
                          <div className="min-w-0">
                            <p className="truncate text-sm text-text-primary">{child.label}</p>
                            <p
                              className="text-xs text-text-muted"
                              data-testid={`notifications-resolved-${child.id}`}
                            >
                              {describeRow(child)}
                            </p>
                            {saveError && saveError.id === child.id ? (
                              <p
                                className="text-xs text-danger"
                                role="alert"
                                data-testid={`notifications-save-error-${child.id}`}
                              >
                                {saveError.message}
                              </p>
                            ) : null}
                          </div>

                          <LevelControl row={child} saving={saving} onPick={onPick} />
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>
    </div>
  );
}

/**
 * The disclosure triangle for a workspace row. A real `aria-expanded` button
 * (not a styled caret on the row) because the row also carries a radiogroup:
 * making the whole row a toggle would nest interactive controls inside a
 * button, which is the classic disclosure anti-pattern.
 */
function Disclosure({
  open,
  label,
  testId,
  onToggle,
}: {
  open: boolean;
  label: string;
  testId: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-surface-strong hover:text-text-primary"
      aria-expanded={open}
      aria-label={`${open ? 'Hide' : 'Show'} channels in ${label}`}
      onClick={onToggle}
      data-testid={testId}
    >
      <svg
        viewBox="0 0 24 24"
        width="14"
        height="14"
        aria-hidden="true"
        style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 120ms ease' }}
      >
        <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </button>
  );
}

/** The three-way level choice for one row. */
function LevelControl({
  row,
  saving,
  onPick,
}: {
  row: NotificationRow;
  saving: string | null;
  onPick: (id: string, level: NotificationLevel) => void;
}) {
  return (
    <div role="radiogroup" aria-label={`Notification level for ${row.label}`} className="flex gap-1">
      {(['all', 'mentions', 'mute'] as const).map((level) => (
        <button
          key={level}
          type="button"
          role="radio"
          aria-checked={row.level === level}
          aria-label={LEVEL_LABEL[level]}
          disabled={saving === row.id}
          onClick={() => onPick(row.id, level)}
          data-testid={`notifications-${row.id}-${level}`}
          className={
            'min-h-9 rounded-md border px-3 text-xs font-medium transition-colors disabled:opacity-60 ' +
            (row.level === level
              ? 'border-accent bg-surface-strong text-text-primary'
              : 'border-line text-text-muted hover:bg-surface-strong')
          }
        >
          {LEVEL_LABEL[level]}
        </button>
      ))}
    </div>
  );
}

/**
 * The delivery state, from what the platform allows, what the member chose, and
 * whether this browser actually holds a subscription.
 *
 * The order matters: a platform-level block outranks a permission the member
 * can grant, because telling someone to grant a permission that cannot help
 * them is worse than telling them the real reason.
 *
 * `subscribed` is the third fact, and it is the one permission alone cannot
 * supply. `granted` means the member once allowed notifications for this site —
 * not that a subscription exists. Deriving "enabled" from permission alone put
 * a checked, "Notifications are on" box in front of browsers that had never
 * registered and could receive nothing, and it made the checkbox unclickable in
 * the only direction that would have helped: unchecking called disable, the
 * state re-derived to enabled, and it snapped back (found live 2026-09-14).
 * Passing `false` resolves that browser to `granted-not-enabled`, which the
 * surface already words correctly. `undefined` means the caller does not know,
 * and keeps the old permission-only behaviour.
 */
export function computeDeliveryState(
  permission: NotificationPermission | 'unknown',
  blocker: WebPushBlocker | null | undefined,
  deliverable: boolean = canDeliverNotifications(),
  subscribed?: boolean,
): DeliveryState {
  if (blocker || !deliverable) return 'blocked';
  if (permission === 'denied') return 'browser-blocked';
  if (permission === 'granted') return subscribed === false ? 'granted-not-enabled' : 'enabled';
  return permission === 'default' ? 'needs-permission' : 'granted-not-enabled';
}

/** The browser's current notification permission, or 'unknown' where there is none. */
export { readNotificationPermission } from './notificationPermission.js';
