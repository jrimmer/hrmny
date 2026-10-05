/**
 * Cytale gateway client (U15) — the TypeScript WebSocket gateway consumer.
 *
 * Implements the Discord-proven lifecycle against @cytale/protocol wire
 * contracts, matching the server (U10) state machine:
 *
 *   connect → Hello → Identify|Resume → Ready/Resumed → steady state
 *
 * - Heartbeats every `heartbeat_interval` from Hello; a beat whose ACK never
 *   arrived increments the missed counter at the next tick (default 5 ⇒ the
 *   connection is killed and reopened with backoff).
 * - Resume carries session_id + last seq + the single-use resume_token issued
 *   in Ready; InvalidSession(false) falls back to a fresh Identify.
 * - Dispatch handling detects sequence gaps (`resume_gap_total`) and reacts
 *   with an immediate full-sync fallback — "no missed messages" becomes a
 *   self-checked invariant rather than an assumption.
 * - Malformed dispatch payloads are guarded (6.2): every mapped `d` must be an
 *   object and Ready's identity fields are type-checked. A failure is counted
 *   (`dispatch_errors_total`) and answered with the ordinary teardown +
 *   backoff — never an exception out of the socket handler, which is what
 *   used to wedge the client mid-handshake.
 * - Close 4004 (auth), 4013/4014 (intents) are TERMINAL (6.3): the client goes
 *   `dead` and `onDead` fires; the reconnect loop is suppressed. Every other
 *   close still reconnects with backoff.
 * - Client→server signals: TYPING_START (op 20, client-throttled to
 *   ~1/sec/channel[/thread]) and MESSAGE_ACK (op 21) per U2 contracts;
 *   CALL_STATE_UPDATE (op 22) and CALL_SIGNAL (op 23) per the calls plan
 *   (U1) — call control rides the main gateway (KTD3).
 */

import {
  GATEWAY_VERSION,
  GatewayOp,
  CLIENT_HELLO,
  CALL_SIGNAL_BODY_MAX_BYTES,
  isCallControlAction,
  isCallSignalKind,
  isCompressionMode,
  isGatewayEnvelope,
  makeSnowflake,
  type CompressionMode,
  type EventName,
  type GatewayCallSignalPayload,
  type GatewayCallStateUpdatePayload,
  type GatewayClientMessageAckPayload,
  type GatewayClientTypingStartPayload,
  type GatewayEnvelope,
  type GatewayHelloPayload,
  type GatewayIdentifyPayload,
  type GatewayResumePayload,
  type Ready,
} from '@cytale/protocol';
import {
  detectNativeZstd,
  detectStreamingInflate,
  makeGatewayInflater,
  normalizePreferredCompression,
  selectCompression,
  type GatewayInflater,
} from './compression.js';
import {
  GatewayOfflineError,
  GatewayActiveError,
  type AnyDispatchHandler,
  type ConnectionState,
  type DispatchHandler,
  type DispatchMeta,
  type GatewayClientOptions,
  type GatewaySocketFactory,
  type GatewaySocketLike,
  type SequenceGapInfo,
  type SocketCloseInfo,
  type StateChange,
  type StoredSession,
  type TelemetrySnapshot,
} from './types.js';

const MIN_RECONNECT_DELAY_MS_DEFAULT = 500;
const MAX_RECONNECT_DELAY_MS_DEFAULT = 30_000;
const JITTER_RATIO_DEFAULT = 0.25;

/**
 * Bound on one connect attempt (F5b): the socket must reach `open` — or
 * report a failure — inside this window, otherwise it is closed and the
 * reconnect backoff takes over.
 *
 * Tradeoff on slow networks: a cold TCP + TLS + WebSocket upgrade to a
 * distant/loaded server can legitimately take several seconds, and aborting
 * at the bound means one wasted attempt plus a backoff delay before the next
 * try. 15s sits above OkHttp's 10s socket-connect default (so the platform
 * rarely wins the race outright) and well below NSURLSession's 60s, which is
 * the window a black-holed connect would otherwise stall the client in
 * `connecting` for. The delay is retried with exponential backoff + jitter
 * (500ms → 30s), so a persistently slow network converges instead of spinning.
 */
export const CONNECT_TIMEOUT_MS_DEFAULT = 15_000;

/**
 * How long the WHOLE opening handshake (socket open -> Hello -> Identify or
 * Resume -> Ready/Resumed) may take before the connection is torn down and
 * reconnected (hardening plan 6.1).
 *
 * `CONNECT_TIMEOUT_MS` bounds only the socket open, and the heartbeat timer
 * cannot help inside this window: the server closes 4003 on a heartbeat that
 * beats its own Identify processing, so the client deliberately does not tick
 * until it is ready. Without a deadline a proxy that accepts the upgrade and
 * then goes silent wedges the client forever — connected socket, no heartbeat,
 * no missed-beat kill, no reconnect.
 */
export const HANDSHAKE_TIMEOUT_MS_DEFAULT = 20_000;

/** Consecutive missing heartbeat ACKs before the connection is killed. */
export const MAX_MISSED_HEARTBEATS_DEFAULT = 5;
/**
 * Client-side typing emit interval: while the author keeps typing, one
 * TYPING_START per channel[/thread] per this window (lane D #21).
 *
 * It used to be 1 s — a signal per second per typist fanned out to every
 * member of the channel, for an indicator whose receivers hold each typist
 * for several seconds anyway. 5 s keeps the indicator continuously lit: the
 * receiver's expiry (`TYPING_TIMEOUT_MS` in the web client, 7 s) outlasts the
 * gap between two emits plus delivery latency, so it never blinks off between
 * them. (The server's own floor is ~1/s/user/channel, so this is well inside it.)
 */
export const TYPING_THROTTLE_MS = 5_000;

/**
 * Bound on the compressed bytes buffered while the decompressor is not ready
 * yet (lane D #19). With Identify/Resume now sent only AFTER the inflater is
 * built, nothing compressed should arrive early at all; the buffer is the
 * belt-and-braces for a server that starts the stream first. A compressed
 * stream cannot skip bytes — dropping one frame corrupts every frame after
 * it — so overflowing the bound tears the connection down (resume/epoch
 * hydration converges) instead of silently dropping.
 */
export const EARLY_BINARY_BUFFER_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Gateway close 4004 — authentication failed. TERMINAL (hardening plan 6.3):
 * the credential was rejected, so replaying the same Identify/Resume on
 * backoff can only be rejected the same way. The client goes `dead` and
 * surfaces `onDead`; a later manual `connect()` (with whatever fresh token
 * the app has acquired) is the only way back.
 */
