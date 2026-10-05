/**
 * @cytale/calls — the host-neutral fallbacks for the media seams.
 *
 * The engine is written against structural interfaces (`MediaEnv`,
 * `CaptureEnv`, `SpeakingEnv`) precisely so that a host can inject whatever
 * its platform offers: the browser (apps/web's `browserEnv.ts`) injects
 * `<audio>` playback, `navigator.mediaDevices` capture and a WebAudio
 * analyser; React Native (apps/mobile) injects react-native-webrtc.
 *
 * A package has no host, so — unlike a platform app — it must not reach for
 * `navigator`, `RTCPeerConnection`, `AudioContext` or `document` as a
 * fallback. What it offers instead is this module: fallbacks that are
 * HONEST about being unconfigured.
 *
 * The three `unavailable*` environments throw from every method rather than
 * silently resolving with nothing. That mirrors the pre-extraction behavior
 * in the only environment that ever hit them: under jsdom (no WebAudio, no
 * media devices) the old browser defaults threw, the engine's callers caught
 * it, and the documented degraded modes followed — a mic-less listen-only
 * leg, a frozen-but-honest speaking indicator, a share-unavailable notice.
 * Throwing keeps that shape while making the misconfiguration legible in any
 * other host.
 */

import type { MediaEnv, RTCIceServerLike } from './useCallMedia.js';
import type { CaptureEnv } from './usePublish.js';
import type { SpeakingEnv } from './speaking.js';

/** One shared "no host injected this seam" failure. */
function unavailable(seam: string, host: string): Error {
  return new Error(
    `@cytale/calls: no ${seam} injected — the host must supply one (e.g. ${host}) via CallEngineDeps.`,
  );
}

/**
 * The default `MediaEnv`: capture, peer connection, stream and remote-audio
 * playback all throw. Hosts inject their own (apps/web: `browserMediaEnv()`,
 * apps/mobile: `rnMediaEnv()`).
 */
export function unavailableMediaEnv(): MediaEnv {
  const fail = (): never => {
    throw unavailable('MediaEnv', 'browserMediaEnv()');
  };
  return {
    getUserMedia: fail,
    createPeerConnection: fail,
    createStream: fail,
    attachAudio: fail,
  };
}

/**
 * The default `CaptureEnv` for the publish engine: every capture throws.
 * Hosts inject their own (apps/web: `browserCaptureEnv()`, apps/mobile:
 * `rnCaptureEnv()`).
 */
export function unavailableCaptureEnv(): CaptureEnv {
  const fail = (): never => {
    throw unavailable('CaptureEnv', 'browserCaptureEnv()');
  };
  return { getUserMedia: fail, getDisplayMedia: fail };
}

/**
 * The default `SpeakingEnv`: creating the audio context throws, so the
 * monitor reports no speakers — the degraded-but-honest mode it already
 * documents for hosts without WebAudio.
 */
export function unavailableSpeakingEnv(): SpeakingEnv {
  return {
    createContext: () => {
      throw unavailable('SpeakingEnv', 'browserSpeakingEnv()');
    },
  };
}

/**
 * The default ICE-config fetch: no TURN, host/loopback candidates only —
 * exactly the documented no-TURN deployment behavior. Hosts inject the real
 * fetch (apps/web: GET /calls/ice through the session api) and the engine
 * refreshes the module ICE list before creating each peer connection.
 */
export function noIceServers(): Promise<RTCIceServerLike[]> {
  return Promise.resolve([]);
}
