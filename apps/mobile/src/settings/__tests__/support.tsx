/**
 * Shared fixtures for the settings tests (plan 004 M10). Not a test file —
 * jest's testMatch only picks up `*.test.ts(x)`.
 *
 * The settings scenarios name real API round-trips, so these tests drive the
 * REAL `CytaleApiClient` through its documented `fetchImpl` seam (a stubbed
 * transport) over a REAL `SessionManager` on `createMemoryTokenStorage()` —
 * never a mocked session. The only double in the stack is the wire.
 */
import { CytaleApiClient, type CurrentUser } from '@cytale/api-client';
import { createMemoryTokenStorage, createSessionManager, type StoredTokenPair } from '@cytale/session';
import { createStateStore } from '@cytale/state';

import { createSettingsServices, type SettingsServices } from '../services';

/** One captured request, with the JSON body already parsed. */
export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export type StubHandler = (request: RecordedRequest) => Response | Promise<Response>;

function jsonBody(init: RequestInit | undefined): unknown {
  if (init?.body === undefined || init.body === null) return undefined;
  if (typeof init.body !== 'string') return init.body;
  try {
    return JSON.parse(init.body) as unknown;
  } catch {
    return init.body;
  }
}

/**
 * A stubbed transport: records every request and answers via `handler`.
 * Installed as the client's `fetchImpl`, so the client's real URL building,
 * auth headers, envelope parsing, and error mapping all run.
 */
export function createStubTransport(handler: StubHandler): {
  calls: RecordedRequest[];
  fetchImpl: typeof fetch;
} {
  const calls: RecordedRequest[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    const request: RecordedRequest = {
      method: init?.method ?? 'GET',
      url: String(input),
      headers,
      body: jsonBody(init),
    };
    calls.push(request);
    return await handler(request);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

/** A JSON response shaped the way the api-client's Http layer reads one. */
export function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** A no-content response (DELETE /users/@me/sessions answers 204). */
export function emptyResponse(status = 204): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => ({}),
    text: async () => '',
  } as unknown as Response;
}

/** The wire's `@me` envelope drift: the client types it flat, the server wraps. */
export function userEnvelope(user: CurrentUser): { user: CurrentUser } {
  return { user };
}

export const USER: CurrentUser = {
  id: '9001',
  username: 'jordan',
  display_name: 'Jordan',
  email: 'j@example.com',
  email_verified: true,
  email_verified_at: '2026-01-01T00:00:00.000Z',
  avatar_url: null,
  created_at: '2026-01-01T00:00:00.000Z',
};

export const SEEDED_PAIR: StoredTokenPair = {
  accessToken: 'access-token-1',
  refreshToken: 'refresh-token-1',
};

export interface SettingsHarness {
  services: SettingsServices;
  session: ReturnType<typeof createSessionManager>;
  storage: ReturnType<typeof createMemoryTokenStorage>;
  store: ReturnType<typeof createStateStore>;
  calls: RecordedRequest[];
}

/**
 * Build the settings surface's services over a real session manager (memory
 * storage) and a real api client whose transport is stubbed. `seed` persists a
 * token pair through the manager's auth store, so a test can prove sign-out
 * clears the injected adapter rather than an in-memory field.
 */
export function buildSettingsHarness(
  handler: StubHandler,
  options: { seed?: StoredTokenPair; user?: CurrentUser } = {},
): SettingsHarness {
  const storage = createMemoryTokenStorage();
  const store = createStateStore();
  const session = createSessionManager({ storage, store });
  const { calls, fetchImpl } = createStubTransport(handler);

  const api = new CytaleApiClient({
    baseUrl: 'http://test.local/api/v1',
    fetchImpl,
    tokens: {
      getAccessToken: async () => session.authStore.getState().getAccessToken(),
      getRefreshToken: async () => session.authStore.getState().getRefreshToken(),
      updateTokens: async (access, refresh) =>
        session.authStore.getState().updateTokens(access, refresh, 900),
    },
  });

  if (options.seed) {
    session.authStore.getState().updateTokens(
      options.seed.accessToken ?? '',
      options.seed.refreshToken ?? '',
      900,
    );
  }
  if (options.user) {
    session.authStore.getState().setUser(options.user);
    session.authStore.getState().setStatus('authenticated');
  }

  return {
    services: createSettingsServices(session, { api, store }),
    session,
    storage,
    store,
    calls,
  };
}

/** Seed the roster row the profile save must converge. */
export function seedRoster(store: ReturnType<typeof createStateStore>, id: string, username: string): void {
  store.setState({
    membersById: {
      [id]: {
        id,
        username,
        nickname: null,
        joined_at: '2026-01-01T00:00:00.000Z',
        roles: [],
      },
    },
  });
}
