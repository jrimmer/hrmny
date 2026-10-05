/**
 * The notification LEVEL vocabulary and the client's copy of the server's
 * inheritance walk — split out of `NotificationsSection` (lane D #7) so the
 * notification-sound coordinator (which runs on every gateway dispatch, from
 * the entry chunk) and the shell can use them without loading the settings
 * surface.
 *
 * The walk itself now lives in `@cytale/state` (notification controls,
 * 2026-09-27) — the ONE copy every surface resolves through, next to the
 * store slice that holds the member's levels. The names below stay so the
 * settings tree and the ding keep their imports; they are the same functions.
 */

import {
  DEFAULT_NOTIFICATION_LEVEL,
  NOTIFICATION_LEVEL_LABEL,
  notificationOverrideKey,
  resolveNotificationLevel,
  type NotificationLevel,
  type ResolveNotificationInput,
} from '@cytale/state';

/** One stored or inherited notification level. */
export type { NotificationLevel };

/** Which layer a row IS — what decides where it sits in the tree. */
export type NotificationScope = 'account' | 'workspace' | 'channel' | 'thread';

/** A row the member can see, with its resolved level and provenance. */
export interface NotificationRow {
  id: string;
  label: string;
  /** The effective level, after the inheritance walk. */
  level: NotificationLevel;
  /** The layer that decided it. */
  decidedBy: 'account' | 'workspace' | 'channel' | 'thread' | 'participation';
  /** False when the member has not overridden this row. */
  overridden: boolean;
  /** Which layer this row belongs to. */
  scope: NotificationScope;
  /**
   * The workspace a channel row sits under. Required for `channel` rows, and
   * the reason the tree can be built from the row list alone — the surface
   * never has to know the store's shape.
   */
  parentId?: string;
  /**
   * Workspace rows only: whether "Suppress @everyone and @here" is on there
   * (2026-09-27). Undefined on every other row.
   */
  suppressBroadcasts?: boolean;
}

/**
 * Resolve a level through the same walk the server runs: thread → channel →
 * workspace → account, most specific first, an absent layer SKIPPED rather
 * than terminating. See `@cytale/state`'s `resolveNotificationLevel`.
 */
export type ResolveInput = ResolveNotificationInput;

export const DEFAULT_LEVEL: NotificationLevel = DEFAULT_NOTIFICATION_LEVEL;

/**
 * A level's name, as EVERY surface says it (2026-09-27): the header
 * control's tooltip and confirmation, the menus' radios, the phone sheet,
 * the settings overview and the native app (`@cytale/state` owns the words).
 * Re-exported here so the settings surface needs no session import.
 */
export const LEVEL_LABEL: Record<NotificationLevel, string> = NOTIFICATION_LEVEL_LABEL;

/** The key an override map uses for one layer. */
export const overrideKey = notificationOverrideKey;

export function resolveFromOverrides(input: ResolveInput): {
  level: NotificationLevel;
  decidedBy: NotificationRow['decidedBy'];
  overridden: boolean;
} {
  return resolveNotificationLevel(input);
}
