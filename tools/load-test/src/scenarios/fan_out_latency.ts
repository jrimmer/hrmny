/**
 * U28 slice 2 — fan-out latency scenario.
 *
 * Proves the message fan-out path (U11): a REST POST to a channel is observed
 * by every connected client as a MESSAGE_CREATE, and the time from post to
 * receipt is measured per client → p50/p99. The harness's arm-before-broadcast
 * round already correlates per-client latencies; this scenario asserts the
 * p99 stays within a configured bound and that every connected client
 * received the message.
 *
 * Gated on `isShipped` (U11 workspace fan-out). The measurement logic is
 * unit-tested against the fake gateway; the gate is what stops it from
 * running against a server without the subject.
 */

import { percentiles } from '../report.js';
import { assertShipped, type ScenarioContext, type ScenarioResult, type ScenarioRunner } from './types.js';

export const fanOutLatencyScenario: ScenarioRunner = {
  descriptor: {
    name: 'fan_out_latency',
    description: 'REST POST → all clients receive MESSAGE_CREATE; p50/p99 fan-out latency',
    subject: 'U11 workspace fan-out',
    gateKey: 'load_test.scenarios.fan_out_latency',
  },

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    assertShipped(ctx, this.descriptor.subject);

    const { harness, bounds } = ctx;
    const p99Bound = bounds.fanOutP99Ms ?? 1_000;

    await harness.connectAll();
    const connected = harness.connectedCount;
    if (connected === 0) {
      return {
        name: this.descriptor.name,
        passed: false,
        summary: 'no clients connected; fan-out cannot be measured',
        metrics: { connected: 0, received: 0, fanOutP50Ms: 0, fanOutP99Ms: 0 },
      };
    }

    const round = await harness.runFanOutRound();
    const p = percentiles(round.fanOutLatencies);

    const allReceived = round.receivedCount === connected;
    const withinBound = p.p99 <= p99Bound;
    const passed = allReceived && withinBound;

    return {
      name: this.descriptor.name,
      passed,
      summary: passed
        ? `fan-out p50=${p.p50.toFixed(1)}ms p99=${p.p99.toFixed(1)}ms, ${round.receivedCount}/${connected} received`
        : `fan-out p99=${p.p99.toFixed(1)}ms exceeds bound ${p99Bound}ms or ${round.receivedCount}/${connected} received`,
      metrics: {
        connected,
        received: round.receivedCount,
        fanOutP50Ms: p.p50,
        fanOutP99Ms: p.p99,
        fanOutP99BoundMs: p99Bound,
        allReceived,
      },
    };
  },
};
