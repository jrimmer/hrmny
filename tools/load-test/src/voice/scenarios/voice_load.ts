/**
 * U13 — the voice-load scenario: N=10 mutual callers in one channel over a
 * 60 s window, full-delivery asserted within tolerance of the spike's
 * fan-out envelope (each caller receives N−1 streams ≈ 450 pps; ≥95 %
 * delivery per receiver), plus the gateway-plane CALL_* assertions (Start/
 * Update/End, roster correctness) the TS harness owns per the U28 doctrine.
 *
 * Media legs: the Elixir sidecar (real ex_webrtc PCs). Signaling + every
 * assertion: this harness (real codecs via @cytale/protocol).
 */

import { assertShipped, type ScenarioContext, type ScenarioResult, type ScenarioRunner } from '../../scenarios/types.js';
import type { SidecarHandle, VoiceClientHandle } from '../types.js';

async function pollUntil(what: string, cond: () => boolean, timeoutMs: number, tickMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, tickMs));
  }
}

export const voiceLoadScenario: ScenarioRunner = {
  descriptor: {
    name: 'voice_load',
    description:
      'N=10 mutual voice callers, 60s window — ≥95% per-receiver RTP delivery + CALL_* / roster assertions',
    subject: 'U13 voice load + full delivery',
    gateKey: 'load_test.scenarios.voice_load',
  },

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    assertShipped(ctx, this.descriptor.subject);

    const voice = ctx.voice;
    if (!voice) {
      throw new Error(
        'voice seam unavailable — run via the CLI against a live server (voice scenarios need provisioning + the Elixir sidecar)',
      );
    }

    const knobs = ctx.knobs ?? {};
    const participants = Number(knobs.participants ?? 10);
    const signalClients = Number(knobs.signalClients ?? 2);
    const windowS = Number(knobs.windowS ?? 60);
    const settleS = Number(knobs.settleS ?? 20);
    const pps = Number(knobs.pps ?? 50);
    const minDeliveryPct = Number(knobs.minDeliveryPct ?? 95);
    const connectTimeoutMs = Number(knobs.connectTimeoutMs ?? 150_000);
    // The gateway throttles op 22 at 900 ms per session+channel; pace the
    // churn joins/leaves above it or the leave gets silently dropped.
    const stateGapMs = Number(knobs.stateGapMs ?? 950);

    const room = await voice.provision({
      userCount: participants + signalClients,
      label: 'load',
    });
    const channelId = room.channelId;

    const clients: VoiceClientHandle[] = [];
    let sidecar: SidecarHandle | null = null;
    let summary = '';
    const metrics: Record<string, number | string | boolean> = {};

    try {
      // Gateway legs: the owner (starts the call) + churn signalers — all
      // real codecs through the production gateway client.
      const owner = voice.createClient(room.ownerToken, 'owner');
      clients.push(owner);
      const churn = room.tokens.slice(participants).map((t, i) => {
        const c = voice.createClient(t, `churn-${i}`);
        clients.push(c);
        return c;
      });
      await Promise.all(clients.map((c) => c.connect()));
      await pollUntil('clients ready', () => clients.every((c) => c.ready), 30_000);

      // Start the call (op 22 `start` — the starter joins, AM16).
      owner.start(channelId, false);
      await pollUntil('CALL_START observed by owner', () => owner.hasCaptured('CallStart'), 10_000);

      // Media legs: N sidecar participants, window + settle so the all-
      // connected wait and churn fit inside the sidecar's run.
      sidecar = await voice.startSidecar({
        tokens: room.tokens.slice(0, participants),
        channelId,
        durationS: windowS + settleS,
        pps,
        labelPrefix: 'v',
      });

      const steadyTick = await sidecar.waitAllConnected(connectTimeoutMs);
      const receivedAtStart = steadyTick.participants?.map((p) => p.received) ?? [];
      const sentAtStart = steadyTick.participants?.map((p) => p.sent) ?? [];

      // Every sidecar join must have arrived at the owner as CALL_UPDATE
      // `joined`, and the derived roster must be exactly owner + N members.
      const expectedRoster = [...room.userIds.slice(0, participants), room.ownerUserId].sort();
      await pollUntil(
        `roster to reach ${expectedRoster.length} members`,
        () => JSON.stringify(owner.rosterIds(channelId)) === JSON.stringify(expectedRoster),
        30_000,
      );
      const rosterOk = true;

      // Busy-call churn INSIDE the delivery window: join → burst op-23 →
      // leave (each mints CALL_UPDATE dispatches + ingress pressure).
      for (const c of churn) {
        c.join(channelId);
        await pollUntil(`churn client ${c.label} in roster`, () => owner.rosterIds(channelId).length === expectedRoster.length + 1, 10_000);
        await new Promise((r) => setTimeout(r, stateGapMs));
        await c.signalBurst(channelId, 5);
        c.leave(channelId);
        await pollUntil(`churn client ${c.label} left roster`, () => owner.rosterIds(channelId).length === expectedRoster.length, 10_000);
        await new Promise((r) => setTimeout(r, stateGapMs));
      }

      // Owner leaves mid-window too (a participant departure the SFU must
      // reconcile without touching the N sidecar legs' delivery).
      owner.leave(channelId);
      await pollUntil(
        'owner left roster',
        () => JSON.stringify(owner.rosterIds(channelId)) === JSON.stringify(room.userIds.slice(0, participants).sort()),
        10_000,
      );

      // Window end: the sidecar's FINAL report (participants leave at their
      // teardown → CALL_END last_left must reach the owner).
      const final = await sidecar.done;
      sidecar = null;
      if (process.env.LOAD_TEST_DEBUG === '1') {
        // eslint-disable-next-line no-console
        console.log('VOICE FINAL REPORT', JSON.stringify(final));
      }

      const parts = final.participants ?? [];
      const aggregate = typeof final.delivery_pct === 'number' ? final.delivery_pct : 0;
      const windowMs = final.steady_window_ms ?? 0;
      // Per-receiver CONSERVATION: Δreceived_i vs the summed Δsent of the
      // other senders (OS timer granularity puts the achieved pump rate a
      // little under nominal pps — nominal-based math under-reports).
      const sentDelta = parts.map((p, i) => p.sent - (sentAtStart[i] ?? 0));
      const totalSentDelta = sentDelta.reduce((a, b) => a + b, 0);
      const perReceiver = parts.map((p, i) => {
        const others = totalSentDelta - (sentDelta[i] ?? 0);
        const got = p.received - (receivedAtStart[i] ?? 0);
        return others > 0 ? (got / others) * 100 : 0;
      });
      const minReceiverPct = perReceiver.length > 0 ? Math.min(...perReceiver) : 0;

      if (process.env.LOAD_TEST_DEBUG === '1') {
        // eslint-disable-next-line no-console
        console.error(
          'PER-RECEIVER %:',
          perReceiver.map((p, i) => `${parts[i]?.label}:${p.toFixed(1)}`).join(' '),
          '| sent:',
          parts.map((p) => p.sent).join(','),
          '| recv:',
          parts.map((p) => p.received).join(','),
        );
      }

      // The room's empty sweep (default 60 s) delays CALL_END `last_left`
      // after the last leave — wait it out unless disabled.
      const callEndTimeoutMs = Number(knobs.callEndTimeoutMs ?? 75_000);
      if (callEndTimeoutMs > 0) {
        await pollUntil('CALL_END after last participant left', () => owner.hasCaptured('CallEnd'), callEndTimeoutMs);
      }

      const callEndCount = owner.capturedOf('CallEnd').length;
      const connected = parts.filter((p) => p.connected === 1 || p.received > 0).length;
      const maxConnectedAfter = Math.max(0, ...parts.map((p) => p.connected_after_ms ?? 0));
      const maxLatency = Math.max(0, ...parts.map((p) => p.max_latency_ms ?? 0));
      const renegotiations = parts.reduce((acc, p) => acc + p.offers, 0);

      const callEndAsserted = callEndTimeoutMs > 0;
      const passed =
        connected === participants &&
        rosterOk &&
        aggregate >= minDeliveryPct &&
        minReceiverPct >= minDeliveryPct &&
        (!callEndAsserted || callEndCount >= 1);

      summary = passed
        ? `${participants} callers × ${windowS}s: delivery ${aggregate.toFixed(1)}% (min receiver ${minReceiverPct.toFixed(1)}%), ${renegotiations} renegotiated offers, call ended cleanly`
        : `delivery ${aggregate.toFixed(1)}% / min receiver ${minReceiverPct.toFixed(1)}% (need ${minDeliveryPct}%), connected ${connected}/${participants}, rosterOk=${rosterOk}, callEnds=${callEndCount}`;

      Object.assign(metrics, {
        participants,
        pps,
        windowS,
        connected,
        deliveryPct: aggregate,
        minReceiverPct,
        steadyWindowMs: windowMs,
        maxConnectedAfterMs: maxConnectedAfter,
        maxLatencyMs: maxLatency,
        renegotiationOffers: renegotiations,
        rosterOk,
        callEndObserved: callEndCount >= 1,
        callEndAsserted,
        aggregateReceived: parts.reduce((a, p) => a + p.received, 0),
        aggregateSent: parts.reduce((a, p) => a + p.sent, 0),
        perParticipant: parts
          .map((p, i) => `${p.label}:d${perReceiver[i]?.toFixed(1)}/o${p.offers}/a${p.answers}/t${p.inbound_tracks}`)
          .join(' '),
      });

      return { name: this.descriptor.name, passed, summary, metrics };
    } finally {
      sidecar?.kill();
      for (const c of clients) c.destroy();
    }
  },
};
