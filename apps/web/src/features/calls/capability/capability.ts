/**
 * @cytale/web — desktop webview media capability probes (calls V2 plan U6;
 * KTD8, R12; origin research §1 — the macOS trap).
 *
 * Why this exists: API presence ≠ working capture. macOS WKWebView can
 * expose `getDisplayMedia`, pass every presence check, and still fail or
 * hang at capture time (wry #1195's permission-responder conflict); Linux
 * WebKitGTK lacks working WebRTC capture entirely. So a probe is TWO
 * steps: (1) API presence, (2) a DRY-RUN capture attempt whose tracks are
 * stopped immediately.
 *
 * Contract (KTD8):
 *   - LAZY: call these only on affordance engagement (a click). The dry
 *     run's permission prompt doubles as the probe — never probe from
 *     render, never trigger an unprompted camera LED.
 *   - DESKTOP-GATED: the web build IS the full client (R12 — "web build
 *     unaffected"); outside the Tauri shell both probes short-circuit to
 *     `'available'` without touching any media API.
 *   - CACHED per session for stable facts; see `probe()` below for the
 *     one deliberate exception (denial).
 *   - CLASSIFICATION:
 *       success                                      → 'available'
 *       API absent                                   → 'unavailable'
 *       NotSupportedError / any capture error that   → 'unavailable'
 *         is not a user refusal (NotFoundError,
 *         OverconstrainedError, unknown…) — and the
 *         macOS trap's timeout/hang
 *       NotAllowedError (user denied the probe)      → 'denied'   — retryable
 *       AbortError (user dismissed the picker)       → 'denied'   — retryable
 *
 * R12 honesty rule, load-bearing: a USER refusal ('denied') must NEVER be
 * rendered as platform incapability. 'denied' is deliberately NOT sticky —
 * the affordance offers retry guidance and the next engagement re-probes
 * (the user may grant this time). 'available'/'unavailable' are platform
 * facts and stick for the session.
 */

import { isTauri } from '../../../tauri/index.js';

/** Outcome of a capability probe. */
export type CapabilityStatus = 'available' | 'denied' | 'unavailable';

/** The two probed surfaces. */
export type CapabilityKind = 'screenshare' | 'capture';

/** Advanced probe options (tests use `timeoutMs`; production never passes any). */
export interface CapabilityProbeOptions {
  /**
   * How long the dry-run capture may take before it is classified a hang
   * ('unavailable'). Generous by default because the timer covers the
   * user's own interaction with the real permission/screen picker.
   */
  timeoutMs?: number;
}

/**
 * Default dry-run budget. The macOS trap manifests as a prompt that never
 * resolves; 30s is far past any deliberate picker interaction yet bounded
 * enough that a hung webview cannot wedge the affordance for the session.
 */
export const CAPABILITY_PROBE_TIMEOUT_MS = 30_000;

/**
 * Sticky results live here ('available' | 'unavailable'); denial is
 * intentionally absent (see module doc). Module scope = per session/page.
 */
const cache = new Map<CapabilityKind, CapabilityStatus>();

/** In-flight probes, so two affordances never double-prompt. */
const inFlight = new Map<CapabilityKind, Promise<CapabilityStatus>>();

/**
 * Can this webview share a screen at all? Probes `getDisplayMedia`
 * presence + a video-only dry run (no share-audio — the question is
 * screen capture itself).
 */
export function screenshareSupport(
  options: CapabilityProbeOptions = {},
): Promise<CapabilityStatus> {
  return probe('screenshare', options);
}

/**
 * Can this webview capture mic/camera at all? Probes `getUserMedia`
 * presence + a combined audio+video dry run (KTD8: also feeds camera/mic
 * affordance gating where capture is wholly absent, e.g. Linux).
 */
export function captureSupport(options: CapabilityProbeOptions = {}): Promise<CapabilityStatus> {
  return probe('capture', options);
}

/**
 * Feed a REAL capture attempt's outcome back into the cache (plan U6:
 * "probe failure or runtime capture failure both route to the honest
 * prompt"). Call with no argument on success, with the thrown error on
 * failure. Stable facts stick; denial stays non-sticky by design.
 */
export function reportCaptureOutcome(kind: CapabilityKind, error?: unknown): void {
  if (error === undefined) {
    cache.set(kind, 'available');
    return;
  }
  if (classifyError(error) === 'unavailable') {
    cache.set(kind, 'unavailable');
  }
  // 'denied' from a live capture is the user's refusal of the real prompt —
  // not recorded, so the affordance's retry re-probes honestly.
}

/** Test-only: wipe the per-session cache (jsdom suites run in one page). */
export function resetCapabilityCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}

async function probe(
  kind: CapabilityKind,
  options: CapabilityProbeOptions,
): Promise<CapabilityStatus> {
  // Desktop gate (KTD8): the web build is the full client — never probe,
  // never prompt, never doubt it.
  if (!isTauri()) return 'available';

  const cached = cache.get(kind);
  if (cached === 'available' || cached === 'unavailable') return cached;

  const existing = inFlight.get(kind);
  if (existing) return existing;

  const run = dryRun(kind, options.timeoutMs ?? CAPABILITY_PROBE_TIMEOUT_MS)
    .catch(() => 'unavailable' as const) // defensive: classification never throws
    .then((status) => {
      inFlight.delete(kind);
      if (status !== 'denied') cache.set(kind, status);
      return status;
    });
  inFlight.set(kind, run);
  return run;
}

async function dryRun(kind: CapabilityKind, timeoutMs: number): Promise<CapabilityStatus> {
  // Step 1 — API presence.
  if (typeof navigator === 'undefined' || !navigator.mediaDevices) return 'unavailable';
  const devices = navigator.mediaDevices;
  const acquire: () => Promise<MediaStream> =
    kind === 'screenshare'
      ? () => {
          if (typeof devices.getDisplayMedia !== 'function') {
            return Promise.reject(notSupported());
          }
          return devices.getDisplayMedia({ video: true });
        }
      : () => {
          if (typeof devices.getUserMedia !== 'function') {
            return Promise.reject(notSupported());
          }
          return devices.getUserMedia({ audio: true, video: true });
        };

  // Step 2 — the dry-run attempt, raced against a hang. A late-resolving
  // stream (after the timeout fired) still gets its tracks stopped: a
  // classified-incapable webview must never leave a camera LED on.
  return new Promise<CapabilityStatus>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve('unavailable'); // timeout/hang → incapable (KTD8)
    }, timeoutMs);

    acquire()
      .then((stream) => {
        for (const track of stream.getTracks()) track.stop();
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve('available');
      })
      .catch((err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(classifyError(err));
      });
  });
}

/**
 * KTD8 classification. Everything that is not a user refusal — including
 * errors this module has never heard of — is the honest 'unavailable':
 * the webview could not produce a capture, whatever the reason.
 */
function classifyError(err: unknown): CapabilityStatus {
  const name = (err as { name?: unknown } | null | undefined)?.name;
  if (name === 'NotAllowedError' || name === 'AbortError') return 'denied';
  return 'unavailable';
}

/** The synthetic absence error for a missing API (presence-check failure). */
function notSupported(): { name: string } {
  return { name: 'NotSupportedError' };
}
