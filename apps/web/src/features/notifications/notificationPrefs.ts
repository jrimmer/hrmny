/**
 * @cytale/web — the ONE client module for notification preferences
 * (notification controls, 2026-09-27).
 *
 * Every surface that shows or changes a level — the channel/DM header control,
 * the thread header control, the channel right-click menu, the workspace menu,
 * the sidebar rows, the phone topbar and its sheet, Settings → Notifications,
 * and the ding coordinator — goes through here. The data itself lives in the
 * U17 store (`notificationPrefs`, see `@cytale/state`'s
 * notificationPreferences.ts), so a change made from any surface is visible on
 * every other one in the same render: there is no second cache to go stale.
 *
 * This module adds only the web bindings: the session's api client, React
 * hooks with narrow selectors (a row re-renders when ITS level moves, not on
 * every gateway event), and the human labels the controls share — so the
 * header tooltip, the menu radio and the settings readout name a level and a
 * layer with the same words.
 */

import { useCallback } from 'react';

import {
  ACCOUNT_ENTITY_ID,
  clearNotificationLevel,
  defaultStore,
  hydrateNotificationPreferences,
  isBroadcastSuppressed,
  nextNotificationLevel,
  NOTIFICATION_LAYER_LABEL,
  notificationControlLabel,
  notificationResetLabel,
  resolveNotificationLevel,
  resolveNotificationTarget,
  setBroadcastSuppressed,
  setNotificationLevel,
  type NotificationDecidedBy,
  type NotificationLevel,
  type NotificationPrefsApi,
  type NotificationPrefsState,
  type NotificationTarget,
  type NotificationTargetView,
  type StateStore,
} from '@cytale/state';

import { useStoreSelector } from '../../app/useStoreSelector.js';
import { api } from '../auth/session.js';
import { LEVEL_LABEL } from '../settings/notificationLevels.js';

export type { NotificationLevel, NotificationTarget, NotificationTargetView };
export { ACCOUNT_ENTITY_ID, nextNotificationLevel };

/** The session api client, narrowed to what the preference writes need. */
function prefsApi(): NotificationPrefsApi {
  return api as unknown as NotificationPrefsApi;
}

// ---------------------------------------------------------------------------
// Labels — one vocabulary for every surface
// ---------------------------------------------------------------------------

/** The level's name as the controls say it (tooltip, radio, confirmation). */
export { LEVEL_LABEL };

/** A layer's name inside "(workspace default)"-style provenance. */
export const LAYER_LABEL: Record<NotificationDecidedBy, string> = NOTIFICATION_LAYER_LABEL;

/** What "Use … default" says for a target (see `@cytale/state`). */
export const resetLabel = (target: NotificationTarget): string => notificationResetLabel(target);

/**
 * The control's accessible name and tooltip: the CURRENT state (with its
 * provenance when inherited) and what a click does next.
 *
 *   "Notifications: Mentions only (workspace default) — click for Nothing"
 */
export const controlLabel = (view: NotificationTargetView): string => notificationControlLabel(view);

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

function sameView(a: NotificationTargetView, b: NotificationTargetView): boolean {
  return (
    a.level === b.level &&
    a.decidedBy === b.decidedBy &&
    a.explicit === b.explicit &&
    a.inheritedLevel === b.inheritedLevel &&
    a.inheritedFrom === b.inheritedFrom &&
    a.overridden === b.overridden
  );
}

/** One target's resolved level, re-rendering only when it changes. */
export function useNotificationTarget(
  target: NotificationTarget,
  store: StateStore = defaultStore,
): NotificationTargetView {
  const { scope, entityId, workspaceId, channelId, threadId } = target;
  const select = useCallback(
    (s: { notificationPrefs: Parameters<typeof resolveNotificationTarget>[0] }) =>
      resolveNotificationTarget(s.notificationPrefs, { scope, entityId, workspaceId, channelId, threadId }),
    [scope, entityId, workspaceId, channelId, threadId],
  );
  return useStoreSelector(store, select, sameView);
}

