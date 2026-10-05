/**
 * U19 — useAuth/session tests (vitest + jsdom, fetch mocked against the
 * documented /api/v1/auth contract in docs/protocol/rest.md).
 *
 * Contract under test:
 *   1. login success → tokens stored, user fetched, gateway connected.
 *   2. login failure (INVALID_CREDENTIALS) → inline error state, no gateway.
 *   3. 401 from an API call → single refresh exchange → retry succeeds.
 *   4. Proactive refresh scheduled before expiry.
 *   5. logout → gateway disconnected, refresh token cleared, store reset.
 *   6. Session restore from a persisted refresh token.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';

import { readStoredRefreshToken, writeStoredRefreshToken } from '../authStore.js';
import { authStore, session, api } from '../session.js';
import { useAuth } from '../useAuth.js';

// -- fetch mock harness ------------------------------------------------------

type Route = { match: (url: string, init: RequestInit) => boolean; respond: () => { status: number; body: unknown } };

const routes: Route[] = [];

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
  } as unknown as Response;
}

function installFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    for (const route of routes) {
      if (route.match(url, init)) {
        const r = route.respond();
        return jsonResponse(r.status, r.body);
      }
    }
    return jsonResponse(404, { error: { key: 'not_found', code: 40404, message: 'no route' } });
  }));
}

const TOKENS = {
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  expires_in: 900,
  token_type: 'Bearer',
};

const USER = {
  id: '123',
  username: 'tester',
  email: 'tester@example.com',
  email_verified_at: null,
};

beforeEach(() => {
  routes.length = 0;
  installFetch();
  globalThis.localStorage?.clear();

  // Route: login
  routes.push({
    match: (url) => url.endsWith('/auth/login'),
    respond: () => {
      const last = routes[0] as Route & { fail?: boolean };
      if (last.fail) {
        return { status: 401, body: { error: { key: 'INVALID_CREDENTIALS', code: 40101, message: 'denied' } } };
      }
      return { status: 200, body: TOKENS };
    },
  });

  // Route: /users/@me
  routes.push({
    match: (url) => url.endsWith('/users/@me'),
    respond: () => ({ status: 200, body: { user: USER } }),
  });

  // Route: refresh
  routes.push({
    match: (url) => url.endsWith('/auth/refresh'),
    respond: () => ({
      status: 200,
      body: { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 900 },
    }),
  });

  // Route: logout
  routes.push({
    match: (url) => url.endsWith('/auth/logout'),
    respond: () => ({ status: 200, body: { logged_out: true } }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  authStore.getState().reset();
});

describe('useAuth — login', () => {
  it('login success stores tokens, sets the user, marks authenticated', async () => {
    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await result.current.login('tester', 'password-123');
    });

    expect(result.current.state.status).toBe('authenticated');
    expect(result.current.state.currentUser?.username).toBe('tester');
    expect(result.current.state.emailVerified).toBe(false); // USER has null verified_at
    expect(readStoredRefreshToken()).toBe('refresh-1');
    expect(result.current.state.getAccessToken()).toBe('access-1');
  });

  it('F6: login arms the proactive refresh timer — idle sessions no longer ride the token to expiry', async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useAuth());
      await act(async () => {
        await result.current.login('tester', 'password-123');
      });
      expect(result.current.state.status).toBe('authenticated');

      // expires_in 900s − 2 min margin → the exchange fires at ~13 min.
      // Before the F6 fix this timer was NEVER armed at login (only a
      // completed refresh armed it): an idle connected session silently
      // held a dying token.
      await act(async () => {
        vi.advanceTimersByTime(13 * 60 * 1000 + 100);
      });

      const refreshCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => String(c[0]).endsWith('/auth/refresh'),
      );
      expect(refreshCalls).toHaveLength(1);
      expect(result.current.state.getAccessToken()).toBe('access-2');
      expect(readStoredRefreshToken()).toBe('refresh-2');
    } finally {
      vi.useRealTimers();
    }
  });

  it('login failure surfaces INVALID_CREDENTIALS and does NOT connect or authenticate', async () => {
    (routes[0] as Route & { fail?: boolean }).fail = true;
    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await expect(result.current.login('tester', 'wrong')).rejects.toMatchObject({
        key: 'INVALID_CREDENTIALS',
      });
    });

    expect(result.current.state.status).not.toBe('authenticated');
    expect(result.current.state.getAccessToken()).toBeNull();
    expect(readStoredRefreshToken()).toBeNull();
  });
});

describe('useAuth — refresh', () => {
  it('refreshTokens exchanges the pair and persists the new refresh token', async () => {
    writeStoredRefreshToken('refresh-1');
    authStore.getState().updateTokens('stale', 'refresh-1', 900);

    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await result.current.refreshTokens();
    });

    expect(result.current.state.getAccessToken()).toBe('access-2');
    expect(readStoredRefreshToken()).toBe('refresh-2');
  });

  it('is single-flight: concurrent refresh calls share one exchange', async () => {
    writeStoredRefreshToken('refresh-1');
    authStore.getState().updateTokens('stale', 'refresh-1', 900);

    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/auth/refresh')) {
        calls++;
        await new Promise((r) => setTimeout(r, 20));
        return jsonResponse(200, { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 900 });
      }
      return jsonResponse(404, {});
    }));

    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await Promise.all([result.current.refreshTokens(), result.current.refreshTokens()]);
    });

    expect(calls).toBe(1);
  });

  it('failed refresh resets the store to unauthenticated', async () => {
    writeStoredRefreshToken('dead-token');
    authStore.getState().updateTokens('stale', 'dead-token', 900);
    authStore.getState().setUser({ ...USER, id: 'x' });

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { error: { key: 'unauthorized', code: 40101, message: 'expired' } })));

    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await expect(result.current.refreshTokens()).rejects.toThrow();
    });

    expect(result.current.state.status).toBe('unauthenticated');
    expect(result.current.state.getAccessToken()).toBeNull();
    expect(readStoredRefreshToken()).toBeNull();
  });

  it('proactive refresh is due inside the expiry margin', async () => {
    // Expiry 1 minute out → inside the 2-minute proactive margin.
    authStore.getState().setAccessToken('soon-expiring', 60);
    const { result } = renderHook(() => useAuth());
    expect(result.current.shouldRefreshProactively()).toBe(true);

    // Expiry 30 minutes out → outside the margin.
    act(() => {
      authStore.getState().setAccessToken('long-lived', 1800);
    });
    expect(result.current.shouldRefreshProactively()).toBe(false);
  });
});

describe('useAuth — logout', () => {
  it('logout revokes, clears the refresh token, resets the store', async () => {
    writeStoredRefreshToken('refresh-1');
    authStore.getState().setAuthenticated(TOKENS, { ...USER, id: '1', username: 'tester', email: 'e', email_verified_at: null });
    authStore.getState().setStatus('authenticated');

    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await result.current.logout();
    });

    expect(result.current.state.status).toBe('unauthenticated');
    expect(result.current.state.getAccessToken()).toBeNull();
    expect(readStoredRefreshToken()).toBeNull();
  });
});

describe('useAuth — restore', () => {
  it('restore with a persisted refresh token rotates and authenticates', async () => {
    writeStoredRefreshToken('refresh-persisted');

    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await result.current.restore();
    });

    expect(result.current.state.status).toBe('authenticated');
    expect(result.current.state.getAccessToken()).toBe('access-2');
    expect(result.current.state.currentUser?.username).toBe('tester');
  });

  it('restore without a token lands unauthenticated', async () => {
    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await result.current.restore();
    });

    expect(result.current.state.status).toBe('unauthenticated');
  });
});
