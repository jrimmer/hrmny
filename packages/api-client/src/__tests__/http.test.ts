/**
 * @cytale/api-client — HTTP layer: 401 → refresh rotation → retry,
 * single-flight refresh collapsing, logout callback on refresh failure.
 *
 * Spec error path: "401 → automatic refresh token rotation → retry succeeds;
 * refresh fails → logout callback fired."
 */
import { describe, expect, it, vi } from 'vitest';
import { CytaleApiClient } from '../api-client.js';
import { REQUEST_ID_HEADER, retryAfterMsFrom, type RequestFailure } from '../http.js';
import { createInMemoryTokenProvider, ApiError, type StoredTokens } from '../types.js';

type Handler = (request: Request) => Response | Promise<Response>;

function createFetchMock() {
  const calls: Request[] = [];
  const routes = new Map<string, Handler>();
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    calls.push(request);
    const handler = routes.get(`${request.method} ${new URL(request.url).pathname}`);
    if (!handler) {
      return Response.json(
        { error: { key: 'no_route', code: 40404, message: 'unrouted' } },
        { status: 404 }
      );
    }
    return await handler(request);
  });
  return {
    fetchMock,
    calls,
    on(method: string, path: string, handler: Handler) {
      routes.set(`${method} ${path}`, handler);
    },
  };
}

const TOKENS: StoredTokens = { access_token: 'at-v1', refresh_token: 'rt-v1', expires_in: 900 };

function makeClient(
  io: ReturnType<typeof createFetchMock>,
  tokens = createInMemoryTokenProvider({ ...TOKENS }),
  onLogout?: () => void
): CytaleApiClient {
  return new CytaleApiClient({
    baseUrl: 'https://api.test',
    tokens,
    fetchImpl: io.fetchMock as unknown as typeof fetch,
    onLogout,
  });
}

/** A real Phoenix request id (`Plug.RequestId` generates Base64url, 20 chars). */
const SERVER_REQUEST_ID = 'GEBMr97eLMHtGWsAAAVj';

