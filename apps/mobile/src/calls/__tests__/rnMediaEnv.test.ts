/**
 * @cytale/mobile — the RN media environment (media spike, step 2).
 *
 * `react-native-webrtc` needs a native module, so it is mocked here; these
 * tests pin the CONTRACT this adapter makes to the call engine, which is the
 * part that can silently break:
 *
 *   - every `MediaEnv` method reaches the module's real entry point with the
 *     arguments it was handed (no re-shaping the engine's constraints);
 *   - `attachAudio` implements the deafen path through `_setVolume`, which is
 *     the ONE mechanism the module offers for it and is underscore-private.
 *     If an upgrade removes or renames it, this test fails instead of a call
 *     silently failing to deafen.
 *   - `rnCaptureEnv().getDisplayMedia` rejects rather than resolving empty —
 *     a share attempt on mobile must fail visibly.
 *
 * The structural-compatibility claim between the module's classes and the
 * engine's `*Like` interfaces is NOT tested here (there is no real peer
 * connection in jest); the spike's integration run is what falsifies that.
 */
import { MediaStream, RTCPeerConnection, mediaDevices } from 'react-native-webrtc';

import { rnCaptureEnv, rnMediaEnv } from '../rnMediaEnv';

jest.mock('react-native-webrtc', () => {
  const setVolume = jest.fn();
  const track = { _setVolume: setVolume, kind: 'audio' };
  class FakeStream {
    tracks: unknown[];
    constructor(tracks: unknown[]) {
      this.tracks = tracks;
    }
    getAudioTracks = () => [track];
    getVideoTracks = () => [];
  }
  class FakePeerConnection {
    config: unknown;
    constructor(config: unknown) {
      this.config = config;
    }
  }
  return {
    __setVolume: setVolume,
    __track: track,
    mediaDevices: { getUserMedia: jest.fn(async () => new FakeStream([track])) },
    RTCPeerConnection: jest.fn(function (this: FakePeerConnection, config: unknown) {
      return new FakePeerConnection(config);
    }),
    MediaStream: jest.fn(function (this: FakeStream, tracks: unknown[]) {
      return new FakeStream(tracks);
    }),
  };
});

/** The mock's spy, surfaced through the mocked module. */
const setVolumeSpy = (jest.requireMock('react-native-webrtc') as { __setVolume: jest.Mock })
  .__setVolume;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('rnMediaEnv', () => {
  it('delegates capture to the module’s mediaDevices', async () => {
    const env = rnMediaEnv();
    const constraints = { audio: true } as Parameters<typeof env.getUserMedia>[0];
    await env.getUserMedia(constraints);
    expect(mediaDevices.getUserMedia).toHaveBeenCalledWith(constraints);
  });

  it('builds a peer connection from the engine’s ICE config, unchanged', () => {
    const env = rnMediaEnv();
    const config = { iceServers: [{ urls: 'stun:example.test' }], extra: 'ignored-by-rn' } as never;
    env.createPeerConnection(config);
    expect(RTCPeerConnection).toHaveBeenCalledWith(config);
  });

  it('builds a stream from the engine’s track list, unchanged', () => {
    const env = rnMediaEnv();
    const tracks = [{ kind: 'audio' }] as never;
    env.createStream(tracks);
    expect(MediaStream).toHaveBeenCalledWith(tracks);
  });

  describe('attachAudio — the deafen path', () => {
    const stream = { getAudioTracks: () => [{ _setVolume: setVolumeSpy }] };

    it('leaves playback audible and unmutes back to full volume', () => {
      const handle = rnMediaEnv().attachAudio(stream as never, 'user-1');
      // Attaching is not a mute: the stream arrives audible.
      expect(setVolumeSpy).toHaveBeenLastCalledWith(1);

      handle.setMuted(true);
      expect(setVolumeSpy).toHaveBeenLastCalledWith(0);

      handle.setMuted(false);
      expect(setVolumeSpy).toHaveBeenLastCalledWith(1);
    });

    it('does not touch playback on stop — the native session owns it', () => {
      const handle = rnMediaEnv().attachAudio(stream as never, 'user-1');
      setVolumeSpy.mockClear();
      expect(() => handle.stop()).not.toThrow();
      expect(setVolumeSpy).not.toHaveBeenCalled();
    });
  });
});

describe('rnCaptureEnv', () => {
  it('delegates mic/camera capture to the module', async () => {
    const env = rnCaptureEnv();
    const constraints = { audio: true } as Parameters<typeof env.getUserMedia>[0];
    await env.getUserMedia(constraints);
    expect(mediaDevices.getUserMedia).toHaveBeenCalledWith(constraints);
  });

  it('refuses screenshare instead of resolving an empty stream', async () => {
    await expect(rnCaptureEnv().getDisplayMedia({} as never)).rejects.toThrow(/not available/i);
  });
});
