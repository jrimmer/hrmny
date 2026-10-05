/**
 * U13 voice modules — unit tests.
 *
 * 1. Pure assertion cores: roster reduction, replay integrity, delivery
 *    math, sidecar line parsing.
 * 2. VirtualVoiceClient against an in-process fake gateway (real
 *    GatewayClient + real codec decode of hand-built dispatches).
 * 3. Scenario smoke runs against a fully fake voice seam (registry wiring,
 *    orchestration, pass/fail folding).
 */

import { describe, expect, it } from 'vitest';
import { GatewayOp, type GatewayEnvelope } from '@cytale/protocol';
import type { GatewaySocketLike } from '@cytale/gateway-client';

import {
  applyCallEvent,
  applyCallSync,
  checkReplayIntegrity,
  deliveryPercentages,
  emptyRoster,
  RESUME_BUFFER_CAP,
} from '../src/voice/roster.js';
import { parseReportLine, sidecarEnvFor } from '../src/voice/sidecar.js';
import {
  attributionFromManifest,
  bodyBytesOf,
  checkBudgetCoverage,
  counterDelta,
  distinctVideoSources,
  offerEnvelopeOf,
} from '../src/voice/manifest.js';
import { scenarioNames } from '../src/scenarios/index.js';
import { voiceVideoScenario } from '../src/voice/scenarios/voice_video.js';
import { RawResumeProber, type ProberSocketLike } from '../src/voice/raw_resume_prober.js';
import { VirtualVoiceClient } from '../src/voice/virtual_voice_client.js';
import { voiceLoadScenario } from '../src/voice/scenarios/voice_load.js';
import { voiceResumeScenario } from '../src/voice/scenarios/voice_resume.js';
import type {
  ProvisionedVoiceRoom,
  SidecarHandle,
  SidecarReport,
  VoiceClientHandle,
  VoiceSeam,
} from '../src/voice/types.js';
import type { ScenarioContext } from '../src/scenarios/types.js';

const CHANNEL = '9007199254740993';

// ---------------------------------------------------------------------------
// 1. Pure cores
// ---------------------------------------------------------------------------

describe('U13 roster reduction', () => {
  it('folds start → joined legs → flags → departures → end', () => {
    let roster = emptyRoster();
    roster = applyCallEvent(roster, {
      channel_id: CHANNEL,
      call_id: '1',
      thread_id: '2',
      started_by: '10',
      started_at: 'now',
    });
    expect(roster.callId).toBe('1');

    roster = applyCallEvent(roster, {
      channel_id: CHANNEL,
      call_id: '1',
      user_id: '10',
      leg: 'a',
      state: 'joined',
    });
    roster = applyCallEvent(roster, {
      channel_id: CHANNEL,
      call_id: '1',
      user_id: '11',
      leg: 'b',
      state: 'joined',
    });
    expect([...roster.members.keys()].sort()).toEqual(['10', '11']);

    roster = applyCallEvent(roster, {
      channel_id: CHANNEL,
      call_id: '1',
      user_id: '10',
      leg: 'a',
      state: 'muted',
    });
    expect(roster.members.get('10')?.mute).toBe(true);

    roster = applyCallEvent(roster, {
      channel_id: CHANNEL,
      call_id: '1',
      user_id: '11',
      leg: 'b',
      state: 'displaced',
    });
    expect([...roster.members.keys()]).toEqual(['10']);

    roster = applyCallEvent(roster, {
      channel_id: CHANNEL,
      call_id: '1',
      reason: 'last_left',
      ended_at: 'later',
    });
    expect(roster.members.size).toBe(0);
    expect(roster.callId).toBeNull();
  });

  it('folds V2 source states (camera_on/off, CALL_SYNC sources[]) into members', () => {
    let roster = emptyRoster();
    roster = applyCallEvent(roster, { channel_id: CHANNEL, call_id: '1', thread_id: '2', started_by: '10', started_at: 'now' });
    roster = applyCallEvent(roster, { channel_id: CHANNEL, call_id: '1', user_id: '10', leg: 'a', state: 'joined' });

    roster = applyCallEvent(roster, { channel_id: CHANNEL, call_id: '1', user_id: '10', leg: 'a', state: 'camera_on', source: 'camera' });
    roster = applyCallEvent(roster, { channel_id: CHANNEL, call_id: '1', user_id: '10', leg: 'a', state: 'screen_on', source: 'screen' });
    expect(roster.members.get('10')?.sources).toEqual(['camera', 'screen']);

    roster = applyCallEvent(roster, { channel_id: CHANNEL, call_id: '1', user_id: '10', leg: 'a', state: 'camera_off', source: 'camera' });
    expect(roster.members.get('10')?.sources).toEqual(['screen']);

    // CALL_SYNC replaces wholesale — sources included.
    roster = applyCallSync(roster, CHANNEL, {
      channel_id: CHANNEL,
      call_id: '1',
      thread_id: null as never,
      participants: [
        { user_id: '10', mute: false, deafen: false, sources: [{ source: 'screen_audio', since: 'now' }] },
        { user_id: '11', mute: false, deafen: false },
      ],
    });
    expect(roster.members.get('10')?.sources).toEqual(['screen_audio']);
    expect(roster.members.get('11')?.sources).toEqual([]);
  });

  it('replaces a channel roster wholesale on CALL_SYNC and clears when absent', () => {
    let roster = emptyRoster();
    roster = applyCallSync(roster, CHANNEL, {
      channel_id: CHANNEL,
      call_id: '7',
      thread_id: null as never,
      participants: [
        { user_id: '10', mute: false, deafen: false },
        { user_id: '11', mute: true, deafen: false },
      ],
    });
    expect([...roster.members.keys()].sort()).toEqual(['10', '11']);
    expect(roster.members.get('11')?.mute).toBe(true);

    roster = applyCallSync(roster, CHANNEL, undefined);
    expect(roster.members.size).toBe(0);
  });
});

