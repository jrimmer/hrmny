/**
 * @cytale/api-client — fetch wrapper for the Cytale REST surface.
 *
 * Responsibilities:
 *  - Bearer auth header injection
 *  - Error envelope normalization: `{ error: { key, code, message } }` →
 *    typed `ApiError` (the plan's single-envelope convention)
 *  - Automatic single-flight token refresh on 401 with exactly one retry,
 *    plus a logout callback when refresh itself fails. The exchange is
 *    AUTHENTICATED (Bearer = last-known access token): the server reads the
 *    user from its JWT `sub` with expiry ignored, so a bare refresh POST is
 *    always rejected.
 *  - `Idempotency-Key` injection on POSTs (crypto.randomUUID)
 *  - Request-id capture (#88): every response's `x-request-id` (Phoenix's
 *    `Plug.RequestId`) is recorded onto the thrown `ApiError` and offered to
 *    an optional `onRequestFailure` seam — the ONE place a failed call is
 *    observed, so web, the desktop shell and mobile all get it for free.
 */

import {
  ApiError,
  type ApiErrorShape,
  type RequestOptions,
  type TokenProvider,
} from './types.js';

/** Idempotency-Key header name (mutating POSTs, per API Surface conventions). */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/**
 * The response header every Phoenix response carries (nested from
 * `Plug.RequestId` in the endpoint — `apps/server/lib/cytale_web/endpoint.ex`).
 * This constant is the client half of that contract.
 */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * One failed call, as observed by the HTTP layer. Deliberately narrow: method,
 * path, status, the server's request id and the machine key. There is NO field
 * for the request body, request headers or the response body — this type is
 * half of the "an error report can never become a content store" guarantee
 * (#88), the other half being the reporter's redaction.
 */
export interface RequestFailure {
  /** HTTP method of the failed call. */
  method: string;
  /** The path the caller passed (no query string — `Http` never sees one joined). */
  path: string;
  /** HTTP status; 0 when no response arrived (transport failure). */
  status: number;
  /** The server's request id, or null when the response carried none. */
  requestId: string | null;
  /** Machine error key ('network_error' for a transport failure). */
  key: string;
  /** The exact error that was (or is about to be) thrown. */
  error: ApiError;
}

function joinV1(baseUrl: string, path: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (/\/api\/v1$/.test(trimmed)) {
    return `${trimmed}${path.startsWith('/') ? path : `/${path}`}`;
  }
  return `${trimmed}/api/v1${path.startsWith('/') ? path : `/${path}`}`;
}

/** An abort signal that fires after `ms`, or undefined for no bound. */
function timeoutSignal(ms: number | undefined): AbortSignal | undefined {
  if (ms === undefined || !(ms > 0)) return undefined;
  const ctor = (globalThis as { AbortSignal?: { timeout?: (ms: number) => AbortSignal } }).AbortSignal;
  if (typeof ctor?.timeout === 'function') return ctor.timeout(ms);
  if (typeof AbortController === 'undefined') return undefined;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/**
 * The error shape for a fetch that rejected. A rejection caused by the
 * timeout signal is keyed `timeout` (lane D #22) — distinct from
 * `network_error` because for a WRITE it means "may have landed": the caller
 * must retry with the same Idempotency-Key, never treat it as not-sent.
 */
function transportFailure(cause: unknown, signal: AbortSignal | undefined): ApiErrorShape {
  if (signal?.aborted) {
    return {
      key: 'timeout',
      code: 0,
      message: 'The server did not answer in time.',
      status: 0,
      requestId: null,
      cause,
    };
  }
  return {
    key: 'network_error',
    code: 0,
    message: describeTransportError(cause),
    status: 0,
    requestId: null,
    cause,
  };
}

export interface HttpLayerOptions {
  /**
   * API origin; `/api/v1` is appended unless already present.
   *
   * A function form resolves PER REQUEST — the login-time server-selection
   * seam (mobile/desktop login forms let the user point the client at any
   * server before authenticating). The resolved value is trailing-slash
   * trimmed the same as a literal.
   */
  baseUrl: string | (() => string);
  /** Supplies the current access token and performs refresh storage updates. */
  tokens: TokenProvider;
  /**
   * Fired when a token refresh attempt fails (invalid/expired refresh token)
   * — the session is unrecoverable: callers should clear stored credentials
   * and route to login.
   */
  onLogout?: () => void;
  /**
   * Observation seam for FAILED calls only (non-2xx response, or a rejected
   * fetch). Called after the retry has been settled, so a 401 the refresh
   * machinery recovered from is NOT a failure — only the final outcome is.
   *
   * The listener must not throw; if it does, the throw is swallowed so a
   * reporting bug can never break the request it was observing. Reporting is
   * fire-and-forget from the HTTP layer's point of view.
   */
  onRequestFailure?: (failure: RequestFailure) => void;
  /** Escape hatch for tests and exotic runtimes; defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

interface RefreshSuccess {
  access_token: string;
  refresh_token: string;
  /**
   * The account, in the `@me` shape (lane D #4) — a server that sends it
   * lets a restoring client skip its `/users/@me` read. Absent on an older
   * server; the caller then reads `@me` as before.
   */
  user?: unknown;
}

/** What a refresh exchange hands back beyond the stored pair. */
export interface RefreshOutcome {
  /** The account the exchange returned, or undefined when it sent none. */
  user?: unknown;
}

export class Http {
  readonly #baseUrl: string | (() => string);
  readonly #tokens: TokenProvider;
  readonly #onLogout?: () => void;
  readonly #onRequestFailure?: (failure: RequestFailure) => void;
  readonly #fetchImpl: typeof fetch;

  /** Shared in-progress refresh promise — the single-flight gate. */
  #refreshInFlight: Promise<RefreshSuccess> | null = null;
  /** Generation counter guarding retries against stale-token loops. */
  #refreshGeneration = 0;

  constructor(options: HttpLayerOptions) {
    this.#baseUrl =
      typeof options.baseUrl === 'function' ? options.baseUrl : options.baseUrl.replace(/\/+$/, '');
    this.#tokens = options.tokens;
    this.#onLogout = options.onLogout;
    this.#onRequestFailure = options.onRequestFailure;
    this.#fetchImpl =
      options.fetchImpl ??
      ((...args) => {
        const f = (globalThis as { fetch?: typeof fetch }).fetch;
        if (!f) throw new Error('No fetch implementation available');
        return f(...args);
      });
  }

  buildUrl(path: string): string {
    const base = typeof this.#baseUrl === 'function' ? this.#baseUrl() : this.#baseUrl;
    return joinV1(base, path);
  }

  /** Low-level request entry. Callers build query strings into `path`. */
  async request<T>(
    method: string,
    path: string,
    options: RequestOptions & { body?: unknown } = {}
  ): Promise<T> {
    let headers: Record<string, string> = {
      ...((options.headers ?? {}) as Record<string, string>),
    };
    let body: BodyInit | undefined;

    if (options.body !== undefined) {
      if (typeof options.body === 'string' || options.body instanceof FormData) {
        body = options.body;
      } else {
        body = JSON.stringify(options.body);
      }
      // JSON bodies default the type. FormData (multipart upload) must set
      // its OWN Content-Type — the runtime fills in the boundary parameter,
      // and a forced type here would strip it.
      if (!(options.body instanceof FormData)) {
        headers['Content-Type'] ??= 'application/json';
      }
    }

    if (options.idempotencyKey) {
      headers[IDEMPOTENCY_KEY_HEADER] = options.idempotencyKey;
    }

    const useAuth = options.auth !== false;
    if (useAuth) {
      const accessToken = await this.#tokens.getAccessToken();
      if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    }

    return await this.#send(method, path, body, headers, useAuth, options.timeoutMs);
  }

  async #send<T>(
    method: string,
    path: string,
    body: BodyInit | undefined,
    headers: Record<string, string>,
    useAuth: boolean,
    timeoutMs?: number
  ): Promise<T> {
    const generationAtSend = this.#refreshGeneration;
    const url = this.buildUrl(path);
    let response: Response;

    // Lane D #22: a bounded wait. A hung request (a stalled proxy, a
    // half-open socket) otherwise holds its caller forever — the composer's
    // send gate stayed shut behind a POST that never answered.
    const signal = timeoutSignal(timeoutMs);

    try {
      response = await this.#fetchImpl(url, { method, headers, body, ...(signal ? { signal } : {}) });
    } catch (cause) {
      // A rejected fetch (offline, DNS, TLS, CORS, aborted) never reaches the
      // response path below, so the failure is observed here — as an ApiError
      // with status 0 and no request id, the same shape every catch site
      // already narrows on (`key === 'network_error'`, `status === 0`).
      throw this.#fail(method, path, transportFailure(cause, signal));
    }

    // Automatic refresh applies ONLY to authenticated requests failing auth;
    // every other status falls through to envelope parsing untouched.
    if (useAuth && response.status === 401) {
      await this.#ensureFreshSession(generationAtSend);
      const accessToken = await this.#tokens.getAccessToken();
      if (accessToken) {
        // Re-read the ROTATED token — never reuse the stale Authorization.
        headers.Authorization = `Bearer ${accessToken}`;
        const retrySignal = timeoutSignal(timeoutMs);
        try {
          response = await this.#fetchImpl(url, {
            method,
            headers,
            body,
            ...(retrySignal ? { signal: retrySignal } : {}),
          });
        } catch (cause) {
          throw this.#fail(method, path, transportFailure(cause, retrySignal));
        }
      }
    }

    return await this.#parse<T>(response, method, path);
  }

  /**
   * Guarantee a usable access token after a 401, with strict single-flight:
   * the first requester whose generation matches triggers (or joins) one
   * /auth/refresh exchange; later arrivals either join the in-flight
   * exchange or skip entirely because it already completed for them.
   */
  async #ensureFreshSession(generationAtRequest: number): Promise<void> {
    const fail = (): never => {
      this.#onLogout?.();
      throw new ApiError({
        key: 'session_expired',
        code: 40101,
        message: 'Session expired and token refresh failed',
        status: 401,
      });
    };
    try {
      if (generationAtRequest === this.#refreshGeneration) {
        await this.refreshTokens();
      } else if (this.#refreshInFlight) {
        // A sibling request's refresh is running — wait out its outcome.
        await this.#refreshInFlight;
      }
      // else: a completed refresh already covers this request; fall through.
    } catch (error) {
      if (error instanceof ApiError && error.key === 'session_expired') throw error;
      fail();
    }
  }

  /**
   * Single-flight refresh: concurrent callers join one network exchange.
   * Stores rotated tokens via the TokenProvider before returning.
   */
  async refreshTokens(): Promise<RefreshOutcome> {
    this.#refreshInFlight ??= this.#exchange();
    const exchanged = this.#refreshInFlight;
    try {
      const next = await exchanged;
      this.#refreshGeneration += 1;
      await this.#tokens.updateTokens(next.access_token, next.refresh_token);
      return { user: next.user };
    } finally {
      // Clear the gate only if nobody else swapped in a newer exchange.
      if (this.#refreshInFlight === exchanged) {
        this.#refreshInFlight = null;
      }
    }
  }

  async #exchange(): Promise<RefreshSuccess> {
    const refreshToken = await this.#tokens.getRefreshToken();
    if (!refreshToken) {
      throw new Error('no refresh token available');
    }
    // Auth header on the refresh POST is MANDATORY for this server: the
    // refresh token encodes no owner, so `AuthController.refresh` identifies
    // the user from the (expiry-ignored) access JWT's `sub` via
    // decode_any_expiry and answers 401 without it. An "unauthenticated
    // refresh" — the OAuth2 habit — can therefore never succeed here, and
    // every 401 would destroy a perfectly good session. Send the last-known
    // access token, expired or not (the same contract SessionManager uses).
    const accessToken = await this.#tokens.getAccessToken();
    const response = await this.#fetchImpl(this.buildUrl('/auth/refresh'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!response.ok) {
      throw new ApiError(await errorFrom(response));
    }
    const data = (await response.json()) as RefreshSuccess;
    if (!data?.access_token || !data?.refresh_token) {
      throw new Error('malformed refresh response');
    }
    return data;
  }

  async #parse<T>(response: Response, method: string, path: string): Promise<T> {
    if (!response.ok) {
      throw this.#fail(method, path, await errorFrom(response));
    }
    if (response.status === 204) {
      return undefined as T;
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      return (await response.text()) as unknown as T;
    }
    return (await response.json()) as T;
  }

  /**
   * The ONE place a failed call is turned into an error, recorded (request id
   * included) and offered to the observer. Every failure path funnels here so
   * the request id can never be captured on one route and dropped on another
   * (#88: "one place, all three clients get it").
   */
  #fail(method: string, path: string, shape: ApiErrorShape): ApiError {
    const error = new ApiError(shape);

    if (this.#onRequestFailure) {
      try {
        this.#onRequestFailure({
          method,
          path,
          status: error.status,
          requestId: error.requestId,
          key: error.key,
          error,
        });
      } catch {
        // A reporting seam must never break the request it observes: the
        // caller still gets its ApiError, which is the contract that matters.
      }
    }

    return error;
  }
}

