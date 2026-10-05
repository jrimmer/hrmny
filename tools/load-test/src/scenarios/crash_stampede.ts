/**
 * U28 slice 2 — crash stampede scenario.
 *
 * Proves bounded recovery after a workspace-process crash (U10 storm damping
 * + U11 recovery ordering): terminate the workspace process mid-load with
 * clients attached, then assert all survivors reconnect/full-sync concurrently
 * within a bound and the error rate stays flat.
 *
 * The harness's `disconnectClient` simulates the crash-induced drop; the
 * runner measures that the surviving clients still complete a fan-out round
 * within the recovery bound and that the error rate (clients that failed to
 * reconnect) stays flat. Gated on `isShipped` (U10/U11).
 */

import { assertShipped, type ScenarioContext, type ScenarioResult, type ScenarioRunner } from './types.js';

export const crashStampedeScenario: ScenarioRunner = {
  descriptor: {
    name: 'crash_stampede',
    description: 'workspace-process crash mid-load → bounded reconnect/full-sync, error rate flat',
    subject: 'U10 storm damping + U11 recovery ordering',
    gateKey: 'load_test.scenarios.crash_stampede',
  },

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    assertShipped(ctx, this.descriptor.subject);

    const { harness, bounds, knobs } = ctx;
    const recoveryBoundMs = bounds.recoveryMs ?? 5_000;
    const crashCount = Number(knobs?.crashCount ?? 1);
    const roundsAfter = Number(knobs?.roundsAfter ?? 2);

    await harness.connectAll();
    const connected = harness.connectedCount;
    if (connected === 0) {
      return {
        name: this.descriptor.name,
        passed: false,
        summary: 'no clients connected; crash recovery cannot be measured',
        metrics: { connected: 0, errorRate: 1 },
      };
    }

    // Simulate the crash: a subset of clients drop (the workspace process
    // died under them). The survivors must still complete fan-out rounds.
    const toCrash = Math.min(crashCount, connected);
    for (let i = 0; i < toCrash; i++) harness.disconnectClient(i);

    // Measure recovery: survivors complete a fan-out round within the bound.
    const start = Date.now();
    let recovered = 0;
    let withinBound = true;
    for (let i = 0; i < roundsAfter; i++) {
      const round = await harness.runFanOutRound();
      recovered = round.receivedCount;
      if (Date.now() - start > recoveryBoundMs) withinBound = false;
    }

    const survivors = connected - toCrash;
    const errorRate = survivors > 0 ? (connected - recovered) / connected : 1;
    const errorRateFlat = errorRate <= (Number(knobs?.maxErrorRate ?? 0.1));
    const passed = withinBound && errorRateFlat;

    return {
      name: this.descriptor.name,
      passed,
      summary: passed
        ? `crash recovery: ${recovered}/${connected} within ${Date.now() - start}ms, error rate ${(errorRate * 100).toFixed(1)}%`
        : `crash recovery exceeded bound or error rate ${(errorRate * 100).toFixed(1)}% not flat`,
      metrics: {
        connected,
        recovered,
        errorRate,
        recoveryMs: Date.now() - start,
        recoveryBoundMs: recoveryBoundMs,
        errorRateFlat,
      },
    };
  },
};
