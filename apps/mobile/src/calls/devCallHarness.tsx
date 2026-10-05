/**
 * @cytale/mobile — the headless call harness (media spike, step 2).
 *
 * Drives a REAL call from a real device with no UI interaction, and reports
 * every fact to the dev sink. This exists because the spike's decisive question
 * — "does the RN client complete a WebRTC negotiation against our SFU?" — was
 * otherwise gated behind driving the sign-in form and the drawer through
 * `adb input`, which is fragile and not part of what is being tested.
 *
 * Sequence, each step reported:
 *   1. sign in with `EXPO_PUBLIC_CYTALE_PROBE_USER` / `_PASS` (headless login
 *      through the session manager — the same code path the form uses);
 *   2. measure IDLE JS frame deltas for `FRAME_WINDOW_MS`;
 *   3. `engine.join(EXPO_PUBLIC_CYTALE_PROBE_CHANNEL)`, reporting every engine
 *      snapshot transition (this is the interop evidence);
 *   4. once the leg is `connected`, measure IN-CALL frame deltas for the same
 *      window — the same screen, so the difference is attributable to the call.
 *
 * Opt-in and dev-only three times over: `__DEV__`, a sink URL, and both
 * credential vars set. With any of them absent this component renders nothing
 * and does nothing. Mounted next to `RootNavigator` so it runs inside the ONE
 * SessionProvider without adding a route.
 *
 * Its numbers are a DELTA on one screen, not a scroll benchmark: rAF deltas
 * measure the JS/UI pipeline that a live call competes for, which is the
 * question the "native is faster" intuition is actually about. A scrollback
 * scroll-under-load benchmark is a bigger instrument and is not attempted here.
 */
import { useEffect, useRef, useState } from 'react';

import { onCallSignal } from '@cytale/calls';

import { getCallEngine } from './wiring';
import { reportToSink, sinkEnabled } from './devSink';
import { useSession } from '../navigation/session';

/** How long each frame sample runs. */
const FRAME_WINDOW_MS = 4_000;
/** Delay between the idle sample and the join, so the two never overlap. */
const JOIN_DELAY_MS = 1_000;

interface FrameStats {
  samples: number;
  p50: number;
  p95: number;
  p99: number;
  worst: number;
  fps: number;
}

/**
 * Sample `requestAnimationFrame` deltas for `ms` and summarise them.
 *
 * rAF deltas are the cadence the JS thread + UI pipeline can sustain; a busy
 * call (media stats polling, track events, playback) shows up as a longer tail
 * here. Rounded to 0.1 ms because sub-microsecond precision is noise.
 */
async function sampleFrames(ms: number): Promise<FrameStats> {
  return new Promise((resolve) => {
    const deltas: number[] = [];
    const start = Date.now();
    let last = 0;

    const tick = (now: number): void => {
      if (last !== 0) deltas.push(now - last);
      last = now;
      if (Date.now() - start >= ms) {
        resolve(summarise(deltas, ms));
        return;
      }
      requestAnimationFrame(tick);
    };

    requestAnimationFrame(tick);
  });
}

/** Percentile helper over an unsorted sample. */
function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return sorted[index] ?? 0;
}

function summarise(deltas: number[], windowMs: number): FrameStats {
  const sorted = [...deltas].sort((a, b) => a - b);
  const round = (n: number): number => Math.round(n * 10) / 10;
  return {
    samples: sorted.length,
    p50: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    p99: round(percentile(sorted, 0.99)),
    worst: round(sorted[sorted.length - 1] ?? 0),
    fps: Math.round((sorted.length / windowMs) * 1000),
  };
}

/** Auth status of the injected manager, tracked without pulling in the gate. */
function useAuthStatus(): string {
  const manager = useSession();
  const [status, setStatus] = useState<string>(() => manager.authStore.getState().status);
  useEffect(
    () => manager.authStore.subscribe(() => setStatus(manager.authStore.getState().status)),
    [manager],
  );
  return status;
}

