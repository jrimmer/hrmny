import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  CALL_CONTROL_ACTIONS,
  CALL_SIGNAL_BODY_MAX_BYTES,
  CALL_SOURCE_KINDS,
  VIDEO_QUALITY_PREFERENCES,
  isCallControlAction,
  isCallSourceKind,
  isVideoQualityPreference,
  type CallSourceKind,
  type GatewayCallStateUpdatePayload,
  type VideoWant,
} from '../payloads.js';
import {
  CALL_MANIFEST_SOURCES,
  CALL_SIGNAL_ENVELOPE_VERSION,
  CALL_UPDATE_STATES,
  isCallManifestSource,
  isCallSignalOfferEnvelope,
  isCallUpdateState,
  parseCallSignalOfferEnvelope,
  type CallParticipant,
  type CallSignal,
  type CallSignalManifestEntry,
  type CallSignalOfferEnvelope,
  type CallSync,
  type CallUpdate,
  type GatewayEvent,
} from '../events.js';

/**
 * Calls V2 plan U2 — the additive wire surface: op-22 publish/unpublish
 * actions with the source discriminant, video_want on `state`, the six
 * CALL_UPDATE source states + `source?`, CALL_SYNC roster `sources[]`, and
 * the CALL_SIGNAL offer envelope v2 carrying the track manifest. Every
 * fixture keeps the house snowflake-string style (> 2^53 — JSON number
 * round-trips would lose precision).
 */

const CH = '9200000000000000100';
const CALL = '9200000000000007001';
const USER_A = '9200000000000000201';
const USER_B = '9200000000000000202';
const TS = '2026-09-07T12:00:00.000Z';

function roundTrip<T>(payload: T): T {
  return JSON.parse(JSON.stringify(payload)) as T;
}

// ---------------------------------------------------------------------------
// op 22 — publish/unpublish actions + the source discriminant
// ---------------------------------------------------------------------------

describe('op 22 publish/unpublish (calls V2 KTD3)', () => {
  it('exposes exactly six actions — publish/unpublish appended additively', () => {
    expect(CALL_CONTROL_ACTIONS).toEqual([
      'start',
      'join',
      'leave',
      'state',
      'publish',
      'unpublish',
    ]);
    for (const action of CALL_CONTROL_ACTIONS) expect(isCallControlAction(action)).toBe(true);
  });

  it('the source discriminant is an exhaustive closed enum with a guard', () => {
    expectTypeOf<CallSourceKind>().toEqualTypeOf<(typeof CALL_SOURCE_KINDS)[number]>();
    expect(CALL_SOURCE_KINDS).toEqual(['camera', 'screen', 'screen_audio']);
    expect(new Set(CALL_SOURCE_KINDS).size).toBe(CALL_SOURCE_KINDS.length);
    for (const kind of CALL_SOURCE_KINDS) expect(isCallSourceKind(kind)).toBe(true);
    // `mic` is deliberately NOT a publish source (KTD3: mute/deafen stay on
    // `state`); it exists only in the manifest source space.
    expect(isCallSourceKind('mic')).toBe(false);
    expect(isCallSourceKind('video')).toBe(false);
    expect(isCallSourceKind(null)).toBe(false);
  });

  it('publish/unpublish round-trip carrying exactly one source each', () => {
    const cmd: GatewayCallStateUpdatePayload = { channel_id: CH, action: 'publish', source: 'camera' };
    expect(roundTrip(cmd)).toEqual({ channel_id: CH, action: 'publish', source: 'camera' });

    const unpublish: GatewayCallStateUpdatePayload = {
      channel_id: CH,
      action: 'unpublish',
      source: 'screen_audio',
    };
    expect(roundTrip(unpublish)).toEqual({
      channel_id: CH,
      action: 'unpublish',
      source: 'screen_audio',
    });

    // No V1 field leaks onto the publish shape.
    expect(Object.keys(cmd).sort()).toEqual(['action', 'channel_id', 'source']);
  });

  it('every source kind publishes and unpublishes (round-trip matrix)', () => {
    for (const source of CALL_SOURCE_KINDS) {
      for (const action of ['publish', 'unpublish'] as const) {
        const parsed = roundTrip<GatewayCallStateUpdatePayload>({ channel_id: CH, action, source });
        expect(parsed.source).toBe(source);
        expect(parsed.action).toBe(action);
      }
    }
  });

  it('source is optional on the payload type (V1 actions compile bare)', () => {
    const start: GatewayCallStateUpdatePayload = { channel_id: CH, action: 'start' };
    expect(start.source).toBeUndefined();
    expectTypeOf<GatewayCallStateUpdatePayload['source']>().toEqualTypeOf<
      CallSourceKind | undefined
    >();
  });
});

