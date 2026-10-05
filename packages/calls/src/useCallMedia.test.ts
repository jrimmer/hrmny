/**
 * @cytale/web — media engine tests (calls plan U8; calls V2 plan U4).
 *
 * Full-negotiation coverage against injected stub media (a fake
 * RTCPeerConnection + fake getUserMedia/getDisplayMedia + fake gateway),
 * per the unit's test scenarios:
 *
 *  V1 lineage (manifest-shaped): join → envelope-v2 offer apply → v1 answer
 *  → connected; mute/deafen (op-22 state + track.enabled + playback mute —
 *  deafen KEEPS video per R15); displaced teardown; glare (offer while an
 *  answer is in flight queues); DTX in the negotiated answer; ice-fail →
 *  restart → fail → VoiceUnavailable; reconnect backfill (+ VM8 re-publish);
 *  ICE trickle both ways; ring.
 *
 *  V2: manifest attribution (audio playback keyed user:source, video tiles
 *  keyed user:source, unattributed-mid + V1-body tolerance, departures);
 *  KTD1 send-side binding by manifest mid (out-of-order grants, rid-encoding
 *  sender caps); publish lifecycle (camera/screen/share-audio, browser stop
 *  bar → single unpublish, share-ended notice, VM13 replaceTrack switch);
 *  listen-only join + later mic grant upgrade (VM5); the adaptive budget's
 *  video_want op with its dedicated ~2 s window (KTD7).
 *
 * Real-browser getUserMedia is deliberately NOT exercised here — the
 * two-real-browser e2e is the e2e unit's.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyGatewayEvent, createStateStore, type StateStore } from '@cytale/state';
import type {
  CallEnd,
  CallSync,
  CallUpdate,
  GatewayCallSignalPayload,
  GatewayCallStateUpdatePayload,
} from '@cytale/protocol';

import { AdaptiveBudget, type AdaptiveBudgetHandle } from './useAdaptiveBudget.js';
import { parseMlines } from './manifest.js';
import type { CaptureConstraints, CaptureEnv } from './usePublish.js';
import { routeCallSignalEvent } from './session-call-signal.js';
import {
  applyDtxToAnswerSdp,
  audioMlineInfo,
  configureIce,
  createCallEngine,
  currentIceServers,
  normalizeIceBody,
  type AdaptiveBudgetFactory,
  type CallEngine,
  type CallEngineDeps,
  type IceCandidateInitLike,
  type MediaEnv,
  type MediaStreamLike,
  type MediaTrackLike,
  type PeerConnectionLike,
  type PlaybackHandle,
  type RtpDescriptionLike,
  type RtpSenderLike,
  type RtpTransceiverLike,
  type RTCIceServerLike,
} from './useCallMedia.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CH = '7300000000000000100';
const ME = '7300000000000000001';
const U2 = '7300000000000000002';
const U3 = '7300000000000000003';
const CALL_ID = '7300000000000000099';

function audioSection(mid: string, direction: string, active = true): string[] {
  return [
    `m=audio ${active ? 9 : 0} RTP/AVP 111`,
    `a=mid:${mid}`,
    `a=${active ? direction : 'inactive'}`,
    'a=rtpmap:111 opus/48000/2',
    'a=fmtp:111 minptime=10;useinbandfec=1',
  ];
}

/**
 * A video m-line of a (wire-munged, GO-branch) server offer. Ingest lines
 * are recvonly; `rids` splices the rid/simulcast attrs the spike measured
 * Chrome auto-populating encodings from.
 */
function videoSection(
  mid: string,
  direction: string,
  active = true,
  rids?: string[],
): string[] {
  const lines = [
    `m=video ${active ? 9 : 0} RTP/AVP 96`,
    `a=mid:${mid}`,
    `a=${active ? direction : 'inactive'}`,
    'a=rtpmap:96 VP8/90000',
  ];
  if (rids !== undefined) {
    for (const rid of rids) lines.push(`a=rid:${rid} recv`);
    lines.push(`a=simulcast:recv ${[...rids].reverse().join(';')}`);
  }
  return lines;
}

/** One manifest entry (envelope v2 tracks row). */
interface TrackEntry {
  mid: string;
  user_id: string;
  source: 'mic' | 'camera' | 'screen' | 'screen_audio';
  rids?: string[];
}

/** The envelope-v2 CALL_SIGNAL body a V2 server pushes (KTD1). */
function envelope(tracks: TrackEntry[], sdp: string): string {
  return JSON.stringify({ v: 2, type: 'offer', sdp, tracks });
}

/** A V2-shaped offer: ingest (mic, recvonly) + egress legs per manifest. */
function offerSdp(
  ...egress: Array<{ mid: string; active?: boolean; kind?: 'audio' | 'video'; rids?: string[] }>
): string {
  const sections = [audioSection('0', 'recvonly')];
  let videoIndex = 0;
  for (const e of egress) {
    if (e.kind === 'video' || e.rids !== undefined) {
      videoIndex += 1;
      sections.push(
        videoSection(
          e.mid,
          'sendonly',
          e.active !== false,
          e.rids ?? ['f', 'h', 'q'],
        ),
      );
    } else {
      sections.push(audioSection(e.mid, 'sendonly', e.active !== false));
    }
  }
  void videoIndex;
  return ['v=0', 'o=- 46117317 2 IN IP4 127.0.0.1', 's=-', 't=0 0', ...sections.flat()].join('\n');
}

/** An ingest-shaped section list for offers WE answer (recvonly, rid-munged). */
function ingestOfferSdp(
  ...ingest: Array<{ mid: string; kind: 'audio' | 'video'; rids?: string[] }>
): string {
  const sections: string[][] = [];
  let audioSeen = false;
  for (const m of ingest) {
    if (m.kind === 'audio') {
      audioSeen = true;
      sections.push(audioSection(m.mid, 'recvonly'));
    } else {
      sections.push(videoSection(m.mid, 'recvonly', true, m.rids));
    }
  }
  void audioSeen;
  return ['v=0', 'o=- 46117317 2 IN IP4 127.0.0.1', 's=-', 't=0 0', ...sections.flat()].join('\n');
}

/** Microtask flush — enough hops for the SRD→bind→answer→SLD→send chain. */
async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

// -- fake media ----------------------------------------------------------------

class FakeTrack implements MediaTrackLike {
  enabled = true;
  contentHint: string | undefined;
  onended: (() => void) | null = null;
  stopped = false;
  readonly applyConstraintsCalls: unknown[] = [];
  constructor(readonly kind: 'audio' | 'video') {}
  stop(): void {
    this.stopped = true;
  }
  applyConstraints(constraints: unknown): Promise<void> {
    this.applyConstraintsCalls.push(constraints);
    return Promise.resolve();
  }
  /** Native-stop simulation (browser stop bar / closed window / OS revoke). */
  fireEnded(): void {
    this.stopped = true;
    this.onended?.();
  }
}

class FakeStream implements MediaStreamLike {
  constructor(
    readonly audioTracks: FakeTrack[] = [],
    readonly videoTracks: FakeTrack[] = [],
  ) {}
  static mic(): FakeStream {
    return new FakeStream([new FakeTrack('audio')], []);
  }
  static camera(): FakeStream {
    return new FakeStream([], [new FakeTrack('video')]);
  }
  static screen(audio = false): FakeStream {
    return new FakeStream(audio ? [new FakeTrack('audio')] : [], [new FakeTrack('video')]);
  }
  getAudioTracks(): MediaTrackLike[] {
    return this.audioTracks;
  }
  getVideoTracks(): MediaTrackLike[] {
    return this.videoTracks;
  }
}

class FakeSender implements RtpSenderLike {
  /** replaceTrack history (the KTD1 binding assertions read this). */
  readonly replaced: Array<MediaTrackLike | null> = [];
  params: { encodings: Array<Record<string, unknown>> };
  constructor(mid: string, rids: string[]) {
    void mid;
    // Chrome auto-populates one encoding per rid on rid-munged m-lines (the
    // spike's measured shape); single-stream m-lines carry one bare row.
    this.params = {
      encodings: rids.length > 0 ? rids.map((rid) => ({ rid })) : [{}],
    };
  }
  async replaceTrack(track: MediaTrackLike | null): Promise<void> {
    this.replaced.push(track);
  }
  getParameters(): unknown {
    return this.params;
  }
  async setParameters(params: unknown): Promise<void> {
    this.params = JSON.parse(JSON.stringify(params)) as { encodings: Array<Record<string, unknown>> };
  }
}

class FakeTransceiver implements RtpTransceiverLike {
  readonly sender: FakeSender;
  direction = 'sendrecv';
  constructor(readonly mid: string, rids: string[]) {
    this.sender = new FakeSender(mid, rids);
  }
}

function ridsOfSection(sdp: string, mid: string): string[] {
  const lines = sdp.split(/\r?\n/);
  const rids: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (line.startsWith('m=')) inSection = false;
    if (new RegExp(`^a=mid:${mid}$`).test(line)) inSection = true;
    if (inSection) {
      const rid = /^a=rid:(\S+) recv$/.exec(line);
      if (rid) rids.push(rid[1]!);
    }
  }
  return rids;
}

class FakePeerConnection implements PeerConnectionLike {
  connectionState = 'new';
  ontrack: PeerConnectionLike['ontrack'] = null;
  onicecandidate: PeerConnectionLike['onicecandidate'] = null;
  onconnectionstatechange: PeerConnectionLike['onconnectionstatechange'] = null;

  closed = false;
  readonly addedTracks: MediaTrackLike[] = [];
  readonly remoteDescriptions: RtpDescriptionLike[] = [];
  readonly localDescriptions: RtpDescriptionLike[] = [];
  readonly iceCandidates: IceCandidateInitLike[] = [];
  readonly transceivers: FakeTransceiver[] = [];
  /** Mids whose receiver has fired ontrack (browsers fire ONCE per receiver). */
  private readonly firedMids = new Set<string>();
  /** The report getStats serves (default: no inbound video — no opinion). */
  statsReport: Iterable<Record<string, unknown>> = [];
  /** Gates createAnswer — the glare test holds the first answer here. */
  answerGate: ((resolve: () => void) => void) | null = null;

  addTrack(track: MediaTrackLike): unknown {
    this.addedTracks.push(track);
    return {};
  }

