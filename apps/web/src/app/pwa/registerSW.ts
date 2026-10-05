/**
 * @cytale/web — service-worker registration and the update hand-off (U25;
 * lane D #6).
 *
 * Registers the generateSW-produced service worker via vite-plugin-pwa's
 * `virtual:pwa-register` module — no hand-written sw.js.
 *
 * UPDATES NEVER RELOAD A PAGE WITHOUT CONSENT (lane D #6). The first design
 * (2026-08-27) was `autoUpdate`; the 2026-09-10 hardening added a
 * `controllerchange → location.reload()` take-over and a 5-minute update poll,
 * so a deploy reloaded every open tab mid-session — mid-sentence in the
 * composer, mid-call, mid-scroll. The registration is now `prompt`:
 *
 *   * a new worker installs and WAITS; `onNeedRefresh` marks an update as
 *     available and the app shows a small non-blocking "Update available —
 *     Reload" affordance (`UpdateAvailable.tsx`). The member's click applies
 *     it (skip-waiting + one reload);
 *   * at BOOT — before the member has interacted — a waiting worker is
 *     applied at once: that is the "next navigation" the update belongs to,
 *     and reloading a page nobody has touched costs nothing;
 *   * a worker another tab activated (skip-waiting reaches every tab) is
 *     reported the same way — "Reload to finish updating" — never obeyed with
 *     a reload of THIS tab;
 *   * update checks stay (so a long-lived tab still learns of a deploy) but
 *     are rarer, and only while the tab is visible.
 *
 * Registration waits for the page's `load` event so the worker's precache
 * download never competes with the boot's own requests.
 *
 * Everything degrades to a no-op where service workers are unavailable (SSR,
 * tests without a serviceWorker stub, the desktop shell): the hooks simply
 * never fire.
 */

import { registerSW as viteRegisterSW } from 'virtual:pwa-register';

import { isTauri } from '../../tauri/index.js';

/** How often a visible tab re-checks for a new worker. */
export const UPDATE_CHECK_INTERVAL_MS = 30 * 60_000;

/** Visibility/focus checks closer together than this are one check. */
export const UPDATE_CHECK_MIN_GAP_MS = 10 * 60_000;

/**
 * A waiting worker found this soon after boot, before any interaction, is
 * applied at once (the reload lands before the member has done anything).
 */
export const BOOT_APPLY_WINDOW_MS = 3_000;

/** The backstop reload after Reload is clicked, should no activation be seen. */
export const APPLY_RELOAD_FALLBACK_MS = 3_000;

export interface RegisterSWHooks {
  /** A new version is installed and waiting (the affordance's trigger). */
  onNeedRefresh?: () => void;
  /** Precache finished — the app shell is ready to load offline. */
  onOfflineReady?: () => void;
  /** The service worker registered; carries the registration for push use. */
  onRegistered?: (registration: ServiceWorkerRegistration | undefined) => void;
  /** Registration failed (insecure origin, storage blocked, etc.). */
  onRegisterError?: (error: unknown) => void;
}

// ---------------------------------------------------------------------------
// The update-available signal (read by UpdateAvailable.tsx)
// ---------------------------------------------------------------------------

type UpdateState = 'none' | 'available' | 'activated-elsewhere';

let updateState: UpdateState = 'none';
let applyUpdateImpl: (() => void) | null = null;
const listeners = new Set<() => void>();

function setUpdateState(next: UpdateState): void {
  if (updateState === next) return;
  updateState = next;
  for (const l of [...listeners]) l();
}

/** The current update state (`useSyncExternalStore` snapshot). */
export function getUpdateState(): UpdateState {
  return updateState;
}

/** Subscribe to update-state changes; returns the unsubscribe. */
export function subscribeUpdateState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Apply the update the member consented to: activate the waiting worker and
 * reload once (or, when another tab already activated it, just reload).
 */
export function applyUpdate(): void {
  if (applyUpdateImpl !== null) {
    applyUpdateImpl();
    return;
  }
  if (typeof window !== 'undefined') window.location.reload();
}

/** Test-only: drive the update signal directly. */
export function setUpdateStateForTests(next: UpdateState): void {
  setUpdateState(next);
}

/** Test-only: reset the module's update signal. */
export function resetUpdateStateForTests(): void {
  updateState = 'none';
  applyUpdateImpl = null;
  listeners.clear();
}

/**
 * Activate the waiting worker and reload ONCE it is active. vite-plugin-pwa's
 * `updateSW(true)` reloads only on `controllerchange`, and a page that was
 * hard-reloaded (Shift/Ctrl+Reload bypasses the worker) is UNCONTROLLED, so
 * that event never comes: the click posted skip-waiting and then did nothing
 * (owner report 2026-09-28). Reload on the waiting worker reaching
 * `activated` instead, whoever controls the page, with a timed backstop.
 * Exported for tests.
 */