describe('request-id capture on failed calls (#88)', () => {
  it("records the server's x-request-id on the thrown ApiError", async () => {
    const io = createFetchMock();
    io.on('GET', '/api/v1/workspaces/400', () =>
      Response.json(
        { error: { key: 'internal_error', code: 50001, message: 'boom' } },
        { status: 500, headers: { [REQUEST_ID_HEADER]: SERVER_REQUEST_ID } }
      )
    );

    const err = await makeClient(io).getWorkspace('400').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    // The traceability claim: the client report carries the id that greps
    // straight into the server logs.
    expect((err as ApiError).requestId).toBe(SERVER_REQUEST_ID);
  });

  it('offers every failed call to onRequestFailure — method, path, status, id', async () => {
    const io = createFetchMock();
    io.on('POST', '/api/v1/workspaces', () =>
      Response.json(
        { error: { key: 'validation_failed', code: 40001, message: 'nope' } },
        { status: 400, headers: { [REQUEST_ID_HEADER]: SERVER_REQUEST_ID } }
      )
    );

    const failures: RequestFailure[] = [];
    const client = new CytaleApiClient({
      baseUrl: 'https://api.test',
      tokens: createInMemoryTokenProvider({ ...TOKENS }),
      fetchImpl: io.fetchMock as unknown as typeof fetch,
      onRequestFailure: failure => failures.push(failure),
    });

    await client.createWorkspace({ name: 'x' }).catch(() => undefined);

    expect(failures).toHaveLength(1);
    const failure = failures[0]!;
    expect(failure.method).toBe('POST');
    expect(failure.path).toBe('/workspaces');
    expect(failure.status).toBe(400);
    expect(failure.key).toBe('validation_failed');
    expect(failure.requestId).toBe(SERVER_REQUEST_ID);
    expect(failure.error).toBeInstanceOf(ApiError);
    // The privacy shape, asserted rather than promised: the failure record has
    // no slot for the request body that produced it.
    expect(Object.keys(failure).sort()).toEqual(
      ['error', 'key', 'method', 'path', 'requestId', 'status'].sort()
    );
  });

  it('records null when the response carried no request id (never fabricated)', async () => {
    const io = createFetchMock();
    io.on('GET', '/api/v1/workspaces/400', () =>
      Response.json({ error: { key: 'not_found', code: 40401, message: 'gone' } }, { status: 404 })
    );

    const failures: RequestFailure[] = [];
    const client = new CytaleApiClient({
      baseUrl: 'https://api.test',
      tokens: createInMemoryTokenProvider({ ...TOKENS }),
      fetchImpl: io.fetchMock as unknown as typeof fetch,
      onRequestFailure: failure => failures.push(failure),
    });

    const err = await client.getWorkspace('400').catch((e: unknown) => e);

    expect((err as ApiError).requestId).toBeNull();
    expect(failures[0]!.requestId).toBeNull();
  });

  it('records a transport failure as status 0 with no request id', async () => {
    const failures: RequestFailure[] = [];
    const fetchImpl = (() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch;
    const client = new CytaleApiClient({
      baseUrl: 'https://api.test',
      tokens: createInMemoryTokenProvider({ ...TOKENS }),
      fetchImpl,
      onRequestFailure: failure => failures.push(failure),
    });

    const err = await client.getCurrentUser().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).key).toBe('network_error');
    expect((err as ApiError).status).toBe(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.status).toBe(0);
    expect(failures[0]!.requestId).toBeNull();
  });

  it('does NOT report a 401 the automatic refresh recovered from', async () => {
    const io = createFetchMock();
    io.on('GET', '/api/v1/users/@me', request =>
      request.headers.get('authorization') === 'Bearer at-v1'
        ? Response.json({ error: { key: 'token_expired', code: 40101, message: 'expired' } }, { status: 401 })
        : Response.json({ id: '2', username: 'jason', email: null, email_verified_at: null })
    );
    io.on('POST', '/api/v1/auth/refresh', () =>
      Response.json({ access_token: 'at-v2', refresh_token: 'rt-v2' })
    );

    const failures: RequestFailure[] = [];
    const client = new CytaleApiClient({
      baseUrl: 'https://api.test',
      tokens: createInMemoryTokenProvider({ ...TOKENS }),
      fetchImpl: io.fetchMock as unknown as typeof fetch,
      onRequestFailure: failure => failures.push(failure),
    });

    await client.getCurrentUser();

    // The recovered 401 is not a failure: only the FINAL outcome is observed.
    expect(failures).toHaveLength(0);
  });

  it('a throwing observer never breaks the request it observes', async () => {
    const io = createFetchMock();
    io.on('GET', '/api/v1/workspaces/400', () =>
      Response.json({ error: { key: 'not_found', code: 40401, message: 'gone' } }, { status: 404 })
    );

    const client = new CytaleApiClient({
      baseUrl: 'https://api.test',
      tokens: createInMemoryTokenProvider({ ...TOKENS }),
      fetchImpl: io.fetchMock as unknown as typeof fetch,
      onRequestFailure: () => {
        throw new Error('reporter exploded');
      },
    });

    const err = await client.getWorkspace('400').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).key).toBe('not_found');
  });
});

