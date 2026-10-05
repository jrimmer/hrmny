/**
 * @cytale/mobile — the RN media device probe (media spike, step 2).
 *
 * Why this exists: the spike's deciding questions split into two groups.
 * "Does the SFU accept our peer?" needs a running server. "Does the RN side
 * work AT ALL?" — the native module loading, mic capture, stream/peer
 * construction, track volume — needs only a device, and is the part that can
 * fail on Hermes for reasons no amount of Node-side testing would reveal.
 *
 * So this runs those platform facts and reports them as ONE JSON line on the
 * console, which `adb logcat` captures without a screenshot. It is the RN
 * counterpart of the desktop capability probe
 * (`apps/web/src/features/calls/capability/capability.ts`): presence is not
 * proof — every step is actually EXECUTED and its outcome reported.
 *
 * OPT-IN and dev-only, twice over:
 *   - `__DEV__` must be true, and
 *   - `EXPO_PUBLIC_CYTALE_MEDIA_PROBE=1` must be set (so a normal dev run
 *     does not open a microphone on launch).
 *
 * It touches no gateway and no server, which is the point: it is runnable on
 * an emulator with the backend down.
 */

import { Platform } from 'react-native';

import type { MediaEnv } from '@cytale/calls';

import { reportToSink } from './devSink';
import { rnCaptureEnv, rnMediaEnv } from './rnMediaEnv';

/** One probed step: what was attempted and what actually happened. */
interface ProbeStep {
  step: string;
  ok: boolean;
  detail: string;
}

/** True when the probe is switched on for this build/run. */
export function mediaProbeEnabled(): boolean {
  return __DEV__ && process.env.EXPO_PUBLIC_CYTALE_MEDIA_PROBE === '1';
}

/**
 * Execute the platform facts and return them. Never throws: a failure is a
 * reported step, because "the probe crashed" and "capture is unavailable" are
 * different answers and a thrown error would collapse them.
 */
export async function runMediaProbe(): Promise<{ steps: ProbeStep[]; media: MediaEnv }> {
  const steps: ProbeStep[] = [];
  const record = (step: string, ok: boolean, detail: string): void => {
    steps.push({ step, ok, detail });
  };

  const media = rnMediaEnv();
  const capture = rnCaptureEnv();

  // 1. Mic capture. This is the step that needs a real device/emulator audio
  //    path; a denial here is a PERMISSION outcome, not a platform failure.
  let stream: Awaited<ReturnType<MediaEnv['getUserMedia']>> | null = null;
  try {
    stream = await capture.getUserMedia({ audio: true } as never);
    const audio = stream.getAudioTracks();
    record('getUserMedia(audio)', true, `tracks=${audio.length}`);
  } catch (err) {
    record('getUserMedia(audio)', false, describe(err));
  }

  // 2. Peer-connection construction — proves the native module is linked and
  //    the WebRTC factory is reachable from Hermes.
  let pc: ReturnType<MediaEnv['createPeerConnection']> | null = null;
  try {
    pc = media.createPeerConnection({ iceServers: [] });
    record('createPeerConnection', true, `connectionState=${pc.connectionState}`);
  } catch (err) {
    record('createPeerConnection', false, describe(err));
  }

  // 3. Stream construction + send-side binding: the exact path the engine's
  //    manifest attribution uses (addTrack → getTransceivers with a mid).
  if (pc !== null && stream !== null) {
    try {
      const tracks = stream.getAudioTracks() as never[];
      const built = media.createStream(tracks as never);
      const sender = pc.addTrack(tracks[0], built);
      const mids = pc.getTransceivers().map((t) => t.mid ?? '(pending)');
      record(
        'createStream + addTrack',
        true,
        `sender=${sender !== undefined} transceiverMids=${JSON.stringify(mids)}`,
      );
    } catch (err) {
      record('createStream + addTrack', false, describe(err));
    }
  } else {
    record('createStream + addTrack', false, 'skipped: no stream or no peer connection');
  }

  // 4. The deafen mechanism the adapter depends on. `_setVolume` is
  //    underscore-private, so prove it is callable on this build's tracks
  //    rather than trusting the type definition.
  if (stream !== null) {
    try {
      const handle = media.attachAudio(stream, 'probe');
      handle.setMuted(true);
      handle.setMuted(false);
      handle.stop();
      record('attachAudio + _setVolume', true, 'mute/unmute/stop all callable');
    } catch (err) {
      record('attachAudio + _setVolume', false, describe(err));
    }
  }

  // 5. Teardown must not throw — the engine calls it on every leave.
  if (pc !== null) {
    try {
      pc.close();
      record('close()', true, 'ok');
    } catch (err) {
      record('close()', false, describe(err));
    }
  }
  if (stream !== null) {
    try {
      for (const track of stream.getAudioTracks()) track.stop();
      record('track.stop()', true, 'ok');
    } catch (err) {
      record('track.stop()', false, describe(err));
    }
  }

  return { steps, media };
}

/**
 * Run the probe and report it.
 *
 * Two sinks, because neither is sufficient alone: `console.log` for a
 * debugger/TTY session, and the dev sink POST for a headless device run — on
 * RN 0.86 console output reaches neither `adb logcat` nor Metro's log when
 * `expo start` has no TTY, which is exactly how the spike runs it.
 */
export async function logMediaProbe(): Promise<void> {
  try {
    const { steps } = await runMediaProbe();
    const failed = steps.filter((s) => !s.ok).length;
    const summary = failed === 0 ? 'pass' : `${failed} failed`;
    console.log(`[media-probe] ${JSON.stringify({ summary, steps })}`);
    await reportToSink('media-probe', { summary, steps, platform: Platform.OS });
  } catch (err) {
    // Belt and braces: runMediaProbe does not throw, but the probe must never
    // take the app down with it.
    console.log(`[media-probe] ${JSON.stringify({ summary: 'threw', error: describe(err) })}`);
    await reportToSink('media-probe', { summary: 'threw', error: describe(err) });
  }
}

/** A short, log-safe description of an unknown thrown value. */
function describe(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
