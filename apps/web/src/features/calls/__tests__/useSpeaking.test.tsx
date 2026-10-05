/**
 * @cytale/web — speaking monitor tests (calls plan U8, AM5).
 *
 * Threshold-based speaking flags per remote stream, identity-stable
 * snapshots, change-only notifications, lazy/tolerant AudioContext wiring,
 * and setInterval-based polling (tab-visibility tolerant — an interval
 * throttles in hidden tabs rather than stopping like rAF).
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SpeakingMonitor,
  useSpeakingSet,
  type AnalyserNodeLike,
  type AudioContextLike,
  type AudioSourceNodeLike,
} from '../useSpeaking.js';

// -- fake WebAudio ---------------------------------------------------------------

class FakeAnalyser implements AnalyserNodeLike {
  fftSize = 4;
  samples = [128, 128, 128, 128]; // silence by default
  disconnected = false;
  getByteTimeDomainData(array: Uint8Array): void {
    for (let i = 0; i < this.samples.length; i++) array[i] = this.samples[i]!;
  }
  disconnect(): void {
    this.disconnected = true;
  }
}

class FakeSource implements AudioSourceNodeLike {
  connected: AnalyserNodeLike | null = null;
  disconnected = false;
  connect(node: AnalyserNodeLike): void {
    this.connected = node;
  }
  disconnect(): void {
    this.disconnected = true;
  }
}

class FakeContext implements AudioContextLike {
  state = 'running';
  resumed = 0;
  closed = false;
  readonly sources: FakeSource[] = [];
  readonly analysers: FakeAnalyser[] = [];
  createMediaStreamSource(): FakeSource {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
  createAnalyser(): FakeAnalyser {
    const analyser = new FakeAnalyser();
    this.analysers.push(analyser);
    return analyser;
  }
  resume(): Promise<void> {
    this.resumed++;
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

/** A monitor whose tick is captured instead of scheduled. */
function manualMonitor(opts: { createContext?: () => AudioContextLike } = {}) {
  let tick: (() => void) | null = null;
  const contextFactory =
    opts.createContext ?? (() => new FakeContext() as AudioContextLike);
  const monitor = new SpeakingMonitor({
    env: { createContext: contextFactory },
    setIntervalFn: ((fn: () => void) => {
      tick = fn;
      return 1;
    }) as unknown as typeof setInterval,
    clearIntervalFn: (() => undefined) as unknown as typeof clearInterval,
  });
  monitor.start();
  return {
    monitor,
    tick: () => {
      if (tick === null) throw new Error('monitor not started');
      tick();
    },
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('SpeakingMonitor — flags and thresholds', () => {
  it('marks a user speaking when the peak deviation crosses the threshold', () => {
    const { monitor, tick } = manualMonitor();
    monitor.attach('u1', {});
    monitor.attach('u2', {});
    tick();

    // Both silent initially.
    expect([...monitor.getSpeaking()]).toEqual([]);

    // Drive u1's analyser loud (deviation 40 ≥ 12), u2 stays silent.
    const ctx = (monitor as unknown as { ctx: FakeContext }).ctx;
    ctx.analysers[0]!.samples = [128, 168, 128, 90];
    tick();
    expect([...monitor.getSpeaking()]).toEqual(['u1']);

    // Silence again → flag clears.
    ctx.analysers[0]!.samples = [128, 128, 128, 128];
    tick();
    expect([...monitor.getSpeaking()]).toEqual([]);
  });

  it('keeps the snapshot identity-stable while nothing changes', () => {
    const { monitor, tick } = manualMonitor();
    monitor.attach('u1', {});
    tick();
    const before = monitor.getSpeaking();
    tick();
    tick();
    expect(monitor.getSpeaking()).toBe(before); // same object, no churn
  });

  it('notifies subscribers only on membership change', () => {
    const { monitor, tick } = manualMonitor();
    const listener = vi.fn();
    monitor.subscribe(listener);
    monitor.attach('u1', {});
    tick();
    expect(listener).not.toHaveBeenCalled(); // still silent

    const ctx = (monitor as unknown as { ctx: FakeContext }).ctx;
    ctx.analysers[0]!.samples = [128, 200, 128, 128];
    tick();
    expect(listener).toHaveBeenCalledTimes(1);

    tick(); // loud still
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('detach removes the analyser chain and clears the flag', () => {
    const { monitor, tick } = manualMonitor();
    monitor.attach('u1', {});
    tick();
    const ctx = (monitor as unknown as { ctx: FakeContext }).ctx;
    ctx.analysers[0]!.samples = [128, 200, 128, 128];
    tick();
    expect([...monitor.getSpeaking()]).toEqual(['u1']);

    monitor.detach('u1');
    expect([...monitor.getSpeaking()]).toEqual([]);
    expect(ctx.sources[0]!.disconnected).toBe(true);
    expect(ctx.analysers[0]!.disconnected).toBe(true);
  });

  it('detachAll drops pending (attached-but-unwired) streams too', () => {
    const ctx = new FakeContext();
    const { monitor, tick } = manualMonitor({ createContext: () => ctx });
    monitor.attach('u1', {});
    tick(); // wired: source + analyser exist
    expect(ctx.sources).toHaveLength(1);

    // u2 attaches but is never wired (no tick) — detachAll must still drop it.
    monitor.attach('u2', {});
    monitor.detachAll();
    tick();

    expect(ctx.sources).toHaveLength(1); // no NEW wiring for u2 after detachAll
    expect(ctx.sources[0]!.disconnected).toBe(true); // u1's chain torn down
    expect([...monitor.getSpeaking()]).toEqual([]);
  });

  it('resumes a suspended AudioContext (autoplay policy) on tick', () => {
    const ctx = new FakeContext();
    ctx.state = 'suspended';
    const { monitor, tick } = manualMonitor({ createContext: () => ctx });
    monitor.attach('u1', {});
    tick();
    expect(ctx.resumed).toBe(1);
  });

  it('degrades to no-speakers when WebAudio is unavailable (lazy context)', () => {
    const error = vi.fn(() => {
      throw new Error('no WebAudio');
    });
    const { monitor, tick } = manualMonitor({ createContext: error });
    monitor.attach('u1', {});
    expect(() => tick()).not.toThrow();
    expect([...monitor.getSpeaking()]).toEqual([]);
  });

  it('polls via setInterval (tab-visibility tolerant), defaulting to ~100ms', () => {
    const intervals: Array<{ fn: () => void; ms: number }> = [];
    const monitor = new SpeakingMonitor({
      env: { createContext: () => new FakeContext() },
      setIntervalFn: ((fn: () => void, ms: number) => {
        intervals.push({ fn, ms });
        return 1;
      }) as unknown as typeof setInterval,
      clearIntervalFn: (() => undefined) as unknown as typeof clearInterval,
    });
    monitor.start();
    monitor.start(); // idempotent
    expect(intervals).toHaveLength(1);
    expect(intervals[0]!.ms).toBe(100);
  });
});

// ---------------------------------------------------------------------------

describe('useSpeakingSet — React binding', () => {
  it('re-renders on speaking-set changes with stable identity otherwise', () => {
    const { monitor, tick } = manualMonitor();

    function Probe() {
      const speaking = useSpeakingSet(
        (cb) => monitor.subscribe(cb),
        () => monitor.getSpeaking(),
      );
      return (
        <ul data-testid="speaking-list" data-count={speaking.size}>
          {[...speaking].map((id) => (
            <li key={id}>{id}</li>
          ))}
        </ul>
      );
    }

    render(<Probe />);
    expect(screen.getByTestId('speaking-list').getAttribute('data-count')).toBe('0');

    monitor.attach('u1', {});
    act(() => {
      tick();
    });
    const ctx = (monitor as unknown as { ctx: FakeContext }).ctx;
    ctx.analysers[0]!.samples = [128, 200, 128, 128];
    act(() => {
      tick();
    });

    expect(screen.getByTestId('speaking-list').getAttribute('data-count')).toBe('1');
    expect(screen.getByText('u1')).toBeTruthy();
  });
});

describe('SpeakingMonitor — the DEFAULT global timers are bound (review #10)', () => {
  // Regression net for the Chromium "Illegal invocation" fix: bare
  // setInterval/setInterval unbound from globalThis throws the moment
  // start() fires in a real browser. Every other test injects timers, so
  // only this one exercises the constructor's bound defaults.
  it('start() schedules through setInterval.bind(globalThis) and stop() clears it', () => {
    const setSpy = vi
      .spyOn(globalThis, 'setInterval')
      .mockReturnValue(42 as unknown as ReturnType<typeof setInterval>);
    const clearSpy = vi.spyOn(globalThis, 'clearInterval').mockReturnValue(undefined);
    const monitor = new SpeakingMonitor({ env: { createContext: () => new FakeContext() as AudioContextLike } });
    try {
      monitor.start();
      expect(setSpy).toHaveBeenCalled();
      monitor.stop();
      expect(clearSpy).toHaveBeenCalledWith(42);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });
});