export function applyWaitingWorker(
  updateSW: ((reloadPage?: boolean) => Promise<void>) | undefined,
  registration: Pick<ServiceWorkerRegistration, 'waiting'> | undefined,
  reload: () => void = () => window.location.reload(),
  timers: Pick<Window, 'setTimeout'> = window,
): void {
  let done = false;
  const go = (): void => {
    if (done) return;
    done = true;
    reload();
  };
  const waiting = registration?.waiting ?? null;
  if (waiting !== null) {
    waiting.addEventListener('statechange', () => {
      if (waiting.state === 'activated') go();
    });
  }
  timers.setTimeout(go, APPLY_RELOAD_FALLBACK_MS);
  void Promise.resolve(updateSW?.(true)).catch(go);
}

// ---------------------------------------------------------------------------
// Controller changes (another tab's activation)
// ---------------------------------------------------------------------------

type SWContainer = Pick<ServiceWorkerContainer, 'controller' | 'addEventListener'>;

/**
 * Report (never obey) a new worker taking control of an ALREADY-controlled
 * page: skip-waiting in ANY tab hands every tab to the new worker, while this
 * tab still runs the old bundle. `onTakeover` fires once; the caller decides
 * what the member sees. Exported for tests.
 *
 * The `controller === null` guard is load-bearing: a first install claims the
 * page too, which fires `controllerchange` — that is not an update.
 */
export function wireControllerTakeover(container: SWContainer, onTakeover: () => void): void {
  const hadController = container.controller !== null;
  let reported = false;

  container.addEventListener('controllerchange', () => {
    if (!hadController || reported) return;
    reported = true;
    onTakeover();
  });
}

/**
 * Check the registration for updates: on an interval, and when the tab
 * becomes visible or focused (throttled). Hidden tabs never check. Failures
 * are swallowed — an offline tab must not throw from a timer. Checking is all
 * this does: an update found here waits for consent.
 */
export function startUpdatePolling(
  registration: Pick<ServiceWorkerRegistration, 'update'>,
  win: Pick<Window, 'addEventListener' | 'setInterval'> = window,
  now: () => number = () => Date.now(),
): void {
  let lastCheck = -Infinity;
  const check = (force: boolean): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (!force && now() - lastCheck < UPDATE_CHECK_MIN_GAP_MS) return;
    lastCheck = now();
    void Promise.resolve(registration.update()).catch(() => undefined);
  };

  win.setInterval(() => check(true), UPDATE_CHECK_INTERVAL_MS);
  win.addEventListener('focus', () => check(false));
  win.addEventListener('visibilitychange', () => check(false));
}

/** Run `fn` once the page has loaded (now, when it already has). */
function afterLoad(fn: () => void): void {
  if (typeof document === 'undefined' || document.readyState === 'complete') {
    fn();
    return;
  }
  window.addEventListener('load', () => fn(), { once: true });
}

/**
 * Register the service worker (prompt mode). Safe to call unconditionally at
 * app entry; no-ops where service workers are unavailable.
 */
export function registerServiceWorker(hooks: RegisterSWHooks = {}): void {
  // Guard: virtual module still loads without SW support, but the call would
  // reject; degrade silently where there is nothing to register.
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return;
  }

  // Never in the desktop shell. The shell already owns the bundle (it is
  // installed, not fetched), and if the worker did take control there the
  // cache strategies would fight it: `networkTimeoutSeconds: 5` serves a
  // CACHED API body for any call slower than 5s. Offline support in the shell
  // is moot.
  if (isTauri()) return;

  const bootAt = Date.now();
  let interacted = false;
  const markInteracted = () => {
    interacted = true;
  };
  window.addEventListener('pointerdown', markInteracted, { once: true, capture: true });
  window.addEventListener('keydown', markInteracted, { once: true, capture: true });

  // Another tab's activation: this tab keeps running the old bundle until the
  // member reloads it — say so, never reload it for them.
  wireControllerTakeover(navigator.serviceWorker, () => {
    if (updateState === 'none') setUpdateState('activated-elsewhere');
  });

  afterLoad(() => {
    let swRegistration: ServiceWorkerRegistration | undefined;
    const updateSW = viteRegisterSW({
      immediate: true,
      onNeedRefresh: () => {
        hooks.onNeedRefresh?.();
        applyUpdateImpl = () => applyWaitingWorker(updateSW, swRegistration);
        // A worker already waiting at boot belongs to THIS navigation: apply
        // it before the member has touched anything.
        if (!interacted && Date.now() - bootAt < BOOT_APPLY_WINDOW_MS) {
          applyUpdateImpl();
          return;
        }
        setUpdateState('available');
      },
      onOfflineReady: hooks.onOfflineReady,
      onRegistered: (registration) => {
        swRegistration = registration;
        hooks.onRegistered?.(registration);
        if (registration) startUpdatePolling(registration);
      },
      onRegisterError: hooks.onRegisterError,
    });
  });
}
