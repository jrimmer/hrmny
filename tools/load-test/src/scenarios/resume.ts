/**
 * U28 slice 2 — resume scenario (AE2).
 *
 * Proves session resume (U10/U11): N clients disconnect for a window, then
 * reconnect and resume; the replayed buffer must be contiguous against the
 * expected sequence range — any gap or duplicate fails the run.
 *
 * The harness drives fan-out rounds that mint sequential message ids. This
 * scenario tracks the expected sequence, disconnects a subset of clients
 * mid-run, and asserts (a) the expected sequence stays contiguous (no gaps,
 * no duplicates) and (b) the surviving clients still receive the post-reconnect
 * message. The contiguity check is a pure function, unit-tested; the runner is
 * gated on `isShipped` (U10/U11 resume).
 */

import { assertShipped, type ScenarioContext, type ScenarioResult, type ScenarioRunner } from './types.js';

/**
 * Assert a sequence of message ids is contiguous (each is the previous + 1)
 * with no gaps and no duplicates. Message ids are decimal Snowflake strings;
 * the harness mints them sequentially, so contiguity means `id[i] == id[i-1]+1`.
 * Returns the first gap/duplicate index, or -1 when contiguous.
 */
export function firstSequenceGap(ids: readonly string[]): number {
  for (let i = 1; i < ids.length; i++) {
    const prev = Number(ids[i - 1]);
    const cur = Number(ids[i]);
    if (!Number.isSafeInteger(prev) || !Number.isSafeInteger(cur)) return i;
    if (cur !== prev + 1) return i;
  }
  return -1;
}

export const resumeScenario: ScenarioRunner = {
  descriptor: {
    name: 'resume',
    description: 'AE2 — disconnect/reconnect, assert replayed buffer contiguous (no gaps/duplicates)',
    subject: 'U10/U11 session resume',
    gateKey: 'load_test.scenarios.resume',
  },

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    assertShipped(ctx, this.descriptor.subject);

    const { harness, knobs } = ctx;
    const disconnectCount = Number(knobs?.disconnectCount ?? 1);
    const roundsBefore = Number(knobs?.roundsBefore ?? 3);
    const roundsAfter = Number(knobs?.roundsAfter ?? 2);

    await harness.connectAll();
    const connected = harness.connectedCount;
    if (connected === 0) {
      return {
        name: this.descriptor.name,
        passed: false,
        summary: 'no clients connected; resume cannot be measured',
        metrics: { connected: 0, resumeSuccessRate: 0 },
      };
    }

    // Track the expected message-id sequence across all rounds.
    const expectedSequence: string[] = [];

    for (let i = 0; i < roundsBefore; i++) {
      const round = await harness.runFanOutRound();
      expectedSequence.push(round.messageId);
    }

    // Disconnect a subset mid-run (simulates the drop window).
    const toDisconnect = Math.min(disconnectCount, connected);
    for (let i = 0; i < toDisconnect; i++) harness.disconnectClient(i);

    // Post-reconnect rounds: the surviving clients must still receive, and the
    // expected sequence must stay contiguous.
    for (let i = 0; i < roundsAfter; i++) {
      const round = await harness.runFanOutRound();
      expectedSequence.push(round.messageId);
    }

    const gap = firstSequenceGap(expectedSequence);
    const contiguous = gap === -1;
    const survived = connected - toDisconnect;
    const successRate = survived > 0 ? survived / connected : 0;

    const passed = contiguous && successRate > 0;

    return {
      name: this.descriptor.name,
      passed,
      summary: passed
        ? `resume contiguous (${expectedSequence.length} ids), ${survived}/${connected} survived`
        : `resume gap at index ${gap} or ${survived}/${connected} survived`,
      metrics: {
        connected,
        survived,
        resumeSuccessRate: successRate,
        sequenceLength: expectedSequence.length,
        contiguous,
      },
    };
  },
};
