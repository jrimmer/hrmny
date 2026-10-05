/**
 * @cytale/state — call slices projection (calls plan U6).
 *
 * Read-side selectors over the call slices (callByChannel /
 * dmCallByChannel / callLogThreadIdByChannel / callRingByChannel) for the
 * consuming surfaces: U7's sidebar slot + live badge, U8's panel roster,
 * U9's log surfaces, U10's DM indicator. Pure functions over a StateState
 * snapshot — no store subscription, no caching (call them from zustand
 * selectors).
 *
 * `clearCallRing` is the one write-side helper that lives here (the
 * unread.ts precedent: the feature module owns its consumer-facing
 * actions): ring lifetime is consumer-owned — the ring UX clears on view
 * or 30 s expiry, and CALL_END deliberately leaves the slot readable for
 * U10's missed-call derivation.
 */

import type { CallSourceKind, CallSourceState, Snowflake } from '@cytale/protocol';

import type {
  CallParticipantState,
  CallRingEntry,
  LiveCall,
  StateState,
  StateStore,
} from '../store.js';

/** The live room call on a channel, if any (undefined = idle). */
export function selectLiveCall(state: StateState, channelId: Snowflake): LiveCall | undefined {
  return state.callByChannel[channelId];
}

/** The live DM call on a channel, if any (R11 — separate slice by design). */
export function selectDmCall(state: StateState, channelId: Snowflake): LiveCall | undefined {
  return state.dmCallByChannel[channelId];
}

/**
 * The channel's roster (room call first, DM call as fallback), sorted by
 * user id for stable rendering. Empty when no call is live.
 */
export function selectCallRoster(
  state: StateState,
  channelId: Snowflake,
): CallParticipantState[] {
  const call = state.callByChannel[channelId] ?? state.dmCallByChannel[channelId];
  if (call === undefined) return [];
  return Object.values(call.participants).sort((a, b) =>
    a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0,
  );
}

/** Participant count for badge/label projections (0 when idle). */
export function selectParticipantCount(state: StateState, channelId: Snowflake): number {
  const call = state.callByChannel[channelId] ?? state.dmCallByChannel[channelId];
  return call === undefined ? 0 : Object.keys(call.participants).length;
}

/** True when `userId` currently holds a voice leg in the channel's call. */
export function selectIsInCall(state: StateState, channelId: Snowflake, userId: Snowflake): boolean {
  const call = state.callByChannel[channelId] ?? state.dmCallByChannel[channelId];
  return call !== undefined && call.participants[userId] !== undefined;
}

/**
 * The channel's standing call-log thread id (R4) — the exclusion key and
 * U9's log-pane anchor. Undefined until a wire/REST source taught it.
 */
export function selectCallLogThreadId(
  state: StateState,
  channelId: Snowflake,
): Snowflake | undefined {
  return state.callLogThreadIdByChannel[channelId];
}

/** The channel's pending ring notification, if any (ephemeral — see store). */
export function selectCallRing(state: StateState, channelId: Snowflake): CallRingEntry | undefined {
  return state.callRingByChannel[channelId];
}

/**
 * The server's media-plane master switch (ticket #124, READY's
 * `media_enabled` → the store's `mediaEnabled`). Absent-field semantics are
 * folded in at the READY write (default true), so this is a plain read:
 * false = the instance disabled calls — surfaces render the honest
 * disabled state, and the server refuses start/join/ICE regardless.
 */
export function selectMediaEnabled(state: StateState): boolean {
  return state.mediaEnabled;
}

/** Channel ids with a live room call, ascending — U7's slot rows. */
export function selectLiveCallChannelIds(state: StateState): Snowflake[] {
  const ids = Object.keys(state.callByChannel).filter(
    (id) => state.callByChannel[id] !== undefined,
  );
  return ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Publish-state projections (calls V2 plan U4 — R3: publish state is visible
// to everyone, incl. late joiners via CALL_SYNC's sources)
// ---------------------------------------------------------------------------

/** One live published source, with its publisher and recency. */
export interface ParticipantSourceInfo {
  user_id: Snowflake;
  source: CallSourceKind;
  /** Publish time (ISO 8601); undefined when only transition-derived. */
  since: string | undefined;
}

/** The participant's live published sources (empty = audio-only). */
export function selectParticipantSources(
  state: StateState,
  channelId: Snowflake,
  userId: Snowflake,
): CallSourceState[] {
  const call = state.callByChannel[channelId] ?? state.dmCallByChannel[channelId];
  return call?.participants[userId]?.sources ?? [];
}

/** True when `userId` currently publishes `source` in the channel's call. */
export function selectIsPublishing(
  state: StateState,
  channelId: Snowflake,
  userId: Snowflake,
  source: CallSourceKind,
): boolean {
  return selectParticipantSources(state, channelId, userId).some((s) => s.source === source);
}

/**
 * Every live publisher of one source kind, MOST RECENT FIRST (VM4's
 * stage-follows-most-recent-sharer input; `since`-less entries sort last,
 * stably by user id). `screen_audio` rides the share it belongs to — the
 * presenter-bar badge (VM9) reads it via selectParticipantSources.
 */
export function selectSourcePublishers(
  state: StateState,
  channelId: Snowflake,
  source: CallSourceKind,
): ParticipantSourceInfo[] {
  const call = state.callByChannel[channelId] ?? state.dmCallByChannel[channelId];
  if (call === undefined) return [];
  const out: ParticipantSourceInfo[] = [];
  for (const participant of Object.values(call.participants)) {
    for (const s of participant.sources ?? []) {
      if (s.source === source) out.push({ user_id: participant.user_id, source, since: s.since });
    }
  }
  return out.sort((a, b) => {
    if (a.since !== undefined && b.since !== undefined) return a.since < b.since ? 1 : a.since > b.since ? -1 : 0;
    if (a.since !== undefined) return -1;
    if (b.since !== undefined) return 1;
    return a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0;
  });
}

/** Who is publishing camera right now (tile sources), most recent first. */
export function selectCameraPublishers(
  state: StateState,
  channelId: Snowflake,
): ParticipantSourceInfo[] {
  return selectSourcePublishers(state, channelId, 'camera');
}

/** Who is sharing a screen right now (stage sources), most recent first. */
export function selectScreenSharers(
  state: StateState,
  channelId: Snowflake,
): ParticipantSourceInfo[] {
  return selectSourcePublishers(state, channelId, 'screen');
}

/** Clear a channel's ring slot (ring UX: viewed / expired / dismissed). */
export function clearCallRing(store: StateStore, channelId: Snowflake): void {
  store.setState((s) => {
    if (s.callRingByChannel[channelId] === undefined) return {};
    const { [channelId]: _cleared, ...callRingByChannel } = s.callRingByChannel;
    return { callRingByChannel };
  });
}
