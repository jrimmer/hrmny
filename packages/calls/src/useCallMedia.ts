/**
 * @cytale/calls — the client media engine (calls plan U8; calls V2 plan U4).
 *
 * Owns the RTCPeerConnection lifecycle for the viewer's ONE voice leg and
 * drives the AM14 composite machine (voiceState.ts) from real events:
 *
 *   op 22 (join/start) ──► room confirms (CALL_UPDATE `joined`, own leg)
 *        │                         │
 *        ▼                         ▼
 *   getUserMedia ──mic──► server offer (CALL_SIGNAL, envelope v2) ──► answer
 *        │                         │  (server is the SOLE offerer, U5;
 *        │                         │   DTX rides the answer — R12)
 *        ▼                         ▼
 *   ICE trickle both ways  ──►  pc `connected` + mic granted ──► Connected
 *
 * Everything browser-shaped is behind injectable seams (MediaEnv,
 * CaptureEnv, CallGatewayLike, the CALL_SIGNAL bus) so tests run a full
 * negotiation against a fake PC + fake gateway; the host supplies the real
 * ones through CallEngineDeps (apps/web: browserEnv.ts + webWiring.ts; the
 * two-REAL-browser falsification is the e2e unit's, deliberately not this
 * one's). This module holds NO platform globals: its defaults are the
 * host-neutral fallbacks in platform.ts.
 *
 * Glare safety (the plan's defer rule): while an offer is being applied
 * (setRemoteDescription → track binding → createAnswer →
 * setLocalDescription in flight) further offers queue. The answerer can
 * never express new m-lines, so SEND-side changes land pre-answer via the
 * manifest binding below or wait for the next offer.
 *
 * V2 ATTRIBUTION (R5/KTD1 — manifest.ts is THE single attribution source):
 * every server offer arrives as the v2 envelope `{"v":2,"type":"offer",
 * "sdp":…,"tracks":[{mid,user_id,source,rids?}]}`; the engine keys ALL
 * track decisions on its mid→(user,source) map — audio playback (mic +
 * share-audio), video tiles (camera/screen), AND its own send-side
 * binding: the mic and every published source attach to the leg's ingest
 * m-lines BY MANIFEST MID via `transceiver.sender.replaceTrack` after
 * setRemoteDescription, never first-free-m-line (same-kind sources
 * otherwise swap when permission prompts resolve out of publish order).
 * V1's positional m-line-order mirror (`remoteOrder`) is RETIRED — an
 * unattributed m-line (missing manifest entry, V1 body) simply never
 * plays; nothing is ever guessed positionally again.
 *
 * V2 additions owned here: the publish engine (usePublish.ts — camera/
 * screen/share-audio capture with every native-stop path converging on one
 * unpublish, quality caps, VM8 re-publish-across-rejoin) and the adaptive
 * budget (useAdaptiveBudget.ts — the getStats ladder whose want rides
 * op-22 `video_want` inside its dedicated ~2 s client window). Listen-only
 * joins (VM5): a denied mic degrades the leg to listen-only instead of
 * tearing it down; a later grant upgrades in place.
 */

import type {
  CallEnd,
  CallSourceKind,
  CallSync,
  CallUpdate,
  GatewayCallSignalPayload,
  GatewayCallStateUpdatePayload,
  VideoQualityPreference,
  VideoWant,
} from '@cytale/protocol';
import { defaultStore, type StateStore } from '@cytale/state';

import {
  AdaptiveBudget,
  LADDER_INITIAL_TILES,
  type AdaptiveBudgetHandle,
  type StatsReportLike,
} from './useAdaptiveBudget.js';
import type { CaptureEnv, PublishQualityId } from './usePublish.js';
import { createPublishEngine, type PublishEngine } from './usePublish.js';
import { onCallSignal } from './session-call-signal.js';
import {
  emptyManifest,
  isAudioSource,
  isVideoSource,
  ownEntries,
  parseCallOffer,
  parseMlines,
  trackKey,
  type CallTrackManifest,
} from './manifest.js';
import { noIceServers, unavailableMediaEnv } from './platform.js';
import { SpeakingMonitor } from './speaking.js';
import {
  initialVoiceState,
  isTerminal,
  transition,
  type VoiceEffect,
  type VoiceInput,
  type VoiceState,
} from './voiceState.js';

// ---------------------------------------------------------------------------
// Structural media types (browser RTCPeerConnection's used surface)
// ---------------------------------------------------------------------------

export interface MediaTrackLike {
  enabled: boolean;
  /** VM12: 'motion' (camera) | 'detail' (screen). */
  contentHint?: string;
  /** Native-stop hook (stop bar / closed window / OS revoke — R4's paths). */
  onended?: (() => void) | null;
  stop(): void;
  applyConstraints?(constraints: unknown): Promise<void>;
}

export interface MediaStreamLike {
  getAudioTracks(): MediaTrackLike[];
  getVideoTracks(): MediaTrackLike[];
}

export interface RtpDescriptionLike {
  type: string;
  sdp: string;
}