export const CLOSE_AUTH_FAILED = 4004;
/**
 * Gateway close 4013 — invalid intents (bots plan U7). TERMINAL, like 4014.
 * This NATIVE client (`cytale_` credentials) never receives it — the server
 * ignores the `intents` Identify field on native sessions entirely; 4013 is
 * only ever sent to compat (`cytbot_`) sessions. Classified terminal anyway:
 * a handshake the server refuses must not become an infinite reconnect loop.
 */
export const CLOSE_INVALID_INTENTS = 4013;
/** Gateway close 4014 — disallowed intents (a set this app may not request). TERMINAL. */
export const CLOSE_DISALLOWED_INTENTS = 4014;

/** Human-readable label per terminal code (structural diagnostics only). */
const TERMINAL_CLOSE_REASONS: ReadonlyMap<number, string> = new Map([
  [CLOSE_AUTH_FAILED, 'authentication failed'],
  [CLOSE_INVALID_INTENTS, 'invalid intents'],
  [CLOSE_DISALLOWED_INTENTS, 'disallowed intents'],
]);

/** True iff a server close code is fatal: retrying cannot change the answer. */
function isTerminalCloseCode(code: number): boolean {
  return TERMINAL_CLOSE_REASONS.has(code);
}

/** Fallback heartbeat cadence when Hello omits heartbeat_interval. */
const HEARTBEAT_INTERVAL_FALLBACK_MS = 45_000;
const RESUME_RETRY_BASE_DELAY_MS = 250;

type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * Structural diagnostics for one malformed inbound frame (F5a, 6.2). No
 * payload bytes are retained: only how the frame failed and its size.
 */
export interface MalformedFrameInfo {
  /** Which check rejected the frame. */
  kind: 'not_json' | 'not_envelope' | 'codec' | 'payload';
  /**
   * Event name (or `Hello`) when the frame PARSED but its payload failed a
   * per-event guard (6.2). Structural identifier only, never content.
   */
  event?: string;
  /** UTF-8 byte length of the offending frame text (0 when not measured). */
  bytes: number;
  /** Codec/decompressor/guard failure description (never frame content). */
  detail?: string;
}

/** States in which the socket is live enough to carry client commands. */
function isActiveState(state: ConnectionState): boolean {
  return state === 'connected' || state === 'ready';
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

function cancelTimer(handle: TimerHandle | null): void {
  if (handle !== null) clearTimeout(handle);
}

function typingKey(channelId: string, threadId?: string): string {
  return threadId === undefined ? channelId : `${channelId}|${threadId}`;
}

function requireSnowflake(value: string, fieldName: string): void {
  try {
    makeSnowflake(value);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new TypeError(`invalid snowflake for ${fieldName}: ${detail}`);
  }
}

/**
 * One UTF-8 encoder for the process. Constructing a `TextEncoder` allocates
 * its internal state, and `utf8ByteLength` runs on the op-23 call-signal path
 * (every SDP/ICE frame), so it is hoisted here rather than rebuilt per frame.
 */
const UTF8_ENCODER = new TextEncoder();

/**
 * UTF-8 byte length of `value` (the op-23 body cap is measured in bytes,
 * not UTF-16 code units — a naive `.length` would pass multi-byte SDP the
 * server then rejects).
 */
function utf8ByteLength(value: string): number {
  return UTF8_ENCODER.encode(value).length;
}

/** Coerce a websocket message event payload to text or bytes. */
function normalizeInbound(
  raw: unknown,
): string | Uint8Array | ArrayBuffer | null {
  if (typeof raw === 'string') return raw;
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return raw;
  // Blob payloads are rejected by the caller-side check below (async extract
  // impossible synchronously); document rather than half-support.
  // Node-style { data, type } message wrappers (fake sockets may use these).
  if (
    typeof raw === 'object' &&
    raw !== null &&
    'data' in (raw as Record<string, unknown>)
  ) {
    return normalizeInbound((raw as Record<string, unknown>)['data']);
  }
  return null;
}

/**
 * JSON-derived payloads are records, arrays, or primitives — a `Date` can
 * never arrive off the wire, so the protocol's stricter isPlainObject is not
 * needed here.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Structural description of a non-record payload (never the value itself). */
function payloadShape(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (value === undefined) return 'absent';
  return `a ${typeof value}`;
}

/**
 * Minimal per-event payload guard (hardening plan 6.2).
 *
 * The protocol deliberately keeps deep `d` validation out of the hot path
 * (envelope.ts documents it), and nothing replaced it — so `payload as Ready`
 * threw a TypeError on `d: null` straight out of `socket.onmessage`, before
 * the state machine advanced. These guards are that replacement, kept
 * deliberately shallow:
 *
 * - EVERY mapped payload must be a plain object (catches `null`, arrays and
 *   scalars on any event, the common data events included);
 * - `Ready` additionally carries the fields the CLIENT ITSELF reads
 *   (`session_id`, `resume_token`), so they are type-checked here;
 * - nothing else is inspected. Deeper field validation belongs to the
 *   consumer, and a stricter guard would reject wire-legal payloads the
 *   client does not need to understand (additive/partial events).
 *
 * Returns a structural failure description (field NAMES and types only —
 * never values), or null when the payload passes.
 */
function dispatchPayloadFailure(
  eventName: EventName,
  payload: unknown,
): string | null {
  if (!isPlainRecord(payload)) {
    return `payload is ${payloadShape(payload)} (expected an object)`;
  }
  if (eventName === 'Ready') {
    const sessionId = payload['session_id'];
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return 'session_id is not a non-empty string';
    }
    if (typeof payload['resume_token'] !== 'string') {
      return 'resume_token is not a string';
    }
  }
  // `Resumed` and every data event read nothing off `d` in this client; the
  // object-shape check above is their whole client-side contract.
  return null;
}

/**
 * Error name for the last-resort dispatch catch. Deliberately NOT the
 * message: a user callback can throw with arbitrary text, and F5a's rule is
 * that diagnostics never carry payload content.
 */
function dispatchErrorDetail(err: unknown): string {
  return `unhandled ${err instanceof Error ? err.name : typeof err} in dispatch`;
}

/**
 * Compression codecs offered by the server. Launch protocol defines Hello as
 * `{heartbeat_interval}` only (payloads.ts), so an absent `compress` array
 * means NOTHING is offered ⇒ the client negotiates 'none' and sends
 * `compress: null` in Identify. When present, unknown mode strings are
 * dropped and known ones kept.
 */
function collectOfferedCompressions(
  hello: Partial<GatewayHelloPayload> | null | undefined,
): CompressionMode[] {
  // The server's Hello offers codecs under `compression_modes` (its
  // long-standing extension); some fakes/older builds used `compress`.
  // Accept both — a missed offer silently downgrades every session to text.
  const h = hello as { compress?: unknown; compression_modes?: unknown } | null | undefined;
  const raw = Array.isArray(h?.compression_modes) ? h!.compression_modes : h?.compress;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isCompressionMode);
}