/**
 * A rejected fetch carries a real reason (TypeError "Failed to fetch",
 * DOMException "AbortError", a Node ECONNREFUSED). Keep its message — it is
 * the diagnosis — and never invent a request id for a call that never
 * reached a server.
 */
function describeTransportError(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message;
  if (typeof cause === 'string' && cause) return cause;
  return 'Network request failed';
}

async function errorFrom(response: Response): Promise<ApiErrorShape> {
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // Non-JSON failure body (proxy HTML, empty 500, …).
  }
  const envelope =
    payload !== null &&
    typeof payload === 'object' &&
    'error' in (payload as Record<string, unknown>)
      ? ((payload as { error: Partial<ApiErrorShape> }).error ?? {})
      : {};
  return {
    key: typeof envelope.key === 'string' ? envelope.key : 'unknown_error',
    code: typeof envelope.code === 'number' ? envelope.code : response.status * 100,
    message:
      typeof envelope.message === 'string'
        ? envelope.message
        : `Request failed with status ${response.status}`,
    status: response.status,
    // The traceability handle (#88). Null when absent — never fabricated.
    requestId: response.headers.get(REQUEST_ID_HEADER),
    retryAfterMs: retryAfterMsFrom(response.headers),
    rateLimitScope:
      response.status === 429 ? rateLimitScopeFrom(envelope as Record<string, unknown>, response.headers) : null,
  };
}