/** RTCIceCandidateInit shape (camelCase, the wire contract of op 23). */
export interface IceCandidateInitLike {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

/** The structural slice of RTCRtpSender the engine + publish caps use. */
export interface RtpSenderLike {
  replaceTrack(track: MediaTrackLike | null): Promise<void>;
  getParameters?(): unknown;
  setParameters?(params: unknown): Promise<void>;
}

/** The structural slice of RTCRtpTransceiver the manifest binding uses. */
export interface RtpTransceiverLike {
  mid: string | null;
  /** Settable local direction (post-answer mic upgrades declare sending). */
  direction?: string;
  sender: RtpSenderLike;
}

export interface PeerConnectionLike {
  addTrack(track: MediaTrackLike, stream: MediaStreamLike): unknown;
  setRemoteDescription(description: RtpDescriptionLike): Promise<void>;
  createAnswer(): Promise<RtpDescriptionLike>;
  setLocalDescription(description: RtpDescriptionLike): Promise<void>;
  addIceCandidate(candidate: IceCandidateInitLike): Promise<void>;
  close(): void;
  ontrack: ((event: { track: MediaTrackLike; transceiver?: { mid: string | null } }) => void) | null;
  onicecandidate:
    | ((event: { candidate: IceCandidateInitLike | null }) => void)
    | null;
  onconnectionstatechange: (() => void) | null;
  connectionState: string;
  /** KTD1 send-side binding: mid→transceiver after setRemoteDescription. */
  getTransceivers(): RtpTransceiverLike[];
  /** KTD7 ladder feed. */
  getStats(): Promise<StatsReportLike>;
}

/** A local-playback handle for one remote audio track (deafen target). */
export interface PlaybackHandle {
  setMuted(muted: boolean): void;
  stop(): void;
}

/** One playback leg: the handle plus what it is (monitor keys on mic only). */
interface PlaybackEntry {
  handle: PlaybackHandle;
  userId: string;
  source: 'mic' | 'screen_audio';
}

export interface RTCIceServerLike {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface MediaEnv {
  getUserMedia(constraints: { audio: boolean }): Promise<MediaStreamLike>;
  createPeerConnection(config: { iceServers: RTCIceServerLike[] }): PeerConnectionLike;
  createStream(tracks: MediaTrackLike[]): MediaStreamLike;
  attachAudio(stream: MediaStreamLike, playbackKey: string): PlaybackHandle;
}

/**
 * ICE config seam (per the unit brief): module-level, defaults to NO ICE
 * servers (host/loopback candidates only) — the engine's join path (U12)
 * refreshes it from GET /calls/ice (the eturnal TURN credentials minted
 * server-side) before creating each call's RTCPeerConnection.
 */
let iceServers: RTCIceServerLike[] = [];

/** Set the ICE server list used for every future RTCPeerConnection. */
export function configureIce(servers: RTCIceServerLike[]): void {
  iceServers = [...servers];
}

/** The current ICE servers (empty = loopback/host default). */
export function currentIceServers(): RTCIceServerLike[] {
  return [...iceServers];
}

// ---------------------------------------------------------------------------
// SDP helpers (pure)
// ---------------------------------------------------------------------------

/**
 * Enable Opus DTX on the send leg (R12): append `usedtx=1` to every Opus
 * fmtp line of an ANSWER before setLocalDescription.
 *
 * Mechanism (recorded per the plan's deferred question): SDP MUNGING, not
 * `RTCRtpSender.setParameters` — the WebRTC spec's send parameters expose
 * maxBitrate/maxFramerate and (in some engines) opus-specific fields, but
 * `usedtx` is NOT part of any standardized parameters surface, so
 * setParameters cannot express it cross-browser. Munging the answer's fmtp
 * is the one portable path. RISK (the plan's open question): some engines
 * — notably Safari/WebKit, relevant to the Tauri shell — ignore munged fmtp
 * or refuse DTX on the answering side; until per-target verification (U13
 * evidence), the no-DTX worst case in the plan's Risks stands as the
 * capacity bound.
 */
export function applyDtxToAnswerSdp(sdp: string): string {
  const sep = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(sep);

  // Opus payload types per m-section (a=rtpmap:<pt> opus/…).
  let mIndex = -1;
  const opusBySection = new Map<number, Set<string>>();
  for (const line of lines) {
    if (line.startsWith('m=')) {
      mIndex++;
      if (/^m=audio /.test(line)) opusBySection.set(mIndex, new Set());
    }
    const rtpmap = /^a=rtpmap:(\d+) opus\//.exec(line);
    if (rtpmap && opusBySection.get(mIndex)) {
      opusBySection.get(mIndex)!.add(rtpmap[1]!);
    }
  }

  // Walk the lines: extend existing opus fmtp lines in place; insert a bare
  // `usedtx=1` fmtp directly under an opus rtpmap whose section carries no
  // fmtp for that payload type (SDP orders rtpmap before fmtp, so a later
  // fmtp is found by sectionHasFmtpFor).
  const out: string[] = [];
  let section = -1;
  for (const line of lines) {
    if (line.startsWith('m=')) section++;
    const fmtp = /^a=fmtp:(\d+) (.*)$/.exec(line);
    if (fmtp) {
      const pt = fmtp[1]!;
      const params = fmtp[2]!;
      const isOpus = opusBySection.get(section)?.has(pt) === true;
      if (isOpus && !/\busedtx=1\b/.test(params)) {
        out.push(`a=fmtp:${pt} ${params.replace(/\s+$/, '')};usedtx=1`);
        continue;
      }
      out.push(line);
      continue;
    }
    out.push(line);
    const rtpmap = /^a=rtpmap:(\d+) opus\//.exec(line);
    if (rtpmap && opusBySection.get(section)?.has(rtpmap[1]!) === true) {
      const pt = rtpmap[1]!;
      if (!sectionHasFmtpFor(lines, section, pt)) {
        out.push(`a=fmtp:${pt} usedtx=1`);
      }
    }
  }

  return out.join(sep);
}

function sectionHasFmtpFor(lines: string[], section: number, pt: string): boolean {
  let s = -1;
  for (const line of lines) {
    if (line.startsWith('m=')) s++;
    if (s === section && new RegExp(`^a=fmtp:${pt} `).test(line)) return true;
    if (s > section) break;
  }
  return false;
}

/** One parsed audio m-line of an offer (V1 compat view over parseMlines). */
export interface AudioMlineInfo {
  mid: string | null;
  /** False when stopped/inactive (departed participant's retained slot). */
  active: boolean;
}

/**
 * Ordered audio m-lines of an SDP (mid + active flag). ATTRIBUTION IS NOT
 * DERIVED HERE — positions carry no meaning post-R5; the manifest owns
 * every mid→user decision.
 */
export function audioMlineInfo(sdp: string): AudioMlineInfo[] {
  return parseMlines(sdp)
    .filter((m) => m.kind === 'audio')
    .map((m) => ({ mid: m.mid, active: m.active }));
}

/**
 * Parse + normalize one server ICE body. Accepts the wire's camelCase keys
 * (`sdpMid`/`sdpMLineIndex` — what op 23 sends and media.ex pattern-matches)
 * and tolerates snake_case; ex_webrtc 0.17 emits hardcoded `"0"`/`0` values
 * which are passed through AS-IS (harmless under BUNDLE, per the unit
 * brief). Returns null on anything malformed (dropped silently — the room
 * re-offers on failure).
 */
export function normalizeIceBody(body: string): IceCandidateInitLike | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null) return null;
  const p = json as Record<string, unknown>;
  const candidate = p.candidate;
  if (typeof candidate !== 'string' || candidate.length === 0) return null;
  const sdpMid = p.sdpMid ?? p.sdp_mid;
  const mLine = p.sdpMLineIndex ?? p.sdp_mline_index;
  return {
    candidate,
    sdpMid: typeof sdpMid === 'string' ? sdpMid : null,
    sdpMLineIndex: typeof mLine === 'number' ? mLine : null,
  };
}

// ---------------------------------------------------------------------------
// Gateway seam (the structural slice the engine consumes)
// ---------------------------------------------------------------------------

