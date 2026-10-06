import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  CALL_CONTROL_ACTIONS,
  CALL_SIGNAL_BODY_MAX_BYTES,
  CALL_SIGNAL_KINDS,
  isCallControlAction,
  isCallSignalKind,
  type GatewayCallSignalPayload,
  type GatewayCallStateUpdatePayload,
} from '../payloads.js';
import {
  type CallEnd,
  type CallRing,
  type CallSignal,
  type CallStart,
  type CallSync,
  type CallUpdate,
  type GatewayEvent,
} from '../events.js';

/**
 * Calls plan U1 — payload round-trips. Every fixture uses snowflakes ABOVE
 * 2^53 (unrepresentable as a JS number): a JSON round-trip that came back
 * as numbers would lose precision and fail these assertions, pinning the
 * house style (snowflakes = decimal strings) to the wire shape.
 */

/** 2^63-ish values: string form is the only lossless encoding. */
const CH = '9200000000000000100';
const CALL = '9200000000000007001';
const THREAD = '9200000000000000301';
const USER_A = '9200000000000000201';
const USER_B = '9200000000000000202';
const TS = '2026-09-06T12:00:00.000Z';

function roundTrip<T>(payload: T): T {
  return JSON.parse(JSON.stringify(payload)) as T;
}

describe('CALL_START payload round-trip', () => {
  it('preserves every field with snowflake-strings intact', () => {
    const start: CallStart = {
      channel_id: CH,
      call_id: CALL,
      thread_id: THREAD,
      started_by: USER_A,
      started_at: TS,
    };
    expect(roundTrip(start)).toEqual(start);
    const parsed = JSON.parse(JSON.stringify(start));
    expect(typeof parsed.channel_id).toBe('string');
    expect(typeof parsed.call_id).toBe('string');
    // Precision proof: the number coercion of these ids is lossy.
    expect(String(Number(CH))).not.toBe(CH);
  });

  it('admits the DM shape (thread_id null)', () => {
    const dm: CallStart = {
      channel_id: CH,
      call_id: CALL,
      thread_id: null,
      started_by: USER_A,
      started_at: TS,
    };
    expect(roundTrip(dm).thread_id).toBeNull();
  });

  it('narrows via the GatewayEvent union', () => {
    const envelope: GatewayEvent<'CallStart'> = { op: 0, t: 'CallStart', s: 1, d: { channel_id: CH, call_id: CALL, thread_id: THREAD, started_by: USER_A, started_at: TS } };
    expectTypeOf(envelope.d).toEqualTypeOf<CallStart>();
    expect(envelope.t).toBe('CallStart');
  });
});

describe('CALL_UPDATE payload round-trip', () => {
  it('carries the AM8 leg discriminator beside the state', () => {
    const update: CallUpdate = {
      channel_id: CH,
      call_id: CALL,
      user_id: USER_B,
      leg: 'sVbXv2xKqP9mQwRt',
      state: 'displaced',
    };
    const parsed = roundTrip(update);
    expect(parsed).toEqual(update);
    expect(parsed.leg).toBe('sVbXv2xKqP9mQwRt');
    expect(parsed.state).toBe('displaced');
  });

  it('round-trips every leg state without mutation', () => {
    for (const state of [
      'joined',
      'left',
      'muted',
      'unmuted',
      'deafened',
      'undeafened',
      'displaced',
      'forced_leave',
    ] as const) {
      const parsed = roundTrip<CallUpdate>({
        channel_id: CH,
        call_id: CALL,
        user_id: USER_A,
        leg: 'leg-1',
        state,
      });
      expect(parsed.state).toBe(state);
    }
  });
});

describe('CALL_END payload round-trip', () => {
  it.each(['last_left', 'swept'] as const)('carries reason %s', (reason) => {
    const end: CallEnd = { channel_id: CH, call_id: CALL, reason, ended_at: TS };
    expect(roundTrip(end)).toEqual(end);
  });
});

describe('CALL_SYNC payload round-trip', () => {
  it('round-trips a full roster with booleans preserved', () => {
    const sync: CallSync = {
      calls: [
        {
          channel_id: CH,
          call_id: CALL,
          thread_id: THREAD,
          participants: [
            { user_id: USER_A, mute: false, deafen: false },
            { user_id: USER_B, mute: true, deafen: true },
          ],
        },
      ],
      dm_calls: [
        {
          channel_id: '9200000000000000110',
          call_id: '9200000000000007002',
          participants: [{ user_id: USER_B, mute: false, deafen: false }],
        },
      ],
    };
    const parsed = roundTrip(sync);
    expect(parsed).toEqual(sync);
    expect(parsed.calls[0]!.participants[1]!).toEqual({
      user_id: USER_B,
      mute: true,
      deafen: true,
    });
  });

  it('round-trips the empty sync (both arrays empty)', () => {
    const empty: CallSync = { calls: [], dm_calls: [] };
    expect(roundTrip(empty)).toEqual({ calls: [], dm_calls: [] });
    expect(Array.isArray(roundTrip(empty).calls)).toBe(true);
    expect(Array.isArray(roundTrip(empty).dm_calls)).toBe(true);
  });
});

