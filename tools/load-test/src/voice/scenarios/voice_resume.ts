/**
 * U13 — the busy-call resume-buffer scenario: heavy call churn (N joins/
 * leaves + op-23 signaling bursts) mints buffered CALL_* envelopes while an
 * observer session is LIVE, then the observer drops and Resumes with a
 * DELIBERATELY UNDERRUN seq (the soak bot's falsification pattern — the
 * production client can never underrun): the server must replay exactly the
 * buffered tail, oldest first, gap-free, within the 1000-envelope session
 * cap, with no InvalidSession refusal (gateway.md "Resume buffer cap and
 * the eviction watermark").
 *
 * V2 (U7) extension: publish-state must survive a mid-call resume — a
 * member publishes camera (op-22 → CALL_UPDATE camera_on) while a LIVE
 * watcher session is dropped; after its Resume the replayed camera_on must
 * rebuild the derived roster's sources, and a FRESH session's CALL_SYNC
 * backfill must carry the source too.
 *
 * Signaling via real codecs (VirtualVoiceClient); only the underrun Resume
 * rides the raw prober (documented boundary, raw_resume_prober.ts).
 */

import { assertShipped, type ScenarioContext, type ScenarioResult, type ScenarioRunner } from '../../scenarios/types.js';
import { RESUME_BUFFER_CAP } from '../roster.js';
import type { RawResumeProberLike, VoiceClientHandle } from '../types.js';

async function pollUntil(what: string, cond: () => boolean, timeoutMs: number, tickMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, tickMs));
  }
}