/**
 * The gateway client. Construct with options; call `connect()` to start the
 * lifecycle; `disconnect()` pauses reconnects; `destroy()` tears down.
 */
export class GatewayClient {
  private readonly url: string;
  private readonly tokenProvider: () => string | Promise<string>;
  private readonly socketFactory: GatewaySocketFactory;
  private readonly preferredCompression: ReturnType<
    typeof normalizePreferredCompression
  >;
  private readonly zstdWasmLoader?: NonNullable<
    GatewayClientOptions['zstdWasmLoader']
  >;
  private readonly identifyProperties: typeof CLIENT_HELLO;
  private readonly minReconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly jitterRatio: number;
  private readonly maxMissedHeartbeatsLimit: number;
  private readonly resumeMaxRetries: number;
  private readonly connectTimeoutMs: number;
  private readonly rng: () => number;
  private readonly nowFn: () => number;
  private readonly cb: Pick<
    GatewayClientOptions,
    | 'onStateChange'
    | 'onInvalidSession'
    | 'onResumeGap'
    | 'onHeartbeatMiss'
    | 'onDead'
    | 'onSocketError'
    | 'onClosed'
  >;

  // -- mutable runtime ------------------------------------------------------
  private state: ConnectionState = 'new';
  private socket: GatewaySocketLike | null = null;
  private inflater: GatewayInflater | null = null;
  /** Binary frames that beat the async inflater setup (flushed on resolve). */
  private pendingBinaryFrames: Uint8Array[] = [];
  private pendingBinaryBytes = 0;
  private connecting: Promise<void> | null = null;
  private destroyed = false;
  private suppressReconnect = false;

  private storedSession: StoredSession | null = null;
  private lastSeq = 0;
  private negotiatedCodec: CompressionMode | 'none' = 'none';

  private hbTimer: TimerHandle | null = null;
  /** Opening-handshake deadline (see HANDSHAKE_TIMEOUT_MS_DEFAULT). */
  private handshakeTimer: TimerHandle | null = null;
  private handshakeTimeoutMs: number;
  /**
   * True once Ready/Resumed landed for the CURRENT socket. The deadline is
   * armed after the socket-open promise resolves, which is a microtask LATER
   * than an inbound frame can already have been handled (a fast server, a
   * test's synchronous fake): without this flag that frame would clear a timer
   * that had not been armed yet, and the timer armed afterwards would fire
   * mid-session and tear down a perfectly healthy connection.
   */
  private handshakeSettled = false;
  private missedHeartbeats = 0;
  /** True from beat send until HeartbeatACK (or teardown) clears it. */
  private awaitingAck = false;

  private reconnectTimer: TimerHandle | null = null;
  private reconnectAttempts = 0;

  private typingSentAt = new Map<string, number>();

  private readonly listeners = new Map<EventName, Set<DispatchHandler<never>>>();
  private readonly anyListeners = new Set<AnyDispatchHandler>();

  private readonly telemetry: TelemetrySnapshot = {
    reconnects_total: 0,
    heartbeats_sent_total: 0,
    heartbeats_missed_total: 0,
    resume_attempts_total: 0,
    resume_successes_total: 0,
    resume_gap_total: 0,
    dispatch_duplicates_dropped_total: 0,
    dispatch_sequence_total: 0,
    inbound_frames_total: 0,
    sink_delivered_total: 0,
    binary_pushed_total: 0,
    invalid_sessions_total: 0,
    malformed_frames_total: 0,
    dispatch_errors_total: 0,
    listener_errors_total: 0,
    commands_dropped_offline_total: 0,
  };

  constructor(options: GatewayClientOptions) {
    if (typeof options?.url !== 'string' || options.url.length === 0) {
      throw new TypeError('GatewayClient requires options.url');
    }
    if (typeof options.tokenProvider !== 'function') {
      throw new TypeError('GatewayClient requires options.tokenProvider');
    }

    this.url = options.url;
    this.tokenProvider = options.tokenProvider;
    this.socketFactory =
      options.socketFactory ??
      ((u: string): GatewaySocketLike =>
        new WebSocket(u) as unknown as GatewaySocketLike);
    this.preferredCompression = normalizePreferredCompression(options.compression);
    this.zstdWasmLoader = options.zstdWasmLoader;
    this.identifyProperties = { ...CLIENT_HELLO, ...(options.properties ?? {}) };
    this.minReconnectDelayMs =
      options.minReconnectDelayMs ?? MIN_RECONNECT_DELAY_MS_DEFAULT;
    this.maxReconnectDelayMs = Math.max(
      this.minReconnectDelayMs,
      options.maxReconnectDelayMs ?? MAX_RECONNECT_DELAY_MS_DEFAULT,
    );
    this.jitterRatio = Math.min(
      1,
      Math.max(0, options.jitterRatio ?? JITTER_RATIO_DEFAULT),
    );
    this.maxMissedHeartbeatsLimit =
      options.maxMissedHeartbeats ?? MAX_MISSED_HEARTBEATS_DEFAULT;
    this.resumeMaxRetries = options.resumeMaxRetries ?? 1;
    this.connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS_DEFAULT;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS_DEFAULT;
    this.rng = options.rng ?? Math.random;
    this.nowFn = options.now ?? Date.now;
    this.cb = {
      onStateChange: options.onStateChange,
      onInvalidSession: options.onInvalidSession,
      onResumeGap: options.onResumeGap,
      onHeartbeatMiss: options.onHeartbeatMiss,
      onDead: options.onDead,
      onSocketError: options.onSocketError,
      onClosed: options.onClosed,
    };
  }

  // -- public API -----------------------------------------------------------

