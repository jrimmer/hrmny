/**
 * Session provider tests (plan 004 M5 integration requirement).
 *
 * M4 delivered `createSessionManager` + the secure-store `TokenStorage`; M5
 * owns instantiating it once in the root layout, restoring on launch, and
 * exposing it to screens. These tests inject a memory-storage manager (the
 * documented seam) instead of mocking expo-secure-store globally — the
 * adapter's own round-trip is already covered by `src/session/__tests__`.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';

import type { CurrentUser } from '@cytale/api-client';
import type { GatewaySocketLike } from '@cytale/gateway-client';
import type { GatewayEvent } from '@cytale/protocol';
import { createMemoryTokenStorage, createSessionManager, type SessionManager } from '@cytale/session';
import { applyGatewayEvent } from '@cytale/state';

import { SurfaceScaffold } from '../SurfaceScaffold';
import { getSurfaceStates, resetSurfaceStates, useSurfaceStates } from '../shellState';
import {
  SessionProvider,
  buildTimeOrigin,
  createTrackedGatewayClient,
  getGatewayConnectivity,
  getSessionManager,
  resetGatewayConnectivity,
  resolveBuildTimeOrigin,
  useAuthStatus,
  useSession,
  useSessionRestored,
} from '../session';
import { defaultStore } from '../store';
import { press, resetShellStore, seedShellStore } from './support';

function Probe() {
  const session = useSession();
  const status = useAuthStatus();
  const restored = useSessionRestored();
  return (
    <Text testID="probe">{`${session.constructor.name}|${status}|${String(restored)}`}</Text>
  );
}

/** The shell's offline/view-only states as a surface would see them (R15). */
function SurfaceProbe() {
  const shared = useSurfaceStates();
  return (
    <Text testID="surface-probe">
      {`offline:${String(shared.offline ?? false)}|viewOnly:${String(shared.viewOnly ?? false)}`}
    </Text>
  );
}

function buildManager() {
  // The test runtime is native-shaped (no `location`), so the origin must be
  // supplied — the manager refuses to guess a host.
  return createSessionManager({
    storage: createMemoryTokenStorage(),
    resolveOrigin: () => 'http://127.0.0.1:4001',
  });
}

const VERIFIED_USER: CurrentUser = {
  id: '900000000000000001',
  username: 'rowan',
  display_name: 'Rowan',
  email: 'rowan@example.com',
  email_verified: true,
  email_verified_at: '2026-01-01T00:00:00.000Z',
  avatar_url: null,
  created_at: '2026-01-01T00:00:00.000Z',
};

const UNVERIFIED_USER: CurrentUser = {
  ...VERIFIED_USER,
  email_verified: false,
  email_verified_at: null,
};

