/**
 * @cytale/session — the access-only token-source mode (tui plan U11, KTD5/KTD8,
 * R9/R14/R27).
 *
 * The terminal client's SSH mode has no refresh token and no credential to log
 * in with: the host mints access tokens and writes each one down an inherited
 * descriptor, which the client's reader publishes into the source below. These
 * scenarios are the ones the mode exists for — reached below the two shipping
 * paths rather than by forking them:
 *
 *   1. a source with no refresh token reaches `authenticated` and connects the
 *      gateway;
 *   2. a renewal from the source replaces the token, and the next request
 *      carries it (the live request path, not a storage round-trip);
 *   3. a 401 that races a renewal does NOT log the session out;
 *   4. the persisting storage write is never called (R27);
 *   5. the refresh-token timer is never armed (R9);
 *   6. an already-expired token surfaces the expired state, not a silent stall;
 *   7. a malformed token is rejected without tearing down a live session.
 *
 * The refresh-token path's own coverage (login, restore, F1/F3/F6, logout)
 * stays in session.test.ts and is unchanged by this mode — the web, desktop,
 * and mobile suites prove the same for their consumers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@cytale/api-client';

import { createSessionManager, type AccessStatus, type AccessTokenSource, type SessionManager } from '../session.js';
import type { TokenStorage } from '../tokenStorage.js';
import { fakeGatewayFactory, installFetch, USER, type CapturedGateway, type FetchHarness, type Route } from './testSupport.js';

/** A JWT-shaped access token: three base64url segments (HS256, as issued). */
const TOKEN_A = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlLWE';
const TOKEN_B = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlLWI';
const FIFTEEN_MIN_MS = 15 * 60 * 1000;

/** The descriptor reader's half: one in-memory value the source answers with. */
function fakeSource(token: string | null, expiresAt: number) {
  let current = token;
  let expiry = expiresAt;
  const source: AccessTokenSource = {
    getAccessToken: () => current,
    getAccessExpiresAt: () => expiry,
  };
  return {
    source,
    /** Publish a renewal the way the pipe reader does. */
    renew(next: string | null, nextExpiresAt: number): void {
      current = next;
      expiry = nextExpiresAt;
    },
  };
}

/** A storage whose write is asserted directly (R27) and which holds nothing. */
function spiedStorage(): TokenStorage & { writes: number } {
  const record = { writes: 0 };
  return {
    get writes() {
      return record.writes;
    },
    read: () => null,
    write: () => {
      record.writes += 1;
    },
    flush: async () => {},
  };
}

let gateways: CapturedGateway[];
let fetchHarness: FetchHarness;
let storage: ReturnType<typeof spiedStorage>;

/** The auth header of the Nth recorded call to /users/@me. */
function meAuth(harness: FetchHarness, index: number): string | undefined {
  const calls = harness.calls.filter((c) => c.url.endsWith('/users/@me'));
  return (calls[index]?.init.headers as Record<string, string> | undefined)?.Authorization;
}

/** `/users/@me` responses in order: `200, 401, 200, …` by call index. */
function meRoutes(...statuses: number[]): Route[] {
  let call = 0;
  return [
    {
      match: (url) => url.endsWith('/users/@me'),
      respond: () => {
        const status = statuses[Math.min(call, statuses.length - 1)] ?? 200;
        call += 1;
        return status === 200
          ? { status: 200, body: { user: USER } }
          : { status: 401, body: { error: { key: 'token_expired', code: 40101, message: 'expired' } } };
      },
    },
    { match: (url) => url.endsWith('/auth/refresh'), respond: () => ({ status: 401, body: { error: { key: 'unauthorized', code: 40101, message: 'no refresh' } } }) },
  ];
}

function makeSourceSession(source: AccessTokenSource, overrides: Partial<Parameters<typeof createSessionManager>[0]> = {}): SessionManager {
  return createSessionManager({
    storage,
    tokenSource: source,
    createGatewayClient: fakeGatewayFactory(gateways),
    resolveOrigin: () => 'http://127.0.0.1:4001',
    ...overrides,
  });
}

