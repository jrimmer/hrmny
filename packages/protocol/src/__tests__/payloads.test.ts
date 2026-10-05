import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  CLIENT_HELLO,
  GATEWAY_VERSION,
  type CompressionMode,
  type GatewayClientMessageAckPayload,
  type GatewayClientTypingStartPayload,
  type GatewayHelloPayload,
  type GatewayIdentifyPayload,
  type GatewayResumePayload,
  type GatewayServerTypingStartPayload,
  type HeartbeatData,
  type IdentifyProperties,
  type MessageAckServerAck,
  type Snowflake,
  isSnowflake,
  makeSnowflake,
} from '../payloads.js';

describe('Snowflake', () => {
  it('serializes as a JSON string, never a number', () => {
    const id: Snowflake = makeSnowflake('9223372036854775807'); // near int64 max
    const json = JSON.stringify({ id });
    expect(json).toContain('"9223372036854775807"');
    const parsed = JSON.parse(json) as { id: Snowflake };
    expect(parsed.id).toBe('9223372036854775807');
  });

  it('preserves >53-bit precision that a JS number would lose', () => {
    // 2^53 + 1 is not representable as a JS number; the string form is lossless.
    expect(Number.isSafeInteger(Number('9007199254740993'))).toBe(false);
    const id = makeSnowflake('9007199254740993'); // 2^53 + 1
    expect(id).toBe('9007199254740993');
  });

  it('makeSnowflake accepts canonical digit strings', () => {
    expect(makeSnowflake('123')).toBe('123');
    expect(makeSnowflake('00123')).toBe('00123'); // leading zeros tolerated at this layer
    expect(isSnowflake(makeSnowflake('7300000000000000001'))).toBe(true);
  });

  it('isSnowflake accepts any well-formed digit string of legal length', () => {
    expect(isSnowflake('123')).toBe(true);
    expect(isSnowflake('0')).toBe(true);
    expect(isSnowflake('9223372036854775807')).toBe(true);
  });

  it('isSnowflake rejects non-strings and non-digit strings', () => {
    expect(isSnowflake(12345)).toBe(false);
    expect(isSnowflake(null)).toBe(false);
    expect(isSnowflake(undefined)).toBe(false);
    expect(isSnowflake('12x45')).toBe(false);
    expect(isSnowflake('-1')).toBe(false);
    expect(isSnowflake('')).toBe(false);
    expect(isSnowflake(' 12')).toBe(false);
    expect(isSnowflake({})).toBe(false);
  });

  it('makeSnowflake rejects malformed and out-of-range values', () => {
    expect(() => makeSnowflake('abc')).toThrow(TypeError);
    expect(() => makeSnowflake('')).toThrow(TypeError);
    expect(() => makeSnowflake('-1')).toThrow(TypeError);
    // Shape violations (>19 digits) fail the digit-shape check first.
    expect(() => makeSnowflake('1'.repeat(20))).toThrow(TypeError);
    // int64 max is 9223372036854775807 — a 19-digit value above it is range-rejected.
    expect(() => makeSnowflake('9223372036854775808')).toThrow(RangeError);
  });
});

describe('gateway protocol version', () => {
  it('is pinned to launch value 1', () => {
    expect(GATEWAY_VERSION).toBe(1);
  });
});

describe('Identify payload (client -> server, op 2)', () => {
  const identify: GatewayIdentifyPayload = {
    token: 'secret-token',
    v: GATEWAY_VERSION,
    compress: 'zstd_stream',
    properties: { os: 'linux', browser: 'cytale-web', device: 'cytale-web' },
  };

  it('carries exactly token, v, compress, properties', () => {
    expect(Object.keys(identify).sort()).toEqual(['compress', 'properties', 'token', 'v']);
    expect(identify.v).toBe(GATEWAY_VERSION);
    expectTypeOf<GatewayIdentifyPayload['v']>().toEqualTypeOf<number>();
    expectTypeOf<GatewayIdentifyPayload['compress']>().toEqualTypeOf<CompressionMode | null>();
    expectTypeOf<GatewayIdentifyPayload['properties']>().toEqualTypeOf<IdentifyProperties>();
  });

  it('allows null compression (no stream compression negotiated)', () => {
    const bare: GatewayIdentifyPayload = {
      token: 't',
      v: 1,
      compress: null,
      properties: { os: 'linux', browser: 'b', device: 'd' },
    };
    expect(bare.compress).toBeNull();
  });

  it('accepts an OPTIONAL intents bitmask (bots plan U7 compat sessions)', () => {
    const withIntents: GatewayIdentifyPayload = {
      token: 'cytbot_x',
      v: 1,
      compress: null,
      properties: { os: 'linux', browser: 'b', device: 'd' },
      // GUILDS | GUILD_MESSAGES | GUILD_MESSAGE_TYPING
      intents: 2561,
    };
    expectTypeOf<GatewayIdentifyPayload['intents']>().toEqualTypeOf<number | undefined>();
    expect(withIntents.intents).toBe(2561);

    // Absent stays valid: no intents = lifecycle-only compat session.
    const without: GatewayIdentifyPayload = {
      token: 't',
      v: 1,
      compress: null,
      properties: { os: 'linux', browser: 'b', device: 'd' },
    };
    expect(without.intents).toBeUndefined();
  });

  it('CLIENT_HELLO constant provides protocol-faithful defaults', () => {
    expect(CLIENT_HELLO.os.length).toBeGreaterThan(0);
    expect(CLIENT_HELLO.browser.length).toBeGreaterThan(0);
    expect(CLIENT_HELLO.device.length).toBeGreaterThan(0);
    const props: IdentifyProperties = { ...CLIENT_HELLO };
    expect(props).toEqual({
      os: CLIENT_HELLO.os,
      browser: CLIENT_HELLO.browser,
      device: CLIENT_HELLO.device,
    });
  });
});