// ---------------------------------------------------------------------------
// op 22 — video_want on the state action (KTD7)
// ---------------------------------------------------------------------------

describe('op 22 video_want (calls V2 KTD7)', () => {
  it('declares the quality preference as a closed, ordered enum with a guard', () => {
    expect(VIDEO_QUALITY_PREFERENCES).toEqual(['high', 'medium', 'low']);
    for (const q of VIDEO_QUALITY_PREFERENCES) expect(isVideoQualityPreference(q)).toBe(true);
    expect(isVideoQualityPreference('f')).toBe(false); // rid names are not preferences
    expect(isVideoQualityPreference('HIGH')).toBe(false);
    expect(isVideoQualityPreference(undefined)).toBe(false);
  });

  it('carries tiles + optional max_quality alongside the V1 state fields', () => {
    const want: VideoWant = { tiles: 9, max_quality: 'medium' };
    const cmd: GatewayCallStateUpdatePayload = {
      channel_id: CH,
      action: 'state',
      video_want: want,
    };
    expect(roundTrip(cmd)).toEqual({ channel_id: CH, action: 'state', video_want: want });
    expect(cmd.video_want?.tiles).toBe(9);
  });

  it('admits the minimal shape (tiles only — server-side congestion selection alone)', () => {
    const cmd: GatewayCallStateUpdatePayload = { channel_id: CH, action: 'state', video_want: { tiles: 4 } };
    expect(roundTrip(cmd).video_want).toEqual({ tiles: 4 });
    expectTypeOf<VideoWant['max_quality']>().toEqualTypeOf<
      (typeof VIDEO_QUALITY_PREFERENCES)[number] | undefined
    >();
  });

  it('composes with mute/deafen on the same state op without mutation', () => {
    const cmd: GatewayCallStateUpdatePayload = {
      channel_id: CH,
      action: 'state',
      mute: true,
      deafen: false,
      video_want: { tiles: 1, max_quality: 'low' },
    };
    const parsed = roundTrip(cmd);
    expect(parsed).toEqual(cmd);
    expect(parsed.video_want).toEqual({ tiles: 1, max_quality: 'low' });
  });
});

// ---------------------------------------------------------------------------
// op 22 — mic_granted on the state action (VM5 retryMic's wire half)
// ---------------------------------------------------------------------------

