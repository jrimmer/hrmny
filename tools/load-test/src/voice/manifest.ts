/**
 * U7 — envelope-v2 manifest attribution + budget-coverage math (pure).
 *
 * The wire codecs are imported from @cytale/protocol (U28 doctrine): the
 * offer envelope parser here IS the production one. These helpers sit on
 * top of it to answer the video scenario's questions:
 *
 *   - which (owner, source) streams does this leg RECEIVE (egress entries)?
 *   - which m-lines are MY attach targets (ingest entries)?
 *   - do a receiver's per-source receipts stay within its video_want budget?
 *   - what is the largest CALL_SIGNAL body observed (vs the 128 KiB cap)?
 */

import {
  CALL_SIGNAL_BODY_MAX_BYTES,
  CALL_SIGNAL_ENVELOPE_VERSION,
  parseCallSignalOfferEnvelope,
  type CallSignalOfferEnvelope,
} from '@cytale/protocol';

/** One egress stream attribution (what the receiving leg plays). */
export interface EgressAttribution {
  mid: string;
  userId: string;
  source: string;
  rids?: string[];
}

/** An ingest attach target (the viewer's own publish m-line). */
export interface IngestAttribution {
  mid: string;
  source: string;
  rids?: string[];
}

/** Split a manifest into receive-streams vs own attach targets. */
export function attributionFromManifest(
  envelope: CallSignalOfferEnvelope,
  ownUserId: string | null,
): { egress: EgressAttribution[]; ingest: IngestAttribution[] } {
  const egress: EgressAttribution[] = [];
  const ingest: IngestAttribution[] = [];

  for (const entry of envelope.tracks) {
    if (ownUserId !== null && entry.user_id === ownUserId) {
      ingest.push({ mid: entry.mid, source: entry.source, rids: entry.rids });
    } else {
      egress.push({ mid: entry.mid, userId: entry.user_id, source: entry.source, rids: entry.rids });
    }
  }

  return { egress, ingest };
}

/** Parse an offer body via the production codec, else null (V1/answer/ICE). */
export function offerEnvelopeOf(body: string): CallSignalOfferEnvelope | null {
  return parseCallSignalOfferEnvelope(body);
}

/** Byte size of a CALL_SIGNAL body against the VM14 cap (128 KiB). */
export function bodyBytesOf(body: string): number {
  return Buffer.byteLength(body, 'utf8');
}

/** True while the body fits the gateway's hard cap. */
export function withinBodyCap(body: string): boolean {
  return bodyBytesOf(body) <= CALL_SIGNAL_BODY_MAX_BYTES;
}

/**
 * Distinct video sources a receiver actually received, from the sidecar's
 * per-source receipt map ("userId/source" -> packets). `min` packets
 * filters renegotiation stragglers (a source's first few packets can land
 * before the budget applies; the steady count is what the policy proves).
 */
export function distinctVideoSources(
  recv: Record<string, number>,
  opts: { videoOnly?: boolean; min?: number } = {},
): { count: number; users: string[]; keys: string[] } {
  const min = opts.min ?? 1;
  const keys: string[] = [];
  const users = new Set<string>();

  for (const [key, packets] of Object.entries(recv)) {
    if (opts.videoOnly !== false && !isVideoKey(key)) continue;
    if (packets < min) continue;
    keys.push(key);
    users.add(key.split('/')[0]!);
  }

  return { count: keys.length, users: [...users].sort(), keys: keys.sort() };
}

function isVideoKey(key: string): boolean {
  const source = key.split('/')[1] ?? '';
  return source === 'camera' || source === 'screen';
}

/**
 * Budget verdict for one receiver against `tiles` (the video_want it
 * declared). Mirrors the server's implemented policy (media.ex `deliver?`):
 * the TILE budget cuts the CAMERA ranking; the stage screen is exempt (R7 —
 * the stage never drops) and non-stage screens ride their own rank list cut
 * at the same budget index — so the counted set is CAMERA sources only,
 * with the stage key additionally excluded when named.
 */
export function checkBudgetCoverage(
  recv: Record<string, number>,
  tiles: number,
  stageKey: string | null = null,
  opts: { min?: number } = {},
): {
  withinBudget: boolean;
  distinct: number;
  keys: string[];
  stageReceived: boolean;
  screenKeys: string[];
} {
  const { keys } = distinctVideoSources(recv, opts);
  const cameras = keys.filter((k) => (k.split('/')[1] ?? '') === 'camera' && k !== stageKey);
  const screens = keys.filter((k) => (k.split('/')[1] ?? '') === 'screen' && k !== stageKey);
  const stageReceived = stageKey === null ? false : keys.includes(stageKey);

  return {
    withinBudget: cameras.length <= tiles,
    distinct: cameras.length,
    keys: cameras,
    stageReceived,
    screenKeys: screens,
  };
}

/**
 * Per-key counter delta between two tick snapshots (steady-window math):
 * maps are monotonic counters, so end − start is the window's volume.
 */
export function counterDelta(
  atStart: Record<string, number> | undefined,
  atEnd: Record<string, number>,
): Record<string, number> {
  const delta: Record<string, number> = {};
  for (const [key, end] of Object.entries(atEnd)) {
    const d = end - (atStart?.[key] ?? 0);
    if (d > 0) delta[key] = d;
  }
  return delta;
}

/** The envelope version this harness expects on V2 offers (docs parity). */
export const ENVELOPE_VERSION = CALL_SIGNAL_ENVELOPE_VERSION;
