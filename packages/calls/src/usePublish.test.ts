/**
 * @cytale/web — publish engine tests (calls V2 plan U4, R1/R2/R4/VM8/VM9/VM12/VM13).
 *
 * Unit coverage for the capture engine in isolation: capture constraints +
 * content hints, op-22 publish/unpublish with the 300 ms debounce, every
 * native-stop path converging on the single unpublish, VM8 re-publish
 * across leg resets (camera yes, ended screen never + notice), VM13
 * replaceTrack switching, and the per-encoding sender caps.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  CAMERA_QUALITY_PRESETS,
  SCREEN_QUALITY_PRESETS,
  applySenderCaps,
  createPublishEngine,
  type CaptureConstraints,
  type CaptureEnv,
  type PublishEngineOps,
  type PublishingState,
} from './usePublish.js';
import type { MediaStreamLike, MediaTrackLike, RtpSenderLike } from './useCallMedia.js';

// -- fakes ---------------------------------------------------------------------

class FakeTrack implements MediaTrackLike {
  enabled = true;
  contentHint: string | undefined;
  onended: (() => void) | null = null;
  stopped = false;
  constructor(readonly kind: 'audio' | 'video') {}
  stop(): void {
    this.stopped = true;
  }
  fireEnded(): void {
    this.stopped = true;
    this.onended?.();
  }
}

class FakeStream implements MediaStreamLike {
  constructor(
    readonly audio: FakeTrack[] = [],
    readonly video: FakeTrack[] = [],
  ) {}
  getAudioTracks(): MediaTrackLike[] {
    return this.audio;
  }
  getVideoTracks(): MediaTrackLike[] {
    return this.video;
  }
}

class FakeCaptureEnv implements CaptureEnv {
  readonly requested: CaptureConstraints[] = [];
  cameraImpl: () => Promise<FakeStream> = () =>
    Promise.resolve(new FakeStream([], [new FakeTrack('video')]));
  displayImpl: () => Promise<FakeStream> = () =>
    Promise.resolve(new FakeStream([], [new FakeTrack('video')]));
  getUserMedia(constraints: CaptureConstraints): Promise<MediaStreamLike> {
    this.requested.push(JSON.parse(JSON.stringify(constraints)));
    return this.cameraImpl();
  }
  getDisplayMedia(constraints: CaptureConstraints): Promise<MediaStreamLike> {
    this.requested.push(JSON.parse(JSON.stringify(constraints)));
    return this.displayImpl();
  }
}

interface OpsLog {
  publish: string[];
  unpublish: string[];
  shareEnded: number;
  shareUnavailable: number;
  changes: number;
}

function makeOps(): { ops: PublishEngineOps; log: OpsLog } {
  const log: OpsLog = { publish: [], unpublish: [], shareEnded: 0, shareUnavailable: 0, changes: 0 };
  return {
    log,
    ops: {
      sendPublish: (source) => log.publish.push(source),
      sendUnpublish: (source) => log.unpublish.push(source),
      notifyShareEnded: () => {
        log.shareEnded += 1;
      },
      notifyShareUnavailable: () => {
        log.shareUnavailable += 1;
      },
      onChange: () => {
        log.changes += 1;
      },
    },
  };
}

function makeEngine(env: FakeCaptureEnv, debounceMs = 0) {
  const { ops, log } = makeOps();
  const engine = createPublishEngine({ ops, env, debounceMs });
  return { engine, log, env };
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

// -- sender caps -----------------------------------------------------------------

function fakeSender(encodings: Array<Record<string, unknown>>): RtpSenderLike & {
  params: { encodings: Array<Record<string, unknown>> };
} {
  const sender = {
    params: { encodings },
    async replaceTrack() {},
    getParameters() {
      return sender.params;
    },
    async setParameters(p: unknown) {
      sender.params = JSON.parse(JSON.stringify(p)) as typeof sender.params;
    },
  };
  return sender;
}

describe('applySenderCaps', () => {
  it('per-encoding caps f/h/q on rid encodings (GO branch — VM2/R2)', async () => {
    const sender = fakeSender([{ rid: 'q' }, { rid: 'h' }, { rid: 'f' }]);
    await applySenderCaps(sender, CAMERA_QUALITY_PRESETS.high); // 1800 kbps top
    const [q, h, f] = sender.params.encodings;
    expect(f).toMatchObject({ maxBitrate: 1_800_000, scaleResolutionDownBy: 1 });
    expect(h).toMatchObject({ maxBitrate: 720_000, scaleResolutionDownBy: 2 });
    expect(q).toMatchObject({ maxBitrate: 270_000, scaleResolutionDownBy: 4 });
  });

  it('single-encoding senders get the tier directly', async () => {
    const sender = fakeSender([{}]);
    await applySenderCaps(sender, SCREEN_QUALITY_PRESETS.medium); // 2500 kbps, 15 fps
    expect(sender.params.encodings[0]).toMatchObject({
      maxBitrate: 2_500_000,
      maxFramerate: 15,
      scaleResolutionDownBy: 1,
    });
  });

  it('the `source` tier caps nothing (uncapped share)', async () => {
    const sender = fakeSender([{}]);
    await applySenderCaps(sender, SCREEN_QUALITY_PRESETS.source);
    expect(sender.params.encodings[0]).toEqual({});
  });

  it('senders without get/setParameters are left alone (best-effort)', async () => {
    const sender = {
      async replaceTrack() {},
    } as RtpSenderLike;
    await expect(applySenderCaps(sender, CAMERA_QUALITY_PRESETS.high)).resolves.toBeUndefined();
  });
});

// -- lifecycle ---------------------------------------------------------------------

describe('publish engine — capture + ops', () => {
  // F5: a host that cannot run screen capture (WKWebView's
  // NotSupportedError et al.) must surface WHY — the silent no-op was the
  // walkthrough finding — while a picker refusal stays silent (a choice,
  // not a failure; KTD8's classification).
  it('screen capture failure (not a refusal) notifies share-unavailable and publishes nothing', async () => {
    const env = new FakeCaptureEnv();
    env.displayImpl = () => Promise.reject(new Error('NotSupportedError: Not supported'));
    const { engine, log } = makeEngine(env);

    engine.publishScreen();
    await flush();
    engine.onLegConfirmed(); // flush the op queue — [] is then meaningful
    await flush();

    expect(log.shareUnavailable).toBe(1);
    expect(log.publish).toEqual([]);
  });

  it('a picker refusal (NotAllowedError/AbortError) stays silent — no notice, no publish', async () => {
    for (const name of ['NotAllowedError', 'AbortError']) {
      const env = new FakeCaptureEnv();
      env.displayImpl = () => Promise.reject(Object.assign(new Error('denied'), { name }));
      const { engine, log } = makeEngine(env);

      engine.publishScreen();
      await flush();
      engine.onLegConfirmed();
      await flush();

      expect(log.shareUnavailable).toBe(0);
      expect(log.publish).toEqual([]);
    }
  });

  it('a failed VM13 window-switch keeps the live share silent (refusal or not)', async () => {
    const env = new FakeCaptureEnv();
    let live = true;
    env.displayImpl = () =>
      live
        ? Promise.resolve(new FakeStream([], [new FakeTrack('video')]))
        : Promise.reject(new Error('NotSupportedError: Not supported'));
    const { engine, log } = makeEngine(env);

    engine.publishScreen();
    await flush();
    engine.onLegConfirmed();
    await flush();
    expect(log.publish).toEqual(['screen']);
    live = false;
    engine.switchScreenSource();
    await flush();

    // The existing share stands; the failed switch is not an availability
    // statement about the host.
    expect(log.shareUnavailable).toBe(0);
    expect(log.unpublish).toEqual([]);
  });

  it('camera: captures with tier constraints, hints motion, sends publish once the leg is confirmed', async () => {
    const { engine, log, env } = makeEngine(new FakeCaptureEnv());
    engine.publishCamera('medium');
    await flush();
    expect(log.publish).toEqual([]); // participant-gated: no leg yet
    expect(engine.getPublishing()).toEqual({ camera: true, screen: false, screen_audio: false });

    engine.onLegConfirmed();
    expect(log.publish).toEqual(['camera']);

    const constraints = env.requested[0]!;
    expect(constraints.audio).toBe(false);
    expect(constraints.video).toMatchObject({
      width: { ideal: CAMERA_QUALITY_PRESETS.medium.width },
      frameRate: { max: CAMERA_QUALITY_PRESETS.medium.frameRate },
    });
  });

  it('screen with audio publishes BOTH sources; without audio support only screen (VM9)', async () => {
    const env = new FakeCaptureEnv();
    env.displayImpl = () =>
      Promise.resolve(new FakeStream([new FakeTrack('audio')], [new FakeTrack('video')]));
    const { engine, log } = makeEngine(env);
    engine.onLegConfirmed();
    engine.publishScreen({ audio: true });
    await flush();
    expect(log.publish).toEqual(['screen', 'screen_audio']);

    const env2 = new FakeCaptureEnv(); // platform returns no audio track
    const p2 = makeEngine(env2);
    p2.engine.onLegConfirmed();
    p2.engine.publishScreen({ audio: true });
    await flush();
    expect(p2.log.publish).toEqual(['screen']);
    expect(p2.engine.getPublishing()).toEqual({
      camera: false,
      screen: true,
      screen_audio: false,
    });
  });

  it('screen tracks carry the detail hint; camera motion (VM12)', async () => {
    const env = new FakeCaptureEnv();
    const screen = new FakeStream([], [new FakeTrack('video')]);
    env.displayImpl = () => Promise.resolve(screen);
    const { engine } = makeEngine(env);
    engine.publishScreen();
    await flush();
    expect(screen.video[0]!.contentHint).toBe('detail');
    expect((env.requested[0]!.video as Record<string, unknown>).frameRate).toBeDefined();
  });

  it('user unpublish: stops the capture and sends one op; screen takes share-audio along', async () => {
    const env = new FakeCaptureEnv();
    env.displayImpl = () =>
      Promise.resolve(new FakeStream([new FakeTrack('audio')], [new FakeTrack('video')]));
    const { engine, log } = makeEngine(env);
    engine.onLegConfirmed();
    engine.publishScreen({ audio: true });
    await flush();
    expect(engine.getPublishing().screen_audio).toBe(true);

    engine.unpublish('screen');
    await flush();
    expect(log.unpublish.sort()).toEqual(['screen', 'screen_audio']);
    expect(engine.getPublishing()).toEqual({ camera: false, screen: false, screen_audio: false });
  });

  it('the 300 ms debounce collapses rapid toggles to the LAST op (KTD3)', async () => {
    vi.useFakeTimers();
    try {
      const env = new FakeCaptureEnv();
      const { ops, log } = makeOps();
      const engine = createPublishEngine({ ops, env, debounceMs: 300 });
      engine.onLegConfirmed();

      engine.publishCamera();
      await vi.runAllTimersAsync();
      expect(log.publish).toEqual(['camera']);

      // Rapid off/on/off inside the window: only the final state's op rides.
      engine.unpublish('camera');
      engine.publishCamera();
      engine.unpublish('camera');
      await flush();
      expect(log.unpublish).toEqual([]);
      vi.advanceTimersByTime(300);
      await flush();
      expect(log.unpublish).toEqual(['camera']);
      expect(log.publish).toEqual(['camera']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('publish engine — native-stop paths (R4)', () => {
  it('the browser stop bar (video onended) unpublishes screen + screen_audio and notifies share-ended', async () => {
    const env = new FakeCaptureEnv();
    const screen = new FakeStream([new FakeTrack('audio')], [new FakeTrack('video')]);
    env.displayImpl = () => Promise.resolve(screen);
    const { engine, log } = makeEngine(env);
    engine.onLegConfirmed();
    engine.publishScreen({ audio: true });
    await flush();

    screen.video[0]!.fireEnded(); // stop bar / closed window / OS revoke
    await flush();
    expect(log.unpublish.sort()).toEqual(['screen', 'screen_audio']);
    expect(log.shareEnded).toBe(1);
    expect(screen.audio[0]!.stopped).toBe(true); // share-audio dies with it
    expect(engine.getPublishing()).toEqual({
      camera: false,
      screen: false,
      screen_audio: false,
    });
  });

  it('share-audio ending alone unpublishes ONLY screen_audio (no notice)', async () => {
    const env = new FakeCaptureEnv();
    const screen = new FakeStream([new FakeTrack('audio')], [new FakeTrack('video')]);
    env.displayImpl = () => Promise.resolve(screen);
    const { engine, log } = makeEngine(env);
    engine.onLegConfirmed();
    engine.publishScreen({ audio: true });
    await flush();

    screen.audio[0]!.fireEnded();
    await flush();
    expect(log.unpublish).toEqual(['screen_audio']);
    expect(log.shareEnded).toBe(0);
    expect(engine.getPublishing().screen).toBe(true);
  });

  it('camera onended (OS revoke) unpublishes camera with NO share-ended notice', async () => {
    const env = new FakeCaptureEnv();
    const camera = new FakeStream([], [new FakeTrack('video')]);
    env.cameraImpl = () => Promise.resolve(camera);
    const { engine, log } = makeEngine(env);
    engine.onLegConfirmed();
    engine.publishCamera();
    await flush();

    camera.video[0]!.fireEnded();
    await flush();
    expect(log.unpublish).toEqual(['camera']);
    expect(log.shareEnded).toBe(0);
  });
});

describe('publish engine — leg lifecycle (VM8)', () => {
  it('leg reset preserves held captures; confirmation re-publishes them', async () => {
    const env = new FakeCaptureEnv();
    const camera = new FakeStream([], [new FakeTrack('video')]);
    env.cameraImpl = () => Promise.resolve(camera);
    const { engine, log } = makeEngine(env);
    engine.onLegConfirmed();
    engine.publishCamera();
    await flush();
    expect(log.publish).toEqual(['camera']);

    engine.onLegReset(); // infrastructure teardown (rejoin pending)
    expect(camera.video[0]!.stopped).toBe(false); // STILL HELD
    engine.onLegConfirmed(); // the new leg confirms → re-publish
    expect(log.publish).toEqual(['camera', 'camera']);
    expect(engine.getPublishing().camera).toBe(true);
  });

  it('stopAll (user-intent teardown) stops every capture', async () => {
    const env = new FakeCaptureEnv();
    const camera = new FakeStream([], [new FakeTrack('video')]);
    env.cameraImpl = () => Promise.resolve(camera);
    const screen = new FakeStream([new FakeTrack('audio')], [new FakeTrack('video')]);
    env.displayImpl = () => Promise.resolve(screen);
    const { engine } = makeEngine(env);
    engine.onLegConfirmed();
    engine.publishCamera();
    engine.publishScreen({ audio: true });
    await flush();

    engine.stopAll();
    expect(camera.video[0]!.stopped).toBe(true);
    expect(screen.video[0]!.stopped).toBe(true);
    expect(screen.audio[0]!.stopped).toBe(true);
    const publishing: PublishingState = engine.getPublishing();
    expect(publishing).toEqual({ camera: false, screen: false, screen_audio: false });
  });

  it('localTrack feeds the engine\'s manifest binding (mic is not a source)', async () => {
    const env = new FakeCaptureEnv();
    const camera = new FakeStream([], [new FakeTrack('video')]);
    env.cameraImpl = () => Promise.resolve(camera);
    const { engine } = makeEngine(env);
    engine.publishCamera();
    await flush();
    expect(engine.localTrack('camera')).toBe(camera.video[0]);
    expect(engine.localTrack('mic')).toBeNull();
    expect(engine.localTrack('screen')).toBeNull();
  });

  it('onTrackBound records the sender and applies caps for video sources only', async () => {
    const { engine } = makeEngine(new FakeCaptureEnv());
    const sender = fakeSender([{ rid: 'q' }, { rid: 'h' }, { rid: 'f' }]);
    const audioSender = fakeSender([{}]);
    engine.onTrackBound('camera', sender);
    engine.onTrackBound('screen_audio', audioSender);
    await flush();
    expect(sender.params.encodings[2]).toMatchObject({ maxBitrate: 1_800_000 });
    // Audio-kind senders are recorded but never video-shaped caps.
    expect(audioSender.params.encodings[0]).toEqual({});
  });
});

describe('publish engine — window switch (VM13)', () => {
  it('replaces the track on the bound sender with no new publish ops; falls back to unpublish+publish when refused', async () => {
    const env = new FakeCaptureEnv();
    const first = new FakeStream([], [new FakeTrack('video')]);
    env.displayImpl = () => Promise.resolve(first);
    const { engine, log } = makeEngine(env);
    engine.onLegConfirmed();
    engine.publishScreen();
    await flush();

    const sender = fakeSender([{}]);
    let refuse = false;
    sender.replaceTrack = async () => {
      if (refuse) throw new Error('InvalidStateError');
    };
    engine.onTrackBound('screen', sender);

    // Switch: second capture replaces the track on the SAME sender.
    const second = new FakeStream([], [new FakeTrack('video')]);
    env.displayImpl = () => Promise.resolve(second);
    engine.switchScreenSource();
    await flush();
    expect(log.publish).toEqual(['screen']); // no re-publish
    expect(first.video[0]!.stopped).toBe(true);
    expect(second.video[0]!.stopped).toBe(false);
    expect(engine.localTrack('screen')).toBe(second.video[0]);

    // Refusing replaceTrack falls back to a fresh binding: the old capture
    // retires and the source re-publishes (the 300 ms debounce collapses
    // unpublish+publish into the publish that survives).
    refuse = true;
    const third = new FakeStream([], [new FakeTrack('video')]);
    env.displayImpl = () => Promise.resolve(third);
    engine.switchScreenSource();
    await flush();
    expect(second.video[0]!.stopped).toBe(true);
    expect(log.publish).toEqual(['screen', 'screen']);
    expect(engine.localTrack('screen')).toBe(third.video[0]);
  });
});