export function DevCallHarness(): null {
  const manager = useSession();
  const status = useAuthStatus();

  const loginAttempted = useRef(false);
  const runStarted = useRef(false);

  const user = process.env.EXPO_PUBLIC_CYTALE_PROBE_USER;
  const pass = process.env.EXPO_PUBLIC_CYTALE_PROBE_PASS;
  const channel = process.env.EXPO_PUBLIC_CYTALE_PROBE_CHANNEL;
  const active = __DEV__ && sinkEnabled() && typeof user === 'string' && typeof pass === 'string';

  // 0. Trace every CALL_SIGNAL the app receives. This is the diagnostic that
  //    separates two very different failures: "the SFU never reached us"
  //    (wiring) vs "we negotiated but ICE never connected" (a media-path
  //    problem, and on an emulator behind `adb reverse` — which forwards TCP
  //    only — the expected one).
  useEffect(() => {
    if (!active) return undefined;
    return onCallSignal((frame) => {
      let kind = 'unknown';
      try {
        kind = (JSON.parse(frame.body) as { type?: string }).type ?? 'unknown';
      } catch {
        kind = 'unparseable';
      }
      void reportToSink('call-signal', {
        channelId: frame.channel_id,
        kind,
        bytes: frame.body.length,
      });
    });
  }, [active]);

  // 1. Headless sign-in (the form's own path: manager.login).
  useEffect(() => {
    if (!active || loginAttempted.current) return;
    if (status !== 'unauthenticated') return;
    loginAttempted.current = true;
    void reportToSink('harness', { step: 'login', user });
    manager
      .login(user, pass)
      .then(() => reportToSink('harness', { step: 'login', ok: true }))
      .catch((err: unknown) =>
        reportToSink('harness', { step: 'login', ok: false, error: String(err) }),
      );
  }, [active, manager, pass, status, user]);

  // 2-4. Idle sample → join → in-call sample, once we are authenticated.
  useEffect(() => {
    if (!active || runStarted.current || status !== 'authenticated') return;
    if (typeof channel !== 'string' || channel === '') {
      void reportToSink('harness', { step: 'join', ok: false, error: 'no probe channel configured' });
      return;
    }
    runStarted.current = true;

    const engine = getCallEngine(manager);
    let sawConnected = false;

    const unsubscribe = engine.subscribe(() => {
      const s = engine.getSnapshot();
      void reportToSink('call-state', {
        voice: s.voice.status,
        pcConnected: s.voice.pcConnected,
        micGranted: s.voice.micGranted,
        micDenied: s.voice.micDenied,
        channelId: s.channelId,
        muted: s.muted,
        listenOnly: s.listenOnly,
      });
      if (s.voice.status === 'connected' && !measured.current) {
        sawConnected = true;
        void measureInCall(true);
      }
    });

    // Fallback: if the leg never reaches 'connected', still report the second
    // window rather than hanging the harness — but report `connected: false`,
    // because that is the fact the spike turns on. Never overstate it.
    const fallback = setTimeout(() => {
      void measureInCall(false);
    }, 20_000);

    /** Guards both trigger paths against a double sample. */
    const measured = { current: false };

    async function measureInCall(connected: boolean): Promise<void> {
      if (measured.current) return;
      measured.current = true;
      await new Promise((r) => setTimeout(r, 2_000));
      const inCall = await sampleFrames(FRAME_WINDOW_MS);
      await reportToSink('frames', { phase: 'in-call', connected, ...inCall });

      // Third window, AFTER leaving. The first "idle" sample runs while the app
      // is still hydrating, so it is a COLD baseline and not comparable to the
      // in-call one; this warm-idle window is the honest comparison. Without it
      // the only pair available is cold-idle vs in-call, which flatters the call
      // (60fps in-call vs a 30fps cold start is a warm-up artefact, not an
      // effect of the call).
      engine.leave();
      await new Promise((r) => setTimeout(r, 2_000));
      const warm = await sampleFrames(FRAME_WINDOW_MS);
      await reportToSink('frames', { phase: 'idle-warm', ...warm, inCallP99: inCall.p99 });
      await reportToSink('harness', { step: 'done', connected });
    }

    void (async () => {
      const idle = await sampleFrames(FRAME_WINDOW_MS);
      await reportToSink('frames', { phase: 'idle', ...idle });
      await new Promise((r) => setTimeout(r, JOIN_DELAY_MS));
      // `start`, not `join`: this channel has no live call, and the engine's
      // `join` sends op-22 `action: 'join'` — which the server has nothing to
      // attach to. (Cost a debugging cycle: the first run reported an empty
      // call because the harness was asking to join a call nobody started.)
      await reportToSink('harness', { step: 'start', channel });
      engine.start(channel);
    })();

    return () => {
      clearTimeout(fallback);
      unsubscribe();
    };
  }, [active, channel, manager, status]);

  return null;
}