  /**
   * Open the socket and run Hello → Identify/Resume. Concurrent calls share
   * one attempt. Resolves when the socket opens; later handshake problems
   * surface via close/reconnect machinery instead of rejecting callers.
   */
  connect(): Promise<void> {
    if (this.destroyed) {
      return Promise.reject(new GatewayActiveError('dead'));
    }
    this.suppressReconnect = false;
    if (this.socket && isActiveState(this.state)) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = this.openAndHandshake().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  /** Polite local close; keeps resume eligibility until the window lapses. */
  disconnect(): void {
    this.suppressReconnect = true;
    cancelTimer(this.hbTimer);
    this.hbTimer = null;
    cancelTimer(this.reconnectTimer);
    this.reconnectTimer = null;
    this.closeSocketLocally(1000, 'client disconnect');
    this.applyState('disconnected');
  }

  /** Terminal teardown; further connect() calls reject. */
  destroy(): void {
    this.destroyed = true;
    this.disconnect();
    this.listeners.clear();
    this.anyListeners.clear();
    this.typingSentAt.clear();
    this.applyState('dead');
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  /** Last processed dispatch sequence number (0 before any dispatch). */
  get lastSequenceNumber(): number {
    return this.lastSeq;
  }

  /** Codec negotiated at Hello time ('none' pre-handshake / when declined). */
  get compressionCodec(): CompressionMode | 'none' {
    return this.negotiatedCodec;
  }

  getTelemetry(): TelemetrySnapshot {
    return { ...this.telemetry };
  }

  getSession(): StoredSession | null {
    return this.storedSession ? { ...this.storedSession } : null;
  }

  /** Subscribe to one dispatch event name; returns an unsubscribe function. */
  on<K extends EventName>(eventName: K, handler: DispatchHandler<K>): () => void {
    let set = this.listeners.get(eventName);
    if (!set) {
      set = new Set();
      this.listeners.set(eventName, set);
    }
    set.add(handler as DispatchHandler<never>);
    return () => {
      set.delete(handler as DispatchHandler<never>);
    };
  }

  /** Subscribe to every dispatch regardless of event name. */
  onAny(handler: AnyDispatchHandler): () => void {
    this.anyListeners.add(handler);
    return () => {
      this.anyListeners.delete(handler);
    };
  }

  /**
   * Drop typing-throttle entries whose window has lapsed (`>=` the throttle
   * window — exactly the complement of the suppression check in `sendTyping`,
   * so pruning can never change what is sent). This runs on every send, and a
   * send is the map's only writer, so the map is bounded by the channel/thread
   * keys typed within the last window instead of growing with every channel
   * the member has ever typed in.
   */
  private pruneTypingSentAt(now: number): void {
    for (const [key, sentAt] of this.typingSentAt) {
      if (now - sentAt >= TYPING_THROTTLE_MS) this.typingSentAt.delete(key);
    }
  }

  /**
   * Typing signal (op 20), throttled client-side to one per TYPING_THROTTLE_MS
   * per channel[/thread]. Returns true when sent; false when suppressed by
   * the throttle window OR dropped because the gateway is offline.
   */
  sendTyping(channelId: string, threadId?: string): boolean {
    requireSnowflake(channelId, 'channel_id');
    if (threadId !== undefined) requireSnowflake(threadId, 'thread_id');

    const now = this.nowFn();
    this.pruneTypingSentAt(now);
    const key = typingKey(channelId, threadId);
    const lastSentAt = this.typingSentAt.get(key);
    if (lastSentAt !== undefined && now - lastSentAt < TYPING_THROTTLE_MS) {
      return false;
    }
    this.typingSentAt.set(key, now);

    const payload: GatewayClientTypingStartPayload =
      threadId === undefined
        ? { channel_id: channelId }
        : { channel_id: channelId, thread_id: threadId };
    try {
      this.sendCommand(GatewayOp.TYPING_START_CLIENT, payload);
      return true;
    } catch {
      this.typingSentAt.delete(key);
      return false;
    }
  }

  /**
   * Client-declared activity status (op 3): online/idle/dnd only — offline is
   * server-derived on socket close, and invisibility is cut from launch.
   * Throws GatewayOfflineError when the gateway is unreachable.
   */
  updatePresence(status: 'online' | 'idle' | 'dnd' | 'invisible'): void {
    this.sendCommand(GatewayOp.PresenceUpdate, { status });
  }

  /**
   * Read acknowledgement command (op 21). Deliberately not throttled (read
   * state must converge across devices); throws GatewayOfflineError when the
   * gateway is unreachable and TypeError on malformed ids.
   */
  sendMessageAck(payload: GatewayClientMessageAckPayload): void {
    requireSnowflake(payload.channel_id, 'channel_id');
    for (const id of payload.message_ids) {
      requireSnowflake(id, `message_ids[${id}]`);
    }
    this.sendCommand(GatewayOp.MESSAGE_ACK, payload);
  }

  /**
   * Voice-call control plane (op 22, calls plan U1): start/join/leave/state.
   * Validates the channel snowflake and the action enum, then sends — the
   * server owns per-session throttling (KTD3). Throws TypeError on
   * malformed payloads and GatewayOfflineError when unreachable (a dropped
   * control verb is the caller's error to surface, never a silent no-op).
   */
  sendCallState(payload: GatewayCallStateUpdatePayload): void {
    requireSnowflake(payload.channel_id, 'channel_id');
    if (!isCallControlAction(payload.action)) {
      throw new TypeError(`invalid call control action: ${String(payload.action)}`);
    }
    this.sendCommand(GatewayOp.CALL_STATE_UPDATE, payload);
  }

  /**
   * Media-signaling relay (op 23, calls plan U1): opaque `kind: sdp|ice`
   * bodies toward the room. The body is pre-sized against the shared
   * server cap — CALL_SIGNAL_BODY_MAX_BYTES, 128 KiB since the calls V2
   * spike raised it (VM14) — with a TypeError beyond it (the server would
   * reject it anyway, and a silently-dropped SDP answer wedges the
   * negotiation). Throws GatewayOfflineError when unreachable.
   */
  sendCallSignal(payload: GatewayCallSignalPayload): void {
    requireSnowflake(payload.channel_id, 'channel_id');
    if (!isCallSignalKind(payload.kind)) {
      throw new TypeError(`invalid call signal kind: ${String(payload.kind)}`);
    }
    if (typeof payload.body !== 'string' || payload.body.length === 0) {
      throw new TypeError('call signal body must be a non-empty string');
    }
    if (utf8ByteLength(payload.body) > CALL_SIGNAL_BODY_MAX_BYTES) {
      throw new TypeError(
        `call signal body exceeds ${CALL_SIGNAL_BODY_MAX_BYTES} bytes (server cap)`,
      );
    }
    this.sendCommand(GatewayOp.CALL_SIGNAL, payload);
  }

  /** Teardown/reopen immediately (still honours backoff bounds once). */
  forceReconnect(reason = 'manual'): void {
    if (this.destroyed || this.suppressReconnect) return;
    this.closeSocketHard(4000, `client-forced reconnect: ${reason}`);
    this.scheduleReconnect(reason);
  }

  /** Introspection for tests and the U28 harness. */
  get diagnostics(): { missedHeartbeats: number; reconnectAttempts: number } {
    return {
      missedHeartbeats: this.missedHeartbeats,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  /** SINGLE mutation point for `state`; emits options.onStateChange. */
  applyState(to: ConnectionState): void {
    if (this.state === to) return;
    const change: StateChange = { from: this.state, to };
    this.state = to;
    this.cb.onStateChange?.(change);
  }

  // -- connect pipeline -------------------------------------------------

  private async openAndHandshake(): Promise<void> {
    this.applyState('connecting');
    this.handshakeSettled = false;
    const socket = this.socketFactory(this.url);
    // Binary frames as ArrayBuffer, NOT the platform default Blob: Blob
    // payloads cannot be decoded synchronously and would be dropped by
    // normalizeInbound — every compressed dispatch would vanish.
    if ('binaryType' in socket) {
      (socket as { binaryType?: string }).binaryType = 'arraybuffer';
    }
    this.socket = socket;
    socket.onmessage = (raw) => {
      this.handleRawMessage(raw);
    };

    // Await the opening handshake; handlers below serve both the opening
    // window (reject path) and the established phase (close/error routing).
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      // F5b: a black-holed connect (dropped SYNs, captive portal, an
      // airplane-mode race) fires NOTHING — the client would sit in
      // 'connecting' until the OS socket gives up (OkHttp ~10s, NSURLSession
      // up to 60s), with no retry in the meantime. Bound it: close the socket
      // and let the existing reconnect backoff own the next attempt.
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.closeSocketLocally(4009, 'connect timeout');
        this.scheduleReconnect('connect timeout');
        reject(new Error(`gateway connect timed out after ${this.connectTimeoutMs}ms`));
      }, this.connectTimeoutMs);
      socket.onopen = () => {
        if (settled) return;
        settled = true;
        cancelTimer(timeout);
        resolve();
      };
      socket.onerror = (err) => {
        if (!settled) {
          settled = true;
          cancelTimer(timeout);
          reject(
            new Error(`gateway socket error during connect: ${err?.message ?? 'unknown'}`),
          );
        } else {
          this.handleSocketError(err);
        }
      };
      socket.onclose = (info) => {
        if (!settled) {
          settled = true;
          cancelTimer(timeout);
          // A terminal code can also land INSIDE the connect window (before
          // `open` settles). Classify it the same way there, or the reconnect
          // timer's own retry catch would loop on it forever.
          if (isTerminalCloseCode(info.code)) {
            this.detachSocketHandlers();
            this.cb.onClosed?.(info);
            this.handleTerminalClose(info);
          }
          reject(new Error(`gateway closed during connect (${info.code})`));
        } else {
          this.handleRemoteClose(info);
        }
      };
    });

    if (this.storedSessionHasResumeMaterial()) {
      // Optimistic label; confirmed 'ready' on Resumed dispatch.
      this.applyState('resuming');
    } else {
      this.applyState('identifying');
    }

  }

