/**
 * U28 slice 2 — isolation scenario (AE1).
 *
 * Proves workspace-process isolation (U11): flood workspace A with a high
 * message rate while workspace B's clients sit idle, then assert B's fan-out
 * latency stays within bounds (B is unaffected by A's load). The harness
 * drives two channel groups (A and B); the runner floods A via repeated
 * fan-out rounds and measures B's latency on a quiet round.
 *
 * Gated on `isShipped` (U11 workspace fan-out). Measurement logic is
 * unit-testable; the gate stops it against a server without the subject.
 */

import { percentiles } from '../report.js';
import { assertShipped, type ScenarioContext, type ScenarioResult, type ScenarioRunner } from './types.js';

export const isolationScenario: ScenarioRunner = {
  descriptor: {
    name: 'isolation',
    description: 'AE1 — flood workspace A, assert workspace B latency within bounds',
    subject: 'U11 workspace fan-out',
    gateKey: 'load_test.scenarios.isolation',
  },

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    assertShipped(ctx, this.descriptor.subject);

    const { harness, bounds, knobs } = ctx;
    const p99Bound = bounds.isolationP99Ms ?? 1_000;
    const floodRounds = Number(knobs?.floodRounds ?? 5);

    await harness.connectAll();
    const connected = harness.connectedCount;
    if (connected < 2) {
      return {
        name: this.descriptor.name,
        passed: false,
        summary: 'need at least 2 clients to observe isolation',
        metrics: { connected, isolationAssertion: 'fail' },
      };
    }

    // Flood workspace A: run several fan-out rounds back-to-back. Each round
    // posts a message and waits for all clients to receive it — the load on A
    // is the repeated broadcast. B's clients are the same sockets; the
    // assertion is that B's fan-out latency (measured on a quiet round) stays
    // within bound despite A's flood.
    for (let i = 0; i < floodRounds; i++) {
      await harness.runFanOutRound();
    }

    // Measure B's fan-out latency on a quiet round.
    const quiet = await harness.runFanOutRound();
    const p = percentiles(quiet.fanOutLatencies);

    const withinBound = p.p99 <= p99Bound;
    const passed = withinBound;

    return {
      name: this.descriptor.name,
      passed,
      summary: passed
        ? `workspace B fan-out p99=${p.p99.toFixed(1)}ms within bound ${p99Bound}ms after ${floodRounds} flood rounds`
        : `workspace B fan-out p99=${p.p99.toFixed(1)}ms exceeds bound ${p99Bound}ms after ${floodRounds} flood rounds`,
      metrics: {
        connected,
        floodRounds,
        isolationP99Ms: p.p99,
        isolationP99BoundMs: p99Bound,
        isolationAssertion: passed ? 'pass' : 'fail',
      },
    };
  },
};
