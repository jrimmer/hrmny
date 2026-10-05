/**
 * @cytale/mobile — the dev-only JSON sink (media spike, step 2).
 *
 * Why this exists: on RN 0.86 `console.log` reaches NEITHER `adb logcat` NOR
 * Metro's log when `expo start` runs without a TTY, so a device-side result
 * that is only logged has no reachable reader. Everything the spike measures
 * therefore POSTs to a tiny listener on the host instead — the Android device
 * reaches it through `adb reverse tcp:41999 tcp:41999`
 * (`scripts/probe-sink.mjs` appends one JSON line per request).
 *
 * Opt-in and dev-only: active only when `__DEV__` AND
 * `EXPO_PUBLIC_CYTALE_PROBE_SINK` is a non-empty URL. A normal run has no sink
 * and every call here is a no-op, so nothing leaks into a shipped build.
 *
 * Delivery is best-effort by design: a probe must never take the app down, and
 * a missing listener is a normal state (the app is often started before the
 * sink). Failures are swallowed.
 */

/** The configured sink URL, or null when the sink is off. */
export function sinkUrl(): string | null {
  if (!__DEV__) return null;
  const raw = process.env.EXPO_PUBLIC_CYTALE_PROBE_SINK;
  return typeof raw === 'string' && raw !== '' ? raw : null;
}

/** True when a sink is configured (callers use it to skip expensive work). */
export function sinkEnabled(): boolean {
  return sinkUrl() !== null;
}

/**
 * POST one result to the sink. Never throws, never blocks a caller that does
 * not await it, and tags every payload so a mixed log is still readable.
 */
export async function reportToSink(tag: string, payload: Record<string, unknown>): Promise<void> {
  const url = sinkUrl();
  if (url === null) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tag, at: new Date().toISOString(), ...payload }),
    });
  } catch {
    // No listener, no network, or the app is shutting down — all normal.
  }
}
