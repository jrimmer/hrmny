/**
 * @cytale/web — bounded fan-out for boot hydration.
 *
 * `mapWithConcurrency` is the pool the authenticated shell's hydration uses
 * for its per-channel `listThreads` leg (hardening plan 7.2). Hydration used
 * to walk a workspace's channels with a serial `for … await`, which makes
 * boot O(channels) round-trips end to end — the N+1 the plan names, sitting
 * in front of the shell being usable. A bare `Promise.all` over every
 * channel would remove the serialisation but also the bound: a workspace
 * with hundreds of channels would put every request on the wire at once, on
 * the one path where the socket is already carrying the gateway's
 * identify/resume. The pool keeps a small, fixed number of requests in
 * flight and starts the next as one settles.
 *
 * Failure policy belongs to the caller: this helper attempts every item and
 * rethrows the FIRST error once the pool has drained. A throwing task
 * therefore cannot abort its siblings, and nothing short-circuits the pool —
 * the drain is what ends it. Callers that want per-item tolerance keep their
 * own try/catch inside the task (hydration does — a failed channel must leave
 * its rows out, not abort the run).
 */

/**
 * Largest number of `task` invocations allowed in flight at once.
 * Rejects a non-positive/non-integer limit instead of silently degrading to
 * a serial walk (which is the bug this exists to fix) or to unbounded.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(
      `mapWithConcurrency: limit must be a positive integer, got ${String(limit)}`,
    );
  }
  const results = new Array<R>(items.length);
  // Shared cursor: every worker pulls the next index, so the pool refills
  // the moment one task settles rather than waiting for a whole batch.
  let next = 0;
  const errors: unknown[] = [];
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await task(items[index]!, index);
      } catch (err) {
        errors.push(err);
      }
    }
  });
  await Promise.all(workers);
  if (errors.length > 0) throw errors[0];
  return results;
}