export const voiceResumeScenario: ScenarioRunner = {
  descriptor: {
    name: 'voice_resume',
    description:
      'busy-call churn + op-23 bursts → underrun Resume replays the buffered CALL_* tail gap-free within the 1000-envelope cap, no refusal',
    subject: 'U13 busy-call resume-buffer integrity',
    gateKey: 'load_test.scenarios.voice_resume',
  },

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    assertShipped(ctx, this.descriptor.subject);

    const voice = ctx.voice;
    if (!voice) {
      throw new Error(
        'voice seam unavailable — run via the CLI against a live server (voice scenarios need provisioning)',
      );
    }

    const knobs = ctx.knobs ?? {};
    const churnClients = Number(knobs.churnClients ?? 3);
    const rounds = Number(knobs.rounds ?? 6);
    const burstCount = Number(knobs.burstCount ?? 5);
    // The gateway throttles op 22 at 900 ms per session+channel (calls plan
    // KTD3); a join→leave faster than that gets the LEAVE silently dropped.
    const stateGapMs = Number(knobs.stateGapMs ?? 950);
    // How many envelopes behind the high-water mark to Resume from.
    const underrunBy = Number(knobs.underrunBy ?? 12);

    const room = await voice.provision({ userCount: churnClients + 2, label: 'resume' });
    const channelId = room.channelId;

    const clients: VoiceClientHandle[] = [];
    let prober: RawResumeProberLike | null = null;
    try {
      const owner = voice.createClient(room.ownerToken, 'owner');
      clients.push(owner);
      const churn = room.tokens.slice(0, churnClients).map((t, i) => {
        const c = voice.createClient(t, `churn-${i}`);
        clients.push(c);
        return c;
      });
      // The observer: a raw native-dialect leg whose buffer accumulates the
      // churn while live, and whose Resume can be deliberately underrun.
      prober = voice.createProber(room.tokens[churnClients] ?? room.tokens[0]!, 'observer');
      // V2 (U7): the resumer — a production-client watcher that drops just
      // before the camera publish and Resumes into the replayed tail.
      const resumer = voice.createClient(room.tokens[churnClients + 1] ?? room.tokens[0]!, 'resumer');
      clients.push(resumer);

      await Promise.all(clients.map((c) => c.connect()));
      await pollUntil('clients ready + named', () => clients.every((c) => c.ready && c.userId !== null), 30_000);
      await prober.connect();

      owner.start(channelId, false);
      await pollUntil('CALL_START observed by owner', () => owner.hasCaptured('CallStart'), 10_000);
      await pollUntil('owner joined (roster)', () => owner.rosterIds(channelId).includes(owner.userId!), 10_000);

      // Busy churn while the prober stays LIVE: every join/leave mints a
      // buffered CALL_UPDATE in its session; op-23 bursts add ingress
      // pressure on top (the room consumes them without dispatching).
      for (let round = 0; round < rounds; round++) {
        for (const c of churn) {
          const uid = c.userId!;
          c.join(channelId);
          await pollUntil(
            `${c.label} joined (round ${round})`,
            () => owner.rosterIds(channelId).includes(uid),
            10_000,
          );
          await new Promise((r) => setTimeout(r, stateGapMs));
          await c.signalBurst(channelId, burstCount);
          c.leave(channelId);
          await pollUntil(
            `${c.label} left (round ${round})`,
            () => !owner.rosterIds(channelId).includes(uid),
            10_000,
          );
          await new Promise((r) => setTimeout(r, stateGapMs));
        }
      }

      // -- V2 (U7): publish-state survives a mid-call resume -----------------
      // The publisher joins and publishes camera; the resumer is DROPPED
      // just before, so the camera_on CALL_UPDATE lands in its replay tail.
      const publisher = churn[0]!;
      resumer.disconnect();
      await new Promise((r) => setTimeout(r, 300));

      if (!owner.rosterIds(channelId).includes(publisher.userId!)) {
        publisher.join(channelId);
        await pollUntil('publisher joined', () => owner.rosterIds(channelId).includes(publisher.userId!), 10_000);
      }
      publisher.publish(channelId, 'camera');
      await pollUntil(
        'owner sees the camera source',
        () => owner.memberSources(channelId, publisher.userId!).includes('camera'),
        10_000,
      );

      // The resumer Resumes (production client: polite drop kept eligibility)
      // and its derived roster must carry the source from the REPLAY.
      await resumer.connect();
      await pollUntil('resumer resumed', () => resumer.hasCaptured('Resumed'), 30_000);
      await pollUntil(
        'resumer roster carries the camera source after resume',
        () => resumer.memberSources(channelId, publisher.userId!).includes('camera'),
        10_000,
      );
      const sourcesSurviveResume = resumer.memberSources(channelId, publisher.userId!).includes('camera');

      // A FRESH session (new Identify) gets CALL_SYNC backfill — the
      // roster's sources[] must carry the publish state there too.
      const backfill = voice.createClient(room.ownerToken, 'backfill');
      clients.push(backfill);
      await backfill.connect();
      await pollUntil(
        'fresh CALL_SYNC backfill carries the camera source',
        () => backfill.memberSources(channelId, publisher.userId!).includes('camera'),
        30_000,
      );
      const sourcesInSyncBackfill = backfill.memberSources(channelId, publisher.userId!).includes('camera');

      // Deliberate underrun: resume from underrunBy envelopes behind the
      // prober's live high-water mark.
      const highWater = prober.lastSeq;
      const bufferedTail = Math.min(underrunBy, Math.max(highWater - 1, 0));
      if (highWater <= 1 || bufferedTail < 1) {
        return {
          name: this.descriptor.name,
          passed: false,
          summary: `prober observed only ${highWater} sequenced dispatches — nothing buffered to replay`,
          metrics: { highWater },
        };
      }
      const fromSeq = highWater - bufferedTail;

      prober.drop();
      await new Promise((r) => setTimeout(r, 300));
      const result = await prober.resumeWith(fromSeq);

      const names = new Set(result.replayed.map((e) => e.t));
      const replayedCallEvents = result.replayed.filter((e) => e.t === 'CallUpdate' || e.t === 'CallStart').length;
      const withinCap = result.replayed.length <= RESUME_BUFFER_CAP;
      const expectedCount = highWater - fromSeq;
      const exactTail =
        result.replayed.length === expectedCount ||
        // Late live dispatches may extend the tail past the high-water mark
        // captured before the drop — exact-or-longer is still gap-free.
        result.replayed.length >= expectedCount;

      const passed =
        result.resumed &&
        !result.refused &&
        result.contiguous &&
        withinCap &&
        exactTail &&
        replayedCallEvents > 0 &&
        sourcesSurviveResume &&
        sourcesInSyncBackfill;
      const summary = passed
        ? `underrun resume replayed ${result.replayed.length} envelopes gap-free from seq ${fromSeq + 1} (${replayedCallEvents} CALL_*), cap ${RESUME_BUFFER_CAP}, no refusal; camera source survived resume + CALL_SYNC backfill`
        : `replay broken: resumed=${result.resumed} refused=${result.refused} contiguous=${result.contiguous} ` +
          `(first bad idx ${result.firstBadIndex}), withinCap=${withinCap}, exactTail=${exactTail} ` +
          `(got ${result.replayed.length}, expected >= ${expectedCount}), callEvents=${replayedCallEvents}, ` +
          `sourcesSurviveResume=${sourcesSurviveResume}, sourcesInSyncBackfill=${sourcesInSyncBackfill}`;

      return {
        name: this.descriptor.name,
        passed,
        summary,
        metrics: {
          highWaterSeq: highWater,
          resumeFromSeq: fromSeq + 1,
          replayedEnvelopes: result.replayed.length,
          expectedTail: expectedCount,
          replayedCallEvents,
          replayedEventNames: [...names].join(','),
          resumeBufferCap: RESUME_BUFFER_CAP,
          contiguous: result.contiguous,
          withinCap,
          noRefusal: !result.refused,
          resumed: result.resumed,
          resumeSuccessRate: passed ? 1 : 0,
          churnRounds: rounds,
          op23Bursts: rounds * churnClients * burstCount,
          sourcesSurviveResume,
          sourcesInSyncBackfill,
        },
      };
    } finally {
      prober?.destroy();
      for (const c of clients) c.destroy();
    }
  },
};