  private armHandshakeDeadline(): void {
    cancelTimer(this.handshakeTimer);

    if (this.handshakeSettled) return;

    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      if (this.destroyed || this.suppressReconnect) return;
      if (this.state === 'ready') return;
      this.teardownConnectionNow('handshake timeout', true);
    }, this.handshakeTimeoutMs);
  }

  private storedSessionHasResumeMaterial(): boolean {
    const session = this.storedSession;
    return session !== null && session.resumeToken !== '';
  }

  // -- inbound frames -----------------------------------------------------

  private handleRawMessage(raw: unknown): void {
    this.telemetry.inbound_frames_total++;
    const inbound = normalizeInbound(raw);
    if (inbound === null) {
      this.telemetry.malformed_frames_total++;
      return;
    }
    if (typeof inbound === 'string') {
      this.processFrameText(inbound);
      return;
    }
    const bytes = inbound instanceof ArrayBuffer ? new Uint8Array(inbound) : inbound;

    // The inflater resolves asynchronously after Hello — binary frames can
    // legitimately beat it. Buffer (bounded) and flush on resolution instead
    // of dropping: a dropped dispatch is a silently missed event.
    const inflater = this.inflater;
    if (!inflater) {
      // Bounded by BYTES, and never lossy (lane D #19): the old cap of 64
      // frames DROPPED the 65th — and a dropped frame of a compressed stream
      // corrupts every frame after it. Over the bound, reconnect instead.
      if (this.pendingBinaryBytes + bytes.byteLength > EARLY_BINARY_BUFFER_MAX_BYTES) {
        this.recordMalformed({
          kind: 'codec',
          bytes: bytes.byteLength,
          detail: 'compressed frames arrived before the decompressor and overflowed the early buffer',
        });
        this.teardownConnectionNow('early compressed buffer overflow', true);
        return;
      }
      this.pendingBinaryFrames.push(bytes);
      this.pendingBinaryBytes += bytes.byteLength;
      return;
    }

    // zlib_stream delivery is driven by the STANDING collector inside the
    // inflater's pipe (see StreamInflater): each decoded span is delivered
    // the moment the decompressor releases it. Pairing a read with this
    // write — the old model — jams when the decompressor coalesces or splits
    // chunk boundaries, stranding every later dispatch behind a read that
    // cannot resolve until the NEXT write arrives (#26). push() here only
    // feeds bytes; it resolves when they are written, not when they decode.
    this.telemetry.binary_pushed_total++;
    inflater
      .push(bytes)
      .then((texts) => {
        for (const text of texts) this.processFrameText(text);
      })
      .catch(() => {
        this.telemetry.malformed_frames_total++;
      });
  }

  /**
   * Last malformed frames (#26 diagnostics) — STRUCTURAL ONLY: where the
   * frame failed and how big it was, never the payload. A truncated raw
   * inbound frame can hold message content (and a prefix of an auth/identify
   * frame could hold a token), so the former raw-text capture was removed
   * rather than truncated. Bounded to the last 3; `malformed_frames_total`
   * keeps the running count.
   */
  lastMalformed: MalformedFrameInfo[] = [];
  /** #26 diagnostics: handleHello invocations. */
  helloCount = 0;
  /** #26 diagnostics: current pending-binary buffer depth. */
  pendingDepth(): number {
    return this.pendingBinaryFrames.length;
  }

  private recordMalformed(info: MalformedFrameInfo): void {
    this.telemetry.malformed_frames_total++;
    this.lastMalformed.push(info);
    if (this.lastMalformed.length > 3) this.lastMalformed.shift();
  }

  /**
   * A dispatch whose payload failed a per-event guard (or whose handler threw).
   * Bumps the dedicated `dispatch_errors_total` and lands in the same
   * structural ring as every other malformed frame — `malformed_frames_total`
   * moves with it, since a frame we cannot trust IS malformed.
   */
  private recordDispatchError(
    eventName: EventName,
    bytes: number,
    detail: string,
  ): void {
    this.telemetry.dispatch_errors_total++;
    this.recordMalformed({ kind: 'payload', event: eventName, bytes, detail });
  }

  private processFrameText(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.recordMalformed({ kind: 'not_json', bytes: utf8ByteLength(text) });
      return;
    }
    if (!isGatewayEnvelope(parsed)) {
      this.recordMalformed({ kind: 'not_envelope', bytes: utf8ByteLength(text) });
      return;
    }
    const envelope = parsed as GatewayEnvelope;
    switch (envelope.op) {
      case GatewayOp.Dispatch:
        // Shape contract (known t, integer s >= 0) enforced by the guard;
        // the payload guard + catch live in safeDispatch (6.2).
        this.safeDispatch(
          envelope.t as EventName,
          envelope.s as number,
          envelope.d,
          text,
        );
        break;
      case GatewayOp.Hello:
        // Hello carries the heartbeat cadence AND arms the handshake
        // deadline — a non-object payload cannot be negotiated from and would
        // otherwise throw inside the async handler (an unhandled rejection).
        // Treated like any other malformed frame: count + backoff retry.
        if (!isPlainRecord(envelope.d)) {
          this.recordMalformed({
            kind: 'payload',
            event: 'Hello',
            bytes: utf8ByteLength(text),
            detail: `payload is ${payloadShape(envelope.d)} (expected an object)`,
          });
          this.teardownConnectionNow('malformed Hello payload', true);
          break;
        }
        void this.handleHello(envelope.d as Partial<GatewayHelloPayload>);
        break;
      case GatewayOp.HeartbeatACK:
        this.clearMissedHeartbeats();
        if (isActiveState(this.state)) break;
        if (this.state === 'resuming' || this.state === 'identifying') {
          this.applyState('connected');
        }
        break;
      case GatewayOp.InvalidSession:
        this.handleInvalidSession(envelope.d === true);
        break;
      case GatewayOp.Reconnect:
        this.forceReconnect('server Reconnect op');
        break;
      default:
        break;
    }
  }

  private async handleHello(hello: Partial<GatewayHelloPayload>): Promise<void> {
    this.helloCount++;
    const interval =
      typeof hello.heartbeat_interval === 'number' && hello.heartbeat_interval > 0
        ? hello.heartbeat_interval
        : HEARTBEAT_INTERVAL_FALLBACK_MS;
    this.startHeartbeatTimer(interval);

    // Hello puts the handshake on the clock (hardening plan 6.1): the client is
    // about to Identify or Resume, and NOTHING else bounds the wait for
    // Ready/Resumed — the heartbeat timer cannot help (a heartbeat that beats the
    // server's Identify processing is closed 4003, so ticks are gated on 'ready').
    // A peer that goes silent here used to wedge the client for the life of the
    // process.
    //
    // Residual, stated rather than implied: a peer that accepts the upgrade and
    // never sends HELLO at all is still bounded only by the OS socket/connect
    // timeout. The deadline could be armed at socket open to close that too, but
    // the window it protects is the one this item names (Identify/Resume -> Ready),
    // and arming at open would make every legitimate slow first frame a teardown.
    this.armHandshakeDeadline();

    // #111: zlib is negotiable only when the runtime PROVES it can stream-
    // inflate (the persistent pipe never closes its source, so an engine
    // that releases inflate output only at close would decode nothing,
    // silently). The probe starts at module load and settles in
    // microseconds on streaming engines; awaiting it here adds nothing to
    // Identify's latency (the token fetch below dominates). Socket guard:
    // a close during the await must not identify on a dead socket.
    const socket = this.socket;
    const canStreamInflate = await detectStreamingInflate();
    if (this.destroyed || this.socket !== socket) return;

    this.negotiatedCodec = selectCompression(
      this.preferredCompression,
      collectOfferedCompressions(hello),
      detectNativeZstd(),
      Boolean(this.zstdWasmLoader),
      canStreamInflate,
    );

    // Lane D #19: the decompressor is READY before Identify/Resume goes out.
    // It used to be built in the background while the handshake was sent, so
    // the server's first compressed frames (READY's tail, a resume replay)
    // could beat it — buffered up to a frame cap and then DROPPED, which
    // corrupts a compressed stream for good. The build is a module init at
    // worst (zstd wasm); awaiting it costs the handshake nothing it did not
    // already wait for (the token fetch below dominates).
    let inflater: GatewayInflater;
    try {
      inflater = await makeGatewayInflater(this.negotiatedCodec, {
        zstdWasmLoader: this.zstdWasmLoader,
      });
    } catch (err) {
      if (this.destroyed || this.socket !== socket) return;
      this.recordMalformed({
        kind: 'codec',
        bytes: 0,
        detail: `decompressor init failed: ${err instanceof Error ? err.name : typeof err}`,
      });
      this.teardownConnectionNow('decompressor init failed', true);
      return;
    }
    // A close during the await must not identify on a dead socket (nor leak
    // the inflater it built).
    if (this.destroyed || this.socket !== socket) {
      inflater.dispose?.();
      return;
    }
    {
      // Sink mode where supported (zlib): spans deliver the moment they
      // decode, independent of any push()'s completion (#26).
      inflater.setSink?.((text) => {
        this.telemetry.sink_delivered_total++;
        this.processFrameText(text);
      });
      // Collector death = dead deflate stream: reconnect and converge via
      // resume/epoch hydration. NEVER drain into silence (#26).
      inflater.setOnError?.((reason) => {
        const r = reason as { message?: string; stack?: string } | undefined;
        this.recordMalformed({
          kind: 'codec',
          bytes: 0,
          detail: `${r?.constructor?.name ?? typeof reason}: ${r?.message ?? ''} @ ${(r?.stack ?? '').split('\n')[1]?.trim().slice(0, 140)}`.slice(
            0,
            200,
          ),
        });
        this.teardownConnectionNow(`compressed stream corrupted (${String(reason).slice(0, 80)})`, true);
      });
      this.inflater = inflater;
      const buffered = this.pendingBinaryFrames;
      this.pendingBinaryFrames = [];
      this.pendingBinaryBytes = 0;
      for (const bytes of buffered) {
        this.telemetry.binary_pushed_total++;
        inflater
          .push(bytes)
          .then((texts) => {
            // Sink mode delivers directly; push-returns stay for codecs
            // without a collector (zstd/none).
            for (const text of texts) this.processFrameText(text);
          })
          .catch(() => {
            this.telemetry.malformed_frames_total++;
          });
      }
    }

    if (this.storedSessionHasResumeMaterial()) {
      this.tryResume();
    } else {
      this.identify();
    }
  }

  private identify(): void {
    Promise.resolve()
      .then(() => this.tokenProvider())
      .then((token) => {
        const payload: GatewayIdentifyPayload = {
          token,
          v: GATEWAY_VERSION,
          compress: this.negotiatedCodec === 'none' ? null : this.negotiatedCodec,
          properties: this.identifyProperties,
        };
        this.applyState('identifying');
        this.sendCommand(GatewayOp.Identify, payload);
      })
      .catch((err: unknown) => {
        this.cb.onSocketError?.({ message: `token provider failed: ${String(err)}` });
        this.teardownConnectionNow('token provider failure', true);
      });
  }

  private tryResume(attempt = 0): void {
    const session = this.storedSession;
    if (!session || session.resumeToken === '') {
      this.identify();
      return;
    }
    this.telemetry.resume_attempts_total++;
    this.reconnectAttempts = 0;
    this.applyState('resuming');
    const sendResume = (token: string): void => {
      const payload: GatewayResumePayload = {
        session_id: session.sessionId,
        seq: this.lastSeq,
        resume_token: session.resumeToken,
        // The server re-authenticates every Resume on the fresh socket before
        // adopting the session (U10 op_resume): same token source as Identify.
        token,
      };
      try {
        this.sendCommand(GatewayOp.Resume, payload);
      } catch {
        if (attempt < this.resumeMaxRetries) {
          setTimeout(
            () => {
              if (!this.destroyed && !this.suppressReconnect) this.tryResume(attempt + 1);
            },
            RESUME_RETRY_BASE_DELAY_MS * (attempt + 1),
          );
        } else {
          this.storedSession = null;
          this.identify();
        }
      }
    };
    Promise.resolve()
      .then(() => this.tokenProvider())
      .then(sendResume)
      .catch((err: unknown) => {
        this.cb.onSocketError?.({ message: `resume token provider failed: ${String(err)}` });
        this.teardownConnectionNow('resume token provider failure', true);
      });
  }

  private handleInvalidSession(resumable: boolean): void {
    this.telemetry.invalid_sessions_total++;
    this.cb.onInvalidSession?.(resumable);
    // Either way the old identity cannot be replayed verbatim: resumable=true
    // lets us retry Resume (server kept the window open), false means the
    // session is gone entirely and a brand-new Identify must follow.
    if (resumable) {
      this.tryResume();
    } else {
      // The not-resumable reply arrives on a socket the server is about to
      // CLOSE — identifying on it would throw into the void and wedge the
      // client (observed: post-restart reconnect stalls forever). Reset the
      // identity and take a FRESH connection (Hello → Identify on the new
      // socket) via the reconnect path.
      this.storedSession = null;
      this.lastSeq = 0;
      if (this.destroyed || this.suppressReconnect) return;
      this.closeSocketHard(4000, 'invalid session (not resumable) — fresh identify');
      this.scheduleReconnect('invalid session (not resumable)');
    }
  }

  // -- outbound -------------------------------------------------------------

  /**
   * Send a command frame. Allowed whenever the socket exists (the handshake
   * itself — Identify/Resume — must be sendable before connected/ready),
   * with one exception: heartbeats gate on an ACTIVE lifecycle state via
   * their caller. Any failure throws GatewayOfflineError.
   */
  private sendCommand(op: number, d: unknown): void {
    const socket = this.socket;
    if (!socket) {
      this.telemetry.commands_dropped_offline_total++;
      throw new GatewayOfflineError(`op ${op}`);
    }
    try {
      socket.send(JSON.stringify({ op, d }));
    } catch (err) {
      this.telemetry.commands_dropped_offline_total++;
      throw new GatewayOfflineError(
        `op ${op}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // -- heartbeat ---------------------------------------------------------

  private startHeartbeatTimer(intervalMs: number): void {
    cancelTimer(this.hbTimer);
    this.hbTimer = setInterval(() => this.heartbeatTick(), intervalMs);
  }

  private clearMissedHeartbeats(): void {
    this.missedHeartbeats = 0;
    this.awaitingAck = false;
  }

  private heartbeatTick(): void {
    if (!isActiveState(this.state)) return;
    // The PREVIOUS beat's ACK never arrived inside one interval?
    if (this.awaitingAck) {
      this.missedHeartbeats++;
      this.telemetry.heartbeats_missed_total++;
      this.cb.onHeartbeatMiss?.(this.missedHeartbeats);
      if (this.missedHeartbeats >= this.maxMissedHeartbeatsLimit) {
        this.teardownConnectionNow(`${this.missedHeartbeats} missed heartbeats`, true);
        return;
      }
    }
    try {
      this.sendCommand(GatewayOp.Heartbeat, this.lastSeq > 0 ? this.lastSeq : null);
      this.telemetry.heartbeats_sent_total++;
      this.awaitingAck = true;
    } catch {
      this.teardownConnectionNow('heartbeat send failure', true);
    }
  }

  // -- connection plumbing --------------------------------------------

  private handleSocketError(err: { message?: string }): void {
    this.cb.onSocketError?.({ message: err?.message });
  }

  private handleRemoteClose(info: SocketCloseInfo): void {
    this.detachSocketHandlers();
    this.cb.onClosed?.(info);
    if (isTerminalCloseCode(info.code)) {
      this.handleTerminalClose(info);
      return;
    }
    this.scheduleReconnect(`remote close ${info.code}`);
  }

  /**
   * A close whose retry cannot change the answer — 4004 (auth failed),
   * 4013/4014 (invalid/disallowed intents; hardening plan 6.3). TERMINAL:
   * `suppressReconnect` stops the backoff loop through the mechanism
   * `disconnect()` already uses (reused, not re-invented), the client enters
   * the terminal `dead` state, and `onDead` carries the reason. `destroyed`
   * is deliberately NOT set: `dead` is recoverable by a manual `connect()`
   * with fresh credentials, which is the documented contract on the state.
   */
  private handleTerminalClose(info: SocketCloseInfo): void {
    cancelTimer(this.reconnectTimer);
    this.reconnectTimer = null;
    this.suppressReconnect = true;
    this.applyState('dead');
    const label = TERMINAL_CLOSE_REASONS.get(info.code) ?? 'terminal close';
    this.cb.onDead?.({
      reason: `gateway closed ${info.code} (${label}); reconnect suppressed`,
    });
  }

  /** Drop timers + socket WITHOUT touching session identity. */
  private detachSocketHandlers(): void {
    cancelTimer(this.hbTimer);
    this.hbTimer = null;
    cancelTimer(this.handshakeTimer);
    this.handshakeTimer = null;
    this.missedHeartbeats = 0;
    this.awaitingAck = false;
    const socket = this.socket;
    this.socket = null;
    this.inflater?.dispose?.();
    this.inflater = null;
    this.pendingBinaryFrames = [];
    this.pendingBinaryBytes = 0;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
  }

  /** Local close on the CURRENT socket (detached handlers prevent callbacks). */
  private closeSocketLocally(code: number, reason: string): void {
    const socket = this.socket;
    this.detachSocketHandlers();
    if (!socket) return;
    try {
      socket.close(code, reason);
    } catch {
      /* already closed */
    }
  }

  private closeSocketHard(code: number, reason: string): void {
    this.closeSocketLocally(code, reason);
  }

  /** Immediate tear-down + (optionally) schedule the reconnect loop. */
  private teardownConnectionNow(reason: string, reconnect: boolean): void {
    this.missedHeartbeats = 0;
    this.closeSocketHard(4009, reason);
    if (isActiveState(this.state) || this.state === 'resuming' || this.state === 'identifying') {
      this.applyState(reconnect ? 'reconnecting' : 'disconnected');
    }
    if (reconnect) {
      this.scheduleReconnect(reason);
    } else {
      this.cb.onDead?.({ reason });
    }
  }

  /** Exponential backoff with symmetric ratio jitter around the curve. */
  private nextBackoffDelay(): number {
    const exp = Math.min(
      this.maxReconnectDelayMs,
      this.minReconnectDelayMs * 2 ** Math.min(this.reconnectAttempts - 1, 16),
    );
    const spread = exp * this.jitterRatio;
    const jitter = (this.rng() * 2 - 1) * spread;
    return Math.max(0, Math.round(exp + jitter));
  }

  private scheduleReconnect(why: string): void {
    if (this.destroyed || this.suppressReconnect) return;
    cancelTimer(this.reconnectTimer);
    this.reconnectAttempts++;
    this.telemetry.reconnects_total++;
    this.applyState('reconnecting');
    this.reconnectTimer = setTimeout(
      () => {
        this.reconnectTimer = null;
        void this.connect().catch(() => {
          // An attempt that failed on its own (connect timeout, socket error)
          // may already have scheduled the next one — don't stack a second
          // timer (and a second attempt counter bump) on top of it.
          if (this.reconnectTimer === null) this.scheduleReconnect(`retry after ${why}`);
        });
      },
      this.nextBackoffDelay(),
    );
  }

  // -- dispatch pipeline ---------------------------------------------------

  /**
   * Guarded entry point for every dispatch (hardening plan 6.2).
   *
   * A frame whose payload cannot be trusted also invalidates our position in
   * the stream (the sequence number was read off the same suspect frame), so
   * the honest recovery is the ordinary teardown + backoff rather than
   * limping on or letting the exception escape `socket.onmessage`. The
   * try/catch is the last-resort net for a throw the guards did not
   * anticipate — the historical bug class — and it counts and tears down
   * exactly like a guard failure. Listener throws never reach it: those are
   * already contained per-handler by `safeInvoke` and counted separately in
   * `listener_errors_total`.
   */
  private safeDispatch(
    eventName: EventName,
    seq: number,
    payload: unknown,
    frameText: string,
  ): void {
    const failure = dispatchPayloadFailure(eventName, payload);
    if (failure === null) {
      try {
        this.handleDispatch(eventName, seq, payload);
        return;
      } catch (err) {
        this.recordDispatchError(
          eventName,
          utf8ByteLength(frameText),
          dispatchErrorDetail(err),
        );
        this.teardownConnectionNow(`dispatch handler error (${eventName})`, true);
        return;
      }
    }
    this.recordDispatchError(eventName, utf8ByteLength(frameText), failure);
    this.teardownConnectionNow(`malformed ${eventName} payload`, true);
  }

  private handleDispatch(eventName: EventName, seq: number, payload: unknown): void {
    // "Have we locked onto the live sequence yet?" The READY dispatch itself
    // seeds lastSeq, so from the second dispatch onward gaps/duplicates are
    // Ready/Resumed are sequence-less control dispatches (s: 0 by protocol —
    // they open a stream rather than continue one). The duplicate/gap guards
    // below would eat a fresh READY after a session reset (0 <= lastSeq 0),
    // wedging the client at 'identifying' forever — observed post-restart.
    const isHandshake = eventName === 'Ready' || eventName === 'Resumed';

    // meaningful. Before that, arbitrary seq is accepted as the baseline.
    const seenAny = !isHandshake && (this.telemetry.dispatch_sequence_total > 1 || this.lastSeq > 0);

    if (seenAny && seq <= this.lastSeq) {
      this.telemetry.dispatch_duplicates_dropped_total++;
      return;
    }
    if (seenAny && seq > this.lastSeq + 1) {
      const gap: SequenceGapInfo = {
        expectedSeq: this.lastSeq + 1,
        receivedSeq: seq,
      };
      this.telemetry.resume_gap_total++;
      this.cb.onResumeGap?.(gap);
      // Full-sync fallback: rebuild state from scratch rather than pretending
      // continuity held. Next successful READY will signal recovery.
      this.dropSessionForFullSync();
    }

    // Seq adoption: Ready resets (fresh stream); Resumed adopts the server's
    // high-water mark when it carries one (s > 0) and otherwise keeps the
    // client's position (sequence-less control — the server replays from
    // what we reported); every other dispatch advances.
    if (eventName === 'Ready') {
      this.lastSeq = 0;
    } else if (eventName !== 'Resumed' || seq > 0) {
      this.lastSeq = seq;
    }
    this.telemetry.dispatch_sequence_total++;

    if (eventName === 'Ready') {
      const ready = payload as Ready;
      this.storedSession = {
        sessionId: ready.session_id,
        seq: 0,
        resumeToken: ready.resume_token,
      };
      this.lastSeq = 0;
      this.reconnectAttempts = 0;
    } else if (eventName === 'Resumed') {
      this.telemetry.resume_successes_total++;
      this.reconnectAttempts = 0;
      // The presented token was consumed by this Resume; the server hands
      // the next one back on Resumed. Adopt it so a later drop can resume
      // again. (An older server sends none: keep the captured one and let an
      // eventual InvalidSession(false) route us to a clean re-identity.)
      const next = (payload as { resume_token?: unknown }).resume_token;
      if (this.storedSession && typeof next === 'string' && next !== '') {
        this.storedSession = { ...this.storedSession, resumeToken: next };
      }
    }

    const meta: DispatchMeta = {
      seq: eventName === 'Ready' ? 0 : seq,
      eventName,
      receivedAt: this.nowFn(),
    };

    const set = this.listeners.get(eventName);
    if (set) {
      for (const handler of set) {
        const h = handler as unknown as (p: unknown, m: DispatchMeta) => void;
        this.safeInvoke(() => h(payload, meta));
      }
    }
    for (const anyHandler of this.anyListeners) {
      this.safeInvoke(() => {
        (anyHandler as (e: unknown, m: DispatchMeta) => void)({ op: 0, t: eventName, s: meta.seq, d: payload }, meta);
      });
    }

    if (eventName === 'Ready' || eventName === 'Resumed') {
      // The handshake is DONE: retirement is what makes the deadline a bound on
      // the handshake rather than on the session.
      this.handshakeSettled = true;
      cancelTimer(this.handshakeTimer);
      this.handshakeTimer = null;
      this.applyState('ready');
    }
  }

  private safeInvoke(fn: () => void): void {
    try {
      fn();
    } catch {
      this.telemetry.listener_errors_total++;
    }
  }

  private dropSessionForFullSync(): void {
    this.storedSession = null;
    this.lastSeq = 0;
  }
}
