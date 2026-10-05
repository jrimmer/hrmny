/**
 * @cytale/mobile — session manager provided to the navigation shell (plan 004
 * M5; M4 delivered the machinery).
 *
 * The root layout instantiates ONE `SessionManager` (from `@cytale/session`,
 * with M4's expo-secure-store-backed `TokenStorage`), calls `restore()` on
 * launch (R5: a cold start with valid credentials never shows a login screen),
 * and exposes it here so later screens (M9 auth, M10 settings, M7 uploads)
 * take the same instance instead of building their own. No session logic
 * lives in this file — it is wiring and a React binding, nothing more.
 *
 * Tests inject a manager built on `createMemoryTokenStorage()` through the
 * `manager` prop; the production path is the `secureTokenStorage` adapter
 * (`src/session/secureStorage.ts`, the only expo-secure-store import).
 *
 * The provider is also where the shell's R15 producers live, because both are
 * app-wide truths no single surface can see:
 *   * `offline` — the gateway's connection state. The manager builds its
 *     client through `createTrackedGatewayClient`, which publishes every
 *     lifecycle transition into the connectivity store below.
 *   * `viewOnly` — an authenticated account that has not verified its email
 *     (web's `viewOnly={!authState.emailVerified}`). `permissionDenied` has
 *     no producer yet: the store hydrates no roles or channel overwrites and
 *     the wire carries no resolved-permission read (see the note on
 *     `setSurfaceStates` in shellState.ts).
 */
import './bootstrap';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import {
  GatewayClient,
  type ConnectionState,
  type GatewayClientOptions,
  type ZstdWasmLoader,
} from '@cytale/gateway-client';
import {
  createSessionManager,
  type AuthState,
  type AuthStatus,
  type SessionManager,
} from '@cytale/session';

import { mobileZstdWasmLoader } from '../gateway/zstd';
import { applyReactionEvent } from '../messages/reactions';
import { routeCallSignalEvent } from '@cytale/calls';
import {
  clientErrors,
  setClientErrorGateway,
  setClientErrorSender,
} from '../observability/clientErrors';
import { secureTokenStorage } from '../session/secureStorage';
import { hydrateStore } from './hydrate';
import { readServerOrigin } from '../auth/serverOrigin';
import { setSurfaceStates } from './shellState';
import { defaultStore, useStoreSelector } from './store';

export interface SessionProviderProps {
  children: ReactNode;
  /**
   * Test seam: a pre-built manager (e.g. memory storage, stub gateway).
   * Production omits it and gets the secure-store-backed manager.
   */
  manager?: SessionManager;
  /**
   * Build-time server origin. Defaults to `EXPO_PUBLIC_CYTALE_ORIGIN`, which
   * Expo inlines at bundle time — so a dev/e2e build points at its own server
   * (`EXPO_PUBLIC_CYTALE_ORIGIN=http://localhost:4000`) without a code change,
   * and a store build carries its real origin. Validated by
   * `buildTimeOrigin`: a non-https (or, outside development, non-loopback)
   * value is refused and undefined is passed on, which leaves the package's
   * platform default — only correct on web, and the reason the refusal is
   * loud.
   */
  resolveOrigin?: () => string | undefined;
}

const SessionContext = createContext<SessionManager | null>(null);

