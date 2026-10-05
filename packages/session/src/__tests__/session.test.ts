/**
 * @cytale/session — extracted session orchestration (plan 004 M4).
 *
 * These are the M4 test scenarios the extraction must not lose (R4/R6):
 *   1. login persists the pair, sets the user, connects the gateway;
 *   2. F6 — the proactive refresh is armed at LOGIN, not only after an
 *      exchange (the bug that let an idle connected session ride its token
 *      to expiry);
 *   3. an expired access token triggers a refresh exchange BEFORE the token
 *      handed to (re-)Identify — the gateway tokenProvider path;
 *   4. a revoked refresh token lands on re-auth (`unauthenticated`), never a
 *      connected gateway cycling re-Identify against a dead credential;
 *   5. a cold launch with a persisted pair restores the session;
 *   6. logout revokes, wipes storage, and tears the gateway down;
 *   7. pre-processors run before the shared store dispatcher (the ordering
 *      the web reactions replay gate depends on).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createStateStore } from '@cytale/state';

import { createMemoryTokenStorage } from '../tokenStorage.js';
import { createSessionManager, ServerOriginError, validateServerOrigin, type SessionManager } from '../session.js';
import {
  authRoutes,
  fakeGatewayFactory,
  installFetch,
  REFRESHED,
  TOKENS,
  USER,
  type CapturedGateway,
  type FetchHarness,
} from './testSupport.js';

let fetchHarness: FetchHarness;
let gateways: CapturedGateway[];

function makeSession(overrides: Partial<Parameters<typeof createSessionManager>[0]> = {}): SessionManager {
  return createSessionManager({
    storage: createMemoryTokenStorage(),
    createGatewayClient: fakeGatewayFactory(gateways),
    // Node has no `location`, so this is a native-shaped runtime: the origin
    // must be supplied (the manager refuses to guess a host — see the
    // `ws://localhost` regression test below).
    resolveOrigin: () => 'http://127.0.0.1:4001',
    ...overrides,
  });
}

beforeEach(() => {
  gateways = [];
  fetchHarness = installFetch(authRoutes());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('login', () => {
  it('persists the pair, sets the user, and connects the gateway', async () => {
    const storage = createMemoryTokenStorage();
    const session = makeSession({ storage });

    await session.login('tester', 'password-123');

    expect(session.authStore.getState().status).toBe('authenticated');
    expect(session.authStore.getState().currentUser?.username).toBe('tester');
    expect(session.authStore.getState().emailVerified).toBe(false);
    expect(session.authStore.getState().getAccessToken()).toBe('access-1');
    // R5: the pair is durable in the injected storage (web: localStorage,
    // native: Keychain/Keystore) — flush() resolved above.
    expect(storage.read()).toEqual({ accessToken: 'access-1', refreshToken: 'refresh-1' });
    expect(gateways).toHaveLength(1);
    expect(gateways[0]?.connects).toBe(1);
  });

  it('F6: arms the proactive refresh at login', async () => {
    vi.useFakeTimers();
    const session = makeSession();

    await session.login('tester', 'password-123');
    expect(session.authStore.getState().status).toBe('authenticated');
    expect(fetchHarness.count('/auth/refresh')).toBe(0);

    // expires_in 900s − 2 min margin → the exchange fires at ~13 min.
    await vi.advanceTimersByTimeAsync(13 * 60 * 1000 + 100);

    expect(fetchHarness.count('/auth/refresh')).toBe(1);
    expect(session.authStore.getState().getAccessToken()).toBe(REFRESHED.access_token);
    expect(session.authStore.getState().getRefreshToken()).toBe(REFRESHED.refresh_token);
  });

  it('a failed login leaves the session unauthenticated with no gateway', async () => {
    fetchHarness = installFetch(
      authRoutes({
        login: () => ({ status: 401, body: { error: { key: 'INVALID_CREDENTIALS', code: 40101, message: 'denied' } } }),
      }),
    );
    const session = makeSession();

    await expect(session.login('tester', 'wrong')).rejects.toMatchObject({ key: 'INVALID_CREDENTIALS' });

    expect(session.authStore.getState().status).not.toBe('authenticated');
    expect(session.authStore.getState().getAccessToken()).toBeNull();
    expect(gateways).toHaveLength(0);
  });
});

describe('gateway endpoint resolution', () => {
  it('refuses to guess a host when the runtime has no origin and no location', async () => {
    // The regression: a native build that never wired `resolveOrigin` used to
    // dial `ws://localhost:4001` — on a device, its own loopback — and the
    // only symptom was a reconnect loop against a host nobody chose.
    const session = makeSession({ resolveOrigin: () => undefined });

    await expect(session.login('tester', 'password-123')).rejects.toThrow(/resolveOrigin/);
    expect(gateways).toHaveLength(0);
  });

  it('derives the socket URL from the origin, upgrading to wss for https', async () => {
    const session = makeSession({ resolveOrigin: () => 'https://chat.example.com' });
    await session.login('tester', 'password-123');

    expect(gateways[0]?.options.url).toBe('wss://chat.example.com/gateway/websocket');
  });
});

describe('gateway (re-)Identify token provider', () => {
  it('refreshes an expired access token before handing a token to Identify', async () => {
    const session = makeSession();
    await session.login('tester', 'password-123');

    const options = gateways[0]?.options;
    expect(options).toBeDefined();

    // Simulate downtime: the in-memory access token is past expiry.
    session.authStore.getState().updateTokens('expired-access', 'refresh-1', -60);
    expect(fetchHarness.count('/auth/refresh')).toBe(0);

    const token = await options!.tokenProvider();

    // The exchange happened first (not a re-Identify against a dead token)…
    expect(fetchHarness.count('/auth/refresh')).toBe(1);
    // …and the U9 contract still carried the last-seen (expired) access JWT.
    // The header is read case-insensitively: the exchange runs through the
    // shared Http layer now (plan 4.14b), which spells it `Authorization`, and
    // HTTP header names are case-insensitive — this harness captures the init
    // literally, so the assertion must not depend on the casing.
    const refreshCall = fetchHarness.calls.find((c) => c.url.endsWith('/auth/refresh'));
    const refreshHeaders = (refreshCall?.init.headers ?? {}) as Record<string, string>;
    expect(refreshHeaders.authorization ?? refreshHeaders.Authorization).toBe('Bearer expired-access');
    expect(token).toBe(REFRESHED.access_token);
  });

  it('returns the live token without an exchange while it is fresh', async () => {
    const session = makeSession();
    await session.login('tester', 'password-123');

    const token = await gateways[0]!.options.tokenProvider();

    expect(token).toBe(TOKENS.access_token);
    expect(fetchHarness.count('/auth/refresh')).toBe(0);
  });
});

describe('revoked / expired session', () => {
  it('restore() with a revoked refresh token lands on re-auth, not a reconnect loop', async () => {
    const storage = createMemoryTokenStorage({ accessToken: 'access-1', refreshToken: 'revoked' });
    fetchHarness = installFetch(
      authRoutes({ refresh: () => ({ status: 401, body: { error: { key: 'unauthorized', code: 40101, message: 'revoked' } } }) }),
    );
    const session = makeSession({ storage });

    await session.restore();

    expect(session.authStore.getState().status).toBe('unauthenticated');
    expect(session.authStore.getState().getAccessToken()).toBeNull();
    // No gateway was ever built → no Identify/backoff loop against the dead
    // credential (R6: the same state web surfaces).
    expect(gateways).toHaveLength(0);
    expect(fetchHarness.count('/auth/refresh')).toBe(1);

    // The failed restore ran the store's reset (web semantics: it clears both
    // persisted keys), so a second restore has nothing to exchange — one
    // attempt, then re-auth. No background retry, no reconnect loop.
    expect(storage.read()).toBeNull();
    await session.restore();
    expect(fetchHarness.count('/auth/refresh')).toBe(1);
    expect(session.authStore.getState().status).toBe('unauthenticated');
    expect(gateways).toHaveLength(0);
  });

  it('an explicit refresh failure resets the store and clears storage', async () => {
    const storage = createMemoryTokenStorage({ accessToken: 'access-1', refreshToken: 'revoked' });
    fetchHarness = installFetch(
      authRoutes({ refresh: () => ({ status: 401, body: { error: { key: 'unauthorized', code: 40101, message: 'revoked' } } }) }),
    );
    const session = makeSession({ storage });
    session.authStore.getState().updateTokens('access-1', 'revoked', 900);

    await expect(session.refreshTokens()).rejects.toThrow();

    expect(session.authStore.getState().status).toBe('unauthenticated');
    expect(storage.read()).toBeNull();
  });

  // Plan 4.14a. The failed-refresh branch used to reset the auth store and stop
  // there, which ended the session in the store but nowhere else: the gateway
  // stayed connected (re-Identifying against a credential the server no longer
  // accepts) and the default store kept the previous user's hydrated messages,
  // which is what the next page reads before any login.
  it('a failed refresh tears the gateway down and clears the previous session data', async () => {
    const store = createStateStore();
    const session = makeSession({ store });
    await session.login('tester', 'password-123');

    // A live, hydrated session: a dispatch frame has landed in the shared store.
    gateways[0]!.emit({
      op: 0,
      t: 'MessageCreate',
      s: 5,
      d: {
        id: '1',
        channel_id: '2',
        thread_id: null,
        author_id: '9',
        content: 'previous user message',
        created_at: '2026-09-08T00:00:00.000Z',
        edited_at: null,
      },
    });
    expect(Object.keys(store.getState().messagesByChannel).length).toBeGreaterThan(0);
    expect(gateways[0]!.disconnects).toBe(0);

    // The refresh token is dead server-side.
    fetchHarness = installFetch(
      authRoutes({ refresh: () => ({ status: 401, body: { error: { key: 'unauthorized', code: 40101, message: 'revoked' } } }) }),
    );

    await expect(session.refreshTokens()).rejects.toThrow();

    // The session is over EVERYWHERE: no gateway, no session data, no gateway
    // handle for a stale subscriber to send on.
    expect(gateways[0]!.disconnects).toBe(1);
    expect(gateways[0]!.destroys).toBe(1);
    expect(session.getGateway()).toBeNull();
    expect(store.getState().messagesByChannel).toEqual({});
    expect(store.getState().currentUser).toBeNull();
    expect(session.authStore.getState().status).toBe('unauthenticated');
  });

  // Plan 4.14a's other half, and the reason the teardown is gated on a REFUSAL
  // rather than on any rejection: `Http.#exchange` awaits the raw fetch, so being
  // offline rejects with a TypeError. Ending the session on that signs a user out
  // for waking a laptop in a lift, and `#teardown()` also destroys the gateway
  // client whose reconnect loop is the thing that would have recovered.
  it('a TRANSPORT failure on refresh leaves the session and its credentials intact', async () => {
    const store = createStateStore();
    const session = makeSession({ store });
    await session.login('tester', 'password-123');

    // The network is gone: the fetch itself rejects, no response at all.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    await expect(session.refreshTokens()).rejects.toThrow(TypeError);

    // Still signed in, still connected, tokens still stored.
    expect(session.authStore.getState().status).toBe('authenticated');
    expect(session.authStore.getState().getRefreshToken()).toBe(TOKENS.refresh_token);
    expect(session.getGateway()).not.toBeNull();
    expect(gateways[0]!.disconnects).toBe(0);
    expect(gateways[0]!.destroys).toBe(0);

    // And the session can still refresh once the network returns.
    fetchHarness = installFetch(authRoutes());
    await session.refreshTokens();
    expect(session.authStore.getState().getRefreshToken()).toBe(REFRESHED.refresh_token);
  });
});

describe('ONE refresh exchange owns the rotation (plan 4.14b)', () => {
  it('a gateway refresh and a REST 401 in flight together run exactly one exchange', async () => {
    // The gateway path enters through the SAME method the socket's tokenProvider
    // calls (`session.refreshTokens()`), so driving it here is the tokenProvider
    // path, not a stand-in for it.
    // Refresh tokens ROTATE and the server deletes the old hash on the first
    // exchange. Two independent single-flights (the session's own fetch and
    // Http's) therefore presented the same token twice: the loser was answered
    // REFRESH_REVOKED → onLogout → a hard logout of a valid session.
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });

    let meCalls = 0;
    fetchHarness = installFetch([
      { match: (url) => url.endsWith('/auth/login'), respond: () => ({ status: 200, body: TOKENS }) },
      {
        match: (url) => url.endsWith('/users/@me'),
        respond: () => {
          meCalls += 1;
          // Login's identity read, then the REST call that 401s (driving Http's
          // own refresh), then the retry that the single exchange rescued.
          if (meCalls === 2) {
            return { status: 401, body: { error: { key: 'token_expired', code: 40101, message: 'expired' } } };
          }
          return { status: 200, body: { user: USER } };
        },
      },
      {
        match: (url) => url.endsWith('/auth/refresh'),
        respond: async () => {
          await refreshGate;
          return { status: 200, body: REFRESHED };
        },
      },
      { match: (url) => url.endsWith('/auth/logout'), respond: () => ({ status: 200, body: { logged_out: true } }) },
    ]);

    const session = makeSession();
    await session.login('tester', 'password-123');
    expect(meCalls).toBe(1);

    // Both paths reach for a rotation while the first is still on the wire.
    const proactive = session.refreshTokens();
    const rest = session.api.getCurrentUser().catch(() => undefined);

    await vi.waitFor(() => expect(fetchHarness.count('/auth/refresh')).toBe(1));
    releaseRefresh();
    await Promise.all([proactive, rest]);

    // EXACTLY one exchange, and the session survived it.
    expect(fetchHarness.count('/auth/refresh')).toBe(1);
    expect(session.authStore.getState().status).toBe('authenticated');
    expect(session.authStore.getState().getRefreshToken()).toBe(REFRESHED.refresh_token);
  });
});

describe('cold-launch restore (R5)', () => {
  it('restores an authenticated session from the persisted pair', async () => {
    const storage = createMemoryTokenStorage({ accessToken: 'stale-access', refreshToken: 'refresh-1' });
    const session = makeSession({ storage });

    await session.restore();

    expect(session.authStore.getState().status).toBe('authenticated');
    expect(session.authStore.getState().currentUser?.username).toBe(USER.username);
    expect(session.authStore.getState().getAccessToken()).toBe(REFRESHED.access_token);
    expect(storage.read()).toEqual({
      accessToken: REFRESHED.access_token,
      refreshToken: REFRESHED.refresh_token,
    });
    expect(gateways[0]?.connects).toBe(1);
  });

  it('lands unauthenticated when nothing is persisted', async () => {
    const session = makeSession();

    await session.restore();

    expect(session.authStore.getState().status).toBe('unauthenticated');
    expect(gateways).toHaveLength(0);
  });

  it('hydrates an async backend before reading the pair', async () => {
    // A cold Keychain/Keystore read is async; the adapter exposes hydrate().
    const inner = createMemoryTokenStorage({ accessToken: 'stale-access', refreshToken: 'refresh-1' });
    let hydrated = false;
    const storage = {
      read: () => (hydrated ? inner.read() : null),
      write: (pair: Parameters<typeof inner.write>[0]) => inner.write(pair),
      hydrate: async () => {
        hydrated = true;
      },
      flush: async () => {},
    };
    const session = makeSession({ storage });

    await session.restore();

    expect(hydrated).toBe(true);
    expect(session.authStore.getState().status).toBe('authenticated');
  });

  it('lands unauthenticated when the storage hydrate rejects', async () => {
    // Native keychain reads can reject (device locked, keystore unavailable).
    // A rejecting hydrate must not strand the store in 'loading' with no
    // re-auth path — the app has to surface the login screen.
    const storage = {
      read: () => null,
      write: async () => {},
      hydrate: async () => {
        throw new Error('keychain unavailable');
      },
      flush: async () => {},
    };
    const session = makeSession({ storage });

    await session.restore();

    expect(session.authStore.getState().status).toBe('unauthenticated');
    expect(gateways).toHaveLength(0);
  });
});

describe('logout', () => {
  it('revokes server-side, wipes storage, and tears the gateway down', async () => {
    const storage = createMemoryTokenStorage();
    const session = makeSession({ storage });
    await session.login('tester', 'password-123');
    expect(storage.read()).not.toBeNull();

    await session.logout();

    expect(session.authStore.getState().status).toBe('unauthenticated');
    expect(session.authStore.getState().getAccessToken()).toBeNull();
    expect(storage.read()).toBeNull();
    expect(fetchHarness.count('/auth/logout')).toBe(1);
    expect(gateways[0]?.disconnects).toBe(1);
    expect(gateways[0]?.destroys).toBe(1);
    expect(session.getGateway()).toBeNull();
  });
});

describe('F1 — a refresh in flight across a sign-out must not resurrect the session', () => {
  it('ignores a proactive refresh that resolves after logout', async () => {
    const storage = createMemoryTokenStorage();
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    fetchHarness = installFetch(
      authRoutes({
        refresh: async () => {
          await refreshGate;
          return { status: 200, body: REFRESHED };
        },
      }),
    );
    const session = makeSession({ storage });
    await session.login('tester', 'password-123');
    expect(storage.read()).toEqual({ accessToken: 'access-1', refreshToken: 'refresh-1' });

    // The exchange is dispatched and parked on the gate…
    const refreshing = session.refreshTokens();
    // The dispatch now goes through Http's single-flight, which awaits the
    // token provider before it dials, so give it the ticks it needs instead of
    // assuming one. `waitFor` still fails loudly if the exchange never leaves.
    await vi.waitFor(() => expect(fetchHarness.count('/auth/refresh')).toBe(1));

    // …the user signs out while it is still on the wire…
    await session.logout();
    expect(storage.read()).toBeNull();

    // …and the server's rotated pair lands AFTER the wipe. It must be dropped:
    // re-persisting it would hand the next cold launch a live 30-day refresh
    // token for an account that has already signed out (the presented token
    // was never revoked — it did not exist when /auth/logout ran).
    releaseRefresh();
    await refreshing;

    expect(storage.read()).toBeNull();
    expect(session.authStore.getState().status).toBe('unauthenticated');
    expect(session.authStore.getState().getAccessToken()).toBeNull();
  });

  it('ignores a REST 401 refresh that resolves after logout', async () => {
    // The api-client's own 401 → refresh → retry path writes through the same
    // TokenProvider, so it needs the same guard.
    const storage = createMemoryTokenStorage();
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let meCalls = 0;
    fetchHarness = installFetch([
      {
        match: (url) => url.endsWith('/auth/login'),
        respond: () => ({ status: 200, body: TOKENS }),
      },
      {
        // Login's /users/@me succeeds; the post-login REST call 401s so the
        // Http layer drives its own refresh exchange.
        match: (url) => url.endsWith('/users/@me'),
        respond: () =>
          ++meCalls === 1
            ? { status: 200, body: { user: USER } }
            : { status: 401, body: { error: { key: 'token_expired', code: 40101, message: 'expired' } } },
      },
      {
        match: (url) => url.endsWith('/auth/refresh'),
        respond: async () => {
          await refreshGate;
          return { status: 200, body: REFRESHED };
        },
      },
      {
        match: (url) => url.endsWith('/auth/logout'),
        respond: () => ({ status: 200, body: { logged_out: true } }),
      },
    ]);
    const session = makeSession({ storage });
    await session.login('tester', 'password-123');

    const restCall = session.api.getCurrentUser().catch((err: unknown) => err);
    await vi.waitFor(() => expect(fetchHarness.count('/auth/refresh')).toBe(1));

    await session.logout();
    expect(storage.read()).toBeNull();

    releaseRefresh();
    await restCall;

    expect(storage.read()).toBeNull();
    expect(session.authStore.getState().getAccessToken()).toBeNull();
    expect(session.authStore.getState().status).toBe('unauthenticated');
  });
});

describe('F3 — verification converges on the server-reported account', () => {
  it('does NOT mark the signed-in account verified when the token verified someone else', async () => {
    // POST /auth/verify-email is UNAUTHENTICATED: it verifies the TOKEN's
    // owner, which need not be the account signed in here.
    fetchHarness = installFetch([
      { match: (url) => url.endsWith('/auth/login'), respond: () => ({ status: 200, body: TOKENS }) },
      { match: (url) => url.endsWith('/auth/verify-email'), respond: () => ({ status: 200, body: { verified: true } }) },
      // …and this account is still unverified on the server.
      { match: (url) => url.endsWith('/users/@me'), respond: () => ({ status: 200, body: { user: USER } }) },
    ]);
    const session = makeSession();
    await session.login('tester', 'password-123');
    expect(session.authStore.getState().emailVerified).toBe(false);

    await session.verifyEmail('someone-elses-token');

    expect(session.authStore.getState().emailVerified).toBe(false);
    // The state converged from /users/@me rather than being asserted.
    expect(fetchHarness.count('/users/@me')).toBe(2);
  });

  it('converges to verified when the server reports this account was verified', async () => {
    let meCalls = 0;
    fetchHarness = installFetch([
      { match: (url) => url.endsWith('/auth/login'), respond: () => ({ status: 200, body: TOKENS }) },
      { match: (url) => url.endsWith('/auth/verify-email'), respond: () => ({ status: 200, body: { verified: true } }) },
      {
        match: (url) => url.endsWith('/users/@me'),
        respond: () =>
          ++meCalls === 1
            ? { status: 200, body: { user: USER } }
            : { status: 200, body: { user: { ...USER, email_verified_at: '2026-09-08T00:00:00.000Z' } } },
      },
    ]);
    const session = makeSession();
    await session.login('tester', 'password-123');

    await session.verifyEmail('own-token');

    expect(session.authStore.getState().emailVerified).toBe(true);
    expect(session.authStore.getState().currentUser?.email_verified_at).toBe('2026-09-08T00:00:00.000Z');
  });

  it('still resolves when the convergence read fails (signed out / offline)', async () => {
    // The token WAS consumed; a failed follow-up read must not turn a
    // successful verification into an error.
    fetchHarness = installFetch([
      { match: (url) => url.endsWith('/auth/verify-email'), respond: () => ({ status: 200, body: { verified: true } }) },
      { match: () => true, respond: () => ({ status: 401, body: { error: { key: 'unauthorized', code: 40101, message: 'denied' } } }) },
    ]);
    const session = makeSession();

    await expect(session.verifyEmail('token-while-signed-out')).resolves.toBeUndefined();

    expect(session.authStore.getState().emailVerified).toBe(false);
  });
});

describe('boot round trips (lane D #4)', () => {
  it('restore adopts the account the refresh returns — no /users/@me read', async () => {
    fetchHarness = installFetch(
      authRoutes({ refresh: () => ({ status: 200, body: { ...REFRESHED, user: { ...USER, username: 'from-refresh' } } }) }),
    );
    const storage = createMemoryTokenStorage({ accessToken: 'stale-access', refreshToken: 'refresh-1' });
    const session = makeSession({ storage });

    await session.restore();

    expect(session.authStore.getState().status).toBe('authenticated');
    expect(session.authStore.getState().currentUser?.username).toBe('from-refresh');
    expect(fetchHarness.count('/users/@me')).toBe(0);
    expect(gateways[0]?.connects).toBe(1);
  });

  it('restore still reads /users/@me when the refresh carries no account (older server)', async () => {
    const storage = createMemoryTokenStorage({ accessToken: 'stale-access', refreshToken: 'refresh-1' });
    const session = makeSession({ storage });

    await session.restore();

    expect(fetchHarness.count('/users/@me')).toBe(1);
    expect(session.authStore.getState().currentUser?.username).toBe(USER.username);
  });

  it('login adopts the account the token pair carries', async () => {
    fetchHarness = installFetch(
      authRoutes({ login: () => ({ status: 200, body: { ...TOKENS, user: { ...USER, username: 'from-login' } } }) }),
    );
    const session = makeSession();

    await session.login('tester', 'password-123');

    expect(session.authStore.getState().currentUser?.username).toBe('from-login');
    expect(fetchHarness.count('/users/@me')).toBe(0);
  });
});

describe('burst batching (lane D #18)', () => {
  it('READY and the frames that follow it land as ONE store commit', async () => {
    const store = createStateStore();
    let flush: (() => void) | null = null;
    const session = makeSession({
      store,
      dispatchBursts: {
        schedule: (f) => {
          flush = f;
        },
      },
    });
    await session.login('tester', 'password-123');

    let commits = 0;
    store.subscribe(() => {
      commits += 1;
    });
    const gw = gateways[0]!;
    gw.emit({
      op: 0,
      t: 'Ready',
      s: 0,
      d: { v: 1, session_id: 's', resume_token: 'r', heartbeat_interval: 1, user: { id: USER.id, username: USER.username } },
    });
    gw.emit({
      op: 0,
      t: 'PresenceUpdate',
      s: 1,
      d: { user_id: '55', status: 'online', last_seen_at: 'x' },
    });
    gw.emit({
      op: 0,
      t: 'MessageCreate',
      s: 2,
      d: { id: '1', channel_id: '2', thread_id: null, author_id: '9', content: 'hi', created_at: 'x', edited_at: null },
    });
    // Nothing applied until the window closes…
    expect(commits).toBe(0);
    expect(store.getState().sessionStatus).toBe('fresh');
    flush!();
    // …then everything, once.
    expect(commits).toBe(1);
    expect(store.getState().sessionStatus).toBe('ready');
    expect(store.getState().presenceByUser['55']?.status).toBe('online');
    expect(store.getState().lastSeq).toBe(2);

    // Live traffic outside a window applies at once.
    gw.emit({
      op: 0,
      t: 'MessageCreate',
      s: 3,
      d: { id: '3', channel_id: '2', thread_id: null, author_id: '9', content: 'live', created_at: 'x', edited_at: null },
    });
    expect(commits).toBe(2);
  });
});

describe('dispatch chain', () => {
  it('runs pre-processors before the shared store dispatcher', async () => {
    const store = createStateStore();
    const order: string[] = [];
    const session = makeSession({
      store,
      gatewayPreprocessors: [
        () => {
          // The reactions replay gate must read the pre-dispatch sequence.
          order.push(`pre:${store.getState().lastSeq}`);
        },
      ],
    });
    await session.login('tester', 'password-123');

    // A WELL-FORMED dispatch: the shared store writes in dispatch-sized
    // batches and stages nothing for a frame it cannot model (a bare
    // `{id, channel_id}` message is dropped, so no write — and no sequence
    // advance). The pre-processor ordering below is observable either way,
    // but a real frame keeps this test measuring the production path.
    gateways[0]!.emit({
      op: 0,
      t: 'MessageCreate',
      s: 7,
      d: {
        id: '1',
        channel_id: '2',
        thread_id: null,
        author_id: '9',
        content: 'hello',
        created_at: '2026-09-08T00:00:00.000Z',
        edited_at: null,
      },
    });
    order.push(`post:${store.getState().lastSeq}`);

    expect(order).toEqual(['pre:0', 'post:7']);
  });

  it('converges the auth store self profile from our own UserUpdate', async () => {
    const session = makeSession();
    await session.login('tester', 'password-123');
    expect(session.authStore.getState().currentUser?.username).toBe(USER.username);

    gateways[0]!.emit({
      op: 0,
      t: 'UserUpdate',
      s: 3,
      d: { id: USER.id, username: 'renamed', display_name: 'Renamed', avatar_url: null },
    });

    expect(session.authStore.getState().currentUser?.username).toBe('renamed');
    expect(session.authStore.getState().currentUser?.display_name).toBe('Renamed');
  });
});

describe('setServerOrigin — the login-time server selection (2026-09-19)', () => {
  it('re-points the api base: login dials the override origin, not resolveOrigin', async () => {
    const session = makeSession({ resolveOrigin: () => 'https://default.example' });
    session.setServerOrigin('https://other.example');

    await session.login('rowan', 'secret');

    const login = fetchHarness.calls.filter((c) => c.url.endsWith('/auth/login'));
    expect(login).toHaveLength(1);
    expect(login[0]!.url.startsWith('https://other.example/api/v1/auth/login')).toBe(true);
  });

  it('refuses while authenticated and keeps the current origin', async () => {
    const session = makeSession();
    await session.login('rowan', 'secret');

    expect(() => session.setServerOrigin('https://other.example')).toThrow(ServerOriginError);

    // The established session keeps dialling the origin it authenticated against.
    await session.logout();
    const logout = fetchHarness.calls.filter((c) => c.url.endsWith('/auth/logout'));
    expect(logout).toHaveLength(1);
    expect(logout[0]!.url.startsWith('http://127.0.0.1:4001/api/v1/auth/logout')).toBe(true);
  });

  it('persists the choice across reconnects: the gateway dials the override too', async () => {
    const session = makeSession({ resolveOrigin: () => 'https://default.example' });
    session.setServerOrigin('https://other.example');
    await session.login('rowan', 'secret');

    expect(gateways[0]!.options.url.startsWith('wss://other.example/gateway/websocket')).toBe(true);
  });
});

describe('validateServerOrigin — the login form rule', () => {
  it('accepts https and trims', () => {
    expect(validateServerOrigin('  https://hrmny.chat ')).toBe('https://hrmny.chat');
  });

  it('accepts http loopback only in development builds', () => {
    expect(validateServerOrigin('http://localhost:4000', { dev: true })).toBe(
      'http://localhost:4000',
    );
    expect(() => validateServerOrigin('http://localhost:4000')).toThrow(ServerOriginError);
  });

  it('rejects non-https remote hosts, junk, and non-absolute input', () => {
    expect(() => validateServerOrigin('http://hrmny.chat')).toThrow(ServerOriginError);
    expect(() => validateServerOrigin('hrmny.chat')).toThrow(ServerOriginError);
    expect(() => validateServerOrigin('')).toThrow(ServerOriginError);
  });
});
