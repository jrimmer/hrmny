/**
 * @cytale/web — `mapWithConcurrency` tests (hardening plan 7.2).
 *
 * The gate the plan asks for is that hydration's per-channel fan-out is
 * CONCURRENT and BOUNDED, not serial: a test that would pass against the old
 * `for … await` loop is not evidence. The pool starts `limit` tasks
 * synchronously (before its own first await), so `inFlight` right after the
 * call is the concurrency witness — the serial loop it replaced would show
 * 1. The refill walk then proves the bound is a ceiling, not just a
 * burst size, and that every item still completes exactly once.
 */
import { describe, expect, it } from 'vitest';

import { mapWithConcurrency } from '../concurrency.js';

/** Let the pool's pending microtasks run (task settle → next pull). */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('mapWithConcurrency', () => {
  it('starts `limit` tasks at once (concurrent, not the old serial walk)', async () => {
    const running = new Set<number>();
    let maxInFlight = 0;
    const resolvers = new Map<number, () => void>();
    const task = (n: number) => {
      running.add(n);
      maxInFlight = Math.max(maxInFlight, running.size);
      return new Promise<number>((resolve) => {
        resolvers.set(n, () => {
          running.delete(n);
          resolve(n);
        });
      });
    };

    const pending = mapWithConcurrency([1, 2, 3, 4], 2, task);

    // Synchronous witness: the pool had already launched its whole allowance
    // when the call returned. The serial loop it replaced would show 1 here.
    expect(running.size).toBe(2);
    expect([...running]).toEqual([1, 2]);

    // Drain in start order; the pool pulls the next item each time.
    for (const n of [1, 2, 3, 4]) {
      resolvers.get(n)!();
      await flush();
    }
    await expect(pending).resolves.toEqual([1, 2, 3, 4]);
    // …and the ceiling held for the whole run, not just the first burst.
    expect(maxInFlight).toBe(2);
  });

  it('never exceeds the limit while refilling across many items', async () => {
    const items = Array.from({ length: 11 }, (_, i) => i);
    const started: number[] = [];
    const running = new Set<number>();
    let maxInFlight = 0;
    const resolvers = new Map<number, () => void>();

    const pending = mapWithConcurrency(items, 3, (n) => {
      started.push(n);
      running.add(n);
      maxInFlight = Math.max(maxInFlight, running.size);
      return new Promise<number>((resolve) => {
        resolvers.set(n, () => {
          running.delete(n);
          resolve(n * 10);
        });
      });
    });

    expect(started).toEqual([0, 1, 2]);
    // Release in start order; the pool pulls the next pending item each time.
    for (const n of items) {
      resolvers.get(n)!();
      await flush();
    }
    await expect(pending).resolves.toEqual(items.map((n) => n * 10));
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBe(3);
    // Each item ran exactly once.
    expect(started).toHaveLength(items.length);
    expect(new Set(started).size).toBe(items.length);
  });

  it('a failing task neither aborts its siblings nor short-circuits the pool: the first error is rethrown once every item has been attempted', async () => {
    const ran: number[] = [];
    const pending = mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      ran.push(n);
      if (n === 2) throw new Error(`channel ${n} down`);
      return n;
    });
    await expect(pending).rejects.toThrow('channel 2 down');
    // Every item was still attempted (the caller's per-item catch policy is
    // what makes hydration's failed channel additive-only).
    expect(ran.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it('rejects a limit that is not a positive integer', async () => {
    await expect(mapWithConcurrency([1], 0, async (n) => n)).rejects.toThrow(RangeError);
    await expect(mapWithConcurrency([1], -1, async (n) => n)).rejects.toThrow(RangeError);
  });
});