describe('Resume payload (client -> server, op 5)', () => {
  it('carries session_id, seq, resume_token with correct types', () => {
    const resume: GatewayResumePayload = {
      session_id: 'sess-1',
      seq: 42,
      resume_token: 'single-use-secret',
      token: 'fresh-rest-token',
    };
    expectTypeOf<GatewayResumePayload['session_id']>().toBeString();
    expectTypeOf<GatewayResumePayload['seq']>().toBeNumber();
    expectTypeOf<GatewayResumePayload['resume_token']>().toBeString();
    expect(resume.seq).toBe(42);
  });

  it('resume_token models the single-use, identity-bound secret issued in Ready (U10 binding)', () => {
    // Semantic contract encoded here as documentation-by-fixture:
    // - issued by the server at session establishment (carried in Ready),
    // - invalidated on successful Resume use,
    // - bound to the authenticated identity so possession alone must not
    //   let a different identity adopt the session.
    const fromReady: { session_id: string; resume_token: string } = {
      session_id: 'sess-2',
      resume_token: 'rt-issued-at-ready',
    };
    const resume: GatewayResumePayload = {
      session_id: fromReady.session_id,
      seq: 7,
      resume_token: fromReady.resume_token,
      token: 'fresh-rest-token',
    };
    expect(resume.resume_token).toBe(fromReady.resume_token);
    expect(resume.resume_token.length).toBeGreaterThan(0);
  });
});

describe('Hello payload (server -> client, op 10)', () => {
  it('carries heartbeat_interval in milliseconds', () => {
    const hello: GatewayHelloPayload = { heartbeat_interval: 45_000 };
    expect(hello.heartbeat_interval).toBe(45_000);
    expectTypeOf<GatewayHelloPayload['heartbeat_interval']>().toBeNumber();
  });
});

describe('Heartbeat data (op 1)', () => {
  it('accepts null or the last sequence number', () => {
    const first: HeartbeatData = null;
    const later: HeartbeatData = 17;
    expect(first).toBeNull();
    expect(later).toBe(17);
  });
});

describe('MessageAck — Cytale reserved range (op 21)', () => {
  it('client->server ack carries channel_id and message_ids[]', () => {
    const ack: GatewayClientMessageAckPayload = {
      channel_id: '7300000000000000100',
      message_ids: ['7300000000000000004', '7300000000000000005'],
    };
    expect(ack.message_ids.length).toBe(2);
    // Round-trips through JSON byte-exactly as a string.
    expect(JSON.parse(JSON.stringify(ack.channel_id))).toBe('7300000000000000100');
    expectTypeOf<GatewayClientMessageAckPayload['message_ids']>().toEqualTypeOf<Snowflake[]>();
  });

  it('server acknowledgement shape mirrors MESSAGE_ACK back to clients', () => {
    const serverAck: MessageAckServerAck = {
      channel_id: '7300000000000000100',
      message_ids: ['7300000000000000004'],
      user_id: '7300000000000000200',
      acknowledged_at: '2026-08-27T12:06:00.000Z',
    };
    expect(serverAck.user_id).toBe('7300000000000000200');
    expect(Object.keys(serverAck).sort()).toEqual([
      'acknowledged_at',
      'channel_id',
      'message_ids',
      'user_id',
    ]);
  });
});

describe('TypingStart bidirectional pair (Cytale reserved range)', () => {
  it('client->server variant has channel_id and optional thread_id only', () => {
    const clientMsg: GatewayClientTypingStartPayload = { channel_id: '100' };
    const clientThread: GatewayClientTypingStartPayload = {
      channel_id: '100',
      thread_id: '300',
    };
    expect(clientMsg).not.toHaveProperty('user_id');
    expect(clientThread.thread_id).toBe('300');
    expectTypeOf<GatewayClientTypingStartPayload>().not.toHaveProperty('user_id');
  });

  it('server fan-out variant adds user_id and timestamp on top of channel scoping', () => {
    const serverFanout: GatewayServerTypingStartPayload = {
      channel_id: '100',
      thread_id: null,
      user_id: '200',
      timestamp: 1795828800000,
    };
    expect(serverFanout.user_id).toBe('200');
    expect(typeof serverFanout.timestamp).toBe('number');
    expectTypeOf<GatewayServerTypingStartPayload['thread_id']>().toEqualTypeOf<Snowflake | null>();
  });
});