describe('CALL_RING payload round-trip', () => {
  it('carries channel, call, and from_user as snowflake-strings', () => {
    const ring: CallRing = { channel_id: CH, call_id: CALL, from_user: USER_A };
    const parsed = roundTrip(ring);
    expect(parsed).toEqual(ring);
    expect(parsed.from_user).toBe(USER_A);
  });
});

describe('CALL_SIGNAL event payload round-trip', () => {
  it('relays channel + opaque body untouched', () => {
    const body = JSON.stringify({ kind: 'ice', candidate: 'candidate:1 1 UDP 2130706431 10.0.0.1 50000 typ host' });
    const signal: CallSignal = { channel_id: CH, body };
    const parsed = roundTrip(signal);
    expect(parsed.body).toBe(body);
    expect(parsed).not.toHaveProperty('kind'); // the event payload is {channel_id, body}
  });

  it('survives a body at the documented 64 KiB cap', () => {
    expect(CALL_SIGNAL_BODY_MAX_BYTES).toBe(131_072);
    const body = 'x'.repeat(CALL_SIGNAL_BODY_MAX_BYTES);
    const parsed = roundTrip<CallSignal>({ channel_id: CH, body });
    expect(parsed.body.length).toBe(CALL_SIGNAL_BODY_MAX_BYTES);
    expect(parsed.body).toBe(body);
  });
});

describe('op 22 CALL_STATE_UPDATE command payload', () => {
  it('exposes exactly six actions (V1 four + calls-V2 publish/unpublish)', () => {
    expect(CALL_CONTROL_ACTIONS).toEqual(['start', 'join', 'leave', 'state', 'publish', 'unpublish']);
    for (const action of CALL_CONTROL_ACTIONS) expect(isCallControlAction(action)).toBe(true);
    expect(isCallControlAction('ring')).toBe(false);
    expect(isCallControlAction('START')).toBe(false);
    expect(isCallControlAction(null)).toBe(false);
  });

  it('start carries the ring modifier (ring-enabled start)', () => {
    const cmd: GatewayCallStateUpdatePayload = { channel_id: CH, action: 'start', ring: true };
    expect(roundTrip(cmd)).toEqual({ channel_id: CH, action: 'start', ring: true });
  });

  it('state carries mute/deafen AND ring (ring-after-start, AM17)', () => {
    const cmd: GatewayCallStateUpdatePayload = {
      channel_id: CH,
      action: 'state',
      mute: true,
      deafen: false,
      ring: true,
    };
    const parsed = roundTrip(cmd);
    expect(parsed.action).toBe('state');
    expect(parsed.mute).toBe(true);
    expect(parsed.ring).toBe(true);
    // A bare ring-after-start: state action, ring only.
    const ringOnly: GatewayCallStateUpdatePayload = { channel_id: CH, action: 'state', ring: true };
    expect(ringOnly.mute).toBeUndefined();
    expect(ringOnly.deafen).toBeUndefined();
  });

  it('join/leave carry only channel + action', () => {
    const join: GatewayCallStateUpdatePayload = { channel_id: CH, action: 'join' };
    const leave: GatewayCallStateUpdatePayload = { channel_id: CH, action: 'leave' };
    expect(Object.keys(join).sort()).toEqual(['action', 'channel_id']);
    expect(Object.keys(leave).sort()).toEqual(['action', 'channel_id']);
    expectTypeOf<GatewayCallStateUpdatePayload['ring']>().toEqualTypeOf<boolean | undefined>();
  });
});

describe('op 23 CALL_SIGNAL command payload', () => {
  it('exposes exactly the two signaling kinds', () => {
    expect(CALL_SIGNAL_KINDS).toEqual(['sdp', 'ice']);
    expect(isCallSignalKind('sdp')).toBe(true);
    expect(isCallSignalKind('ice')).toBe(true);
    expect(isCallSignalKind('candidate')).toBe(false);
    expect(isCallSignalKind(1)).toBe(false);
  });

  it('round-trips channel + kind + opaque body', () => {
    const cmd: GatewayCallSignalPayload = {
      channel_id: CH,
      kind: 'sdp',
      body: 'v=0\r\no=- 46117317 2 IN IP4 127.0.0.1\r\n',
    };
    const parsed = roundTrip(cmd);
    expect(parsed).toEqual(cmd);
    expect(parsed.kind).toBe('sdp');
  });

  it('documents the 64 KiB body cap as a shared constant', () => {
    // Ingress (U4) rejects byte_length > CALL_SIGNAL_BODY_MAX_BYTES; the
    // value is pinned here so client pre-sizing and the load harness probe
    // the same boundary.
    expect(CALL_SIGNAL_BODY_MAX_BYTES).toBe(131072);
    const atCap: GatewayCallSignalPayload = { channel_id: CH, kind: 'ice', body: 'y'.repeat(CALL_SIGNAL_BODY_MAX_BYTES) };
    expect(new TextEncoder().encode(atCap.body).byteLength).toBe(CALL_SIGNAL_BODY_MAX_BYTES);
  });
});
