/**
 * The notification probes the SHELL needs, kept apart from the notifications
 * settings surface (lane D #7): the shell reads the permission at mount and on
 * focus, and the in-app prompt asks whether delivery is possible at all —
 * importing either from `NotificationsSection` pulled that whole
 * (lazily-loaded) section back into the shell chunk.
 */
import { isWebPushSupported } from '../../app/pwa/capabilities.js';
import { isTauri } from '../../tauri/index.js';

/** Whether this surface has any delivery path at all (the real probe). */
export function canDeliverNotifications(): boolean {
  return isTauri() ? true : isWebPushSupported();
}

export function readNotificationPermission(): NotificationPermission | 'unknown' {
  if (typeof Notification === 'undefined') return 'unknown';
  return Notification.permission;
}
