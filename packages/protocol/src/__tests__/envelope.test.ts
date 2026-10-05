import { describe, it, expect } from 'vitest';
import {
  isGatewayEnvelope,
  narrowDispatch,
  dispatchEvent,
  type GatewayDispatchEnvelope,
} from '../envelope.js';
import { GatewayOp } from '../opcodes.js';

const validMessageCreate = {
  id: '7300000000000000001',
  channel_id: '7300000000000000100',
  thread_id: null,
  author_id: '7300000000000000200',
  content: 'hi',
  created_at: '2026-08-27T12:00:00.000Z',
  edited_at: null,
};

describe('isGatewayEnvelope — accept', () => {
  it('accepts a well-formed dispatch envelope', () => {
    const env = { op: 0, t: 'MessageCreate', s: 1, d: validMessageCreate };
    expect(isGatewayEnvelope(env)).toBe(true);
  });

  it('accepts a non-dispatch envelope without t or s', () => {
    expect(isGatewayEnvelope({ op: 10, d: { heartbeat_interval: 45000 } })).toBe(true);
    expect(isGatewayEnvelope({ op: 1, d: null })).toBe(true);
    expect(
      isGatewayEnvelope({ op: 2, d: { token: 'x', v: 1, compress: null, properties: {} } }),
    ).toBe(true);
    // Envelope keys may appear in any order / subset as long as d is present.
    expect(isGatewayEnvelope({ d: null, op: 6 })).toBe(true);
  });
});

describe('isGatewayEnvelope — reject malformed frames', () => {
  it('rejects non-object inputs', () => {
    for (const bad of [null, undefined, 42, 'str', true, [], () => {}]) {
      expect(isGatewayEnvelope(bad), `should reject ${String(bad)}`).toBe(false);
    }
  });

  it('rejects missing required keys and extra unknown keys', () => {
    expect(isGatewayEnvelope({})).toBe(false); // no op, no d
    expect(isGatewayEnvelope({ op: 0 })).toBe(false); // dispatch without d
    expect(isGatewayEnvelope({ d: {} })).toBe(false); // no op
    expect(isGatewayEnvelope({ op: 0, t: 'Ready', s: 1 })).toBe(false); // no d
    expect(
      isGatewayEnvelope({ op: 10, d: {}, extra: true }), // extra top-level key
    ).toBe(false);
  });

  it('control frames may omit d (shipped U10 server sends bare HeartbeatACK/Reconnect)', () => {
    expect(isGatewayEnvelope({ op: 11 })).toBe(true);
    expect(isGatewayEnvelope({ op: 6, d: { url: 'wss://redirect' } })).toBe(true);
    // dispatch frames still REQUIRE d
    expect(isGatewayEnvelope({ op: 0, t: 'Ready', s: 1 })).toBe(false);
  });

  it('rejects invalid opcode values', () => {
    expect(isGatewayEnvelope({ op: '2', d: null })).toBe(false); // string op
    expect(isGatewayEnvelope({ op: NaN, d: null })).toBe(false); // NaN op
    expect(isGatewayEnvelope({ op: Infinity, d: null })).toBe(false);
    expect(isGatewayEnvelope({ op: 3.5, d: null })).toBe(false); // fractional
    expect(isGatewayEnvelope({ op: -1, d: null })).toBe(false); // negative unassigned
    expect(isGatewayEnvelope({ op: 99, d: null })).toBe(false); // out of range
    expect(isGatewayEnvelope({ op: 4, d: null })).toBe(false); // voice op, never adopted
    expect(isGatewayEnvelope({ op: 8, d: null })).toBe(false);
  });

  it('rejects invalid or missing t on dispatch frames', () => {
    expect(isGatewayEnvelope({ op: 0, d: {} })).toBe(false); // t missing entirely
    expect(isGatewayEnvelope({ op: 0, s: 1, d: {} })).toBe(false);
    expect(isGatewayEnvelope({ op: 0, t: 42, d: {} })).toBe(false); // wrong type
    expect(isGatewayEnvelope({ op: 0, t: 'NotARealEvent', s: 1, d: {} })).toBe(false);
  });

  it('rejects invalid or missing sequence numbers on dispatch frames', () => {
    expect(isGatewayEnvelope({ op: 0, t: 'MessageCreate', d: validMessageCreate })).toBe(false);
    expect(isGatewayEnvelope({ op: 0, t: 'MessageCreate', s: -1, d: validMessageCreate })).toBe(
      false,
    );
    expect(isGatewayEnvelope({ op: 0, t: 'MessageCreate', s: 4.2, d: validMessageCreate })).toBe(
      false,
    );
    expect(
      isGatewayEnvelope({ op: 0, t: 'MessageCreate', s: Number.MAX_SAFE_INTEGER + 1, d: validMessageCreate }),
    ).toBe(false);
  });

  it('rejects dispatch-only fields smuggled onto non-dispatch frames', () => {
    expect(isGatewayEnvelope({ op: 10, t: 'Ready', d: {} })).toBe(false);
    expect(isGatewayEnvelope({ op: 11, s: 5, d: null })).toBe(false);
  });
});