describe('automatic token refresh on 401 (spec error path)', () => {
  it('rotates the refresh token and retries the original request successfully', async () => {
    const io = createFetchMock();
    io.on('GET', '/api/v1/channels/300/messages', request => {
      if (request.headers.get('authorization') === 'Bearer at-v1') {
        return Response.json(
          { error: { key: 'token_expired', code: 40101, message: 'expired' } },
          { status: 401 }
        );
      }
      return Response.json({
        items: [{ id: '1323802875133952000', channel_id: '300', thread_id: null, author_id: '2', content: 'after refresh', created_at: '2025-01-01T00:00:00.500Z', edited_at: null }],
        cursor: { before: '1323802875133952000', after: '1323802875133952000', limit: 50 },
      });
    });
    io.on('POST', '/api/v1/auth/refresh', async request => {
      // The server identifies the refresh's owner from the Authorization
      // header (JWT sub, expiry IGNORED) and returns 401 without it — an
      // "unauthenticated refresh" is never accepted by this server.
      expect(request.headers.get('authorization')).toBe('Bearer at-v1');
      const body = (await request.json()) as { refresh_token?: string };
      expect(body.refresh_token).toBe('rt-v1');
      return Response.json({ access_token: 'at-v2', refresh_token: 'rt-v2' });
    });

    const provider = createInMemoryTokenProvider({ ...TOKENS });
    const messages = await makeClient(io, provider).getMessages('300');

    expect(messages[0]!.content).toBe('after refresh');
    const historyCalls = io.calls.filter(c => c.url.includes('/messages'));
    expect(historyCalls).toHaveLength(2); // original + exactly one retry
    expect(historyCalls[0]!.headers.get('authorization')).toBe('Bearer at-v1');
    expect(historyCalls[1]!.headers.get('authorization')).toBe('Bearer at-v2');
    // Rotation persisted via the TokenProvider seam.
    expect(provider.snapshot()?.access_token).toBe('at-v2');
    expect(provider.snapshot()?.refresh_token).toBe('rt-v2');
  });

  it('fires the logout callback and throws session_expired when refresh fails', async () => {
    const io = createFetchMock();
    io.on('GET', '/api/v1/channels/300/messages', () =>
      Response.json({ error: { key: 'token_expired', code: 40101, message: 'expired' } }, { status: 401 })
    );
    io.on('POST', '/api/v1/auth/refresh', () =>
      Response.json({ error: { key: 'invalid_grant', code: 40102, message: 'revoked' } }, { status: 401 })
    );

    const onLogout = vi.fn();
    const err = await makeClient(io, undefined, onLogout)
      .getMessages('300')
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).key).toBe('session_expired');
    expect(onLogout).toHaveBeenCalledTimes(1);
    // No retry after failed refresh.
    expect(io.calls.filter(c => c.url.includes('/messages'))).toHaveLength(1);
  });

  it('keeps other error statuses untouched (no refresh machinery on 403)', async () => {
    const io = createFetchMock();
    io.on('GET', '/api/v1/workspaces/400', () =>
      Response.json({ error: { key: 'missing_permissions', code: 40301, message: 'denied' } }, { status: 403 })
    );
    const err = await makeClient(io).getWorkspace('400').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
    // No refresh exchange attempted.
    expect(io.calls.filter(c => c.url.includes('/auth/refresh'))).toHaveLength(0);
  });

  it('sends the last-known access token on the refresh POST (server contract)', async () => {
    // The server's refresh handler derives the user from the Authorization
    // JWT sub with expiry ignored (`decode_any_expiry`); without the header it
    // answers 401 and the session is destroyed. The refresh POST started by a
    // 401 must therefore carry the very token that just expired.
    const io = createFetchMock();
    let refreshAuth: string | null = 'unset';
    io.on('GET', '/api/v1/users/@me', request => {
      if (request.headers.get('authorization') === 'Bearer at-v1') {
        return Response.json({ error: { key: 'token_expired', code: 40101, message: 'expired' } }, { status: 401 });
      }
      return Response.json({ id: '2', username: 'jason', email: null, email_verified_at: null });
    });
    io.on('POST', '/api/v1/auth/refresh', request => {
      refreshAuth = request.headers.get('authorization');
      return Response.json({ access_token: 'at-v2', refresh_token: 'rt-v2' });
    });

    const provider = createInMemoryTokenProvider({ ...TOKENS });
    const me = await makeClient(io, provider).getCurrentUser();

    expect(me.username).toBe('jason');
    expect(refreshAuth).toBe('Bearer at-v1');
    expect(provider.snapshot()?.access_token).toBe('at-v2');
  });

  it('single-flight: concurrent 401s collapse into ONE /auth/refresh call', async () => {
    const io = createFetchMock();
    let refreshCalls = 0;
    io.on('GET', '/api/v1/users/@me', request => {
      if (request.headers.get('authorization') === 'Bearer at-v1') {
        return Response.json({ error: { key: 'token_expired', code: 40101, message: 'expired' } }, { status: 401 });
      }
      return Response.json({ id: '2', username: 'jason', email: null, email_verified_at: null });
    });
    io.on('POST', '/api/v1/auth/refresh', async () => {
      refreshCalls += 1;
      await new Promise(resolve => setTimeout(resolve, 10)); // widen the race window
      return Response.json({ access_token: 'at-v2', refresh_token: 'rt-v2' });
    });

    const provider = createInMemoryTokenProvider({ ...TOKENS });
    const client = makeClient(io, provider);
    const [a, b] = await Promise.all([client.getCurrentUser(), client.getCurrentUser()]);
    expect(a.username).toBe('jason');
    expect(b.username).toBe('jason');
    expect(refreshCalls).toBe(1);
  });
});

describe('account deletion endpoint wiring', () => {
  it('DELETE /account returns void and no idempotency header needed', async () => {
    const io = createFetchMock();
    io.on('DELETE', '/api/v1/account', request => {
      expect(request.method).toBe('DELETE');
      expect(new URL(request.url).pathname).toBe('/api/v1/account');
      return new Response(null, { status: 204 });
    });
    await expect(makeClient(io).deleteAccount()).resolves.toBeUndefined();
  });
});