/**
 * WHICH limit a 429 hit: the envelope's `scope`, else the
 * `X-RateLimit-Scope` header; null when neither names one (read on a 429
 * only — no other status names a rate limit).
 */
function rateLimitScopeFrom(envelope: Record<string, unknown>, headers: Headers): string | null {
  const scope = envelope['scope'];
  if (typeof scope === 'string' && scope !== '') return scope;
  const header = headers.get('x-ratelimit-scope')?.trim();
  return header ? header : null;
}

/**
 * The server's "try again in" hint, in ms, or null when it gave none.
 *
 * `Retry-After` wins (integer seconds on every Cytale 429/503, or an HTTP
 * date per RFC 9110); without it, the bucket's own reset headers:
 * `X-RateLimit-Reset-After` (seconds, the native surface) or Discord's
 * `X-RateLimit-Reset` (epoch seconds, the compat surface).
 */
export function retryAfterMsFrom(headers: Headers, now: number = Date.now()): number | null {
  const seconds = (value: string | null): number | null => {
    if (value === null || value.trim() === '') return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const retryAfter = headers.get('retry-after');
  const delta = seconds(retryAfter);
  if (delta !== null) return Math.round(delta * 1000);
  if (retryAfter) {
    const at = Date.parse(retryAfter);
    if (!Number.isNaN(at)) return Math.max(0, at - now);
  }
  const resetAfter = seconds(headers.get('x-ratelimit-reset-after'));
  if (resetAfter !== null) return Math.round(resetAfter * 1000);
  const reset = seconds(headers.get('x-ratelimit-reset'));
  if (reset !== null) return Math.max(0, Math.round(reset * 1000 - now));
  return null;
}