/** A socket that never completes the handshake — the client owns the state. */
function fakeSocket(): GatewaySocketLike {
  return {
    send: jest.fn(),
    close: jest.fn(),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
}

/** A JSON `Response` shaped the way the api-client's Http layer reads one. */
function jsonResponse(body: unknown, status = 200): Response {
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

describe('SessionProvider', () => {
  it('restores once on launch and exposes the manager to the tree', async () => {
    const manager = buildManager();
    const restore = jest.spyOn(manager, 'restore');

    await render(
      <SessionProvider manager={manager}>
        <Probe />
      </SessionProvider>,
    );

    expect(restore).toHaveBeenCalledTimes(1);
    // No persisted pair → the manager lands on the renderable
    // unauthenticated state rather than hanging in `loading`.
    await waitFor(() =>
      expect(screen.getByTestId('probe')).toHaveTextContent('SessionManager|unauthenticated|true'),
    );
  });

  it('keeps one manager instance across re-renders', async () => {
    const manager = buildManager();
    const restore = jest.spyOn(manager, 'restore');
    const seen: unknown[] = [];
    function Capture() {
      seen.push(useSession());
      return <Text testID="capture">ok</Text>;
    }

    const result = await render(
      <SessionProvider manager={manager}>
        <Capture />
      </SessionProvider>,
    );
    await result.rerender(
      <SessionProvider manager={manager}>
        <Capture />
      </SessionProvider>,
    );

    expect(restore).toHaveBeenCalledTimes(1);
    expect(new Set(seen).size).toBe(1);
  });

  it('throws a wiring error when a screen reads the session outside the provider', async () => {
    // React logs the render error; keep the test output focused on the throw.
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(render(<Probe />)).rejects.toThrow(/outside <SessionProvider>/);
    spy.mockRestore();
  });
});

describe('build-time origin validation', () => {
  const originalEnv = process.env.EXPO_PUBLIC_CYTALE_ORIGIN;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.EXPO_PUBLIC_CYTALE_ORIGIN;
    else process.env.EXPO_PUBLIC_CYTALE_ORIGIN = originalEnv;
    jest.restoreAllMocks();
  });

  it('accepts an https origin verbatim', () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(resolveBuildTimeOrigin('https://chat.example.com', false)).toBe('https://chat.example.com');
    expect(resolveBuildTimeOrigin('https://chat.example.com', true)).toBe('https://chat.example.com');
    expect(error).not.toHaveBeenCalled();
  });

  it('accepts loopback http in development only', () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(resolveBuildTimeOrigin('http://localhost:4000', true)).toBe('http://localhost:4000');
    expect(resolveBuildTimeOrigin('http://127.0.0.1:4000', true)).toBe('http://127.0.0.1:4000');

    // Release: refusing beats deriving a cleartext ws:// gateway from it.
    expect(resolveBuildTimeOrigin('http://localhost:4000', false)).toBeUndefined();
    expect(error).toHaveBeenCalled();
  });

  it('refuses anything that would downgrade the transport', () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    for (const raw of [
      'http://chat.example.com', // cleartext to a real host
      'ws://chat.example.com', // the session package maps non-https to ws://
      'wss://chat.example.com', // …which would downgrade a secure origin
      'chat.example.com', // not absolute — no scheme at all
      'not a url',
    ]) {
      expect(resolveBuildTimeOrigin(raw, true)).toBeUndefined();
      expect(resolveBuildTimeOrigin(raw, false)).toBeUndefined();
    }
    expect(error).toHaveBeenCalledTimes(10);
    // The note names the variable and the refused value, so the misconfigured
    // build is diagnosable from a device log.
    expect(error).toHaveBeenCalledWith(expect.stringContaining('EXPO_PUBLIC_CYTALE_ORIGIN'));
  });

  it('treats an unset or blank origin as absent, not as a failure', () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(resolveBuildTimeOrigin(undefined, false)).toBeUndefined();
    expect(resolveBuildTimeOrigin('', false)).toBeUndefined();
    expect(resolveBuildTimeOrigin('   ', true)).toBeUndefined();
    // The platform default (web same-origin) is a supported configuration.
    expect(error).not.toHaveBeenCalled();
  });

  it('reads the Expo-inlined variable and trims it', () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    process.env.EXPO_PUBLIC_CYTALE_ORIGIN = ' https://chat.example.com ';
    expect(buildTimeOrigin()).toBe('https://chat.example.com');

    // __DEV__ is true under jest, so the loopback exception applies here too.
    process.env.EXPO_PUBLIC_CYTALE_ORIGIN = 'http://localhost:4000';
    expect(buildTimeOrigin()).toBe('http://localhost:4000');

    process.env.EXPO_PUBLIC_CYTALE_ORIGIN = 'http://chat.example.com';
    expect(buildTimeOrigin()).toBeUndefined();
    expect(error).toHaveBeenCalled();
  });
});

describe('session manager registry', () => {
  it('publishes the live manager to non-React callers while mounted', async () => {
    expect(getSessionManager()).toBeNull();

    const manager = buildManager();
    const rendered = await render(
      <SessionProvider manager={manager}>
        <Probe />
      </SessionProvider>,
    );
    await waitFor(() => expect(getSessionManager()).toBe(manager));

    // RNTL v14's unmount is async (it wraps its own act).
    await rendered.unmount();
    expect(getSessionManager()).toBeNull();
  });
});