describe('the retry hint on a 429 (the send budget)', () => {
  it('carries Retry-After (seconds) on the thrown ApiError as retryAfterMs', async () => {
    const io = createFetchMock();
    io.on('POST', '/api/v1/channels/42/messages', () =>
      Response.json(
        {
          error: {
            key: 'rate_limited',
            code: 42901,
            message: 'Too many messages in this conversation — the send limit is 10 per 5s per sender in one channel or thread. Try again in 3s.',
          },
        },
        {
          status: 429,
          headers: {
            'retry-after': '3',
            'x-ratelimit-limit': '10',
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset-after': '2',
          },
        }
      )
    );

    const err = await makeClient(io)
      .sendMessage('42', { content: 'hi' }, 'nonce-1')
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(429);
    expect((err as ApiError).key).toBe('rate_limited');
    expect((err as ApiError).retryAfterMs).toBe(3000);
  });

  it('carries the tripped limit as rateLimitScope: the envelope field first, the header as fallback', async () => {
    const io = createFetchMock();
    const refusal = (scope: string | undefined, header: string | undefined) =>
      Response.json(
        {
          error: {
            key: 'rate_limited',
            code: 42901,
            message: 'Too many messages — try again in 2 seconds.',
            ...(scope !== undefined ? { scope, retry_after_ms: 1840 } : {}),
          },
        },
        { status: 429, headers: { 'retry-after': '2', ...(header !== undefined ? { 'x-ratelimit-scope': header } : {}) } }
      );
    const answers = [
      refusal('conversation', 'conversation'),
      refusal('sender', 'sender'),
      // The body wins over a disagreeing header.
      refusal('conversation', 'sender'),
      // No body field: the header names it.
      refusal(undefined, 'ip'),
      // An unknown value passes through untouched for the caller to judge.
      refusal('galaxy', undefined),
      // Neither: null.
      refusal(undefined, undefined),
    ];
    io.on('POST', '/api/v1/channels/42/messages', () => answers.shift()!);
    const client = makeClient(io);
    const scopes: Array<string | null> = [];
    for (let i = 0; i < 6; i += 1) {
      const err = await client.sendMessage('42', { content: 'hi' }, `nonce-${i}`).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      scopes.push((err as ApiError).rateLimitScope);
    }
    expect(scopes).toEqual(['conversation', 'sender', 'conversation', 'ip', 'galaxy', null]);
  });

  it('names no rate-limit scope on anything but a 429', async () => {
    const io = createFetchMock();
    io.on('GET', '/api/v1/workspaces/403', () =>
      Response.json(
        { error: { key: 'forbidden', code: 40301, message: 'no', scope: 'conversation' } },
        { status: 403, headers: { 'x-ratelimit-scope': 'account' } }
      )
    );
    const err = await makeClient(io).getWorkspace('403').catch((e: unknown) => e);
    expect((err as ApiError).rateLimitScope).toBeNull();
    expect(new ApiError({ key: 'x', code: 0, message: 'x' }).rateLimitScope).toBeNull();
  });

  it('is null when the response gave no hint', async () => {
    const io = createFetchMock();
    io.on('GET', '/api/v1/workspaces/400', () =>
      Response.json({ error: { key: 'internal_error', code: 50001, message: 'boom' } }, { status: 500 })
    );
    const err = await makeClient(io).getWorkspace('400').catch((e: unknown) => e);
    expect((err as ApiError).retryAfterMs).toBeNull();
  });

  it('reads Retry-After as seconds or an HTTP date, then falls back to the reset headers', () => {
    const now = Date.parse('2026-09-28T12:00:00Z');
    const h = (init: Record<string, string>) => new Headers(init);
    expect(retryAfterMsFrom(h({ 'retry-after': '5' }), now)).toBe(5000);
    expect(retryAfterMsFrom(h({ 'retry-after': '0.25' }), now)).toBe(250);
    expect(retryAfterMsFrom(h({ 'retry-after': 'Mon, 28 Sep 2026 12:00:04 GMT' }), now)).toBe(4000);
    // Retry-After wins over the bucket headers.
    expect(retryAfterMsFrom(h({ 'retry-after': '2', 'x-ratelimit-reset-after': '4' }), now)).toBe(2000);
    expect(retryAfterMsFrom(h({ 'x-ratelimit-reset-after': '1.5' }), now)).toBe(1500);
    // Discord's compat header: epoch seconds.
    expect(retryAfterMsFrom(h({ 'x-ratelimit-reset': String(now / 1000 + 3) }), now)).toBe(3000);
    expect(retryAfterMsFrom(h({}), now)).toBeNull();
    expect(retryAfterMsFrom(h({ 'retry-after': 'soon' }), now)).toBeNull();
  });
});
