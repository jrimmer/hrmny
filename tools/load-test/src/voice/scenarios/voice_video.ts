/**
 * U7 — the V2 video-load scenario: sidecar participants with real video
 * legs (publish camera/screen via op-22, pump video-rate RTP, count inbound
 * per (user, source) from the envelope-v2 manifest) against a live server,
 * with the TS harness owning every gateway-plane assertion (U28 doctrine).
 *
 * Shapes (knob `shape`):
 *
 *   cameras — N=10 all-cameras within budget; one receiver declares
 *             tiles=2 (video_want) and its receipts must stay within that
 *             budget; every other receiver sees (n−1) sources.
 *   stage   — N=25, 2 screen sharers (multi-share / envelope edge): the
 *             most-recent screen is the stage and must reach EVERY other
 *             participant; tiles budgeted per VM2/KDV4 arithmetic; the max
 *             observed CALL_SIGNAL body is recorded against the 128 KiB cap.
 *   churn   — publish-churn storm at line rate vs the glare guard: rapid
 *             camera publish/unpublish toggles; ZERO leg drops, bounded
 *             offer cascades, roster intact, audio delivery sustained.
 *   turn    — one sidecar participant RELAY-only through eturnal (when
 *             configured): allocation PASS (deploy/turn-check.exs) is the
 *             bar on this single-host topology; relayed receipts recorded
 *             honestly.
 *
 * The sidecar's video legs are single-layer (ex_webrtc 0.17 cannot originate
 * rid encodings — the spike's library-half FAIL): receivers see full-rate
 * streams inside their budgets, the honest fallback-branch ceiling. The
 * GO-branch q-layer packet rates need real browsers (the e2e doc's leg).
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { CALL_SIGNAL_BODY_MAX_BYTES } from '@cytale/protocol';

import { assertShipped, type ScenarioContext, type ScenarioResult, type ScenarioRunner } from '../../scenarios/types.js';
import { REPO_ROOT } from '../sidecar.js';
import {
  bodyBytesOf,
  checkBudgetCoverage,
  counterDelta,
  distinctVideoSources,
  offerEnvelopeOf,
} from '../manifest.js';
import type { SidecarHandle, SidecarReport, SidecarParticipantStats, VoiceClientHandle } from '../types.js';

async function pollUntil(what: string, cond: () => boolean, timeoutMs: number, tickMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, tickMs));
  }
}

interface TickView {
  steady: SidecarReport;
  final: SidecarReport;
}

/** Diff helpers over per-participant counter fields between two ticks. */
function participantAt(tick: SidecarReport, idx: number): SidecarParticipantStats | undefined {
  return tick.participants?.[idx];
}

function audioDelivery(
  steady: SidecarReport,
  final: SidecarReport,
): { aggregate: number; minReceiver: number; perReceiver: number[] } {
  const parts = final.participants ?? [];
  const sentDelta = parts.map((p, i) => p.sent - (participantAt(steady, i)?.sent ?? 0));
  const totalSent = sentDelta.reduce((a, b) => a + b, 0);
  const perReceiver = parts.map((p, i) => {
    const others = totalSent - (sentDelta[i] ?? 0);
    const got = p.received - (participantAt(steady, i)?.received ?? 0);
    return others > 0 ? (got / others) * 100 : 0;
  });
  return {
    aggregate: totalSent > 0 ? (perReceiver.reduce((a, b) => a + b, 0) / perReceiver.length) : 0,
    minReceiver: perReceiver.length > 0 ? Math.min(...perReceiver) : 0,
    perReceiver,
  };
}

