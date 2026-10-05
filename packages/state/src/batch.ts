/**
 * @cytale/state — batched store writes (lane D #18).
 *
 * Every gateway dispatch is its own store commit, and every commit notifies
 * every subscriber. That is right for live traffic (one event, one render)
 * and wrong for a BURST: a resume replay of 200 buffered dispatches, or a
 * fresh READY followed by its CALL_SYNC, presence snapshot and read-state
 * sync, was 200 (or a dozen) notifications and as many React renders — each
 * one painting a half-applied state (READY's reset without the presence that
 * refills it: everyone flickers offline).
 *
 * `withBatchedWrites` runs a block with the store's writes COLLECTED: inside
 * it, `getState()` returns the working state (every earlier write in the
 * block applied, so the reconcile's own reads — the replay gate, the
 * optimistic-echo match — see what they would have seen unbatched) and
 * `setState()` folds into that working state without notifying anyone. When
 * the block ends the result lands as ONE commit.
 *
 * Every writer goes through `getState`/`setState` — the reconcile, the web
 * reaction seams, the optimistic helpers — so a batch cannot interleave with
 * a write it does not see (a single shared accumulator would: a seam's direct
 * write between two reconciled events would be overwritten by the flush).
 *
 * Synchronous only: the block must not await. Re-entrant: a nested batch
 * joins the outer one.
 */

import type { StateState, StateStore } from './store.js';

const active = new WeakSet<StateStore>();

export function withBatchedWrites<T>(store: StateStore, block: () => T): T {
  if (active.has(store)) return block();

  const originalGet = store.getState;
  const originalSet = store.setState;
  const base = originalGet();
  let working: StateState = base;

  active.add(store);
  store.getState = () => working;
  store.setState = ((partial: unknown, replace?: boolean) => {
    const next =
      typeof partial === 'function'
        ? (partial as (s: StateState) => Partial<StateState> | StateState)(working)
        : (partial as Partial<StateState> | StateState);
    if (next === working || next === undefined || next === null) return;
    working = replace === true ? (next as StateState) : { ...working, ...next };
  }) as StateStore['setState'];

  try {
    return block();
  } finally {
    store.getState = originalGet;
    store.setState = originalSet;
    active.delete(store);
    if (working !== base) {
      // One commit, carrying only what changed (zustand notifies on the
      // partial; unchanged slices keep their identity either way).
      const changed: Partial<StateState> = {};
      const w = working as unknown as Record<string, unknown>;
      const b = base as unknown as Record<string, unknown>;
      let any = false;
      for (const key of Object.keys(w)) {
        if (!Object.is(w[key], b[key])) {
          (changed as Record<string, unknown>)[key] = w[key];
          any = true;
        }
      }
      // `lastSeq` is NOT reactive (see store.ts): it never rides the commit —
      // a batch whose only change is the watermark notifies nobody — and it
      // is carried onto the live state in place below.
      delete (changed as Record<string, unknown>)['lastSeq'];
      any = Object.keys(changed).length > 0;
      if (any) originalSet(changed);
      (originalGet() as { lastSeq: number }).lastSeq = working.lastSeq;
    }
  }
}

/** True while `store` is inside a `withBatchedWrites` block (tests/diagnostics). */
export function isBatching(store: StateStore): boolean {
  return active.has(store);
}
