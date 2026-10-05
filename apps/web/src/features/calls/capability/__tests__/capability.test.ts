/**
 * @cytale/web — capability probe tests (calls V2 plan U6; KTD8 matrix).
 *
 * Classification under test:
 *   web build (no shell)          → 'available', zero media API calls
 *   API absent                    → 'unavailable', zero prompts
 *   present + dry-run works       → 'available', tracks stopped immediately
 *   present + NotSupportedError   → 'unavailable'  (the macOS trap: API
 *                                    presence ≠ working capture — research §1)
 *   present + timeout/hang        → 'unavailable'; a LATE track still stopped
 *   NotAllowedError               → 'denied' — retryable, NOT 'unavailable'
 *                                    (R12: never render user-denial as
 *                                    platform-incapability) — hence NOT sticky
 *   AbortError (picker dismissed) → 'denied' (user action, same rule)
 * Sticky facts cached per session; denials re-probe; concurrent probes
 * dedupe; runtime outcomes feed the cache via reportCaptureOutcome.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  captureSupport,
  reportCaptureOutcome,
  resetCapabilityCacheForTests,
  screenshareSupport,
} from '../capability.js';

// ---------------------------------------------------------------------------
// jsdom harness: shell global + mediaDevices stubs
// ---------------------------------------------------------------------------

function setTauriShell(on: boolean): void {
  const w = window as { __TAURI_INTERNALS__?: unknown };
  if (on) {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
  } else {
    delete w.__TAURI_INTERNALS__;
  }
}

function installMediaDevices(devices: Partial<MediaDevices> | undefined): void {
  if (devices === undefined) {
    // jsdom ships none; drop any prior stub
    delete (navigator as unknown as { mediaDevices?: MediaDevices }).mediaDevices;
  } else {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: devices,
    });
  }
}

interface TrackStub {
  stop: ReturnType<typeof vi.fn>;
}

function streamOf(tracks: TrackStub[]): MediaStream {
  return { getTracks: () => tracks } as unknown as MediaStream;
}

function errNamed(name: string): { name: string } {
  return { name };
}

beforeEach(() => {
  resetCapabilityCacheForTests();
});

afterEach(() => {
  resetCapabilityCacheForTests();
  setTauriShell(false);
  installMediaDevices(undefined);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Web build (KTD8 desktop gate — R12 "web build unaffected")
// ---------------------------------------------------------------------------

describe('capability probes — web build short-circuit', () => {
  it('both probes return available without touching any media API', async () => {
    setTauriShell(false); // a browser / the PWA — the full client
    const getDisplayMedia = vi.fn();
    const getUserMedia = vi.fn();
    installMediaDevices({ getDisplayMedia, getUserMedia });

    await expect(screenshareSupport()).resolves.toBe('available');
    await expect(captureSupport()).resolves.toBe('available');
    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('stays available even with mediaDevices wholly absent', async () => {
    setTauriShell(false);
    installMediaDevices(undefined);
    await expect(screenshareSupport()).resolves.toBe('available');
    await expect(captureSupport()).resolves.toBe('available');
  });
});

// ---------------------------------------------------------------------------
// API presence (desktop shell)
// ---------------------------------------------------------------------------

describe('capability probes — API absence in the shell', () => {
  it('no navigator.mediaDevices → unavailable (Linux posture)', async () => {
    setTauriShell(true);
    installMediaDevices(undefined);
    await expect(screenshareSupport()).resolves.toBe('unavailable');
    await expect(captureSupport()).resolves.toBe('unavailable');
  });

  it('getDisplayMedia missing while getUserMedia exists → screenshare unavailable only', async () => {
    setTauriShell(true);
    installMediaDevices({ getUserMedia: vi.fn(() => Promise.resolve(streamOf([{ stop: vi.fn() }]))) });

    await expect(screenshareSupport()).resolves.toBe('unavailable');
    await expect(captureSupport()).resolves.toBe('available');
  });
});

// ---------------------------------------------------------------------------
// Dry-run success (present + works)
// ---------------------------------------------------------------------------

describe('capability probes — present + works', () => {
  it('classifies available and stops the dry-run tracks immediately', async () => {
    setTauriShell(true);
    const stop = vi.fn();
    const getDisplayMedia = vi.fn(() => Promise.resolve(streamOf([{ stop }])));
    installMediaDevices({ getDisplayMedia });

    await expect(screenshareSupport()).resolves.toBe('available');
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1); // never a lingering camera LED
  });

  it('caches the sticky fact per session — second probe does not re-prompt', async () => {
    setTauriShell(true);
    const getDisplayMedia = vi.fn(() => Promise.resolve(streamOf([{ stop: vi.fn() }])));
    installMediaDevices({ getDisplayMedia });

    await expect(screenshareSupport()).resolves.toBe('available');
    await expect(screenshareSupport()).resolves.toBe('available');
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
  });

  it('capture probe covers mic+camera in one dry run', async () => {
    setTauriShell(true);
    const micStop = vi.fn();
    const camStop = vi.fn();
    const getUserMedia = vi.fn(() =>
      Promise.resolve(streamOf([{ stop: micStop }, { stop: camStop }])),
    );
    installMediaDevices({ getUserMedia });

    await expect(captureSupport()).resolves.toBe('available');
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: true });
    expect(micStop).toHaveBeenCalledTimes(1);
    expect(camStop).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Present + fails (the macOS probe-passes-but-fails trap — research §1)
// ---------------------------------------------------------------------------

describe('capability probes — present + fails', () => {
  it('NotSupportedError → unavailable (sticky)', async () => {
    setTauriShell(true);
    const getDisplayMedia = vi.fn(() => Promise.reject(errNamed('NotSupportedError')));
    installMediaDevices({ getDisplayMedia });

    await expect(screenshareSupport()).resolves.toBe('unavailable');
    await expect(screenshareSupport()).resolves.toBe('unavailable'); // cached
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
  });

  it('unknown error names are the honest unavailable too', async () => {
    setTauriShell(true);
    installMediaDevices({
      getDisplayMedia: vi.fn(() => Promise.reject(errNamed('SomeWebviewQuirk'))),
    });
    await expect(screenshareSupport()).resolves.toBe('unavailable');
  });

  it('NotFoundError (no device) → unavailable', async () => {
    setTauriShell(true);
    installMediaDevices({
      getUserMedia: vi.fn(() => Promise.reject(errNamed('NotFoundError'))),
    });
    await expect(captureSupport()).resolves.toBe('unavailable');
  });

  it('hang (never settling) times out to unavailable', async () => {
    setTauriShell(true);
    installMediaDevices({
      getDisplayMedia: vi.fn(() => new Promise<MediaStream>(() => {})),
    });
    await expect(screenshareSupport({ timeoutMs: 5 })).resolves.toBe('unavailable');
  });

  it('a track resolving AFTER the timeout is still stopped', async () => {
    setTauriShell(true);
    let lateResolve!: (s: MediaStream) => void;
    installMediaDevices({
      getDisplayMedia: vi.fn(
        () => new Promise<MediaStream>((resolve) => { lateResolve = resolve; }),
      ),
    });

    await expect(screenshareSupport({ timeoutMs: 5 })).resolves.toBe('unavailable');
    const stop = vi.fn();
    lateResolve(streamOf([{ stop }]));
    await Promise.resolve();
    await Promise.resolve();
    expect(stop).toHaveBeenCalledTimes(1); // no lingering capture either way
  });
});

// ---------------------------------------------------------------------------
// Denied vs unavailable (R12 honesty)
// ---------------------------------------------------------------------------

describe('capability probes — denial is not incapability', () => {
  it('NotAllowedError (user denied the probe) → denied, never unavailable', async () => {
    setTauriShell(true);
    installMediaDevices({
      getDisplayMedia: vi.fn(() => Promise.reject(errNamed('NotAllowedError'))),
    });
    await expect(screenshareSupport()).resolves.toBe('denied');
  });

  it('denied is retryable — NOT sticky: the next engagement re-probes', async () => {
    setTauriShell(true);
    let denied = true;
    const getDisplayMedia = vi.fn(() =>
      denied ? Promise.reject(errNamed('NotAllowedError')) : Promise.resolve(streamOf([{ stop: vi.fn() }])),
    );
    installMediaDevices({ getDisplayMedia });

    await expect(screenshareSupport()).resolves.toBe('denied');
    denied = false; // the user grants on retry
    await expect(screenshareSupport()).resolves.toBe('available');
    expect(getDisplayMedia).toHaveBeenCalledTimes(2);
  });

  it('AbortError (user dismissed the picker) → denied, not platform-incapable', async () => {
    setTauriShell(true);
    installMediaDevices({
      getDisplayMedia: vi.fn(() => Promise.reject(errNamed('AbortError'))),
    });
    await expect(screenshareSupport()).resolves.toBe('denied');
  });

  it('capture denial mirrors screenshare denial', async () => {
    setTauriShell(true);
    installMediaDevices({
      getUserMedia: vi.fn(() => Promise.reject(errNamed('NotAllowedError'))),
    });
    await expect(captureSupport()).resolves.toBe('denied');
  });
});

// ---------------------------------------------------------------------------
// Concurrency + runtime feedback
// ---------------------------------------------------------------------------

describe('capability probes — concurrency and runtime outcomes', () => {
  it('concurrent probes share one dry run (no double prompt)', async () => {
    setTauriShell(true);
    let resolveCapture!: (s: MediaStream) => void;
    const getDisplayMedia = vi.fn(
      () => new Promise<MediaStream>((resolve) => { resolveCapture = resolve; }),
    );
    installMediaDevices({ getDisplayMedia });

    const first = screenshareSupport();
    const second = screenshareSupport();
    resolveCapture(streamOf([{ stop: vi.fn() }]));
    await expect(first).resolves.toBe('available');
    await expect(second).resolves.toBe('available');
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
  });

  it('reportCaptureOutcome(success) caches available without probing', async () => {
    setTauriShell(true);
    const getDisplayMedia = vi.fn();
    installMediaDevices({ getDisplayMedia });

    reportCaptureOutcome('screenshare');
    await expect(screenshareSupport()).resolves.toBe('available');
    expect(getDisplayMedia).not.toHaveBeenCalled();
  });

  it('a runtime capture failure feeds the honest prompt (sticky unavailable)', async () => {
    setTauriShell(true);
    const getDisplayMedia = vi.fn();
    installMediaDevices({ getDisplayMedia });

    reportCaptureOutcome('screenshare', errNamed('NotSupportedError'));
    await expect(screenshareSupport()).resolves.toBe('unavailable');
    expect(getDisplayMedia).not.toHaveBeenCalled();
  });

  it('a runtime denial is not recorded as a platform fact', async () => {
    setTauriShell(true);
    let denied = true;
    const getUserMedia = vi.fn(() =>
      denied ? Promise.reject(errNamed('NotAllowedError')) : Promise.resolve(streamOf([{ stop: vi.fn() }])),
    );
    installMediaDevices({ getUserMedia });

    reportCaptureOutcome('capture', errNamed('NotAllowedError'));
    denied = false;
    await expect(captureSupport()).resolves.toBe('available'); // re-probed, user granted
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });
});
