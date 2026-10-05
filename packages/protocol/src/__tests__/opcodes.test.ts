import { describe, it, expect } from 'vitest';
import {
  COMPRESSION_MODES,
  GATEWAY_OP_DIRECTIONS,
  GATEWAY_OP_NAMES,
  GatewayOp,
  KNOWN_GATEWAY_OPS,
  isCompressionMode,
  isKnownOp,
  isReservedOp,
  RESERVED_OP_MIN,
  type CompressionMode,
  type GatewayOpCode,
} from '../opcodes.js';

describe('core gateway opcodes', () => {
  it('maps each opcode to its exact integer value', () => {
    expect(GatewayOp.Dispatch).toBe(0);
    expect(GatewayOp.Heartbeat).toBe(1);
    expect(GatewayOp.Identify).toBe(2);
    expect(GatewayOp.PresenceUpdate).toBe(3);
    expect(GatewayOp.Resume).toBe(5);
    expect(GatewayOp.Reconnect).toBe(6);
    expect(GatewayOp.InvalidSession).toBe(9);
    expect(GatewayOp.Hello).toBe(10);
    expect(GatewayOp.HeartbeatACK).toBe(11);
  });

  it('omits the Discord voice opcodes (4 and 8)', () => {
    expect(Object.values(GatewayOp)).not.toContain(4);
    expect(Object.values(GatewayOp)).not.toContain(8);
  });

  it('reserves the Cytale-specific range starting at 20', () => {
    expect(RESERVED_OP_MIN).toBe(20);
    expect(GatewayOp.TYPING_START_CLIENT).toBe(20);
    expect(GatewayOp.MESSAGE_ACK).toBe(21);
    expect(GatewayOp.CALL_STATE_UPDATE).toBe(22);
    expect(GatewayOp.CALL_SIGNAL).toBe(23);
  });

  it('keeps every opcode value unique', () => {
    const values = Object.values(GatewayOp);
    expect(new Set(values).size).toBe(values.length);
  });

  it('are all non-negative integers', () => {
    for (const op of Object.values(GatewayOp)) {
      expect(Number.isInteger(op)).toBe(true);
      expect(op).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('isKnownOp', () => {
  it.each([0, 1, 2, 3, 5, 6, 9, 10, 11, 20, 21, 22, 23])('accepts known op %i', (op) => {
    expect(isKnownOp(op)).toBe(true);
  });

  it.each([-1, 4, 7, 8, 12, 19, 25, 100])('rejects unassigned op %i', (op) => {
    expect(isKnownOp(op)).toBe(false);
  });

  it.each(['0', null, undefined, NaN, Infinity, 1.5, {}, [], true])(
    'rejects non-integer input %p',
    (input) => {
      expect(isKnownOp(input)).toBe(false);
    },
  );

  it('narrows the type to GatewayOpCode on success', () => {
    const candidate: number = 2;
    if (isKnownOp(candidate)) {
      const narrowed: GatewayOpCode = candidate;
      expect(narrowed).toBe(2);
    } else {
      throw new Error('expected narrowing to succeed');
    }
  });
});

describe('isReservedOp', () => {
  it.each([20, 21, 22, 23, 24])('accepts reserved-range op %i', (op) => {
    expect(isReservedOp(op)).toBe(true);
  });

  it.each([0, 1, 2, 3, 5, 6, 9, 10, 11, 19, 25])('rejects op %i outside the defined reserved set', (op) => {
    expect(isReservedOp(op)).toBe(false);
  });

  it('keeps the next free slot (25) undefined — no accidental gap consumption', () => {
    // Ops 22/23 (calls) and 24 (focus report) consumed the next free slots in
    // definition order; the new next-free value must stay rejected until a
    // protocol version defines it on both sides.
    expect(isKnownOp(25)).toBe(false);
    expect(isReservedOp(25)).toBe(false);
  });
});

describe('KNOWN_GATEWAY_OPS', () => {
  it('contains exactly the values of the GatewayOp map', () => {
    expect([...KNOWN_GATEWAY_OPS].sort((a, b) => a - b)).toEqual(
      Object.values(GatewayOp).sort((a, b) => a - b),
    );
  });
});

describe('GATEWAY_OP_NAMES', () => {
  it('provides a unique human-readable name for every opcode', () => {
    for (const op of Object.values(GatewayOp)) {
      expect(typeof GATEWAY_OP_NAMES[op]).toBe('string');
      expect(GATEWAY_OP_NAMES[op].length).toBeGreaterThan(0);
    }
    const names = Object.values(GATEWAY_OP_NAMES);
    expect(new Set(names).size).toBe(names.length);
  });

  it('round-trips opcode -> name -> opcode via reverse lookup', () => {
    for (const [numericKey, name] of Object.entries(GATEWAY_OP_NAMES)) {
      const op = Number(numericKey);
      if (!isKnownOp(op)) throw new Error(`unknown op ${numericKey} in GATEWAY_OP_NAMES`);
      expect(GATEWAY_OP_NAMES[op]).toBe(name);
    }
  });

  it('names the voice-call command ops (calls plan U1)', () => {
    expect(GATEWAY_OP_NAMES[GatewayOp.CALL_STATE_UPDATE]).toBe('CALL_STATE_UPDATE');
    expect(GATEWAY_OP_NAMES[GatewayOp.CALL_SIGNAL]).toBe('CALL_SIGNAL');
  });

  it('names the focus-report op (notifications plan U5)', () => {
    expect(GATEWAY_OP_NAMES[GatewayOp.FOCUS_UPDATE]).toBe('FOCUS_UPDATE');
  });

  it('adds NO opcode for the calls V2 surface (publish/unpublish/video_want ride op 22 actions)', () => {
    // Calls V2 plan U2/R6: the wire extension is additive actions, fields,
    // and enum values on the EXISTING ops — the unknown-op rejection list is
    // unchanged. The count is 14 since the notifications plan's focus report
    // claimed slot 24, so the next free slot is 25.
    expect(KNOWN_GATEWAY_OPS).toHaveLength(14);
    expect(isKnownOp(25)).toBe(false);
    expect(GATEWAY_OP_NAMES[GatewayOp.CALL_STATE_UPDATE]).toBe('CALL_STATE_UPDATE');
    expect(GATEWAY_OP_NAMES[GatewayOp.CALL_SIGNAL]).toBe('CALL_SIGNAL');
  });
});

describe('GATEWAY_OP_DIRECTIONS', () => {
  it('covers every opcode', () => {
    const directed = Object.keys(GATEWAY_OP_DIRECTIONS).map((k) => Number(k));
    expect([...directed].sort((a, b) => a - b)).toEqual(
      Object.values(GatewayOp).sort((a, b) => a - b),
    );
  });

  it('marks dispatch and server-control ops as server-to-client', () => {
    const serverToClient: GatewayOpCode[] = [
      GatewayOp.Dispatch,
      GatewayOp.Reconnect,
      GatewayOp.InvalidSession,
      GatewayOp.Hello,
      GatewayOp.HeartbeatACK,
    ];
    for (const op of serverToClient) {
      expect(GATEWAY_OP_DIRECTIONS[op]).toBe('server-to-client');
    }
  });

  it('marks all Cytale reserved-range ops as client-to-server commands', () => {
    expect(GATEWAY_OP_DIRECTIONS[GatewayOp.TYPING_START_CLIENT]).toBe('client-to-server');
    expect(GATEWAY_OP_DIRECTIONS[GatewayOp.MESSAGE_ACK]).toBe('client-to-server');
    expect(GATEWAY_OP_DIRECTIONS[GatewayOp.CALL_STATE_UPDATE]).toBe('client-to-server');
    expect(GATEWAY_OP_DIRECTIONS[GatewayOp.CALL_SIGNAL]).toBe('client-to-server');
  });

  it('marks client lifecycle ops as client-to-server', () => {
    expect(GATEWAY_OP_DIRECTIONS[GatewayOp.Heartbeat]).toBe('client-to-server');
    expect(GATEWAY_OP_DIRECTIONS[GatewayOp.Identify]).toBe('client-to-server');
    expect(GATEWAY_OP_DIRECTIONS[GatewayOp.Resume]).toBe('client-to-server');
    expect(GATEWAY_OP_DIRECTIONS[GatewayOp.PresenceUpdate]).toBe('client-to-server');
  });
});

describe('compression modes', () => {
  it('exposes exactly the two supported stream codecs', () => {
    expect([...COMPRESSION_MODES]).toEqual(['zstd_stream', 'zlib_stream']);
  });

  it('accepts valid compression mode literals', () => {
    const a: CompressionMode | 'nope' = 'zstd_stream';
    const b: CompressionMode | 'nope' = 'zlib_stream';
    expect(isCompressionMode(a)).toBe(true);
    expect(isCompressionMode(b)).toBe(true);
  });

  it('rejects unknown compression modes', () => {
    expect(isCompressionMode('gzip')).toBe(false);
    expect(isCompressionMode('ZSTD_STREAM')).toBe(false);
    expect(isCompressionMode('')).toBe(false);
    expect(isCompressionMode(null)).toBe(false);
    expect(isCompressionMode(42)).toBe(false);
  });
});
