/**
 * @cytale/state — call reconcile tests (calls plan U6).
 *
 * Event application for the six CALL_* dispatches: the full lifecycle
 * sequence drives the call slices exactly (two participants from one
 * stream), CALL_SYNC is a per-recipient authoritative full replace (R9),
 * out-of-order END-before-UPDATE is idempotent, CALL_RING lives in its
 * ephemeral deduped slot, and call-log MessageCreate traffic never touches
 * channel surfaces (R5 — the security-reviewed exclusion).
 *
 * Frames are driven exactly as the gateway delivers them (op-0 dispatch
 * objects with seq `s`), mirroring the gateway-client test harness's
 * serverSend shapes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CallEnd,
  CallStart,
  CallSync,
  CallUpdate,
  GatewayEvent,
  MessageCreate,
  Ready,
  ThreadMessageCreate,
} from '@cytale/protocol';

import { createStateStore } from '../store.js';
import {
  applyGatewayEvent,
  mergeChannelMessages,
  resetForFreshSession,
  setCallLogThread,
} from '../reconcile.js';
import {
  clearCallRing,
  selectCameraPublishers,
  selectCallLogThreadId,
  selectCallRing,
  selectCallRoster,
  selectDmCall,
  selectIsInCall,
  selectIsPublishing,
  selectLiveCall,
  selectLiveCallChannelIds,
  selectParticipantCount,
  selectParticipantSources,
  selectScreenSharers,
} from '../call/projection.js';

// ---------------------------------------------------------------------------
// Fixtures — snowflakes are decimal strings (>53-bit safe), never numbers.
// ---------------------------------------------------------------------------

const CHANNEL = '9007199254740993';
const CHANNEL_2 = '9007199254740994';
const DM_CHANNEL = '9007199254741999';
/** The standing call-log thread of CHANNEL (R4). */
const CALL_LOG_THREAD = '9007199254741000';
/** An ordinary (non-call-log) thread in CHANNEL. */
const OTHER_THREAD = '9007199254741001';
const CALL = '8000000000000001';
const CALL_2 = '8000000000000002';
const USER_A = '7000000000000001';
const USER_B = '7000000000000002';
const ME = '7000000000000003';

let seq = 0;
function dispatch(t: string, d: unknown): GatewayEvent {
  seq += 1;
  return { op: 0, t, s: seq, d } as unknown as GatewayEvent;
}

function callStart(overrides: Partial<CallStart> = {}): CallStart {
  return {
    channel_id: CHANNEL,
    call_id: CALL,
    thread_id: CALL_LOG_THREAD,
    started_by: USER_A,
    started_at: '2026-09-06T12:00:00.000Z',
    ...overrides,
  };
}

function callUpdate(overrides: Partial<CallUpdate> = {}): CallUpdate {
  return {
    channel_id: CHANNEL,
    call_id: CALL,
    user_id: USER_A,
    leg: 'leg-a-1',
    state: 'joined',
    ...overrides,
  };
}

function callEnd(overrides: Partial<CallEnd> = {}): CallEnd {
  return {
    channel_id: CHANNEL,
    call_id: CALL,
    reason: 'last_left',
    ended_at: '2026-09-06T12:30:00.000Z',
    ...overrides,
  };
}

function callSync(d: CallSync): CallSync {
  return d;
}

function channelMessage(overrides: Partial<MessageCreate> = {}): MessageCreate {
  return {
    id: '1000000000000001',
    channel_id: CHANNEL,
    thread_id: null,
    author_id: USER_A,
    content: 'hello',
    created_at: '2026-09-06T12:00:05.000Z',
    edited_at: null,
    ...overrides,
  };
}

