/**
 * @cytale/calls — the publish engine (calls V2 plan U4, R1/R2/R4/VM8/VM9/VM12/VM13).
 *
 * Capture + publish lifecycle for every non-mic source: camera
 * (getUserMedia), screen video + optional share-audio (getDisplayMedia).
 * The mic is NOT a source (it is the V1 call itself) — but its send-side
 * binding shares the manifest path in useCallMedia (KTD1).
 *
 * Design shape (mirrors the V1 engine's injectable-seam doctrine):
 *
 *   - ALL native-stop paths converge on ONE unpublish: every captured track
 *     wires `onended` — the browser's stop-sharing bar, a closed shared
 *     window, and OS-level permission revocation all fire it — and the
 *     handler drops the source through the same `retireSource()` path a
 *     user toggle uses (R4: the roster never claims a dead track).
 *   - Publish/unpublish ride op-22 (throttle-exempt actions server-side)
 *     with the ratified 300 ms client debounce per source.
 *   - Quality caps (R2, Discord-style per source): capture CONSTRAINTS at
 *     gUM time plus SENDER CAPS after manifest binding. GO-simulcast branch
 *     (the spike's recorded branch): the server's rid-munged offers give the
 *     remote-offered transceivers f/h/q encodings, and the publisher's
 *     chosen quality sets the TOP encoding with derived mid/low layers;
 *     absent rid encodings (single stream), the same tier is the single
 *     encoding's cap.
 *   - `contentHint` per VM12: `detail` for screens, `motion` for camera.
 *   - Window-switch while sharing uses `replaceTrack` on the bound sender —
 *     no renegotiation storm (VM13) — falling back to unpublish+publish
 *     where the browser refuses.
 *   - Re-publish policy (VM8): tracks OUTLIVE a leg reset (they are local
 *     captures; only user-intent teardowns stop them). After a rejoin the
 *     still-held camera re-publishes automatically on leg confirmation;
 *     ENDED screen tracks never restart capture — they surface the
 *     share-ended notice instead.
 *
 * The engine (useCallMedia) owns the PC and the wire; this module never
 * touches signaling directly — it asks `ops` to send and gets told when a
 * sender is bound (`onTrackBound` — sender caps apply there).
 */

import type { CallManifestSource, CallSourceKind } from '@cytale/protocol';

import { unavailableCaptureEnv } from './platform.js';
import type { MediaStreamLike, MediaTrackLike, RtpSenderLike } from './useCallMedia.js';

// ---------------------------------------------------------------------------
// Quality tiers (R2 — publisher-picked caps per source; VM2 GO-branch sender
// shape: the tier is the f/top encoding, mid/low derive by fraction)
// ---------------------------------------------------------------------------

/** Publisher-facing quality ids (the U5 picker's vocabulary). */
export type PublishQualityId = 'low' | 'medium' | 'high' | 'source';

/** One tier's caps (constraints at capture; bitrate caps at the sender). */
export interface QualityPreset {
  /** Ideal capture width (absent = uncapped — the `source` tier). */
  width?: number;
  height?: number;
  frameRate?: number;
  /** Top (f) encoding max bitrate, kbps. */
  maxBitrateKbps?: number;
}

/** Camera tiers (motion — VM12). */
export const CAMERA_QUALITY_PRESETS: Record<'low' | 'medium' | 'high', QualityPreset> = {
  low: { width: 426, height: 240, frameRate: 15, maxBitrateKbps: 250 },
  medium: { width: 640, height: 360, frameRate: 30, maxBitrateKbps: 700 },
  high: { width: 1280, height: 720, frameRate: 30, maxBitrateKbps: 1800 },
};

/** Screen tiers (detail — VM12; `source` = uncapped). */
export const SCREEN_QUALITY_PRESETS: Record<PublishQualityId, QualityPreset> = {
  low: { width: 1280, height: 720, frameRate: 15, maxBitrateKbps: 1000 },
  medium: { width: 1920, height: 1080, frameRate: 15, maxBitrateKbps: 2500 },
  high: { width: 1920, height: 1080, frameRate: 30, maxBitrateKbps: 4000 },
  source: {},
};

