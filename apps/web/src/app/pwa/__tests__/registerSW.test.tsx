/**
 * @cytale/web — U25 PWA shell tests (vitest + jsdom, no browser).
 *
 * Contract under test:
 *   1. manifest.json values (name, standalone, theme color == tokens dark
 *      background) — read as JSON, asserted against the theme source.
 *   2. vite.config.ts includes VitePWA with generateSW + prompt and the
 *      never-stale network-first strategy for /api/v1/* + the gateway URL
 *      (asserted as text invariants — no build needed).
 *   3. registerSW module exposes the hook contract and no-ops safely where
 *      serviceWorker is unavailable (jsdom default).
 *   4. Web Push capability detection: iOS < 16.4 hidden, ≥ 16.4 + desktop
 *      chromium shown, insecure context refused.
 *   5. useOnlineStatus tracks the online/offline events (offline banner).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import React from 'react';

import {
  registerServiceWorker,
  isWebPushSupported,
  webPushBlocker,
  isOffline,
  useOnlineStatus,
} from '../index.js';
import {
  applyUpdate,
  applyWaitingWorker,
  APPLY_RELOAD_FALLBACK_MS,
  getUpdateState,
  resetUpdateStateForTests,
  setUpdateStateForTests,
  startUpdatePolling,
  UPDATE_CHECK_MIN_GAP_MS,
  wireControllerTakeover,
} from '../registerSW.js';
import { UpdateAvailable } from '../UpdateAvailable.js';

const WEB_ROOT = join(__dirname, '..', '..', '..', '..');

// ---------------------------------------------------------------------------
// 1. Manifest contract
// ---------------------------------------------------------------------------

describe('manifest.json', () => {
  const manifest = JSON.parse(readFileSync(join(WEB_ROOT, 'public', 'manifest.json'), 'utf8')) as {
    name: string;
    display: string;
    theme_color: string;
    background_color: string;
    start_url: string;
    icons: { src: string; sizes: string; type: string; purpose: string }[];
  };

  it('is the Hrmny app, standalone, from root', () => {
    expect(manifest.name).toBe('Hrmny');
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
  });

  it('theme and background colors match the dark-default tokens (U18)', () => {
    // The theme IS tokens.css (the JS token mirror was retired); the dark
    // default background must match the PWA manifest colors.
    const tokens = readFileSync(
      join(WEB_ROOT, 'src', 'app', 'theme', 'tokens.css'),
      'utf8',
    );
    expect(tokens).toContain('--tk-background: #131416');
    expect(manifest.theme_color).toBe('#131416');
    expect(manifest.background_color).toBe('#131416');
  });

  it('declares any-purpose icons at 192 and 512 plus a maskable 512', () => {
    const anyIcons = manifest.icons.filter((i) => i.purpose === 'any');
    const maskable = manifest.icons.filter((i) => i.purpose === 'maskable');

    expect(anyIcons.map((i) => i.sizes).sort()).toEqual(['192x192', '512x512']);
    expect(maskable.map((i) => i.sizes)).toEqual(['512x512']);
    for (const icon of [...anyIcons, ...maskable]) {
      expect(icon.type).toBe('image/png');
    }
  });

  it('icon files exist on disk and are real PNGs with correct dimensions', () => {
    for (const icon of manifest.icons) {
      const path = join(WEB_ROOT, 'public', icon.src);
      const bytes = readFileSync(path);
      // PNG magic
      expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      // IHDR width/height at fixed offsets
      const width = bytes.readUInt32BE(16);
      const height = bytes.readUInt32BE(20);
      const [w, h] = icon.sizes.split('x').map((n) => parseInt(n, 10));
      expect(width).toBe(w);
      expect(height).toBe(h);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Vite config contract (text assertions — no build)
// ---------------------------------------------------------------------------

describe('vite.config.ts PWA wiring', () => {
  const config = readFileSync(join(WEB_ROOT, 'vite.config.ts'), 'utf8');

  it('uses vite-plugin-pwa in generateSW mode (pinned 2026-08-27)', () => {
    expect(config).toContain('VitePWA');
    // vite-plugin-pwa v1.x option name: strategies (generateSW | injectManifest)
    expect(config).toContain("strategies: 'generateSW'");
  });

  it('registers in prompt mode — an update waits for consent (lane D #6)', () => {
    expect(config).toContain("registerType: 'prompt'");
    expect(config).not.toContain("registerType: 'autoUpdate'");
  });

  it('never persists live data: /api/v1/* is NOT runtime-cached; the gateway probe is NetworkFirst', () => {
    // WEB-8 hardening (2026-09-25): the former NetworkFirst cache for
    // /api/v1/* stored message/channel bodies in Cache Storage — a
    // data-at-rest surface any same-origin script could read. Offline
    // rendering comes from the hydrated in-memory store instead, so the
    // correct contract is ABSENCE of any /api/v1 runtime cache entry.
    expect(config).not.toContain("startsWith('/api/v1/')");
    expect(config).not.toContain("cytale-api-v1");
    // The gateway probe stays uncached-live: NetworkFirst, never stale.
    expect(config).toContain('gateway/websocket');
    expect(config).toContain("'NetworkFirst'");
  });

  it('keeps the app shell on stale-while-revalidate', () => {
    expect(config).toContain("'StaleWhileRevalidate'");
  });

  it('no hand-written sw.js exists in the pwa surface', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const pwaDir = join(WEB_ROOT, 'src', 'app', 'pwa');
    const files = fs.readdirSync(pwaDir);
    expect(files.filter((f) => f.endsWith('sw.js'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. registerSW hook contract
// ---------------------------------------------------------------------------

describe('registerServiceWorker', () => {
  const originalNavigator = globalThis.navigator;

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it('no-ops safely when serviceWorker is unavailable (jsdom default)', () => {
    // jsdom does not implement serviceWorker — the call must not throw and
    // no hooks may fire.
    const onOfflineReady = vi.fn();
    const onRegistered = vi.fn();

    expect(() =>
      registerServiceWorker({ onOfflineReady, onRegistered }),
    ).not.toThrow();
    expect(onOfflineReady).not.toHaveBeenCalled();
    expect(onRegistered).not.toHaveBeenCalled();
  });

  it('accepts the full hook contract without error', () => {
    expect(() =>
      registerServiceWorker({
        onNeedRefresh: () => {},
        onOfflineReady: () => {},
        onRegistered: () => {},
        onRegisterError: () => {},
      }),
    ).not.toThrow();
  });

  it('isOffline reflects navigator.onLine', () => {
    expect(isOffline()).toBe(false); // jsdom default is online
  });
});

// ---------------------------------------------------------------------------
// 4. Web Push capability detection (iOS ≥ 16.4 gate)
// ---------------------------------------------------------------------------

describe('isWebPushSupported', () => {
  const originalNavigator = globalThis.navigator;
  const originalWindow = globalThis.window;

  function stubEnv(opts: {
    userAgent: string;
    maxTouchPoints?: number;
    serviceWorker?: boolean;
    pushManager?: boolean;
    secure?: boolean;
    /** iOS only: whether the page is running from the home screen. */
    standalone?: boolean;
    displayModeStandalone?: boolean;
  }): void {
    const nav = {
      userAgent: opts.userAgent,
      maxTouchPoints: opts.maxTouchPoints ?? 0,
      ...(opts.standalone === undefined ? {} : { standalone: opts.standalone }),
      ...(opts.serviceWorker === false ? {} : { serviceWorker: {} }),
    };
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: nav,
    });
    const win = {
      ...(opts.pushManager === false ? {} : { PushManager: function PushManager() {} }),
      isSecureContext: opts.secure ?? true,
      matchMedia: (query: string) => ({
        matches: opts.displayModeStandalone === true && query.includes('standalone'),
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }),
    };
    Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
  }

  afterEach(() => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator,
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    });
  });

  it('iPhone on iOS 15 → unsupported (subscription UI hidden entirely)', () => {
    stubEnv({
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 15_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1',
    });
    expect(isWebPushSupported()).toBe(false);
  });

  it('iPhone on iOS 16.4 AS AN INSTALLED PWA → supported', () => {
    stubEnv({
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Mobile/15E148 Safari/604.1',
      standalone: true,
    });
    expect(isWebPushSupported()).toBe(true);
  });

  // iOS delivers web push only to a home-screen app. A probe that stops at the
  // version hands the member an enable control that cannot succeed.
  it('iPhone on iOS 16.4 in a BROWSER TAB → unsupported (must be installed)', () => {
    stubEnv({
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Mobile/15E148 Safari/604.1',
      standalone: false,
    });
    expect(isWebPushSupported()).toBe(false);
    expect(webPushBlocker()).toBe('ios_install');
  });

  // The floor is 16.4, not 16.0 — the whole point of comparing the minor.
  it('iPhone on iOS 16.0 → unsupported (below the real floor)', () => {
    stubEnv({
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
      standalone: true,
    });
    expect(isWebPushSupported()).toBe(false);
    expect(webPushBlocker()).toBe('ios_update');
  });

  it('an installed PWA via the display-mode query is recognized', () => {
    stubEnv({
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      displayModeStandalone: true,
    });
    expect(isWebPushSupported()).toBe(true);
  });

  it('iPhone on iOS 17 as an installed PWA → supported', () => {
    stubEnv({
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      standalone: true,
    });
    expect(isWebPushSupported()).toBe(true);
  });

  it('iPadOS-13+-as-Mac with touch points is detected as iOS', () => {
    stubEnv({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Safari/605.1.15',
      maxTouchPoints: 5,
      standalone: true,
    });
    // iPad as Mac, installed → the version gate and the install gate both pass.
    expect(isWebPushSupported()).toBe(true);
  });

  it('desktop Chrome → supported (serviceWorker + PushManager)', () => {
    stubEnv({
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      serviceWorker: true,
      pushManager: true,
    });
    expect(isWebPushSupported()).toBe(true);
  });

  it('no PushManager (Firefox pre-2022 profile, old Safari) → unsupported', () => {
    stubEnv({
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      pushManager: false,
    });
    expect(isWebPushSupported()).toBe(false);
  });

  it('no serviceWorker → unsupported', () => {
    stubEnv({
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      serviceWorker: false,
    });
    expect(isWebPushSupported()).toBe(false);
  });

  it('insecure context → unsupported (SWs cannot register)', () => {
    stubEnv({
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      secure: false,
    });
    expect(isWebPushSupported()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Offline indicator (banner + hook)
// ---------------------------------------------------------------------------

function HookProbe(): React.ReactElement {
  const online = useOnlineStatus();
  return <div data-testid="probe">{online ? 'online' : 'offline'}</div>;
}

describe('useOnlineStatus', () => {
  afterEach(cleanup);

  it('starts online in jsdom and flips on the offline event', () => {
    render(<HookProbe />);
    expect(screen.getByTestId('probe').textContent).toBe('online');

    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(screen.getByTestId('probe').textContent).toBe('offline');

    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(screen.getByTestId('probe').textContent).toBe('online');
  });

  it('shares ONE online/offline listener pair across every consumer', () => {
    // The message list mounts this hook per visible row; before the shared
    // subscription each row attached its own pair.
    cleanup(); // start from a fully detached singleton
    const addSpy = vi.spyOn(window, 'addEventListener');

    const { unmount } = render(
      <>
        <HookProbe />
        <HookProbe />
        <HookProbe />
      </>,
    );

    const added = (type: string) => addSpy.mock.calls.filter(([t]) => t === type).length;
    expect(added('online')).toBe(1);
    expect(added('offline')).toBe(1);

    // All three observe the same transition…
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(screen.getAllByTestId('probe').map((el) => el.textContent)).toEqual([
      'offline',
      'offline',
      'offline',
    ]);

    // …and the pair is released with the last consumer.
    unmount();
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const second = render(<HookProbe />); // re-attaches the pair
    second.unmount(); // …and releases it
    expect(removeSpy.mock.calls.filter(([t]) => t === 'online').length).toBe(1);
    addSpy.mockRestore();
    removeSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 3b. Prompt take-over (stale-bundle hardening, 2026-09-10)
// ---------------------------------------------------------------------------

describe('wireControllerTakeover', () => {
  function fakeContainer(controller: ServiceWorker | null) {
    const listeners: Array<() => void> = [];
    return {
      controller,
      addEventListener: (_: string, cb: EventListenerOrEventListenerObject) => {
        listeners.push(cb as () => void);
      },
      fire: () => listeners.forEach((cb) => cb()),
    };
  }

  it('REPORTS (once) — never reloads — when a new worker takes over an already-controlled page', () => {
    const onTakeover = vi.fn();
    const container = fakeContainer({} as ServiceWorker); // existing controller
    wireControllerTakeover(container, onTakeover);

    container.fire();
    expect(onTakeover).toHaveBeenCalledTimes(1);
    container.fire();
    expect(onTakeover).toHaveBeenCalledTimes(1);
  });

  it('does NOT report on the first install (no prior controller)', () => {
    const onTakeover = vi.fn();
    const container = fakeContainer(null); // first install
    wireControllerTakeover(container, onTakeover);
    container.fire();
    expect(onTakeover).not.toHaveBeenCalled();
  });
});

describe('startUpdatePolling', () => {
  function fakeWindow() {
    const handlers = new Map<string, () => void>();
    return {
      handlers,
      setInterval: ((cb: () => void) => {
        handlers.set('interval', cb);
        return 1 as unknown as ReturnType<typeof setInterval>;
      }) as unknown as Window['setInterval'],
      addEventListener: ((type: string, cb: () => void) => {
        handlers.set(type, cb);
      }) as unknown as Window['addEventListener'],
    };
  }

  it('checks for updates on focus/visibilitychange (throttled) and the interval', () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const win = fakeWindow();
    let clock = 1_000_000;
    startUpdatePolling({ update }, win, () => clock);

    win.handlers.get('focus')!();
    expect(update).toHaveBeenCalledTimes(1);
    // A visibility flip right after the focus check is the same check.
    win.handlers.get('visibilitychange')!();
    expect(update).toHaveBeenCalledTimes(1);
    clock += UPDATE_CHECK_MIN_GAP_MS;
    win.handlers.get('visibilitychange')!();
    expect(update).toHaveBeenCalledTimes(2);
    win.handlers.get('interval')!();
    expect(update).toHaveBeenCalledTimes(3);
  });

  it('swallows update failures (offline tabs must not throw from a timer)', () => {
    const update = vi.fn().mockRejectedValue(new Error('offline'));
    const win = fakeWindow();
    startUpdatePolling({ update }, win);
    expect(() => win.handlers.get('interval')!()).not.toThrow();
  });
});

describe('UpdateAvailable (lane D #6)', () => {
  afterEach(() => {
    resetUpdateStateForTests();
    cleanup();
  });

  it('renders nothing until an update is waiting', () => {
    render(<UpdateAvailable />);
    expect(screen.queryByTestId('update-available')).toBeNull();
    expect(getUpdateState()).toBe('none');
  });

  it('shows a non-blocking Reload once an update is waiting, and can be dismissed', () => {
    render(<UpdateAvailable />);
    act(() => setUpdateStateForTests('available'));
    expect(screen.getByTestId('update-available').textContent).toMatch(/update is available/i);
    act(() => screen.getByTestId('update-available-dismiss').click());
    expect(screen.queryByTestId('update-available')).toBeNull();
  });

  it('applyUpdate without a waiting worker falls back to a plain reload', () => {
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, reload } });
    try {
      applyUpdate();
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });
});

describe('applyWaitingWorker (owner report 2026-09-28: Reload did nothing)', () => {
  function fakeWaiting() {
    const listeners: Array<() => void> = [];
    const worker = {
      state: 'installed' as ServiceWorkerState,
      addEventListener: (_: string, l: () => void) => listeners.push(l),
      activate() {
        this.state = 'activated';
        for (const l of listeners) l();
      },
    };
    return worker;
  }

  it('reloads once the waiting worker is ACTIVATED — even on an uncontrolled (hard-reloaded) page', async () => {
    const waiting = fakeWaiting();
    const reload = vi.fn();
    const timers = { setTimeout: vi.fn() };
    const updateSW = vi.fn(async () => {});
    applyWaitingWorker(
      updateSW,
      { waiting } as unknown as ServiceWorkerRegistration,
      reload,
      timers as unknown as Window,
    );
    expect(updateSW).toHaveBeenCalledWith(true);
    expect(reload).not.toHaveBeenCalled();
    waiting.activate();
    expect(reload).toHaveBeenCalledTimes(1);
    // The backstop firing later does not reload a second time.
    const backstop = timers.setTimeout.mock.calls[0]![0] as () => void;
    expect(timers.setTimeout.mock.calls[0]![1]).toBe(APPLY_RELOAD_FALLBACK_MS);
    backstop();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('the backstop reloads when no activation is ever seen', () => {
    const reload = vi.fn();
    const timers = { setTimeout: vi.fn() };
    applyWaitingWorker(async () => {}, undefined, reload, timers as unknown as Window);
    expect(reload).not.toHaveBeenCalled();
    (timers.setTimeout.mock.calls[0]![0] as () => void)();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('a failed skip-waiting still reloads', async () => {
    const reload = vi.fn();
    applyWaitingWorker(
      () => Promise.reject(new Error('no worker')),
      undefined,
      reload,
      { setTimeout: vi.fn() } as unknown as Window,
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