describe('U13 replay integrity', () => {
  it('accepts a contiguous replay and rejects gaps/duplicates', () => {
    expect(checkReplayIntegrity(10, [11, 12, 13])).toMatchObject({ contiguous: true, count: 3 });
    expect(checkReplayIntegrity(10, [11, 13]).contiguous).toBe(false);
    expect(checkReplayIntegrity(10, [11, 11]).contiguous).toBe(false);
    expect(checkReplayIntegrity(10, []).contiguous).toBe(true);
  });

  it('flags over-cap replays against the documented session cap', () => {
    expect(RESUME_BUFFER_CAP).toBe(1000);
    const seqs = Array.from({ length: RESUME_BUFFER_CAP + 1 }, (_, i) => i + 1);
    expect(checkReplayIntegrity(0, seqs).withinCap).toBe(false);
    expect(checkReplayIntegrity(0, seqs.slice(0, 1000)).withinCap).toBe(true);
  });
});

describe('U13 delivery math', () => {
  it('computes per-receiver percentages against the (n−1)×pps envelope', () => {
    // 10 receivers, 9 streams each at 50pps over 60s → 27000 expected each.
    const got = deliveryPercentages(
      Array(10).fill(26_800),
      Array(10).fill(100),
      10,
      50,
      60_000,
    );
    expect(got.every((p) => p > 95 && p < 100)).toBe(true);
  });

  it('degrades to 0% on an empty window', () => {
    expect(deliveryPercentages([5], [0], 2, 50, 0)).toEqual([0]);
  });
});