function threadMessage(overrides: Partial<ThreadMessageCreate> = {}): ThreadMessageCreate {
  return {
    id: '1000000000000002',
    channel_id: CHANNEL,
    thread_id: CALL_LOG_THREAD,
    author_id: USER_A,
    content: 'call-log chatter',
    created_at: '2026-09-06T12:00:06.000Z',
    edited_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  seq = 0;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('CALL_START → CALL_UPDATE×2 → CALL_END (happy path)', () => {
  it('drives the slices exactly: two participants from one event stream', () => {
    const store = createStateStore();

    applyGatewayEvent(store, dispatch('CallStart', callStart()));
    let call = store.getState().callByChannel[CHANNEL];
    expect(call).toMatchObject({
      call_id: CALL,
      thread_id: CALL_LOG_THREAD,
      started_by: USER_A,
      started_at: '2026-09-06T12:00:00.000Z',
    });
    expect(Object.keys(call!.participants)).toHaveLength(0);

    // The server emits the starter's leg right after start (room.ex).
    applyGatewayEvent(store, dispatch('CallUpdate', callUpdate({ user_id: USER_A })));
    applyGatewayEvent(
      store,
      dispatch('CallUpdate', callUpdate({ user_id: USER_B, leg: 'leg-b-1' })),
    );
    call = store.getState().callByChannel[CHANNEL];
    expect(Object.keys(call!.participants).sort()).toEqual([USER_A, USER_B]);
    expect(call!.participants[USER_A]).toEqual({
      user_id: USER_A,
      mute: false,
      deafen: false,
      leg: 'leg-a-1',
    });

    applyGatewayEvent(store, dispatch('CallEnd', callEnd()));
    expect(store.getState().callByChannel[CHANNEL]).toBeUndefined();
  });

  it('seeds the standing-thread mapping from CALL_START (R4/R5)', () => {
    const store = createStateStore();
    applyGatewayEvent(store, dispatch('CallStart', callStart()));
    expect(store.getState().callLogThreadIdByChannel[CHANNEL]).toBe(CALL_LOG_THREAD);
  });

  it('flips mute/deafen leg states and refreshes the leg discriminator (AM8)', () => {
    const store = createStateStore();
    applyGatewayEvent(store, dispatch('CallStart', callStart()));
    applyGatewayEvent(store, dispatch('CallUpdate', callUpdate({ user_id: USER_B, leg: 'leg-b-1' })));

    applyGatewayEvent(
      store,
      dispatch('CallUpdate', callUpdate({ user_id: USER_B, leg: 'leg-b-1', state: 'muted' })),
    );
    expect(store.getState().callByChannel[CHANNEL]!.participants[USER_B]).toMatchObject({
      mute: true,
      deafen: false,
    });

    applyGatewayEvent(
      store,
      dispatch('CallUpdate', callUpdate({ user_id: USER_B, leg: 'leg-b-1', state: 'deafened' })),
    );
    expect(store.getState().callByChannel[CHANNEL]!.participants[USER_B]).toMatchObject({
      mute: true,
      deafen: true,
    });

    applyGatewayEvent(
      store,
      dispatch('CallUpdate', callUpdate({ user_id: USER_B, leg: 'leg-b-1', state: 'unmuted' })),
    );
    applyGatewayEvent(
      store,
      dispatch('CallUpdate', callUpdate({ user_id: USER_B, leg: 'leg-b-2', state: 'undeafened' })),
    );
    expect(store.getState().callByChannel[CHANNEL]!.participants[USER_B]).toEqual({
      user_id: USER_B,
      mute: false,
      deafen: false,
      leg: 'leg-b-2',
    });
  });

  it('V1 review-fix 12: deafen implies mute in the roster; undeafen defers to the paired unmuted', () => {
    const store = createStateStore();
    applyGatewayEvent(store, dispatch('CallStart', callStart()));
    applyGatewayEvent(store, dispatch('CallUpdate', callUpdate({ user_id: USER_B, leg: 'leg-b-1' })));

    // Deafen WITHOUT explicit mute: the roster still shows muted (AM12's
    // implication — the row never renders deafened-but-unmuted).
    applyGatewayEvent(
      store,
      dispatch('CallUpdate', callUpdate({ user_id: USER_B, leg: 'leg-b-1', state: 'deafened' })),
    );
    expect(store.getState().callByChannel[CHANNEL]!.participants[USER_B]).toMatchObject({
      mute: true,
      deafen: true,
    });

    // Undeafen with explicit mute still held: NO unmuted transition rides
    // the wire (the composite flag never dropped) — mute stays true.
    applyGatewayEvent(
      store,
      dispatch('CallUpdate', callUpdate({ user_id: USER_B, leg: 'leg-b-1', state: 'undeafened' })),
    );
    expect(store.getState().callByChannel[CHANNEL]!.participants[USER_B]).toMatchObject({
      mute: true,
      deafen: false,
    });

    // Undeafen WITHOUT explicit mute: the server's paired `unmuted`
    // transition is what clears the implied mute.
    applyGatewayEvent(
      store,
      dispatch('CallUpdate', callUpdate({ user_id: USER_B, leg: 'leg-b-1', state: 'deafened' })),
    );
    applyGatewayEvent(
      store,
      dispatch('CallUpdate', callUpdate({ user_id: USER_B, leg: 'leg-b-1', state: 'undeafened' })),
    );
    applyGatewayEvent(
      store,
      dispatch('CallUpdate', callUpdate({ user_id: USER_B, leg: 'leg-b-3', state: 'unmuted' })),
    );
    expect(store.getState().callByChannel[CHANNEL]!.participants[USER_B]).toMatchObject({
      mute: false,
      deafen: false,
    });
  });

  it('left/displaced/forced_leave remove the leg; the LAST leg does not end the call', () => {
    const store = createStateStore();
    applyGatewayEvent(store, dispatch('CallStart', callStart()));
    applyGatewayEvent(store, dispatch('CallUpdate', callUpdate({ user_id: USER_A })));
    applyGatewayEvent(store, dispatch('CallUpdate', callUpdate({ user_id: USER_B, leg: 'leg-b-1' })));

    applyGatewayEvent(
      store,
      dispatch('CallUpdate', callUpdate({ user_id: USER_A, state: 'displaced' })),
    );
    expect(store.getState().callByChannel[CHANNEL]!.participants[USER_A]).toBeUndefined();
    expect(store.getState().callByChannel[CHANNEL]!.participants[USER_B]).toBeDefined();

    applyGatewayEvent(
      store,
      dispatch('CallUpdate', callUpdate({ user_id: USER_B, state: 'forced_leave' })),
    );
    // Empty call survives — CALL_END owns deletion (the 60s sweep window, R8).
    expect(store.getState().callByChannel[CHANNEL]).toMatchObject({ call_id: CALL });
    expect(Object.keys(store.getState().callByChannel[CHANNEL]!.participants)).toHaveLength(0);

    applyGatewayEvent(store, dispatch('CallEnd', callEnd()));
    expect(store.getState().callByChannel[CHANNEL]).toBeUndefined();
  });

  it('keeps the standing-thread mapping after CALL_END (reused by the next call)', () => {
    const store = createStateStore();
    applyGatewayEvent(store, dispatch('CallStart', callStart()));
    applyGatewayEvent(store, dispatch('CallEnd', callEnd()));
    expect(store.getState().callLogThreadIdByChannel[CHANNEL]).toBe(CALL_LOG_THREAD);
  });
});

// ---------------------------------------------------------------------------
// DM calls
// ---------------------------------------------------------------------------

describe('DM calls (R11 — separate slice, no thread artifact)', () => {
  it('thread_id null routes to dmCallByChannel with no mapping and no room entry', () => {
    const store = createStateStore();
    applyGatewayEvent(
      store,
      dispatch('CallStart', callStart({ channel_id: DM_CHANNEL, thread_id: null })),
    );
    const s = store.getState();
    expect(s.callByChannel[DM_CHANNEL]).toBeUndefined();
    expect(s.dmCallByChannel[DM_CHANNEL]).toMatchObject({
      call_id: CALL,
      thread_id: null,
      started_by: USER_A,
    });
    expect(s.callLogThreadIdByChannel[DM_CHANNEL]).toBeUndefined();
  });

  it('CALL_UPDATE routes to the DM call and CALL_END removes it', () => {
    const store = createStateStore();
    applyGatewayEvent(
      store,
      dispatch('CallStart', callStart({ channel_id: DM_CHANNEL, thread_id: null })),
    );
    applyGatewayEvent(
      store,
      dispatch(
        'CallUpdate',
        callUpdate({ channel_id: DM_CHANNEL, user_id: USER_B, leg: 'leg-b-1' }),
      ),
    );
    expect(store.getState().dmCallByChannel[DM_CHANNEL]!.participants[USER_B]).toBeDefined();

    applyGatewayEvent(
      store,
      dispatch('CallEnd', callEnd({ channel_id: DM_CHANNEL })),
    );
    expect(store.getState().dmCallByChannel[DM_CHANNEL]).toBeUndefined();
  });

  it('a room call and a DM call coexist without cross-talk', () => {
    const store = createStateStore();
    applyGatewayEvent(store, dispatch('CallStart', callStart()));
    applyGatewayEvent(
      store,
      dispatch('CallStart', callStart({ channel_id: DM_CHANNEL, thread_id: null, call_id: CALL_2 })),
    );
    // An update for the DM call_id must not touch the room call.
    applyGatewayEvent(
      store,
      dispatch(
        'CallUpdate',
        callUpdate({ channel_id: DM_CHANNEL, call_id: CALL_2, user_id: USER_B }),
      ),
    );
    const s = store.getState();
    expect(Object.keys(s.callByChannel[CHANNEL]!.participants)).toHaveLength(0);
    expect(Object.keys(s.dmCallByChannel[DM_CHANNEL]!.participants)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Calls V2 wire surface — source states + roster sources (calls V2 plan U4:
// U2's bridge became real — the roster's source slice exists)
// ---------------------------------------------------------------------------

describe('calls V2 sources (CALL_UPDATE source states mutate participant sources)', () => {
  it('every *_on adds its source (idempotent, with a synthesized since); *_off removes it; mute/deafen coexist', () => {
    const store = createStateStore();
    applyGatewayEvent(store, dispatch('CallStart', callStart()));
    applyGatewayEvent(
      store,
      dispatch('CallUpdate', callUpdate({ user_id: USER_B, leg: 'leg-b-1' })),
    );

    const on = (
      state: Extract<CallUpdate['state'], 'camera_on' | 'screen_on' | 'screen_audio_on' | 'camera_off' | 'screen_off' | 'screen_audio_off'>,
      source: NonNullable<CallUpdate['source']>,
    ): void => {
      applyGatewayEvent(
        store,
        dispatch('CallUpdate', callUpdate({ user_id: USER_B, leg: 'leg-b-1', state, source })),
      );
    };

    on('camera_on', 'camera');
    on('screen_on', 'screen');
    on('screen_audio_on', 'screen_audio');
    on('camera_on', 'camera'); // idempotent re-add never duplicates

    let roster = store.getState().callByChannel[CHANNEL]!.participants;
    expect(roster[USER_B]!.sources!.map((s) => s.source)).toEqual([
      'camera',
      'screen',
      'screen_audio',
    ]);
    // Transition-added sources synthesize a recency stamp (the CallRing
    // precedent — the wire event carries no clock) for stage-follows (VM4).
    expect(roster[USER_B]!.sources![0]!.since).toBeDefined();

    on('screen_off', 'screen');
    on('screen_audio_off', 'screen_audio');
    roster = store.getState().callByChannel[CHANNEL]!.participants;
    expect(roster[USER_B]!.sources!.map((s) => s.source)).toEqual(['camera']);
    expect(roster[USER_B]!.mute).toBe(false); // untouched by source churn

    on('camera_off', 'camera');
    roster = store.getState().callByChannel[CHANNEL]!.participants;
    // Elided-when-empty: audio-only participants keep the V1 shape.
    expect(roster[USER_B]!.sources).toBeUndefined();
    expect('sources' in roster[USER_B]!).toBe(false);

    // Mute/deafen transitions still refresh the leg and keep sources.
    on('camera_on', 'camera');
    applyGatewayEvent(
      store,
      dispatch('CallUpdate', callUpdate({ user_id: USER_B, leg: 'leg-b-1', state: 'muted' })),
    );
    roster = store.getState().callByChannel[CHANNEL]!.participants;
    expect(roster[USER_B]!.mute).toBe(true);
    expect(roster[USER_B]!.sources!.map((s) => s.source)).toEqual(['camera']);
  });

  it('a source state for an unknown call/channel is an inert no-op (no phantom slices)', () => {
    const store = createStateStore();
    applyGatewayEvent(
      store,
      dispatch('CallUpdate', callUpdate({ state: 'camera_on', source: 'camera' })),
    );
    const s = store.getState();
    expect(s.callByChannel[CHANNEL]).toBeUndefined();
    expect(s.dmCallByChannel[CHANNEL]).toBeUndefined();
  });

  it('a fresh `joined` resets sources (a new leg has published nothing yet)', () => {
    const store = createStateStore();
    applyGatewayEvent(store, dispatch('CallStart', callStart()));
    applyGatewayEvent(
      store,
      dispatch('CallUpdate', callUpdate({ user_id: USER_B, leg: 'leg-b-1' })),
    );
    applyGatewayEvent(
      store,
      dispatch('CallUpdate', callUpdate({ user_id: USER_B, leg: 'leg-b-1', state: 'camera_on', source: 'camera' })),
    );
    expect(
      store.getState().callByChannel[CHANNEL]!.participants[USER_B]!.sources,
    ).toBeDefined();

    // Leave + rejoin: the new leg carries no sources.
    applyGatewayEvent(
      store,
      dispatch('CallUpdate', callUpdate({ user_id: USER_B, leg: 'leg-b-1', state: 'left' })),
    );
    applyGatewayEvent(
      store,
      dispatch('CallUpdate', callUpdate({ user_id: USER_B, leg: 'leg-b-9' })),
    );
    expect(store.getState().callByChannel[CHANNEL]!.participants[USER_B]).toEqual({
      user_id: USER_B,
      mute: false,
      deafen: false,
      leg: 'leg-b-9',
    });
  });

  it('CALL_SYNC rosters carrying sources project THROUGH (authoritative replace)', () => {
    const store = createStateStore();
    applyGatewayEvent(
      store,
      dispatch(
        'CallSync',
        callSync({
          calls: [
            {
              channel_id: CHANNEL,
              call_id: CALL,
              thread_id: CALL_LOG_THREAD,
              participants: [
                {
                  user_id: USER_A,
                  mute: false,
                  deafen: false,
                  sources: [
                    { source: 'camera', since: '2026-09-07T12:00:00.000Z' },
                    { source: 'screen' },
                  ],
                },
                { user_id: USER_B, mute: true, deafen: false, sources: [] },
              ],
            },
          ],
          dm_calls: [],
        }),
      ),
    );
    const roster = store.getState().callByChannel[CHANNEL]!.participants;
    expect(roster[USER_A]!.sources).toEqual([
      { source: 'camera', since: '2026-09-07T12:00:00.000Z' },
      { source: 'screen' },
    ]);
    // Empty sources elide (audio-only shape); absent sources too.
    expect(roster[USER_B]!.sources).toBeUndefined();
    expect('sources' in roster[USER_B]!).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Calls V2 publish-state projections (U4 — who's publishing what, since when)
// ---------------------------------------------------------------------------

describe('calls V2 publish-state selectors', () => {
  function seeded(): ReturnType<typeof createStateStore> {
    const store = createStateStore();
    applyGatewayEvent(store, dispatch('CallStart', callStart()));
    applyGatewayEvent(store, dispatch('CallUpdate', callUpdate({ user_id: USER_A, leg: 'a' })));
    applyGatewayEvent(
      store,
      dispatch('CallUpdate', callUpdate({ user_id: USER_B, leg: 'b' })),
    );
    return store;
  }

  it('selectCameraPublishers / selectScreenSharers: most-recent first, since carried (VM4)', () => {
    const store = seeded();
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(1_800_000_000_000);
      applyGatewayEvent(
        store,
        dispatch('CallUpdate', callUpdate({ user_id: USER_A, leg: 'a', state: 'camera_on', source: 'camera' })),
      );
      nowSpy.mockReturnValue(1_800_000_005_000);
      applyGatewayEvent(
        store,
        dispatch('CallUpdate', callUpdate({ user_id: USER_B, leg: 'b', state: 'camera_on', source: 'camera' })),
      );
      applyGatewayEvent(
        store,
        dispatch('CallUpdate', callUpdate({ user_id: USER_A, leg: 'a', state: 'screen_on', source: 'screen' })),
      );

      const state = store.getState();
      const cameras = selectCameraPublishers(state, CHANNEL);
      expect(cameras.map((c) => c.user_id)).toEqual([USER_B, USER_A]); // B newer
      expect(cameras[0]!.since! > cameras[1]!.since!).toBe(true);
      expect(selectScreenSharers(state, CHANNEL).map((s) => s.user_id)).toEqual([USER_A]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('selectParticipantSources + selectIsPublishing read one participant', () => {
    const store = seeded();
    applyGatewayEvent(
      store,
      dispatch('CallUpdate', callUpdate({ user_id: USER_A, leg: 'a', state: 'screen_on', source: 'screen' })),
    );
    applyGatewayEvent(
      store,
      dispatch('CallUpdate', callUpdate({ user_id: USER_A, leg: 'a', state: 'screen_audio_on', source: 'screen_audio' })),
    );
    const state = store.getState();
    expect(selectParticipantSources(state, CHANNEL, USER_A).map((s) => s.source)).toEqual([
      'screen',
      'screen_audio',
    ]);
    expect(selectIsPublishing(state, CHANNEL, USER_A, 'screen')).toBe(true);
    expect(selectIsPublishing(state, CHANNEL, USER_A, 'camera')).toBe(false);
    expect(selectParticipantSources(state, CHANNEL, USER_B)).toEqual([]);
    expect(selectCameraPublishers(state, DM_CHANNEL)).toEqual([]); // no call there
  });

  it('departure removes the participant with their sources (no orphans)', () => {
    const store = seeded();
    applyGatewayEvent(
      store,
      dispatch('CallUpdate', callUpdate({ user_id: USER_A, leg: 'a', state: 'camera_on', source: 'camera' })),
    );
    applyGatewayEvent(
      store,
      dispatch('CallUpdate', callUpdate({ user_id: USER_A, leg: 'a', state: 'left' })),
    );
    const state = store.getState();
    expect(selectCameraPublishers(state, CHANNEL)).toEqual([]);
    expect(state.callByChannel[CHANNEL]!.participants[USER_A]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// CALL_SYNC
// ---------------------------------------------------------------------------

describe('CALL_SYNC (R9 — per-recipient authoritative full replace)', () => {
  it('replaces BOTH call slices entirely; absent channels lose stale entries', () => {
    const store = createStateStore();
    // Stale pre-sync knowledge: a live call on CHANNEL and a stale DM call.
    applyGatewayEvent(store, dispatch('CallStart', callStart()));
    applyGatewayEvent(
      store,
      dispatch('CallStart', callStart({ channel_id: DM_CHANNEL, thread_id: null, call_id: CALL_2 })),
    );

    applyGatewayEvent(
      store,
      dispatch(
        'CallSync',
        callSync({
          calls: [
            {
              channel_id: CHANNEL_2,
              call_id: CALL_2,
              thread_id: OTHER_THREAD,
              participants: [{ user_id: USER_A, mute: false, deafen: false }],
            },
          ],
          dm_calls: [],
        }),
      ),
    );

    const s = store.getState();
    expect(s.callByChannel[CHANNEL]).toBeUndefined(); // absent from sync → gone
    expect(s.callByChannel[CHANNEL_2]).toMatchObject({ call_id: CALL_2 });
    expect(s.dmCallByChannel[DM_CHANNEL]).toBeUndefined(); // dm_calls empty → gone
  });

  it('empty arrays clear both slices (no live call visible)', () => {
    const store = createStateStore();
    applyGatewayEvent(store, dispatch('CallStart', callStart()));
    applyGatewayEvent(
      store,
      dispatch('CallSync', callSync({ calls: [], dm_calls: [] })),
    );
    const s = store.getState();
    expect(s.callByChannel).toEqual({});
    expect(s.dmCallByChannel).toEqual({});
  });

  it('carries the roster projection (leg-less) keyed by user', () => {
    const store = createStateStore();
    applyGatewayEvent(
      store,
      dispatch(
        'CallSync',
        callSync({
          calls: [
            {
              channel_id: CHANNEL,
              call_id: CALL,
              thread_id: CALL_LOG_THREAD,
              participants: [
                { user_id: USER_A, mute: false, deafen: false },
                { user_id: USER_B, mute: true, deafen: true },
              ],
            },
          ],
          dm_calls: [],
        }),
      ),
    );
    const participants = store.getState().callByChannel[CHANNEL]!.participants;
    expect(participants[USER_B]).toEqual({ user_id: USER_B, mute: true, deafen: true, leg: null });
    expect(Object.keys(participants)).toHaveLength(2);
  });

  it('keeps started_by/started_at for a known call_id; null when sync-only', () => {
    const store = createStateStore();
    applyGatewayEvent(store, dispatch('CallStart', callStart()));
    applyGatewayEvent(
      store,
      dispatch(
        'CallSync',
        callSync({
          calls: [
            {
              channel_id: CHANNEL,
              call_id: CALL, // same call as the START we saw
              thread_id: CALL_LOG_THREAD,
              participants: [{ user_id: USER_A, mute: false, deafen: false }],
            },
            {
              channel_id: CHANNEL_2,
              call_id: CALL_2, // never seen live — no boundary metadata
              thread_id: OTHER_THREAD,
              participants: [],
            },
          ],
          dm_calls: [],
        }),
      ),
    );
    expect(store.getState().callByChannel[CHANNEL]).toMatchObject({
      started_by: USER_A,
      started_at: '2026-09-06T12:00:00.000Z',
    });
    expect(store.getState().callByChannel[CHANNEL_2]).toMatchObject({
      started_by: null,
      started_at: null,
    });
  });

  it('seeds the standing-thread mapping and RETAINS it for unmentioned channels', () => {
    const store = createStateStore();
    applyGatewayEvent(store, dispatch('CallStart', callStart())); // seeds CHANNEL
    applyGatewayEvent(
      store,
      dispatch(
        'CallSync',
        callSync({
          calls: [
            {
              channel_id: CHANNEL_2,
              call_id: CALL_2,
              thread_id: OTHER_THREAD,
              participants: [],
            },
          ],
          dm_calls: [],
        }),
      ),
    );
    const mapping = store.getState().callLogThreadIdByChannel;
    expect(mapping[CHANNEL]).toBe(CALL_LOG_THREAD); // durable — kept though absent
    expect(mapping[CHANNEL_2]).toBe(OTHER_THREAD);
  });

  it('tolerates entries for channels the client knows nothing about yet (late hydration)', () => {
    const store = createStateStore(); // no channels hydrated at all
    expect(() =>
      applyGatewayEvent(
        store,
        dispatch(
          'CallSync',
          callSync({
            calls: [
              {
                channel_id: CHANNEL,
                call_id: CALL,
                thread_id: CALL_LOG_THREAD,
                participants: [{ user_id: USER_A, mute: false, deafen: false }],
              },
            ],
            dm_calls: [
              {
                channel_id: DM_CHANNEL,
                call_id: CALL_2,
                participants: [{ user_id: USER_B, mute: false, deafen: true }],
              },
            ],
          }),
        ),
      ),
    ).not.toThrow();
    expect(store.getState().callByChannel[CHANNEL]).toMatchObject({ call_id: CALL });
    expect(store.getState().dmCallByChannel[DM_CHANNEL]!.participants[USER_B]).toMatchObject({
      deafen: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Out-of-order / idempotency
// ---------------------------------------------------------------------------

describe('out-of-order replay gaps are idempotent', () => {
  it('CALL_END before any start is a no-op', () => {
    const store = createStateStore();
    applyGatewayEvent(store, dispatch('CallEnd', callEnd()));
    expect(store.getState().callByChannel[CHANNEL]).toBeUndefined();
  });

  it('a late CALL_UPDATE after END creates no phantom call', () => {
    const store = createStateStore();
    applyGatewayEvent(store, dispatch('CallStart', callStart()));
    applyGatewayEvent(store, dispatch('CallEnd', callEnd()));
    // Buffered update delivered after the END (replay gap).
    applyGatewayEvent(store, dispatch('CallUpdate', callUpdate({ user_id: USER_B })));
    expect(store.getState().callByChannel[CHANNEL]).toBeUndefined();
  });

  it('double CALL_END is idempotent', () => {
    const store = createStateStore();
    applyGatewayEvent(store, dispatch('CallStart', callStart()));
    applyGatewayEvent(store, dispatch('CallEnd', callEnd()));
    applyGatewayEvent(store, dispatch('CallEnd', callEnd({ reason: 'swept' })));
    expect(store.getState().callByChannel[CHANNEL]).toBeUndefined();
  });

  it('a stale-call_id END never deletes a NEWER call on the same channel', () => {
    const store = createStateStore();
    applyGatewayEvent(store, dispatch('CallStart', callStart()));
    applyGatewayEvent(store, dispatch('CallEnd', callEnd()));
    applyGatewayEvent(
      store,
      dispatch('CallStart', callStart({ call_id: CALL_2, started_by: USER_B })),
    );
    // Stale END for the FIRST call arrives late.
    applyGatewayEvent(store, dispatch('CallEnd', callEnd()));
    expect(store.getState().callByChannel[CHANNEL]).toMatchObject({ call_id: CALL_2 });
  });

  it('a state change for an unknown leg is a no-op (roster repair is CALL_SYNC)', () => {
    const store = createStateStore();
    applyGatewayEvent(store, dispatch('CallStart', callStart()));
    applyGatewayEvent(
      store,
      dispatch('CallUpdate', callUpdate({ user_id: USER_B, state: 'muted' })),
    );
    expect(store.getState().callByChannel[CHANNEL]!.participants[USER_B]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// CALL_RING
// ---------------------------------------------------------------------------

describe('CALL_RING (ephemeral slot, call_id dedupe)', () => {
  it('stores the ring outside the call slices, stamped on arrival', () => {
    const store = createStateStore();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    applyGatewayEvent(
      store,
      dispatch('CallRing', { channel_id: CHANNEL, call_id: CALL, from_user: USER_A }),
    );
    expect(store.getState().callByChannel[CHANNEL]).toBeUndefined(); // never a call slice
    expect(store.getState().callRingByChannel[CHANNEL]).toEqual({
      call_id: CALL,
      from_user: USER_A,
      rang_at: 1_700_000_000_000,
    });
    nowSpy.mockRestore();
  });

  it('dedupes a re-delivered ring by call_id without extending the window', () => {
    const store = createStateStore();
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_700_000_000_000);
    applyGatewayEvent(
      store,
      dispatch('CallRing', { channel_id: CHANNEL, call_id: CALL, from_user: USER_A }),
    );
    nowSpy.mockReturnValue(1_700_000_030_000); // 30s later — original must win
    applyGatewayEvent(
      store,
      dispatch('CallRing', { channel_id: CHANNEL, call_id: CALL, from_user: USER_A }),
    );
    expect(store.getState().callRingByChannel[CHANNEL]!.rang_at).toBe(1_700_000_000_000);
    nowSpy.mockRestore();
  });

  it('replaces the slot when a NEW call rings on the same channel', () => {
    const store = createStateStore();
    applyGatewayEvent(
      store,
      dispatch('CallRing', { channel_id: CHANNEL, call_id: CALL, from_user: USER_A }),
    );
    applyGatewayEvent(
      store,
      dispatch('CallRing', { channel_id: CHANNEL, call_id: CALL_2, from_user: USER_B }),
    );
    expect(store.getState().callRingByChannel[CHANNEL]).toMatchObject({
      call_id: CALL_2,
      from_user: USER_B,
    });
  });

  it('CALL_END leaves the ring readable (U10 missed-call derivation) — clearCallRing owns removal', () => {
    const store = createStateStore();
    applyGatewayEvent(
      store,
      dispatch('CallRing', { channel_id: CHANNEL, call_id: CALL, from_user: USER_A }),
    );
    applyGatewayEvent(store, dispatch('CallEnd', callEnd()));
    expect(store.getState().callRingByChannel[CHANNEL]).toMatchObject({ call_id: CALL });

    clearCallRing(store, CHANNEL);
    expect(store.getState().callRingByChannel[CHANNEL]).toBeUndefined();
  });

  it('a fresh READY clears the ring slot with the rest of the transient state', () => {
    const store = createStateStore();
    applyGatewayEvent(
      store,
      dispatch('CallRing', { channel_id: CHANNEL, call_id: CALL, from_user: USER_A }),
    );
    applyGatewayEvent(
      store,
      dispatch('Ready', {
        v: 1,
        session_id: 'sess-1',
        resume_token: 'rt-1',
        heartbeat_interval: 41250,
        user: { id: ME, username: 'mee' },
      } satisfies Ready),
    );
    expect(store.getState().callRingByChannel[CHANNEL]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Call-log exclusion (R5 — the security-reviewed fix)
// ---------------------------------------------------------------------------

describe('call-log MessageCreate exclusion (R5)', () => {
  /**
   * The excluded scenario: a call-log message (thread_id = the channel's
   * standing thread) authored by someone else while I am connected. Channel
   * surfaces must stay untouched; the thread pane keeps working.
   */
  function arrange(store = createStateStore()) {
    store.setState({ currentUser: { id: ME, username: 'mee' } });
    applyGatewayEvent(store, dispatch('CallStart', callStart()));
    return store;
  }

  it('keeps the message out of the channel timeline and leaves channel unread untouched', () => {
    const store = arrange();
    applyGatewayEvent(
      store,
      dispatch('MessageCreate', channelMessage({ thread_id: CALL_LOG_THREAD })),
    );
    const s = store.getState();
    expect(s.messagesByChannel[CHANNEL]).toBeUndefined();
    expect(s.unreadByChannel[CHANNEL]).toBeUndefined(); // no accrual at all
  });

  it('does not bump channels.last_message_id from call-log chatter', () => {
    const store = arrange();
    store.setState((s) => ({
      channels: {
        ...s.channels,
        [CHANNEL]: {
          id: CHANNEL,
          workspace_id: '6000000000000001',
          name: 'general',
          type: 'text',
          topic: null,
          position: 0,
          last_message_id: '1000000000000099',
          created_at: '2026-09-06T00:00:00Z',
        },
      },
    }));
    applyGatewayEvent(
      store,
      dispatch(
        'MessageCreate',
        channelMessage({ id: '1000000000000100', thread_id: CALL_LOG_THREAD }),
      ),
    );
    expect(store.getState().channels[CHANNEL]!.last_message_id).toBe('1000000000000099');
  });

  it('still lands in the thread store and accrues thread unread (thread pane unaffected)', () => {
    const store = arrange();
    applyGatewayEvent(store, dispatch('ThreadMessageCreate', threadMessage()));
    const s = store.getState();
    expect(s.messagesByThread[CALL_LOG_THREAD]!.items).toHaveLength(1);
    expect(s.messagesByThread[CALL_LOG_THREAD]!.items[0]!.content).toBe('call-log chatter');
    expect(s.unreadByThread[CALL_LOG_THREAD]).toMatchObject({ unread_count: 1 });
  });

  it('learns the mapping from CALL_SYNC too', () => {
    const store = createStateStore();
    store.setState({ currentUser: { id: ME, username: 'mee' } });
    applyGatewayEvent(
      store,
      dispatch(
        'CallSync',
        callSync({
          calls: [
            {
              channel_id: CHANNEL,
              call_id: CALL,
              thread_id: CALL_LOG_THREAD,
              participants: [],
            },
          ],
          dm_calls: [],
        }),
      ),
    );
    applyGatewayEvent(
      store,
      dispatch('MessageCreate', channelMessage({ thread_id: CALL_LOG_THREAD })),
    );
    expect(store.getState().messagesByChannel[CHANNEL]).toBeUndefined();
    expect(store.getState().unreadByChannel[CHANNEL]).toBeUndefined();
  });

  it('learns the mapping from REST hydration via setCallLogThread (GET /channels/{id}/call)', () => {
    const store = createStateStore();
    store.setState({ currentUser: { id: ME, username: 'mee' } });
    setCallLogThread(store, CHANNEL, CALL_LOG_THREAD);
    applyGatewayEvent(
      store,
      dispatch('MessageCreate', channelMessage({ thread_id: CALL_LOG_THREAD })),
    );
    expect(store.getState().messagesByChannel[CHANNEL]).toBeUndefined();
    expect(store.getState().callLogThreadIdByChannel[CHANNEL]).toBe(CALL_LOG_THREAD);
  });

  it('setCallLogThread ignores null (DM channels keep no log) and is idempotent', () => {
    const store = createStateStore();
    setCallLogThread(store, CHANNEL, null);
    expect(store.getState().callLogThreadIdByChannel[CHANNEL]).toBeUndefined();
    setCallLogThread(store, CHANNEL, CALL_LOG_THREAD);
    const before = store.getState().callLogThreadIdByChannel;
    setCallLogThread(store, CHANNEL, CALL_LOG_THREAD);
    expect(store.getState().callLogThreadIdByChannel).toBe(before); // same reference
  });

  it('thread replies (any thread) stay OUT of the channel timeline', () => {
    // Discord semantics (2026-09-10): thread replies belong to their thread
    // slice; the channel shows the seed + its indicator. The server's
    // channel read filters them the same way.
    const store = arrange();
    applyGatewayEvent(
      store,
      dispatch('MessageCreate', channelMessage({ id: '1000000000000011', thread_id: OTHER_THREAD })),
    );
    const s = store.getState();
    expect(s.messagesByChannel[CHANNEL]?.items ?? []).toHaveLength(0);
    expect(s.unreadByChannel[CHANNEL]).toBeUndefined();
  });

  it('plain channel messages (thread_id null) are unaffected', () => {
    const store = arrange();
    applyGatewayEvent(store, dispatch('MessageCreate', channelMessage()));
    expect(store.getState().messagesByChannel[CHANNEL]!.items).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// REST history filter (belt-and-braces over the server-side exclusion)
// ---------------------------------------------------------------------------

describe('mergeChannelMessages filters call-log rows from REST pages', () => {
  it('drops rows whose thread_id is the channel\'s standing thread', () => {
    const store = createStateStore();
    setCallLogThread(store, CHANNEL, CALL_LOG_THREAD);
    mergeChannelMessages(store, CHANNEL, [
      channelMessage({ id: '1000000000000021' }),
      channelMessage({ id: '1000000000000022', thread_id: CALL_LOG_THREAD }), // excluded
      channelMessage({ id: '1000000000000020', thread_id: OTHER_THREAD }), // normal thread row
    ]);
    const slice = store.getState().messagesByChannel[CHANNEL]!;
    expect(slice.items.map((m) => m.id)).toEqual(['1000000000000021', '1000000000000020']);
    expect(slice.oldestId).toBe('1000000000000020'); // cursor skips the filtered row
  });

  it('merges everything when the channel has no known mapping yet', () => {
    const store = createStateStore();
    mergeChannelMessages(store, CHANNEL, [
      channelMessage({ id: '1000000000000021' }),
      channelMessage({ id: '1000000000000022', thread_id: CALL_LOG_THREAD }),
    ]);
    expect(store.getState().messagesByChannel[CHANNEL]!.items).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Session reset
// ---------------------------------------------------------------------------

describe('READY reset clears the call slices (CALL_SYNC re-seeds)', () => {
  it('fresh READY wipes call/dmCall/ring but keeps the durable mapping; resetForFreshSession clears all', () => {
    const store = createStateStore();
    applyGatewayEvent(store, dispatch('CallStart', callStart()));
    applyGatewayEvent(
      store,
      dispatch('CallStart', callStart({ channel_id: DM_CHANNEL, thread_id: null })),
    );
    applyGatewayEvent(
      store,
      dispatch('CallRing', { channel_id: CHANNEL, call_id: CALL, from_user: USER_A }),
    );
    applyGatewayEvent(
      store,
      dispatch('Ready', {
        v: 1,
        session_id: 'sess-2',
        resume_token: 'rt-2',
        heartbeat_interval: 41250,
        user: { id: ME, username: 'mee' },
      } satisfies Ready),
    );
    const s = store.getState();
    expect(s.callByChannel).toEqual({});
    expect(s.dmCallByChannel).toEqual({});
    // The standing-thread mapping is durable per channel (R4) — the call-log
    // exclusion must keep working across a reconnect (lane D #1: READY
    // resets session state only).
    expect(s.callLogThreadIdByChannel).toEqual({ [CHANNEL]: CALL_LOG_THREAD });
    expect(s.callRingByChannel).toEqual({});

    // And the logout path clears everything, the mapping included.
    applyGatewayEvent(store, dispatch('CallStart', callStart()));
    resetForFreshSession(store);
    expect(store.getState().callByChannel).toEqual({});
    expect(store.getState().callLogThreadIdByChannel).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Projections (U7/U9/U10 read surface)
// ---------------------------------------------------------------------------

describe('call projections', () => {
  function seeded() {
    const store = createStateStore();
    applyGatewayEvent(store, dispatch('CallStart', callStart()));
    applyGatewayEvent(store, dispatch('CallUpdate', callUpdate({ user_id: USER_A })));
    applyGatewayEvent(store, dispatch('CallUpdate', callUpdate({ user_id: USER_B, leg: 'leg-b-1' })));
    applyGatewayEvent(
      store,
      dispatch('CallStart', callStart({ channel_id: CHANNEL_2, call_id: CALL_2 })),
    );
    return store;
  }

  it('roster is sorted by user id; count and membership derive from it', () => {
    const store = seeded();
    const state = store.getState();
    const roster = selectCallRoster(state, CHANNEL);
    expect(roster.map((p) => p.user_id)).toEqual([USER_A, USER_B]);
    expect(selectParticipantCount(state, CHANNEL)).toBe(2);
    expect(selectIsInCall(state, CHANNEL, USER_B)).toBe(true);
    expect(selectIsInCall(state, CHANNEL, ME)).toBe(false);
  });

  it('live-call selectors and the slot id list', () => {
    const store = seeded();
    const state = store.getState();
    expect(selectLiveCall(state, CHANNEL)!.call_id).toBe(CALL);
    expect(selectLiveCall(state, DM_CHANNEL)).toBeUndefined();
    expect(selectDmCall(state, DM_CHANNEL)).toBeUndefined();
    expect(selectLiveCallChannelIds(state)).toEqual([CHANNEL, CHANNEL_2]);
  });

  it('idle channels project an empty roster and no thread id until learned', () => {
    const store = createStateStore();
    const state = store.getState();
    expect(selectCallRoster(state, CHANNEL)).toEqual([]);
    expect(selectParticipantCount(state, CHANNEL)).toBe(0);
    expect(selectCallLogThreadId(state, CHANNEL)).toBeUndefined();
    expect(selectCallRing(state, CHANNEL)).toBeUndefined();
  });

  it('the standing-thread id and ring project once populated', () => {
    const store = seeded();
    store.setState({ currentUser: { id: ME, username: 'mee' } });
    applyGatewayEvent(
      store,
      dispatch('CallRing', { channel_id: CHANNEL, call_id: CALL, from_user: USER_A }),
    );
    const state = store.getState();
    expect(selectCallLogThreadId(state, CHANNEL)).toBe(CALL_LOG_THREAD);
    expect(selectCallRing(state, CHANNEL)).toMatchObject({ call_id: CALL, from_user: USER_A });
  });
});
