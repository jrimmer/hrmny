/**
 * @cytale/web — RingSound tests (calls plan U11).
 *
 * Scenarios per the plan's error/edge paths:
 *   happy path — a running context starts the cadence (bursts scheduled),
 *     repeats per cadence, and stop() silences everything.
 *   error path — autoplay blocked (suspended context that stays suspended
 *     after one resume attempt) → `{ audible: false, reason:
 *     'autoplay-blocked' }`, NO oscillators — the visual-only fallback the
 *     toast asserts upstream.
 *   edge — no WebAudio at all → 'unavailable'; restart after stop works
 *     (one controller serves many ring sessions).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createRingSound,
  RING_CADENCE_MS,
  type AudioContextLike,
  type OscillatorLike,
  type RingSoundEnv,
} from '../RingSound.js';

class FakeParam {
  calls: Array<[string, number, number]> = [];
  setValueAtTime(_v: number, _t: number): FakeParam {
    this.calls.push(['set', _v, _t]);
    return this;
  }
  linearRampToValueAtTime(_v: number, _t: number): FakeParam {
    this.calls.push(['ramp', _v, _t]);
    return this;
  }
}

class FakeNode {
  connectedTo: FakeNode | null = null;
  disconnected = false;
  connect(dest: FakeNode): FakeNode {
    this.connectedTo = dest;
    return this;
  }
  disconnect(): void {
    this.disconnected = true;
  }
}

class FakeOscillator extends FakeNode {
  type = '';
  frequency = { value: 0 };
  started: number | null = null;
  stopped: number | null = null;
  stoppedCount = 0;
  gain: FakeParam = new FakeParam();
  start(when?: number): void {
    this.started = when ?? null;
  }
  stop(when?: number): void {
    this.stoppedCount += 1;
    if (when !== undefined) this.stopped = when;
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam();
}

interface FakeCtx extends AudioContextLike {
  oscillators: FakeOscillator[];
  resumeBehavior: () => Promise<void>;
  closed: boolean;
}

function fakeContext(state: 'running' | 'suspended' = 'running'): FakeCtx {
  const ctx: FakeCtx = {
    state,
    currentTime: 0,
    destination: new FakeNode(),
    closed: false,
    oscillators: [],
    resumeBehavior: async () => {
      ctx.state = 'running';
    },
    async resume() {
      await ctx.resumeBehavior();
    },
    async close() {
      ctx.closed = true;
    },
    createOscillator() {
      const osc = new FakeOscillator();
      ctx.oscillators.push(osc);
      return osc;
    },
    createGain() {
      return new FakeGain();
    },
  };
  return ctx;
}

function fakeEnv(ctx: AudioContextLike | null): RingSoundEnv {
  return {
    audioContext: () => ctx,
    scheduleInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h),
  };
}

async function act_flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0); // flush close()'s promise
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RingSound (happy path)', () => {
  it('starts the cadence on a running context: first bursts land immediately', async () => {
    const ctx = fakeContext('running');
    const sound = createRingSound(fakeEnv(ctx));

    const result = await sound.start();

    expect(result).toEqual({ audible: true });
    // First cycle: two bursts × two partials (800 + 1000 Hz).
    expect(ctx.oscillators).toHaveLength(4);
    expect(new Set(ctx.oscillators.map((o) => o.frequency.value))).toEqual(
      new Set([800, 1000]),
    );
    expect(ctx.oscillators.every((o) => o.started !== null)).toBe(true);
  });

  it('repeats the double-burst each cadence and stop() silences + closes', async () => {
    const ctx = fakeContext('running');
    const sound = createRingSound(fakeEnv(ctx));
    await sound.start();

    await vi.advanceTimersByTimeAsync(RING_CADENCE_MS);
    expect(ctx.oscillators).toHaveLength(8); // two cycles
    await vi.advanceTimersByTimeAsync(RING_CADENCE_MS * 2);
    expect(ctx.oscillators).toHaveLength(16);

    sound.stop();
    expect(ctx.oscillators.every((o) => o.stoppedCount > 0)).toBe(true);
    await act_flush();
    expect(ctx.closed).toBe(true); // close() is async — flushed

    const before = ctx.oscillators.length;
    await vi.advanceTimersByTimeAsync(RING_CADENCE_MS * 3);
    expect(ctx.oscillators).toHaveLength(before); // cadence halted
  });

  it('restarts after stop (one controller serves many ring sessions)', async () => {
    const ctxA = fakeContext('running');
    const made: AudioContextLike[] = [ctxA];
    const sound = createRingSound({
      audioContext: () => made.shift() ?? fakeContext('running'),
      scheduleInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => clearInterval(h),
    });

    await sound.start();
    sound.stop();
    const result = await sound.start();
    expect(result).toEqual({ audible: true });
  });
});

describe('RingSound (error paths — autoplay fallback)', () => {
  it('reports autoplay-blocked when a suspended context stays suspended', async () => {
    const ctx = fakeContext('suspended');
    // resume() is a no-op: the context never becomes runnable.
    ctx.resumeBehavior = async () => {
      /* stays suspended */
    };
    const sound = createRingSound(fakeEnv(ctx));

    const result = await sound.start();

    expect(result).toEqual({ audible: false, reason: 'autoplay-blocked' });
    expect(ctx.oscillators).toHaveLength(0); // nothing scheduled
    expect(ctx.closed).toBe(true); // context torn down
  });

  it('reports autoplay-blocked when resume() rejects outright', async () => {
    const ctx = fakeContext('suspended');
    ctx.resumeBehavior = () => Promise.reject(new Error('NotAllowedError'));
    const sound = createRingSound(fakeEnv(ctx));

    const result = await sound.start();

    expect(result).toEqual({ audible: false, reason: 'autoplay-blocked' });
    expect(ctx.oscillators).toHaveLength(0);
  });

  it('resumes a suspended-but-allowed context and rings', async () => {
    const ctx = fakeContext('suspended'); // default behavior flips to running
    const sound = createRingSound(fakeEnv(ctx));

    const result = await sound.start();

    expect(result).toEqual({ audible: true });
    expect(ctx.oscillators.length).toBeGreaterThan(0);
  });

  it('reports unavailable where WebAudio is absent (jsdom default)', async () => {
    const sound = createRingSound(fakeEnv(null));
    const result = await sound.start();
    expect(result).toEqual({ audible: false, reason: 'unavailable' });
  });

  it('start() while already sounding is an idempotent audible no-op', async () => {
    const ctx = fakeContext('running');
    const sound = createRingSound(fakeEnv(ctx));
    await sound.start();
    const again = await sound.start();
    expect(again).toEqual({ audible: true });
    expect(ctx.oscillators).toHaveLength(4); // no duplicate first cycle
  });
});