beforeEach(() => {
  gateways = [];
  storage = spiedStorage();
  fetchHarness = installFetch(meRoutes(200));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('establishing a session from the source alone', () => {
  it('reaches authenticated state and connects the gateway with no refresh token', async () => {
    const { source } = fakeSource(TOKEN_A, Date.now() + FIFTEEN_MIN_MS);
    const session = makeSourceSession(source);

    await session.authenticateFromTokenSource();

    expect(session.authStore.getState().status).toBe('authenticated');
    expect(session.authStore.getState().currentUser?.username).toBe(USER.username);
    expect(session.authStore.getState().getAccessToken()).toBe(TOKEN_A);
    // The store's refresh half is empty by construction (R9)…
    expect(session.authStore.getState().getRefreshToken()).toBeNull();
    // …and the session is still a real one: the gateway was built and connected.
    expect(gateways).toHaveLength(1);
    expect(gateways[0]?.connects).toBe(1);
    expect(session.accessStatus).toBe('authenticated');
  });

  it('reports the transition through onAccessStatusChange', async () => {
    const { source } = fakeSource(TOKEN_A, Date.now() + FIFTEEN_MIN_MS);
    const session = makeSourceSession(source);
    const seen: AccessStatus[] = [];
    session.onAccessStatusChange((status) => seen.push(status));

    await session.authenticateFromTokenSource();

    expect(seen).toEqual(['connecting', 'authenticated']);
  });

  it('a renewal from the source replaces the token and the next request carries it', async () => {
    const pipe = fakeSource(TOKEN_A, Date.now() + FIFTEEN_MIN_MS);
    const session = makeSourceSession(pipe.source);
    await session.authenticateFromTokenSource();
    expect(meAuth(fetchHarness, 0)).toBe(`Bearer ${TOKEN_A}`);

    // The host writes a fresh token; the descriptor reader publishes it.
    pipe.renew(TOKEN_B, Date.now() + FIFTEEN_MIN_MS);

    await session.api.getCurrentUser();

    expect(meAuth(fetchHarness, 1)).toBe(`Bearer ${TOKEN_B}`);
    // The auth store's mirror moved with it, so its own readers stay honest.
    expect(session.authStore.getState().getAccessToken()).toBe(TOKEN_B);
    expect(session.accessStatus).toBe('authenticated');
  });

  it('the gateway re-Identify takes the renewed token too', async () => {
    const pipe = fakeSource(TOKEN_A, Date.now() + FIFTEEN_MIN_MS);
    const session = makeSourceSession(pipe.source);
    await session.authenticateFromTokenSource();

    pipe.renew(TOKEN_B, Date.now() + FIFTEEN_MIN_MS);

    expect(await gateways[0]!.options.tokenProvider()).toBe(TOKEN_B);
  });
});

describe('renewal races and the inherited 401 policy', () => {
  it('a 401 during a renewal window does not log the session out', async () => {
    fetchHarness = installFetch(meRoutes(200, 401, 200));
    const pipe = fakeSource(TOKEN_A, Date.now() + FIFTEEN_MIN_MS);
    const session = makeSourceSession(pipe.source);
    await session.authenticateFromTokenSource();

    const err = await session.api.getCurrentUser().catch((e: unknown) => e);

    // A recoverable failure, not a sign-out: the Http layer could not refresh
    // (there is nothing to refresh with) and this mode declines to log out.
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).key).toBe('session_expired');
    expect(fetchHarness.count('/auth/refresh')).toBe(0); // no exchange was even attempted
    expect(session.authStore.getState().status).toBe('authenticated');
    expect(session.authStore.getState().getAccessToken()).toBe(TOKEN_A);
    expect(session.accessStatus).toBe('expired');
    expect(storage.writes).toBe(0);
    // Gateway intact — a renewal race is not a teardown.
    expect(gateways[0]?.disconnects).toBe(0);
    expect(gateways[0]?.destroys).toBe(0);
    expect(session.getGateway()).not.toBeNull();

    // …and the source's renewal wins: the retry carries it and the session is
    // established again without a restart.
    pipe.renew(TOKEN_B, Date.now() + FIFTEEN_MIN_MS);
    await session.api.getCurrentUser();

    expect(meAuth(fetchHarness, 2)).toBe(`Bearer ${TOKEN_B}`);
    expect(session.accessStatus).toBe('authenticated');
    expect(session.authStore.getState().status).toBe('authenticated');
    expect(storage.writes).toBe(0);
  });
});