describe('U13 sidecar line parsing', () => {
  it('parses the three report line kinds and tolerates noise', () => {
    const tick = parseReportLine('VOICE_TICK {"t":5000,"all_connected":true,"participants":[{"label":"v0","connected":1,"sent":10,"received":90,"offers":1,"answers":1,"ice_sent":2,"inbound_tracks":9,"connected_after_ms":900,"ws_closed":0,"last_latency_ms":3.2,"max_latency_ms":40.0}]}');
    expect(tick?.type).toBe('tick');
    expect(tick?.all_connected).toBe(true);
    expect(tick?.participants?.[0]?.received).toBe(90);

    const fin = parseReportLine('VOICE_FINAL {"t":60000,"delivery_pct":97.5,"steady_window_ms":55000}');
    expect(fin?.type).toBe('final');
    expect(fin?.delivery_pct).toBe(97.5);

    const meta = parseReportLine('VOICE_META {"n":10,"pps":50}');
    expect(meta?.type).toBe('meta');

    expect(parseReportLine('12:34:56.789 [info] sidecar ready')).toBeNull();
    expect(parseReportLine('VOICE_TICK not-json')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. VirtualVoiceClient against a fake gateway (real codec path)
// ---------------------------------------------------------------------------

class FakeSocket implements GatewaySocketLike {
  open = false;
  onopen: (() => void) | null = null;
  onmessage: ((data: unknown) => void) | null = null;
  onclose: ((info: { code: number; reason: string }) => void) | null = null;
  onerror: ((err: { message?: string }) => void) | null = null;

  constructor(
    public readonly url: string,
    private readonly server: FakeVoiceGateway,
  ) {}

  send(data: string): void {
    if (!this.open) throw new Error('fake socket send while not open');
    this.server.record(this, data);
  }

  serverSend(envelope: GatewayEnvelope): void {
    this.onmessage?.(JSON.stringify(envelope));
  }

  close(code?: number, reason?: string): void {
    if (!this.open) return;
    this.open = false;
    this.onclose?.({ code: code ?? 1005, reason: reason ?? '' });
  }

  simulateOpen(): void {
    this.open = true;
    this.onopen?.();
  }
}

class FakeVoiceGateway {
  readonly sockets: FakeSocket[] = [];
  private nextSeq = 1;
  /** channel roster: user id -> leg */
  readonly roster = new Map<string, string>();
  readonly op23Count: number[] = [];
  callStarted = false;
  callEnded = false;
  /** dispatches buffered for replay (seq → frame). */
  readonly buffered: Array<{ seq: number; envelope: GatewayEnvelope }> = [];

  readonly socketFactory = (url: string): FakeSocket => {
    const socket = new FakeSocket(url, this);
    this.sockets.push(socket);
    queueMicrotask(() => {
      if (!socket.open) socket.simulateOpen();
      // HELLO on the NEXT macrotask: real sockets deliver open first and let
      // the open-continuation attach message handlers before frames arrive.
      setTimeout(() => socket.serverSend({ op: GatewayOp.Hello, d: { heartbeat_interval: 60_000 } } as GatewayEnvelope), 0);
    });
    return socket;
  };

  userIdFor(socket: FakeSocket): string {
    return String(5000 + this.sockets.indexOf(socket));
  }

  record(socket: FakeSocket, raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const frame = parsed as { op: number; d: Record<string, unknown> };

    if (frame.op === GatewayOp.Identify) {
      queueMicrotask(() => socket.serverSend({
        op: GatewayOp.Dispatch,
        t: 'Ready',
        s: 0,
        d: {
          v: 1,
          session_id: 's-' + this.sockets.indexOf(socket),
          resume_token: 'rt-' + this.sockets.indexOf(socket),
          heartbeat_interval: 60_000,
          user: { id: this.userIdFor(socket), username: 'fake' },
        },
      } as unknown as GatewayEnvelope));
      // V2 (U7): a fresh Identify backfills CALL_SYNC when a call is live —
      // participants carry their live published sources.
      if (this.callStarted) {
        queueMicrotask(() => socket.serverSend({
          op: GatewayOp.Dispatch,
          t: 'CallSync',
          s: 0,
          d: {
            calls: [{
              channel_id: CHANNEL,
              call_id: '77',
              thread_id: '78',
              participants: [...this.roster.entries()].map(([uid]) => ({
                user_id: uid,
                mute: false,
                deafen: false,
                ...(this.sources.get(uid) && this.sources.get(uid)!.size > 0
                  ? { sources: [...this.sources.get(uid)!].map((source) => ({ source, since: 'now' })) }
                  : {}),
              })),
            }],
            dm_calls: [],
          },
        } as unknown as GatewayEnvelope));
      }
      return;
    }

    if (frame.op === GatewayOp.Resume) {
      // gateway.md semantics: RESUMED first, then every buffered dispatch
      // with s > the requested seq, oldest first.
      const fromSeq = Number(frame.d['seq'] ?? 0);
      const replay = this.buffered.filter((b) => b.seq > fromSeq);
      queueMicrotask(() => {
        socket.serverSend({
          op: GatewayOp.Dispatch,
          t: 'Resumed',
          s: 0,
          d: { replayed_events: replay.length, heartbeat_interval: 60_000 },
        } as unknown as GatewayEnvelope);
        for (const b of replay) socket.serverSend(b.envelope);
      });
      return;
    }

    if (frame.op === GatewayOp.CALL_STATE_UPDATE) {
      const action = String(frame.d['action']);
      const uid = this.userIdFor(socket);
      if (action === 'start' && !this.callStarted) {
        this.callStarted = true;
        this.broadcast({ channel_id: CHANNEL, call_id: '77', thread_id: '78', started_by: uid, started_at: 'now' }, 'CallStart');
        this.join(uid);
      } else if (action === 'join') {
        this.join(uid);
      } else if (action === 'leave') {
        this.roster.delete(uid);
        this.broadcast(
          { channel_id: CHANNEL, call_id: '77', user_id: uid, leg: 'leg-' + uid, state: 'left' },
          'CallUpdate',
        );
      } else if (action === 'publish') {
        this.publishSource(uid, String(frame.d['source']), true);
      } else if (action === 'unpublish') {
        this.publishSource(uid, String(frame.d['source']), false);
      }
      return;
    }

    if (frame.op === GatewayOp.CALL_SIGNAL) {
      this.op23Count.push(this.sockets.indexOf(socket));
    }
  }

  /** V2: source-state roster mirror (userId -> Set<source>). */
  readonly sources = new Map<string, Set<string>>();

  private publishSource(uid: string, source: string, on: boolean): void {
    const set = this.sources.get(uid) ?? new Set<string>();
    if (on) set.add(source);
    else set.delete(source);
    this.sources.set(uid, set);
    this.broadcast(
      {
        channel_id: CHANNEL,
        call_id: '77',
        user_id: uid,
        leg: 'leg-' + uid,
        state: `${source}_${on ? 'on' : 'off'}`,
        source,
      },
      'CallUpdate',
    );
  }

  private join(uid: string): void {
    this.roster.set(uid, 'leg-' + uid);
    this.broadcast(
      { channel_id: CHANNEL, call_id: '77', user_id: uid, leg: 'leg-' + uid, state: 'joined' },
      'CallUpdate',
    );
  }

  /** Broadcast a channel-keyed dispatch to every open socket. */
  broadcast(d: unknown, t: string): void {
    const envelope = { op: GatewayOp.Dispatch, t, s: this.nextSeq++, d } as unknown as GatewayEnvelope;
    this.buffered.push({ seq: envelope.s as number, envelope });
    for (const socket of this.sockets) {
      if (socket.open) socket.serverSend(envelope);
    }
  }

  endCall(): void {
    this.callEnded = true;
    this.roster.clear();
    this.broadcast({ channel_id: CHANNEL, call_id: '77', reason: 'last_left', ended_at: 'now' }, 'CallEnd');
  }
}

describe('U13 VirtualVoiceClient (real gateway client + codecs, fake wire)', () => {
  it('identifies, starts a call, and derives the roster from CALL_* dispatches', async () => {
    const gateway = new FakeVoiceGateway();
    const client = new VirtualVoiceClient({ url: 'ws://fake', token: 'tok', label: 't', socketFactory: gateway.socketFactory });
    try {
      await client.connect();
      const deadline = Date.now() + 2_000;
      while (client.userId === null && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(client.userId).toBe('5000');

      client.start(CHANNEL);
      await new Promise((r) => setTimeout(r, 50));
      expect(client.hasCaptured('CallStart')).toBe(true);
      expect(client.rosterIds(CHANNEL)).toEqual([client.userId!]);

      client.join(CHANNEL);
      client.leave(CHANNEL);
      await new Promise((r) => setTimeout(r, 50));
      expect(client.rosterSize(CHANNEL)).toBe(0);

      gateway.endCall();
      await new Promise((r) => setTimeout(r, 50));
      expect(client.hasCaptured('CallEnd')).toBe(true);
    } finally {
      client.destroy();
    }
  });

  it('sends op-23 bursts through the production send path', async () => {
    const gateway = new FakeVoiceGateway();
    const client = new VirtualVoiceClient({ url: 'ws://fake', token: 'tok', label: 't', socketFactory: gateway.socketFactory });
    try {
      await client.connect();
      await client.signalBurst(CHANNEL, 3, 1);
      expect(gateway.op23Count.length).toBeGreaterThanOrEqual(3);
    } finally {
      client.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Scenario smoke runs against a fully fake voice seam
// ---------------------------------------------------------------------------

/** Adapts the fake on*-property socket to the prober's addEventListener surface. */
class ProberSocketAdapter implements ProberSocketLike {
  readyState = 1;
  private readonly messageCbs = new Set<(ev: { data: unknown }) => void>();

  constructor(private readonly fake: FakeSocket) {}

  send(data: string): void {
    this.fake.send(data);
  }

  close(code?: number, reason?: string): void {
    this.fake.close(code, reason);
  }

  addEventListener(type: 'message' | 'open' | 'close', cb: (ev: never) => void): void {
    if (type === 'message') {
      this.messageCbs.add(cb as (ev: { data: unknown }) => void);
      this.fake.onmessage = (d: unknown) => {
        for (const c of [...this.messageCbs]) c({ data: d });
      };
    } else if (type === 'open') {
      const fire = () => (cb as () => void)();
      if (this.fake.open) fire();
      else this.fake.onopen = fire;
    } else if (type === 'close') {
      this.fake.onclose = () => (cb as () => void)();
    }
  }

  removeEventListener(_type: 'message', cb: (ev: { data: unknown }) => void): void {
    this.messageCbs.delete(cb);
  }
}

function makeFakeWorld(): { voice: VoiceSeam; gateway: FakeVoiceGateway } {
  const gateway = new FakeVoiceGateway();
  const world = {
    sidecarUsers: [] as string[],
    provisionCount: 0,
  };

  const seam: VoiceSeam = {
    provision: async (req) => {
      world.provisionCount++;
      const tokens = Array.from({ length: req.userCount }, (_, i) => `sidecar-token-${world.provisionCount}-${i}`);
      const room: ProvisionedVoiceRoom = {
        workspaceId: '1',
        channelId: CHANNEL,
        ownerToken: 'owner-token',
        // The fake gateway names the FIRST client (the owner) user 5000.
        ownerUserId: '5000',
        tokens,
        // Synthetic sidecar participant ids (the fake sidecar joins these).
        userIds: tokens.map((_, i) => String(7000 + i)),
      };
      return room;
    },
    createClient: (token: string, label: string): VoiceClientHandle => {
      const c = new VirtualVoiceClient({
        url: 'ws://fake',
        token,
        label,
        socketFactory: gateway.socketFactory,
      });
      return c as unknown as VoiceClientHandle;
    },
    createProber: (token: string): RawResumeProber =>
      new RawResumeProber('ws://fake', token, (url) => new ProberSocketAdapter(gateway.socketFactory(url))),
    startSidecar: async (request) => {
      // Fake media legs: they "join" via the fake gateway and report a
      // healthy final delivery.
      world.sidecarUsers = request.tokens.map((_, i) => {
        const uid = String(7000 + i);
        gateway.roster.set(uid, 'leg-' + uid);
        gateway.broadcast(
          { channel_id: CHANNEL, call_id: '77', user_id: uid, leg: 'leg-' + uid, state: 'joined' },
          'CallUpdate',
        );
        return uid;
      });

      // V2 (U7): when the request carries a video plane, the fake legs
      // report per-source sent/recv maps keyed like the real sidecar's ETS
      // fold ("userId/source"), self-consistent for the conservation math.
      const n = request.tokens.length;
      const videoOn = request.video !== undefined && (request.video.cameraCount ?? 0) > 0;
      const fakeUserId = (i: number): string => String(7000 + i);
      const videoMaps = (i: number, sentPerSource: number, recvPerKey: number) =>
        videoOn
          ? {
              video_sent: sentPerSource,
              video_received: recvPerKey * Math.max(0, n - 1),
              max_video_latency_ms: 42,
              max_sdp_body_bytes: 5_000,
              pc_failures: 0,
              churn_toggles: 0,
              video: {
                sent: { camera: sentPerSource },
                recv: Object.fromEntries(
                  Array.from({ length: n }, (_, j) =>
                    j === i || recvPerKey <= 0 ? null : [`${fakeUserId(j)}/camera`, recvPerKey],
                  ).filter((e): e is [string, number] => e !== null),
                ),
              },
            }
          : {};

      const tick: SidecarReport = {
        type: 'tick',
        t: 5_000,
        all_connected: true,
        participants: request.tokens.map((_, i) => ({
          label: `v${i}`,
          connected: 1,
          sent: 250,
          received: 250 * (request.tokens.length - 1),
          last_latency_ms: 3,
          max_latency_ms: 30,
          offers: 1,
          answers: 1,
          ice_sent: 2,
          inbound_tracks: request.tokens.length - 1,
          connected_after_ms: 900,
          ws_closed: 0,
          ...videoMaps(i, 100, 0),
        })),
      };

      const handle: SidecarHandle = {
        ticks: () => [tick],
        waitAllConnected: async () => tick,
        done: new Promise<SidecarReport>((resolve) => {
          // Honor the requested window like the real sidecar (ms resolution
          // keeps the smoke fast: windowS=1, settleS=0 → 1000 ms).
          setTimeout(() => {
            for (const uid of world.sidecarUsers) {
              gateway.roster.delete(uid);
              gateway.broadcast(
                { channel_id: CHANNEL, call_id: '77', user_id: uid, leg: 'leg-' + uid, state: 'left' },
                'CallUpdate',
              );
            }
            // Roster now empty: the empty sweep ends the call.
            gateway.endCall();
            resolve({
              type: 'final',
              t: 60_000,
              delivery_pct: 97.2,
              steady_window_ms: 55_000,
              // Steady-window conservation: each sender's Δsent = 2_750
              // (55 s × 50 pps), each receiver gets 2 × 2_750 × 0.97.
              participants: tick.participants!.map((p, i) => ({
                ...p,
                sent: p.sent + 2_750,
                received: p.received + 5_335,
                ...(videoOn
                  ? {
                      ...videoMaps(
                        tick.participants!.indexOf(p),
                        1_000,
                        900,
                      ),
                    }
                  : {}),
              })),
              all_connected: true,
            });
          }, Math.max((request.durationS ?? 1) * 1000, 30));
        }),
        kill: () => undefined,
      };
      return handle;
    },
  };

  return { voice: seam, gateway };
}

function ctxFor(voice: VoiceSeam, knobs?: Record<string, number | string | boolean>): ScenarioContext {
  return {
    isShipped: true,
    harness: {
      connectAll: () => Promise.reject(new Error('unused')),
      runFanOutRound: () => Promise.reject(new Error('unused')),
      connectedCount: 0,
      disconnectClient: () => undefined,
      destroy: () => undefined,
    },
    channelIds: [],
    bounds: {},
    knobs,
    voice,
  };
}

describe('U13 voice_load scenario (fake seam smoke)', () => {
  it('runs the full orchestration and folds a passing result', async () => {
    const world = makeFakeWorld();
    const result = await voiceLoadScenario.run(
      ctxFor(world.voice, { participants: 3, signalClients: 1, windowS: 1, settleS: 4, callEndTimeoutMs: 5_000, connectTimeoutMs: 5_000 }),
    );

    expect(result.passed).toBe(true);
    expect(result.metrics.participants).toBe(3);
    expect(result.metrics.deliveryPct).toBeGreaterThan(95);
    expect(result.metrics.callEndObserved).toBe(true);
    expect(result.metrics.rosterOk).toBe(true);
  }, 20_000);

  it('fails when the sidecar reports under-delivery', async () => {
    const world = makeFakeWorld();
    const seam: VoiceSeam = {
      ...world.voice,
      startSidecar: async (request) => {
        const handle = await world.voice.startSidecar(request);
        return {
          ...handle,
          done: handle.done.then((fin) => ({ ...fin, delivery_pct: 80 })),
        };
      },
    };

    const result = await voiceLoadScenario.run(
      ctxFor(seam, { participants: 3, signalClients: 1, windowS: 1, settleS: 4, callEndTimeoutMs: 5_000, connectTimeoutMs: 5_000 }),
    );
    expect(result.passed).toBe(false);
  }, 20_000);
});

describe('U13 voice_resume scenario (fake seam smoke)', () => {
  it('churns, resumes, and asserts replay integrity', async () => {
    const world = makeFakeWorld();
    const result = await voiceResumeScenario.run(
      ctxFor(world.voice, { churnClients: 2, rounds: 2, burstCount: 2 }),
    );

    expect(result.passed).toBe(true);
    expect(result.metrics.contiguous).toBe(true);
    expect(result.metrics.noRefusal).toBe(true);
    expect(result.metrics.replayedEnvelopes).toBeGreaterThan(0);
    expect(result.metrics.resumeSuccessRate).toBe(1);
    expect(result.metrics.op23Bursts).toBe(8); // 2 clients x 2 rounds x 2-burst
    // V2 (U7): publish-state survived the mid-call resume + the fresh
    // session's CALL_SYNC backfill carries it.
    expect(result.metrics.sourcesSurviveResume).toBe(true);
    expect(result.metrics.sourcesInSyncBackfill).toBe(true);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// 4. V2 (U7) — manifest attribution, budget math, env contract, scenario
// ---------------------------------------------------------------------------

const OFFER_SDP =
  'v=0\r\n' +
  'o=- 1 1 IN IP4 127.0.0.1\r\n' +
  's=-\r\n' +
  't=0 0\r\n' +
  'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' +
  'a=mid:0\r\n' +
  'a=recvonly\r\n' +
  'm=video 9 UDP/TLS/RTP/SAVPF 96\r\n' +
  'a=mid:1\r\n' +
  'a=recvonly\r\n' +
  'a=rid:q recv\r\n' +
  'a=simulcast:recv q;h;f\r\n' +
  'm=video 9 UDP/TLS/RTP/SAVPF 96\r\n' +
  'a=mid:2\r\n' +
  'a=sendonly\r\n';

function envelopeBody(): string {
  return JSON.stringify({
    v: 2,
    type: 'offer',
    sdp: OFFER_SDP,
    tracks: [
      { mid: '0', user_id: '5000', source: 'mic' },
      { mid: '1', user_id: '5000', source: 'camera', rids: ['f', 'h', 'q'] },
      { mid: '2', user_id: '7001', source: 'screen' },
    ],
  });
}

describe('U7 manifest attribution (real envelope codec)', () => {
  it('parses envelope-v2 offer bodies and rejects non-offers', () => {
    const env = offerEnvelopeOf(envelopeBody());
    expect(env).not.toBeNull();
    expect(env!.v).toBe(2);
    expect(env!.tracks).toHaveLength(3);

    expect(offerEnvelopeOf(JSON.stringify({ type: 'offer', sdp: OFFER_SDP }))).toBeNull();
    expect(offerEnvelopeOf(JSON.stringify({ type: 'answer', sdp: OFFER_SDP }))).toBeNull();
    expect(offerEnvelopeOf('not json')).toBeNull();
    expect(offerEnvelopeOf(JSON.stringify({ v: 2, type: 'offer', sdp: OFFER_SDP, tracks: [{ mid: '', user_id: 'x', source: 'mic' }] }))).toBeNull();
  });

  it('splits egress streams from own ingest targets by user id', () => {
    const env = offerEnvelopeOf(envelopeBody())!;
    const mine = attributionFromManifest(env, '5000');
    expect(mine.ingest.map((t) => t.source).sort()).toEqual(['camera', 'mic']);
    expect(mine.ingest.find((t) => t.source === 'camera')?.rids).toEqual(['f', 'h', 'q']);
    expect(mine.egress).toHaveLength(1);
    expect(mine.egress[0]).toMatchObject({ mid: '2', userId: '7001', source: 'screen' });

    // Without an identity, every entry is an egress candidate (the sidecar's
    // direction-based fallback path).
    expect(attributionFromManifest(env, null).egress).toHaveLength(3);
  });

  it('measures body bytes against the 128 KiB cap', () => {
    expect(bodyBytesOf(envelopeBody())).toBeLessThan(131_072);
    expect(bodyBytesOf('x'.repeat(131_073))).toBe(131_073);
  });
});

describe('U7 budget + conservation math', () => {
  it('counts distinct video sources and respects budgets (cameras cut; stage exempt; screens ride their list)', () => {
    const recv = { '7001/camera': 900, '7002/camera': 850, '7003/screen': 950, '7001/mic': 300 };
    expect(distinctVideoSources(recv).count).toBe(3);
    expect(distinctVideoSources(recv).users).toEqual(['7001', '7002', '7003']);

    // The server's deliver? cuts the CAMERA ranking at `tiles` — screens
    // ride their own list (stage exempt, non-stage budgeted there).
    const budget = checkBudgetCoverage(recv, 2);
    expect(budget.withinBudget).toBe(true);
    expect(budget.distinct).toBe(2);
    expect(budget.screenKeys).toEqual(['7003/screen']);

    expect(checkBudgetCoverage(recv, 1).withinBudget).toBe(false);
    expect(checkBudgetCoverage(recv, 1).distinct).toBe(2);

    const withStage = checkBudgetCoverage(recv, 2, '7003/screen');
    expect(withStage.withinBudget).toBe(true);
    expect(withStage.stageReceived).toBe(true);
    expect(withStage.screenKeys).toEqual([]);

    expect(checkBudgetCoverage({ '7001/camera': 5 }, 2, null, { min: 200 }).withinBudget).toBe(true);
  });

  it('derives steady-window deltas from counter maps', () => {
    expect(counterDelta({ a: 10, b: 10 }, { a: 15, b: 10, c: 7 })).toEqual({ a: 5, c: 7 });
  });
});

describe('U7 sidecar env contract', () => {
  const base = {
    tokens: ['t0'],
    channelId: '1',
    host: '127.0.0.1',
    port: 4100,
    durationS: 60,
  };

  it('omits every VOICE_VIDEO* var on the V1 audio-only shape', () => {
    const env = sidecarEnvFor(base, '/tmp/tokens.json');
    expect(env.VOICE_VIDEO).toBeUndefined();
    expect(env.VOICE_CAMERA_COUNT).toBeUndefined();
    expect(env.VOICE_TILES_JSON).toBeUndefined();
    expect(env.VOICE_TOKENS_FILE).toBe('/tmp/tokens.json');
    expect(env.VOICE_DURATION_S).toBe('60');
  });

  it('maps the video request onto the documented env names', () => {
    const env = sidecarEnvFor(
      { ...base, video: { cameraCount: 10, screenCount: 2, videoPps: 200, tiles: { '0': 2 }, churnPublishers: 3, churnIntervalMs: 400, churnRounds: 12 } },
      '/tmp/t.json',
    );
    expect(env.VOICE_VIDEO).toBe('1');
    expect(env.VOICE_CAMERA_COUNT).toBe('10');
    expect(env.VOICE_SCREEN_COUNT).toBe('2');
    expect(env.VOICE_VIDEO_PPS).toBe('200');
    expect(env.VOICE_TILES_JSON).toBe('{"0":2}');
    expect(env.VOICE_CHURN_PUBLISHERS).toBe('3');
    expect(env.VOICE_CHURN_INTERVAL_MS).toBe('400');
    expect(env.VOICE_CHURN_ROUNDS).toBe('12');
    // Empty tiles maps stay unset (the sidecar's own default).
    expect(sidecarEnvFor({ ...base, video: { tiles: {} } }, '/tmp/t.json').VOICE_TILES_JSON).toBeUndefined();
  });
});

describe('U7 registry wiring', () => {
  it('registers voice_video beside the V1 voice scenarios', () => {
    expect(scenarioNames()).toContain('voice_video');
    expect(scenarioNames()).toContain('voice_load');
    expect(scenarioNames()).toContain('voice_resume');
  });
});

describe('U7 voice_video scenario (fake seam smoke)', () => {
  it('runs the cameras shape and folds a passing result with budget coverage', async () => {
    const world = makeFakeWorld();
    const result = await voiceVideoScenario.run(
      ctxFor(world.voice, { shape: 'cameras', participants: 3, windowS: 1, settleS: 4, budgetReceiver: 0, budgetTiles: 2, callEndTimeoutMs: 10_000, connectTimeoutMs: 10_000 }),
    );

    expect(result.passed).toBe(true);
    expect(result.metrics.participants).toBe(3);
    expect(result.metrics.budgetWithinBudget).toBe(true);
    expect(result.metrics.budgetDistinctSources).toBe(2);
    expect(result.metrics.pcFailures).toBe(0);
    expect(result.metrics.maxSdpBodyBytes).toBe(5_000);
    expect(result.metrics.minVideoReceiverPct).toBeGreaterThan(95);
    expect(result.metrics.callEndObserved).toBe(true);
    expect(result.metrics.rosterIntact).toBe(true);
  }, 20_000);

  it('fails when the budget receiver sees more sources than its tiles', async () => {
    const world = makeFakeWorld();
    const result = await voiceVideoScenario.run(
      ctxFor(world.voice, { shape: 'cameras', participants: 3, windowS: 1, settleS: 4, budgetReceiver: 0, budgetTiles: 1, callEndTimeoutMs: 10_000, connectTimeoutMs: 10_000 }),
    );
    expect(result.passed).toBe(false);
    expect(result.metrics.budgetWithinBudget).toBe(false);
  }, 20_000);

  it('fails on leg drops (pc_failures)', async () => {
    const world = makeFakeWorld();
    const seam: VoiceSeam = {
      ...world.voice,
      startSidecar: async (request) => {
        const handle = await world.voice.startSidecar(request);
        return {
          ...handle,
          done: handle.done.then((fin) => ({
            ...fin,
            participants: (fin.participants ?? []).map((p, i) => (i === 0 ? { ...p, pc_failures: 2 } : p)),
          })),
        };
      },
    };
    const result = await voiceVideoScenario.run(
      ctxFor(seam, { shape: 'cameras', participants: 3, windowS: 1, settleS: 4, callEndTimeoutMs: 10_000, connectTimeoutMs: 10_000 }),
    );
    expect(result.passed).toBe(false);
    expect(result.metrics.pcFailures).toBe(2);
  }, 20_000);
});