  async setRemoteDescription(description: RtpDescriptionLike): Promise<void> {
    this.remoteDescriptions.push(description);
    // Browsers materialize a transceiver per offered m-line at SRD; rid-
    // munged video lines seed one encoding per rid (spike-measured Chrome).
    for (const m of parseMlines(description.sdp)) {
      if (m.mid === null) continue;
      if (this.transceivers.some((t) => t.mid === m.mid)) continue;
      this.transceivers.push(new FakeTransceiver(m.mid, ridsOfSection(description.sdp, m.mid)));
    }
    // Real browsers fire ontrack ONCE per receiver (a re-offer over the
    // same m-line keeps the receiver's track) — the fake mirrors that.
    for (const m of parseMlines(description.sdp)) {
      if (m.mid === null || !m.active) continue;
      if (m.direction !== 'sendonly' && m.direction !== 'sendrecv') continue;
      if (this.firedMids.has(m.mid)) continue;
      this.firedMids.add(m.mid);
      this.ontrack?.({
        track: new FakeTrack(m.kind === 'video' ? 'video' : 'audio'),
        transceiver: { mid: m.mid },
      });
    }
  }

  async createAnswer(): Promise<RtpDescriptionLike> {
    if (this.answerGate) await new Promise<void>(this.answerGate);
    const offer = this.remoteDescriptions[this.remoteDescriptions.length - 1]!;
    // Direction-flipped echo — enough shape for the DTX munge to bite.
    return { type: 'answer', sdp: offer.sdp.replace(/sendonly/g, 'recvonly').replace(/recvonly/g, 'sendonly') };
  }

  async setLocalDescription(description: RtpDescriptionLike): Promise<void> {
    this.localDescriptions.push(description);
  }

  async addIceCandidate(candidate: IceCandidateInitLike): Promise<void> {
    this.iceCandidates.push(candidate);
  }

  getTransceivers(): RtpTransceiverLike[] {
    return this.transceivers;
  }

  async getStats(): Promise<Iterable<Record<string, unknown>>> {
    return this.statsReport;
  }

  close(): void {
    this.closed = true;
    this.connectionState = 'closed';
  }

  // Test drivers.
  simulateConnectionState(state: string): void {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }

  emitLocalCandidate(candidate: IceCandidateInitLike | null): void {
    this.onicecandidate?.({ candidate });
  }
}

class FakeMediaEnv implements MediaEnv {
  readonly pcs: FakePeerConnection[] = [];
  readonly pcConfigs: Array<{ iceServers: RTCIceServerLike[] }> = [];
  readonly attached: Array<{ playbackKey: string; mutedCalls: boolean[]; stopped: boolean }> = [];
  /** The iceServers createPeerConnection must be called with. */
  expectedIceServers: RTCIceServerLike[] = [];
  getUserMediaImpl: () => Promise<FakeStream> = () => Promise.resolve(FakeStream.mic());

  getUserMedia(constraints: { audio: boolean }): Promise<MediaStreamLike> {
    void constraints;
    return this.getUserMediaImpl().then((s) => s as MediaStreamLike);
  }

  createPeerConnection(config: { iceServers: RTCIceServerLike[] }): PeerConnectionLike {
    this.pcConfigs.push(config);
    expect(config).toEqual({ iceServers: this.expectedIceServers });
    const pc = new FakePeerConnection();
    this.pcs.push(pc);
    return pc;
  }

  createStream(tracks: MediaTrackLike[]): MediaStreamLike {
    return { getAudioTracks: () => tracks, getVideoTracks: () => [] };
  }

  attachAudio(_stream: MediaStreamLike, playbackKey: string): PlaybackHandle {
    const record = { playbackKey, mutedCalls: [] as boolean[], stopped: false };
    this.attached.push(record);
    return {
      setMuted: (muted: boolean) => {
        record.mutedCalls.push(muted);
      },
      stop: () => {
        record.stopped = true;
      },
    };
  }
}

/** Capture seam for the publish engine (camera gUM / screen gDM). */
class FakeCaptureEnv implements CaptureEnv {
  readonly requested: CaptureConstraints[] = [];
  cameraImpl: () => Promise<FakeStream> = () => Promise.resolve(FakeStream.camera());
  displayImpl: () => Promise<FakeStream> = () => Promise.resolve(FakeStream.screen());
  getUserMedia(constraints: CaptureConstraints): Promise<MediaStreamLike> {
    this.requested.push(JSON.parse(JSON.stringify(constraints)));
    return this.cameraImpl();
  }
  getDisplayMedia(constraints: CaptureConstraints): Promise<MediaStreamLike> {
    this.requested.push(JSON.parse(JSON.stringify(constraints)));
    return this.displayImpl();
  }
}

// -- fake gateway ----------------------------------------------------------------

type Handler = (payload: unknown) => void;

class FakeGateway {
  connectionState = 'ready';
  readonly sentState: Array<GatewayCallStateUpdatePayload> = [];
  readonly sentSignal: Array<GatewayCallSignalPayload> = [];
  private readonly handlers = new Map<string, Set<Handler>>();

  sendCallState(payload: GatewayCallStateUpdatePayload): void {
    this.sentState.push(payload);
  }

  sendCallSignal(payload: GatewayCallSignalPayload): void {
    this.sentSignal.push(payload);
  }

  on(
    event: 'CallUpdate' | 'CallEnd' | 'CallSync',
    handler: (p: never) => void,
  ): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler);
    return () => set!.delete(handler as Handler);
  }

  dispatch(event: 'CallUpdate' | 'CallEnd' | 'CallSync', payload: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
  }
}

/** A monitor test double that only records the lifecycle calls. */
function fakeRecordingMonitor(overrides: {
  attach: ReturnType<typeof vi.fn>;
  detachAll: ReturnType<typeof vi.fn>;
}): CallEngineDeps['monitor'] {
  return {
    attach: overrides.attach,
    detach: vi.fn(),
    detachAll: overrides.detachAll,
    start: vi.fn(),
    stop: vi.fn(),
    dispose: vi.fn(),
    getSpeaking: () => new Set<string>(),
    subscribe: () => () => undefined,
  } as unknown as CallEngineDeps['monitor'];
}

// -- harness -----------------------------------------------------------------------

interface Harness {
  engine: CallEngine;
  gateway: FakeGateway;
  media: FakeMediaEnv;
  capture: FakeCaptureEnv;
  store: StateStore;
  /** Drive one dispatch through BOTH the store reconcile and the engine. */
  event(t: 'CallUpdate', d: CallUpdate): void;
  event(t: 'CallEnd', d: CallEnd): void;
  event(t: 'CallSync', d: CallSync): void;
  event(t: 'CallStart', d: unknown): void;
  signal(body: string): void;
}

function harness(
  opts: {
    getUserMediaImpl?: FakeMediaEnv['getUserMediaImpl'];
    fetchIceServers?: () => Promise<RTCIceServerLike[]>;
    iceTimeoutMs?: number;
    capture?: FakeCaptureEnv;
    adaptiveBudget?: AdaptiveBudgetFactory | null;
    /** Injected speaking monitor (default: the jsdom-safe real one). */
    monitor?: CallEngineDeps['monitor'];
  } = {},
): Harness {
  const store = createStateStore();
  store.setState((s) => ({
    ...s,
    currentUser: { id: ME, username: 'me' },
  }));
  const gateway = new FakeGateway();
  const media = new FakeMediaEnv();
  if (opts.getUserMediaImpl) media.getUserMediaImpl = opts.getUserMediaImpl;
  const capture = opts.capture ?? new FakeCaptureEnv();
  const engine = createCallEngine({
    store,
    media,
    monitor: opts.monitor,
    gateway: () => gateway,
    pollMs: 0, // tests drive pollConnectionState explicitly
    // Hermetic ICE fetch: no network in jsdom — loopback default ([]).
    fetchIceServers: opts.fetchIceServers ?? (() => Promise.resolve([])),
    iceTimeoutMs: opts.iceTimeoutMs,
    captureEnv: capture,
    publishDebounceMs: 0, // deterministic publish ops in tests
    adaptiveBudget: opts.adaptiveBudget ?? null, // budget tests inject their own
  });
  let seq = 0;
  const event = (t: string, d: unknown): void => {
    seq++;
    applyGatewayEvent(store, {
      op: 0,
      t: t as 'CallUpdate',
      s: seq,
      d: d as CallUpdate,
    });
    if (t === 'CallUpdate' || t === 'CallEnd' || t === 'CallSync') {
      gateway.dispatch(t, d);
    }
  };
  const signal = (body: string): void => {
    seq++;
    routeCallSignalEvent({ op: 0, t: 'CallSignal', s: seq, d: { channel_id: CH, body } });
  };
  return { engine, gateway, media, capture, store, event, signal } as unknown as Harness;
}

/** The server's roster preamble: CALL_START then our own joined leg. */
function startCallInStore(h: Harness): void {
  h.event('CallStart', {
    channel_id: CH,
    call_id: CALL_ID,
    thread_id: '7300000000000000055',
    started_by: ME,
    started_at: '2026-09-06T12:00:00Z',
  });
}

/** join + confirm own leg + grant mic — the common prelude. */
async function joinedWithMic(h: Harness): Promise<void> {
  startCallInStore(h);
  h.engine.join(CH);
  await flush();
  h.event('CallUpdate', {
    channel_id: CH,
    call_id: CALL_ID,
    user_id: ME,
    leg: 'L1',
    state: 'joined',
  });
  await flush();
}

/** One remote participant + the initial v2 offer (mic ingest + U2 mic). */
async function appliedOfferWithU2(h: Harness): Promise<void> {
  await joinedWithMic(h);
  h.event('CallUpdate', {
    channel_id: CH,
    call_id: CALL_ID,
    user_id: U2,
    leg: 'L2',
    state: 'joined',
  });
  await flush();
  h.signal(
    envelope(
      [
        { mid: '0', user_id: ME, source: 'mic' },
        { mid: '1', user_id: U2, source: 'mic' },
      ],
      offerSdp({ mid: '1' }),
    ),
  );
  await flush();
}

/** Connected with U2 attributed + played back — the controls prelude. */
async function connected(h: Harness): Promise<FakePeerConnection> {
  await appliedOfferWithU2(h);
  const pc = h.media.pcs[0]!;
  pc.simulateConnectionState('connected');
  expect(h.engine.getSnapshot().voice.status).toBe('connected');
  return pc;
}

function senderOf(pc: FakePeerConnection, mid: string): FakeSender {
  const t = pc.transceivers.find((x) => x.mid === mid);
  if (!t) throw new Error(`no transceiver with mid ${mid}`);
  return t.sender;
}

function transceiverOf(pc: FakePeerConnection, mid: string): FakeTransceiver {
  const t = pc.transceivers.find((x) => x.mid === mid);
  if (!t) throw new Error(`no transceiver with mid ${mid}`);
  return t;
}

function publishOps(h: Harness, source: string): GatewayCallStateUpdatePayload[] {
  return h.gateway.sentState.filter(
    (s) => (s.action === 'publish' || s.action === 'unpublish') && s.source === source,
  );
}

