/**
 * @cytale/api-client — the shared client-error reporting seam (#88).
 *
 * A user hitting a JavaScript exception, a failed API call or a dead socket
 * had no path to the maintainer, and the maintainer had no path to the error:
 * the only way a client-side bug was discovered was that a human mentioned it
 * (which is why the compat bugs #69–#77 were all found by an external client
 * operator). This module is the client half of the fix.
 *
 * It lives in `@cytale/api-client` because that is the package all three
 * clients already depend on — web, the desktop shell (same SPA) and mobile —
 * so one reporter, one redaction rule and one rate discipline cover all of
 * them. The platform-specific capture points (`window.onerror`,
 * `ErrorUtils.setGlobalHandler`, React error boundary, gateway telemetry)
 * live in the apps; the POLICY lives here, where it can be tested once.
 *
 * ## The privacy guarantees, as code
 *
 *   * **No message content, ever.** `ClientErrorPayload` has fields for a
 *     stack, a message, a redacted route, a status and a request id — and NO
 *     field for a request body, response body, headers, cookies or a token.
 *     A failed POST's body is the tempting thing to attach and the one thing
 *     that would turn an error log into a content store, so there is nowhere
 *     to put it. `assertNoForbiddenFields` pins that at runtime, and the
 *     suite asserts the payload's key set exactly.
 *   * **Ids are redacted out of every captured string** (route, message,
 *     stack): snowflakes, UUIDs, emails and query-string values are replaced
 *     before the payload leaves the process, so an error row cannot be used
 *     as a map of a private workspace.
 *   * **Stacks and messages are truncated** (`MAX_MESSAGE_CHARS`,
 *     `MAX_STACK_CHARS`) — a captured report is bounded by construction.
 *   * **Retention**: 30 days, enforced server-side by the ScyllaDB table's
 *     TTL and restated in `docs/protocol/rest.md` where an operator reads it.
 *
 * ## The client discipline (part of the deliverable, not polish)
 *
 *   * **Dedupe by fingerprint per session**: a crash loop reports its first
 *     occurrence and nothing more, so a wedged client cannot hose the
 *     endpoint.
 *   * **Rate caps**: a per-session ceiling on total reports and a per-window
 *     ceiling on distinct new fingerprints.
 *   * **Never throw**: `report()` cannot throw, and a rejected `send` is
 *     swallowed. Error reporting must not be able to break the app it is
 *     reporting about, or the report becomes the incident.
 *   * **At most one send attempt per event**: a report that fails to send is
 *     DROPPED, never retried — retrying is how an offline client turns one
 *     crash into a duplicate on every reconnect. The one exception is a
 *     `isOffline()` probe that says so: those events queue (bounded) and go
 *     out on the platform's `flush()` at reconnect, still exactly once each.
 */

import type { RequestFailure } from './http.js';
import { REQUEST_ID_HEADER } from './http.js';

export { REQUEST_ID_HEADER };

/** Which client produced the report. Desktop shares the web SPA's hooks. */
export type ClientKind = 'web' | 'desktop' | 'mobile';

/** The capture point. One value per hook, so a report says how it was found. */
export type ClientErrorSource =
  | 'window.onerror'
  | 'unhandledrejection'
  | 'error-boundary'
  | 'api.request'
  | 'gateway.telemetry';

/**
 * The wire shape of one report — this is exactly what is POSTed to
 * `/api/v1/client-errors`. Every optional field is omitted (not null) when
 * unknown, so the payload carries no empty scaffolding.
 *
 * There is deliberately no `body`, `headers`, `cookies`, `token` or `content`
 * field. That absence IS the guarantee: see the moduledoc.
 */
export interface ClientErrorPayload {
  client: ClientKind;
  source: ClientErrorSource;
  /** Stable de-duplication key (see `fingerprintOf`). */
  fingerprint: string;
  /** Redacted, truncated human-readable failure message. */
  message: string;
  stack?: string;
  /** Redacted route (hash route, or the failed call's path). */
  route?: string;
  /** Build identity — the short commit hash the client renders. */
  version?: string;
  /** HTTP status for `api.request` reports; absent otherwise. */
  status?: number;
  /** The server's request id for `api.request` reports — the trace handle. */
  request_id?: string;
  /** Extra context that is not free text (e.g. `malformed_frames_total=+2`). */
  detail?: string;
}

