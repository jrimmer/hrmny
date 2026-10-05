/**
 * Shared fixtures for the M12 auth tests. Not a test file — jest's testMatch
 * only picks up `*.test.ts(x)`.
 *
 * The scenarios in the plan name real round-trips (wrong password, revoked
 * session, resend), so these tests drive the REAL `SessionManager` over
 * `createMemoryTokenStorage()` with the wire stubbed at `globalThis.fetch`
 * (the manager's api-client resolves fetch at request time). Only the socket
 * is faked: `createGatewayClient` never opens one, so a test can assert the
 * manager's gateway teardown without a network.
 *
 * `sessionModuleMock()` is the bridge for suites that mount the real app tree:
 * `renderRouter(APP_DIR)` builds the manager inside `SessionProvider`, so the
 * package's factory has to be swapped for one that uses memory storage.
 */
import type * as SessionPackage from '@cytale/session';
import type { CurrentUser } from '@cytale/api-client';
import type { GatewayClient, GatewayClientOptions } from '@cytale/gateway-client';
import type { SessionManager, SessionManagerOptions } from '@cytale/session';

/** The memory adapter's type — `snapshot()` is the assertion seam. */
export type MemoryTokenStorage = ReturnType<typeof SessionPackage.createMemoryTokenStorage>;

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export const VERIFIED_USER: CurrentUser = {
  id: '900000000000000001',
  username: 'rowan',
  display_name: 'Rowan',
  email: 'rowan@jmc.test',
  email_verified: true,
  email_verified_at: '2026-01-01T00:00:00.000Z',
  avatar_url: null,
  created_at: '2026-01-01T00:00:00.000Z',
};

export const UNVERIFIED_USER: CurrentUser = {
  ...VERIFIED_USER,
  email_verified: false,
};

// ---------------------------------------------------------------------------
// Stubbed wire (globalThis.fetch)
// ---------------------------------------------------------------------------

export interface WireCall {
  url: string;
  method: string;
  body: unknown;
}

export interface WireRoute {
  match: (url: string, init: RequestInit) => boolean;
  respond: () => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;
}

export interface Wire {
  calls: WireCall[];
  /** Requests seen for a URL suffix, in order. */
  seen(suffix: string): WireCall[];
  restore(): void;
}