/**
 * The build-time server origin Expo inlines into the bundle. Undefined in a
 * build that did not set `EXPO_PUBLIC_CYTALE_ORIGIN`.
 *
 * VALIDATED, not passed through. The transport is derived from this string
 * downstream and the derivation is not scheme-safe: `@cytale/session`'s
 * `#gatewayUrl` turns any origin whose protocol is not `https:` into a
 * CLEARTEXT `ws://` gateway, and the refresh exchange posts the refresh token
 * over plain `http://` on the same origin (packages/session/src/session.ts —
 * not this file's to change). An unset or junk `EXPO_PUBLIC_CYTALE_ORIGIN`
 * must therefore fail loudly rather than silently downgrade the transport.
 *
 * `resolveBuildTimeOrigin` is the rule, as a pure function so it can be
 * tested without touching `process.env` or the `__DEV__` global:
 *   * `https:` — always accepted;
 *   * `http://localhost` / `http://127.0.0.1` — development builds only (the
 *     local server the e2e harness runs against);
 *   * everything else (`http://` to a real host, `ws://`/`wss://`, a bare
 *     hostname, a path-only string) — refused with a console error.
 *
 * A refused origin returns `undefined`, which leaves the session package's
 * platform default in place. On web that is `location.origin` (same-origin,
 * so https in a release). On NATIVE there is no default: the package refuses
 * to guess a host and throws naming `resolveOrigin`
 * (`packages/session/src/session.ts`), so an unconfigured native build fails
 * at the first connect instead of dialling its own loopback.
 */
export function resolveBuildTimeOrigin(raw: string | undefined, dev: boolean): string | undefined {
  const origin = raw?.trim();
  if (origin === undefined || origin === '') return undefined;

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return refuseBuildTimeOrigin(origin, 'it is not an absolute URL');
  }

  if (url.protocol === 'https:') return origin;

  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (dev && url.protocol === 'http:' && loopback) return origin;

  return refuseBuildTimeOrigin(
    origin,
    dev
      ? 'only https:// (plus http://localhost or http://127.0.0.1 in development) is accepted'
      : 'only https:// is accepted in a release build',
  );
}

/** Loudly drop a misconfigured origin (a silent downgrade is the bug). */
function refuseBuildTimeOrigin(origin: string, reason: string): undefined {
  console.error(
    `[session] ignoring EXPO_PUBLIC_CYTALE_ORIGIN="${origin}": ${reason}. ` +
      'Refusing to derive a cleartext gateway from it — fix the build.',
  );
  return undefined;
}

/** The validated build-time origin (`EXPO_PUBLIC_CYTALE_ORIGIN`). */
export function buildTimeOrigin(): string | undefined {
  return resolveBuildTimeOrigin(process.env.EXPO_PUBLIC_CYTALE_ORIGIN, __DEV__);
}

/** True once the cold-launch restore has settled (success or failure). */
const SessionRestoredContext = createContext(false);

/**
 * The live manager for non-React callers. `SessionProvider` registers it on
 * mount and clears it on unmount; it is null before the provider mounts and
 * in tests that render without one, which is exactly the "no gateway" case
 * (`useChannelWindow`'s default ack sender, web's `session.getGateway()`).
 */
let registeredManager: SessionManager | null = null;

/**
 * The login form's server choice for THIS launch (persisted across launches
 * via serverOrigin storage; the provider re-applies the persisted value
 * before a restored session connects). Consulted ahead of the build-time
 * origin by the provider's resolveOrigin.
 */
let originOverride: string | undefined;

export function applyServerOriginOverride(origin: string): void {
  originOverride = origin;
}

/** The server the session currently dials (login-form choice or baked). */
export function currentServerOrigin(): string | undefined {
  return originOverride ?? buildTimeOrigin();
}

/**
 * Origin-resolved asset URL — mirrors web's `assetUrl` contract exactly:
 * null/empty → undefined, absolute or scheme-relative paths pass through,
 * server-relative paths (`/…`) get the current origin prefixed.
 */
export function serverAssetUrl(path: string | null | undefined): string | undefined {
  if (typeof path !== 'string' || path === '') return undefined;
  if (!path.startsWith('/')) return path;
  const origin = currentServerOrigin();
  return origin ? `${origin}${path}` : undefined;
}

/** The app's session manager, or null outside a mounted provider. */
export function getSessionManager(): SessionManager | null {
  return registeredManager;
}

// ---------------------------------------------------------------------------
// Gateway connectivity (R15 `offline`)
// ---------------------------------------------------------------------------