/**
 * The level a SIDEBAR ROW reads at: the effective level when some layer of
 * its chain was actually set by the member, and `all` (today's badges) when
 * nothing was.
 *
 * Why not the raw effective level: the product default is `mentions`, so
 * applying "mentions-only rows show no unread count" to the DEFAULT would
 * strip the unread counts from every channel of every member who never opened
 * a notification setting — a sweeping change nobody chose. The rule is the
 * member's instruction, so it applies where the member gave one (at any
 * layer: an account-level "Mentions only" quiets every row that inherits it).
 */
export function useRowLevel(
  chain: { workspaceId?: string | null; channelId?: string | null; threadId?: string | null },
  store: StateStore = defaultStore,
): NotificationLevel {
  const { workspaceId, channelId, threadId } = chain;
  const select = useCallback(
    (s: { notificationPrefs: NotificationPrefsState }) =>
      rowLevel(s.notificationPrefs, { workspaceId, channelId, threadId }),
    [workspaceId, channelId, threadId],
  );
  return useStoreSelector(store, select);
}

/** `useRowLevel`'s rule as a pure function, for list hosts that map rows. */
export function rowLevel(
  prefs: NotificationPrefsState | undefined,
  chain: { workspaceId?: string | null; channelId?: string | null; threadId?: string | null },
): NotificationLevel {
  if (!prefs) return 'all';
  const view = resolveNotificationLevel({
    overrides: prefs.overrides,
    workspaceId: chain.workspaceId ?? null,
    channelId: chain.channelId ?? null,
    threadId: chain.threadId ?? null,
  });
  return view.overridden ? view.level : 'all';
}

/** Whether the member suppresses broadcasts in this workspace. */
export function useBroadcastSuppressed(workspaceId: string | null | undefined, store: StateStore = defaultStore): boolean {
  const select = useCallback(
    (s: { notificationPrefs: Parameters<typeof isBroadcastSuppressed>[0] }) =>
      isBroadcastSuppressed(s.notificationPrefs, workspaceId),
    [workspaceId],
  );
  return useStoreSelector(store, select);
}

// ---------------------------------------------------------------------------
// Writes — optimistic, rejecting (after rollback) so a control can say so
// ---------------------------------------------------------------------------

/** Load (or reload) the member's preferences into the store. Never rejects. */
export function hydrateNotificationPrefs(store: StateStore = defaultStore): Promise<void> {
  return hydrateNotificationPreferences(store, prefsApi());
}

/** Write an explicit level at the target's own layer. */
export function setTargetLevel(
  target: NotificationTarget,
  level: NotificationLevel,
  store: StateStore = defaultStore,
): Promise<void> {
  return setNotificationLevel(store, prefsApi(), target.scope, target.entityId, level);
}

/** Clear the target's own row ("Use … default"). */
export function clearTargetLevel(target: NotificationTarget, store: StateStore = defaultStore): Promise<void> {
  return clearNotificationLevel(store, prefsApi(), target.scope, target.entityId);
}

/** Flip a workspace's "Suppress @everyone and @here" switch. */
export function setWorkspaceBroadcastSuppressed(
  workspaceId: string,
  suppress: boolean,
  store: StateStore = defaultStore,
): Promise<void> {
  return setBroadcastSuppressed(store, prefsApi(), workspaceId, suppress);
}

// ---------------------------------------------------------------------------
// Target builders — so every surface names a target the same way
// ---------------------------------------------------------------------------

/** A workspace channel, or a DM when `workspaceId` is null. */
export function channelTarget(channelId: string, workspaceId: string | null | undefined): NotificationTarget {
  return { scope: 'channel', entityId: channelId, channelId, workspaceId: workspaceId ?? null };
}

export function threadTarget(
  threadId: string,
  channelId: string | null | undefined,
  workspaceId: string | null | undefined,
): NotificationTarget {
  return { scope: 'thread', entityId: threadId, threadId, channelId: channelId ?? null, workspaceId: workspaceId ?? null };
}

export function workspaceTarget(workspaceId: string): NotificationTarget {
  return { scope: 'workspace', entityId: workspaceId, workspaceId };
}

export function accountTarget(): NotificationTarget {
  return { scope: 'account', entityId: ACCOUNT_ENTITY_ID };
}

/** The message a failed write shows beside its control. */
export const WRITE_FAILED_MESSAGE = "Couldn't change notifications — check your connection and try again.";
