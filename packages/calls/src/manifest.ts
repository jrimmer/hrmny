/**
 * @cytale/web — the offer-manifest attribution module (calls V2 plan U4, R5/KTD1).
 *
 * THE single attribution source for every remote track: a V2 server wraps
 * every SDP offer it pushes on CALL_SIGNAL in the versioned envelope
 * `{"v":2,"type":"offer","sdp":…,"tracks":[{mid,user_id,source,rids?}]}` (the
 * wire shape and its parser live in @cytale/protocol —
 * `parseCallSignalOfferEnvelope`, U2). This module turns that envelope into
 * the mid → (user, source, rids) map the engine keys everything on:
 *
 *   - AUDIO PLAYBACK keys on it (mic + screen_audio m-lines) — V1's
 *     positional m-line-order mirror (`remoteOrder`) is RETIRED here (R5).
 *   - VIDEO TRACKS key on it (camera/screen attach + detach).
 *   - SEND-SIDE BINDING keys on it: the client attaches its OWN published
 *     tracks (mic included) to the leg's ingest m-lines BY MANIFEST MID via
 *     `transceiver.sender.replaceTrack` after `setRemoteDescription` — never
 *     first-free-m-line; same-kind sources (camera/screen; mic/share-audio)
 *     otherwise swap when permission prompts resolve out of publish order
 *     (KTD1's out-of-order-grants hazard).
 *
 * Tolerance-first (per docs/protocol/events.md): an offer body without `v`
 * is a V1 audio-only shape — it still negotiates, but with an EMPTY manifest
 * (nothing is ever guessed positionally again, so an unattributed m-line
 * simply never plays); a v2 envelope whose `tracks` omits an m-line leaves
 * that line unattributed the same way; duplicate mids collapse
 * deterministically (last entry wins — one manifest entry per m-line is the
 * server contract, U3 derives it from its own roster).
 */

import {
  parseCallSignalOfferEnvelope,
  type CallManifestSource,
  type CallSignalManifestEntry,
} from '@cytale/protocol';

/** Attribution of one SDP m-line (manifest entry, post-parse). */
export interface CallTrackAttribution {
  userId: string;
  source: CallManifestSource;
  /** Simulcast rid layers riding the m-line (GO branch); absent = single stream. */
  rids?: string[];
}

/** mid → attribution. THE map every track decision keys on. */
export type CallTrackManifest = ReadonlyMap<string, CallTrackAttribution>;

/** A parsed CALL_SIGNAL offer body, ready for the negotiation pump. */
export interface ParsedCallOffer {
  sdp: string;
  /** mid → (user, source, rids). Empty for V1-shaped bodies (tolerance). */
  manifest: CallTrackManifest;
  /** True when the body was a v2 envelope; false for the V1-shape fallback. */
  envelope: boolean;
}

/** The empty manifest — the tolerance result for V1 bodies / missing tracks. */
export function emptyManifest(): CallTrackManifest {
  return new Map();
}

/**
 * Parse one CALL_SIGNAL `body` into an offer + its manifest.
 *
 * Returns `{sdp, manifest, envelope: true}` for envelope v2 bodies, a
 * V1-shape fallback `{sdp, manifest: empty, envelope: false}` for
 * `{"type":"offer","sdp":…}` bodies without the version tag (rolling-deploy
 * tolerance — negotiation proceeds, attribution does not guess), and null
 * for anything else (answers, ICE bodies, malformed JSON — the caller drops
 * them exactly as V1 did).
 */
export function parseCallOffer(body: string): ParsedCallOffer | null {
  const envelope = parseCallSignalOfferEnvelope(body);
  if (envelope !== null) {
    return { sdp: envelope.sdp, manifest: manifestFromEntries(envelope.tracks), envelope: true };
  }
  // V1-shape tolerance: a bare offer without the envelope version tag.
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null) return null;
  const p = json as Record<string, unknown>;
  if (p.type === 'offer' && typeof p.sdp === 'string' && !('v' in p)) {
    return { sdp: p.sdp, manifest: emptyManifest(), envelope: false };
  }
  return null;
}

/** Wire manifest entries → the mid-keyed map (duplicate mids: last wins). */
export function manifestFromEntries(
  entries: readonly CallSignalManifestEntry[],
): CallTrackManifest {
  const map = new Map<string, CallTrackAttribution>();
  for (const entry of entries) {
    map.set(entry.mid, {
      userId: entry.user_id,
      source: entry.source,
      ...(entry.rids !== undefined ? { rids: [...entry.rids] } : {}),
    });
  }
  return map;
}

/** True for audio-kind sources (playback targets; deafen stops both — R15). */
export function isAudioSource(source: CallManifestSource): source is 'mic' | 'screen_audio' {
  return source === 'mic' || source === 'screen_audio';
}

/** True for video-kind sources (tile/stage targets). */
export function isVideoSource(source: CallManifestSource): source is 'camera' | 'screen' {
  return source === 'camera' || source === 'screen';
}

/** Stable per-track key: `${userId}:${source}` (playback + video maps). */
export function trackKey(userId: string, source: CallManifestSource): string {
  return `${userId}:${source}`;
}

/** Manifest entries attributed to `userId` — the send-side binding set. */
export function ownEntries(
  manifest: CallTrackManifest,
  userId: string,
): Array<{ mid: string; source: CallManifestSource }> {
  const out: Array<{ mid: string; source: CallManifestSource }> = [];
  for (const [mid, attr] of manifest) {
    if (attr.userId === userId) out.push({ mid, source: attr.source });
  }
  return out;
}

// ---------------------------------------------------------------------------
// SDP m-line parsing (generalizes V1's audioMlineInfo — video m-lines exist
// now; the engine keys on mids, never positions)
// ---------------------------------------------------------------------------

/** One parsed m-line of an SDP. */
export interface MlineInfo {
  kind: string;
  mid: string | null;
  /** False when stopped/inactive (port 0 or a=inactive). */
  active: boolean;
  /** sendonly | recvonly | sendrecv | inactive | '' (unmarked). */
  direction: string;
}

/**
 * Ordered m-lines of an SDP (kind, mid, active flag, direction). Pure SDP
 * shape walk — no attribution (that is the manifest's job, never re-derived
 * here; positions carry no meaning post-R5).
 */
export function parseMlines(sdp: string): MlineInfo[] {
  const lines = sdp.split(/\r?\n/);
  const result: MlineInfo[] = [];
  let current: MlineInfo | null = null;
  for (const line of lines) {
    if (line.startsWith('m=')) {
      if (current) result.push(current);
      const m = /^m=(\S+) (\d+) /.exec(line);
      current = m
        ? { kind: m[1]!, mid: null, active: m[2] !== '0', direction: '' }
        : null;
      continue;
    }
    if (!current) continue;
    const mid = /^a=mid:(.+)$/.exec(line);
    if (mid) current.mid = mid[1]!;
    const dir = /^a=(sendonly|recvonly|sendrecv|inactive)$/.exec(line);
    if (dir) {
      current.direction = dir[1]!;
      if (dir[1] === 'inactive') current.active = false;
    }
  }
  if (current) result.push(current);
  return result;
}
