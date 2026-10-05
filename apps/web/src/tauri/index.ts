/**
 * @cytale/web — Tauri desktop-shell integration surface (U27).
 *
 * The desktop app hosts this web build; the shared TS core (U15–U17) means
 * the Tauri shell and the PWA share account/gateway/state (AE6). This module
 * is the thin web-side seam: runtime detection + deep-link parsing. Native
 * notification/window-state/updater behavior lives in the Rust shell
 * (apps/desktop/src-tauri); the web side only needs to know it is inside
 * the shell and how to interpret a deep link.
 */

export { isTauri, tauriPlatform } from './isTauri.js';
export {
  parseDeepLink,
  subscribeToDeepLinks,
  DEEP_LINK_EVENT,
  DEEP_LINK_TAKE_PENDING_COMMAND,
  type DeepLinkBridge,
  type DeepLinkTarget,
} from './deepLink.js';
export {
  isDesktopNotificationsSupported,
  notificationSupport,
  ensureNotificationPermission,
  showDesktopNotification,
  type DesktopNotification,
  type NotificationSupport,
} from './notifications.js';