// ---------------------------------------------------------------------------
// SDP helpers (pure)
// ---------------------------------------------------------------------------

describe('applyDtxToAnswerSdp', () => {
  it('appends usedtx=1 to every opus fmtp line across m-sections (and is idempotent)', () => {
    const sdp = offerSdp({ mid: '1' }, { mid: '2' });
    const once = applyDtxToAnswerSdp(sdp);
    expect(once.match(/usedtx=1/g)).toHaveLength(3); // ingest + 2 egress
    expect(once).toContain('a=fmtp:111 minptime=10;useinbandfec=1;usedtx=1');
    expect(applyDtxToAnswerSdp(once)).toBe(once); // no double-append
  });

  it('inserts a bare usedtx fmtp under the opus rtpmap when the answer has none', () => {
    const sdp = [
      'v=0',
      'm=audio 9 RTP/AVP 111',
      'a=mid:0',
      'a=rtpmap:111 opus/48000/2',
      'm=video 9 RTP/AVP 96',
      'a=mid:1',
      'a=rtpmap:96 VP8/90000',
    ].join('\n');
    const out = applyDtxToAnswerSdp(sdp);
    expect(out).toContain('a=fmtp:111 usedtx=1');
    // Non-opus payload types are untouched.
    expect(out).not.toContain('a=fmtp:96');
  });

  it('preserves CRLF line endings', () => {
    const sdp = offerSdp({ mid: '1' }).replace(/\n/g, '\r\n');
    const out = applyDtxToAnswerSdp(sdp);
    expect(out).toContain('\r\n');
    expect(out).toContain('usedtx=1');
  });
});

describe('audioMlineInfo', () => {
  it('reports mids in order with inactive/departed m-lines flagged', () => {
    const info = audioMlineInfo(
      offerSdp({ mid: '1', active: false }, { mid: '2' }),
    );
    expect(info).toEqual([
      { mid: '0', active: true },
      { mid: '1', active: false },
      { mid: '2', active: true },
    ]);
  });
});