describe('narrowDispatch', () => {
  it('narrows a matching dispatch frame to its typed envelope', () => {
    const frame: unknown = { op: 0, t: 'MessageCreate', s: 7, d: validMessageCreate };
    const typed = narrowDispatch(frame, 'MessageCreate');
    expect(typed).not.toBeNull();
    const narrowed: GatewayDispatchEnvelope<'MessageCreate'> | null = typed;
    expect(narrowed?.d.content).toBe('hi');
    expect(narrowed?.op).toBe(GatewayOp.Dispatch);
    expect(narrowed?.s).toBe(7);
  });

  it('returns null when the event name does not match', () => {
    const frame = { op: 0, t: 'MessageUpdate', s: 7, d: validMessageCreate };
    expect(narrowDispatch(frame, 'MessageCreate')).toBeNull();
    expect(narrowDispatch(frame, 'MessageUpdate')).not.toBeNull();
  });

  it('returns null for non-dispatch or invalid frames', () => {
    expect(narrowDispatch({ op: 10, d: {} }, 'Ready')).toBeNull();
    expect(narrowDispatch(null, 'Ready')).toBeNull();
  });
});

describe('dispatchEvent exhaustive handler table', () => {
  it('invokes the handler mapped to the frame event name', () => {
    const frame = { op: 0, t: 'TypingStart', s: 3, d: {
      channel_id: '100', thread_id: null, user_id: '200', timestamp: 1795828800000,
    } } as const;

    const out = dispatchEvent(frame, {
      MessageCreate: (p) => `msg:${p.id}`,
      MessageUpdate: () => 'mu',
      MessageDelete: () => 'md',
      MessageAck: () => 'ma',
      ChannelCreate: () => 'cc',
      ChannelUpdate: () => 'cu',
      ChannelDelete: () => 'cd',
      UserUpdate: () => 'uu',
      ThreadCreate: () => 'tc',
      ThreadUpdate: () => 'tu',
      ThreadDelete: () => 'td',
      ThreadMemberAdd: () => 'tma',
      ThreadMemberRemove: () => 'tmr',
      ThreadListSync: () => 'tls',
      ThreadMessageCreate: () => 'tmc',
      PresenceUpdate: () => 'pu',
      MessageReactionAdd: () => 'mra',
      MessageReactionRemove: () => 'mrr',
      MessageReactionRemoveAll: () => 'mrra',
      InteractionCreate: () => 'ic',
      InteractionModal: () => 'im',
      InteractionSuccess: () => 'is',
      CallStart: () => 'cst',
      CallUpdate: () => 'cup',
      CallEnd: () => 'cen',
      CallSync: () => 'csy',
      CallRing: () => 'cri',
      CallSignal: () => 'csg',
      ReadStateSync: () => 'rss',
      ReadStateUpdate: () => 'rsu',
      TypingStart: (p) => `typing:${p.user_id}`,
      Ready: (p) => `ready:${p.session_id}`,
      Resumed: () => 'r',
      RoleCreate: () => 'rc',
      RoleUpdate: () => 'ru',
      RoleDelete: () => 'rd',
      MemberAdd: () => 'ma2',
      MemberRemove: () => 'mr',
      MemberUpdate: () => 'mu',
      AccountDelete: () => 'ad',
    });
    expect(out).toBe('typing:200');

    const msgFrame = { ...frame, t: 'MessageCreate' as const, d: validMessageCreate };
    const out2 = dispatchEvent(msgFrame, {
      MessageCreate: (p) => `msg:${p.id}`,
      MessageUpdate: () => 'mu',
      MessageDelete: () => 'md',
      MessageAck: () => 'ma',
      ChannelCreate: () => 'cc',
      ChannelUpdate: () => 'cu',
      ChannelDelete: () => 'cd',
      UserUpdate: () => 'uu',
      ThreadCreate: () => 'tc',
      ThreadUpdate: () => 'tu',
      ThreadDelete: () => 'td',
      ThreadMemberAdd: () => 'tma',
      ThreadMemberRemove: () => 'tmr',
      ThreadListSync: () => 'tls',
      ThreadMessageCreate: () => 'tmc',
      PresenceUpdate: () => 'pu',
      MessageReactionAdd: () => 'mra',
      MessageReactionRemove: () => 'mrr',
      MessageReactionRemoveAll: () => 'mrra',
      InteractionCreate: () => 'ic',
      InteractionModal: () => 'im',
      InteractionSuccess: () => 'is',
      CallStart: () => 'cst',
      CallUpdate: () => 'cup',
      CallEnd: () => 'cen',
      CallSync: () => 'csy',
      CallRing: () => 'cri',
      CallSignal: () => 'csg',
      ReadStateSync: () => 'rss',
      ReadStateUpdate: () => 'rsu',
      TypingStart: (p) => `typing:${p.user_id}`,
      Ready: (p) => `ready:${p.session_id}`,
      Resumed: () => 'r',
      RoleCreate: () => 'rc',
      RoleUpdate: () => 'ru',
      RoleDelete: () => 'rd',
      MemberAdd: () => 'ma2',
      MemberRemove: () => 'mr',
      MemberUpdate: () => 'mu',
      AccountDelete: () => 'ad',
    });
    expect(out2).toBe('msg:7300000000000000001');
  });
});