describe('R27 — an access-only session writes nothing to storage', () => {
  it('never calls the persisting write, before or after a renewal', async () => {
    const pipe = fakeSource(TOKEN_A, Date.now() + FIFTEEN_MIN_MS);
    const session = makeSourceSession(pipe.source);

    await session.authenticateFromTokenSource();
    expect(storage.writes).toBe(0);

    pipe.renew(TOKEN_B, Date.now() + FIFTEEN_MIN_MS);
    await session.api.getCurrentUser();

    expect(storage.writes).toBe(0);
    expect(session.authStore.getState().getAccessToken()).toBe(TOKEN_B);
  });

  it('logout revokes nothing server-side (there is no refresh token) and ends the session locally', async () => {
    const { source } = fakeSource(TOKEN_A, Date.now() + FIFTEEN_MIN_MS);
    const session = makeSourceSession(source);
    await session.authenticateFromTokenSource();

    await session.logout();

    // No refresh token exists, so there is nothing to revoke server-side…
    expect(fetchHarness.count('/auth/logout')).toBe(0);
    // …and the session is gone locally.
    expect(session.authStore.getState().getAccessToken()).toBeNull();
    expect(session.accessStatus).toBe('idle');
  });
});

describe('R9 — no refresh-token timer is armed', () => {
  it('arms no timer at all, and time passing triggers no exchange', async () => {
    vi.useFakeTimers();
    const { source } = fakeSource(TOKEN_A, Date.now() + FIFTEEN_MIN_MS);
    const session = makeSourceSession(source);

    await session.authenticateFromTokenSource();
    expect(session.authStore.getState().status).toBe('authenticated');

    // Directly asserted: the login path arms one here (F6); this mode must not.
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(FIFTEEN_MIN_MS * 2);

    expect(fetchHarness.count('/auth/refresh')).toBe(0);
    expect(session.authStore.getState().status).toBe('authenticated');
    expect(session.accessStatus).toBe('authenticated');
    expect(session.shouldRefreshProactively()).toBe(false);
  });

  it('refreshTokens() refuses loudly instead of silently no-opping', async () => {
    const { source } = fakeSource(TOKEN_A, Date.now() + FIFTEEN_MIN_MS);
    const session = makeSourceSession(source);
    await session.authenticateFromTokenSource();

    await expect(session.refreshTokens()).rejects.toMatchObject({ key: 'no_refresh_token' });
    expect(fetchHarness.count('/auth/refresh')).toBe(0);
  });
});