describe('shell surface-state producers (R15)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // Reset between tests, while no tree is mounted (the previous test's
    // RNTL cleanup has already run) — writing shell state under a live tree
    // outside act would warn. Connectivity is module-level too.
    resetGatewayConnectivity();
    resetSurfaceStates();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('flips offline from the live gateway connection state', async () => {
    const storage = createMemoryTokenStorage({ accessToken: 'access-1', refreshToken: 'refresh-1' });
    globalThis.fetch = jest.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) {
        return jsonResponse({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 900 });
      }
      if (url.includes('/users/@me')) return jsonResponse({ user: VERIFIED_USER });
      return jsonResponse({}, 404);
    }) as unknown as typeof fetch;

    // The provider's own manager, built through the tracked factory the
    // provider uses: restore() authenticates and opens the gateway.
    const manager = createSessionManager({
      storage,
      resolveOrigin: () => 'http://127.0.0.1:4001',
      createGatewayClient: (options) =>
        createTrackedGatewayClient({ ...options, socketFactory: () => fakeSocket() }),
    });

    await render(
      <SessionProvider manager={manager}>
        <SurfaceProbe />
      </SessionProvider>,
    );
    await waitFor(() => expect(getSessionManager()).toBe(manager));
    await waitFor(() => expect(manager.getGateway()).not.toBeNull());
    expect(screen.getByTestId('surface-probe')).toHaveTextContent('offline:false|viewOnly:false');

    // The handshake never settles against the fake socket, so a client-side
    // drop is the observable offline transition (the banner's real trigger).
    await act(async () => {
      manager.getGateway()?.disconnect();
    });

    expect(getGatewayConnectivity()).toBe('offline');
    expect(screen.getByTestId('surface-probe')).toHaveTextContent('offline:true|viewOnly:false');

    // Signing out destroys the gateway: the banner must not survive on the
    // login screen (offline is only meaningful for a signed-in client).
    await act(async () => {
      await manager.logout();
    });
    expect(screen.getByTestId('surface-probe')).toHaveTextContent('offline:false|viewOnly:false');
  });

  it('flips view-only from the account email verification', async () => {
    const manager = buildManager();
    await render(
      <SessionProvider manager={manager}>
        <SurfaceProbe />
      </SessionProvider>,
    );
    expect(screen.getByTestId('surface-probe')).toHaveTextContent('offline:false|viewOnly:false');

    // Register → view-only until verification (web's `!emailVerified`).
    await act(async () => {
      manager.authStore.getState().setUser(UNVERIFIED_USER);
      manager.authStore.getState().setStatus('authenticated');
    });
    expect(screen.getByTestId('surface-probe')).toHaveTextContent('offline:false|viewOnly:true');

    await act(async () => {
      manager.authStore.getState().setVerified(true);
    });
    expect(screen.getByTestId('surface-probe')).toHaveTextContent('offline:false|viewOnly:false');
  });
});