/** Bounds. A captured report is truncated, never unbounded. */
export const MAX_MESSAGE_CHARS = 500;
export const MAX_STACK_CHARS = 4_000;
export const MAX_ROUTE_CHARS = 300;
export const MAX_DETAIL_CHARS = 200;

/** The reporter's two ceilings (see the moduledoc). */
export const DEFAULT_MAX_PER_SESSION = 20;
export const DEFAULT_MAX_PER_WINDOW = 8;
export const DEFAULT_WINDOW_MS = 60_000;
export const DEFAULT_MAX_QUEUED = 20;

/**
 * Field names that must never appear on an outbound payload. A report that
 * carries any of these is dropped rather than sent (and the drop is counted
 * as `forbidden`), which is the belt to the type system's braces.
 */
const FORBIDDEN_FIELDS = [
  'body',
  'request_body',
  'response_body',
  'headers',
  'cookies',
  'token',
  'access_token',
  'refresh_token',
  'authorization',
  'content',
  'message_content',
  'email',
  'password',
] as const;

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/** A snowflake is a 15–20 digit decimal id; nothing else in our URLs is. */
const SNOWFLAKE_RE = /(?<!\d)\d{15,20}(?!\d)/g;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const EMAIL_RE = /[\w.+%-]+@[\w-]+\.[\w.-]+/g;
/** `?token=…`, `&code=…` — values, never keys (keys carry the diagnosis). */
const QUERY_VALUE_RE = /([?&][^=&\s#]+=)[^&#\s]*/g;
/** A bearer/basic credential that leaked into a message or stack. */
const CREDENTIAL_RE = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi;

/**
 * Redact identifiers out of one captured string.
 *
 * Order matters: query values first (they can contain anything, including an
 * id that would otherwise survive as `:id`), then credentials, then the
 * id/email shapes. Ids become `:id`, emails `:email`, credentials
 * `Bearer [redacted]`.
 */
export function redact(value: string): string {
  return value
    .replace(QUERY_VALUE_RE, '$1[redacted]')
    .replace(CREDENTIAL_RE, (_m, scheme: string) => `${scheme} [redacted]`)
    .replace(UUID_RE, ':id')
    .replace(SNOWFLAKE_RE, ':id')
    .replace(EMAIL_RE, ':email');
}

/**
 * Redact a route or path. Same rules as `redact`, plus the strip of anything
 * that is not the path itself — a path is the thing most likely to carry a
 * workspace id, so it gets the strictest treatment.
 *
 * `?` always ends a path. `#` ends one too — EXCEPT on web, where the app's
 * own hash route (`#/workspaces/123/channels/456`) IS the path and stripping
 * it would throw away the whole diagnosis.
 */
export function redactPath(value: string): string {
  const withoutQuery = value.split('?')[0] ?? '';
  const path = withoutQuery.startsWith('#') ? withoutQuery : (withoutQuery.split('#')[0] ?? '');
  return truncate(redact(path), MAX_ROUTE_CHARS);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  // The marker is explicit so a reader can tell truncation from a short value.
  return `${value.slice(0, max)}…[truncated]`;
}

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Digits collapse in the frame key so a rebuild does not fork the bug. */
function frameKey(stack: string | undefined): string {
  if (!stack) return '';
  const frame = stack.split('\n').find(line => /\bat\b/.test(line)) ?? '';
  return frame.replace(/\d+/g, '#').trim().slice(0, 160);
}

/**
 * The de-duplication key: source + message + the first stack frame (digits
 * collapsed) + an optional discriminator.
 *
 * Digits collapse in the FRAME only, because line/column numbers move on every
 * rebuild while the bug does not. The message keeps its digits: "Request failed
 * with status 500" and "... 404" are different failures, and an error message
 * is the primary signal a maintainer reads.
 *
 * Route is deliberately EXCLUDED for exceptions — a crash on channel A and the
 * same crash on channel B are one bug, and including the route would both
 * defeat the dedupe and make the fingerprint a private-workspace map. A failed
 * API call passes a discriminator instead (status + redacted path + machine
 * key), because two 500s on different routes are two different failures whose
 * messages read identically.
 */
export function fingerprintOf(
  source: ClientErrorSource,
  message: string,
  stack?: string,
  discriminator?: string
): string {
  const normalizedMessage = message.trim().slice(0, 200);
  return fnv1a(
    [source, normalizedMessage, frameKey(stack), discriminator ?? ''].join('\u0000')
  );
}

// ---------------------------------------------------------------------------
// Error description
// ---------------------------------------------------------------------------

/** Best-effort message/stack from anything a runtime can throw at us. */
export function describeThrown(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return { message: redact(error.message || error.name), stack: error.stack ? redact(error.stack) : undefined };
  }
  if (typeof error === 'string') return { message: redact(error) };
  if (error && typeof error === 'object') {
    const candidate = error as { message?: unknown; reason?: unknown; stack?: unknown };
    const raw =
      typeof candidate.message === 'string'
        ? candidate.message
        : typeof candidate.reason === 'string'
          ? candidate.reason
          : safeStringify(error);
    return {
      message: redact(raw),
      stack: typeof candidate.stack === 'string' ? redact(candidate.stack) : undefined,
    };
  }
  return { message: `Unhandled non-error value: ${typeof error}` };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '[unserializable]';
  }
}