describe('op 22 mic_granted (VM5 retryMic)', () => {
  it('round-trips the listen-only upgrade signal on the state action', () => {
    const cmd: GatewayCallStateUpdatePayload = {
      channel_id: CH,
      action: 'state',
      mic_granted: true,
    };
    const parsed = roundTrip(cmd);
    expect(parsed).toEqual({ channel_id: CH, action: 'state', mic_granted: true });
    expectTypeOf<GatewayCallStateUpdatePayload['mic_granted']>().toEqualTypeOf<
      boolean | undefined
    >();
  });

  it('is optional and additive — absent on every pre-existing op shape', () => {
    const join: GatewayCallStateUpdatePayload = { channel_id: CH, action: 'join' };
    expect(roundTrip(join).mic_granted).toBeUndefined();
    const publish: GatewayCallStateUpdatePayload = {
      channel_id: CH,
      action: 'publish',
      source: 'camera',
    };
    expect('mic_granted' in publish).toBe(false);
    // Composes with the other state fields without mutation.
    const composed: GatewayCallStateUpdatePayload = {
      channel_id: CH,
      action: 'state',
      mute: false,
      mic_granted: true,
      video_want: { tiles: 2 },
    };
    const parsed = roundTrip(composed);
    expect(parsed).toEqual(composed);
    expect(parsed.mic_granted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CALL_UPDATE — the six source states + source?
// ---------------------------------------------------------------------------

describe('CALL_UPDATE source states (calls V2 U2)', () => {
  const SOURCE_STATES = [
    ['camera_on', 'camera'],
    ['camera_off', 'camera'],
    ['screen_on', 'screen'],
    ['screen_off', 'screen'],
    ['screen_audio_on', 'screen_audio'],
    ['screen_audio_off', 'screen_audio'],
  ] as const;

  it('every source state round-trips carrying its source discriminator', () => {
    for (const [state, source] of SOURCE_STATES) {
      const update: CallUpdate = {
        channel_id: CH,
        call_id: CALL,
        user_id: USER_B,
        leg: 'sVbXv2xKqP9mQwRt',
        state,
        source,
      };
      const parsed = roundTrip(update);
      expect(parsed).toEqual(update);
      expect(isCallUpdateState(parsed.state)).toBe(true);
    }
  });

  it('the state↔source pairing is total: each source state names its own source', () => {
    for (const [state, source] of SOURCE_STATES) {
      expect(state.startsWith(source)).toBe(true);
      expect(isCallSourceKind(source)).toBe(true);
    }
  });

  it('source? is additive — V1 states compile and serialize without it', () => {
    const legacy: CallUpdate = {
      channel_id: CH,
      call_id: CALL,
      user_id: USER_B,
      leg: 'sVbXv2xKqP9mQwRt',
      state: 'muted',
    };
    expect(roundTrip(legacy)).toEqual(legacy);
    expect(Object.keys(legacy).sort()).toEqual(['call_id', 'channel_id', 'leg', 'state', 'user_id']);
    expectTypeOf<CallUpdate['source']>().toEqualTypeOf<CallSourceKind | undefined>();
  });

  it('narrows via the GatewayEvent union', () => {
    const envelope: GatewayEvent<'CallUpdate'> = {
      op: 0,
      t: 'CallUpdate',
      s: 72,
      d: {
        channel_id: CH,
        call_id: CALL,
        user_id: USER_B,
        leg: 'sVbXv2xKqP9mQwRt',
        state: 'screen_off',
        source: 'screen',
      },
    };
    expectTypeOf(envelope.d).toEqualTypeOf<CallUpdate>();
    expect(envelope.d.source).toBe('screen');
    expect(CALL_UPDATE_STATES).toContain('screen_off');
  });
});

// ---------------------------------------------------------------------------
// CALL_SYNC — roster sources[] (KTD1: attribution without parsing SDP)
// ---------------------------------------------------------------------------

describe('CALL_SYNC roster sources (calls V2 U2)', () => {
  it('round-trips participants carrying sources with optional since timestamps', () => {
    const publisher: CallParticipant = {
      user_id: USER_A,
      mute: false,
      deafen: false,
      sources: [
        { source: 'camera', since: TS },
        { source: 'screen', since: '2026-09-07T12:10:00.000Z' },
        { source: 'screen_audio' }, // since optional
      ],
    };
    const sync: CallSync = {
      calls: [
        {
          channel_id: CH,
          call_id: CALL,
          thread_id: '9200000000000000301',
          participants: [publisher, { user_id: USER_B, mute: true, deafen: false }],
        },
      ],
      dm_calls: [],
    };
    const parsed = roundTrip(sync);
    expect(parsed).toEqual(sync);
    expect(parsed.calls[0]!.participants[0]!.sources).toHaveLength(3);
    // The audio-only sibling carries NO sources key (absent ≡ none).
    expect('sources' in (parsed.calls[0]!.participants[1] as CallParticipant)).toBe(false);
  });

  it('admits the empty-sources form (explicit [] ≡ audio-only, like absent)', () => {
    const sync: CallSync = {
      calls: [
        {
          channel_id: CH,
          call_id: CALL,
          thread_id: '9200000000000000301',
          participants: [{ user_id: USER_A, mute: false, deafen: false, sources: [] }],
        },
      ],
      dm_calls: [],
    };
    const parsed = roundTrip(sync);
    expect(parsed.calls[0]!.participants[0]!.sources).toEqual([]);
  });

  it('DM call rosters carry sources identically (KDV1 — one media abstraction)', () => {
    const sync: CallSync = {
      calls: [],
      dm_calls: [
        {
          channel_id: '9200000000000000110',
          call_id: '9200000000000007002',
          participants: [
            {
              user_id: USER_B,
              mute: false,
              deafen: false,
              sources: [{ source: 'camera', since: TS }],
            },
          ],
        },
      ],
    };
    const parsed = roundTrip(sync);
    expect(parsed.dm_calls[0]!.participants[0]!.sources).toEqual([
      { source: 'camera', since: TS },
    ]);
  });

  it('every source kind appears in a roster identically (enum totality)', () => {
    const sources = CALL_SOURCE_KINDS.map((source) => ({ source, since: TS }));
    const participant: CallParticipant = {
      user_id: USER_A,
      mute: false,
      deafen: false,
      sources,
    };
    expect(roundTrip(participant).sources).toEqual(sources);
  });
});

// ---------------------------------------------------------------------------
// CALL_SIGNAL — offer envelope v2 (KTD1: the track manifest)
// ---------------------------------------------------------------------------

describe('CALL_SIGNAL offer envelope v2 (calls V2 KTD1)', () => {
  const envelope: CallSignalOfferEnvelope = {
    v: 2,
    type: 'offer',
    sdp: 'v=0\r\no=- 46117317 2 IN IP4 127.0.0.1\r\n',
    tracks: [
      { mid: '0', user_id: USER_A, source: 'mic' },
      { mid: '1', user_id: USER_A, source: 'camera', rids: ['f', 'h', 'q'] },
      { mid: '2', user_id: USER_B, source: 'screen' },
      { mid: '3', user_id: USER_B, source: 'screen_audio' },
    ],
  };

  it('pins the envelope version constant at 2', () => {
    expect(CALL_SIGNAL_ENVELOPE_VERSION).toBe(2);
    expectTypeOf<CallSignalOfferEnvelope['v']>().toEqualTypeOf<2>();
  });

  it('the manifest source space is the publish vocabulary PLUS mic (audio keys on the manifest too)', () => {
    expect(CALL_MANIFEST_SOURCES).toEqual(['mic', 'camera', 'screen', 'screen_audio']);
    for (const source of CALL_MANIFEST_SOURCES) expect(isCallManifestSource(source)).toBe(true);
    // mic is manifest-only: it is not a publishable source kind.
    expect(isCallSourceKind('mic')).toBe(false);
    expect(isCallManifestSource('speaker')).toBe(false);
    expect(isCallManifestSource(2)).toBe(false);
  });

  it('round-trips inside the CALL_SIGNAL event body (still an opaque string)', () => {
    const signal: CallSignal = { channel_id: CH, body: JSON.stringify(envelope) };
    const parsed = roundTrip(signal);
    expect(parsed.body).toBe(signal.body);
    expect(parseCallSignalOfferEnvelope(parsed.body)).toEqual(envelope);
    // The event payload shape itself is unchanged: {channel_id, body}.
    expect(Object.keys(parsed).sort()).toEqual(['body', 'channel_id']);
  });

  it('parses a v2 offer body into the typed manifest', () => {
    const parsed = parseCallSignalOfferEnvelope(JSON.stringify(envelope));
    expect(parsed).not.toBeNull();
    expect(parsed!.type).toBe('offer');
    expect(parsed!.tracks).toHaveLength(4);
    expect(parsed!.tracks[1]).toEqual({
      mid: '1',
      user_id: USER_A,
      source: 'camera',
      rids: ['f', 'h', 'q'],
    });
    // The mid -> (user, source) attribution map U4 builds is a straight fold.
    const byMid = new Map<string, CallSignalManifestEntry>(
      parsed!.tracks.map((t) => [t.mid, t]),
    );
    expect(byMid.get('0')).toMatchObject({ user_id: USER_A, source: 'mic' });
    expect(byMid.get('2')).toMatchObject({ user_id: USER_B, source: 'screen' });
  });

  it('accepts a manifest-less-quality body: rids optional on every entry', () => {
    const minimal: CallSignalOfferEnvelope = {
      v: 2,
      type: 'offer',
      sdp: 'v=0\r\n',
      tracks: [{ mid: '0', user_id: USER_A, source: 'mic' }],
    };
    expect(parseCallSignalOfferEnvelope(JSON.stringify(minimal))).toEqual(minimal);
    expect(minimal.tracks[0]!.rids).toBeUndefined();
  });

  it('accepts an empty tracks array (a re-offer with no media is a valid envelope)', () => {
    const empty: CallSignalOfferEnvelope = { v: 2, type: 'offer', sdp: 'v=0\r\n', tracks: [] };
    expect(isCallSignalOfferEnvelope(empty)).toBe(true);
  });

  it('rejects V1 bodies: bare offers, answers, ICE (answers keep the V1 shape — KTD1)', () => {
    expect(parseCallSignalOfferEnvelope(JSON.stringify({ type: 'offer', sdp: 'v=0\r\n' }))).toBeNull();
    expect(
      parseCallSignalOfferEnvelope(JSON.stringify({ type: 'answer', sdp: 'v=0\r\n' })),
    ).toBeNull();
    expect(
      parseCallSignalOfferEnvelope(
        JSON.stringify({ candidate: 'candidate:1 1 UDP 1 10.0.0.1 50000 typ host', sdpMid: '0', sdpMLineIndex: 0 }),
      ),
    ).toBeNull();
  });

  it('rejects malformed envelope bodies without throwing', () => {
    expect(parseCallSignalOfferEnvelope('not json at all')).toBeNull();
    expect(parseCallSignalOfferEnvelope('')).toBeNull();
    expect(parseCallSignalOfferEnvelope('null')).toBeNull();
    expect(parseCallSignalOfferEnvelope('[]')).toBeNull();
  });

  it('rejects wrong versions, non-offer types, and structurally invalid manifests', () => {
    // Wrong version tag.
    expect(
      isCallSignalOfferEnvelope({ v: 3, type: 'offer', sdp: 'v=0', tracks: [] }),
    ).toBe(false);
    expect(isCallSignalOfferEnvelope({ v: '2', type: 'offer', sdp: 'v=0', tracks: [] })).toBe(false);
    // An answer-shaped envelope is NOT an offer envelope (offers only).
    expect(
      isCallSignalOfferEnvelope({ v: 2, type: 'answer', sdp: 'v=0', tracks: [] }),
    ).toBe(false);
    // Missing sdp / tracks.
    expect(isCallSignalOfferEnvelope({ v: 2, type: 'offer', tracks: [] })).toBe(false);
    expect(isCallSignalOfferEnvelope({ v: 2, type: 'offer', sdp: 'v=0' })).toBe(false);
    // Bad manifest entries.
    expect(
      isCallSignalOfferEnvelope({
        v: 2,
        type: 'offer',
        sdp: 'v=0',
        tracks: [{ mid: '', user_id: USER_A, source: 'mic' }], // empty mid
      }),
    ).toBe(false);
    expect(
      isCallSignalOfferEnvelope({
        v: 2,
        type: 'offer',
        sdp: 'v=0',
        tracks: [{ mid: '0', user_id: 9200000000000000201, source: 'mic' }], // numeric id
      }),
    ).toBe(false);
    expect(
      isCallSignalOfferEnvelope({
        v: 2,
        type: 'offer',
        sdp: 'v=0',
        tracks: [{ mid: '0', user_id: USER_A, source: 'speaker' }], // unknown source
      }),
    ).toBe(false);
    expect(
      isCallSignalOfferEnvelope({
        v: 2,
        type: 'offer',
        sdp: 'v=0',
        tracks: [{ mid: '0', user_id: USER_A, source: 'camera', rids: 'f' }], // rids not an array
      }),
    ).toBe(false);
    expect(
      isCallSignalOfferEnvelope({
        v: 2,
        type: 'offer',
        sdp: 'v=0',
        tracks: [{ mid: '0', user_id: USER_A, source: 'camera', rids: [1, 2] }], // non-string rids
      }),
    ).toBe(false);
    // tracks not an array.
    expect(isCallSignalOfferEnvelope({ v: 2, type: 'offer', sdp: 'v=0', tracks: {} })).toBe(false);
  });

  it('the body cap is the spike-raised 128 KiB: envelope + SDP live under the same budget', () => {
    // VM14: the cap stays 65536 unless the spike measures a breach. The
    // envelope wrapper must not silently change that budget's unit — the
    // CAP applies to the WHOLE body string, envelope JSON included.
    expect(CALL_SIGNAL_BODY_MAX_BYTES).toBe(131_072);
  });
});
