/**
 * Gateway envelope shapes and runtime guards.
 *
 * Every gateway frame — dispatch or command — shares the envelope:
 *   { op, t?, s?, d }
 *
 * `op === 0` (Dispatch) additionally carries `t` (event name) and `s`
 * (monotonic sequence number). Guards here are the runtime half of the
 * contract shared by U15 (gateway-client), U17 (web SPA), and the U28 load
 * harness; wire encode/decode lives in this package exactly once so
 * consumers never drift.
 */

import { isKnownOp, type GatewayOpCode } from './opcodes.js';
import {
  EventPayloadMap,
  isEventName,
  type EventName,
  type GatewayEvent,
} from './events.js';

// ---------------------------------------------------------------------------
// Envelope types
// ---------------------------------------------------------------------------

/**
 * Full gateway envelope generic over dispatch event names. `t`/`s` are only
 * present on Dispatch frames (op 0); other ops carry just `op`, plus `d` when
 * the frame has data (e.g. op 6 Reconnect may carry a redirect hint; op 11
 * Heartbeat ACK carries none — the shipped U10 server sends `{op: 11}` bare).
 */
export interface GatewayEnvelope<T extends EventName = EventName> {
  op: GatewayOpCode;
  /** Event name — present iff op === Dispatch. */
  t?: T;
  /** Sequence number — present iff op === Dispatch. */
  s?: number | null;
  /** Payload — present when the frame carries data; control frames may omit it. */
  d?: unknown;
}

/**
 * Runtime-validated Dispatch frame (op 0): `t` is a known event name, `s` a
 * non-negative safe integer, and `d` narrows to the mapped payload type via
 * `narrowDispatch`.
 */
export interface GatewayDispatchEnvelope<T extends EventName = EventName>
  extends GatewayEnvelope<T> {
  op: 0;
  t: T;
  s: number;
  /** Payload narrowed to the event's mapped shape once runtime-checked. */
  d: EventPayloadMap[T];
}

/**
 * Union of every validated gateway frame shape: typed dispatch envelopes
 * across all event names plus non-dispatch command/control frames.
 */
export type ValidatedGatewayFrame =
  | GatewayEvent
  | { op: Exclude<GatewayOpCode, 0>; d?: unknown };

// ---------------------------------------------------------------------------
// Runtime guards
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

const ENVELOPE_KEYS = new Set(['op', 't', 's', 'd']);

/**
 * Validate an untrusted decoded JSON value as a gateway envelope. Structural
 * checks only — deep payload validation of `d` belongs to per-event guards
 * built on top of this guard, deliberately kept out of this hot path.
 *
 * Rejects:
 * - non-objects / arrays / null primitives,
 * - unknown, fractional, negative or otherwise unassigned opcode values,
 * - op-0 frames without a known `t` or with an invalid `s`,
 * - non-dispatch frames that carry `t` or `s`,
 * - frames carrying keys outside `{op, t, s, d}`.
 *
 * `d` is OPTIONAL on non-dispatch frames: the shipped U10 server sends op 11
 * Heartbeat ACK and op 6 Reconnect without a `d` field (session.ex frames are
 * `%{op: n}`), so requiring it would classify every heartbeat ACK as a
 * malformed frame and starve the client's missed-heartbeat counter.
 */
export function isGatewayEnvelope(value: unknown): value is GatewayEnvelope<EventName> {
  if (!isPlainObject(value)) return false;

  const keys = Object.keys(value);
  if (keys.length < 1 || keys.length > 4) return false;
  for (const k of keys) {
    if (!ENVELOPE_KEYS.has(k)) return false;
  }

  const { op } = value;
  if (!isKnownOp(op)) return false;

  if (op === 0) {
    if (!isEventName(value.t)) return false;
    const s = value.s;
    if (typeof s !== 'number' || !Number.isSafeInteger(s) || s < 0) return false;
    if (!('d' in value)) return false; // dispatches always carry a payload
  } else if ('t' in value || 's' in value) {
    // Non-dispatch frames must not carry dispatch-only fields (blocks
    // smuggling dispatch semantics into command/control frames).
    return false;
  }

  return true;
}

/**
 * Narrow an already-guarded envelope to a typed dispatch frame for a specific
 * event name, or null when the frame is not a matching Dispatch of `eventName`.
 */
export function narrowDispatch<T extends EventName>(
  value: unknown,
  eventName: T,
): GatewayDispatchEnvelope<T> | null {
  if (!isGatewayEnvelope(value)) return null;
  if (value.op !== 0) return null;
  if (value.t !== eventName) return null;
  return value as unknown as GatewayDispatchEnvelope<T>;
}

/**
 * Exhaustive dispatcher helper: given a validated dispatch frame and a handler
 * map covering every event name, invoke the right handler. Compile-time
 * exhaustiveness enforced by requiring the full EventPayloadMap-shaped table.
 */
export function dispatchEvent<TOut>(
  event: GatewayEvent,
  handlers: { [K in keyof EventPayloadMap]: (payload: EventPayloadMap[K]) => TOut },
): TOut {
  const handler = handlers[event.t] as (payload: unknown) => TOut;
  return handler(event.d);
}
