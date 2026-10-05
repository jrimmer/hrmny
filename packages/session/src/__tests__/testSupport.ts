/**
 * @cytale/session — test support (plan 004 M4).
 *
 * A fetch router mirroring the web U19 harness (documented /api/v1/auth
 * contract in docs/protocol/rest.md) plus a gateway factory that captures the
 * options the SessionManager builds — so the tests can drive the
 * re-Identify/tokenProvider path without real sockets.
 */

import { vi } from 'vitest';

import type { GatewayClient, GatewayClientOptions } from '@cytale/gateway-client';

export const TOKENS = {
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  expires_in: 900,
  token_type: 'Bearer',
};

export const REFRESHED = {
  access_token: 'access-2',
  refresh_token: 'refresh-2',
  expires_in: 900,
};

export const USER = {
  id: '123',
  username: 'tester',
  email: 'tester@example.com',
  email_verified_at: null,
};

export interface Route {
  match: (url: string, init: RequestInit) => boolean;
  /** Sync by default; may return a promise to hold a call open (race tests). */
  respond: () => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;
}

export interface FetchHarness {
  routes: Route[];
  /** Every fetch call, in order (url + init). */
  calls: Array<{ url: string; init: RequestInit }>;
  /** Count calls whose URL ends with `suffix`. */
  count: (suffix: string) => number;
}

export function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
  } as unknown as Response;
}

/** Install a routed fetch mock on globalThis; returns the log + helpers. */
export function installFetch(routes: Route[]): FetchHarness {
  const calls: FetchHarness['calls'] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, init });
      for (const route of routes) {
        if (route.match(url, init)) {
          const r = await route.respond();
          return jsonResponse(r.status, r.body);
        }
      }
      return jsonResponse(404, { error: { key: 'not_found', code: 40404, message: 'no route' } });
    }),
  );
  return {
    routes,
    calls,
    count: (suffix) => calls.filter((c) => c.url.endsWith(suffix)).length,
  };
}

/** The documented auth contract, with the login/refresh responses overridable. */
export function authRoutes(options: {
  login?: () => { status: number; body: unknown };
  refresh?: () => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;
} = {}): Route[] {
  return [
    {
      match: (url) => url.endsWith('/auth/login'),
      respond: options.login ?? (() => ({ status: 200, body: TOKENS })),
    },
    {
      match: (url) => url.endsWith('/users/@me'),
      respond: () => ({ status: 200, body: { user: USER } }),
    },
    {
      match: (url) => url.endsWith('/auth/refresh'),
      respond: options.refresh ?? (() => ({ status: 200, body: REFRESHED })),
    },
    {
      match: (url) => url.endsWith('/auth/logout'),
      respond: () => ({ status: 200, body: { logged_out: true } }),
    },
  ];
}

export interface CapturedGateway {
  options: GatewayClientOptions;
  connects: number;
  disconnects: number;
  destroys: number;
  /** Every onAny handler the SessionManager registered. */
  handlers: Array<(event: unknown) => void>;
  /** Deliver one dispatch frame to those handlers (test-side dispatch). */
  emit: (event: unknown) => void;
}

/**
 * A gateway factory that records the options (so tests can invoke the
 * tokenProvider directly), captures the dispatch handler (so tests can emit
 * frames), and never opens a socket.
 */
export function fakeGatewayFactory(records: CapturedGateway[]): (options: GatewayClientOptions) => GatewayClient {
  return (options: GatewayClientOptions) => {
    const handlers: CapturedGateway['handlers'] = [];
    const record: CapturedGateway = {
      options,
      connects: 0,
      disconnects: 0,
      destroys: 0,
      handlers,
      emit: (event: unknown) => {
        for (const handler of [...handlers]) handler(event);
      },
    };
    records.push(record);
    const fake = {
      onAny: (handler: (event: unknown) => void) => {
        handlers.push(handler);
        return () => {
          const i = handlers.indexOf(handler);
          if (i >= 0) handlers.splice(i, 1);
        };
      },
      connect: async () => {
        record.connects += 1;
      },
      disconnect: () => {
        record.disconnects += 1;
      },
      destroy: () => {
        record.destroys += 1;
      },
    };
    return fake as unknown as GatewayClient;
  };
}
