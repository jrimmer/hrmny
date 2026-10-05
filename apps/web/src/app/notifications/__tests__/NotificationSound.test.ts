/**
 * notifications plan — the "ding" for a notification the member should hear.
 *
 * Synthesized rather than an audio file, for the reason RingSound records: no
 * binary enters git, and a programmatic AudioContext surfaces autoplay policy
 * as an inspectable `suspended` state instead of a silently rejected
 * `<audio>.play()` promise that nobody remembers to catch.
 *
 * The behaviour that matters is not the tone — it is the RESTRAINT. A ding on
 * every message is worse than no sound: it is the notification-fatigue failure
 * this whole feature exists to avoid, in audio form.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createNotificationSound,
  type NotificationSoundEnv,
} from '../NotificationSound.js';

// -- a fake WebAudio surface, mirroring RingSound's test approach --------------

function fakeEnv(opts: { state?: 'running' | 'suspended'; unavailable?: boolean } = {}) {
  const started: number[] = [];
  const ctx = {
    state: opts.state ?? 'running',
    currentTime: 0,
    // `connect` must return the node — AudioNodeLike declares it chainable.
    destination: {
      connect: () => ctx.destination,
      disconnect: () => undefined,
    },
    resume: vi.fn().mockImplementation(function (this: { state: string }) {
      ctx.state = 'running';
      return Promise.resolve();
    }),
    close: vi.fn().mockResolvedValue(undefined),
    createOscillator: () => {
      const osc = {
        type: 'sine',
        frequency: { value: 0 },
        connect: () => osc,
        disconnect: () => undefined,
        start: (when?: number) => started.push(when ?? 0),
        stop: () => undefined,
      };
      return osc;
    },
    createGain: () => {
      const param = {
        setValueAtTime: () => param,
        linearRampToValueAtTime: () => param,
      };
      const node = {
        gain: param,
        connect: () => node,
        disconnect: () => undefined,
      };
      return node;
    },
  };

  // `now` is present by default so a test can spread this env and override
  // only the clock — spreading an object that lacked it silently dropped the
  // injected clock and the interval brake read `undefined`.
  const env: NotificationSoundEnv = {
    audioContext: () => (opts.unavailable ? null : ctx),
    now: () => Date.now(),
  };

  return { env, ctx, started };
}

describe('createNotificationSound', () => {
  it('plays two partials when the context is running', async () => {
    const { env, started } = fakeEnv();
    const sound = createNotificationSound(env);

    const result = await sound.play();

    expect(result.played).toBe(true);
    // Two oscillators — the blip is a pair, not a single tone.
    expect(started).toHaveLength(2);
  });

  // Autoplay policy: an un-gesture'd tab reports suspended. One resume attempt,
  // and a context that stays suspended is reported rather than pretended away.
  it('attempts one resume when suspended, then plays', async () => {
    const { env, ctx } = fakeEnv({ state: 'suspended' });
    const sound = createNotificationSound(env);

    const result = await sound.play();

    expect(ctx.resume).toHaveBeenCalledTimes(1);
    expect(result.played).toBe(true);
  });

  it('reports autoplay-blocked when resume does not help', async () => {
    const { env, ctx } = fakeEnv({ state: 'suspended' });
    ctx.resume.mockImplementation(() => Promise.resolve()); // state stays suspended
    const sound = createNotificationSound(env);

    const result = await sound.play();

    expect(result.played).toBe(false);
    if (result.played) throw new Error('expected the ding to be suppressed');
    expect(result.reason).toBe('autoplay-blocked');
  });

  it('reports unavailable where WebAudio is absent', async () => {
    const { env } = fakeEnv({ unavailable: true });
    const sound = createNotificationSound(env);

    const result = await sound.play();

    expect(result.played).toBe(false);
    if (result.played) throw new Error('expected the ding to be suppressed');
    expect(result.reason).toBe('unavailable');
  });

  it('a resume() that rejects is treated as blocked, not as a crash', async () => {
    const { env, ctx } = fakeEnv({ state: 'suspended' });
    ctx.resume.mockRejectedValue(new Error('nope'));
    const sound = createNotificationSound(env);

    const result = await sound.play();

    expect(result.played).toBe(false);
    if (result.played) throw new Error('expected the ding to be suppressed');
    expect(result.reason).toBe('autoplay-blocked');
  });

  // RESTRAINT. A burst of messages must not produce a burst of dings — that is
  // notification fatigue in audio form, which is the failure this feature
  // exists to prevent. A second play inside the minimum interval is skipped.
  it('drops a second ding inside the minimum interval', async () => {
    const { env, started } = fakeEnv();
    let now = 1_000;
    const sound = createNotificationSound({ ...env, now: () => now });

    await sound.play();
    now += 100; // well inside the gap
    const second = await sound.play();

    expect(second.played).toBe(false);
    if (second.played) throw new Error('expected the second ding to be suppressed');
    expect(second.reason).toBe('too-soon');
    // Only the first pair sounded.
    expect(started).toHaveLength(2);
  });

  it('allows a ding once the interval has passed', async () => {
    const { env, started } = fakeEnv();
    let now = 1_000;
    const sound = createNotificationSound({ ...env, now: () => now });

    await sound.play();
    now += 10_000;
    const second = await sound.play();

    expect(second.played).toBe(true);
    expect(started).toHaveLength(4);
  });

  it('reuses one context across dings rather than opening one per sound', async () => {
    const { env } = fakeEnv();
    const created = vi.fn(env.audioContext);
    let now = 1_000;
    const sound = createNotificationSound({ audioContext: created, now: () => now });

    await sound.play();
    now += 10_000;
    await sound.play();

    expect(created).toHaveBeenCalledTimes(1);
  });
});
