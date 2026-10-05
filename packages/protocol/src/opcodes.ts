/**
 * Cytale gateway opcodes — single source of truth for the wire protocol.
 *
 * The core opcode table follows the Discord-proven gateway model (R3) with
 * voice ops deliberately omitted. Ops 20+ are reserved for Cytale-specific
 * client-to-server commands. This module is intentionally runtime-useful:
 * the Elixir server mirror and the U28 load harness consume the same
 * constants, so there is exactly one definition of every opcode.
 *
 * Mirrors `apps/server` gateway op table once U6 lands.
 */

/** Cytale-specific reserved range floor. All ops >= 20 are Cytale-native. */
export const RESERVED_OP_MIN = 20;

/**
 * Core gateway opcodes. Values mirror the Discord gateway model minus voice
 * (ops 4 and 8 are left unassigned forever).
 */
export const GatewayOp = {
  /** Server -> client event dispatch. Carries `t` (event name) + `s` (seq) + `d`. */
  Dispatch: 0,
  /** Client -> server heartbeat ping. */
  Heartbeat: 1,
  /** Client -> server session start. */
  Identify: 2,
  /** Client -> server presence change request. */
  PresenceUpdate: 3,
  /** Client -> server session resumption after reconnect. */
  Resume: 5,
  /** Server -> client "drop and reconnect immediately". */
  Reconnect: 6,
  /** Server -> client "session dead; re-Identify" (payload: boolean, resumable flag). */
  InvalidSession: 9,
  /** Server -> client first payload after connect (heartbeat_interval). */
  Hello: 10,
  /** Server -> client acknowledgement of a heartbeat. */
  HeartbeatACK: 11,
  /** Client -> server typing signal (Cytale reserved range). */
  TYPING_START_CLIENT: 20,
  /** Client -> server read acknowledgement (Cytale reserved range). */
  MESSAGE_ACK: 21,
  /** Client -> server voice-call control plane (Cytale reserved range). */
  CALL_STATE_UPDATE: 22,
  /** Client -> server opaque media-signaling relay (Cytale reserved range). */
  CALL_SIGNAL: 23,
  /**
   * Client -> server focus report: whether this session is the one the member
   * is actively looking at (Cytale reserved range). Delivery reads it to keep
   * one event from reaching every device — the focused session is already
   * showing the thing, so the others are the ones worth interrupting.
   */
  FOCUS_UPDATE: 24,
} as const;

/** Any defined gateway opcode value (non-erased: usable for narrowing). */
export type GatewayOpCode = (typeof GatewayOp)[keyof typeof GatewayOp];

/** Names of every core (pre-reserved-range) opcode, for diagnostics/logging. */
export const CORE_GATEWAY_OP_NAMES: ReadonlySet<string> = new Set([
  'Dispatch',
  'Heartbeat',
  'Identify',
  'PresenceUpdate',
  'Resume',
  'Reconnect',
  'InvalidSession',
  'Hello',
  'HeartbeatACK',
]);

/**
 * Human-readable name for each opcode. Keyed by the numeric opcode value so
 * both TS and the Elixir mirror can render identical log lines.
 */
export const GATEWAY_OP_NAMES: Readonly<Record<GatewayOpCode, string>> = {
  [GatewayOp.Dispatch]: 'DISPATCH',
  [GatewayOp.Heartbeat]: 'HEARTBEAT',
  [GatewayOp.Identify]: 'IDENTIFY',
  [GatewayOp.PresenceUpdate]: 'PRESENCE_UPDATE',
  [GatewayOp.Resume]: 'RESUME',
  [GatewayOp.Reconnect]: 'RECONNECT',
  [GatewayOp.InvalidSession]: 'INVALID_SESSION',
  [GatewayOp.Hello]: 'HELLO',
  [GatewayOp.HeartbeatACK]: 'HEARTBEAT_ACK',
  [GatewayOp.TYPING_START_CLIENT]: 'TYPING_START_CLIENT',
  [GatewayOp.MESSAGE_ACK]: 'MESSAGE_ACK',
  [GatewayOp.CALL_STATE_UPDATE]: 'CALL_STATE_UPDATE',
  [GatewayOp.CALL_SIGNAL]: 'CALL_SIGNAL',
  [GatewayOp.FOCUS_UPDATE]: 'FOCUS_UPDATE',
};

/** Which side originates frames carrying this opcode. */
export type OpDirection = 'client-to-server' | 'server-to-client';

/**
 * Wire direction of every opcode. Dispatch-frame *content* flows
 * server->client; the two Cytale reserved ops are client->server commands.
 */
export const GATEWAY_OP_DIRECTIONS: Readonly<Record<GatewayOpCode, OpDirection>> = {
  [GatewayOp.Dispatch]: 'server-to-client',
  [GatewayOp.Heartbeat]: 'client-to-server',
  [GatewayOp.Identify]: 'client-to-server',
  [GatewayOp.PresenceUpdate]: 'client-to-server',
  [GatewayOp.Resume]: 'client-to-server',
  [GatewayOp.Reconnect]: 'server-to-client',
  [GatewayOp.InvalidSession]: 'server-to-client',
  [GatewayOp.Hello]: 'server-to-client',
  [GatewayOp.HeartbeatACK]: 'server-to-client',
  [GatewayOp.TYPING_START_CLIENT]: 'client-to-server',
  [GatewayOp.MESSAGE_ACK]: 'client-to-server',
  [GatewayOp.CALL_STATE_UPDATE]: 'client-to-server',
  [GatewayOp.CALL_SIGNAL]: 'client-to-server',
  [GatewayOp.FOCUS_UPDATE]: 'client-to-server',
};

/** Every defined opcode value (sorted ascending by construction of GatewayOp). */
export const KNOWN_GATEWAY_OPS: readonly GatewayOpCode[] = Object.values(GatewayOp);

/**
 * True iff `value` is a currently-defined opcode (integer type included).
 * Deliberately strict: ops 4 and 8 (Discord voice, never adopted) and any
 * unassigned number are rejected so encode/decode bugs surface early.
 */
export function isKnownOp(value: unknown): value is GatewayOpCode {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    (KNOWN_GATEWAY_OPS as readonly number[]).includes(value)
  );
}

/**
 * True iff `value` is an opcode inside the Cytale-specific reserved range
 * (>= RESERVED_OP_MIN) that this protocol version defines. Unassigned
 * reserved slots (25+) are rejected until a later protocol version defines
 * them on both sides.
 */
export function isReservedOp(value: unknown): value is GatewayOpCode {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= RESERVED_OP_MIN &&
    isKnownOp(value)
  );
}

/** Supported stream compression codecs (negotiated via Identify.compress). */
export const COMPRESSION_MODES = ['zstd_stream', 'zlib_stream'] as const;

export type CompressionMode = (typeof COMPRESSION_MODES)[number];

/** True iff `value` is one of the supported stream compression codec names. */
export function isCompressionMode(value: unknown): value is CompressionMode {
  return (
    typeof value === 'string' && (COMPRESSION_MODES as readonly string[]).includes(value)
  );
}