export function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Install a routed fetch stub; every request is recorded. */
export function installWire(routes: WireRoute[]): Wire {
  const calls: WireCall[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({
      url,
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : init.body,
    });
    for (const route of routes) {
      if (route.match(url, init)) {
        const { status, body } = await route.respond();
        return jsonResponse(status, body);
      }
    }
    return jsonResponse(404, { error: { key: 'not_found', code: 40404, message: 'no route' } });
  }) as unknown as typeof fetch;

  return {
    calls,
    seen: (suffix) => calls.filter((call) => call.url.endsWith(suffix)),
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

export interface AuthRoutesOptions {
  /** `/users/@me` answer; also what login/register converge on. */
  user?: CurrentUser;
  /** Override `/users/@me` (e.g. to simulate a revoked session mid-use). */
  usersMe?: () => { status: number; body: unknown };
  login?: () => { status: number; body: unknown };
  register?: () => { status: number; body: unknown };
  refresh?: () => { status: number; body: unknown };
}

export const TOKENS = { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 900 };

/** The documented `/api/v1` auth contract the screens drive. */
export function authRoutes(options: AuthRoutesOptions = {}): WireRoute[] {
  const user = options.user ?? VERIFIED_USER;
  return [
    { match: (url) => url.endsWith('/auth/login'), respond: options.login ?? (() => ({ status: 200, body: TOKENS })) },
    {
      match: (url) => url.endsWith('/auth/register'),
      respond: options.register ?? (() => ({ status: 201, body: TOKENS })),
    },
    {
      match: (url) => url.endsWith('/users/@me'),
      respond: options.usersMe ?? (() => ({ status: 200, body: { user } })),
    },
    {
      match: (url) => url.endsWith('/auth/refresh'),
      respond: options.refresh ?? (() => ({ status: 200, body: TOKENS })),
    },
    { match: (url) => url.endsWith('/auth/logout'), respond: () => ({ status: 200, body: { logged_out: true } }) },
    {
      match: (url) => url.endsWith('/auth/verify-email'),
      respond: () => ({ status: 200, body: { verified: true } }),
    },
    {
      match: (url) => url.endsWith('/auth/resend-verification'),
      respond: () => ({ status: 200, body: { sent: true } }),
    },
  ];
}

// ---------------------------------------------------------------------------
// Gateway double
// ---------------------------------------------------------------------------

/** A gateway that never opens a socket; the manager's teardown still runs. */
export function createFakeGateway(options: GatewayClientOptions): GatewayClient {
  const fake = {
    options,
    onAny: () => () => undefined,
    // The typed-event seam the inbox hook (and any live-wire consumer)
    // subscribes through; the double accepts every event and never fires.
    on: () => () => undefined,
    connect: async () => undefined,
    disconnect: () => undefined,
    destroy: () => undefined,
    updatePresence: () => undefined,
    send: async () => undefined,
  };
  return fake as unknown as GatewayClient;
}

// ---------------------------------------------------------------------------
// Signed-in fixture for suites that mount the real app tree
// ---------------------------------------------------------------------------

let routeUser: CurrentUser | null = null;
let routeWire: Wire | null = null;
let sharedStorage: MemoryTokenStorage | null = null;
let built: { manager: SessionManager; storage: MemoryTokenStorage } | null = null;

/** The one credential adapter this test file's managers share. */
function storageForTests(actual: typeof import('@cytale/session')): MemoryTokenStorage {
  sharedStorage ??= actual.createMemoryTokenStorage();
  return sharedStorage;
}

/** Test hygiene: a fresh, empty credential adapter. */
export function resetSessionModuleMock(): void {
  sharedStorage = null;
  built = null;
  routeUser = null;
  routeWire?.restore();
  routeWire = null;
}

/**
 * The transport a signed-in app tree needs: an empty history page (the
 * channel/thread suites assert surfaces, not messages), the anti-enumeration
 * 404 for a thread the store does not hold, and the auth reads a rebuilt
 * manager performs.
 */
function installShellWire(): Wire {
  return installWire([
    {
      match: (url) => /\/channels\/[^/]+\/messages/.test(url),
      respond: () => ({ status: 200, body: { messages: [], oldest_id: null } }),
    },
    {
      match: (url) => /\/threads\/[^/]+\/messages/.test(url),
      respond: () => ({ status: 200, body: { messages: [] } }),
    },
    {
      match: (url, init) => /\/threads\/[^/]+$/.test(url) && (init.method ?? 'GET') === 'GET',
      respond: () => ({ status: 404, body: { error: { key: 'not_found', code: 40404, message: 'no thread' } } }),
    },
    { match: (url) => url.endsWith('/users/@me'), respond: () => ({ status: 200, body: { user: VERIFIED_USER } }) },
    { match: (url) => url.endsWith('/auth/refresh'), respond: () => ({ status: 200, body: TOKENS }) },
  ]);
}

/**
 * The last manager `SessionProvider` built in this test file. The auth flow
 * tests drive the app's REAL manager through it (revoke a session mid-use,
 * read the storage the sign-out must clear) instead of constructing a second
 * one the UI never sees.
 */
export function lastBuiltSession(): typeof built {
  return built;
}

/**
 * Make the next manager `SessionProvider` builds start signed in — the route
 * suites exercise the drawer, not the auth flow, and the M12 gate correctly
 * hides the drawer from a signed-out tree. An authenticated tree reads
 * history, so this also installs the empty-page transport.
 */
export function signInRouteSession(user: CurrentUser = VERIFIED_USER): void {
  routeUser = user;
  routeWire ??= installShellWire();
}

/** Test hygiene: back to a signed-out app. */
export function signOutRouteSession(): void {
  routeUser = null;
  routeWire?.restore();
  routeWire = null;
}

/**
 * The `@cytale/session` module with its factory pointed at memory storage.
 * Consumed through `jest.mock`:
 *
 *   jest.mock('@cytale/session', () =>
 *     require('../../auth/__tests__/support').sessionModuleMock());
 *
 * The storage is shared across managers the way the Keychain is in
 * production: `renderRouter` can remount the layout, and a rebuilt manager
 * must restore the persisted session rather than silently sign the user out.
 */
export function sessionModuleMock(): typeof import('@cytale/session') {
  const actual = jest.requireActual<typeof import('@cytale/session')>('@cytale/session');
  return {
    ...actual,
    createSessionManager: (options: SessionManagerOptions): SessionManager => {
      const storage = storageForTests(actual);
      const manager = actual.createSessionManager({
        ...options,
        storage,
        // The test runtime is native-shaped (no `location`): the manager
        // refuses to guess a gateway host without an origin.
        resolveOrigin: options.resolveOrigin ?? (() => 'http://127.0.0.1:4001'),
        createGatewayClient: createFakeGateway,
      });
      built = { manager, storage };
      if (routeUser !== null) {
        manager.authStore
          .getState()
          .setAuthenticated({ access_token: 'route-access', refresh_token: 'route-refresh', expires_in: 900 }, routeUser);
        jest.spyOn(manager, 'restore').mockResolvedValue(undefined);
      }
      return manager;
    },
  };
}
