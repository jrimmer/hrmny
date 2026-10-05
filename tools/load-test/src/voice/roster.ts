/**
 * U13 — pure call-roster reduction + resume-replay integrity checks.
 *
 * Pure functions only: they are the voice scenarios' assertion core, unit
 * tested in __tests__/voice.test.ts. The wire types come from
 * @cytale/protocol (the codec-authoritative path).
 */

import type { CallEnd, CallStart, CallSync, CallSyncEntry, CallSyncDmEntry, CallUpdate } from '@cytale/protocol';

/** One roster member's derived voice state. */
export interface RosterMember {
  userId: string;
  leg: string;
  mute: boolean;
  deafen: boolean;
  /** V2: live published sources (camera | screen | screen_audio). */
  sources: string[];
}

/** A channel's live-call roster as derived from CALL_* dispatches. */
export interface CallRoster {
  callId: string | null;
  channelId: string | null;
  members: Map<string, RosterMember>;
}

export function emptyRoster(): CallRoster {
  return { callId: null, channelId: null, members: new Map() };
}

/** User ids currently in the call (sorted for stable comparisons). */
export function rosterUserIds(roster: CallRoster): string[] {
  return [...roster.members.keys()].sort();
}

/**
 * Fold one CALL_* dispatch into the roster. Unknown/foreign-channel events
 * are ignored (returns the same roster object). CallSync is folded per-entry
 * via {@link applyCallSync} (a sync carries rosters for MANY channels).
 */
export function applyCallEvent(roster: CallRoster, event: CallStart | CallUpdate | CallEnd): CallRoster {
  if (isCallStart(event)) {
    if (roster.callId !== null && roster.callId !== event.call_id) return roster;
    return { callId: event.call_id, channelId: event.channel_id, members: new Map(roster.members) };
  }

  if (isCallUpdate(event)) {
    if (roster.callId !== null && roster.callId !== event.call_id) return roster;
    const members = new Map(roster.members);
    switch (event.state) {
      case 'joined':
        members.set(String(event.user_id), {
          userId: String(event.user_id),
          leg: event.leg,
          mute: false,
          deafen: false,
          sources: [],
        });
        break;
      case 'left':
      case 'displaced':
      case 'forced_leave':
        members.delete(String(event.user_id));
        break;
      case 'muted': {
        const m = members.get(String(event.user_id));
        if (m) members.set(m.userId, { ...m, mute: true });
        break;
      }
      case 'unmuted': {
        const m = members.get(String(event.user_id));
        if (m) members.set(m.userId, { ...m, mute: false });
        break;
      }
      case 'deafened': {
        const m = members.get(String(event.user_id));
        if (m) members.set(m.userId, { ...m, deafen: true, mute: true });
        break;
      }
      case 'undeafened': {
        const m = members.get(String(event.user_id));
        if (m) members.set(m.userId, { ...m, deafen: false });
        break;
      }
      default: {
        // V2 source states (camera_on … screen_audio_off): fold the
        // publish-state of the event's `source` into the member's set.
        if (event.source !== undefined && event.source !== null) {
          const m = members.get(String(event.user_id));
          if (m) {
            const set = new Set(m.sources);
            if (String(event.state).endsWith('_on')) set.add(String(event.source));
            else set.delete(String(event.source));
            members.set(m.userId, { ...m, sources: [...set].sort() });
          }
        }
        break;
      }
    }
    return { ...roster, members };
  }

  if (isCallEnd(event)) {
    if (roster.callId !== null && roster.callId !== event.call_id) return roster;
    return emptyRoster();
  }

  return roster;
}

/**
 * Fold one channel's entry of a CALL_SYNC backfill: replace that channel's
 * roster wholesale (or clear it when the sync carries no entry — the call is
 * not live from this recipient's view).
 */
export function applyCallSync(
  roster: CallRoster,
  channelId: string,
  entry: CallSyncEntry | CallSyncDmEntry | undefined,
): CallRoster {
  if (!entry) return roster.channelId === channelId || roster.channelId === null ? emptyRoster() : roster;
  return {
    callId: entry.call_id,
    channelId: String(entry.channel_id),
    members: new Map(
      entry.participants.map((p) => [
        String(p.user_id),
        {
          userId: String(p.user_id),
          leg: '',
          mute: p.mute,
          deafen: p.deafen,
          sources: (p.sources ?? []).map((s) => String(s.source)).sort(),
        },
      ]),
    ),
  };
}

function isCallStart(e: object): e is CallStart {
  return 'started_by' in e && 'started_at' in e;
}

function isCallUpdate(e: object): e is CallUpdate {
  return 'leg' in e && 'state' in e;
}

function isCallEnd(e: object): e is CallEnd {
  return 'reason' in e && 'ended_at' in e && !('started_at' in e);
}

/**
 * The per-session resume-buffer cap (gateway.md: bounded at 1000 envelopes;
 * a Resume below the eviction watermark is refused, never a partial replay).
 */
export const RESUME_BUFFER_CAP = 1000;

/** Integrity verdict of one replayed dispatch stream. */
export interface ReplayIntegrity {
  /** Every replayed seq is lastSeq+1, lastSeq+2, … — no gap, no duplicate. */
  contiguous: boolean;
  /** First out-of-order index (for diagnostics), -1 when contiguous. */
  firstBadIndex: number;
  /** Replay count against the session cap. */
  withinCap: boolean;
  count: number;
}

/**
 * Assert replay integrity: after a Resume from `fromSeq`, the server replays
 * exactly the retained dispatches with seq > fromSeq, oldest first, gap-free
 * (gateway.md "Resume buffer cap and the eviction watermark"). A refusal is
 * NOT detectable here — the caller asserts no InvalidSession instead.
 */
export function checkReplayIntegrity(fromSeq: number, replayedSeqs: readonly number[], cap = RESUME_BUFFER_CAP): ReplayIntegrity {
  let expected = fromSeq;
  for (let i = 0; i < replayedSeqs.length; i++) {
    const s = replayedSeqs[i];
    if (typeof s !== 'number' || s !== expected + 1) {
      return { contiguous: false, firstBadIndex: i, withinCap: replayedSeqs.length <= cap, count: replayedSeqs.length };
    }
    expected = s;
  }
  return { contiguous: true, firstBadIndex: -1, withinCap: replayedSeqs.length <= cap, count: replayedSeqs.length };
}

/**
 * Steady-window delivery math (the U13 full-delivery assertion): every
 * receiver's inbound count over the window vs (n−1) sources × pps × time.
 * Returns per-receiver percentages.
 */
export function deliveryPercentages(
  receivedPerReceiver: readonly number[],
  receivedAtWindowStart: readonly number[],
  n: number,
  pps: number,
  windowMs: number,
): number[] {
  const expected = (n - 1) * pps * (windowMs / 1_000);
  return receivedPerReceiver.map((r, i) => {
    if (expected <= 0) return 0;
    return ((r - (receivedAtWindowStart[i] ?? 0)) / expected) * 100;
  });
}
