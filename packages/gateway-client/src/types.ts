/**
 * Client-side session-state types for the Cytale gateway client (U15).
 *
 * Pure types + tiny error classes only — no runtime protocol logic lives
 * here. All wire shapes come from @cytale/protocol, which is the single
 * source of truth shared with the Elixir gateway (U10) and the U28 load
 * harness.
 */

import type {
  CompressionMode,
  EventName,
  EventPayloadMap,
  GatewayEvent,
  IdentifyProperties,
} from '@cytale/protocol';

// ---------------------------------------------------------------------------
// Connection state machine
// ---------------------------------------------------------------------------

/**
 * Client-visible gateway lifecycle states. Mirrors the server (U10) machine
 * and the High-Level Technical Design diagram:
 *
 *   new → connecting → identifying → ready → connected
 *                                   ↘ resuming ↗        (with a live session)
 *   connected/ready → disconnected → reconnecting → (identifying|resuming)
 *
 * `ready` is the transient state right after a Ready/Resumed dispatch is
 * processed; `connected` is the steady state entered once the next inbound
 * frame (typically the first HeartbeatACK) proves the pipe is alive.
 * `dead` is terminal until a manual connect().
 */
export type ConnectionState =
  | 'new'
  | 'connecting'
  | 'identifying'
  | 'resuming'
  | 'ready'
  | 'connected'
  | 'disconnected'
  | 'reconnecting'
  | 'dead';

/** Transition notification delivered to options.onStateChange. */
export interface StateChange {
  from: ConnectionState;
  to: ConnectionState;
}

// ---------------------------------------------------------------------------
// Socket abstraction (injectable for tests + U28)
// ---------------------------------------------------------------------------

/** Close info normalized from whichever socket implementation is in play. */
export interface SocketCloseInfo {
  code: number;
  reason: string;
}

/**
 * Minimal duplex socket surface the client needs. The real WebSocket adapter
 * (default factory) and the in-test fake both conform to this shape, which is
 * what lets tests — and the U28 load harness — inject a socket without any
 * network stack.
 */
export interface GatewaySocketLike {
  /** Serialized UTF-8 JSON or a compressed binary frame. */
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  /** Assignable handlers (WebSocket-style properties, plain-object events). */
  onopen?: (() => void) | null;
  /** `data` is string | ArrayBuffer | Uint8Array | Blob depending on impl. */
  onmessage?: ((data: unknown) => void) | null;
  onclose?: ((info: SocketCloseInfo) => void) | null;
  onerror?: ((err: { message?: string }) => void) | null;
}

/** Factory creating a socket for a gateway URL. Defaults to global WebSocket. */
export type GatewaySocketFactory = (url: string) => GatewaySocketLike;

// ---------------------------------------------------------------------------
// Compression plumbing
// ---------------------------------------------------------------------------

/**
 * Zstandard decompressor abstraction for runtimes whose DecompressionStream
 * lacks the `zstd` format. Implementations are loaded at runtime (WASM) and
 * handed to the client via options.zstdWasmLoader.
 */
export interface ZstdWasmDecompressor {
  decompress(input: Uint8Array): Promise<Uint8Array>;
}

/** Async factory producing a (possibly shared/cached) decompressor. */
export type ZstdWasmLoader = () => Promise<ZstdWasmDecompressor>;

// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------

