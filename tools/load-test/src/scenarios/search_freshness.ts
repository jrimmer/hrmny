/**
 * U28 slice 2 — search freshness scenario (edit #9).
 *
 * Proves index-commit-to-searchable freshness (U13): a message sent via the
 * fan-out pipeline becomes searchable within ~1s (the ~500ms batched commit
 * window + query round-trip). The runner measures the end-to-end time from
 * post to searchable and asserts p99 stays within the stated bound.
 *
 * The search seam is injected via `knobs.search` (a function that returns
 * whether a message id is searchable) so the measurement logic is unit-testable
 * without a live Tantivy index. Gated on `isShipped` (U13 search).
 */

import { assertShipped, type ScenarioContext, type ScenarioResult, type ScenarioRunner } from './types.js';

export const searchFreshnessScenario: ScenarioRunner = {
  descriptor: {
    name: 'search_freshness',
    description: 'index-commit-to-searchable end-to-end, assert p99 within ~1s bound',
    subject: 'U13 Tantivy search',
    gateKey: 'load_test.scenarios.search_freshness',
  },

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    assertShipped(ctx, this.descriptor.subject);

    const { harness, bounds, knobs } = ctx;
    const p99Bound = bounds.searchP99Ms ?? 1_000;
    const rounds = Number(knobs?.rounds ?? 3);
    const search = knobs?.search as ((messageId: string) => boolean) | undefined;

    await harness.connectAll();
    const connected = harness.connectedCount;
    if (connected === 0) {
      return {
        name: this.descriptor.name,
        passed: false,
        summary: 'no clients connected; search freshness cannot be measured',
        metrics: { connected: 0, searchP99Ms: 0 },
      };
    }

    // For each round: post a message, then poll the search seam until the
    // message is searchable (or the bound elapses). Record the freshness time.
    const freshnessMs: number[] = [];
    for (let i = 0; i < rounds; i++) {
      const round = await harness.runFanOutRound();
      const start = Date.now();
      let searchable = false;
      while (Date.now() - start <= p99Bound) {
        if (search && search(round.messageId)) {
          searchable = true;
          break;
        }
        await sleep(20);
      }
      freshnessMs.push(searchable ? Date.now() - start : p99Bound + 1);
    }

    const p99 = percentileOf(freshnessMs, 99);
    const passed = p99 <= p99Bound;

    return {
      name: this.descriptor.name,
      passed,
      summary: passed
        ? `search freshness p99=${p99.toFixed(1)}ms within bound ${p99Bound}ms`
        : `search freshness p99=${p99.toFixed(1)}ms exceeds bound ${p99Bound}ms`,
      metrics: {
        connected,
        searchP99Ms: p99,
        searchP99BoundMs: p99Bound,
        rounds,
      },
    };
  },
};

function percentileOf(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const frac = idx - lo;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * frac;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