export interface CallGatewayLike {
  readonly connectionState: string;
  sendCallState(payload: GatewayCallStateUpdatePayload): void;
  sendCallSignal(payload: GatewayCallSignalPayload): void;
  /**
   * Event subscription for the three call-control dispatches. The handler
   * parameter is `never` (contravariance bottom) so both the real
   * GatewayClient's generic `on<K>` and test fakes with per-event handlers
   * satisfy the seam without intersection gymnastics — callers always pass
   * a specifically-typed handler.
   */
  on(
    event: 'CallUpdate' | 'CallEnd' | 'CallSync',
    handler: (p: never) => void,
  ): () => void;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface CallEngineSnapshot {
  voice: VoiceState;
  channelId: string | null;
  /** Effective mute (explicit OR implied by deafen — AM12). */
  muted: boolean;
  deafened: boolean;
  /** VM5: the mic was denied and the leg degraded to listen-only. */
  listenOnly: boolean;
  /** Live published sources (capture held + intent on). */
  publishing: { camera: boolean; screen: boolean; screen_audio: boolean };
  /**
   * U5b wiring revision: bumps whenever a publish capture changes identity
   * (capture completes, VM13 replaceTrack switch) — the re-render trigger
   * for self-view/own-share local-track reads. Opaque by design; optional
   * so pre-V2 snapshot literals (tests) stay type-valid.
   */
  localVideoRev?: number;
}

export interface CallEngine {
  subscribe(listener: () => void): () => void;
  getSnapshot(): CallEngineSnapshot;
  speakingSubscribe(listener: () => void): () => void;
  getSpeaking(): ReadonlySet<string>;
  /** Video-track subscription (U5's tiles/stage) — key `${userId}:${source}`. */
  videoSubscribe(listener: () => void): () => void;
  getVideoTracks(): ReadonlyMap<string, MediaTrackLike>;
  /**
   * Receiver-want subscription (U5b wiring — budget announcements + the
   * receiver picker's value). Identity-stable between emissions.
   */
  wantSubscribe(listener: () => void): () => void;
  /** The current receiver want (tiles + max-quality), CEILING-clamped. */
  getVideoWant(): VideoWant;
  /** R9: the viewer's declared max-quality preference (the picker's value). */
  getReceiverMaxQuality(): VideoQualityPreference;
  /** Declare/replace the receiver ceiling; emits a want (2 s window applies). */
  setReceiverMaxQuality(pref: VideoQualityPreference): void;
  /** The source's current sender tier (U5b picker value source). */
  getPublishQuality(source: CallSourceKind): PublishQualityId;
  /**
   * The viewer's own held capture for self-view / staging their own share
   * (own m-lines never echo back through ontrack — the server forwards to
   * OTHERS). null when the source isn't held.
   */
  getLocalPublishTrack(source: 'camera' | 'screen'): MediaTrackLike | null;
  start(channelId: string, opts?: { ring?: boolean }): void;
  join(channelId: string): void;
  leave(): void;
  toggleMute(): void;
  toggleDeafen(): void;
  /** Ring-after-start (AM17): op-22 `state` with `ring`. */
  ring(): void;
  /** Dismiss a terminal state / notice → Idle. */
  dismiss(): void;
  /** Retry after VoiceUnavailable: dismiss + fresh join. */
  retry(): void;
  /** VM5: re-request the mic from the listen-only guidance surface. */
  retryMic(): void;
  /** Publish the camera (capture + op-22 publish; R1/R2). */
  publishCamera(quality?: 'low' | 'medium' | 'high'): void;
  /** Publish screen (+ share-audio when `audio` and the platform supply it). */
  publishScreen(opts?: { audio?: boolean; quality?: PublishQualityId }): void;
  /** VM13 window-switch affordance on a live share. */
  switchScreenSource(): void;
  /** Stop one published source (screen takes its share-audio along). */
  unpublishSource(source: CallSourceKind): void;
  /** Re-tier a live source (U5's quality picker). */
  setPublishQuality(source: CallSourceKind, quality: PublishQualityId): void;
  /** One connection-state probe (the poll body — public for tests). */
  pollConnectionState(): void;
  destroy(): void;
}

export interface CallEngineDeps {
  store?: StateStore;
  /** Capture/PC/playback seam; defaults to the unavailable fallback (platform.ts). */
  media?: MediaEnv;
  monitor?: SpeakingMonitor;
  /** Gateway accessor; defaults to none (a call join then drops, as documented). */
  gateway?: () => CallGatewayLike | null;
  /** CALL_SIGNAL subscription; defaults to this package's emitter seam. */
  onSignal?: (listener: (frame: { channel_id: string; body: string }) => void) => () => void;
  /** Connection poll interval; 0 disables (tests drive pollConnectionState). */
  pollMs?: number;
  /**
   * ICE config fetch (U12 GET /calls/ice); defaults to none — loopback/host
   * candidates only, the documented no-TURN deployment behavior. Hosts
   * inject their real fetch (apps/web: the session api).
   */
  fetchIceServers?: () => Promise<RTCIceServerLike[]>;
  /** How long the join waits on the ICE fetch before proceeding. */
  iceTimeoutMs?: number;
  /** Capture environment for the publish engine (tests inject fakes). */
  captureEnv?: CaptureEnv;
  /** Publish-op debounce (KTD3's 300 ms; 0 = immediate, tests). */
  publishDebounceMs?: number;
  /**
   * Adaptive budget factory (KTD7); receives the engine's stats feed and
   * want sink so tests can inject their own ladder. null disables;
   * undefined = the real ladder.
   */
  adaptiveBudget?: AdaptiveBudgetFactory | null;
}

/** The hooks the engine hands an injected budget (KTD7 wiring). */
export interface AdaptiveBudgetHooks {
  getStats: () => Promise<StatsReportLike>;
  onWant: (want: VideoWant) => void;
}

/** Builds (or declines to build) the engine's adaptive budget. */
export type AdaptiveBudgetFactory = (hooks: AdaptiveBudgetHooks) => AdaptiveBudgetHandle | null;

interface QueuedOffer {
  sdp: string;
  manifest: CallTrackManifest;
}

/** The dedicated video_want window's client half (KTD7: ~2 s, never exempt). */
const VIDEO_WANT_WINDOW_MS = 2_000;

/**
 * Bounded Reconnecting wait: entering Reconnecting (ice-failed recoverable /
 * gateway-resume) arms this; Connected or teardown clears it. A truly dead
 * leg — one whose server restart offer never arrives — must not park the
 * surface in Reconnecting forever (reconnect-timeout → VoiceUnavailable,
 * the existing Retry surface).
 */
const RECONNECT_TIMEOUT_MS = 15_000;

export function createCallEngine(deps: CallEngineDeps = {}): CallEngine {
  // Every platform-shaped default here is a host-neutral fallback
  // (platform.ts): a host injects the real one through CallEngineDeps —
  // apps/web's getCallEngine() does exactly that, so the SPA's behavior is
  // byte-for-byte what the pre-extraction browser defaults gave it.
  const store = deps.store ?? defaultStore;
  const media = deps.media ?? unavailableMediaEnv();
  const monitor = deps.monitor ?? new SpeakingMonitor();
  const gatewayFor = deps.gateway ?? (() => null);
  const onSignal = deps.onSignal ?? onCallSignal;
  const pollMs = deps.pollMs ?? 1_000;
  const fetchIceServers = deps.fetchIceServers ?? noIceServers;
  const iceTimeoutMs = deps.iceTimeoutMs ?? 2_000;

  // -- mutable runtime -------------------------------------------------------
  let voice: VoiceState = initialVoiceState();
  let channelId: string | null = null;
  let callId: string | null = null;
  let myLeg: string | null = null;
  let explicitMuted = false;
  let deafened = false;

  let pc: PeerConnectionLike | null = null;
  let micStream: MediaStreamLike | null = null;
  let micTrack: MediaTrackLike | null = null;
  /** True while the mic outcome is UNKNOWN (pumpOffers waits only then — a
   * denied mic is listen-only, not a negotiation blocker). */
  let micPending = false;
  /** Join generation: stale async continuations (gUM) abort on mismatch. */
  let generation = 0;

  let applyingOffer = false;
  let remoteSet = false;
  let iceRestartSpent = false;
  const offerQueue: QueuedOffer[] = [];
  const iceQueue: IceCandidateInitLike[] = [];

  /** The LAST applied offer's manifest — THE attribution source (R5). */
  let lastManifest: CallTrackManifest = emptyManifest();

  const pendingMidTracks = new Map<string, MediaTrackLike>();
  const playback = new Map<string, PlaybackEntry>();
  const videoTracks = new Map<string, MediaTrackLike>();
  let videoSnapshot: ReadonlyMap<string, MediaTrackLike> = videoTracks;
  const videoListeners = new Set<() => void>();

  // -- receiver want (U5b wiring: the budget surfaces read this) ---------------
  const wantListeners = new Set<() => void>();
  let receiverMaxQuality: VideoQualityPreference = 'high';
  let wantSnapshot: VideoWant = { tiles: LADDER_INITIAL_TILES, max_quality: 'high' };

  const unsubs: Array<() => void> = [];
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let resumeSignaled = false;
  let epochAtResumeSignal = 0;
  /** The bounded Reconnecting wait (RECONNECT_TIMEOUT_MS). */
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Revision of local publish captures (self-view re-render trigger). */
  let localVideoRev = 0;

  // -- publish engine (R1/R2/R4; mic excluded by design) -----------------------
  const publish: PublishEngine = createPublishEngine({
    env: deps.captureEnv,
    debounceMs: deps.publishDebounceMs,
    ops: {
      sendPublish: (source) => sendPublishOp(source, 'publish'),
      sendUnpublish: (source) => sendPublishOp(source, 'unpublish'),
      notifyShareEnded: () => dispatch({ type: 'share-ended' }),
      notifyShareUnavailable: () => dispatch({ type: 'share-unavailable' }),
      onChange: () => {
        localVideoRev += 1;
        notify();
      },
    },
  });

  function sendPublishOp(source: CallSourceKind, action: 'publish' | 'unpublish'): void {
    const ch = channelId;
    if (ch === null) return;
    try {
      gatewayFor()?.sendCallState({ channel_id: ch, action, source });
    } catch {
      // Offline mid-call: the reconnect's leg-confirmed flush re-publishes
      // (VM8) — the roster's source state rides CALL_SYNC repair.
    }
  }

  // -- adaptive budget (KTD7) ---------------------------------------------------
  let budget: AdaptiveBudgetHandle | null = null;
  let budgetStarted = false;
  if (deps.adaptiveBudget !== null) {
    const factory: AdaptiveBudgetFactory =
      deps.adaptiveBudget ?? ((hooks) => new AdaptiveBudget(hooks));
    budget = factory({
      getStats: () =>
        pc !== null ? pc.getStats() : Promise.resolve([] as StatsReportLike),
      onWant: (want) => enqueueVideoWant(want),
    });
  }
  let lastWantSentAt = 0;
  let queuedWant: VideoWant | null = null;
  let wantFlushTimer: ReturnType<typeof setTimeout> | null = null;

  /** Rank for ceiling-clamping (R9): high > medium > low. */
  function qualityRank(q: VideoQualityPreference): number {
    return q === 'high' ? 2 : q === 'medium' ? 1 : 0;
  }

  /** The ladder's want, clamped to the viewer's declared ceiling (R9). */
  function clampWant(want: VideoWant): VideoWant {
    const q = want.max_quality ?? 'high';
    return {
      tiles: want.tiles,
      max_quality: qualityRank(q) > qualityRank(receiverMaxQuality) ? receiverMaxQuality : q,
    };
  }

  function notifyWant(): void {
    for (const listener of [...wantListeners]) {
      try {
        listener();
      } catch {
        // a broken subscriber never breaks the engine
      }
    }
  }

  function wantSubscribe(listener: () => void): () => void {
    wantListeners.add(listener);
    return () => {
      wantListeners.delete(listener);
    };
  }

  /** The CURRENT want: the live ladder's, or the declared default sans budget. */
  function currentWant(): VideoWant {
    return clampWant(budget !== null ? budget.getWant() : {
      tiles: LADDER_INITIAL_TILES,
      max_quality: 'high',
    });
  }

  function getVideoWant(): VideoWant {
    return wantSnapshot;
  }

  function getReceiverMaxQuality(): VideoQualityPreference {
    return receiverMaxQuality;
  }

  function setReceiverMaxQuality(pref: VideoQualityPreference): void {
    receiverMaxQuality = pref;
    wantSnapshot = currentWant();
    notifyWant(); // the picker reflects the ceiling immediately…
    enqueueVideoWant(wantSnapshot); // …while the op keeps its 2 s window
  }

  function getPublishQualityOf(source: CallSourceKind): PublishQualityId {
    return publish.getQuality(source);
  }

  function getLocalPublishTrack(source: 'camera' | 'screen'): MediaTrackLike | null {
    return publish.localTrack(source);
  }

  /** Rate-limited op-22 `state` with `video_want` (dedicated ~2 s window). */
  function enqueueVideoWant(rawWant: VideoWant): void {
    const ch = channelId;
    if (ch === null) return;
    const want = clampWant(rawWant);
    wantSnapshot = want;
    notifyWant();
    const now = Date.now();
    if (now - lastWantSentAt >= VIDEO_WANT_WINDOW_MS) {
      lastWantSentAt = now;
      queuedWant = null;
      try {
        gatewayFor()?.sendCallState({ channel_id: ch, action: 'state', video_want: want });
      } catch {
        // Offline: the ladder's next change re-emits.
      }
      return;
    }
    // Inside the window: hold the latest want, flush when it opens.
    queuedWant = want;
    if (wantFlushTimer === null) {
      wantFlushTimer = setTimeout(() => {
        wantFlushTimer = null;
        const held = queuedWant;
        queuedWant = null;
        if (held) enqueueVideoWant(held);
      }, VIDEO_WANT_WINDOW_MS - (now - lastWantSentAt));
    }
  }

  let snapshot: CallEngineSnapshot = buildSnapshot();
  const listeners = new Set<() => void>();

  function buildSnapshot(): CallEngineSnapshot {
    return {
      voice,
      channelId,
      muted: explicitMuted || deafened,
      deafened,
      listenOnly: voice.micDenied,
      publishing: publish.getPublishing(),
      localVideoRev,
    };
  }

  function notify(): void {
    const next = buildSnapshot();
    if (
      next.voice === snapshot.voice &&
      next.channelId === snapshot.channelId &&
      next.muted === snapshot.muted &&
      next.deafened === snapshot.deafened &&
      next.listenOnly === snapshot.listenOnly &&
      next.publishing.camera === snapshot.publishing.camera &&
      next.publishing.screen === snapshot.publishing.screen &&
      next.publishing.screen_audio === snapshot.publishing.screen_audio &&
      next.localVideoRev === snapshot.localVideoRev
    ) {
      return;
    }
    snapshot = next;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // a broken subscriber never breaks the engine
      }
    }
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function notifyVideo(): void {
    // Fresh identity per change: videoTracks is MUTATED in place, so a
    // `snapshot === map` guard would never fire (the V2 WebKit walkthrough
    // found every video arrival invisible to React — useSyncExternalStore
    // needs a new reference to re-render).
    videoSnapshot = new Map(videoTracks);
    for (const listener of [...videoListeners]) {
      try {
        listener();
      } catch {
        // a broken subscriber never breaks the engine
      }
    }
  }