describe('the source reports something unusable', () => {
  it('an already-expired token surfaces the expired state rather than a silent stall', async () => {
    const { source } = fakeSource(TOKEN_A, Date.now() - 1_000);
    const session = makeSourceSession(source);

    const err = await session.authenticateFromTokenSource().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).key).toBe('access_token_expired');
    expect(session.accessStatus).toBe('expired');
    // Never 'loading' forever, and never a half-built session.
    expect(session.authStore.getState().status).toBe('unauthenticated');
    expect(gateways).toHaveLength(0);
    expect(fetchHarness.count('/users/@me')).toBe(0);
    expect(storage.writes).toBe(0);
  });

  it('a token that is not a token is rejected at adoption', async () => {
    const { source } = fakeSource('not-a-token at all', Date.now() + FIFTEEN_MIN_MS);
    const session = makeSourceSession(source);

    const err = await session.authenticateFromTokenSource().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).key).toBe('access_token_malformed');
    expect(session.accessStatus).toBe('expired');
    expect(session.authStore.getState().status).toBe('unauthenticated');
    expect(gateways).toHaveLength(0);
    expect(storage.writes).toBe(0);
  });

  it('nothing on the pipe yet is reported as missing, not as a session', async () => {
    const { source } = fakeSource(null, 0);
    const session = makeSourceSession(source);

    const err = await session.authenticateFromTokenSource().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).key).toBe('access_token_missing');
    expect(session.accessStatus).toBe('expired');
    expect(gateways).toHaveLength(0);
  });

  it('a malformed renewal is rejected without tearing down the live session', async () => {
    const pipe = fakeSource(TOKEN_A, Date.now() + FIFTEEN_MIN_MS);
    const session = makeSourceSession(pipe.source);
    await session.authenticateFromTokenSource();

    // A garbled descriptor write: not a JWT, so it never becomes a credential.
    pipe.renew('\u0000\u0007 garbage', Date.now() + FIFTEEN_MIN_MS);

    await session.api.getCurrentUser();

    // The last good token stays live; the session is untouched.
    expect(meAuth(fetchHarness, 1)).toBe(`Bearer ${TOKEN_A}`);
    expect(session.authStore.getState().getAccessToken()).toBe(TOKEN_A);
    expect(session.authStore.getState().status).toBe('authenticated');
    expect(session.accessStatus).toBe('authenticated');
    expect(gateways[0]?.disconnects).toBe(0);
    expect(gateways[0]?.destroys).toBe(0);
    expect(storage.writes).toBe(0);
    // An empty value is refused the same way.
    pipe.renew('', Date.now() + FIFTEEN_MIN_MS);
    expect(await gateways[0]!.options.tokenProvider()).toBe(TOKEN_A);
    // …and the next usable value is adopted as normal.
    pipe.renew(TOKEN_B, Date.now() + FIFTEEN_MIN_MS);
    expect(await gateways[0]!.options.tokenProvider()).toBe(TOKEN_B);
  });

  it('a rejected token at adoption leaves an existing session alone', async () => {
    fetchHarness = installFetch(meRoutes(200, 401));
    const pipe = fakeSource(TOKEN_A, Date.now() + FIFTEEN_MIN_MS);
    const session = makeSourceSession(pipe.source);
    await session.authenticateFromTokenSource();
    expect(session.authStore.getState().status).toBe('authenticated');

    // A re-adoption whose read is refused must not sign the member out — the
    // session stays established (the server rejected the probe, so the status
    // says so, but nothing was torn down).
    const err = await session.authenticateFromTokenSource().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(session.accessStatus).toBe('expired');
    expect(session.authStore.getState().status).toBe('authenticated');
    expect(session.authStore.getState().getAccessToken()).toBe(TOKEN_A);
    expect(gateways[0]?.disconnects).toBe(0);
    expect(storage.writes).toBe(0);
  });
});

describe('the refresh-token path is untouched', () => {
  it('a session built without a tokenSource reports accessStatus idle and uses storage', async () => {
    fetchHarness = installFetch([
      { match: (url) => url.endsWith('/auth/login'), respond: () => ({ status: 200, body: { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 900 } }) },
      { match: (url) => url.endsWith('/users/@me'), respond: () => ({ status: 200, body: { user: USER } }) },
      { match: (url) => url.endsWith('/auth/refresh'), respond: () => ({ status: 200, body: { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 900 } }) },
    ]);
    const memory = {
      pair: null as null | { accessToken: string | null; refreshToken: string | null },
      read() {
        return this.pair;
      },
      write(next: null | { accessToken: string | null; refreshToken: string | null }) {
        this.pair = next;
      },
    };
    const session = createSessionManager({
      storage: memory,
      createGatewayClient: fakeGatewayFactory(gateways),
      resolveOrigin: () => 'http://127.0.0.1:4001',
    });

    await session.login('tester', 'password-123');

    expect(session.accessStatus).toBe('idle');
    // The pair is still persisted, exactly as before this unit.
    expect(memory.read()).toEqual({ accessToken: 'access-1', refreshToken: 'refresh-1' });
    expect(session.shouldRefreshProactively()).toBe(false);
    expect(await gateways[0]!.options.tokenProvider()).toBe('access-1');
  });
});