describe('normalizeIceBody', () => {
  it('accepts camelCase wire bodies verbatim (incl. the hardcoded 0/0 quirk)', () => {
    expect(
      normalizeIceBody('{"candidate":"candidate:1","sdpMid":"0","sdpMLineIndex":0}'),
    ).toEqual({ candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 });
  });

  it('tolerates snake_case keys and rejects malformed bodies', () => {
    expect(
      normalizeIceBody('{"candidate":"c","sdp_mid":"1","sdp_mline_index":1}'),
    ).toEqual({ candidate: 'c', sdpMid: '1', sdpMLineIndex: 1 });
    expect(normalizeIceBody('not json')).toBeNull();
    expect(normalizeIceBody('{"sdpMid":"0"}')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Engine: the join negotiation (envelope v2)
// ---------------------------------------------------------------------------

describe('media engine — join → offer → answer → connected', () => {
  it('sends op-22 join, applies the v2 offer, binds the mic BY MANIFEST MID, answers v1-shaped with DTX, connects', async () => {
    const h = harness();
    await appliedOfferWithU2(h);

    expect(h.gateway.sentState).toEqual([{ channel_id: CH, action: 'join' }]);
    expect(h.engine.getSnapshot().voice.status).toBe('connecting-media');

    const pc = h.media.pcs[0]!;
    expect(pc.remoteDescriptions).toHaveLength(1);
    // KTD1: the mic bound to the manifest's OWN ingest mid via replaceTrack —
    // addTrack (first-free-m-line) is gone.
    expect(pc.addedTracks).toHaveLength(0);
    expect(senderOf(pc, '0').replaced).toHaveLength(1);
    expect(senderOf(pc, '1').replaced).toHaveLength(0); // U2's egress — never ours

    // The answer went out on op 23 V1-SHAPED (no envelope, no manifest —
    // KTD1) with DTX on the send leg (R12).
    const answerSignal = h.gateway.sentSignal.find((s) => s.kind === 'sdp');
    expect(answerSignal).toMatchObject({ channel_id: CH, kind: 'sdp' });
    const body = JSON.parse(answerSignal!['body'] as string) as {
      type: string;
      sdp: string;
      v?: unknown;
      tracks?: unknown;
    };
    expect(body.type).toBe('answer');
    expect(body.v).toBeUndefined();
    expect(body.tracks).toBeUndefined();
    expect(body.sdp).toContain('usedtx=1');

    // Media leg lands: pc connected → composite Connected.
    pc.simulateConnectionState('connected');
    expect(h.engine.getSnapshot().voice.status).toBe('connected');

    // The remote track is attributed BY MANIFEST to U2's mic and played back
    // under the user:source key.
    expect(h.media.attached.map((a) => a.playbackKey)).toEqual([`${U2}:mic`]);
  });

  it('self-attaches the local mic to the speaking monitor under MY id (user-panel "hearing you")', async () => {
    const attach = vi.fn();
    const detachAll = vi.fn();
    const h = harness({ monitor: fakeRecordingMonitor({ attach, detachAll }) });

    await joinedWithMic(h);
    await flush();

    // The LOCAL mic stream rides the AM5 monitor keyed by MY user id —
    // speaking.has(me) is what the user panel's mic status (and the self
    // tile ring) read. A disabled (muted) track renders silence through
    // the WebAudio graph, so mute stays honest with zero extra wiring.
    expect(attach).toHaveBeenCalledWith(ME, expect.anything());

    h.engine.leave();
    await flush();
    expect(detachAll).toHaveBeenCalled();
  });

  it('queues an offer that races the mic (applied once gUM lands)', async () => {
    let grantMic: ((s: FakeStream) => void) | null = null;
    const h = harness({
      getUserMediaImpl: () => new Promise((resolve) => (grantMic = resolve)),
    });
    h.engine.join(CH);
    await flush();
    h.event('CallUpdate', {
      channel_id: CH,
      call_id: CALL_ID,
      user_id: ME,
      leg: 'L1',
      state: 'joined',
    });
    // Offer arrives while gUM is still pending.
    h.signal(
      envelope(
        [
          { mid: '0', user_id: ME, source: 'mic' },
          { mid: '1', user_id: U2, source: 'mic' },
        ],
        offerSdp({ mid: '1' }),
      ),
    );
    await flush();
    expect(h.media.pcs[0]!.remoteDescriptions).toHaveLength(0);

    grantMic!(FakeStream.mic());
    await flush();
    expect(h.media.pcs[0]!.remoteDescriptions).toHaveLength(1);
    expect(h.gateway.sentSignal.filter((s) => s.kind === 'sdp')).toHaveLength(1);
  });

  it('queues an offer that races PC creation (applied once the ICE fetch lands the PC)', async () => {
    let releaseIce: ((servers: RTCIceServerLike[]) => void) | null = null;
    const h = harness({
      fetchIceServers: () =>
        new Promise<RTCIceServerLike[]>((resolve) => {
          releaseIce = resolve;
        }),
    });
    startCallInStore(h);
    h.engine.join(CH);
    await flush(); // mic granted; PC still pending on the ICE fetch
    h.event('CallUpdate', {
      channel_id: CH,
      call_id: CALL_ID,
      user_id: ME,
      leg: 'L1',
      state: 'joined',
    });
    await flush();
    expect(h.media.pcs).toHaveLength(0);

    // Offer arrives while the PC does not exist yet: it must QUEUE (the
    // pre-shift guards return without consuming it), never drop.
    h.signal(
      envelope([{ mid: '0', user_id: ME, source: 'mic' }], ingestOfferSdp({ mid: '0', kind: 'audio' })),
    );
    await flush();
    expect(h.media.pcs).toHaveLength(0);

    releaseIce!([]);
    await flush();
    expect(h.media.pcs[0]!.remoteDescriptions).toHaveLength(1);
    expect(h.gateway.sentSignal.filter((s) => s.kind === 'sdp')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Engine: glare + ICE
// ---------------------------------------------------------------------------

describe('media engine — glare and ICE trickle', () => {
  it('queues a second offer while the first answer is in flight (defer rule)', async () => {
    const h = harness();
    await joinedWithMic(h);
    h.event('CallUpdate', {
      channel_id: CH,
      call_id: CALL_ID,
      user_id: U2,
      leg: 'L2',
      state: 'joined',
    });
    await flush();

    const pc = h.media.pcs[0]!;
    let releaseAnswer: (() => void) | null = null;
    pc.answerGate = (resolve: () => void) => {
      pc.answerGate = null; // only gates the FIRST answer
      releaseAnswer = resolve;
    };

    h.signal(
      envelope(
        [
          { mid: '0', user_id: ME, source: 'mic' },
          { mid: '1', user_id: U2, source: 'mic' },
        ],
        offerSdp({ mid: '1' }),
      ),
    );
    await flush();
    h.signal(
      envelope(
        [
          { mid: '0', user_id: ME, source: 'mic' },
          { mid: '1', user_id: U2, source: 'mic' },
          { mid: '2', user_id: U3, source: 'mic' },
        ],
        offerSdp({ mid: '1' }, { mid: '2' }),
      ),
    );
    await flush();

    // First offer applied; second deferred behind the outstanding answer.
    expect(pc.remoteDescriptions).toHaveLength(1);
    expect(h.gateway.sentSignal.filter((s) => s.kind === 'sdp')).toHaveLength(0);

    releaseAnswer!();
    await flush();
    expect(pc.remoteDescriptions).toHaveLength(2);
    expect(h.gateway.sentSignal.filter((s) => s.kind === 'sdp')).toHaveLength(2);
  });

  it('trickles local ICE out as op-23 ice with camelCase wire keys', async () => {
    const h = harness();
    await joinedWithMic(h);
    const pc = h.media.pcs[0]!;
    pc.emitLocalCandidate({ candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 });
    pc.emitLocalCandidate(null); // end-of-candidates never rides the wire

    const ice = h.gateway.sentSignal.filter((s) => s.kind === 'ice');
    expect(ice).toHaveLength(1);
    expect(JSON.parse(ice[0]!['body'] as string)).toEqual({
      candidate: 'candidate:1',
      sdpMid: '0',
      sdpMLineIndex: 0,
    });
  });

  it('queues server ICE racing the remote description, then flushes (accepts 0/0 quirk)', async () => {
    const h = harness();
    await joinedWithMic(h);
    h.event('CallUpdate', {
      channel_id: CH,
      call_id: CALL_ID,
      user_id: U2,
      leg: 'L2',
      state: 'joined',
    });
    await flush();

    // Candidate lands BEFORE any offer.
    h.signal('{"candidate":"candidate:9","sdpMid":"0","sdpMLineIndex":0}');
    await flush();
    expect(h.media.pcs[0]!.iceCandidates).toHaveLength(0);

    h.signal(
      envelope(
        [
          { mid: '0', user_id: ME, source: 'mic' },
          { mid: '1', user_id: U2, source: 'mic' },
        ],
        offerSdp({ mid: '1' }),
      ),
    );
    await flush();
    expect(h.media.pcs[0]!.iceCandidates).toEqual([
      { candidate: 'candidate:9', sdpMid: '0', sdpMLineIndex: 0 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Engine: controls
// ---------------------------------------------------------------------------

describe('media engine — mute / deafen / ring / leave', () => {
  it('mute emits op-22 state and disables the local track', async () => {
    const h = harness();
    const pc = await connected(h);
    const track = senderOf(pc, '0').replaced[0] as FakeTrack;

    h.engine.toggleMute();
    expect(h.gateway.sentState.at(-1)).toEqual({
      channel_id: CH,
      action: 'state',
      mute: true,
      deafen: false,
    });
    expect(track.enabled).toBe(false);

    h.engine.toggleMute();
    // Unmute carries an explicit false (absent = unchanged server-side).
    expect(h.gateway.sentState.at(-1)).toEqual({
      channel_id: CH,
      action: 'state',
      mute: false,
      deafen: false,
    });
    expect(track.enabled).toBe(true);
  });

  it('deafen implies mute (AM12) and mutes mic + share-audio playback — but KEEPS video (R15)', async () => {
    const h = harness();
    const pc = await connected(h);
    const track = senderOf(pc, '0').replaced[0] as FakeTrack;

    // U2 publishes a screen share: the re-offer attributes a screen video
    // m-line + share-audio m-line to U2.
    h.event('CallUpdate', {
      channel_id: CH,
      call_id: CALL_ID,
      user_id: U2,
      leg: 'L2',
      state: 'screen_on',
      source: 'screen',
    });
    await flush();
    h.signal(
      envelope(
        [
          { mid: '0', user_id: ME, source: 'mic' },
          { mid: '1', user_id: U2, source: 'mic' },
          { mid: '2', user_id: U2, source: 'screen' },
          { mid: '3', user_id: U2, source: 'screen_audio' },
        ],
        [
          'v=0',
          'o=- 46117317 2 IN IP4 127.0.0.1',
          's=-',
          't=0 0',
          ...audioSection('0', 'recvonly'),
          ...audioSection('1', 'sendonly'),
          ...videoSection('2', 'sendonly'),
          ...audioSection('3', 'sendonly'),
        ].join('\n'),
      ),
    );
    await flush();

    expect(h.media.attached.map((a) => a.playbackKey)).toEqual([`${U2}:mic`, `${U2}:screen_audio`]);
    expect([...h.engine.getVideoTracks().keys()]).toEqual([`${U2}:screen`]);

    h.engine.toggleDeafen();
    expect(h.gateway.sentState.at(-1)).toEqual({
      channel_id: CH,
      action: 'state',
      mute: true,
      deafen: true,
    });
    expect(track.enabled).toBe(false); // implied self-mute
    // BOTH audio playbacks muted (mic + share-audio — R15)...
    expect(h.media.attached[0]!.mutedCalls).toEqual([false, true]);
    expect(h.media.attached[1]!.mutedCalls).toEqual([false, true]);
    // ...while the video track keeps rendering.
    expect([...h.engine.getVideoTracks().keys()]).toEqual([`${U2}:screen`]);

    // Undeafen restores the explicit mute state (still unmuted here) — the
    // false deafen MUST ride the wire or the server keeps us deafened.
    h.engine.toggleDeafen();
    expect(h.gateway.sentState.at(-1)).toEqual({
      channel_id: CH,
      action: 'state',
      mute: false,
      deafen: false,
    });
    expect(track.enabled).toBe(true);
    expect(h.media.attached[0]!.mutedCalls).toEqual([false, true, false]);
    expect(h.media.attached[1]!.mutedCalls).toEqual([false, true, false]);
  });

  it('ring-after-start emits op-22 state with ring (AM17)', async () => {
    const h = harness();
    await connected(h);
    h.engine.ring();
    expect(h.gateway.sentState.at(-1)).toEqual({
      channel_id: CH,
      action: 'state',
      ring: true,
    });
  });

  it('leave sends op-22 leave, tears the PC and every capture down, and lands Idle', async () => {
    const h = harness();
    const pc = await connected(h);
    const cameraStream = FakeStream.camera();
    h.capture.cameraImpl = () => Promise.resolve(cameraStream);
    h.engine.publishCamera();
    await flush();
    expect(h.engine.getSnapshot().publishing.camera).toBe(true);

    h.engine.leave();
    expect(h.gateway.sentState.at(-1)).toEqual({ channel_id: CH, action: 'leave' });
    expect(h.engine.getSnapshot()).toMatchObject({
      channelId: null,
      voice: { status: 'idle', notice: null },
    });
    expect(pc.closed).toBe(true);
    // User-intent teardown stops published captures (no camera light leak).
    // No unpublish op rides the leave — the whole leg goes, sources with it
    // (the server's `left` transition is the roster truth).
    expect(cameraStream.videoTracks[0]!.stopped).toBe(true);
    expect(publishOps(h, 'camera')).toHaveLength(1); // the publish, nothing after
  });
});

// ---------------------------------------------------------------------------
// Engine: failure + eviction paths
// ---------------------------------------------------------------------------

describe('media engine — failures and evictions', () => {
  it('mic denial degrades to LISTEN-ONLY (VM5): the leg survives, the offer applies without a mic, later grant upgrades in place', async () => {
    const h = harness({
      getUserMediaImpl: () => Promise.reject(new DOMException('denied', 'NotAllowedError')),
    });
    startCallInStore(h);
    h.engine.join(CH);
    await flush();

    const snap = h.engine.getSnapshot();
    expect(snap.listenOnly).toBe(true);
    expect(snap.voice.micDenied).toBe(true);
    expect(snap.voice.status).toBe('connecting-signaling'); // leg NOT torn down

    h.event('CallUpdate', {
      channel_id: CH,
      call_id: CALL_ID,
      user_id: ME,
      leg: 'L1',
      state: 'joined',
    });
    await flush();
    // The offer applies WITHOUT a mic (listen-only negotiates recvonly).
    h.signal(
      envelope(
        [
          { mid: '0', user_id: ME, source: 'mic' },
          { mid: '1', user_id: U2, source: 'mic' },
        ],
        offerSdp({ mid: '1' }),
      ),
    );
    await flush();
    const pc = h.media.pcs[0]!;
    expect(pc.remoteDescriptions).toHaveLength(1);
    expect(senderOf(pc, '0').replaced).toEqual([]); // nothing bound — no mic
    expect(h.gateway.sentSignal.filter((s) => s.kind === 'sdp')).toHaveLength(1);

    pc.simulateConnectionState('connected');
    const connected1 = h.engine.getSnapshot();
    expect(connected1.voice.status).toBe('connected'); // listen-only Connected
    expect(connected1.listenOnly).toBe(true);
    // Remote audio still plays — listening works.
    expect(h.media.attached.map((a) => a.playbackKey)).toEqual([`${U2}:mic`]);

    // Later grant (guidance surface retry): upgrades IN PLACE — mic bound to
    // the manifest mid with the send direction declared for the next offer.
    h.media.getUserMediaImpl = () => Promise.resolve(FakeStream.mic());
    h.engine.retryMic();
    await flush();
    expect(senderOf(pc, '0').replaced).toHaveLength(1);
    expect(transceiverOf(pc, '0').direction).toBe('sendonly');
    const upgraded = h.engine.getSnapshot();
    expect(upgraded.listenOnly).toBe(false);
    expect(upgraded.voice.micGranted).toBe(true);
    expect(upgraded.voice.status).toBe('connected'); // never left the call

    // P2 fix: the retry ALSO told the room over op-22 — `state` carrying
    // mic_granted: true is what asks the room to RE-OFFER the mic m-line
    // (the local replaceTrack + sendonly binding can never force one; the
    // server is the sole offerer). Sent once, on the retryMic path only —
    // the fresh join's op-22 carried no mic_granted.
    expect(h.gateway.sentState).toContainEqual({
      channel_id: CH,
      action: 'state',
      mic_granted: true,
    });
    expect(h.gateway.sentState.filter((s) => s.mic_granted === true)).toHaveLength(1);
  });

  it('ice failure: one recoverable restart, then exhausted → VoiceUnavailable + teardown', async () => {
    const h = harness();
    await joinedWithMic(h);
    const pc = h.media.pcs[0]!;
    pc.simulateConnectionState('connected');
    expect(h.engine.getSnapshot().voice.status).toBe('connected');

    pc.simulateConnectionState('failed'); // restart #1 (recoverable)
    expect(h.engine.getSnapshot().voice.status).toBe('reconnecting');

    // The server's ice_restart offer arrives and the leg recovers.
    h.signal(
      envelope([{ mid: '0', user_id: ME, source: 'mic' }], ingestOfferSdp({ mid: '0', kind: 'audio' })),
    );
    await flush();
    pc.simulateConnectionState('connected');
    expect(h.engine.getSnapshot().voice.status).toBe('connected');

    pc.simulateConnectionState('failed'); // restart spent → exhausted
    const snap = h.engine.getSnapshot();
    expect(snap.voice.status).toBe('voice-unavailable');
    expect(snap.voice.notice).toBeNull();
    expect(pc.closed).toBe(true);
  });

  it('a Reconnecting leg whose restart offer NEVER arrives times out after ~15 s (bounded wait)', async () => {
    const h = harness();
    await joinedWithMic(h);
    const pc = h.media.pcs[0]!;
    pc.simulateConnectionState('connected');
    expect(h.engine.getSnapshot().voice.status).toBe('connected');

    vi.useFakeTimers();
    try {
      pc.simulateConnectionState('failed'); // recoverable → Reconnecting, timer armed
      expect(h.engine.getSnapshot().voice.status).toBe('reconnecting');

      vi.advanceTimersByTime(14_999); // still inside the bounded window
      expect(h.engine.getSnapshot().voice.status).toBe('reconnecting');

      vi.advanceTimersByTime(1); // the wait expired — no endless park
      const snap = h.engine.getSnapshot();
      expect(snap.voice.status).toBe('voice-unavailable');
      expect(snap.voice.notice).toBeNull(); // the Retry surface explains itself
      expect(pc.closed).toBe(true);

      // The existing recovery surface: Retry re-joins on the kept channel.
      h.engine.retry();
      await flush();
      expect(h.engine.getSnapshot().voice.status).toBe('connecting-signaling');
      expect(h.gateway.sentState.at(-1)).toEqual({ channel_id: CH, action: 'join' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a recovered Reconnecting leg CLEARS the timeout (no phantom voice-unavailable)', async () => {
    const h = harness();
    await joinedWithMic(h);
    const pc = h.media.pcs[0]!;
    pc.simulateConnectionState('connected');

    vi.useFakeTimers();
    try {
      pc.simulateConnectionState('failed');
      expect(h.engine.getSnapshot().voice.status).toBe('reconnecting');
      // The restart offer lands and the PC reconnects well inside the window.
      h.signal(
        envelope([{ mid: '0', user_id: ME, source: 'mic' }], ingestOfferSdp({ mid: '0', kind: 'audio' })),
      );
      await flush();
      pc.simulateConnectionState('connected');
      expect(h.engine.getSnapshot().voice.status).toBe('connected');

      vi.advanceTimersByTime(60_000); // far past the window — nothing fires
      expect(h.engine.getSnapshot().voice.status).toBe('connected');
    } finally {
      vi.useRealTimers();
    }
  });

  it('displaced (own leg, AM8) tears down with the displaced notice', async () => {
    const h = harness();
    await joinedWithMic(h);
    const pc = h.media.pcs[0]!;
    h.event('CallUpdate', {
      channel_id: CH,
      call_id: CALL_ID,
      user_id: ME,
      leg: 'L1',
      state: 'displaced',
    });
    const snap = h.engine.getSnapshot();
    expect(snap.voice).toMatchObject({ status: 'idle', notice: 'displaced' });
    expect(snap.channelId).toBe(CH); // kept for the "joined elsewhere" notice
    expect(pc.closed).toBe(true);
    // Dismiss clears the notice and the channel binding.
    h.engine.dismiss();
    expect(h.engine.getSnapshot().channelId).toBeNull();
  });

  it('forced_leave on the own leg lands PermissionDenied', async () => {
    const h = harness();
    await joinedWithMic(h);
    h.event('CallUpdate', {
      channel_id: CH,
      call_id: CALL_ID,
      user_id: ME,
      leg: 'L1',
      state: 'forced_leave',
    });
    expect(h.engine.getSnapshot().voice).toMatchObject({
      status: 'permission-denied',
      notice: 'forced-leave',
    });
  });

  it('CALL_END for our call exits cleanly to Idle (no notice)', async () => {
    const h = harness();
    await joinedWithMic(h);
    h.event('CallEnd', {
      channel_id: CH,
      call_id: CALL_ID,
      reason: 'last_left',
      ended_at: '2026-09-06T12:00:00Z',
    });
    expect(h.engine.getSnapshot().voice).toMatchObject({ status: 'idle', notice: null });
  });
});

// ---------------------------------------------------------------------------
// Engine: reconnect / backfill (AM4) + VM8 re-publish
// ---------------------------------------------------------------------------

describe('media engine — gateway resume, backfill, invalid session', () => {
  async function connectedBare(h: Harness): Promise<void> {
    await joinedWithMic(h);
    h.media.pcs[0]!.simulateConnectionState('connected');
  }

  it('gateway loss → Reconnecting; backfill with own leg → backfill-ok → Connected', async () => {
    const h = harness();
    await connectedBare(h);

    h.gateway.connectionState = 'reconnecting';
    h.engine.pollConnectionState();
    expect(h.engine.getSnapshot().voice.status).toBe('reconnecting');

    h.event('CallSync', {
      calls: [
        {
          channel_id: CH,
          call_id: CALL_ID,
          thread_id: '7300000000000000055',
          participants: [
            { user_id: ME, mute: false, deafen: false },
            { user_id: U2, mute: false, deafen: false },
          ],
        },
      ],
      dm_calls: [],
    });
    expect(h.engine.getSnapshot().voice.status).toBe('connected');
  });

  it('backfill showing self absent → rejoin attempt (op-22 join); a still-held camera RE-PUBLISHES on the new leg (VM8)', async () => {
    const h = harness();
    await connectedBare(h);

    // Camera on before the disconnect.
    h.engine.publishCamera();
    await flush();
    expect(publishOps(h, 'camera')).toEqual([
      { channel_id: CH, action: 'publish', source: 'camera' },
    ]);
    const camStream = FakeStream.camera(); // the held capture
    h.capture.cameraImpl = () => Promise.resolve(camStream);
    // (re)publish with the held stream semantics: capture already done above
    // via the default impl — grab its track through a fresh publish below.

    h.gateway.connectionState = 'reconnecting';
    h.engine.pollConnectionState();

    // The call is live but our leg is gone (AM4) → rejoin.
    h.event('CallSync', {
      calls: [
        {
          channel_id: CH,
          call_id: CALL_ID,
          thread_id: '7300000000000000055',
          participants: [{ user_id: U2, mute: false, deafen: false }],
        },
      ],
      dm_calls: [],
    });

    const snap = h.engine.getSnapshot();
    expect(snap.voice.status).toBe('connecting-signaling'); // rejoining
    expect(h.gateway.sentState.at(-1)).toEqual({ channel_id: CH, action: 'join' });

    // The new leg confirms → the camera re-publishes automatically (VM8).
    h.event('CallUpdate', {
      channel_id: CH,
      call_id: CALL_ID,
      user_id: ME,
      leg: 'L9',
      state: 'joined',
    });
    await flush();
    const cameraOps = publishOps(h, 'camera');
    expect(cameraOps.filter((op) => op.action === 'publish')).toHaveLength(2);

    // No live call at all: backfill lands Idle and stays there.
    const h2 = harness();
    await connectedBare(h2);
    h2.gateway.connectionState = 'reconnecting';
    h2.engine.pollConnectionState();
    h2.event('CallEnd', {
      channel_id: CH,
      call_id: CALL_ID,
      reason: 'swept',
      ended_at: '2026-09-06T12:00:00Z',
    });
    expect(h2.engine.getSnapshot().voice.status).toBe('idle');
  });

  it('an ended screen share NEVER auto-restarts after a rejoin — it surfaces the share-ended notice (VM8)', async () => {
    const h = harness();
    await connectedBare(h);

    const screenStream = FakeStream.screen(true);
    h.capture.displayImpl = () => Promise.resolve(screenStream);
    h.engine.publishScreen({ audio: true });
    await flush();
    expect(publishOps(h, 'screen')).toEqual([
      { channel_id: CH, action: 'publish', source: 'screen' },
    ]);
    expect(publishOps(h, 'screen_audio')).toEqual([
      { channel_id: CH, action: 'publish', source: 'screen_audio' },
    ]);

    // The share ends natively while connected (browser stop bar).
    screenStream.videoTracks[0]!.fireEnded();
    await flush();
    expect(publishOps(h, 'screen').at(-1)).toMatchObject({ action: 'unpublish' });
    expect(publishOps(h, 'screen_audio').at(-1)).toMatchObject({ action: 'unpublish' });
    const snap = h.engine.getSnapshot();
    expect(snap.voice.notice).toBe('share-ended');
    expect(snap.voice.status).toBe('connected'); // the leg is unaffected

    // Dismiss clears the mid-call notice without leaving.
    h.engine.dismiss();
    expect(h.engine.getSnapshot().voice).toMatchObject({ status: 'connected', notice: null });

    // A rejoin after the ended share re-publishes NOTHING for screen.
    h.gateway.connectionState = 'reconnecting';
    h.engine.pollConnectionState();
    h.event('CallSync', {
      calls: [
        {
          channel_id: CH,
          call_id: CALL_ID,
          thread_id: '7300000000000000055',
          participants: [{ user_id: U2, mute: false, deafen: false }],
        },
      ],
      dm_calls: [],
    });
    h.event('CallUpdate', {
      channel_id: CH,
      call_id: CALL_ID,
      user_id: ME,
      leg: 'L9',
      state: 'joined',
    });
    await flush();
    expect(publishOps(h, 'screen').filter((op) => op.action === 'publish')).toHaveLength(1);
  });

  it('a fresh Identify (sessionEpoch bump) during reconnect → Offline + teardown', async () => {
    const h = harness();
    await connectedBare(h);
    const pc = h.media.pcs[0]!;

    h.gateway.connectionState = 'reconnecting';
    h.engine.pollConnectionState();
    expect(h.engine.getSnapshot().voice.status).toBe('reconnecting');

    // The "resume" degraded to a full re-identify (epoch advanced).
    h.store.setState((s) => ({ sessionEpoch: s.sessionEpoch + 1 }));
    h.gateway.connectionState = 'ready';
    h.engine.pollConnectionState();

    const snap = h.engine.getSnapshot();
    expect(snap.voice).toMatchObject({ status: 'offline', notice: 'offline' });
    expect(pc.closed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Engine: manifest attribution (R5 — the positional mirror is retired)
// ---------------------------------------------------------------------------

describe('media engine — manifest attribution', () => {
  it('manifest drops a departed participant: playback stops even though the m-line lingers (never mis-attributed)', async () => {
    const h = harness();
    await joinedWithMic(h);

    // Two remote participants join; the offer attributes by manifest.
    for (const [user, leg] of [
      [U2, 'L2'],
      [U3, 'L3'],
    ] as const) {
      h.event('CallUpdate', {
        channel_id: CH,
        call_id: CALL_ID,
        user_id: user,
        leg,
        state: 'joined',
      });
    }
    await flush();
    h.signal(
      envelope(
        [
          { mid: '0', user_id: ME, source: 'mic' },
          { mid: '1', user_id: U2, source: 'mic' },
          { mid: '2', user_id: U3, source: 'mic' },
        ],
        offerSdp({ mid: '1' }, { mid: '2' }),
      ),
    );
    await flush();
    expect(h.media.attached.map((a) => a.playbackKey).sort()).toEqual(
      [`${U2}:mic`, `${U3}:mic`].sort(),
    );

    // U2 leaves: their m-line is RETAINED server-side (V1 behavior) but the
    // manifest drops their entry — their playback stops, U3's is untouched,
    // and the lingering active m-line attributes to NOBODY.
    h.event('CallUpdate', {
      channel_id: CH,
      call_id: CALL_ID,
      user_id: U2,
      leg: 'L2',
      state: 'left',
    });
    await flush();
    h.signal(
      envelope(
        [
          { mid: '0', user_id: ME, source: 'mic' },
          { mid: '2', user_id: U3, source: 'mic' },
        ],
        offerSdp({ mid: '1' }, { mid: '2' }),
      ),
    );
    await flush();
    const u2Handles = h.media.attached.filter((a) => a.playbackKey === `${U2}:mic`);
    expect(u2Handles).toHaveLength(1);
    expect(u2Handles[0]!.stopped).toBe(true);
    const u3Handles = h.media.attached.filter((a) => a.playbackKey === `${U3}:mic`);
    expect(u3Handles.at(-1)!.stopped).toBe(false);
  });

  it('rejoin of a departed participant replaces their stale playback handle', async () => {
    const h = harness();
    await joinedWithMic(h);
    h.event('CallUpdate', {
      channel_id: CH,
      call_id: CALL_ID,
      user_id: U2,
      leg: 'L2',
      state: 'joined',
    });
    await flush();
    h.signal(
      envelope(
        [
          { mid: '0', user_id: ME, source: 'mic' },
          { mid: '1', user_id: U2, source: 'mic' },
        ],
        offerSdp({ mid: '1' }),
      ),
    );
    await flush();
    expect(h.media.attached.filter((a) => a.playbackKey === `${U2}:mic`)).toHaveLength(1);

    // U2 leaves, then rejoins on a fresh leg: the re-offer attributes a NEW
    // mid; the stale handle is replaced, never kept.
    h.event('CallUpdate', {
      channel_id: CH,
      call_id: CALL_ID,
      user_id: U2,
      leg: 'L2',
      state: 'left',
    });
    await flush();
    h.event('CallUpdate', {
      channel_id: CH,
      call_id: CALL_ID,
      user_id: U2,
      leg: 'L9',
      state: 'joined',
    });
    await flush();
    h.signal(
      envelope(
        [
          { mid: '0', user_id: ME, source: 'mic' },
          { mid: '2', user_id: U2, source: 'mic' },
        ],
        offerSdp({ mid: '1' }, { mid: '2' }),
      ),
    );
    await flush();

    const u2 = h.media.attached.filter((a) => a.playbackKey === `${U2}:mic`);
    expect(u2).toHaveLength(2); // stale handle replaced, never kept
    expect(u2[0]!.stopped).toBe(true);
    expect(u2[1]!.stopped).toBe(false);
  });

  it('video tracks key on the manifest (user:source) and detach when the manifest drops them', async () => {
    const h = harness();
    await joinedWithMic(h);
    h.event('CallUpdate', {
      channel_id: CH,
      call_id: CALL_ID,
      user_id: U2,
      leg: 'L2',
      state: 'camera_on',
      source: 'camera',
    });
    await flush();
    h.signal(
      envelope(
        [
          { mid: '0', user_id: ME, source: 'mic' },
          { mid: '1', user_id: U2, source: 'mic' },
          { mid: '2', user_id: U2, source: 'camera', rids: ['f', 'h', 'q'] },
        ],
        offerSdp({ mid: '1' }, { mid: '2', kind: 'video' }),
      ),
    );
    await flush();
    expect([...h.engine.getVideoTracks().keys()]).toEqual([`${U2}:camera`]);

    // U2 turns the camera off: the manifest drops the entry — the tile's
    // track detaches (the roster state and the manifest agree).
    h.event('CallUpdate', {
      channel_id: CH,
      call_id: CALL_ID,
      user_id: U2,
      leg: 'L2',
      state: 'camera_off',
      source: 'camera',
    });
    await flush();
    h.signal(
      envelope(
        [
          { mid: '0', user_id: ME, source: 'mic' },
          { mid: '1', user_id: U2, source: 'mic' },
        ],
        offerSdp({ mid: '1' }, { mid: '2', kind: 'video', active: false }),
      ),
    );
    await flush();
    expect([...h.engine.getVideoTracks().keys()]).toEqual([]);
  });

  it('an m-line missing from the manifest NEVER plays (tolerance — no positional guessing)', async () => {
    const h = harness();
    await joinedWithMic(h);
    h.event('CallUpdate', {
      channel_id: CH,
      call_id: CALL_ID,
      user_id: U2,
      leg: 'L2',
      state: 'joined',
    });
    await flush();
    // The offer carries U2's egress m-line but the manifest omits it.
    h.signal(
      envelope([{ mid: '0', user_id: ME, source: 'mic' }], offerSdp({ mid: '1' })),
    );
    await flush();
    expect(h.media.attached).toHaveLength(0);
    expect([...h.engine.getVideoTracks().keys()]).toEqual([]);
  });

  it('a V1-shaped offer body (no envelope) still negotiates — with an EMPTY manifest nothing plays', async () => {
    const h = harness();
    await joinedWithMic(h);
    h.signal(JSON.stringify({ type: 'offer', sdp: offerSdp({ mid: '1' }) }));
    await flush();

    const pc = h.media.pcs[0]!;
    expect(pc.remoteDescriptions).toHaveLength(1);
    expect(h.gateway.sentSignal.filter((s) => s.kind === 'sdp')).toHaveLength(1);
    // No mic m-line attributed → nothing bound; no playback guessed.
    expect(h.media.attached).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Engine: KTD1 send-side binding (out-of-order grants)
// ---------------------------------------------------------------------------

describe('media engine — manifest send-side binding (KTD1)', () => {
  it('same-kind sources bind to THEIR manifest mid even when captures resolve out of publish order', async () => {
    const h = harness();
    await joinedWithMic(h);

    // Screen requested FIRST, camera SECOND — but the camera's prompt
    // resolves first and the server accepts it first, so the manifest
    // assigns camera mid 2 and screen mid 3 (acceptance order).
    let grantScreen: ((s: FakeStream) => void) | null = null;
    const screenStream = FakeStream.screen();
    h.capture.displayImpl = () => new Promise((resolve) => (grantScreen = () => resolve(screenStream)));
    const cameraStream = FakeStream.camera();
    h.capture.cameraImpl = () => Promise.resolve(cameraStream);

    h.engine.publishScreen(); // capture pending
    await flush();
    h.engine.publishCamera(); // resolves immediately
    await flush();
    expect(publishOps(h, 'camera')).toEqual([
      { channel_id: CH, action: 'publish', source: 'camera' },
    ]);

    // The re-offer attributes BOTH ingest mids while only the camera is
    // held (the screen prompt is still up).
    h.signal(
      envelope(
        [
          { mid: '0', user_id: ME, source: 'mic' },
          { mid: '2', user_id: ME, source: 'camera', rids: ['f', 'h', 'q'] },
          { mid: '3', user_id: ME, source: 'screen', rids: ['f', 'h', 'q'] },
        ],
        ingestOfferSdp(
          { mid: '0', kind: 'audio' },
          { mid: '2', kind: 'video', rids: ['f', 'h', 'q'] },
          { mid: '3', kind: 'video', rids: ['f', 'h', 'q'] },
        ),
      ),
    );
    await flush();
    const pc = h.media.pcs[0]!;
    expect(senderOf(pc, '2').replaced).toEqual([cameraStream.videoTracks[0]]);
    expect(senderOf(pc, '3').replaced).toEqual([]); // screen not held YET

    // The screen prompt resolves → its publish op → its OWN re-offer binds
    // it to mid 3 (never onto the camera's mid 2). The camera re-binds to
    // ITS mid (idempotent rebinding on every offer).
    grantScreen!(screenStream);
    await flush();
    expect(publishOps(h, 'screen')).toEqual([
      { channel_id: CH, action: 'publish', source: 'screen' },
    ]);
    h.signal(
      envelope(
        [
          { mid: '0', user_id: ME, source: 'mic' },
          { mid: '2', user_id: ME, source: 'camera', rids: ['f', 'h', 'q'] },
          { mid: '3', user_id: ME, source: 'screen', rids: ['f', 'h', 'q'] },
        ],
        ingestOfferSdp(
          { mid: '0', kind: 'audio' },
          { mid: '2', kind: 'video', rids: ['f', 'h', 'q'] },
          { mid: '3', kind: 'video', rids: ['f', 'h', 'q'] },
        ),
      ),
    );
    await flush();
    // THE out-of-order-grants invariant: each m-line carries ONLY its own
    // source's track — never swapped despite the inverted resolution order.
    expect(senderOf(pc, '2').replaced.every((t) => t === cameraStream.videoTracks[0])).toBe(true);
    expect(senderOf(pc, '3').replaced.every((t) => t === screenStream.videoTracks[0])).toBe(true);
  });

  it('the audio pair (mic + share-audio) binds by mid — never swapped', async () => {
    const h = harness();
    await joinedWithMic(h);

    const screenStream = FakeStream.screen(true);
    h.capture.displayImpl = () => Promise.resolve(screenStream);
    h.engine.publishScreen({ audio: true });
    await flush();

    // Manifest: mic mid 0, screen video mid 2, share-audio mid 3.
    h.signal(
      envelope(
        [
          { mid: '0', user_id: ME, source: 'mic' },
          { mid: '2', user_id: ME, source: 'screen' },
          { mid: '3', user_id: ME, source: 'screen_audio' },
        ],
        ingestOfferSdp(
          { mid: '0', kind: 'audio' },
          { mid: '2', kind: 'video' },
          { mid: '3', kind: 'audio' },
        ),
      ),
    );
    await flush();
    const pc = h.media.pcs[0]!;
    expect(senderOf(pc, '0').replaced).toHaveLength(1); // mic track
    expect(senderOf(pc, '3').replaced).toEqual([screenStream.audioTracks[0]]); // share-audio
    expect(senderOf(pc, '2').replaced).toEqual([screenStream.videoTracks[0]]);
  });

  it('rid-munged ingest m-lines get per-encoding sender caps (GO branch, VM2/R2)', async () => {
    const h = harness();
    await joinedWithMic(h);
    const cameraStream = FakeStream.camera();
    h.capture.cameraImpl = () => Promise.resolve(cameraStream);
    h.engine.publishCamera();
    await flush();

    h.signal(
      envelope(
        [
          { mid: '0', user_id: ME, source: 'mic' },
          { mid: '2', user_id: ME, source: 'camera', rids: ['f', 'h', 'q'] },
        ],
        ingestOfferSdp(
          { mid: '0', kind: 'audio' },
          { mid: '2', kind: 'video', rids: ['f', 'h', 'q'] },
        ),
      ),
    );
    await flush();
    const sender = senderOf(h.media.pcs[0]!, '2');
    expect(sender.replaced).toEqual([cameraStream.videoTracks[0]]);
    const encodings = sender.params.encodings;
    expect(encodings.map((e) => e['rid'])).toEqual(['f', 'h', 'q']);
    // CAMERA_QUALITY_PRESETS.high = 720p30 @1800 kbps top; layers 40%/15%
    // with floors 150/80 (f=1800k, h=720k, q=270k), scales 1/2/4.
    expect(encodings[0]).toMatchObject({ maxBitrate: 1_800_000, scaleResolutionDownBy: 1 });
    expect(encodings[1]).toMatchObject({ maxBitrate: 720_000, scaleResolutionDownBy: 2 });
    expect(encodings[2]).toMatchObject({ maxBitrate: 270_000, scaleResolutionDownBy: 4 });
    // VM12: the camera track carries the motion hint.
    expect(cameraStream.videoTracks[0]!.contentHint).toBe('motion');
  });

  it('sender caps RE-APPLY after the answer commits when bind-time encodings were empty', async () => {
    const h = harness();
    await joinedWithMic(h);
    const cameraStream = FakeStream.camera();
    h.capture.cameraImpl = () => Promise.resolve(cameraStream);
    h.engine.publishCamera();
    await flush();

    // Pre-answer, this browser's senders report EMPTY encodings (Chrome
    // materializes one-per-rid only once the answer commits) — so the
    // track-bound hook's applySenderCaps no-opped at bind time.
    const pc = h.media.pcs[0]!;
    const origSrd = pc.setRemoteDescription.bind(pc);
    pc.setRemoteDescription = async (d) => {
      await origSrd(d);
      for (const t of pc.transceivers) t.sender.params = { encodings: [] };
    };
    const origSld = pc.setLocalDescription.bind(pc);
    pc.setLocalDescription = async (d) => {
      // The answer commit materializes the rid encodings.
      for (const t of pc.transceivers) {
        if (t.mid === '2') t.sender.params = { encodings: [{ rid: 'f' }, { rid: 'h' }, { rid: 'q' }] };
      }
      await origSld(d);
    };

    h.signal(
      envelope(
        [
          { mid: '0', user_id: ME, source: 'mic' },
          { mid: '2', user_id: ME, source: 'camera', rids: ['f', 'h', 'q'] },
        ],
        ingestOfferSdp(
          { mid: '0', kind: 'audio' },
          { mid: '2', kind: 'video', rids: ['f', 'h', 'q'] },
        ),
      ),
    );
    await flush();

    const sender = senderOf(pc, '2');
    expect(sender.replaced).toEqual([cameraStream.videoTracks[0]]); // bound
    // Caps landed POST-ANSWER — the top layer is no longer uncapped:
    // CAMERA_QUALITY_PRESETS.high = 1800 kbps top, 40%/15% layers.
    expect(sender.params.encodings[0]).toMatchObject({
      rid: 'f',
      maxBitrate: 1_800_000,
      scaleResolutionDownBy: 1,
    });
    expect(sender.params.encodings[1]).toMatchObject({ rid: 'h', maxBitrate: 720_000 });
    expect(sender.params.encodings[2]).toMatchObject({ rid: 'q', maxBitrate: 270_000 });
  });
});

// ---------------------------------------------------------------------------
// Engine: publish lifecycle (R4 — every native-stop path → one unpublish)
// ---------------------------------------------------------------------------

describe('media engine — publish lifecycle', () => {
  it('camera toggle-off unpublishes; the browser stop path (onended) converges on the SAME unpublish', async () => {
    const h = harness();
    await connected(h);

    // User toggle-off path.
    const cameraStream = FakeStream.camera();
    h.capture.cameraImpl = () => Promise.resolve(cameraStream);
    h.engine.publishCamera();
    await flush();
    expect(publishOps(h, 'camera')).toEqual([
      { channel_id: CH, action: 'publish', source: 'camera' },
    ]);
    expect(h.engine.getSnapshot().publishing.camera).toBe(true);

    h.engine.unpublishSource('camera');
    await flush();
    expect(publishOps(h, 'camera').at(-1)).toEqual({
      channel_id: CH,
      action: 'unpublish',
      source: 'camera',
    });
    expect(cameraStream.videoTracks[0]!.stopped).toBe(true);
    expect(h.engine.getSnapshot().publishing.camera).toBe(false);

    // Native-stop path (OS revoke fires onended mid-publish) → the SAME
    // unpublish shape, no notice (share-ended is screens only).
    const revoked = FakeStream.camera();
    h.capture.cameraImpl = () => Promise.resolve(revoked);
    h.engine.publishCamera();
    await flush();
    expect(h.engine.getSnapshot().publishing.camera).toBe(true);

    revoked.videoTracks[0]!.fireEnded();
    await flush();
    expect(publishOps(h, 'camera').at(-1)).toEqual({
      channel_id: CH,
      action: 'unpublish',
      source: 'camera',
    });
    expect(h.engine.getSnapshot().publishing.camera).toBe(false);
    expect(h.engine.getSnapshot().voice.notice).toBeNull();
  });

  it('KTD6: a server-driven camera_off (rights revocation) retires the still-held capture + notices — no echo op', async () => {
    const h = harness();
    await connected(h);
    const cameraStream = FakeStream.camera();
    h.capture.cameraImpl = () => Promise.resolve(cameraStream);
    h.engine.publishCamera();
    await flush();
    expect(h.engine.getSnapshot().publishing.camera).toBe(true);

    // Another leg's camera_off never touches our capture (own-leg gate).
    h.event('CallUpdate', {
      channel_id: CH,
      call_id: CALL_ID,
      user_id: ME,
      leg: 'L9',
      state: 'camera_off',
      source: 'camera',
    });
    expect(h.engine.getSnapshot().publishing.camera).toBe(true);
    expect(cameraStream.videoTracks[0]!.stopped).toBe(false);

    // The room revokes SEND_VIDEO: camera_off on the OWN leg.
    h.event('CallUpdate', {
      channel_id: CH,
      call_id: CALL_ID,
      user_id: ME,
      leg: 'L1',
      state: 'camera_off',
      source: 'camera',
    });
    const snap = h.engine.getSnapshot();
    expect(cameraStream.videoTracks[0]!.stopped).toBe(true); // OS light off
    expect(snap.publishing.camera).toBe(false); // snapshot matches the room
    expect(snap.voice.status).toBe('connected'); // the leg keeps running
    expect(snap.voice.notice).toBe('camera-stopped'); // KTD6 banner copy
    // The server DROVE the unpublish — the client never echoes one back.
    expect(publishOps(h, 'camera')).toEqual([
      { channel_id: CH, action: 'publish', source: 'camera' },
    ]);

    // Dismiss clears the banner; the toggle re-arms (a fresh publish is a
    // fresh permission question, not an auto-restart).
    h.engine.dismiss();
    expect(h.engine.getSnapshot().voice.notice).toBeNull();
  });

  it('KTD6: a server-driven screen_off retires share + share-audio with the share-stopped notice', async () => {
    const h = harness();
    await connected(h);
    const screenStream = FakeStream.screen(true);
    h.capture.displayImpl = () => Promise.resolve(screenStream);
    h.engine.publishScreen({ audio: true });
    await flush();
    expect(h.engine.getSnapshot().publishing).toEqual({
      camera: false,
      screen: true,
      screen_audio: true,
    });

    h.event('CallUpdate', {
      channel_id: CH,
      call_id: CALL_ID,
      user_id: ME,
      leg: 'L1',
      state: 'screen_off',
      source: 'screen',
    });
    const snap = h.engine.getSnapshot();
    expect(screenStream.videoTracks[0]!.stopped).toBe(true);
    expect(screenStream.audioTracks[0]!.stopped).toBe(true); // audio dies with it
    expect(snap.publishing).toEqual({ camera: false, screen: false, screen_audio: false });
    expect(snap.voice.status).toBe('connected');
    expect(snap.voice.notice).toBe('share-stopped');
    expect(publishOps(h, 'screen')).toEqual([
      { channel_id: CH, action: 'publish', source: 'screen' },
    ]); // no echo unpublish
    expect(publishOps(h, 'screen_audio')).toEqual([
      { channel_id: CH, action: 'publish', source: 'screen_audio' },
    ]);
  });

  it('KTD6: our OWN unpublish\'s camera_off echo does NOT double-fire (nothing still held)', async () => {
    const h = harness();
    await connected(h);
    const cameraStream = FakeStream.camera();
    h.capture.cameraImpl = () => Promise.resolve(cameraStream);
    h.engine.publishCamera();
    await flush();

    // The user toggles off; the room's echo arrives afterwards.
    h.engine.unpublishSource('camera');
    await flush();
    expect(publishOps(h, 'camera')).toHaveLength(2); // publish + unpublish

    h.event('CallUpdate', {
      channel_id: CH,
      call_id: CALL_ID,
      user_id: ME,
      leg: 'L1',
      state: 'camera_off',
      source: 'camera',
    });
    const snap = h.engine.getSnapshot();
    expect(snap.publishing.camera).toBe(false);
    expect(snap.voice.notice).toBeNull(); // no notice — WE initiated it
    expect(snap.voice.status).toBe('connected');
    expect(publishOps(h, 'camera')).toHaveLength(2); // no third, echo op
  });

  it('screen publish with audio publishes BOTH sources; the stop bar ends both with the share-ended notice', async () => {
    const h = harness();
    await connected(h);
    const screenStream = FakeStream.screen(true);
    h.capture.displayImpl = () => Promise.resolve(screenStream);

    h.engine.publishScreen({ audio: true });
    await flush();
    expect(publishOps(h, 'screen')).toEqual([
      { channel_id: CH, action: 'publish', source: 'screen' },
    ]);
    expect(publishOps(h, 'screen_audio')).toEqual([
      { channel_id: CH, action: 'publish', source: 'screen_audio' },
    ]);
    expect(screenStream.videoTracks[0]!.contentHint).toBe('detail'); // VM12

    // The browser's own stop-sharing bar.
    screenStream.videoTracks[0]!.fireEnded();
    await flush();
    expect(publishOps(h, 'screen').at(-1)).toEqual({
      channel_id: CH,
      action: 'unpublish',
      source: 'screen',
    });
    expect(publishOps(h, 'screen_audio').at(-1)).toEqual({
      channel_id: CH,
      action: 'unpublish',
      source: 'screen_audio',
    });
    expect(screenStream.audioTracks[0]!.stopped).toBe(true); // audio dies with it
    expect(h.engine.getSnapshot().voice).toMatchObject({
      status: 'connected',
      notice: 'share-ended',
    });
  });

  it('a platform without display audio publishes the share WITHOUT screen_audio (VM9)', async () => {
    const h = harness();
    await connected(h);
    h.capture.displayImpl = () => Promise.resolve(FakeStream.screen(false));
    h.engine.publishScreen({ audio: true });
    await flush();
    expect(publishOps(h, 'screen')).toHaveLength(1);
    expect(publishOps(h, 'screen_audio')).toHaveLength(0);
    expect(h.engine.getSnapshot().publishing).toEqual({
      camera: false,
      screen: true,
      screen_audio: false,
    });
  });

  it('a second publishScreen({audio:true}) DURING an in-flight capture keeps the audio ask (re-capture with audio)', async () => {
    const h = harness();
    await connected(h);
    // A gated picker: every getDisplayMedia call parks until the test grants it.
    const grantCalls: Array<(s: FakeStream) => void> = [];
    h.capture.displayImpl = () => new Promise((resolve) => grantCalls.push(resolve));

    h.engine.publishScreen(); // capture 1 in flight (no audio asked)
    await flush();
    h.engine.publishScreen({ audio: true }); // bails on the in-flight capture
    await flush();
    expect(grantCalls).toHaveLength(1); // no second picker mid-flight
    expect(publishOps(h, 'screen')).toHaveLength(0); // nothing published yet

    grantCalls[0]!(FakeStream.screen(false)); // capture 1 lands WITHOUT audio
    await flush();
    // The audio ask survived the bail: a re-capture WITH audio ran.
    expect(grantCalls).toHaveLength(2);
    const requested = h.capture.requested[1]!;
    expect(requested.audio).toMatchObject({ echoCancellation: false });

    grantCalls[1]!(FakeStream.screen(true)); // capture 2 carries share-audio
    await flush();
    expect(publishOps(h, 'screen_audio')).toEqual([
      { channel_id: CH, action: 'publish', source: 'screen_audio' },
    ]);
    const snap = h.engine.getSnapshot();
    expect(snap.publishing.screen).toBe(true);
    expect(snap.publishing.screen_audio).toBe(true); // the ask landed
  });

  it('VM13: a window-switch replaces the track on the bound sender — no new publish ops', async () => {
    const h = harness();
    await connected(h);
    const first = FakeStream.screen();
    h.capture.displayImpl = () => Promise.resolve(first);
    h.engine.publishScreen();
    await flush();

    // Bind via the re-offer.
    h.signal(
      envelope(
        [
          { mid: '0', user_id: ME, source: 'mic' },
          { mid: '2', user_id: ME, source: 'screen', rids: ['f', 'h', 'q'] },
        ],
        ingestOfferSdp(
          { mid: '0', kind: 'audio' },
          { mid: '2', kind: 'video', rids: ['f', 'h', 'q'] },
        ),
      ),
    );
    await flush();
    const sender = senderOf(h.media.pcs[0]!, '2');
    expect(sender.replaced).toEqual([first.videoTracks[0]]);

    // The user picks a different window: a fresh capture replaces the track.
    const second = FakeStream.screen();
    h.capture.displayImpl = () => Promise.resolve(second);
    h.engine.switchScreenSource();
    await flush();

    expect(sender.replaced).toEqual([first.videoTracks[0], second.videoTracks[0]]);
    expect(first.videoTracks[0]!.stopped).toBe(true); // old capture stopped
    // Still ONE publish for screen — no renegotiation storm.
    expect(publishOps(h, 'screen')).toHaveLength(1);
    expect(h.engine.getSnapshot().publishing.screen).toBe(true);
  });

  it('capture refusals never lie to the roster (no publish op, publishing stays false)', async () => {
    const h = harness();
    await connected(h);
    h.capture.cameraImpl = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));
    h.engine.publishCamera();
    await flush();
    expect(publishOps(h, 'camera')).toHaveLength(0);
    expect(h.engine.getSnapshot().publishing.camera).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Engine: adaptive budget wiring (KTD7)
// ---------------------------------------------------------------------------

describe('media engine — adaptive budget → op-22 video_want', () => {
  it('a degraded window emits video_want on state; the dedicated ~2 s window holds the second want', async () => {
    // An injected REAL ladder wired through the engine's factory hooks (the
    // engine's own onWant — the send path under test); stats feed via the
    // fake PC's report; no timers (the test drives the ladder by hand).
    let budgetRef: AdaptiveBudget | null = null;
    const h = harness({
      adaptiveBudget: (hooks) =>
        (budgetRef = new AdaptiveBudget({
          ...hooks,
          setIntervalFn: () => 0,
          clearIntervalFn: () => undefined,
        })),
    });
    await joinedWithMic(h);
    const pc = h.media.pcs[0]!;
    pc.simulateConnectionState('connected');

    // Degrade: jitter above the threshold (single-poll windows carry no
    // freeze deltas — freeze accrual is the multi-poll signature).
    pc.statsReport = [
      { type: 'inbound-rtp', kind: 'video', freezeCount: 3, jitter: 0.08, bytesReceived: 1_000_500 },
    ];
    await budgetRef!.poll();
    budgetRef!.evaluateWindow();

    const wantOps = h.gateway.sentState.filter(
      (s) => s.action === 'state' && s.video_want !== undefined,
    );
    expect(wantOps).toHaveLength(1);
    expect(wantOps[0]!).toMatchObject({
      channel_id: CH,
      action: 'state',
      video_want: { tiles: 8, max_quality: 'medium' },
    });

    // A second decision inside the 2 s window is HELD, not sent...
    pc.statsReport = [
      { type: 'inbound-rtp', kind: 'video', freezeCount: 5, jitter: 0.08, bytesReceived: 1_000_600 },
    ];
    await budgetRef!.poll();
    budgetRef!.evaluateWindow();
    expect(h.gateway.sentState.filter((s) => s.video_want !== undefined)).toHaveLength(1);

    // ...and flushes once the window opens (KTD7's client half).
    await vi.waitFor(
      () => {
        expect(h.gateway.sentState.filter((s) => s.video_want !== undefined)).toHaveLength(2);
      },
      { timeout: 3500 },
    );
    h.engine.destroy();
  });

  it('the budget starts with the PC and stops on teardown', async () => {
    const calls: string[] = [];
    const h = harness({
      adaptiveBudget: () => ({
        start: () => calls.push('start'),
        stop: () => calls.push('stop'),
        getWant: () => ({ tiles: 9, max_quality: 'high' as const }),
      }),
    });
    startCallInStore(h);
    h.engine.join(CH);
    await flush();
    expect(calls).toEqual(['start']);
    h.engine.leave();
    expect(calls).toEqual(['start', 'stop']);
    h.engine.destroy();
  });
});

// ---------------------------------------------------------------------------
// ICE config delivery (calls plan U12 — GET /calls/ice at call-join)
// ---------------------------------------------------------------------------

describe('ICE config delivery (U12)', () => {
  // configureIce is MODULE-level state — never leak entries between tests.
  afterEach(() => {
    configureIce([]);
  });

  it('fetches the ICE config at join and wires configureIce BEFORE the PC exists', async () => {
    const entry: RTCIceServerLike = {
      urls: 'turn:turn.cytale.test:3478',
      username: '1800003600',
      credential: 'TzQdJjc/Vqz1SptekQHSXhwv+I=',
    };
    const h = harness({ fetchIceServers: () => Promise.resolve([entry]) });
    h.media.expectedIceServers = [entry];

    startCallInStore(h);
    h.engine.join(CH);
    // The PC creation WAITS on the fetch (iceServers are fixed at creation).
    expect(h.media.pcs).toHaveLength(0);
    await flush();

    expect(h.media.pcs).toHaveLength(1);
    expect(currentIceServers()).toEqual([entry]);

    // Negotiation proceeds through the deferred PC: a queued server offer
    // is applied and the answer goes out — with the mic bound by manifest.
    h.signal(
      envelope(
        [
          { mid: '0', user_id: ME, source: 'mic' },
          { mid: '1', user_id: U2, source: 'mic' },
        ],
        offerSdp({ mid: '1' }),
      ),
    );
    await flush();
    expect(h.gateway.sentSignal.filter((s) => s.kind === 'sdp')).toHaveLength(1);
    expect(senderOf(h.media.pcs[0]!, '0').replaced).toHaveLength(1); // mic bound
  });

  it('failed fetch still creates the PC (host/loopback degradation)', async () => {
    const h = harness({
      fetchIceServers: () => Promise.reject(new Error('ice endpoint down')),
    });
    h.media.expectedIceServers = []; // stays on the loopback default

    startCallInStore(h);
    h.engine.join(CH);
    await flush();

    expect(h.media.pcs).toHaveLength(1);
    h.signal(
      envelope(
        [
          { mid: '0', user_id: ME, source: 'mic' },
          { mid: '1', user_id: U2, source: 'mic' },
        ],
        offerSdp({ mid: '1' }),
      ),
    );
    await flush();
    expect(h.gateway.sentSignal.filter((s) => s.kind === 'sdp')).toHaveLength(1);
  });

  it('a hung fetch times out and proceeds with the configured servers', async () => {
    const h = harness({
      fetchIceServers: () => new Promise<RTCIceServerLike[]>(() => undefined),
      iceTimeoutMs: 10,
    });
    h.media.expectedIceServers = [];

    startCallInStore(h);
    h.engine.join(CH);
    await flush();
    expect(h.media.pcs).toHaveLength(0); // still waiting

    await new Promise((r) => setTimeout(r, 25));
    expect(h.media.pcs).toHaveLength(1);
  });

  it('a stale continuation (leave before the fetch resolves) never creates the PC', async () => {
    let resolveFetch: (servers: RTCIceServerLike[]) => void = () => undefined;
    const h = harness({
      fetchIceServers: () =>
        new Promise<RTCIceServerLike[]>((resolve) => {
          resolveFetch = resolve;
        }),
    });

    startCallInStore(h);
    h.engine.join(CH);
    h.engine.leave();
    resolveFetch([{ urls: 'turn:t:3478' }]);
    await flush();

    expect(h.media.pcs).toHaveLength(0);
    expect(currentIceServers()).toEqual([]);
  });

  it('mic granted before the fetch resolves binds exactly once when the offer lands', async () => {
    let resolveFetch: (servers: RTCIceServerLike[]) => void = () => undefined;
    const h = harness({
      fetchIceServers: () =>
        new Promise<RTCIceServerLike[]>((resolve) => {
          resolveFetch = resolve;
        }),
    });

    startCallInStore(h);
    h.engine.join(CH);
    await flush(); // mic granted; PC still pending on the fetch
    expect(h.media.pcs).toHaveLength(0);

    resolveFetch([]);
    await flush();
    expect(h.media.pcs).toHaveLength(1);
    // The mic binds at the offer's SRD — exactly once, by manifest mid
    // (addTrack's first-free-m-line hazard is gone — KTD1).
    h.signal(
      envelope(
        [
          { mid: '0', user_id: ME, source: 'mic' },
          { mid: '1', user_id: U2, source: 'mic' },
        ],
        offerSdp({ mid: '1' }),
      ),
    );
    await flush();
    expect(senderOf(h.media.pcs[0]!, '0').replaced).toHaveLength(1);
    expect(h.media.pcs[0]!.addedTracks).toHaveLength(0);
  });
});