/** Resumable session identity, captured from Ready and updated on Resumed. */
export interface StoredSession {
  sessionId: string;
  /** Last dispatch sequence number the client has processed. */
  seq: number;
  /**
   * Single-use resume secret issued in Ready; invalidated by the server on
   * successful Resume use and replaced by the next Ready.
   */
  resumeToken: string;
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

/** Counters surfaced for metrics scrapers; `resume_gap_total` is contractual */
export interface TelemetrySnapshot {
  reconnects_total: number;
  heartbeats_sent_total: number;
  heartbeats_missed_total: number;
  resume_attempts_total: number;
  resume_successes_total: number;
  resume_gap_total: number;
  dispatch_duplicates_dropped_total: number;
  dispatch_sequence_total: number;
  /** Raw frames that reached handleRawMessage (#26 triangulation). */
  inbound_frames_total: number;
  /** Span texts delivered through the sink collector (#26 triangulation). */
  sink_delivered_total: number;
  /** Binary frames pushed into an inflater pipe (#26 triangulation). */
  binary_pushed_total: number;
  invalid_sessions_total: number;
  malformed_frames_total: number;
  /**
   * Dispatches whose payload failed a per-event guard, or whose handler threw
   * (hardening plan 6.2). Each one is answered with a teardown + reconnect
   * rather than an exception, so this counter — not a crash — is the signal
   * that the inbound stream is suspect. A failing dispatch also bumps
   * `malformed_frames_total` and lands in `GatewayClient.lastMalformed`.
   */
  dispatch_errors_total: number;
  listener_errors_total: number;
  commands_dropped_offline_total: number;
}

// ---------------------------------------------------------------------------
// Subscription + metadata types
// ---------------------------------------------------------------------------

/** Delivery metadata accompanying every dispatch event. */
export interface DispatchMeta {
  /** Wire sequence number the payload arrived at (already gap-checked). */
  seq: number;
  /** Server event name (`t` on the dispatch envelope). */
  eventName: EventName;
  /** Epoch ms at local receive time. */
  receivedAt: number;
}

export type DispatchHandler<K extends EventName> = (
  payload: EventPayloadMap[K],
  meta: DispatchMeta,
) => void;

/** Observer invoked for every dispatch regardless of event name. */
export type AnyDispatchHandler = (event: GatewayEvent, meta: DispatchMeta) => void;

// ---------------------------------------------------------------------------
// Lifecycle callbacks payload shapes
// ---------------------------------------------------------------------------

/** Reported via onResumeGap whenever a sequence hole is detected. */
export interface SequenceGapInfo {
  /** Seq the client expected next (lastSeq + 1). */
  expectedSeq: number;
  /** Seq the server actually sent. */
  receivedSeq: number;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface GatewayClientOptions {
  /** Gateway endpoint, e.g. `wss://gw.example.com/gateway`. */
  url: string;
  /** Auth token source for Identify; re-consulted on every fresh identify. */
  tokenProvider: () => string | Promise<string>;
  /** Injectable socket factory (tests + U28); defaults to global WebSocket. */
  socketFactory?: GatewaySocketFactory;
  /** Requested stream codec. Default: 'zstd_stream' with zlib fallback. */
  compression?: CompressionMode | 'none';
  /** Runtime zstd decompressor loader enabling zstd where natives lack it. */
  zstdWasmLoader?: ZstdWasmLoader;
  /** Identify.properties overrides; defaults to CLIENT_HELLO + platform sniff. */
  properties?: Partial<IdentifyProperties>;
  /** Backoff floor for reconnection delays. Default 500ms. */
  minReconnectDelayMs?: number;
  /** Backoff ceiling. Default 30_000ms. */
  maxReconnectDelayMs?: number;
  /** Full-width jitter fraction [0..1]. Default 0.25. */
  jitterRatio?: number;
  /**
   * Consecutive heartbeats lacking an ACK that kill the connection. Default 5
   * ("5 missed ACKs = dead").
   */
  maxMissedHeartbeats?: number;
  /** Auto-retries of Resume before falling back to fresh identify. Default 1. */
  resumeMaxRetries?: number;
  /**
   * Bound on one connect attempt (socket open) before the socket is closed
   * and the reconnect backoff takes over. Default `CONNECT_TIMEOUT_MS_DEFAULT`
   * (15_000ms) — see the tradeoff note beside that constant.
   */
  connectTimeoutMs?: number;
  /**
   * Bound on the WHOLE opening handshake — socket open, Hello, Identify or
   * Resume, then Ready/Resumed — before the connection is torn down and
   * reconnected (hardening plan 6.1). Default
   * `HANDSHAKE_TIMEOUT_MS_DEFAULT` (20_000ms).
   */
  handshakeTimeoutMs?: number;
  /** Injectable RNG for reproducible backoff jitter in tests. */
  rng?: () => number;
  /** Injectable wall clock for throttling windows in tests. */
  now?: () => number;

  // -- lifecycle callbacks -------------------------------------------------
  onStateChange?(change: StateChange): void;
  /** InvalidSession received; `false` means the session cannot be resumed. */
  onInvalidSession?(resumable: boolean): void;
  /** Sequence gap detected → full-sync fallback follows automatically. */
  onResumeGap?(gap: SequenceGapInfo): void;
  /** A heartbeat tick found the previous beat unacknowledged. */
  onHeartbeatMiss?(consecutiveMissed: number): void;
  /** Give-up condition: reconnect loop exhausted (see connectMaxAttempts). */
  onDead?(info: { reason: string }): void;
  onSocketError?(err: { message?: string }): void;
  onClosed?(info: SocketCloseInfo): void;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Raised by client→server command methods while the socket is unusable. */
export class GatewayOfflineError extends Error {
  override readonly name = 'GatewayOfflineError';
  constructor(operation: string) {
    super(`gateway offline: cannot send ${operation}`);
  }
}

/** Raised when connect() is called on an already-live client. */
export class GatewayActiveError extends Error {
  override readonly name = 'GatewayActiveError';
  constructor(state: ConnectionState) {
    super(`connect() called while client is ${state}; call disconnect()/destroy() first`);
  }
}