/** A resolver that throws yields `undefined` — never the whole report. */
function safeResolve(resolve?: () => string | undefined): string | undefined {
  if (!resolve) return undefined;
  try {
    return resolve() || undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Gateway telemetry → events (the socket story, reported not re-instrumented)
// ---------------------------------------------------------------------------

/**
 * The gateway client's own counters that mean "something went wrong on the
 * wire". `reconnects_total` is included but kept LAST and labelled, because a
 * reconnect is also what a legitimate network blip looks like — the ticket's
 * socket failures (connect refused, abnormal close codes, resume failures) are
 * the malformed/gap/invalid/heartbeat counters alongside it.
 * `dispatch_errors_total` (hardening 6.2) counts dispatches whose payload
 * failed a per-event guard or whose handler threw: the inbound stream is
 * suspect, so it belongs here with malformed frames.
 *
 * Nothing here adds instrumentation: these are the counters
 * `GatewayClient.getTelemetry()` already maintains (#67/#80).
 */
export const GATEWAY_FAILURE_COUNTERS = [
  'malformed_frames_total',
  'dispatch_errors_total',
  'resume_gap_total',
  'invalid_sessions_total',
  'heartbeats_missed_total',
  'listener_errors_total',
  'reconnects_total',
] as const;

export type GatewayFailureCounter = (typeof GATEWAY_FAILURE_COUNTERS)[number];

export interface GatewayTelemetryDelta {
  counter: GatewayFailureCounter;
  delta: number;
  total: number;
}

/**
 * One tick of the socket story: the failure counters that INCREASED since the
 * previous snapshot. A delta of zero is silence, not a report — this is why
 * polling the snapshot is enough and no new socket interception is needed.
 */
export function gatewayTelemetryDeltas(
  previous: Record<string, number> | null,
  current: Record<string, number> | null
): GatewayTelemetryDelta[] {
  if (!current) return [];
  const deltas: GatewayTelemetryDelta[] = [];
  for (const counter of GATEWAY_FAILURE_COUNTERS) {
    const total = current[counter] ?? 0;
    const before = previous?.[counter] ?? 0;
    const delta = total - before;
    if (delta > 0) deltas.push({ counter, delta, total });
  }
  return deltas;
}

/**
 * Anything carrying the gateway client's telemetry shape. Typed structurally
 * on purpose: this package must not depend on `@cytale/gateway-client` (which
 * depends on the protocol, not on transport), and the only thing the poller
 * needs is the counter snapshot.
 *
 * `object` rather than `Record<string, number>` because `TelemetrySnapshot` is
 * a fixed-key interface, which TypeScript will not assign to an index
 * signature; `countersOf` below narrows it, and `GATEWAY_FAILURE_COUNTERS` is
 * the contract that the counters it names are numeric.
 */
export interface TelemetrySource {
  getTelemetry(): object;
}

function countersOf(snapshot: object): Record<string, number> {
  return snapshot as Record<string, number>;
}

export interface GatewayTelemetryPoller {
  /** One tick: report what moved since the previous snapshot. */
  poll(): void;
  start(): void;
  stop(): void;
}

/**
 * The socket-level capture point, shared by web/desktop and mobile. The
 * gateway client already maintains the socket story as counters, so this reads
 * them and reports the DELTAS — no new instrumentation, and a counter that
 * does not move produces no report.
 *
 * The first tick establishes the BASELINE and reports nothing: a snapshot
 * taken after connect is the state of the world, not an incident. Failures
 * from then on are reported once each (the reporter's fingerprint dedupe means
 * a counter that keeps climbing still yields one report per counter).
 */
export function createGatewayTelemetryPoller<T extends TelemetrySource>(
  getClient: () => T | null,
  reporter: ClientErrorReporter,
  options: { intervalMs?: number } = {}
): GatewayTelemetryPoller {
  let previous: Record<string, number> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const poll = (): void => {
    try {
      const client = getClient();
      if (!client) return;

      const snapshot = countersOf(client.getTelemetry());
      if (previous === null) {
        previous = snapshot;
        return;
      }

      const deltas = gatewayTelemetryDeltas(previous, snapshot);
      previous = snapshot;
      if (deltas.length > 0) reporter.observeGatewayDeltas(deltas);
    } catch {
      // A poll of a teardown-in-progress client must not throw into a timer.
    }
  };

  return {
    poll,
    start() {
      poll();
      timer ??= setInterval(poll, options.intervalMs ?? DEFAULT_GATEWAY_POLL_INTERVAL_MS);
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}

/** Default poll cadence for the gateway telemetry (a socket story is not urgent). */
export const DEFAULT_GATEWAY_POLL_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// The reporter
// ---------------------------------------------------------------------------

/** What a capture point hands in; the reporter builds the wire payload. */
export interface ClientErrorEventInput {
  source: ClientErrorSource;
  message: string;
  stack?: string | undefined;
  /** Overrides the reporter's route resolver (the failed call's path). */
  route?: string | undefined;
  status?: number | undefined;
  requestId?: string | null | undefined;
  detail?: string | undefined;
  /**
   * Extra fingerprint input for capture points whose messages read alike
   * (`api.request` passes status + redacted path + machine key). Never sent.
   */
  discriminator?: string | undefined;
}

export interface ClientErrorReporterOptions {
  /** Which client this reporter is installed in. */
  client: ClientKind;
  /**
   * Transport. Rejections are swallowed and the event dropped — see the
   * moduledoc's "at most one send attempt". `send` is never awaited by
   * `report()`.
   */
  send: (payload: ClientErrorPayload) => Promise<unknown>;
  /** Build identity, resolved per report (a lazy page may load later). */
  version?: string | (() => string | undefined);
  /** Current route, resolved per report. */
  route?: () => string | undefined;
  /** Per-session ceiling on total reports. */
  maxPerSession?: number;
  /** Per-window ceiling on distinct NEW fingerprints. */
  maxPerWindow?: number;
  windowMs?: number;
  /** Queue bound while `isOffline()` is true. */
  maxQueued?: number;
  now?: () => number;
  /** When true, events queue instead of sending (flushed on `flush()`). */
  isOffline?: () => boolean;
  /** Called after every accepted event with its payload (tests, debug logs). */
  onReport?: (payload: ClientErrorPayload) => void;
}

/** Counters the suite and an operator both want to see. */
export interface ClientErrorReporterState {
  /** Events accepted and handed to `send`. */
  sent: number;
  /** Events rejected because their fingerprint was already seen. */
  deduped: number;
  /** Events rejected by the per-session or per-window cap. */
  throttled: number;
  /** Events held because the client reported itself offline. */
  queued: number;
  /** Events a capture point produced that carried a forbidden field. */
  forbidden: number;
  /** Distinct fingerprints accepted this session. */
  fingerprints: number;
}

export class ClientErrorReporter {
  readonly #options: Required<
    Pick<ClientErrorReporterOptions, 'client' | 'send' | 'maxPerSession' | 'maxPerWindow'>
  > & {
    version?: () => string | undefined;
    route?: () => string | undefined;
    maxQueued: number;
    windowMs: number;
    now: () => number;
    isOffline?: () => boolean;
    onReport?: (payload: ClientErrorPayload) => void;
  };

  /** Fingerprints already reported this session (the crash-loop gate). */
  readonly #seen = new Set<string>();
  /** Events held while offline. Sent at most once each, in order. */
  readonly #queue: ClientErrorPayload[] = [];

  #sent = 0;
  #deduped = 0;
  #throttled = 0;
  #forbidden = 0;
  #windowStartedAt: number;
  #newInWindow = 0;

  constructor(options: ClientErrorReporterOptions) {
    if (!options?.send) throw new TypeError('ClientErrorReporter requires options.send');

    const now = options.now ?? Date.now;

    this.#options = {
      client: options.client,
      send: options.send,
      maxPerSession: options.maxPerSession ?? DEFAULT_MAX_PER_SESSION,
      maxPerWindow: options.maxPerWindow ?? DEFAULT_MAX_PER_WINDOW,
      maxQueued: options.maxQueued ?? DEFAULT_MAX_QUEUED,
      windowMs: options.windowMs ?? DEFAULT_WINDOW_MS,
      now,
      version: typeof options.version === 'function' ? options.version : () => options.version as string | undefined,
      route: options.route,
      isOffline: options.isOffline,
      onReport: options.onReport,
    };

    this.#windowStartedAt = now();
  }

  /**
   * Report one event. NEVER throws — every rejection path is a counted drop,
   * and the caller (an `onerror` handler, a React lifecycle, a polling timer)
   * is never implicated in a reporting failure.
   */
  report(input: ClientErrorEventInput): void {
    try {
      const payload = this.#payload(input);
      if (!payload) return;
      if (!this.#admit(payload)) return;

      this.#options.onReport?.(payload);

      if (this.#options.isOffline?.()) {
        this.#enqueue(payload);
        return;
      }

      this.#dispatch(payload);
    } catch {
      // A reporting bug must never become a second incident. Swallowed on
      // purpose; the counters below still tell the story in a debug console.
    }
  }

  /**
   * Report a thrown value (an exception, a rejection reason). The stack is
   * taken from the throw when it has one.
   */
  captureThrown(error: unknown, input: Omit<ClientErrorEventInput, 'message'> & { message?: string }): void {
    const described = describeThrown(error);
    this.report({
      ...input,
      message: input.message ?? described.message,
      stack: input.stack ?? described.stack,
    });
  }

  /**
   * The `api.request` capture point: every failed call the shared HTTP layer
   * observes, carrying its status and — the point of #88 — the server's
   * request id, so the report greps straight into the server logs.
   */
  observeApiFailure(failure: RequestFailure): void {
    const redactedRoute = redactPath(failure.path);
    this.report({
      source: 'api.request',
      message: failure.error.message,
      route: failure.path,
      status: failure.status,
      requestId: failure.requestId,
      detail: `${failure.method} ${failure.key}`,
      discriminator: `${failure.status} ${redactedRoute} ${failure.key}`,
    });
  }

  /**
   * The `gateway.telemetry` capture point. One report per counter that moved,
   * because each counter is a distinct failure mode with its own fingerprint.
   */
  observeGatewayDeltas(deltas: readonly GatewayTelemetryDelta[]): void {
    for (const delta of deltas) {
      this.report({
        source: 'gateway.telemetry',
        message: `gateway ${delta.counter} increased`,
        detail: `${delta.counter}=+${delta.delta} (total ${delta.total})`,
      });
    }
  }

  /** Send everything held while offline. Safe to call repeatedly. */
  flush(): void {
    try {
      const pending = this.#queue.splice(0, this.#queue.length);
      for (const payload of pending) {
        // Already admitted (fingerprinted, capped) when it was queued.
        this.#dispatch(payload);
      }
    } catch {
      // See report().
    }
  }

  /** A snapshot of what happened, for tests and a debug console. */
  getState(): ClientErrorReporterState {
    return {
      sent: this.#sent,
      deduped: this.#deduped,
      throttled: this.#throttled,
      queued: this.#queue.length,
      forbidden: this.#forbidden,
      fingerprints: this.#seen.size,
    };
  }

  // -- internals ------------------------------------------------------------

  #payload(input: ClientErrorEventInput): ClientErrorPayload | null {
    const message = truncate(redact(String(input.message ?? '')), MAX_MESSAGE_CHARS);
    if (!message) return null;

    const payload: ClientErrorPayload = {
      client: this.#options.client,
      source: input.source,
      fingerprint: fingerprintOf(input.source, message, input.stack, input.discriminator),
      message,
    };

    if (input.stack) payload.stack = truncate(redact(input.stack), MAX_STACK_CHARS);

    // Route/version resolution is DEFENSIVE: a resolver that throws must cost
    // the report a field, never the report itself. (A crash reporter that goes
    // silent because the router broke is worse than useless.)
    const route = input.route ?? safeResolve(this.#options.route);
    if (route) {
      const redactedRoute = redactPath(route);
      if (redactedRoute) payload.route = redactedRoute;
    }

    const version = safeResolve(this.#options.version);
    if (version) payload.version = version;

    if (typeof input.status === 'number' && input.status > 0) payload.status = input.status;
    // The request id is opaque transport metadata, not a workspace id: it is
    // carried verbatim (it is the trace handle) and never invented.
    if (input.requestId) payload.request_id = input.requestId;
    if (input.detail) payload.detail = truncate(redact(input.detail), MAX_DETAIL_CHARS);

    if (hasForbiddenField(payload)) {
      this.#forbidden += 1;
      return null;
    }

    return payload;
  }

  #admit(payload: ClientErrorPayload): boolean {
    if (this.#seen.has(payload.fingerprint)) {
      this.#deduped += 1;
      return false;
    }
    if (this.#sent + this.#queue.length >= this.#options.maxPerSession) {
      this.#throttled += 1;
      return false;
    }

    const now = this.#options.now();
    if (now - this.#windowStartedAt >= this.#options.windowMs) {
      this.#windowStartedAt = now;
      this.#newInWindow = 0;
    }
    if (this.#newInWindow >= this.#options.maxPerWindow) {
      this.#throttled += 1;
      return false;
    }

    this.#newInWindow += 1;
    this.#seen.add(payload.fingerprint);
    return true;
  }

  #enqueue(payload: ClientErrorPayload): void {
    if (this.#queue.length >= this.#options.maxQueued) {
      // Oldest first: the newest event is the one closest to a diagnosis.
      this.#queue.shift();
    }
    this.#queue.push(payload);
  }

  #dispatch(payload: ClientErrorPayload): void {
    this.#sent += 1;
    // Fire and forget. A rejection is a DROP, never a retry — see the
    // moduledoc's "at most one send attempt per event".
    void Promise.resolve()
      .then(() => this.#options.send(payload))
      .catch(() => undefined);
  }
}

/** True when a payload carries a field it must never carry. */
export function hasForbiddenField(payload: object): boolean {
  const keys = Object.keys(payload).map(key => key.toLowerCase());
  return FORBIDDEN_FIELDS.some(field => keys.includes(field));
}
