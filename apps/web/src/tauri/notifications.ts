/**
 * @cytale/web — desktop native notifications (notifications plan U8).
 *
 * The Rust shell has registered `tauri-plugin-notification` and granted it in
 * its capability set since the shell was built, but nothing on the web side
 * could call it — the plugin binding was not a dependency, so desktop
 * notifications were unreachable from application code. This is that binding.
 *
 * ## Deliberately NOT the service worker
 *
 * The PWA path cannot serve the shell: `registerSW` returns early inside
 * Tauri because a worker there would serve cached API bodies
 * (`networkTimeoutSeconds: 5`) and the update poll would reload the webview
 * mid-session. So the desktop path is the native plugin, and the two share
 * only the decision (the server's policy) and the payload shape — never the
 * transport.
 *
 * ## Permission is requested, never assumed
 *
 * macOS shows its own prompt the first time, and a member can refuse. The
 * surface reports what actually happened rather than optimistically claiming
 * notifications are on, because a silently-denied permission is the worst
 * outcome: the member believes they will be told and never is.
 */

import { isTauri } from './isTauri.js';

export interface DesktopNotification {
  title: string;
  body: string;
  /** Routing target, carried so a click could land on the exact message. */
  target?: {
    workspace_id?: string | null;
    channel_id?: string | null;
    thread_id?: string | null;
    message_id?: string | null;
  };
}

/** What the platform will actually do. */
export type NotificationSupport = 'unsupported' | 'needs-permission' | 'denied' | 'granted';

/**
 * The plugin module, loaded lazily.
 *
 * Lazy because the package is only present in a shell build's dependency graph
 * in practice, and importing it at module scope in the browser/PWA path would
 * pull Tauri internals into a bundle that never uses them.
 */
type NotificationPlugin = {
  isPermissionGranted: () => Promise<boolean>;
  requestPermission: () => Promise<'granted' | 'denied' | 'default'>;
  sendNotification: (options: { title: string; body: string; extra?: unknown }) => void;
};

async function loadPlugin(): Promise<NotificationPlugin | null> {
  try {
    return (await import('@tauri-apps/plugin-notification')) as unknown as NotificationPlugin;
  } catch {
    // Not in a shell build, or the plugin is absent. Either way there is
    // nothing to notify with, and that is a state rather than an error.
    return null;
  }
}

/** True when native notifications are the right transport on this surface. */
export function isDesktopNotificationsSupported(): boolean {
  return isTauri();
}

/**
 * Report what the platform will do, without requesting anything.
 *
 * A surface must be able to say "you need to allow this" BEFORE the member
 * clicks, or the click looks like it did nothing.
 */
export async function notificationSupport(): Promise<NotificationSupport> {
  if (!isDesktopNotificationsSupported()) return 'unsupported';

  const plugin = await loadPlugin();
  if (!plugin) return 'unsupported';

  try {
    if (await plugin.isPermissionGranted()) return 'granted';
    return 'needs-permission';
  } catch {
    return 'unsupported';
  }
}

/**
 * Ask for permission if it has not been granted, and report the outcome.
 *
 * Returns 'denied' rather than throwing: a refusal is a legitimate answer the
 * surface must render honestly.
 */
export async function ensureNotificationPermission(): Promise<NotificationSupport> {
  if (!isDesktopNotificationsSupported()) return 'unsupported';

  const plugin = await loadPlugin();
  if (!plugin) return 'unsupported';

  try {
    if (await plugin.isPermissionGranted()) return 'granted';

    const result = await plugin.requestPermission();
    return result === 'granted' ? 'granted' : 'denied';
  } catch {
    return 'unsupported';
  }
}

/**
 * Show a native notification. Returns true when one was actually sent.
 *
 * No-ops (returning false) rather than throwing when unsupported or refused,
 * so a caller on the fan-out path never has to guard: a notification that
 * cannot be shown must never cost the message that produced it.
 */
export async function showDesktopNotification(
  notification: DesktopNotification,
): Promise<boolean> {
  if (!isDesktopNotificationsSupported()) return false;

  const plugin = await loadPlugin();
  if (!plugin) return false;

  try {
    if (!(await plugin.isPermissionGranted())) return false;

    plugin.sendNotification({
      title: notification.title,
      body: notification.body,
      // The target rides `extra` so a click handler can route without the
      // sender having needed a lookup — the same shape the web push payload
      // carries, so both transports hand the app identical information.
      extra: notification.target ? { target: notification.target } : undefined,
    });

    return true;
  } catch {
    return false;
  }
}