describe('REST bootstrap (StoreHydrator, R15 error state)', () => {
  beforeEach(() => {
    resetShellStore();
    resetSurfaceStates();
  });

  afterEach(async () => {
    // The tree is still mounted here (RNTL's own cleanup runs later), so the
    // reset has to flush inside act rather than warn.
    await act(async () => {
      resetSurfaceStates();
    });
    // Unmount NOW rather than in RNTL's async auto-cleanup: these tests move
    // the store's `sessionEpoch` (the READY case), and a tree left mounted
    // from the previous test would hydrate — outside act — when the next test
    // bumps it.
    await cleanup();
    resetShellStore();
    jest.restoreAllMocks();
  });

  /** A surface with nothing but the shell's frame — the real error render. */
  function BootstrapSurface() {
    return <SurfaceScaffold testID="surface-home" title="Home" />;
  }

  async function renderAuthenticated(manager: SessionManager): Promise<void> {
    await render(
      <SessionProvider manager={manager}>
        <BootstrapSurface />
      </SessionProvider>,
    );
    await act(async () => {
      manager.authStore.getState().setStatus('authenticated');
    });
  }

  it('surfaces a failed bootstrap and retries it to a cleared state', async () => {
    const manager = buildManager();
    const listWorkspaces = jest
      .spyOn(manager.api, 'listWorkspaces')
      .mockRejectedValueOnce(new Error('workspaces unavailable'))
      .mockResolvedValue({ items: [], cursor: { before: null, after: null, limit: 0 } });

    await renderAuthenticated(manager);

    // The failure is visible on the surface, not swallowed into an empty
    // drawer: the shell's error state renders with the producer's retry.
    await waitFor(() => expect(screen.getByTestId('surface-error')).toBeTruthy());
    expect(screen.getByText('Could not load your workspaces.')).toBeTruthy();
    expect(listWorkspaces).toHaveBeenCalledTimes(1);

    // The retry re-runs the bootstrap and the error clears on success.
    await press(screen.getByTestId('surface-error-retry'));
    await waitFor(() => expect(screen.queryByTestId('surface-error')).toBeNull());
    expect(listWorkspaces).toHaveBeenCalledTimes(2);
    expect(getSurfaceStates().hydrationError).toBeNull();
    expect(getSurfaceStates().retryHydration).toBeNull();
  });

  it('clears the bootstrap error when the session ends', async () => {
    const manager = buildManager();
    jest.spyOn(manager.api, 'listWorkspaces').mockRejectedValue(new Error('workspaces unavailable'));

    await renderAuthenticated(manager);
    await waitFor(() => expect(screen.getByTestId('surface-error')).toBeTruthy());

    await act(async () => {
      manager.authStore.getState().setStatus('unauthenticated');
    });

    await waitFor(() => expect(screen.queryByTestId('surface-error')).toBeNull());
  });

  it('does not touch the REST fan-out when the shell already holds the graph', async () => {
    seedShellStore();
    const manager = buildManager();
    const listWorkspaces = jest.spyOn(manager.api, 'listWorkspaces');

    await renderAuthenticated(manager);
    await act(async () => {});

    // `hydrateStore`'s reconnect guard: the shell already renders this graph,
    // so the bootstrap costs nothing (and publishes no failure state).
    expect(listWorkspaces).not.toHaveBeenCalled();
    expect(screen.queryByTestId('surface-error')).toBeNull();
    expect(getSurfaceStates().hydrationError).toBeNull();
  });

  it('re-hydrates after a fresh gateway READY, because the reset empties the graph', async () => {
    const manager = buildManager();
    const listWorkspaces = jest
      .spyOn(manager.api, 'listWorkspaces')
      .mockResolvedValue({ items: [], cursor: { before: null, after: null, limit: 0 } });

    await renderAuthenticated(manager);
    await waitFor(() => expect(listWorkspaces).toHaveBeenCalledTimes(1));

    // Cross-package residual, pinned here so it cannot regress silently:
    // a reconnect that re-identifies dispatches READY, and the state
    // package's `resetStoreTransient` empties workspaces/channels in the SAME
    // dispatch that bumps `sessionEpoch`. The epoch effect therefore re-runs
    // against an EMPTY store, so the guard above cannot fire and the launch
    // fan-out repeats (now 1 + 2×W requests instead of 1 + Σ(2 + C)).
    await act(async () => {
      applyGatewayEvent(defaultStore, {
        op: 0,
        t: 'Ready',
        s: 99,
        d: {
          v: 1,
          session_id: 'sess-2',
          resume_token: 'rt-2',
          heartbeat_interval: 41250,
          user: { id: '900000000000000001', username: 'rowan' },
        },
      } as unknown as GatewayEvent);
    });

    await waitFor(() => expect(listWorkspaces).toHaveBeenCalledTimes(2));
    // Let the re-fetch settle inside act: the epoch is marked on success.
    await act(async () => {});
  });
});
