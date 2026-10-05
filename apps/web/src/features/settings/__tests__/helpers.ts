/**
 * @cytale/web — integrations test helpers (U13).
 *
 * A tiny fetch router matching the api-client test style: routes keyed
 * `METHOD /api/v1/pathname`, every call recorded with its parsed JSON body
 * so payload-correctness assertions are first-class. Plus clipboard
 * stubbing for the copy affordances.
 */
import { vi } from 'vitest';

type RouteHandler = (init?: RequestInit) => Response | Promise<Response>;

export interface RecordedCall {
  method: string;
  pathname: string;
  body?: unknown;
}

export function createFetchRouter() {
  const calls: RecordedCall[] = [];
  const routes = new Map<string, RouteHandler>();

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown;
    try {
      body = init?.body != null ? JSON.parse(String(init.body)) : undefined;
    } catch {
      body = undefined;
    }
    calls.push({ method, pathname: new URL(url).pathname, body });
    const handler = routes.get(`${method} ${new URL(url).pathname}`);
    if (!handler) {
      return Response.json(
        { error: { key: 'no_route', code: 40404, message: `unrouted ${method} ${url}` } },
        { status: 404 },
      );
    }
    return await handler(init);
  });

  return {
    fetchMock,
    calls,
    on(method: string, path: string, handler: RouteHandler) {
      routes.set(`${method} ${path}`, handler);
    },
    /** Routes recorded so far for one pathname, in order. */
    recorded(pathname: string): RecordedCall[] {
      return calls.filter((c) => c.pathname === pathname);
    },
  };
}

export type FetchRouter = ReturnType<typeof createFetchRouter>;

/** jsdom ships no navigator.clipboard; give Copy buttons something to hit. */
export function stubClipboard(): { writeText: ReturnType<typeof vi.fn> } {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
  return { writeText };
}

/** Force useOnlineStatus()'s initial read to offline. */
export function goOffline(): void {
  Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
}

/** Restore the online default after goOffline(). */
export function goOnline(): void {
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
}

// -- fixtures -----------------------------------------------------------------

export const WS = '9007199254740993';
export const CHANNEL_GENERAL = '910000000000000001';
export const CHANNEL_RANDOM = '910000000000000002';

export const CHANNELS = [
  { id: CHANNEL_GENERAL, name: 'general' },
  { id: CHANNEL_RANDOM, name: 'random' },
];

/**
 * The all-none access document the server reports for an agent that has never
 * been granted anything — the shape every machine principal starts at (R6).
 */
export const ACCESS_NONE = {
  v: 1,
  server: 'read' as const,
  account: { agent: 'read' as const },
  dms: 'none' as const,
  workspaces: { mode: 'none' as const, level: null, grants: {} },
};

/** A granted document: one workspace at read_write (the tree's edit target). */
export const ACCESS_GRANTED = {
  ...ACCESS_NONE,
  workspaces: {
    mode: 'custom' as const,
    level: null,
    grants: { [WS]: { level: 'read_write' as const, channels: {} } },
  },
};

/** The workspaces the tree may grant: the caller's own (R5). */
export const WORKSPACES = [
  { id: WS, name: 'Cytale' },
  { id: '9007199254740994', name: 'Playground' },
];

/** A machine credential the caller owns (one kind internally: `bot`). */
export const BOT_ROW = {
  id: '930000000000000001',
  name: 'CI runner',
  /** The tag (unique per server) — the @handle under the display name. */
  username: 'ci-runner',
  avatar_url: null,
  kind: 'bot' as const,
  created_at: '2026-09-01T00:00:00Z',
  restrictions: null,
  access: ACCESS_NONE,
};

export const WEBHOOK_ROW = {
  id: '940000000000000001',
  name: 'CI hook',
  channel_id: CHANNEL_GENERAL,
  url: `http://localhost/api/webhooks/940000000000000001/whsec_example`,
};
