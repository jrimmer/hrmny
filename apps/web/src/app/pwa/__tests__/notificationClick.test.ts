/**
 * The notification-click contract, both halves:
 *
 *   - the SERVICE WORKER's handler (public/push-handler.js — a plain
 *     importScripts file, evaluated here against a stubbed worker scope):
 *     focus an existing window and NAVIGATE it to the message; cold-start at
 *     the message itself when no window exists; never a bare root load;
 *   - the APP-side path builder (the postMessage listener's twin), which
 *     must produce the IDENTICAL grammar — the two cannot share a module
 *     (importScripts), so this test is what keeps them in lockstep.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { notificationClickPath } from '../notificationClick.js';

const WORKER_SRC = readFileSync(
  join(__dirname, '..', '..', '..', '..', 'public', 'push-handler.js'),
  'utf8',
);

/** A worker scope double: capture listeners, drive them with fake events. */
function workerScope() {
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const clients: unknown[] = [];
  const openWindow = vi.fn(async (url: string) => ({ postMessage: vi.fn(), url }));
  const self = {
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      (listeners[type] ??= []).push(fn);
    },
    registration: { showNotification: vi.fn(async () => undefined) },
    clients: {
      matchAll: vi.fn(async () => clients.slice()),
      openWindow,
    },
  };
  // eslint-disable-next-line no-new-func
  new Function('self', WORKER_SRC)(self);
  return { self, listeners, clients, openWindow };
}

function click(scope: ReturnType<typeof workerScope>, target: unknown) {
  const handler = scope.listeners['notificationclick']![0]!;
  const waitUntil = vi.fn();
  handler({
    notification: { close: vi.fn(), data: { target } },
    waitUntil,
  });
  // Resolve the waitUntil promise chain synchronously enough for assertions.
  return waitUntil.mock.calls[0]![0] as Promise<unknown>;
}

const WS_TARGET = {
  workspace_id: '91000000001',
  channel_id: '91000000002',
  thread_id: null,
  message_id: '91000000100',
};
const WS_HREF = '#/workspace/91000000001/channel/91000000002/message/91000000100';
const DM_TARGET = {
  workspace_id: null,
  channel_id: '91000000003',
  thread_id: '91000000004',
  message_id: '91000000101',
};
const DM_HREF = '#/channel/91000000003/thread/91000000004/message/91000000101';

describe('push-handler.js — notificationclick', () => {
  it('focuses an existing window and NAVIGATES it to the message', async () => {
    const scope = workerScope();
    const navigate = vi.fn(async (url: string) => ({ url }));
    scope.clients.push({ focus: vi.fn(async () => undefined), navigate, postMessage: vi.fn() });

    await click(scope, WS_TARGET);

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(`/${WS_HREF}`);
    expect(scope.openWindow).not.toHaveBeenCalled();
  });

  it('cold-starts at the message itself when no window exists on this origin', async () => {
    const scope = workerScope();
    await click(scope, DM_TARGET);
    expect(scope.openWindow).toHaveBeenCalledTimes(1);
    expect(scope.openWindow).toHaveBeenCalledWith(`/${DM_HREF}`);
  });

  it('every URL it opens resolves to the app root, never beside the worker script', async () => {
    // openWindow()/navigate() resolve against the worker's own URL
    // (/sw.js): a bare "#/…" became "/sw.js#/…" and opened the worker's
    // JavaScript instead of the app (owner report 2026-09-30).
    const scope = workerScope();
    const navigate = vi.fn(async (url: string) => ({ url }));
    scope.clients.push({ focus: vi.fn(async () => undefined), navigate, postMessage: vi.fn() });
    await click(scope, WS_TARGET);
    const cold = workerScope();
    await click(cold, DM_TARGET);
    for (const url of [navigate.mock.calls[0]?.[0], cold.openWindow.mock.calls[0]?.[0]]) {
      const resolved = new URL(String(url), 'https://hrmny.example/sw.js');
      expect(resolved.pathname).toBe('/');
      expect(resolved.hash.startsWith('#/')).toBe(true);
    }
  });

  it('a target without ids falls back to the app root', async () => {
    const scope = workerScope();
    await click(scope, { channel_id: '91000000002' });
    expect(scope.openWindow).toHaveBeenCalledWith('/');
  });
});

describe('notificationClickPath — the app-side twin', () => {
  it('produces the IDENTICAL grammar the worker navigates to (the worker roots it at /)', () => {
    expect(notificationClickPath(WS_TARGET)).toBe(WS_HREF);
    expect(notificationClickPath(DM_TARGET)).toBe(DM_HREF);
  });

  it('returns null for an unusable target (the listener no-ops)', () => {
    expect(notificationClickPath({ channel_id: '91000000002' })).toBeNull();
    expect(notificationClickPath({ message_id: '91000000100' })).toBeNull();
  });
});