/** Default tiers (camera high; screen 1080p15 — VM2's recorded default shape). */
export const DEFAULT_CAMERA_QUALITY: 'low' | 'medium' | 'high' = 'high';
export const DEFAULT_SCREEN_QUALITY: PublishQualityId = 'medium';

/** Simulcast layer fractions of the top encoding (f=1; h≈40%; q≈15%). */
export const SIMULCAST_LAYER_BITRATE_FRACTIONS = { f: 1, h: 0.4, q: 0.15 } as const;
/** scaleResolutionDownBy per layer (the spike's measured 1/2/4 tuning). */
export const SIMULCAST_LAYER_SCALES = { f: 1, h: 2, q: 4 } as const;
/** Hard floors so tiny tops never produce unusable low layers (kbps). */
export const SIMULCAST_LAYER_BITRATE_FLOORS_KBPS = { f: 0, h: 150, q: 80 } as const;

/** The structural slice of RTCRtpSendParameters the caps writer touches. */
export interface RtpSendParamsLike {
  encodings?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

/**
 * Apply the tier's SENDER caps to a bound sender (after replaceTrack).
 *
 * Multi-encoding senders (the GO branch's rid-munged ingest m-lines carry
 * f/h/q) get per-layer caps keyed by each encoding's `rid`; a single
 * encoding gets the tier as-is. Best-effort by design: browsers without
 * get/setParameters (or with read-only surfaces) degrade to the capture
 * constraints — never a failed publish.
 */
export async function applySenderCaps(
  sender: RtpSenderLike,
  preset: QualityPreset,
): Promise<void> {
  if (typeof sender.getParameters !== 'function' || typeof sender.setParameters !== 'function') {
    return;
  }
  let params: RtpSendParamsLike;
  try {
    params = sender.getParameters() as RtpSendParamsLike;
  } catch {
    return;
  }
  if (typeof params !== 'object' || params === null || !Array.isArray(params.encodings)) return;
  const encodings = params.encodings;
  if (encodings.length > 1) {
    for (const encoding of encodings) {
      const rid = typeof encoding['rid'] === 'string' ? (encoding['rid'] as string) : null;
      const layer = rid !== null && rid in SIMULCAST_LAYER_BITRATE_FRACTIONS ? rid : 'f';
      const top = preset.maxBitrateKbps;
      if (top !== undefined) {
        const floor = SIMULCAST_LAYER_BITRATE_FLOORS_KBPS[layer as keyof typeof SIMULCAST_LAYER_BITRATE_FLOORS_KBPS];
        encoding['maxBitrate'] = Math.max(floor, Math.round(top * SIMULCAST_LAYER_BITRATE_FRACTIONS[layer as keyof typeof SIMULCAST_LAYER_BITRATE_FRACTIONS])) * 1000;
      }
      // Layer geometry (not bitrate): the 1/2/4 ladder stands even for the
      // uncapped `source` tier on a simulcast m-line.
      encoding['scaleResolutionDownBy'] = SIMULCAST_LAYER_SCALES[layer as keyof typeof SIMULCAST_LAYER_SCALES];
    }
  } else if (encodings.length === 1) {
    // Single stream: the tier IS the stream — an empty preset (`source`)
    // caps nothing at all.
    const encoding = encodings[0]!;
    if (preset.maxBitrateKbps !== undefined) {
      encoding['maxBitrate'] = preset.maxBitrateKbps * 1000;
    }
    if (preset.frameRate !== undefined) {
      encoding['maxFramerate'] = preset.frameRate;
    }
    if (preset.maxBitrateKbps !== undefined || preset.frameRate !== undefined) {
      encoding['scaleResolutionDownBy'] = 1;
    }
  }
  try {
    await sender.setParameters(params as never);
  } catch {
    // Engine refusal (e.g. mid-answer parameter race) — caps retry on the
    // next binding; the stream itself is unaffected.
  }
}

// ---------------------------------------------------------------------------
// Capture environment (injectable seam — jsdom has no media devices)
// ---------------------------------------------------------------------------

export interface CaptureConstraints {
  video?: boolean | Record<string, unknown>;
  audio?: boolean | Record<string, unknown>;
}

export interface CaptureEnv {
  getUserMedia(constraints: CaptureConstraints): Promise<MediaStreamLike>;
  getDisplayMedia(constraints: CaptureConstraints): Promise<MediaStreamLike>;
}

// The real capture environment (navigator.mediaDevices) is the HOST's, not
// this package's: apps/web supplies `browserCaptureEnv()` (browserEnv.ts),
// apps/mobile `rnCaptureEnv()`. Absent an injection the fallback throws
// (platform.ts).

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/** Wire ops the publish engine asks its owner (the media engine) to run. */
export interface PublishEngineOps {
  /** Send op-22 publish (already debounced here; engine adds the channel). */
  sendPublish(source: CallSourceKind): void;
  /** Send op-22 unpublish (debounced here). */
  sendUnpublish(source: CallSourceKind): void;
  /** VM8: an ended screen share surfaces its notice (voiceState input). */
  notifyShareEnded(): void;
  /**
   * F5: screen capture cannot run in this host (NotSupportedError et al.)
   * and the user asked to share — surfaces the share-unavailable notice
   * (voiceState input). User CANCELS of the picker never reach this op.
   */
  notifyShareUnavailable(): void;
  /** Publishing state changed — the engine re-snapshots. */
  onChange(): void;
}

/** Narrow timer contracts for the op debounce (node/dom neutral). */
type SetTimeoutFn = (fn: () => void, ms: number) => unknown;
type ClearTimeoutFn = (id: unknown) => void;

export interface PublishEngineDeps {
  ops: PublishEngineOps;
  env?: CaptureEnv;
  /** Debounce window (KTD3's client-side 300 ms; 0 = immediate, tests). */
  debounceMs?: number;
  setTimeoutFn?: SetTimeoutFn;
  clearTimeoutFn?: ClearTimeoutFn;
}

export interface PublishingState {
  camera: boolean;
  screen: boolean;
  screen_audio: boolean;
}

export interface PublishEngine {
  /** Start (or re-tier) the camera. No-op while a capture is in flight. */
  publishCamera(quality?: 'low' | 'medium' | 'high'): void;
  /**
   * Start a screen share; `audio: true` ALSO publishes share-audio when the
   * platform returns an audio track (VM9 — offered where supported, absent
   * otherwise). Called while ALREADY sharing, this is the VM13 window
   * switch: a fresh capture replaces the track on the bound sender without
   * new publish ops, falling back to unpublish+publish.
   */
  publishScreen(opts?: { audio?: boolean; quality?: PublishQualityId }): void;
  /** Re-run the screen picker for the SAME share (VM13 switch affordance). */
  switchScreenSource(): void;
  /** Stop one source (user toggle) — screen takes its share-audio along. */
  unpublish(source: CallSourceKind): void;
  /**
   * KTD6: the ROOM unpublished this source (rights revocation) — retire the
   * capture to match WITHOUT an echo op (the server already knows; a pending
   * debounced op for the source is cancelled, not sent). Screen takes its
   * share-audio along, exactly like the user path.
   */
  serverRetire(source: CallSourceKind): void;
  /**
   * Re-apply sender caps to every BOUND own source — run after an answer
   * commits: encodings materialize only then, so a bind-time
   * applySenderCaps over empty encodings no-opped (idempotent by design).
   */
  reapplySenderCaps(): void;
  /** Re-tier a live source (U5's picker): constraints + sender caps. */
  setQuality(source: CallSourceKind, quality: PublishQualityId): void;
  /** The engine's mic+source send-side binding asks for held tracks. */
  localTrack(source: CallManifestSource): MediaTrackLike | null;
  /** Engine hook: a manifest mid was bound — apply the sender caps. */
  onTrackBound(source: CallManifestSource, sender: RtpSenderLike): void;
  /** Engine hook: own `joined` seen — flush queued publishes (VM8 re-publish). */
  onLegConfirmed(): void;
  /** Engine hook: the leg went away WITHOUT user intent (rejoin pending). */
  onLegReset(): void;
  /** Engine hook: user-intent teardown — stop every capture, publish nothing. */
  stopAll(): void;
  /** Live publishing state (desired AND held). */
  getPublishing(): PublishingState;
  /** The source's current quality tier (U5b picker value source). */
  getQuality(source: CallSourceKind): PublishQualityId;
  destroy(): void;
}

const SOURCE_ORDER: readonly CallSourceKind[] = ['camera', 'screen', 'screen_audio'];

/**
 * A picker refusal (KTD8's classification): the user closed or denied the
 * screen picker — a choice, not a failure, so the caller stays silent.
 */
function isPickerRefusal(err: unknown): boolean {
  const name = (err as { name?: unknown } | null | undefined)?.name;
  return name === 'NotAllowedError' || name === 'AbortError';
}

export function createPublishEngine(deps: PublishEngineDeps): PublishEngine {
  const env = deps.env ?? unavailableCaptureEnv();
  const debounceMs = deps.debounceMs ?? 300;
  const setTimeoutFn: SetTimeoutFn = deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimeoutFn: ClearTimeoutFn =
    deps.clearTimeoutFn ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));

  // desired = the user's intent; held = live captured tracks; sent = the op
  // the SERVER has (or will receive via the pending debounce) for THIS leg.
  const desired = new Set<CallSourceKind>();
  const held = new Map<CallSourceKind, MediaTrackLike>();
  const sent = new Set<CallSourceKind>();
  const boundSenders = new Map<CallSourceKind, RtpSenderLike>();
  const quality: Record<CallSourceKind, PublishQualityId> = {
    camera: DEFAULT_CAMERA_QUALITY,
    screen: DEFAULT_SCREEN_QUALITY,
    screen_audio: DEFAULT_SCREEN_QUALITY,
  };
  let legConfirmed = false;
  /** Per-source capture in-flight guards (a camera gUM must not block a screen pick). */
  const capturing = new Set<CallSourceKind>();
  const opTimers = new Map<CallSourceKind, unknown>();
  /**
   * A publishScreen({audio:true}) that bailed on an in-flight screen capture
   * leaves its audio ask here — when that capture completes without a
   * share-audio track, the engine re-captures WITH audio.
   */
  let pendingScreenAudio = false;
  let destroyed = false;

  function preset(source: CallSourceKind): QualityPreset {
    const q = quality[source]!;
    if (source === 'camera') return CAMERA_QUALITY_PRESETS[q as 'low' | 'medium' | 'high'] ?? CAMERA_QUALITY_PRESETS.high;
    return SCREEN_QUALITY_PRESETS[q] ?? SCREEN_QUALITY_PRESETS.medium;
  }

  // -- op reconciliation (the ONE place ops are decided) ----------------------

  /**
   * Reconcile intent → wire: publish what is desired+held+unsent (once the
   * leg is confirmed — the op is participant-gated server-side), unpublish
   * what was sent but is no longer desired/held. Ops debounce per source.
   */
  function reconcile(): void {
    if (destroyed) return;
    for (const source of SOURCE_ORDER) {
      const live = desired.has(source) && held.has(source);
      if (live && legConfirmed && !sent.has(source)) {
        scheduleOp(source, 'publish');
      } else if (!live && sent.has(source)) {
        scheduleOp(source, 'unpublish');
      }
    }
  }

  function scheduleOp(source: CallSourceKind, action: 'publish' | 'unpublish'): void {
    // Mark synchronously — reconcile's reads see the intended end state and
    // a rapid toggle collapses to whichever op is scheduled LAST.
    if (action === 'publish') sent.add(source);
    else sent.delete(source);
    const existing = opTimers.get(source);
    if (existing !== undefined) clearTimeoutFn(existing);
    if (debounceMs <= 0) {
      opTimers.delete(source);
      sendNow(source, action);
      return;
    }
    opTimers.set(
      source,
      setTimeoutFn(() => {
        opTimers.delete(source);
        sendNow(source, action);
      }, debounceMs),
    );
  }

  function sendNow(source: CallSourceKind, action: 'publish' | 'unpublish'): void {
    if (destroyed) return;
    if (action === 'publish') deps.ops.sendPublish(source);
    else deps.ops.sendUnpublish(source);
  }

  // -- track helpers -----------------------------------------------------------

  function wireEnd(track: MediaTrackLike, onEnded: () => void): void {
    if ('onended' in track) track.onended = onEnded;
  }

  function stopTrack(track: MediaTrackLike | undefined): void {
    if (!track) return;
    if ('onended' in track) track.onended = null; // our own stop is not a notice
    try {
      track.stop();
    } catch {
      // already stopped natively
    }
  }

  /** The single unpublish path every ended/deselected source flows through. */
  function retireSource(source: CallSourceKind, noticeShareEnded: boolean): void {
    desired.delete(source);
    const track = held.get(source);
    held.delete(source);
    boundSenders.delete(source);
    stopTrack(track);
    if (noticeShareEnded) deps.ops.notifyShareEnded();
    reconcile();
    deps.ops.onChange();
  }

  /** KTD6's one-source slice: retire WITHOUT any echo op (see serverRetire). */
  function serverRetireOne(source: CallSourceKind): void {
    const timer = opTimers.get(source);
    if (timer !== undefined) {
      clearTimeoutFn(timer);
      opTimers.delete(source);
    }
    desired.delete(source);
    const track = held.get(source);
    held.delete(source);
    boundSenders.delete(source);
    sent.delete(source); // the server drove this unpublish — nothing to echo
    stopTrack(track);
  }

  function serverRetire(source: CallSourceKind): void {
    if (destroyed) return;
    if (source === 'screen') {
      // A revoked share dies whole (rights gate both) — mirrors unpublish().
      serverRetireOne('screen_audio');
      serverRetireOne('screen');
    } else {
      serverRetireOne(source);
    }
    deps.ops.onChange();
  }

  function reapplySenderCaps(): void {
    for (const [source, sender] of boundSenders) {
      // Caps are video-shaped — share-audio senders are never capped.
      if (source === 'camera' || source === 'screen') {
        void applySenderCaps(sender, preset(source));
      }
    }
  }

  function cameraEnded(): void {
    retireSource('camera', false);
  }

  function screenVideoEnded(): void {
    // The share died natively (stop bar / closed window / OS revoke): its
    // share-audio dies with it (R4 — one unpublish path per ending cause).
    retireSource('screen_audio', false);
    retireSource('screen', true); // VM8: ended screens never auto-restart
  }

  function screenAudioEnded(): void {
    retireSource('screen_audio', false);
  }

  // -- capture -------------------------------------------------------------------

  async function captureCamera(q: 'low' | 'medium' | 'high'): Promise<void> {
    const p = CAMERA_QUALITY_PRESETS[q] ?? CAMERA_QUALITY_PRESETS[DEFAULT_CAMERA_QUALITY];
    const stream = await env.getUserMedia({
      video: {
        width: { ideal: p.width },
        height: { ideal: p.height },
        frameRate: { max: p.frameRate },
      },
      audio: false,
    });
    const track = stream.getVideoTracks()[0];
    if (track === undefined) throw new Error('camera stream carried no video track');
    if ('contentHint' in track) track.contentHint = 'motion'; // VM12
    wireEnd(track, cameraEnded);
    held.set('camera', track);
    reconcile();
    deps.ops.onChange();
  }

  async function captureScreen(withAudio: boolean): Promise<{
    replaced: boolean;
  }> {
    const p = preset('screen');
    const videoCaps: boolean | Record<string, unknown> = Object.keys(p).length > 0
      ? {
          width: { ideal: p.width },
          height: { ideal: p.height },
          frameRate: { max: p.frameRate },
        }
      : true;
    const stream = await env.getDisplayMedia({
      video: videoCaps,
      audio: withAudio ? { echoCancellation: false, noiseSuppression: false } : false,
    });
    const track = stream.getVideoTracks()[0];
    if (track === undefined) throw new Error('display stream carried no video track');
    if ('contentHint' in track) track.contentHint = 'detail'; // VM12

    const previousVideo = held.get('screen');
    const switching = previousVideo !== undefined;
    const sender = boundSenders.get('screen');
    let replaced = false;
    if (switching && sender) {
      // VM13: window-switch on the bound sender — no renegotiation storm.
      try {
        await sender.replaceTrack(track);
        replaced = true;
      } catch {
        replaced = false; // browser refused → unpublish+publish fallback
      }
    }

    if (replaced) {
      stopTrack(previousVideo);
      wireEnd(track, screenVideoEnded);
      held.set('screen', track);
    } else {
      if (switching) {
        // Fallback path: the old share retires, the new one publishes fresh.
        stopTrack(previousVideo);
        held.delete('screen');
        sent.delete('screen');
      }
      wireEnd(track, screenVideoEnded);
      held.set('screen', track);
      desired.add('screen');
    }

    // Share-audio (VM9): only when the platform supplied the track.
    const audioTrack = stream.getAudioTracks()[0];
    if (audioTrack !== undefined) {
      const previousAudio = held.get('screen_audio');
      if (previousAudio !== undefined && previousAudio !== audioTrack) {
        const audioSender = boundSenders.get('screen_audio');
        if (audioSender) {
          try {
            await audioSender.replaceTrack(audioTrack);
            stopTrack(previousAudio);
          } catch {
            stopTrack(previousAudio);
            sent.delete('screen_audio');
          }
        } else {
          stopTrack(previousAudio);
          sent.delete('screen_audio');
        }
      }
      wireEnd(audioTrack, screenAudioEnded);
      held.set('screen_audio', audioTrack);
      desired.add('screen_audio');
    } else {
      // No audio came back (unsupported platform or unchecked box): any
      // previous share-audio from the old capture ends with it.
      const previousAudio = held.get('screen_audio');
      if (previousAudio !== undefined) {
        stopTrack(previousAudio);
        held.delete('screen_audio');
        desired.delete('screen_audio');
      }
    }
    reconcile();
    deps.ops.onChange();
    return { replaced };
  }

  // -- public surface ---------------------------------------------------------

  function publishCamera(q?: 'low' | 'medium' | 'high'): void {
    if (destroyed) return;
    quality.camera = q ?? (quality.camera as 'low' | 'medium' | 'high');
    if (desired.has('camera')) {
      // Already on: re-tier only (U5 picker on a live source).
      const track = held.get('camera');
      if (track && typeof track.applyConstraints === 'function') {
        const p = preset('camera');
        void track.applyConstraints({ width: { ideal: p.width }, height: { ideal: p.height }, frameRate: { max: p.frameRate } }).catch(() => undefined);
      }
      const sender = boundSenders.get('camera');
      if (sender) void applySenderCaps(sender, preset('camera'));
      return;
    }
    desired.add('camera');
    if (held.has('camera')) {
      reconcile(); // held-but-reset (VM8 rejoin): re-publish directly
      return;
    }
    if (capturing.has('camera')) return;
    capturing.add('camera');
    void (async () => {
      try {
        await captureCamera(quality.camera as 'low' | 'medium' | 'high');
      } catch {
        desired.delete('camera'); // capture refused: no publish, no roster lie
      } finally {
        capturing.delete('camera');
      }
    })();
  }

  function publishScreen(opts?: { audio?: boolean; quality?: PublishQualityId }): void {
    if (destroyed) return;
    if (opts?.quality !== undefined) quality.screen = opts.quality;
    const withAudio = opts?.audio === true || desired.has('screen_audio');
    if (!desired.has('screen') && !held.has('screen')) {
      desired.add('screen');
    }
    if (capturing.has('screen')) {
      // Bailed on an in-flight capture — but an explicit audio ask must not
      // vanish with it: remember it, and if the in-flight capture lands
      // without share-audio, re-capture WITH audio once it settles.
      if (opts?.audio === true) pendingScreenAudio = true;
      return;
    }
    capturing.add('screen');
    void (async () => {
      try {
        await captureScreen(withAudio);
      } catch (err) {
        if (!held.has('screen')) {
          desired.delete('screen');
          // F5: distinguish WHY the capture failed. A picker refusal
          // (NotAllowedError/AbortError — the user closed or denied it) is
          // the user changing their mind: silence is honest. Any other
          // failure with nothing held means THIS HOST cannot share (e.g.
          // WKWebView's NotSupportedError) — the silent no-op the WebKit
          // walkthrough flagged becomes the share-unavailable notice,
          // which the surface pairs with the KDV3 web-app handoff.
          if (!isPickerRefusal(err)) deps.ops.notifyShareUnavailable();
        }
      } finally {
        capturing.delete('screen');
      }
      if (pendingScreenAudio) {
        pendingScreenAudio = false; // consumed either way
        if (!held.has('screen_audio') && held.has('screen') && !destroyed) {
          // The share is live without audio and the user asked for it:
          // re-capture WITH audio (captureScreen's replace path — audio-only
          // getDisplayMedia is not portable across engines). A refusal keeps
          // the video share; audio simply stays off.
          capturing.add('screen');
          try {
            await captureScreen(true);
          } catch {
            // picker refused — the live share stands
          } finally {
            capturing.delete('screen');
          }
        }
      }
    })();
  }

  function switchScreenSource(): void {
    if (!held.has('screen')) return;
    publishScreen({ audio: desired.has('screen_audio') });
  }

  function unpublish(source: CallSourceKind): void {
    if (destroyed) return;
    if (source === 'screen') {
      retireSource('screen_audio', false);
      retireSource('screen', false);
      return;
    }
    retireSource(source, false);
  }

  function setQuality(source: CallSourceKind, q: PublishQualityId): void {
    if (source === 'camera' && q !== 'source') publishCamera(q as 'low' | 'medium' | 'high');
    else {
      quality[source] = q;
      const sender = boundSenders.get(source);
      if (sender) void applySenderCaps(sender, preset(source));
    }
  }

  function localTrack(source: CallManifestSource): MediaTrackLike | null {
    if (source === 'mic') return null; // the engine owns the mic
    return held.get(source) ?? null;
  }

  function onTrackBound(source: CallManifestSource, sender: RtpSenderLike): void {
    if (source === 'mic') return;
    if (!(source in quality)) return;
    boundSenders.set(source, sender);
    // Caps are video-shaped (scaleResolutionDownBy is invalid on audio) —
    // share-audio senders are recorded for VM13 switching but never capped.
    if (source === 'camera' || source === 'screen') {
      void applySenderCaps(sender, preset(source));
    }
  }

  function onLegConfirmed(): void {
    legConfirmed = true;
    reconcile(); // VM8: the still-held camera (and a live screen) re-publish
  }

  function onLegReset(): void {
    legConfirmed = false;
    sent.clear(); // the new leg's roster is fresh — publishes must re-send
    boundSenders.clear(); // senders belong to the dead PC
    reconcile();
  }

  function stopAll(): void {
    desired.clear();
    pendingScreenAudio = false;
    for (const source of [...held.keys()]) {
      const track = held.get(source);
      held.delete(source);
      stopTrack(track);
    }
    boundSenders.clear();
    sent.clear();
    for (const timer of opTimers.values()) clearTimeoutFn(timer);
    opTimers.clear();
    legConfirmed = false;
    deps.ops.onChange();
  }

  function getPublishing(): PublishingState {
    return {
      camera: desired.has('camera') && held.has('camera'),
      screen: desired.has('screen') && held.has('screen'),
      screen_audio: desired.has('screen_audio') && held.has('screen_audio'),
    };
  }

  function getQuality(source: CallSourceKind): PublishQualityId {
    return quality[source] ?? DEFAULT_SCREEN_QUALITY;
  }

  function destroy(): void {
    destroyed = true;
    stopAll();
  }

  return {
    publishCamera,
    publishScreen,
    switchScreenSource,
    unpublish,
    serverRetire,
    reapplySenderCaps,
    setQuality,
    localTrack,
    onTrackBound,
    onLegConfirmed,
    onLegReset,
    stopAll,
    getPublishing,
    getQuality,
    destroy,
  };
}