  function videoSubscribe(listener: () => void): () => void {
    videoListeners.add(listener);
    return () => {
      videoListeners.delete(listener);
    };
  }

  // -- machine ------------------------------------------------------------

  /** Arm the bounded Reconnecting wait (one timer per Reconnecting spell). */
  function armReconnectTimeout(): void {
    clearReconnectTimeout();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      dispatch({ type: 'reconnect-timeout' });
    }, RECONNECT_TIMEOUT_MS);
  }

  function clearReconnectTimeout(): void {
    if (reconnectTimer === null) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function dispatch(input: VoiceInput): void {
    const result = transition(voice, input);
    if (result.state === voice) return;
    const wasReconnecting = voice.status === 'reconnecting';
    const effectChannel = channelId; // effects may fire after the reset below
    voice = result.state;
    const status = voice.status;
    // The bounded wait covers exactly one Reconnecting spell: armed on
    // entry (ice-failed recoverable / gateway-resume), cleared the moment
    // the status leaves Reconnecting (Connected, teardown, eviction).
    if (status === 'reconnecting') {
      if (!wasReconnecting) armReconnectTimeout();
    } else {
      clearReconnectTimeout();
    }
    if (status === 'idle' || isTerminal(status)) {
      const keepChannel = status !== 'idle' || voice.notice !== null;
      // VM8: infrastructure teardowns (rejoin pending, ICE exhaustion with a
      // retry possibly following) PRESERVE held captures for the re-publish;
      // every user-intent exit stops them.
      const preservePublished =
        result.effects.some((e) => e.type === 'rejoin') || status === 'voice-unavailable';
      teardownMedia({ preservePublished });
      unsubAll();
      if (!keepChannel) channelId = null;
    }
    runEffects(result.effects, effectChannel);
    notify();
  }

  function runEffects(effects: VoiceEffect[], forChannel: string | null): void {
    for (const effect of effects) {
      if (effect.type === 'rejoin') rejoinAfterBackfill(forChannel);
    }
  }

  /**
   * AM4 re-join: the resume backfill showed our leg gone. Only when a live
   * call still exists on the channel (and we are truly absent from it) does
   * a fresh op-22 join make sense; otherwise Idle is the resting state.
   */
  function rejoinAfterBackfill(fromChannel: string | null): void {
    const ch = fromChannel;
    if (!ch) return;
    const state = store.getState();
    const me = state.currentUser?.id ?? null;
    const live = state.callByChannel[ch] ?? state.dmCallByChannel[ch];
    if (!live) return;
    if (me && live.participants[me]) return; // roster already repaired
    begin(ch, 'join');
  }

  // -- lifecycle -----------------------------------------------------------

  function start(channelIdArg: string, opts?: { ring?: boolean }): void {
    begin(channelIdArg, 'start', opts?.ring === true);
  }

  function join(channelIdArg: string): void {
    if (
      channelId === channelIdArg &&
      (voice.status !== 'idle' || voice.notice !== null)
    ) {
      // AM18: clicking while joined RETURNS, never re-joins.
      return;
    }
    begin(channelIdArg, 'join');
  }

  function begin(channelIdArg: string, action: 'start' | 'join', ring?: boolean): void {
    // A leg elsewhere? Tear it down first (one voice leg per client).
    if (channelId !== null && channelId !== channelIdArg && voice.status !== 'idle') {
      dispatch({ type: 'leave-intent' });
    }
    teardownMedia({ preservePublished: true }); // rejoin resets keep captures
    unsubAll();

    generation += 1;
    channelId = channelIdArg;
    callId = null;
    myLeg = null;
    explicitMuted = false;
    deafened = false;
    resumeSignaled = false;
    lastManifest = emptyManifest();
    lastWantSentAt = 0;
    wantSnapshot = currentWant(); // fresh leg, standing budget + ceiling

    dispatch({ type: 'join-intent' });

    const gateway = gatewayFor();
    if (!gateway) {
      // eslint-disable-next-line no-console
      console.warn('[call] no gateway session — call join dropped');
      dispatch({ type: 'leave-intent' });
      return;
    }
    try {
      gateway.sendCallState({
        channel_id: channelIdArg,
        action,
        ...(ring === true ? { ring: true } : {}),
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[call] control op failed', err);
      dispatch({ type: 'leave-intent' });
      return;
    }

    subscribeAll();
    monitor.start();
    configureIceThenCreatePc(generation);
    captureMic(generation);
    if (pollMs > 0) {
      pollTimer = setInterval(() => pollConnectionState(), pollMs);
    }
    notify();
  }

  /**
   * U12 ICE delivery: refresh the ICE config (minted TURN credentials,
   * GET /calls/ice) BEFORE creating the PC — a PC's iceServers are fixed
   * at creation. Signaling is unaffected (op 22 + queued offers/candidates
   * flow regardless; pumpOffers applies them once the PC exists). A failed
   * or timed-out fetch proceeds with whatever is configured — host/loopback
   * candidates, the documented no-TURN degradation — and a stale
   * continuation (leave/retry/displace bumped the generation) aborts.
   */
  function configureIceThenCreatePc(gen: number): void {
    void Promise.race([
      Promise.resolve()
        .then(() => fetchIceServers())
        .then(
          (servers) => servers,
          () => [] as RTCIceServerLike[],
        ),
      new Promise<RTCIceServerLike[]>((resolve) => {
        setTimeout(() => resolve([]), iceTimeoutMs);
      }),
    ]).then((servers) => {
      if (gen !== generation || channelId === null) return;
      if (servers.length > 0) configureIce(servers);
      createPc();
      void pumpOffers(); // offers queued while the PC was pending
    });
  }

  function leave(): void {
    const ch = channelId;
    if (ch) {
      try {
        gatewayFor()?.sendCallState({ channel_id: ch, action: 'leave' });
      } catch {
        // best-effort — the server's grace sweep covers a dropped leave
      }
    }
    dispatch({ type: 'leave-intent' });
    channelId = null;
    notify();
  }

  function dismiss(): void {
    dispatch({ type: 'dismiss' });
    notify();
  }

  function retry(): void {
    const ch = channelId;
    if (!ch || !isTerminal(voice.status)) return;
    begin(ch, 'join');
  }

  function retryMic(): void {
    if (channelId === null || !controlsAllowed()) return;
    if (micTrack !== null || micPending) return;
    captureMic(generation, true);
  }

  function destroy(): void {
    teardownMedia({ preservePublished: false });
    publish.destroy();
    budget?.stop();
    unsubAll();
    monitor.dispose();
    listeners.clear();
    videoListeners.clear();
    wantListeners.clear();
  }

  // -- subscriptions ---------------------------------------------------------

  function subscribeAll(): void {
    const gateway = gatewayFor();
    unsubs.push(
      onSignal((frame) => {
        if (frame.channel_id === channelId) handleSignalBody(frame.body);
      }),
    );
    if (gateway) {
      unsubs.push(gateway.on('CallUpdate', handleCallUpdate));
      unsubs.push(gateway.on('CallEnd', handleCallEnd));
      unsubs.push(gateway.on('CallSync', handleCallSync));
    }
    unsubs.push(
      store.subscribe(() => {
        // Boundary metadata only — attribution NEVER derives from the
        // roster (R5 retired the positional mirror); the manifest owns it.
        if (channelId === null) return;
        const call = store.getState().callByChannel[channelId] ?? store.getState().dmCallByChannel[channelId];
        if (call && callId === null) callId = call.call_id;
      }),
    );
  }

  function unsubAll(): void {
    for (const unsub of unsubs.splice(0)) {
      try {
        unsub();
      } catch {
        // a dying emitter never blocks teardown
      }
    }
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // -- control-plane events ---------------------------------------------------

  function handleCallUpdate(p: CallUpdate): void {
    if (channelId === null || p.channel_id !== channelId) return;
    const me = store.getState().currentUser?.id;
    if (me === null || me === undefined || p.user_id !== me) return;
    if (callId === null) callId = p.call_id;

    switch (p.state) {
      case 'joined': {
        if (myLeg === null) {
          myLeg = p.leg;
          dispatch({ type: 'session-confirmed' });
        } else if (p.leg !== myLeg) {
          // AM8: another device's join took the leg.
          dispatch({ type: 'displaced' });
          break;
        } else {
          dispatch({ type: 'session-confirmed' });
        }
        // Publish ops are participant-gated server-side: the leg's own
        // `joined` is the flush point for held captures (VM8 re-publish).
        publish.onLegConfirmed();
        break;
      }
      case 'displaced': {
        if (p.leg === myLeg) dispatch({ type: 'displaced' });
        break;
      }
      case 'forced_leave': {
        if (p.leg === myLeg || myLeg === null) dispatch({ type: 'forced-leave' });
        break;
      }
      case 'left': {
        // Our own echo of a deliberate leave is a no-op (already Idle); a
        // server-side removal (grace expiry, sweep) lands here as the first
        // signal — clean teardown, no notice (CALL_END owns call-over UX).
        if (p.leg === myLeg && voice.status !== 'idle') dispatch({ type: 'leave-intent' });
        break;
      }
      case 'camera_off':
      case 'screen_off':
      case 'screen_audio_off': {
        // KTD6: the ROOM unpublished one of our sources (rights revocation).
        // When the publish engine still holds it (WE didn't initiate), the
        // capture must retire to match — otherwise it keeps running (OS
        // camera light on, toggle lit, next click a no-op). Our own
        // unpublish's echo finds nothing held and skips.
        if (myLeg !== null && p.leg === myLeg) handleServerSourceOff(p.state);
        break;
      }
      default:
        break; // muted/unmuted/deafened/undeafened + *_on states — store owns display
    }
  }

  /** KTD6: retire a still-held source the room just unpublished. */
  function handleServerSourceOff(
    state: 'camera_off' | 'screen_off' | 'screen_audio_off',
  ): void {
    const publishing = publish.getPublishing();
    if (state === 'camera_off') {
      if (!publishing.camera) return;
      publish.serverRetire('camera');
      dispatch({ type: 'source-revoked', source: 'camera' });
    } else if (state === 'screen_off') {
      if (!publishing.screen) return;
      publish.serverRetire('screen'); // takes share-audio along, as everywhere
      dispatch({ type: 'source-revoked', source: 'screen' });
    } else {
      // Audio-only revocation: the share's video keeps running — retire the
      // audio source silently (same shape as a native screenAudioEnded).
      if (!publishing.screen_audio) return;
      publish.serverRetire('screen_audio');
    }
    notify();
  }

  function handleCallEnd(p: CallEnd): void {
    if (channelId === null || p.channel_id !== channelId) return;
    if (callId !== null && p.call_id !== callId) return;
    if (voice.status === 'idle') return;
    dispatch({ type: 'leave-intent' });
  }

  function handleCallSync(p: CallSync): void {
    if (channelId === null) return;
    if (!(voice.status === 'reconnecting' || voice.status === 'connected')) return;
    const me = store.getState().currentUser?.id ?? null;
    const entry =
      p.calls.find((c) => c.channel_id === channelId) ??
      p.dm_calls.find((c) => c.channel_id === channelId);
    const present = entry?.participants.some((x) => x.user_id === me) === true;
    if (present) {
      dispatch({ type: 'backfill-ok' });
    } else {
      // Absent leg (or absent call): re-join attempt then Idle (AM4). Also
      // the defensive connected-but-absent case (a leg drop we missed).
      dispatch({ type: 'backfill-self-absent' });
    }
  }

  // -- gateway connection poll (Reconnecting / Offline inputs) ----------------

  function pollConnectionState(): void {
    const gateway = gatewayFor();
    if (!gateway) return;
    const cs = gateway.connectionState;
    const liveConn = cs === 'connected' || cs === 'ready';
    if (!liveConn) {
      if (!resumeSignaled && voice.status !== 'idle' && !isTerminal(voice.status)) {
        resumeSignaled = true;
        epochAtResumeSignal = store.getState().sessionEpoch;
        dispatch({ type: 'gateway-resume' });
      }
      return;
    }
    if (resumeSignaled) {
      resumeSignaled = false;
      if (store.getState().sessionEpoch > epochAtResumeSignal) {
        // The "resume" degraded into a fresh Identify — the stored session
        // (and our leg with it) was purged server-side (AM4).
        dispatch({ type: 'gateway-invalid' });
      }
      // Else: a real Resume — handleCallSync resolves backfill-ok/absent.
    }
  }

  // -- media -------------------------------------------------------------------

  function createPc(): void {
    const ch = channelId;
    if (ch === null) return;
    const gateway = gatewayFor();
    pc = media.createPeerConnection({ iceServers: currentIceServers() });
    pc.onicecandidate = (event) => {
      const candidate = event.candidate;
      if (candidate === null || ch === null) return; // end-of-candidates
      try {
        gateway?.sendCallSignal({
          channel_id: ch,
          kind: 'ice',
          body: JSON.stringify({
            candidate: candidate.candidate,
            sdpMid: candidate.sdpMid ?? null,
            sdpMLineIndex: candidate.sdpMLineIndex ?? null,
          }),
        });
      } catch {
        // Offline: candidates re-gather behind the reconnect's restart offer
      }
    };
    pc.onconnectionstatechange = () => {
      const state = pc?.connectionState;
      if (state === 'connected') {
        dispatch({ type: 'pc-connected' });
      } else if (state === 'failed') {
        if (!iceRestartSpent) {
          // One restart (the server pushes an ice_restart offer — media.ex
          // handles its side; we apply it as any other offer).
          iceRestartSpent = true;
          dispatch({ type: 'ice-failed', recoverable: true });
        } else {
          dispatch({ type: 'ice-failed', recoverable: false });
        }
      }
      // 'disconnected' is transient (ICE may recover on its own); 'failed'
      // is the terminal signal the policy keys on.
    };
    pc.ontrack = (event) => {
      const mid = event.transceiver?.mid ?? null;
      if (mid !== null) {
        routeRemoteTrack(mid, event.track);
        return;
      }
      // WebKit fires ontrack BEFORE committing transceiver.mid (Chrome
      // assigns it first — the V2 WebKit walkthrough found every remote
      // track silently dropped here). Re-read on later tasks instead of
      // dropping; the mid is committed by answer time at the latest.
      const transceiver = event.transceiver;
      const track = event.track;
      if (transceiver === undefined) return;
      const retry = (delayMs: number) => {
        setTimeout(() => {
          const m = transceiver.mid;
          if (m !== null) routeRemoteTrack(m, track);
          else if (delayMs < 1000) retry(delayMs * 4);
        }, delayMs);
      };
      retry(0);
    };
    if (budget !== null && !budgetStarted) {
      budget.start();
      budgetStarted = true;
    }
  }

  /**
   * VM5 retryMic's wire half: tell the room the mic is granted so it
   * RE-OFFERS this leg's mic m-line (send direction) — the local
   * replaceTrack + sendonly binding alone can never force a re-offer (the
   * server is the sole offerer).
   */
  function sendMicGranted(): void {
    const ch = channelId;
    if (ch === null) return;
    try {
      gatewayFor()?.sendCallState({ channel_id: ch, action: 'state', mic_granted: true });
    } catch {
      // Offline: the reconnect's backfill re-syncs the leg's mic state.
    }
  }

  function captureMic(gen: number, announceGrant = false): void {
    micPending = true;
    media
      .getUserMedia({ audio: true })
      .then((stream) => {
        if (gen !== generation) {
          for (const track of stream.getAudioTracks()) track.stop();
          return;
        }
        micStream = stream;
        micTrack = stream.getAudioTracks()[0] ?? null;
        micPending = false;
        // Self-level monitor (user-directed 2026-09-07): attach the LOCAL
        // mic so the speaking set carries MY id while Cytale is hearing me
        // — the user panel's mic status keys off it. Mute honesty is free:
        // a disabled track renders silence through the WebAudio graph, and
        // teardown's detachAll covers every leave path.
        const me = store.getState().currentUser?.id ?? null;
        if (me !== null) monitor.attach(me, stream);
        if (announceGrant) sendMicGranted(); // only on the retryMic path — a fresh join's op-22 already carries the mic
        dispatch({ type: 'mic-granted' });
        if (micTrack !== null && pc !== null && lastManifest.size > 0) {
          // The offer was already answered listen-only: bind now for the
          // next negotiation (the answerer cannot force a re-offer — any
          // roster change's offer carries the send direction).
          void bindMicAfterAnswer().then(() => pumpOffers());
        } else {
          void pumpOffers();
        }
        applyLocalVoiceFlags(); // restore mute/deafen on a fresh track
      })
      .catch(() => {
        if (gen !== generation) return;
        micPending = false;
        // VM5: NotAllowedError (browser/OS denial) and device errors alike
        // DEGRADE the leg to listen-only — it survives, guidance surfaces,
        // retryMic() upgrades on a later grant.
        dispatch({ type: 'mic-denied' });
        void pumpOffers(); // listen-only: offers proceed without the mic
      });
  }

  /**
   * KTD1 send-side binding: attach every own track (mic + published
   * sources) to the offer's ingest m-lines BY MANIFEST MID, pre-answer.
   * Same-kind sources (mic/share-audio; camera/screen) can never swap —
   * the manifest names each mid's (user, source) exactly.
   */
  async function bindOwnTracksByManifest(manifest: CallTrackManifest): Promise<void> {
    const me = store.getState().currentUser?.id ?? null;
    if (me === null || pc === null) return;
    const transceivers = pc.getTransceivers();
    const byMid = new Map<string, RtpTransceiverLike>();
    for (const t of transceivers) {
      if (t.mid !== null) byMid.set(t.mid, t);
    }
    const bindings: Array<Promise<void>> = [];
    for (const { mid, source } of ownEntries(manifest, me)) {
      const transceiver = byMid.get(mid);
      if (transceiver === undefined) continue; // mid not in this PC — server/SDP drift, next offer repairs
      const track =
        source === 'mic' ? micTrack : publish.localTrack(source);
      if (track === null || track === undefined) continue; // not held (listen-only / unpublished)
      // Declare the send direction BEFORE createAnswer: the server's ingest
      // m-lines are offered recvonly, and WebKit answers `inactive` (and
      // then rejects the follow-up renegotiation outright) when the
      // transceiver still says recvonly at answer time — Chrome tolerated
      // the missing flip, which is why the Chrome-only spike never caught
      // it. Same declaration as bindMicAfterAnswer below. (Found live in
      // the V2 WebKit walkthrough, 2026-09-07.)
      if (transceiver.direction !== 'sendonly') transceiver.direction = 'sendonly';
      bindings.push(
        transceiver.sender
          .replaceTrack(track)
          .then(() => {
            publish.onTrackBound(source, transceiver.sender);
          })
          .catch(() => {
            // Binding refused (engine state race): the source stays held;
            // its roster re-offer re-attempts the binding.
          }),
      );
    }
    await Promise.all(bindings);
  }

  /**
   * VM5 upgrade: mic granted after the leg answered listen-only. Binds by
   * manifest mid and declares the send direction so the NEXT answer
   * carries it (the server is the sole offerer — its roster-driven
   * re-offer completes the upgrade).
   */
  async function bindMicAfterAnswer(): Promise<void> {
    const me = store.getState().currentUser?.id ?? null;
    if (me === null || pc === null || micTrack === null) return;
    for (const { mid, source } of ownEntries(lastManifest, me)) {
      if (source !== 'mic') continue;
      for (const transceiver of pc.getTransceivers()) {
        if (transceiver.mid === mid) {
          transceiver.direction = 'sendonly'; // next answer declares sending
          await transceiver.sender.replaceTrack(micTrack).catch(() => undefined);
          return;
        }
      }
    }
  }

  function teardownMedia(opts?: { preservePublished?: boolean }): void {
    generation += 1;
    clearReconnectTimeout();
    if (pc) {
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      pc.ontrack = null;
      try {
        pc.close();
      } catch {
        // already closed
      }
      pc = null;
    }
    if (budgetStarted) {
      budget?.stop();
      budgetStarted = false;
    }
    if (wantFlushTimer !== null) {
      clearTimeout(wantFlushTimer);
      wantFlushTimer = null;
      queuedWant = null;
    }
    if (micStream) {
      for (const track of micStream.getAudioTracks()) track.stop();
      micStream = null;
    }
    micTrack = null;
    micPending = false;
    applyingOffer = false;
    remoteSet = false;
    iceRestartSpent = false;
    offerQueue.length = 0;
    iceQueue.length = 0;
    lastManifest = emptyManifest();
    pendingMidTracks.clear();
    for (const entry of playback.values()) entry.handle.stop();
    playback.clear();
    videoTracks.clear();
    notifyVideo();
    monitor.detachAll();
    if (opts?.preservePublished === true) {
      publish.onLegReset(); // held captures survive for the VM8 re-publish
    } else {
      publish.stopAll();
    }
  }

  // -- signaling ----------------------------------------------------------------

  function handleSignalBody(body: string): void {
    const offer = parseCallOffer(body);
    if (offer !== null) {
      offerQueue.push({ sdp: offer.sdp, manifest: offer.manifest });
      void pumpOffers();
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return; // malformed relay — dropped, the room re-offers on failure
    }
    if (typeof json === 'object' && json !== null) {
      const p = json as Record<string, unknown>;
      if (p.type === 'answer') {
        return; // The server is the sole offerer (U5) — we never receive these.
      }
    }
    const ice = normalizeIceBody(body);
    if (ice) {
      if (!remoteSet || !pc) {
        iceQueue.push(ice); // candidates racing the remote description
        return;
      }
      void pc.addIceCandidate(ice).catch(() => {
        // Dropped (duplicate / mid mismatch) — never fatal; re-offers cover
      });
    }
  }

  function flushIceQueue(): void {
    const queued = iceQueue.splice(0);
    for (const candidate of queued) {
      if (!pc) break;
      void pc.addIceCandidate(candidate).catch(() => undefined);
    }
  }

  /**
   * Apply queued server offers strictly one-at-a-time (glare defer rule).
   * Waiting on the mic only lasts while its outcome is UNKNOWN — a denied
   * mic is listen-only (VM5), never a negotiation blocker. Own tracks bind
   * by manifest mid BEFORE the answer exists (the answerer cannot add
   * m-lines later without a fresh offer).
   */
  async function pumpOffers(): Promise<void> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (applyingOffer || offerQueue.length === 0) return;
      if (micPending) return; // mic outcome unknown (or denied → listen-only proceeds)
      const ch = channelId;
      // Guards BEFORE the shift: an offer taken off the queue while the PC
      // (or channel) is still pending would be dropped on the floor — it
      // must stay queued until createPc's continuation pumps it.
      if (!ch || !pc) return;
      const offer = offerQueue.shift()!;
      applyingOffer = true;
      try {
        await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
        await bindOwnTracksByManifest(offer.manifest);
        remoteSet = true;
        flushIceQueue();
        const answer = await pc.createAnswer();
        const sdp = applyDtxToAnswerSdp(answer.sdp);
        await pc.setLocalDescription({ type: 'answer', sdp });
        // Sender caps re-apply: encodings materialize only once the answer
        // commits — a bind-time applySenderCaps over EMPTY encodings is a
        // no-op, leaving the top layer uncapped until unrelated churn.
        // Idempotent by construction (same preset, same sender).
        publish.reapplySenderCaps();
        lastManifest = offer.manifest;
        applyManifestAttribution(offer.manifest);
        // Answers keep the V1 shape (KTD1): no envelope, no manifest — the
        // room built the topology.
        gatewayFor()?.sendCallSignal({
          channel_id: ch,
          kind: 'sdp',
          body: JSON.stringify({ type: 'answer', sdp }),
        });
      } catch {
        // Broken negotiation: drop the offer; the room's next roster change
        // re-offers. (A lost answer never wedges the queue.)
      } finally {
        applyingOffer = false;
      }
    }
  }

  // -- remote attribution + playback (manifest-keyed, R5) ------------------------

  /** Route one inbound track by manifest mid; unattributed mids queue. */
  function routeRemoteTrack(mid: string, track: MediaTrackLike): void {
    const attr = lastManifest.get(mid);
    if (attr === undefined) {
      // Tolerance (KTD1): never guessed — waits for an attributing offer.
      pendingMidTracks.set(mid, track);
      return;
    }
    if (isAudioSource(attr.source)) {
      attachRemoteAudio(attr.userId, attr.source, track);
    } else {
      setVideoTrack(attr.userId, attr.source, track);
    }
  }

  /**
   * Receive-side attribution pass after each applied offer: stop playback
   * and drop video entries whose (user, source) left the manifest, then
   * drain tracks that arrived before their attribution existed.
   */
  function applyManifestAttribution(manifest: CallTrackManifest): void {
    const audioKeys = new Set<string>();
    const videoKeys = new Set<string>();
    for (const attr of manifest.values()) {
      const key = trackKey(attr.userId, attr.source);
      if (isAudioSource(attr.source)) audioKeys.add(key);
      else videoKeys.add(key);
    }
    for (const [key, entry] of [...playback]) {
      if (!audioKeys.has(key)) {
        entry.handle.stop();
        playback.delete(key);
        if (entry.source === 'mic') monitor.detach(entry.userId); // VM11: mic-only
      }
    }
    if (videoTracks.size > 0) {
      let pruned = false;
      for (const key of [...videoTracks.keys()]) {
        if (!videoKeys.has(key)) {
          videoTracks.delete(key);
          pruned = true;
        }
      }
      if (pruned) notifyVideo();
    }
    for (const [mid, track] of [...pendingMidTracks]) {
      const attr = manifest.get(mid);
      if (attr !== undefined) {
        pendingMidTracks.delete(mid);
        if (isAudioSource(attr.source)) attachRemoteAudio(attr.userId, attr.source, track);
        else setVideoTrack(attr.userId, attr.source, track);
      }
    }
  }

  function attachRemoteAudio(
    userId: string,
    source: 'mic' | 'screen_audio',
    track: MediaTrackLike,
  ): void {
    const key = trackKey(userId, source);
    const stale = playback.get(key);
    if (stale) {
      // Leave+rejoin (or a re-offer handing the user a fresh leg): stop the
      // stale handle and attach the new track — one LIVE audio leg per
      // (user, source).
      stale.handle.stop();
      playback.delete(key);
      if (source === 'mic') monitor.detach(userId);
    }
    const stream = media.createStream([track]);
    const handle = media.attachAudio(stream, key);
    handle.setMuted(deafened);
    playback.set(key, { handle, userId, source });
    if (source === 'mic') {
      // VM11: speaking indicators stay mic-only — share-audio never drives them.
      monitor.attach(userId, stream);
    }
  }

  function setVideoTrack(
    userId: string,
    source: 'camera' | 'screen',
    track: MediaTrackLike,
  ): void {
    const key = trackKey(userId, source);
    if (videoTracks.get(key) === track) return;
    videoTracks.set(key, track);
    notifyVideo();
  }

  // -- mute / deafen / ring ---------------------------------------------------------

  function applyLocalVoiceFlags(): void {
    const effectiveMute = explicitMuted || deafened;
    if (micTrack) micTrack.enabled = !effectiveMute;
    // R15: deafen mutes mic + share-audio playback; video keeps rendering.
    for (const entry of playback.values()) entry.handle.setMuted(deafened);
  }

  function pushVoiceFlags(): void {
    const ch = channelId;
    if (ch === null) return;
    try {
      gatewayFor()?.sendCallState({
        channel_id: ch,
        action: 'state',
        // Both flags ALWAYS carried: an omitted `deafen` means "unchanged"
        // server-side, so un-deafen/unmute must send an explicit false.
        mute: explicitMuted || deafened,
        deafen: deafened,
      });
    } catch {
      // Offline mid-call: local flags applied; the reconnect re-syncs state
    }
  }

  function toggleMute(): void {
    if (channelId === null || !controlsAllowed()) return;
    explicitMuted = !explicitMuted;
    applyLocalVoiceFlags();
    pushVoiceFlags();
    notify();
  }

  function toggleDeafen(): void {
    if (channelId === null || !controlsAllowed()) return;
    deafened = !deafened;
    applyLocalVoiceFlags();
    pushVoiceFlags();
    notify();
  }

  function ring(): void {
    const ch = channelId;
    if (ch === null || voice.status !== 'connected') return;
    try {
      // AM17 ring-after-start: op-22 `state` carries the ring flag.
      gatewayFor()?.sendCallState({ channel_id: ch, action: 'state', ring: true });
    } catch {
      // best-effort summon
    }
  }

  function controlsAllowed(): boolean {
    return voice.status === 'connected' || voice.status === 'reconnecting';
  }

  // -- publish surface (delegates to the capture engine) ---------------------------

  function publishCamera(quality?: 'low' | 'medium' | 'high'): void {
    if (channelId === null) return;
    publish.publishCamera(quality);
  }

  function publishScreen(opts?: { audio?: boolean; quality?: PublishQualityId }): void {
    if (channelId === null) return;
    publish.publishScreen(opts);
  }

  function switchScreenSource(): void {
    publish.switchScreenSource();
  }

  function unpublishSource(source: CallSourceKind): void {
    publish.unpublish(source);
  }

  function setPublishQuality(source: CallSourceKind, quality: PublishQualityId): void {
    publish.setQuality(source, quality);
  }

  // -- surface ----------------------------------------------------------------------

  return {
    subscribe,
    getSnapshot: () => snapshot,
    speakingSubscribe: (listener: () => void) => monitor.subscribe(listener),
    getSpeaking: () => monitor.getSpeaking(),
    videoSubscribe,
    getVideoTracks: () => videoSnapshot,
    wantSubscribe,
    getVideoWant,
    getReceiverMaxQuality,
    setReceiverMaxQuality,
    getPublishQuality: getPublishQualityOf,
    getLocalPublishTrack,
    start,
    join,
    leave,
    toggleMute,
    toggleDeafen,
    ring,
    dismiss,
    retry,
    retryMic,
    publishCamera,
    publishScreen,
    switchScreenSource,
    unpublishSource,
    setPublishQuality,
    pollConnectionState,
    destroy,
  };
}