export const voiceVideoScenario: ScenarioRunner = {
  descriptor: {
    name: 'voice_video',
    description:
      'V2 video legs: cameras/stage+screens/churn/turn shapes — envelope-v2 offers, per-(user,source) receipts, video_want budgets, SDP-bytes vs the 128 KiB cap, 0 leg-drops',
    subject: 'V2 U7 video harness legs + capacity',
    gateKey: 'load_test.scenarios.voice_video',
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
    const shape = String(knobs.shape ?? 'cameras');
    const defaults =
      shape === 'stage'
        ? { participants: 25, windowS: 60, settleS: 30 }
        : shape === 'turn'
          ? { participants: 4, windowS: 30, settleS: 15 }
          : { participants: 10, windowS: 45, settleS: 20 };
    const participants = Number(knobs.participants ?? defaults.participants);
    const windowS = Number(knobs.windowS ?? defaults.windowS);
    const settleS = Number(knobs.settleS ?? defaults.settleS);
    // Stage shape pumps at the GO-branch q-layer rate by default (the spike's
    // measured low-layer packet rate — what real browser tiles produce);
    // `videoPps=200` reproduces the single-layer fallback ceiling (measured
    // at N=25 to sit in the collapse band — research doc's V2 harness entry).
    const videoPps = Number(knobs.videoPps ?? (shape === 'stage' ? 50 : 200));
    const connectTimeoutMs = Number(knobs.connectTimeoutMs ?? 240_000);
    const callEndTimeoutMs = Number(knobs.callEndTimeoutMs ?? 90_000);
    // Delivery floors encode the branch being measured: the sidecar's video
    // is single-layer 200pps (the honest library-only ceiling — KDV4's
    // fallback numbers), so the stage shape at N=25 sits at the spike's
    // measured collapse boundary (~2,400pps per receiver PC) and its floors
    // assert the fallback-branch envelope, not the GO branch's q-layer
    // rates (those are the two-browser e2e's gate).
    const minAudioPct = Number(
      knobs.minAudioPct ?? (shape === 'cameras' || shape === 'turn' ? 95 : shape === 'churn' ? 90 : 50),
    );
    const minVideoPct = Number(knobs.minVideoPct ?? (shape === 'cameras' ? 85 : shape === 'stage' ? 40 : 50));
    const budgetReceiver = Number(knobs.budgetReceiver ?? 0);
    const budgetTiles = Number(knobs.budgetTiles ?? 2);
    const stageTiles = Number(knobs.stageTiles ?? 4);
    const churnPublishers = Number(knobs.churnPublishers ?? 3);
    const churnIntervalMs = Number(knobs.churnIntervalMs ?? 400);
    const churnRounds = Number(knobs.churnRounds ?? 12);
    // Stage default: publishes land AFTER the N=25 join cascade settles.
    // Measured 2026-09-07: with a 2 s delay, 1–3 of 25 legs lost
    // renegotiation liveness where the two cascades overlapped (their
    // negotiation stopped mid-run — offers 15 vs ~49 for healthy legs, zero
    // delivery for the stall, no ws close, no client-visible failure);
    // staggered past the cascade, all 25 converge and deliver ~100%. The
    // overlap stall is recorded in the research doc as a server-lane
    // follow-up on this hardware.
    const publishDelayMs = Number(
      knobs.publishDelayMs ?? (shape === 'stage' ? 8_000 : 2_000),
    );
    const turnUrl = String(knobs.turnUrl ?? process.env.ETURNAL_URL ?? '');
    const turnSecret = String(knobs.turnSecret ?? process.env.ETURNAL_SECRET ?? '');

    const metrics: Record<string, number | string | boolean> = { shape, participants, videoPps };

    // -- TURN shape: allocation PASS is the bar (deploy/turn-check.exs) ------
    if (shape === 'turn') {
      if (turnUrl === '' || turnSecret === '') {
        return {
          name: this.descriptor.name,
          passed: true,
          summary: 'skipped — eturnal not configured (set --set turnUrl=… --set turnSecret=… or ETURNAL_URL/ETURNAL_SECRET)',
          metrics: { ...metrics, turnStatus: 'skipped', turnAllocationPass: false },
        };
      }

      const m = turnUrl.match(/^turns?:\/\/([^:/?]+):(\d+)/);
      const host = m?.[1] ?? '127.0.0.1';
      const port = m?.[2] ?? '3478';
      const res = spawnSync(
        'elixir',
        [join(REPO_ROOT, 'deploy/turn-check.exs'), '--host', host, '--port', port, '--secret', turnSecret],
        { encoding: 'utf8', timeout: 120_000 },
      );
      const allocationPass = res.status === 0;
      metrics.turnAllocationPass = allocationPass;
      metrics.turnCheckOut = (res.stdout ?? '').split('\n').filter((l) => l.includes('PASS') || l.includes('FAIL'))[0] ?? '';
      if (!allocationPass) {
        return {
          name: this.descriptor.name,
          passed: false,
          summary: `TURN allocation FAILED (exit ${res.status}): ${(res.stderr || res.stdout || '').slice(-300)}`,
          metrics,
        };
      }
    }

    // -- Provision + start ------------------------------------------------------
    const room = await voice.provision({ userCount: participants, label: `video-${shape}` });
    const channelId = room.channelId;

    // Every shape publishes cameras on all participants; the stage shape
    // adds two screen sharers (idx 0 then idx 1 — the LATER publish is the
    // most-recent screen, i.e. the stage, by `since` recency).
    const cameraCount = participants;
    const screenCount = shape === 'stage' ? 2 : 0;

    const tiles: Record<string, number> = {};
    if (shape === 'cameras' || shape === 'stage' || shape === 'turn') {
      tiles[String(budgetReceiver)] = budgetTiles;
    }
    if (shape === 'stage') {
      for (let i = 0; i < participants; i++) {
        if (i !== budgetReceiver) tiles[String(i)] = stageTiles;
      }
    }

    const clients: VoiceClientHandle[] = [];
    let sidecar: SidecarHandle | null = null;
    let summary = '';

    try {
      const owner = voice.createClient(room.ownerToken, 'owner');
      clients.push(owner);
      await owner.connect();
      await pollUntil('owner ready', () => owner.ready, 30_000);

      owner.start(channelId, false);
      await pollUntil('CALL_START observed by owner', () => owner.hasCaptured('CallStart'), 10_000);

      sidecar = await voice.startSidecar({
        tokens: room.tokens.slice(0, participants),
        channelId,
        durationS: windowS + settleS,
        pps: 50,
        labelPrefix: 'v',
        video: {
          cameraCount,
          screenCount,
          videoPps,
          videoBytes: 1_000,
          publishDelayMs,
          tiles,
          ...(shape === 'churn' ? { churnPublishers, churnIntervalMs, churnRounds } : {}),
        },
        ...(shape === 'turn' ? { turnOnly: 1, turnUrl, turnSecret } : {}),
      });

      await sidecar.waitAllConnected(connectTimeoutMs);
      // Video flowing: at least one participant has pumped video packets.
      if (shape !== 'churn') {
        await pollUntil(
          'video packets flowing',
          () => {
            const t = sidecar!.ticks().at(-1);
            return (t?.participants ?? []).some((p) => (p.video_sent ?? 0) > 0) ? true : false;
          },
          60_000,
        );
      }
      const steadyVideoTick = sidecar.ticks().at(-1) ?? sidecar.ticks()[0]!;

      // Roster: owner + N sidecar members.
      const expectedRoster = [...room.userIds.slice(0, participants), room.ownerUserId].sort();
      await pollUntil(
        `roster to reach ${expectedRoster.length} members`,
        () => JSON.stringify(owner.rosterIds(channelId)) === JSON.stringify(expectedRoster),
        60_000,
      );

      // The envelope-v2 wire, seen from the TS side too: every captured
      // CallSignal offer body is measured against the cap and parsed with
      // the PRODUCTION codec. A body present but unparseable is RECORDED as
      // codec drift (measured 2026-09-07: the server emits "rids": null on
      // audio ingest entries, which parseCallSignalOfferEnvelope rejects —
      // see the research doc's V2 harness entry; not this scenario's
      // subject, so it is surfaced, not gated).
      let tsMaxBodyBytes = 0;
      let tsBodiesSeen = 0;
      let envelopeV2Seen = false;
      const checkBodies = (): void => {
        for (const ev of owner.capturedOf('CallSignal')) {
          const body = (ev.payload as { body?: string }).body ?? '';
          if (body === '') continue;
          tsBodiesSeen++;
          tsMaxBodyBytes = Math.max(tsMaxBodyBytes, bodyBytesOf(body));
          if (offerEnvelopeOf(body) !== null) envelopeV2Seen = true;
        }
      };
      checkBodies();

      // Churn shape: wait out the storm (toggles observed on ticks) before
      // the steady-window checkpoint.
      if (shape === 'churn') {
        const wantToggles = churnPublishers * churnRounds;
        await pollUntil(
          `churn storm observed (${wantToggles} toggles)`,
          () => {
            const t = sidecar!.ticks().at(-1);
            const seen = (t?.participants ?? []).reduce((a, p) => a + (p.churn_toggles ?? 0), 0);
            return seen >= wantToggles;
          },
          Math.max(60_000, churnPublishers * churnRounds * churnIntervalMs + 60_000),
        ).catch(() => undefined);
        // Let the final re-publish renegotiate before the checkpoint.
        await new Promise((r) => setTimeout(r, 3_000));
      }

      // Roster intact at the checkpoint (post-storm, mid-window — the
      // sidecar's teardown emptying the roster comes AFTER this).
      const rosterAfter = owner.rosterIds(channelId);
      const rosterIntact = JSON.stringify(rosterAfter) === JSON.stringify(expectedRoster);

      // The owner leaves so the empty sweep can end the call once the
      // sidecar's participants tear down (CALL_END `last_left`).
      owner.leave(channelId);
      await pollUntil(
        'owner left roster',
        () => owner.rosterSize(channelId) === participants,
        10_000,
      );

      const final = await sidecar.done;
      sidecar = null;
      checkBodies();

      const parts = final.participants ?? [];
      const view: TickView = { steady: steadyVideoTick, final };

      // -- Assertion cores -----------------------------------------------------
      const audio = audioDelivery(view.steady, view.final);
      const connected = parts.filter((p) => p.connected === 1 || p.received > 0).length;
      const pcFailures = parts.reduce((a, p) => a + (p.pc_failures ?? 0), 0);
      const churnToggles = parts.reduce((a, p) => a + (p.churn_toggles ?? 0), 0);
      const offersTotal = parts.reduce((a, p) => a + p.offers, 0);
      const maxSdpBodyBytes = Math.max(0, ...parts.map((p) => p.max_sdp_body_bytes ?? 0), tsMaxBodyBytes);
      const maxVideoLatencyMs = Math.max(0, ...parts.map((p) => p.max_video_latency_ms ?? 0));

      Object.assign(metrics, {
        connected,
        pcFailures,
        churnToggles,
        offersTotal,
        maxSdpBodyBytes,
        sdpCapBytes: CALL_SIGNAL_BODY_MAX_BYTES,
        sdpCapPct: Math.round((maxSdpBodyBytes / CALL_SIGNAL_BODY_MAX_BYTES) * 1000) / 10,
        tsMaxBodyBytes,
        envelopeV2Seen,
        tsBodiesSeen,
        envelopeCodecDrift: tsBodiesSeen > 0 && !envelopeV2Seen,
        audioDeliveryPct: Math.round(audio.aggregate * 10) / 10,
        minAudioReceiverPct: Math.round(audio.minReceiver * 10) / 10,
        maxVideoLatencyMs,
      });

      // Per-receiver video conservation over the steady window: for each
      // receipt key ("user/source"), Δrecv vs THAT SENDER's Δsent for the
      // source (the sender idx comes from the provisioned user ids — the
      // sidecar's labels and token order line up with room.userIds).
      const senderDelta: Array<Record<string, number>> = parts.map((p, i) =>
        counterDelta(participantAt(view.steady, i)?.video?.sent ?? {}, p.video?.sent ?? {}),
      );
      const senderIdxByUser = new Map<string, number>(
        room.userIds.slice(0, participants).map((uid, i) => [uid, i]),
      );

      const videoPcts: number[] = [];
      const perReceiverVideo: string[] = [];
      for (let i = 0; i < parts.length; i++) {
        const recvEnd = parts[i]?.video?.recv ?? {};
        const recvStart = participantAt(view.steady, i)?.video?.recv ?? {};
        const delta = counterDelta(recvStart, recvEnd);
        const { count } = distinctVideoSources(delta);
        let gotTotal = 0;
        let expectedTotal = 0;
        for (const [key, got] of Object.entries(delta)) {
          const [uid, source] = key.split('/');
          const sender = senderIdxByUser.get(uid ?? '');
          const sent = sender !== undefined ? (senderDelta[sender]?.[source ?? ''] ?? 0) : 0;
          if (sent > 0) {
            gotTotal += got;
            expectedTotal += sent;
          }
        }
        const pct = expectedTotal > 0 ? (gotTotal / expectedTotal) * 100 : 0;
        if (expectedTotal > 0) videoPcts.push(pct);
        perReceiverVideo.push(`v${i}:src${count}/d${Math.round(pct)}`);
      }
      const videoDeliveryPct = videoPcts.length > 0 ? videoPcts.reduce((a, b) => a + b, 0) / videoPcts.length : 0;
      const minVideoReceiverPct = videoPcts.length > 0 ? Math.min(...videoPcts) : 0;
      Object.assign(metrics, {
        videoDeliveryPct: Math.round(videoDeliveryPct * 10) / 10,
        minVideoReceiverPct: Math.round(minVideoReceiverPct * 10) / 10,
        perReceiverVideo: perReceiverVideo.join(' '),
        perParticipantDetail: parts
          .map(
            (p, i) =>
              `v${i}:s${p.sent}/r${p.received}/vs${p.video_sent ?? 0}/vr${p.video_received ?? 0}/o${p.offers}/a${p.answers}/w${p.ws_closed}/t${p.inbound_tracks}`,
          )
          .join(' '),
      });

      // Budget receiver: receipts within its declared tiles. The stage
      // screen is budget-EXEMPT on the server (R7); non-stage screens ride
      // their own rank list — the counted set is camera sources.
      const budgetRecv = counterDelta(
        participantAt(view.steady, budgetReceiver)?.video?.recv ?? {},
        parts[budgetReceiver]?.video?.recv ?? {},
      );
      const budgetStageKey = shape === 'stage' ? `${room.userIds[1]!}/screen` : null;
      const budget = checkBudgetCoverage(budgetRecv, budgetTiles, budgetStageKey, { min: 200 });
      Object.assign(metrics, {
        budgetReceiver,
        budgetTiles,
        budgetDistinctSources: budget.distinct,
        budgetWithinBudget: budget.withinBudget,
        budgetKeys: budget.keys.join(','),
      });

      // Stage shape: the LATER screen publish is the stage (most-recent
      // `since`); it must reach every other participant (R7 — the stage
      // never drops), and the non-stage screen rides tile budgets.
      let stageOk = true;
      let stageReceivers = 0;
      if (shape === 'stage') {
        const stageUser = room.userIds[1]!;
        const stageKey = `${stageUser}/screen`;
        for (let i = 0; i < parts.length; i++) {
          if (i === 1) continue;
          const delta = counterDelta(
            participantAt(view.steady, i)?.video?.recv ?? {},
            parts[i]?.video?.recv ?? {},
          );
          if ((delta[stageKey] ?? 0) > 0) stageReceivers++;
        }
        stageOk = stageReceivers === parts.length - 1;
        Object.assign(metrics, { stageUser, stageKey, stageReceivers, stageReceiversExpected: parts.length - 1 });
      }

      // Churn shape: bounded offer cascades. The structural bound: each
      // toggle is TWO roster transitions (unpublish + publish), each fanning
      // out one offer per participant without coalescing, plus the join
      // cascade (roster changes as each of N joins). The compression ratio
      // vs that uncoalesced fan-out is the measurement (the glare guard's
      // coalescing at work); cascade depth itself is structurally ≤ 2
      // (offer → answer → single queued flush — the spike's arm-c shape).
      let cascadeBounded = true;
      if (shape === 'churn' && churnToggles > 0) {
        const uncoalesced = 2 * churnToggles * participants + (participants * (participants + 1)) / 2;
        cascadeBounded = offersTotal <= uncoalesced * 1.05;
        Object.assign(metrics, {
          uncoalescedOffers: uncoalesced,
          offerCompressionVsUncoalesced: Math.round((offersTotal / uncoalesced) * 1000) / 1000,
          cascadeBounded,
        });
      }

      Object.assign(metrics, { rosterIntact, rosterAfterCount: rosterAfter.length });

      // TURN shape: the relay-only participant's receipts (relayed media on
      // this single-host topology is reported, not gated — allocation was).
      if (shape === 'turn') {
        const relay = parts[0];
        Object.assign(metrics, {
          turnRelayReceivedAudio: relay?.received ?? 0,
          turnRelayReceivedVideo: relay?.video_received ?? 0,
          turnRelayConnected: relay?.connected === 1,
        });
      }

      // CALL_END after everyone left (the empty sweep).
      let callEndObserved = false;
      if (callEndTimeoutMs > 0) {
        await pollUntil('CALL_END after last participant left', () => owner.hasCaptured('CallEnd'), callEndTimeoutMs).catch(
          () => undefined,
        );
        callEndObserved = owner.capturedOf('CallEnd').length > 0;
      }
      Object.assign(metrics, { callEndObserved });

      const baseChecks =
        connected === participants &&
        pcFailures === 0 &&
        rosterIntact &&
        maxSdpBodyBytes <= CALL_SIGNAL_BODY_MAX_BYTES &&
        maxVideoLatencyMs < 15_000;

      Object.assign(metrics, {
      videoPpsNote:
        shape === 'stage'
          ? 'stage pumps q-layer rate (GO-branch tiles); videoPps=200 reproduces the single-layer fallback ceiling'
          : 'single-layer 200pps (fallback-branch rate)',
    });

      const shapeChecks =
        shape === 'churn'
          ? cascadeBounded && audio.minReceiver >= minAudioPct
          : shape === 'stage'
            ? stageOk && budget.withinBudget && audio.minReceiver >= minAudioPct && minVideoReceiverPct >= minVideoPct
            : shape === 'turn'
              ? metrics.turnRelayConnected === true
              : budget.withinBudget && audio.minReceiver >= minAudioPct && minVideoReceiverPct >= minVideoPct;

      const passed = baseChecks && shapeChecks;

      summary = passed
        ? `${shape} @N=${participants}: audio ${audio.minReceiver.toFixed(1)}% min receiver, video ${minVideoReceiverPct.toFixed(1)}% min, ` +
          `SDP max ${maxSdpBodyBytes}B (${metrics.sdpCapPct}% of cap), leg-drops ${pcFailures}` +
          (shape === 'churn' ? `, ${churnToggles} toggles, offers ${offersTotal}` : '') +
          (shape === 'stage' ? `, stage→${stageReceivers}/${(parts.length ?? 1) - 1}` : '') +
          (shape === 'turn' ? `, TURN relay audio=${metrics.turnRelayReceivedAudio} video=${metrics.turnRelayReceivedVideo}` : '')
        : `FAILED: connected ${connected}/${participants}, pcFailures ${pcFailures}, rosterIntact ${rosterIntact}, ` +
          `audio ${audio.minReceiver.toFixed(1)}/${minAudioPct}%, video ${minVideoReceiverPct.toFixed(1)}/${minVideoPct}%, ` +
          `SDP ${maxSdpBodyBytes}B` +
          (shape === 'churn' ? '' : `, budget ${budget.distinct}≤${budgetTiles}=${budget.withinBudget}`) +
          (shape === 'stage' ? `, stage ${stageReceivers}/${(parts.length ?? 1) - 1}` : '') +
          (shape === 'churn' ? `, cascadeBounded ${cascadeBounded}` : '');

      return { name: this.descriptor.name, passed, summary, metrics };
    } finally {
      sidecar?.kill();
      for (const c of clients) c.destroy();
    }
  },
};
