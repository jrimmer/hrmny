/**
 * notifications plan U8 — the desktop notification binding.
 *
 * The Rust shell has registered and permitted the notification plugin since
 * it was built; what was missing was any way for application code to call it.
 * These tests pin the two things that decide whether the feature is honest: it
 * never claims to have notified when it did not, and it never throws into a
 * caller that is on the fan-out path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pluginMock = {
  isPermissionGranted: vi.fn<() => Promise<boolean>>(),
  requestPermission: vi.fn<() => Promise<'granted' | 'denied' | 'default'>>(),
  sendNotification: vi.fn<(options: unknown) => void>(),
};

vi.mock('@tauri-apps/plugin-notification', () => pluginMock);

import {
  ensureNotificationPermission,
  isDesktopNotificationsSupported,
  notificationSupport,
  showDesktopNotification,
} from '../notifications.js';

function asShell(inShell: boolean): void {
  if (inShell) {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
  } else {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  asShell(true);
  pluginMock.isPermissionGranted.mockResolvedValue(true);
  pluginMock.requestPermission.mockResolvedValue('granted');
});

afterEach(() => {
  asShell(false);
});

describe('isDesktopNotificationsSupported', () => {
  it('is true inside the shell and false in a browser', () => {
    expect(isDesktopNotificationsSupported()).toBe(true);
    asShell(false);
    expect(isDesktopNotificationsSupported()).toBe(false);
  });
});

describe('notificationSupport', () => {
  it('reports granted when the platform has already allowed it', async () => {
    await expect(notificationSupport()).resolves.toBe('granted');
  });

  // A surface must be able to say "you need to allow this" BEFORE the member
  // clicks, or the click looks like it did nothing.
  it('reports needs-permission without requesting anything', async () => {
    pluginMock.isPermissionGranted.mockResolvedValue(false);

    await expect(notificationSupport()).resolves.toBe('needs-permission');
    expect(pluginMock.requestPermission).not.toHaveBeenCalled();
  });

  it('reports unsupported outside the shell', async () => {
    asShell(false);
    await expect(notificationSupport()).resolves.toBe('unsupported');
  });

  it('reports unsupported when the plugin cannot be reached', async () => {
    pluginMock.isPermissionGranted.mockRejectedValue(new Error('no plugin'));
    await expect(notificationSupport()).resolves.toBe('unsupported');
  });
});

describe('ensureNotificationPermission', () => {
  it('does not prompt when permission is already granted', async () => {
    await expect(ensureNotificationPermission()).resolves.toBe('granted');
    expect(pluginMock.requestPermission).not.toHaveBeenCalled();
  });

  it('prompts once and reports the grant', async () => {
    pluginMock.isPermissionGranted.mockResolvedValue(false);

    await expect(ensureNotificationPermission()).resolves.toBe('granted');
    expect(pluginMock.requestPermission).toHaveBeenCalledTimes(1);
  });

  // A refusal is a legitimate answer the surface must render honestly.
  it('a refusal reports denied rather than throwing', async () => {
    pluginMock.isPermissionGranted.mockResolvedValue(false);
    pluginMock.requestPermission.mockResolvedValue('denied');

    await expect(ensureNotificationPermission()).resolves.toBe('denied');
  });

  it('a default (dismissed) prompt reports denied', async () => {
    pluginMock.isPermissionGranted.mockResolvedValue(false);
    pluginMock.requestPermission.mockResolvedValue('default');

    await expect(ensureNotificationPermission()).resolves.toBe('denied');
  });
});

describe('showDesktopNotification', () => {
  it('sends with the title, body, and routing target', async () => {
    const sent = await showDesktopNotification({
      title: 'Cytale',
      body: 'hey there',
      target: { workspace_id: '1', channel_id: '2', message_id: '3' },
    });

    expect(sent).toBe(true);
    expect(pluginMock.sendNotification).toHaveBeenCalledWith({
      title: 'Cytale',
      body: 'hey there',
      extra: { target: { workspace_id: '1', channel_id: '2', message_id: '3' } },
    });
  });

  // A notification that cannot be shown must never cost the message that
  // produced it, so every failure is a false rather than a throw.
  it('does not send when permission is not granted', async () => {
    pluginMock.isPermissionGranted.mockResolvedValue(false);

    await expect(showDesktopNotification({ title: 'C', body: 'b' })).resolves.toBe(false);
    expect(pluginMock.sendNotification).not.toHaveBeenCalled();
  });

  it('returns false outside the shell', async () => {
    asShell(false);
    await expect(showDesktopNotification({ title: 'C', body: 'b' })).resolves.toBe(false);
  });

  it('returns false rather than throwing when the send fails', async () => {
    pluginMock.sendNotification.mockImplementation(() => {
      throw new Error('notification center unavailable');
    });

    await expect(showDesktopNotification({ title: 'C', body: 'b' })).resolves.toBe(false);
  });

  it('omits extra when there is no target', async () => {
    await showDesktopNotification({ title: 'C', body: 'b' });

    expect(pluginMock.sendNotification).toHaveBeenCalledWith({
      title: 'C',
      body: 'b',
      extra: undefined,
    });
  });
});
