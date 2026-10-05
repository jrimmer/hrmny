/**
 * @cytale/mobile — the React Native media environment (media spike, step 2).
 *
 * The counterpoint to `apps/web/src/features/calls/browserEnv.ts`. The call
 * engine (`@cytale/calls`) owns the negotiation, the manifest attribution, the
 * adaptive budget and the voice state machine; everything that touches a
 * platform's media stack is behind exactly two injected interfaces. This module
 * is the mobile implementation of those two:
 *
 *   `MediaEnv`    — capture, peer connection, stream, remote-audio playback
 *   `CaptureEnv`  — the publish engine's capture (mic; camera on publish)
 *
 * Deliberately narrow: it imports ONLY the two interfaces from the package and
 * derives every other type from them with `Parameters<>` / `ReturnType<>`, so a
 * rename or a moved type inside `@cytale/calls` cannot break this file.
 *
 * ── The one real translation: remote audio ──────────────────────────────────
 * The browser env attaches each remote stream to a `<audio>` element. React
 * Native has no such element, and react-native-webrtc does not expose a
 * renderer for audio: remote audio is played by the NATIVE audio session as
 * soon as the track arrives (`RTCView` is video-only, addressed by
 * `stream.toURL()`). So this `attachAudio` does NOT route anything — it owns
 * volume, which is what the engine actually uses it for:
 *
 *   - deafen  → `setMuted(true)`  → `_setVolume(0)` on the stream's audio tracks
 *   - undeafen→ `setMuted(false)` → `_setVolume(1)`
 *   - `stop()`→ a no-op, because there is no local handle to detach playback
 *               from: the native session stops the audio when the peer
 *               connection closes or the track ends.
 *
 * `_setVolume` is underscore-private in react-native-webrtc (it is, however,
 * present in the published type definitions — the call below is type-checked,
 * not cast). It is the only per-track volume control the module offers, so it is
 * the only deafen mechanism available to us. `rnMediaEnv.test.ts` pins it, so an
 * upgrade that removes or renames it fails a test rather than silently breaking
 * deafen on a call.
 *
 * ── Known gaps, by design, for the spike ────────────────────────────────────
 * Audio ROUTING (earpiece vs speaker), interruption handling and ducking are
 * not modelled here. The module ships the iOS audio categories
 * (`PlayAndRecord`, `Speakerphone`) and `RTCAudioSession`, and Android routes via
 * RTCModule, but a phone-call-shaped experience is the CallKit/ConnectionService
 * native module described in `docs/architecture/platform-clients.md` — not an
 * env method. Background audio likewise needs entitlements.
 */

import type { CaptureEnv, MediaEnv } from '@cytale/calls';

/**
 * `react-native-webrtc` is imported LAZILY, never at module scope.
 *
 * Load-bearing, and found the hard way: the module's entry point builds a
 * `NativeEventEmitter` from its native module at import time and throws
 * (`new NativeEventEmitter() requires a non-null argument`) wherever that
 * module is absent — which is every jest run, since jest never loads native
 * code. A static import here therefore took the whole app tree down in tests
 * the moment anything reachable from the root layout imported this file.
 *
 * The lazy require keeps evaluation to the moment a call actually needs it,
 * which also means a build that never places a call never pays for it. Same
 * idiom (and the same reason) as `src/gateway/zstd.ts`: Metro's synchronous
 * `require`, typed locally because this app has no Node globals.
 */
declare const require: (moduleName: string) => unknown;

/** The module's shape, for the lazy require. */
type WebRtcModule = typeof import('react-native-webrtc');

let loaded: WebRtcModule | null = null;

/** The native module, evaluated on first use (see the module docs). */
function webrtc(): WebRtcModule {
  loaded ??= require('react-native-webrtc') as WebRtcModule;
  return loaded;
}

/** The engine's peer-connection config (ICE servers only; empty = host candidates). */
type PeerConfig = Parameters<MediaEnv['createPeerConnection']>[0];
/** The engine's capture constraints (audio-only for the voice leg). */
type CaptureConstraints = Parameters<CaptureEnv['getUserMedia']>[0];
/** What the engine does with an attached remote stream (mute/undeafen/stop). */
type PlaybackHandle = ReturnType<MediaEnv['attachAudio']>;

/**
 * `react-native-webrtc`'s classes are structurally compatible with the engine's
 * `*Like` interfaces (same members, same shapes — the engine's interfaces were
 * written as the structural slice of the browser classes, and the RN module
 * mirrors the browser API). These casts are the seam where that claim is
 * asserted; the alternative is re-declaring the module's types against ours,
 * which would drift. The spike's integration test is what actually falsifies the
 * claim, so keep the casts here and nowhere else.
 */
type PeerLike = ReturnType<MediaEnv['createPeerConnection']>;
type StreamLike = ReturnType<MediaEnv['getUserMedia']> extends Promise<infer S> ? S : never;

/**
 * The React Native media environment. Mirrors `browserMediaEnv()` method for
 * method; see the module docs for why `attachAudio` differs.
 */
export function rnMediaEnv(): MediaEnv {
  return {
    getUserMedia: (constraints) =>
      webrtc().mediaDevices.getUserMedia(constraints) as unknown as Promise<StreamLike>,

    createPeerConnection: (config: PeerConfig) =>
      new (webrtc().RTCPeerConnection)(config) as unknown as PeerLike,

    createStream: (tracks) =>
      new (webrtc().MediaStream)(
        tracks as unknown as import('react-native-webrtc').MediaStreamTrack[],
      ) as unknown as StreamLike,

    attachAudio: (stream, _playbackKey): PlaybackHandle => {
      // Remote audio is already playing through the native session — this
      // handle's job is volume, i.e. the deafen path. The engine hands back its
      // own structural `MediaTrackLike`, which is narrower than the module's
      // `MediaStreamTrack`, so narrow once here to reach `_setVolume`.
      const tracks = stream.getAudioTracks() as unknown as import('react-native-webrtc').MediaStreamTrack[];
      let muted = false;
      const applyVolume = (): void => {
        for (const track of tracks) track._setVolume(muted ? 0 : 1);
      };
      applyVolume();

      return {
        setMuted: (next: boolean) => {
          muted = next;
          applyVolume();
        },
        stop: () => {
          // Nothing to detach: the native audio session owns playback and stops
          // it when the peer connection closes or the track ends.
        },
      };
    },
  };
}

/**
 * The publish engine's capture environment.
 *
 * `getUserMedia` is the mic (and the camera on publish). `getDisplayMedia` is
 * screenshare — a desktop/web job, deliberately out of scope for mobile (see
 * `docs/architecture/platform-clients.md`); it rejects loudly rather than
 * resolving with an empty stream, so a call path that tries to share fails
 * visibly instead of publishing nothing.
 */
export function rnCaptureEnv(): CaptureEnv {
  return {
    getUserMedia: (constraints: CaptureConstraints) =>
      webrtc().mediaDevices.getUserMedia(constraints) as unknown as Promise<StreamLike>,

    getDisplayMedia: () =>
      Promise.reject(
        new Error('Screen sharing is not available on mobile (out of scope for the media spike).'),
      ),
  };
}
