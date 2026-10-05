/**
 * notifications plan U6/U7 — the browser subscription flow.
 *
 * This is the piece that was missing entirely: the server had a subscription
 * store and a sender, and the worker had a push handler, but nothing ever
 * called `pushManager.subscribe()`, so no browser could be reached.
 *
 * Two properties decide whether the feature is honest: a refused permission is
 * reported as refused rather than as success, and a RE-SUBSCRIBE replaces the
 * old row rather than accumulating dead ones — the browser rotates a
 * subscription silently, and a stale endpoint is exactly the quiet failure
 * this whole feature exists to remove.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  disablePushSubscription,
  enablePushSubscription,
  urlBase64ToUint8Array,
} from '../pushSubscription.js';

const VAPID = 'BEQvU93maFHTu19KHfUNqlP6KiI5U7L6teTDmalu4gVPWIKnLOrZSiGXJsUN9TnjkCeVjGINoSDDN3ek0-Cla54';

interface FakeSubscription {
  endpoint: string;
  toJSON: () => unknown;
  unsubscribe: () => Promise<boolean>;
}

function fakeSubscription(endpoint: string): FakeSubscription {
  return {
    endpoint,
    toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: vi.fn().mockResolvedValue(true),
  };
}

interface Harness {
  subscribe: ReturnType<typeof vi.fn>;
  getSubscription: ReturnType<typeof vi.fn>;
  requestPermission: ReturnType<typeof vi.fn>;
}

function installPushEnv(existing: FakeSubscription | null = null): Harness {
  const subscribe = vi.fn().mockResolvedValue(fakeSubscription('https://push.example.com/new'));
  const getSubscription = vi.fn().mockResolvedValue(existing);
  const requestPermission = vi.fn().mockResolvedValue('granted');

  const registration = {
    pushManager: { subscribe, getSubscription },
  };

  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { ready: Promise.resolve(registration), getRegistration: () => Promise.resolve(registration) },
  });

  Object.defineProperty(globalThis, 'PushManager', {
    configurable: true,
    value: function PushManager() {},
  });
  Object.defineProperty(window, 'PushManager', {
    configurable: true,
    value: function PushManager() {},
  });
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });

  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    value: { requestPermission },
  });

  return { subscribe, getSubscription, requestPermission };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'Notification');
  Reflect.deleteProperty(globalThis, 'PushManager');
});

describe('urlBase64ToUint8Array', () => {
  it('decodes a VAPID public key to the 65 bytes of an uncompressed P-256 point', () => {
    const bytes = urlBase64ToUint8Array(VAPID);

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(65);
    // Uncompressed-point marker — the shape the Push API requires.
    expect(bytes[0]).toBe(4);
  });
});

describe('enablePushSubscription', () => {
  it('subscribes and registers the endpoint with the server', async () => {
    const env = installPushEnv();
    const register = vi.fn().mockResolvedValue(undefined);

    const result = await enablePushSubscription({ vapidPublicKey: VAPID, register });

    expect(result).toEqual({ ok: true, endpoint: 'https://push.example.com/new' });
    expect(env.subscribe).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith({
      endpoint: 'https://push.example.com/new',
      keys: { p256dh: 'p', auth: 'a' },
    });
  });

  it('passes the decoded VAPID key as applicationServerKey', async () => {
    const env = installPushEnv();
    await enablePushSubscription({ vapidPublicKey: VAPID, register: vi.fn() });

    const options = env.subscribe.mock.calls[0]?.[0] as { applicationServerKey: Uint8Array };
    expect(options.applicationServerKey.length).toBe(65);
  });

  // A refusal is a legitimate answer, and reporting it as success would leave
  // the member believing they will be told and never being told.
  it('reports a refused permission without subscribing', async () => {
    const env = installPushEnv();
    env.requestPermission.mockResolvedValue('denied');
    const register = vi.fn();

    const result = await enablePushSubscription({ vapidPublicKey: VAPID, register });

    expect(result.ok).toBe(false);
    expect(env.subscribe).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it('reports a dismissed prompt distinctly from a refusal', async () => {
    const env = installPushEnv();
    env.requestPermission.mockResolvedValue('default');

    const result = await enablePushSubscription({ vapidPublicKey: VAPID, register: vi.fn() });

    expect(result).toEqual({ ok: false, reason: 'dismissed' });
  });

  // The browser rotates a subscription silently. Re-registering the NEW
  // endpoint is correct and must not be skipped just because one existed.
  it('re-registers an existing subscription rather than assuming it is current', async () => {
    const existing = fakeSubscription('https://push.example.com/old');
    const env = installPushEnv(existing);
    const register = vi.fn().mockResolvedValue(undefined);

    const result = await enablePushSubscription({ vapidPublicKey: VAPID, register });

    expect(result).toEqual({ ok: true, endpoint: 'https://push.example.com/old' });
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'https://push.example.com/old' }),
    );
    // Reusing the existing one avoids a pointless round trip with the push
    // service.
    expect(env.subscribe).not.toHaveBeenCalled();
  });

  it('reports a registration failure rather than claiming success', async () => {
    installPushEnv();
    const register = vi.fn().mockRejectedValue(new Error('server said no'));

    const result = await enablePushSubscription({ vapidPublicKey: VAPID, register });

    expect(result.ok).toBe(false);
  });

  // A subscription missing `auth` cannot be encrypted to, so registering it
  // would create a row that fails on every send — reported rather than stored.
  it('refuses a subscription missing its encryption keys', async () => {
    const broken = {
      endpoint: 'https://push.example.com/broken',
      toJSON: () => ({ endpoint: 'https://push.example.com/broken', keys: { p256dh: 'p' } }),
      unsubscribe: vi.fn().mockResolvedValue(true),
    };
    installPushEnv(broken);
    const register = vi.fn();

    const result = await enablePushSubscription({ vapidPublicKey: VAPID, register });

    expect(result).toEqual({ ok: false, reason: 'subscribe-failed' });
    expect(register).not.toHaveBeenCalled();
  });

  it('reports unsupported when the platform cannot subscribe', async () => {
    Reflect.deleteProperty(globalThis, 'PushManager');
    Reflect.deleteProperty(window, 'PushManager');

    const result = await enablePushSubscription({ vapidPublicKey: VAPID, register: vi.fn() });

    expect(result).toEqual({ ok: false, reason: 'unsupported' });
  });
});

describe('disablePushSubscription', () => {
  it('unsubscribes in the browser and removes the server row', async () => {
    const existing = fakeSubscription('https://push.example.com/old');
    installPushEnv(existing);
    const unregister = vi.fn().mockResolvedValue(undefined);

    const result = await disablePushSubscription({ unregister });

    expect(result.ok).toBe(true);
    expect(existing.unsubscribe).toHaveBeenCalledTimes(1);
    // Addressed by the ENDPOINT that was live, before it is unsubscribed.
    expect(unregister).toHaveBeenCalledWith('https://push.example.com/old');
  });

  it('is a no-op when nothing is subscribed', async () => {
    installPushEnv(null);
    const unregister = vi.fn();

    const result = await disablePushSubscription({ unregister });

    expect(result.ok).toBe(true);
    expect(unregister).not.toHaveBeenCalled();
  });
});
