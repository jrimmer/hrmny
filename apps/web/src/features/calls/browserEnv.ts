/**
 * @cytale/web — the browser's media environments (media spike step 1).
 *
 * The counterpart to `apps/mobile/src/calls/rnMediaEnv.ts`: the engine in
 * `@cytale/calls` owns the negotiation, the manifest attribution, the
 * adaptive budget, the publish lifecycle and the voice state machine, and
 * everything that touches the browser's media stack lives HERE, behind the
 * three injected interfaces:
 *
 *   `MediaEnv`     — capture, peer connection, stream, remote-audio playback
 *   `CaptureEnv`   — the publish engine's capture (camera / screen /
 *                    share-audio)
 *   `SpeakingEnv`  — the WebAudio context the speaking monitor analyses with
 *
 * These are the browser globals the extracted package deliberately does not
 * contain: `navigator.mediaDevices`, `RTCPeerConnection`, `MediaStream`,
 * `document`/`HTMLAudioElement` and `AudioContext`. Nothing here is imported
 * by the package (the dependency runs one way); `webWiring.ts` hands these
 * values to `createCallEngine` as its deps.
 */

import type {
  AudioContextLike,
  CaptureEnv,
  MediaEnv,
  MediaStreamLike,
  PeerConnectionLike,
  SpeakingEnv,
} from '@cytale/calls';

/**
 * The default browser media environment — the structural browser classes
 * behind the engine's `*Like` interfaces. jsdom tests inject fakes instead
 * (see the engine's own suite).
 */
export function browserMediaEnv(): MediaEnv {
  return {
    getUserMedia: (constraints) =>
      navigator.mediaDevices.getUserMedia(constraints) as Promise<MediaStreamLike>,
    createPeerConnection: (config) =>
      new RTCPeerConnection(config as RTCConfiguration) as unknown as PeerConnectionLike,
    createStream: (tracks) =>
      new MediaStream(tracks as unknown as MediaStreamTrack[]) as MediaStreamLike,
    attachAudio: (stream, playbackKey) => {
      const el = document.createElement('audio');
      el.autoplay = true;
      el.setAttribute('data-call-playback', playbackKey);
      el.srcObject = stream as unknown as MediaStream;
      el.muted = false;
      const playResult = el.play() as unknown as Promise<void> | undefined;
      void playResult?.catch(() => {
        // autoplay policy — the first user gesture (clicking Join) unlocks
        // it; silence until then is the documented browser behavior
      });
      return {
        setMuted: (muted) => {
          el.muted = muted;
        },
        stop: () => {
          el.srcObject = null;
          el.remove();
        },
      };
    },
  };
}

/** The default browser capture environment (the publish engine's seam). */
export function browserCaptureEnv(): CaptureEnv {
  return {
    getUserMedia: (constraints) =>
      navigator.mediaDevices.getUserMedia(constraints as MediaStreamConstraints) as Promise<MediaStreamLike>,
    getDisplayMedia: (constraints) =>
      navigator.mediaDevices.getDisplayMedia(constraints as DisplayMediaStreamOptions) as Promise<MediaStreamLike>,
  };
}

/** The real-browser WebAudio environment (jsdom tests inject their own). */
export function browserSpeakingEnv(): SpeakingEnv {
  return {
    createContext: () => new AudioContext() as unknown as AudioContextLike,
  };
}