/**
 * Gateway connectivity as the shell's `offline` state sees it. `unknown` is
 * the honest third value: no gateway yet (signed out), or the first handshake
 * in progress — neither is a failure, and the banner must not flash on launch.
 */
export type GatewayConnectivity = 'unknown' | 'online' | 'offline';

let connectivity: GatewayConnectivity = 'unknown';
const connectivityListeners = new Set<() => void>();

function publishConnectivity(next: GatewayConnectivity): void {
  if (connectivity === next) return;
  connectivity = next;
  for (const listener of connectivityListeners) listener();
}

/**
 * Map the gateway's lifecycle (U15 state machine) onto connectivity. A drop
 * (`disconnected`/`reconnecting`) and a terminal client (`dead`) are offline;
 * an active pipe (`connected`/`ready`) is online; everything else — including
 * `resuming` after a drop — waits for the handshake to settle rather than
 * claiming a state it has not reached.
 */
function connectivityOf(state: ConnectionState): GatewayConnectivity {
  if (state === 'connected' || state === 'ready') return 'online';
  if (state === 'disconnected' || state === 'reconnecting' || state === 'dead') return 'offline';
  return 'unknown';
}

/** Read the current connectivity (non-React callers). */
export function getGatewayConnectivity(): GatewayConnectivity {
  return connectivity;
}

/** Drop connectivity back to `unknown` (test hygiene: the store is module-level). */
export function resetGatewayConnectivity(): void {
  publishConnectivity('unknown');
}

/** Reactive gateway connectivity. */
export function useGatewayConnectivity(): GatewayConnectivity {
  return useSyncExternalStore(
    (listener) => {
      connectivityListeners.add(listener);
      return () => connectivityListeners.delete(listener);
    },
    getGatewayConnectivity,
    getGatewayConnectivity,
  );
}

/**
 * Gateway factory wired to the connectivity store — the SessionProvider
 * passes it as `createGatewayClient`, so the shell learns every transition of
 * the one live client. Exported so tests can build a manager whose fake
 * socket drives the same store (the offline producer's seam).
 *
 * `deps.zstdLoader` defaults to the app's fzstd-backed decode path: Hermes has
 * no `DecompressionStream`, so without it the handshake negotiates `none`
 * (KD4's fallback) and gateway frames stay uncompressed. A caller-supplied
 * `options.zstdWasmLoader` wins; an explicit `{ zstdLoader: undefined }` models
 * a runtime with no decode path and must leave the socket fully functional.
 */
export function createTrackedGatewayClient(
  options: GatewayClientOptions,
  deps: { zstdLoader?: ZstdWasmLoader } = { zstdLoader: mobileZstdWasmLoader },
): GatewayClient {
  const zstdWasmLoader = options.zstdWasmLoader ?? deps.zstdLoader;
  return new GatewayClient({
    ...options,
    ...(zstdWasmLoader === undefined ? {} : { zstdWasmLoader }),
    onStateChange: (change) => {
      publishConnectivity(connectivityOf(change.to));
      options.onStateChange?.(change);
    },
  });
}

/** Select one auth-store slice, reactively. */
function useAuthSelector<T>(manager: SessionManager, select: (state: AuthState) => T): T {
  const store = manager.authStore;
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => select(store.getState()),
    () => select(store.getState()),
  );
}

/**
 * Fetches the workspace/channel/member/thread graph once per gateway session
 * (the REST bootstrap the web app runs in AuthenticatedApp). The gateway's
 * `Ready` carries only the user, so without this the shell renders empty.
 *
 * A failed bootstrap is visible and retryable (code-review residual 3). The
 * epoch is marked only AFTER a successful fetch, so a failure never counts as
 * hydrated and the retry can run again; a failure that leaves the store with
 * no workspaces at all publishes `hydrationError` + `retryHydration` (a
 * drawer with "No channels yet" and no explanation is the bug being fixed),
 * rendered by the drawer and by the surfaces that take the shared states
 * verbatim. It is NOT the per-surface `error`: settings does not need the
 * workspace graph and must not be blanked by its absence.
 *
 * With `hydrateStore`'s store guard, the only reachable rejection is the one
 * that finds no workspaces (the guard skips the workspace leg entirely when
 * the store holds a graph), so the "still holds workspaces" check below is
 * belt-and-braces — it keeps the producer honest if a future caller hydrates
 * without the guard. A failure there stays silent: the shell is usable and
 * must not be blanked, and the next gateway session retries it.
 */
