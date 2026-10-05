/**
 * @cytale/web — the browser push subscription flow (notifications plan U6/U7).
 *
 * The missing half of web push. The server had a subscription store and a
 * sender, and the worker had a push handler, but nothing ever called
 * `pushManager.subscribe()` — so no browser could be reached and the whole
 * path was inert no matter how the server was configured.
 *
 * ## Re-subscribing is not an optimization, it is correctness
 *
 * A browser rotates its push subscription silently: endpoint changes, or the
 * subscription is dropped entirely, with no notification to the page. A server
 * row keyed by the OLD endpoint then fails forever, and the failure is
 * invisible — the member simply stops being told anything. So enabling
 * registers whatever the browser currently holds, every time, and disabling
 * unregisters by the endpoint that was actually live.
 *
 * ## Failures are states, not exceptions
 *
 * A refused permission, a dismissed prompt, an unsupported platform, and a
 * server rejection each resolve to a distinguishable result. The settings
 * surface renders them as themselves: a member who believes they will be told
 * — and is not — is the exact failure this feature exists to remove, so
 * nothing here may report success it did not achieve.
 */

/** Distinct outcomes, so a surface can say which one happened. */
export type PushEnableFailure =
  | 'unsupported'
  | 'denied'
  | 'dismissed'
  | 'subscribe-failed'
  | 'register-failed';

export type PushEnableResult =
  | { ok: true; endpoint: string }
  | { ok: false; reason: PushEnableFailure };

export type PushDisableResult = { ok: true } | { ok: false; reason: string };

export interface PushDeps {
  vapidPublicKey: string;
  /**
   * The browser's subscription, in the shape the server's route accepts. Named
   * keys rather than a loose record because the server rejects a body without
   * both — a subscription missing `auth` cannot be encrypted to.
   */
  register: (body: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  }) => Promise<unknown>;
}

export interface PushDisableDeps {
  unregister: (endpoint: string) => Promise<unknown>;
}

/**
 * Decode a base64url VAPID public key into the bytes the Push API wants.
 *
 * `applicationServerKey` takes an ArrayBuffer/Uint8Array, not a string, and
 * the conversion is not optional: passing the base64 text through produces a
 * subscription the push service will reject. Padding is restored because
 * base64url omits it.
 */
export function urlBase64ToUint8Array(base64Url: string): Uint8Array {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);

  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    bytes[i] = raw.charCodeAt(i);
  }
  return bytes;
}

/** Whether this browser can subscribe at all. */
export function canSubscribe(): boolean {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return false;
  if (!('serviceWorker' in navigator)) return false;
  if (!('PushManager' in window)) return false;
  return window.isSecureContext !== false;
}

/**
 * How long to wait for a service worker to become active.
 *
 * `navigator.serviceWorker.ready` NEVER SETTLES when no worker registers — it
 * is a promise that waits for one to appear, forever. A member clicking "Turn
 * on" while registration is pending (or broken, on an insecure origin, or
 * blocked by policy) would watch the button do nothing at all, with no error
 * and no way to tell whether it worked. Racing it turns a silent hang into a
 * reported failure.
 */
const WORKER_READY_TIMEOUT_MS = 10_000;

async function serviceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
  return await Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('service worker never became ready')), WORKER_READY_TIMEOUT_MS);
    }),
  ]);
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await serviceWorkerRegistration();
  return await registration.pushManager.getSubscription();
}

/**
 * Whether this browser actually holds a live push subscription right now.
 *
 * This is the fact a settings surface cannot infer from PERMISSION. A member
 * who granted the permission and then never turned notifications on — or who
 * turned them off on this device, or whose subscription was rotated away by
 * the browser — has `Notification.permission === 'granted'` and NO
 * subscription, so a surface driven by permission alone shows a checked,
 * "Notifications are on" box for a browser that can never receive anything.
 * That is the exact failure this feature exists to remove, and it is
 * self-contradicting the moment something else on the same screen (the test
 * button) reports the truth.
 *
 * Never throws and never hangs: a browser with no worker registered leaves
 * `navigator.serviceWorker.ready` pending forever, which is a "no" for this
 * question rather than an error to report.
 */
export async function hasPushSubscription(): Promise<boolean> {
  if (!canSubscribe()) return false;
  try {
    return (await currentSubscription()) !== null;
  } catch {
    return false;
  }
}

export async function enablePushSubscription(deps: PushDeps): Promise<PushEnableResult> {
  if (!canSubscribe()) return { ok: false, reason: 'unsupported' };

  // Permission first: subscribing without it throws, and the prompt is the
  // member's decision to make rather than a side effect of a click.
  const permission = await Notification.requestPermission();
  if (permission === 'denied') return { ok: false, reason: 'denied' };
  if (permission !== 'granted') return { ok: false, reason: 'dismissed' };

  let subscription: PushSubscription | null;
  try {
    const registration = await serviceWorkerRegistration();
    const existing = await registration.pushManager.getSubscription();

    // Reuse the existing subscription (no reason to churn the push service)
    // but ALWAYS re-register it: the server may never have seen this endpoint,
    // or may hold a stale one from a previous session.
    subscription =
      existing ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        // The cast is a lib-typing artifact: TypeScript's DOM lib wants an
        // ArrayBuffer-backed view, while `atob` produces one over a plain
        // ArrayBuffer. The bytes are what the Push API wants either way.
        applicationServerKey: urlBase64ToUint8Array(deps.vapidPublicKey) as BufferSource,
      }));
  } catch {
    return { ok: false, reason: 'subscribe-failed' };
  }

  const json = subscription.toJSON() as {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
  };

  const endpoint = json.endpoint ?? subscription.endpoint;
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;

  // Both keys are required — without them the server cannot encrypt a payload
  // to this subscription, so registering it would create a row that fails on
  // every send.
  if (!endpoint || !p256dh || !auth) return { ok: false, reason: 'subscribe-failed' };

  try {
    await deps.register({ endpoint, keys: { p256dh, auth } });
  } catch {
    return { ok: false, reason: 'register-failed' };
  }

  return { ok: true, endpoint };
}

export async function disablePushSubscription(
  deps: PushDisableDeps,
): Promise<PushDisableResult> {
  if (!canSubscribe()) return { ok: true };

  try {
    const subscription = await currentSubscription();
    if (!subscription) return { ok: true };

    // Deregister by the endpoint that is STILL live, before unsubscribing —
    // after `unsubscribe()` the browser may have forgotten it, and the server
    // row would be orphaned.
    try {
      await deps.unregister(subscription.endpoint);
    } catch {
      // The browser-side unsubscribe below is still worth doing: it stops
      // local delivery even if the server row lingers, and a lingering row is
      // pruned by the next 404/410 from the push service.
    }

    await subscription.unsubscribe();
    return { ok: true };
  } catch {
    return { ok: false, reason: 'unsubscribe-failed' };
  }
}