function StoreHydrator({ manager }: { manager: SessionManager }) {
  const status = useAuthSelector(manager, (state) => state.status);
  const epoch = useStoreSelector(defaultStore, (state) => state.sessionEpoch);
  const hydratedEpoch = useRef<number | null>(null);
  /** Bumped by the error state's Retry to re-run a failed bootstrap. */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (status !== 'authenticated') {
      // The bootstrap error belongs to the session that produced it.
      hydratedEpoch.current = null;
      setSurfaceStates({ hydrationError: null, retryHydration: null });
      return;
    }
    if (hydratedEpoch.current === epoch) return;

    let cancelled = false;
    void hydrateStore(manager.api, defaultStore).then(
      () => {
        if (cancelled) return;
        // Only a success marks the epoch: a failure stays retryable.
        hydratedEpoch.current = epoch;
        setSurfaceStates({ hydrationError: null, retryHydration: null });
      },
      () => {
        if (cancelled) return;
        // Nothing to render → surface it. A shell that still holds workspaces
        // renders fine, so a failed refresh there is not a user-facing error.
        if (Object.keys(defaultStore.getState().workspaces).length > 0) return;
        setSurfaceStates({
          hydrationError: HYDRATION_FAILED_MESSAGE,
          retryHydration: () => setAttempt((n) => n + 1),
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt, epoch, manager, status]);

  return null;
}

/**
 * Web's fallback copy, and the only thing the shell renders: a raw transport
 * message ("no route", "Network request failed") is not user-facing copy.
 */
const HYDRATION_FAILED_MESSAGE = 'Could not load your workspaces.';

/**
 * Writes the shell's `offline` / `viewOnly` states from their real sources.
 * One producer for the app: the states are global, and every surface already
 * reads them through `useSurfaceStates` (the composer and the scaffold).
 */
function ShellSurfaceStateProducer({ manager }: { manager: SessionManager }) {
  const connectivity = useGatewayConnectivity();
  const status = useAuthSelector(manager, (state) => state.status);
  const user = useAuthSelector(manager, (state) => state.currentUser);
  const emailVerified = useAuthSelector(manager, (state) => state.emailVerified);

  useEffect(() => {
    // Only a signed-in client can be "offline": signing out destroys the
    // gateway, and that must not leave the banner on the login screen.
    setSurfaceStates({ offline: connectivity === 'offline' && status === 'authenticated' });
  }, [connectivity, status]);

  useEffect(() => {
    // Web's source is the auth slice's `emailVerified`; the derivation in
    // packages/session now honours the wire's `email_verified` boolean, so a
    // member the server has not verified renders view-only (review finding #2).
    // The placeholder self written while /users/@me is in flight (empty id)
    // carries no verification truth, so it never flips the state.
    const viewOnly =
      status === 'authenticated' &&
      user !== null &&
      user.id !== '' &&
      !emailVerified;
    setSurfaceStates({ viewOnly });
  }, [emailVerified, status, user]);

  return null;
}

/** The manager instance. Throws outside the provider (a wiring bug, not a state). */
export function useSession(): SessionManager {
  const manager = useContext(SessionContext);
  if (manager === null) {
    throw new Error(
      'useSession() used outside <SessionProvider> — the root layout owns the manager.',
    );
  }
  return manager;
}

/** True once `restore()` has settled — the shell's first loading gate. */
export function useSessionRestored(): boolean {
  return useContext(SessionRestoredContext);
}

/**
 * Auth status as React state. Subscribes to the manager's auth store (the
 * session package's public seam) so screens can render the states-first
 * contract for a cold launch / expired session without polling.
 */
export function useAuthStatus(): AuthStatus {
  const manager = useSession();
  const store = manager.authStore;
  const [status, setStatus] = useState<AuthStatus>(() => store.getState().status);
  useEffect(() => {
    setStatus(store.getState().status);
    return store.subscribe((state) => setStatus(state.status));
  }, [store]);
  return status;
}

export function SessionProvider({ children, manager, resolveOrigin }: SessionProviderProps) {
  // One manager per mount: a re-render must never rebuild the gateway client
  // or re-run the refresh exchange.
  const managerRef = useRef<SessionManager | null>(manager ?? null);
  if (managerRef.current === null) {
    managerRef.current = createSessionManager({
      storage: secureTokenStorage,
      // Reaction dispatches reconcile before the shared store sees them —
      // web's ordering contract, which the replay gate depends on (M8). The
      // seam is (frame, store); the reactions module takes (store, frame).
      // One store instance for the manager and the UI: the REST bootstrap
      // below writes what the gateway dispatches, and the shell reads it.
      store: defaultStore,
      gatewayPreprocessors: [
        (frame, store) => applyReactionEvent(store, frame),
        // CALL_SIGNAL is the same shape of seam as reactions: the store
        // deliberately ignores it (reconcile treats CallSignal as a no-op) and
        // the media engine consumes it through @cytale/calls's own emitter.
        // Without this route a called device negotiates nothing.
        (frame) => {
          routeCallSignalEvent(frame);
        },
      ],
      // Every lifecycle transition of the one live client feeds the shell's
      // offline state (R15) — no surface can observe the gateway itself.
      createGatewayClient: createTrackedGatewayClient,
      // #88: every FAILED api call is offered here with its status and the
      // server's `x-request-id` — the trace handle that makes a report greppable
      // in the server logs. Same one-line wire as web's composition root.
      onRequestFailure: failure => clientErrors.observeApiFailure(failure),
      // The login form's server choice (persisted) wins over the build-time
      // origin: a user-typed server must survive the manager's construction.
      resolveOrigin: () => originOverride ?? (resolveOrigin ?? buildTimeOrigin)(),
    });
  }
  const active = managerRef.current;

  const [restored, setRestored] = useState(false);
  useEffect(() => {
    let cancelled = false;
    // The login form's server choice (persisted) applies BEFORE the restore:
    // a restored session reconnects to the server it authenticated against,
    // not the build-time default.
    void (async () => {
      const stored = await readServerOrigin();
      if (cancelled) return;
      if (stored) applyServerOriginOverride(stored);
      // restore() resolves the persisted pair and re-identifies; a storage
      // failure must not take the app down — the manager lands on
      // `unauthenticated`, which is a renderable state.
      await active.restore().finally(() => {
        if (!cancelled) setRestored(true);
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [active]);

  // Publish the live manager for non-React callers (the message window's
  // default read-ack sender; web's `session.getGateway()` seam).
  useEffect(() => {
    registeredManager = active;
    return () => {
      if (registeredManager === active) registeredManager = null;
    };
  }, [active]);

  // #88: hand the shared reporter (installed at bootstrap, before this provider
  // existed) the two things only this provider knows — the api client that
  // carries its reports, and the gateway accessor the socket-story poller reads.
  useEffect(() => {
    setClientErrorSender(active.api);
    setClientErrorGateway(() => active.getGateway());
    return () => {
      setClientErrorSender(null);
      setClientErrorGateway(null);
    };
  }, [active]);

  const value = useMemo(() => active, [active]);

  return (
    <SessionContext.Provider value={value}>
      <SessionRestoredContext.Provider value={restored}>
        <ShellSurfaceStateProducer manager={active} />
        <StoreHydrator manager={active} />
        {children}
      </SessionRestoredContext.Provider>
    </SessionContext.Provider>
  );
}
