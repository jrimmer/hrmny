/**
 * @cytale/session — app-level auth session (extracted from apps/web U19
 * `features/auth/session.ts`, plan 004 M4 / KTD4).
 *
 * Owns the api-client, the gateway-client, and the auth store wiring. One
 * instance per app (the SPA has exactly one session; the native app too).
 * React/RN bind via useSyncExternalStore over `authStore` (web: useAuth).
 *
 * ---------------------------------------------------------------------------
 * The token strategy is ONE implementation with TWO shapes, and MUST NOT fork
 * ---------------------------------------------------------------------------
 *
 * `refresh-token` (the default — web, the desktop shell, mobile, and the
 * terminal's local mode). Unchanged: the access token is held in memory for
 * request use and mirrored to the injected `TokenStorage` as the last-seen
 * copy the refresh contract needs (the refresh body carries no user claim);
 * the refresh token is persisted through the same storage. Where that storage
 * lives is the platform's call — web uses localStorage (its documented
 * tradeoff), the desktop shell and the native client use the OS credential
 * store (KD3). The api-client's Http layer handles 401 → refresh → one retry
 * via the TokenProvider seam below; proactive refresh before expiry is driven
 * by the expiry timestamp (armed at login — the F6 fix — and re-armed on every
 * exchange); every gateway (re-)Identify presents a live JWT because the
 * tokenProvider refreshes before returning when the in-memory token is expired.
 *
 * `access-only` (opt-in, and the terminal's SSH mode). Supplying
 * `tokenSource` selects it, and it exists for the one shape the refresh-token
 * path cannot express (KTD5/KTD8): an authenticated session with NO refresh
 * token, whose renewals arrive out of band. `authenticateFromTokenSource()`
 * establishes the session, and every later read of the token asks the source —
 * so a connection's descriptor reader publishing a fresh token makes the live
 * request path (REST and the gateway's re-Identify) present it on the next
 * call, with no restart and no storage round-trip. What this shape guarantees,
 * and the refresh-token shape does not have to:
 *   * **Nothing is ever written to `TokenStorage` (R27).** Adoption mirrors the
 *     token through the auth store's NON-persisting `setAccessToken`; the
 *     persisting pair (`setAuthenticated` / `updateTokens`, which write through
 *     `TokenStorage`) is never used on this path. The client therefore keeps
 *     no Cytale token on disk.
 *   * **The refresh-token timer is never armed (R9).** There is no refresh
 *     token to exchange, and `refreshTokens()` throws without one — arming the
 *     timer would leave a dead timer that fires and throws minutes later.
 *   * **A 401 is RECOVERABLE, never a logout.** `Http` refreshes on a 401 and
 *     calls `onLogout` when it cannot; for an access-only session it cannot, by
 *     definition, because there is no refresh token. This mode therefore does
 *     not log out from that callback: it moves `accessStatus` to `'expired'`
 *     (the token the request carried is stale and a renewal is expected from
 *     the source) and lets `Http`'s `session_expired` ApiError propagate to the
 *     caller as a retryable failure. A client in this mode must NOT treat
 *     `session_expired` as terminal — retry after the source has renewed.
 *   * **Its state is reported on the session, not on `AuthState.status`** (see
 *     `accessStatus`): `AuthStatus` is the three shipping clients' contract and
 *     this mode does not widen it.
 * A malformed value from the source is REJECTED, never adopted, and never
 * tears down a session that already has a good token.
 *
 * Every platform seam stays injectable instead of being dragged into the
 * package — three of them, and `tokenSource` is the third:
 *   * `resolveOrigin` — web's build-time `configuredOrigin()`
 *     (VITE_CYTALE_ORIGIN for the Tauri desktop build); native supplies its
 *     configured server origin; the terminal client supplies the host
 *     configuration in SSH mode (R14).
 *   * `gatewayPreprocessors` — web's DOM-free dispatch seams
 *     (`applyReactionEvent`, `routeCallSignalEvent`) run BEFORE the shared
 *     store dispatcher, preserving the ordering the reactions replay gate
 *     depends on (`s <= lastSeq` must see the pre-dispatch value).
 *   * `tokenSource` — the access-only renewal answer described above, which
 *     is also the ONLY thing that selects that shape: without it the session
 *     is the refresh-token path, unchanged.
 */

import {
  CytaleApiClient,
  ApiError,
  type CurrentUser,
  type AuthTokens,
  type RequestFailure,
} from '@cytale/api-client';
import { GatewayClient, type GatewayClientOptions } from '@cytale/gateway-client';
import {
  defaultStore,
  resetForFreshSession,
  applyGatewayEvent,
  withBatchedWrites,
  type StateStore,
} from '@cytale/state';

import { createAuthStore, type AuthStore } from './authStore.js';
import type { TokenStorage } from './tokenStorage.js';

/** Proactive refresh fires this long before expiry (2 min). */
const PROACTIVE_REFRESH_MARGIN_MS = 2 * 60 * 1000;

/** Access-token TTL fallback when the refresh body carries none (U8 default). */
const DEFAULT_ACCESS_TTL_SECONDS = 900;

/**
 * Did the SERVER refuse this refresh, or did the request merely fail to arrive?
 *
 * Only the first ends a session (plan 4.14a). `ApiError` is constructed from a
 * response, so its presence means the server answered; 401/403 is that answer
 * saying the credential is dead. A rejected fetch (offline, DNS, TLS), a 5xx, a
 * timeout or a 429 are all transport/serving conditions the caller should retry
 * with the session intact.
 */
function isAuthRefusal(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

/**
 * A dispatch pre-processor. Runs on every gateway frame BEFORE the shared
 * store dispatcher; `store` is the session's store so a seam can never patch
 * a different instance than the one the dispatcher hydrates.
 */
export type GatewayPreprocessor = (frame: unknown, store: StateStore) => void;

/**
 * The out-of-band renewal seam (KTD5/KTD8): a synchronous, authoritative
 * answer to "what token should the next request present?".
 *
 * Both members are read on every request, so the implementation owns ONE
 * in-memory value that its renewal path (the terminal's descriptor reader)
 * replaces when a fresh token arrives. It must be synchronous: the request
 * path reads a token synchronously through a promise wrapper, and the storage
 * adapter's read is not the access-token path (its read is consulted for the
 * refresh token only).
 */
export interface AccessTokenSource {
  /** The access token to authenticate with right now; null when none exists. */
  getAccessToken(): string | null;
  /**
   * That token's expiry in ms since epoch, or 0 when the source does not
   * know it. A 0 expiry means "usable" (an unknown clock is not an expired
   * one); a past expiry is surfaced as `'expired'` rather than retried blind.
   */
  getAccessExpiresAt(): number;
}

/**
 * Access-only session status — the terminal client's connection state.
 *
 *   * `'idle'` — nothing established (also the value the refresh-token
 *     clients always report, since they never enter this mode).
 *   * `'connecting'` — `authenticateFromTokenSource()` is in flight.
 *   * `'authenticated'` — established, with a usable token.
 *   * `'expired'` — the token is stale (it was already expired when the
 *     source was read, or a 401 told us the server rejected it) and the next
 *     usable value has not arrived yet. RECOVERABLE: the session is not torn
 *     down and a renewal from the source moves it back to `'authenticated'`.
 */
export type AccessStatus = 'idle' | 'connecting' | 'authenticated' | 'expired';

/**
 * A JWT — three base64url segments and nothing else. HS256 access tokens are
 * the only thing the server mints (`Cytale.Accounts.Auth.issue_access_token/3`)
 * and the gateway verifies, so a value that is not shaped like one is a
 * garbled descriptor write, not a credential: it is rejected where it enters
 * (`#usableSourceToken`) instead of being sent and dropping the session into a
 * 401 → logout path.
 */
const ACCESS_TOKEN_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** Seconds-from-now for an absolute expiry, or 0 when the expiry is unknown. */
function expiresInSeconds(expiresAt: number): number {
  if (!(expiresAt > 0)) return 0;
  return Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
}

export interface SessionManagerOptions {
  /** Platform credential persistence (KTD4/KD3). */
  storage: TokenStorage;
  /**
   * Build-time server origin override. Web passes `configuredOrigin`
   * (VITE_CYTALE_ORIGIN); native passes its configured API origin. Consulted
   * once when the api client is built, mirroring web's module-load behaviour.
   */
  resolveOrigin?: () => string | undefined;
  /** Hydrated store; defaults to @cytale/state's `defaultStore`. */
  store?: StateStore;
  /** Ordered pre-processors (web: reactions, call signals). */
  gatewayPreprocessors?: readonly GatewayPreprocessor[];
  /** Access-token TTL seconds used when the refresh body omits one. */
  defaultExpiresIn?: number;
  /**
   * Gateway construction seam (tests, and native runtimes that supply a
   * socket factory / codec preferences). Defaults to `new GatewayClient(...)`.
   */
  createGatewayClient?: (options: GatewayClientOptions) => GatewayClient;
  /**
   * Preferred gateway payload codec, forwarded verbatim to the gateway
   * client's `compression` option (#111 rig hook: pinning `zlib_stream`
   * simulates a browser without native zstd). Undefined = the documented
   * zstd-first negotiation with its proven-streaming zlib fallback.
   */
  gatewayCompression?: GatewayClientOptions['compression'];
  /**
   * Access-only mode (KTD8). Supplying a source makes this session renew
   * through it instead of through a refresh token: no token is persisted
   * (R27), no refresh timer is armed (R9), and a 401 is recoverable rather
   * than a logout. Omit it and the session is byte-for-byte the refresh-token
   * path the three shipping clients use.
   */
  tokenSource?: AccessTokenSource;
  /**
   * Failure observation seam (#88), forwarded to the api-client's HTTP layer:
   * every FAILED call is offered here with its status and the server's
   * `x-request-id`. Supplying it is how web, the desktop shell and mobile all
   * record the same request id — the HTTP layer is the one place that sees
   * every call, and this is the one line each client's composition root adds.
   */
  onRequestFailure?: (failure: RequestFailure) => void;
  /**
   * Burst batching (lane D #18). READY and RESUMED open a short window in
   * which dispatches are queued and then applied as ONE store commit (see
   * `withBatchedWrites`): a resume replay, or READY with its CALL_SYNC /
   * presence snapshot / read-state sync, renders once instead of once per
   * frame. `schedule` decides when the window closes; the default is the next
   * animation frame, bounded by a short timer so a hidden tab (no frames)
   * still flushes. Pass `false` to apply every dispatch synchronously.
   */
  dispatchBursts?: false | { schedule: (flush: () => void) => void };
}

/** Upper bound on a burst window when no animation frame arrives (hidden tab). */
const BURST_MAX_WAIT_MS = 50;

/** The default burst-window close: next frame, or the bound, whichever first. */
function scheduleBurstFlush(flush: () => void): void {
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    flush();
  };
  const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => unknown }).requestAnimationFrame;
  if (typeof raf === 'function') raf(once);
  setTimeout(once, BURST_MAX_WAIT_MS);
}

/** True for a value usable as the signed-in account (a login/refresh `user`). */
function usableUser(value: unknown): value is CurrentUser {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    (value as { id: string }).id !== ''
  );
}

/** A server-address field submitted something unusable. */
export class ServerOriginError extends Error {}

/**
 * The login form's server-address rule — the same transport safety
 * `resolveBuildTimeOrigin` enforces for build-time origins, applied to
 * user input: an absolute absolute URL, https always, http loopback
 * (localhost / 127.0.0.1) only in development builds. Returns the trimmed
 * origin; throws `ServerOriginError` with a user-facing message otherwise.
 */
export function validateServerOrigin(raw: string, opts?: { dev?: boolean }): string {
  const dev = opts?.dev ?? false;
  const origin = raw.trim();
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new ServerOriginError(
      'That server address is not a valid URL — it should look like https://hrmny.chat',
    );
  }
  if (url.protocol === 'https:') return url.origin;
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (dev && url.protocol === 'http:' && loopback) return url.origin;
  throw new ServerOriginError(
    dev
      ? 'Only https:// servers are accepted (plus http://localhost for development).'
      : 'Only https:// servers are accepted.',
  );
}

export class SessionManager {
  readonly authStore: AuthStore;
  readonly api: CytaleApiClient;

  readonly #storage: TokenStorage;
  readonly #store: StateStore;
  readonly #resolveOrigin: () => string | undefined;
  /**
   * Login-time server selection (2026-09-19): the login forms on native and
   * the desktop shell let the user point the session at any server before
   * authenticating. Set through `setServerOrigin`; wins over `resolveOrigin`
   * for every URL the manager builds (api base, refresh/logout, gateway).
   * Cleared never — it persists for the manager's life; the next login may
   * set a different one.
   */
  #originOverride: string | null = null;
  readonly #preprocessors: readonly GatewayPreprocessor[];
  readonly #defaultExpiresIn: number;
  readonly #createGatewayClient: (options: GatewayClientOptions) => GatewayClient;
  readonly #gatewayCompression: GatewayClientOptions['compression'];
  /** Non-null iff this session is access-only (see the header). */
  readonly #tokenSource: AccessTokenSource | null;

  #accessStatus: AccessStatus = 'idle';
  readonly #accessStatusListeners = new Set<(status: AccessStatus) => void>();
  /**
   * The last token mirrored into the auth store from the source. Only used to
   * skip a redundant `setAccessToken` (zustand notifies on any partial), never
   * as the token itself — the source is the owner.
   */
  #mirroredSourceToken: string | null = null;

  #gateway: GatewayClient | null = null;
  #refreshTimer: ReturnType<typeof setTimeout> | null = null;
  #refreshInFlight: Promise<void> | null = null;
  /** The account the last refresh exchange returned (lane D #4); consumed once. */
  #refreshedUser: CurrentUser | null = null;
  readonly #burstSchedule: ((flush: () => void) => void) | null;
  /** Dispatches queued inside an open burst window, or null when none is open. */
  #burst: Parameters<typeof applyGatewayEvent>[1][] | null = null;
  /**
   * Session generation (F1). Bumped by every teardown (logout, failed
   * restore, session-expiry) so an exchange that was already on the wire when
   * the session died can recognise itself as stale and DROP its result
   * instead of re-persisting it. Without this, `logout()`'s wipe is undone by
   * a refresh that resolves a moment later: both keys are rewritten, and
   * because `/auth/logout` only revokes the token the client presented, the
   * freshly minted pair is still valid server-side — the next cold launch
   * signs the user straight back in.
   */
  #sessionGeneration = 0;
  /**
   * Generation at the last credential READ by the api-client's TokenProvider.
   * A rotation may only be persisted while this still matches (F1, the
   * api-client's own 401 → refresh path writes through the same provider).
   */
  #credentialReadGeneration = 0;

  constructor(options: SessionManagerOptions) {
    this.#storage = options.storage;
    this.#store = options.store ?? defaultStore;
    this.#resolveOrigin = options.resolveOrigin ?? (() => undefined);
    this.#preprocessors = options.gatewayPreprocessors ?? [];
    this.#defaultExpiresIn = options.defaultExpiresIn ?? DEFAULT_ACCESS_TTL_SECONDS;
    this.#createGatewayClient = options.createGatewayClient ?? ((gatewayOptions) => new GatewayClient(gatewayOptions));
    this.#gatewayCompression = options.gatewayCompression;
    this.#tokenSource = options.tokenSource ?? null;
    this.#burstSchedule =
      options.dispatchBursts === false
        ? null
        : (options.dispatchBursts?.schedule ?? scheduleBurstFlush);

    this.authStore = createAuthStore(this.#storage);

    this.api = new CytaleApiClient({
      // Dynamic: setServerOrigin re-points this between launches and
      // mid-walk (the login form submits AFTER choosing the server).
      baseUrl: () => this.#apiBaseUrl(),
      onRequestFailure: options.onRequestFailure,
      tokens: {
        getAccessToken: async () => this.#liveAccessToken(),
        getRefreshToken: async () => {
          // R9: the bridge issues an access token ONLY, so an access-only
          // session has no refresh token to present — by construction, not
          // because the adapter happens to be empty. Http's 401 exchange reads
          // this, finds null, and surfaces a recoverable error instead of
          // running a refresh that could only fail (see the header policy).
          if (this.#tokenSource !== null) return null;

          // F1: mark the generation this credential belongs to. The rotation
          // that follows may only be written back while no teardown has
          // intervened (see updateTokens below).
          this.#credentialReadGeneration = this.#sessionGeneration;
          return this.authStore.getState().getRefreshToken();
        },
        updateTokens: async (access, refresh) => {
          // Access-only: Http can only reach this after a successful
          // /auth/refresh, which cannot happen without a refresh token. The
          // guard is here so an access-only session can NEVER write a token
          // through TokenStorage (R27) even if that ever changed.
          if (this.#tokenSource !== null) return;

          // F1: the Http layer refreshed on a 401 that started before a
          // sign-out. Persisting now would rewrite both keys after logout's
          // wipe (and hand the next cold launch a live 30-day credential).
          if (this.#credentialReadGeneration !== this.#sessionGeneration) return;

          // The Http layer rotated the pair server-side; expiresIn comes from
          // the last known TTL (the refresh response body is consumed inside
          // Http; the config default 15 min matches the server contract).
          this.authStore
            .getState()
            .updateTokens(access, refresh, this.authStore.getState().expiresIn || this.#defaultExpiresIn);
          await this.#storage.flush?.();
        },
      },
      onLogout: () => {
        // Http gave up refreshing (session_expired) — hard logout.
        if (this.#tokenSource !== null) {
          // …unless there was nothing to refresh WITH. For an access-only
          // session this callback means "the token the request carried is
          // stale", and the source is the renewal path: surface the expired
          // state, keep the session, and let the caller retry once the
          // descriptor has delivered a fresh token. Tearing the session down
          // here would turn a renewal race into a sign-out.
          this.#setAccessStatus('expired');
          return;
        }
        void this.logout('Your session expired. Please sign in again.');
      },
    });
  }

  /** Restore a session from persisted credentials (cold launch / page load). */
  async restore(): Promise<void> {
    this.authStore.getState().setStatus('loading');

    // Async backends (expo-secure-store) load their mirror here; the
    // localStorage adapter has nothing to do. A rejecting hydrate (device
    // locked, keystore unavailable) is treated as "no persisted credentials"
    // so the store lands on 'unauthenticated' — never stranded in 'loading'
    // with no re-auth path.
    try {
      await this.#storage.hydrate?.();
    } catch {
      /* treat as no persisted credentials */
    }

    const stored = this.#storage.read();
    const refresh = stored?.refreshToken ?? null;

    if (refresh === null) {
      this.authStore.getState().setStatus('unauthenticated');
      return;
    }

    // Seed the store so the refresh exchange has both halves: the last-seen
    // access token (the U9 refresh contract identifies the user by its JWT
    // sub in the Authorization header) and the persisted refresh token.
    // Seeding with '' would erase the persisted access copy via updateTokens.
    this.authStore.getState().updateTokens(stored?.accessToken ?? '', refresh, 0);

    try {
      await this.refreshTokens();
      // Lane D #4: boot was refresh → GET /users/@me → connect, each waiting
      // on the last. The socket needs only a live token, so it opens the
      // moment the exchange lands — its handshake overlaps everything after —
      // and the account rides the exchange itself on a current server (an
      // older one gets the `@me` read, as before).
      this.#connectGateway();
      const refreshed = this.#takeRefreshedUser();
      const user =
        refreshed ?? (await this.api.getCurrentUser() as unknown as { user: CurrentUser }).user;
      this.authStore.getState().setUser(user);
      this.authStore.getState().setStatus('authenticated');
    } catch {
      // Refresh token dead/expired → unauthenticated state. Do NOT wipe
      // storage here: the next successful login overwrites both keys, and
      // wiping here means every deploy (which rotates tokens server-side
      // when the DB resets) would force a re-login even for valid sessions.
      this.#teardown();
      this.authStore.getState().reset();
      this.authStore.getState().setStatus('unauthenticated');
    }
  }

  /** Login (identifier = username or email). Errors surface as ApiError. */
  async login(identifier: string, password: string): Promise<void> {
    const tokens = await this.api.login({ identifier, password });
    await this.#acceptTokens(tokens);
  }

  /**
   * Establish a session from an ALREADY-MINTED token pair (#36, passkey login).
   * The WebAuthn ceremony runs in the browser — outside this package, which
   * has no `navigator.credentials` — and the verify endpoint hands back the
   * exact pair POST /auth/login returns. From here the flow is byte-identical
   * to password login: same store seeding, proactive refresh, /users/@me
   * hydration, and gateway connect (so the signed-out continuation resumes).
   */
  async loginWithTokens(tokens: AuthTokens): Promise<void> {
    await this.#acceptTokens(tokens);
  }

  /**
   * Establish an authenticated session from the token source alone (KTD5/KTD8)
   * — the terminal client's SSH entry point, where the token came from the
   * host over an inherited descriptor and there is no credential to log in
   * with and no refresh token to exchange.
   *
   * The token is mirrored through the NON-persisting setter, the server is
   * asked who it belongs to, and the gateway connects; the refresh-token timer
   * is deliberately never armed. Re-callable: a session whose token was
   * reported expired can be re-established once the source has a fresh one,
   * without a restart.
   *
   * Throws an ApiError keyed `access_token_missing`, `access_token_malformed`,
   * or `access_token_expired` when the source holds nothing usable, and
   * `session_expired` when the server rejects the token (the same recoverable
   * error the live path surfaces — this mode never logs out). A failure leaves
   * any already-established session alone.
   */
  async authenticateFromTokenSource(): Promise<void> {
    const source = this.#tokenSource;
    if (source === null) {
      throw new Error('This session has no token source; pass `tokenSource` to the session manager.');
    }

    const alreadyAuthenticated = this.authStore.getState().status === 'authenticated';
    this.#setAccessStatus('connecting');

    const token = this.#usableSourceToken();
    if (token === null) {
      const raw = source.getAccessToken();
      const missing = raw === null || raw === '';
      this.#refuseAdoption(
        alreadyAuthenticated,
        new ApiError({
          key: missing ? 'access_token_missing' : 'access_token_malformed',
          code: 40101,
          message: missing
            ? 'No access token is available from the token source.'
            : 'The access token supplied by the token source is not a token.',
          status: 401,
        }),
      );
    }

    if (this.#sourceTokenExpired()) {
      // Visible, not a silent stall: the caller renders "expired, awaiting a
      // renewed token" from `accessStatus` instead of watching a spinner.
      this.#refuseAdoption(
        alreadyAuthenticated,
        new ApiError({
          key: 'access_token_expired',
          code: 40101,
          message: 'The access token from the token source has already expired.',
          status: 401,
        }),
      );
    }

    this.#mirrorSourceToken(token);
    try {
      const user = (await this.api.getCurrentUser() as unknown as { user: CurrentUser }).user;
      this.authStore.getState().setUser(user);
      this.authStore.getState().setStatus('authenticated');
      this.#setAccessStatus('authenticated');
      this.#connectGateway();
    } catch (err) {
      // Not established (a rejected token lands on 'expired' inside the
      // api-client's onLogout before this runs; anything else is a transport
      // failure). Land the store on a state a client can render — never a
      // permanent 'loading'. Nothing here persists: `reset()` would write
      // through TokenStorage, which this mode must not do (R27).
      if (this.#accessStatus === 'connecting') this.#setAccessStatus('idle');
      if (!alreadyAuthenticated) this.authStore.getState().setStatus('unauthenticated');
      throw err;
    }
  }

  /**
   * Access-only session status (see the header). `'idle'` for the
   * refresh-token clients, which never enter this mode.
   */
  get accessStatus(): AccessStatus {
    return this.#accessStatus;
  }

  /**
   * Subscribe to access-only status transitions (the terminal renders its
   * connection banner from this). Returns an unsubscribe function.
   */
  onAccessStatusChange(listener: (status: AccessStatus) => void): () => void {
    this.#accessStatusListeners.add(listener);
    return () => {
      this.#accessStatusListeners.delete(listener);
    };
  }

  /**
   * Register → account is view-only until verification. `inviteCode` rides
   * along when the visitor arrived through an invite link (required by a
   * server with closed sign-up; the account joins that workspace).
   */
  async register(username: string, email: string, password: string, inviteCode?: string): Promise<void> {
    const tokens = await this.api.register(
      inviteCode ? { username, email, password, invite_code: inviteCode } : { username, email, password },
    );
    await this.#acceptTokens(tokens);
  }

  /** Complete email verification with the emailed token. */
  async verifyEmail(token: string): Promise<void> {
    await this.api.verifyEmail({ token });

    // F3: POST /auth/verify-email is UNAUTHENTICATED and verifies the TOKEN's
    // owner — consuming a forwarded or cross-device link says nothing about
    // whoever happens to be signed in here. Converge from the server instead
    // of asserting `verified` on the current account.
    if (!this.authStore.getState().isAuthenticated()) return;
    try {
      const user = (await this.api.getCurrentUser() as unknown as { user: CurrentUser }).user;
      this.authStore.getState().setUser(user);
    } catch {
      // The token WAS consumed: a failed follow-up read (offline, or the
      // session died mid-flow) must not turn a successful verification into
      // an error, and must never fall back to asserting `verified`.
    }
  }

  /** Resend the verification email for the logged-in account. */
  async resendVerification(): Promise<void> {
    const email = this.authStore.getState().currentUser?.email;
    if (email) await this.api.resendVerification(email);
  }

  /** Request a password-reset email (anti-enumeration: always succeeds). */
  async requestPasswordReset(email: string): Promise<void> {
    await this.api.requestPasswordReset(email);
  }

  /** Complete the reset with the emailed token; all sessions are revoked. */
  async completePasswordReset(token: string, newPassword: string): Promise<void> {
    await this.api.completePasswordReset({ token, new_password: newPassword });
  }

  /**
   * Single-flight proactive/explicit refresh. The Http layer refreshes on
   * 401 automatically; this covers expiry-before-request and the gateway's
   * re-Identify path.
   *
   * ONE exchange owns the rotation (hardening plan 4.14b). This method used to
   * run its own `fetch` to `/auth/refresh`, independently of Http's identical
   * single-flight. Refresh tokens ROTATE and the server deletes the old hash on
   * the first exchange, so the two gates presenting the same token meant the
   * loser was answered `REFRESH_REVOKED` → `onLogout` → a hard logout of a
   * perfectly valid session. The exchange now runs through
   * `Http.refreshTokens()`, where the 401 path already joins it.
   *
   * The outer gate stays: it is what makes a concurrent caller of THIS method
   * await the same promise, and it keeps one place where the refresh timer is
   * re-armed.
   */
  async refreshTokens(): Promise<void> {
    if (this.#tokenSource !== null) {
      // R9: there is no refresh token in this mode, so there is no exchange to
      // run — renewals arrive through the source. Failing loudly beats a
      // silent no-op, and the message names the mechanism.
      throw new ApiError({
        key: 'no_refresh_token',
        code: 40101,
        message: 'This session renews through its token source; it has no refresh token.',
      });
    }

    if (this.#refreshInFlight) return this.#refreshInFlight;

    this.#refreshInFlight = (async () => {
      // F1: the generation this exchange belongs to. Anything that lands
      // after the session it was minted for has been torn down is dropped.
      const generation = this.#sessionGeneration;

      try {
        // Http reads both halves through this session's token provider (which
        // marks the credential generation) and writes the rotated pair back
        // through `updateTokens`, so the F1 staleness guards still apply.
        const user = await this.api.refreshToken();
        if (generation === this.#sessionGeneration) this.#refreshedUser = user;
      } catch (error) {
        // A late failure belongs to a session that no longer exists: resetting
        // here would wipe whatever came after the sign-out (e.g. a new login).
        if (generation !== this.#sessionGeneration) return;

        // A TRANSPORT failure is not a refusal (plan 4.14a). `Http.#exchange`
        // awaits the raw fetch, so being offline rejects with a TypeError rather
        // than an ApiError — and ending the session on that would sign a user out
        // for waking a laptop in a lift, wiping credentials the server never
        // invalidated. The gateway's reconnect loop and the proactive timer both
        // call this path, and `#teardown()` also destroys the gateway client, so
        // it would take the retry loop with it. Only a server REFUSAL ends the
        // session; everything else propagates with the session intact.
        if (!isAuthRefusal(error)) throw error;

        // F1/4.14a: a refused refresh ENDS the session, so tear it down before
        // clearing the store. Resetting alone left the gateway connected on the
        // dead credential — re-Identifying against a revoked token forever —
        // and left the previous user's hydrated messages in the default store,
        // which is the state the next page reads before any login.
        this.#teardown();
        this.authStore.getState().reset();
        await this.#storage.flush?.();
        throw error;
      }

      // F1: the sign-out (or a fresh login) happened while this was in flight.
      // The rotated pair was written by the provider only if the credential
      // generation still matched; do not re-arm the timer for a dead session.
      if (generation !== this.#sessionGeneration) return;

      // Http consumes the response body, so the TTL comes from the store the
      // provider just updated (the server's `expires_in` on the exchange, or
      // the last known / configured default). This is the F6 arming: without
      // it an idle connected session rides its access token to expiry.
      this.#scheduleProactiveRefresh(
        this.authStore.getState().expiresIn || this.#defaultExpiresIn
      );
    })();

    try {
      await this.#refreshInFlight;
    } finally {
      this.#refreshInFlight = null;
    }
  }

  /** Logout: revoke server-side, disconnect gateway, wipe all state. */
  async logout(reason?: string): Promise<void> {
    // api-client gap (U16 ships no logout method — noted for the parent):
    // revoke directly against the documented POST /auth/logout contract.
    const refresh = this.authStore.getState().getRefreshToken();
    if (refresh !== null) {
      try {
        await globalThis.fetch(`${this.#apiBaseUrl()}/auth/logout`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(this.authStore.getState().getAccessToken()
              ? { authorization: `Bearer ${this.authStore.getState().getAccessToken()}` }
              : {}),
          },
          body: JSON.stringify({ refresh_token: refresh }),
        });
      } catch {
        // Revocation is best-effort; local state is cleared regardless.
      }
    }

    this.#teardown();
    this.authStore.getState().reset();
    // Durability barrier: the wipe must land in Keychain/Keystore before the
    // caller (sign-out UI) reports success.
    await this.#storage.flush?.();

    if (reason) {
      // Surface the reason through the store status for the login page.
      this.authStore.getState().setStatus('unauthenticated');
    }
  }

  /** True when the access token expires within the proactive margin. */
  shouldRefreshProactively(): boolean {
    // Access-only: nothing to refresh with, so there is never a proactive
    // exchange to schedule (R9). Reported as "no" rather than a caller-visible
    // throw on a predicate.
    if (this.#tokenSource !== null) return false;

    const { accessExpiresAt, accessToken } = this.authStore.getState();
    return accessToken !== null && Date.now() >= accessExpiresAt - PROACTIVE_REFRESH_MARGIN_MS;
  }

  // -- internals -------------------------------------------------------------

  /**
   * The token the live request path must present (KTD8).
   *
   * Without a source this is the auth store's in-memory token — the existing
   * path, untouched. With one, the source is asked on EVERY read, so a renewal
   * the connection's descriptor reader published reaches the next request (and
   * the next gateway Identify) without a restart. An unusable value is
   * rejected and the last good token stays live.
   */
  #liveAccessToken(): string | null {
    if (this.#tokenSource === null) return this.authStore.getState().getAccessToken();

    const token = this.#usableSourceToken();
    if (token === null) {
      // Nothing usable on the pipe (a garbled write, or a renewal not yet
      // delivered): keep the token the session already holds. This is the
      // "rejected without tearing down an existing session" path.
      return this.authStore.getState().getAccessToken();
    }

    if (this.#sourceTokenExpired()) {
      this.#setAccessStatus('expired');
      return token;
    }

    this.#mirrorSourceToken(token);
    return token;
  }

  /**
   * The source's current token when it is present and token-shaped, else null.
   * The shape check is what keeps a malformed value from ever being adopted.
   */
  #usableSourceToken(): string | null {
    const token = this.#tokenSource?.getAccessToken() ?? null;
    if (token === null || token === '') return null;
    return ACCESS_TOKEN_SHAPE.test(token) ? token : null;
  }

  /** True when the source reports an expiry that has already passed. */
  #sourceTokenExpired(): boolean {
    const expiresAt = this.#tokenSource?.getAccessExpiresAt() ?? 0;
    return expiresAt > 0 && expiresAt <= Date.now();
  }

  /**
   * Mirror a usable source token into the auth store so its own readers
   * (`isAuthenticated`, `getAccessToken`) see renewals too.
   *
   * This is the NON-PERSISTING `setAccessToken` — never `setAuthenticated` or
   * `updateTokens`, which write the pair through `TokenStorage` and would put
   * a Cytale token on disk (R27). Written only when the value actually
   * changed, because zustand notifies on any partial.
   */
  #mirrorSourceToken(token: string): void {
    if (this.#mirroredSourceToken !== token) {
      this.#mirroredSourceToken = token;
      this.authStore
        .getState()
        .setAccessToken(token, expiresInSeconds(this.#tokenSource?.getAccessExpiresAt() ?? 0));
    }
    // A usable token means the session is established again, including out of
    // the 'expired' state a stalled renewal or a refused request left behind.
    if (this.#accessStatus === 'expired') this.#setAccessStatus('authenticated');
  }

  #setAccessStatus(status: AccessStatus): void {
    if (this.#accessStatus === status) return;
    this.#accessStatus = status;
    for (const listener of [...this.#accessStatusListeners]) listener(status);
  }

  /**
   * Refuse an adoption: land the session on a state a client can render —
   * never a permanent `'loading'` — and throw. Nothing is persisted either
   * way: `reset()` would write through `TokenStorage`, which this mode must
   * not do (R27).
   */
  #refuseAdoption(keepEstablished: boolean, error: ApiError): never {
    this.#setAccessStatus('expired');
    if (!keepEstablished) this.authStore.getState().setStatus('unauthenticated');
    throw error;
  }

  /**
   * Re-point the session at a server origin BEFORE authenticating — the
   * login form's server-address field. Rebuilds nothing: the api client and
   * the gateway both resolve their URLs per use, so the next call (and every
   * call after) dials the new origin. Refused while authenticated — the
   * server is a pre-auth choice; switching servers mid-session is a
   * sign-out-and-back.
   *
   * The same transport rule `resolveBuildTimeOrigin` enforces applies here:
   * https always, http loopback only in dev builds. Throws
   * `ServerOriginError` with user-facing copy on refusal.
   */
  setServerOrigin(origin: string, opts?: { dev?: boolean }): void {
    if (this.authStore.getState().status === 'authenticated') {
      throw new ServerOriginError('Sign out before changing the server.');
    }
    this.#originOverride = validateServerOrigin(origin, opts);
  }

  /** Build the documented API base for the resolved origin. */
  #apiBaseUrl(): string {
    const origin = this.#originOverride ?? this.#resolveOrigin() ?? globalThis.location?.origin ?? '';
    return `${origin}/api/v1`;
  }

  /** Gateway endpoint (same host, WS protocol, U10 mount point). */
  #gatewayUrl(): string {
    const override = this.#originOverride ?? this.#resolveOrigin();
    if (override) {
      const url = new URL(override);
      const proto = url.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${proto}//${url.host}/gateway/websocket`;
    }
    const loc = globalThis.location;
    if (!loc) {
      // No configured origin and no `location`: this is a native runtime (React
      // Native has no `location`) whose `resolveOrigin` was never wired. The
      // old fallback was `ws://localhost:4001` — which on a device is the
      // DEVICE's own loopback, so the wiring bug surfaced as an endless
      // reconnect loop against a host nobody chose. Fail where the cause is
      // legible instead of dialling a guess.
      throw new Error(
        'Cannot resolve the gateway URL: this runtime has no `location` — pass `resolveOrigin`.',
      );
    }
    const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${loc.host}/gateway/websocket`;
  }

  /** The account the last refresh returned, once (null when it sent none). */
  #takeRefreshedUser(): CurrentUser | null {
    const user = this.#refreshedUser;
    this.#refreshedUser = null;
    return usableUser(user) ? user : null;
  }

  async #acceptTokens(tokens: AuthTokens): Promise<void> {
    // Lane D #4: a current server's token pair carries the account in the
    // `@me` shape — adopt it and skip the round trip. An older server's
    // reduced (or absent) `user` still takes the read.
    const carried = usableUser(tokens.user) ? tokens.user : null;
    this.authStore.getState().setAuthenticated(
      tokens,
      carried ?? {
        id: '', // replaced by /users/@me below
        username: '',
        email: null,
        email_verified_at: null,
      },
    );
    await this.#storage.flush?.();

    // F6: arm the proactive refresh at LOGIN too. The scheduler was only
    // reachable from inside refreshTokens() — a fresh session that idles
    // connected (healthy WS, no REST 401 to rescue it, no reconnect for
    // tokenProvider to fire) silently rode the 15-minute token to expiry
    // (the walkthrough's dead-session observation).
    this.#scheduleProactiveRefresh(tokens.expires_in);

    try {
      // The socket needs only the token: open it before the account read.
      this.#connectGateway();
      const user =
        carried ?? (await this.api.getCurrentUser() as unknown as { user: CurrentUser }).user;
      this.authStore.getState().setUser(user);
      this.authStore.getState().setStatus('authenticated');
    } catch (err) {
      await this.logout();
      throw err;
    }
  }

  #connectGateway(): void {
    if (this.#gateway) return; // already connected

    this.#gateway = this.#createGatewayClient({
      url: this.#gatewayUrl(),
      // #111 rig hook: a host-pinned codec (e.g. zlib_stream to simulate a
      // browser without native zstd) rides the documented option; when unset
      // the client's own negotiation applies unchanged.
      ...(this.#gatewayCompression !== undefined
        ? { compression: this.#gatewayCompression }
        : {}),
      // Identify (and every reconnect's re-Identify) must present a live JWT:
      // after downtime the in-memory token is expired and the socket would
      // otherwise cycle auth-failed → backoff against a dead credential.
      tokenProvider: async () => {
        // Access-only: the source owns the token, and it is the only place a
        // renewal appears (KTD8) — reading the auth store here would re-present
        // the token the host has already replaced.
        if (this.#tokenSource !== null) return this.#liveAccessToken() ?? '';

        const s = this.authStore.getState();
        if (s.accessToken && Date.now() < s.accessExpiresAt - 10_000) {
          return s.accessToken;
        }

        try {
          await this.refreshTokens();
        } catch {
          // Swallowed on purpose: Identify fails-and-closes below on the dead
          // token, and the session transition is ALREADY owned by the failure — a
          // server refusal tears down and resets inside `refreshTokens/0`
          // (plan 4.14a), while a transport failure deliberately leaves the
          // session intact so the reconnect loop can retry it. There is nothing
          // left for this call site to do beyond letting Identify take its course.
        }

        return this.authStore.getState().getAccessToken() ?? '';
      },
    });

    // Hydrate the U17 store from every gateway dispatch (U19's READY hook).
    // Pre-processors run FIRST: their seams' replay gates read lastSeq before
    // applyGatewayEvent advances it (see apps/web reactions.ts). CALL_SIGNAL
    // pre-processing (calls plan U8) routes media signaling to the active call
    // media controller BEFORE the store — the store's own CallSignal case is a
    // deliberate no-op (signaling is ephemeral).
    this.#gateway.onAny((event) => {
      // Lane D #18: READY / RESUMED open a burst window — everything that
      // arrives before it closes lands as ONE store commit (the replay, the
      // establishment tail). Live traffic outside a window applies at once.
      if (this.#burstSchedule !== null) {
        if (this.#burst === null && (event.t === 'Ready' || event.t === 'Resumed')) {
          this.#burst = [];
          const gateway = this.#gateway;
          this.#burstSchedule(() => {
            // A window opened by a torn-down client has nothing to flush into.
            if (this.#gateway === gateway) this.#flushBurst();
          });
        }
        if (this.#burst !== null) {
          this.#burst.push(event);
          return;
        }
      }
      this.#applyDispatch(event);
    });

    // Initial connect failures must not leak as unhandled rejections — the
    // client's reconnect-with-backoff loop owns retrying.
    this.#gateway.connect().catch(() => undefined);
  }

  /** Apply one burst window's queued dispatches as a single store commit. */
  #flushBurst(): void {
    const queued = this.#burst;
    this.#burst = null;
    if (queued === null || queued.length === 0) return;
    withBatchedWrites(this.#store, () => {
      for (const event of queued) this.#applyDispatch(event);
    });
  }

  /** One dispatch through the pre-processors, the store, and self-convergence. */
  #applyDispatch(event: Parameters<typeof applyGatewayEvent>[1]): void {
    for (const preprocess of this.#preprocessors) preprocess(event, this.#store);
    applyGatewayEvent(this.#store, event);
    // Self profile convergence: the roster row updated above, but the
    // AUTH store's rich self (UserPanel's avatar source) only refreshes
    // on REST reads — converge it from our own UserUpdate so a profile
    // change lands on every live session of this account, not just peers.
    if (event.t === 'UserUpdate') {
      const self = this.authStore.getState().currentUser;
      const u = event.d;
      if (self && self.id === u.id) {
        this.authStore.getState().setUser({
          ...self,
          username: u.username,
          display_name: u.display_name ?? self.display_name,
          avatar_url: u.avatar_url ?? null,
        });
      }
    }
  }

  #scheduleProactiveRefresh(expiresIn: number): void {
    // R9: an access-only session has no refresh token, so `refreshTokens()`
    // throws here — arming the timer would leave a dead timer that fires
    // minutes later and throws at nobody. The host's descriptor renewal is
    // this session's refresh path.
    if (this.#tokenSource !== null) return;

    if (this.#refreshTimer) clearTimeout(this.#refreshTimer);

    const delay = Math.max(expiresIn * 1000 - PROACTIVE_REFRESH_MARGIN_MS, 5_000);
    this.#refreshTimer = setTimeout(() => {
      if (this.authStore.getState().status === 'authenticated') {
        void this.refreshTokens().catch(() => {
          /* onLogout handles the dead-session path */
        });
      }
    }, delay);
  }

  #teardown(): void {
    // F1: invalidate every exchange already on the wire. Bumping here (rather
    // than only in logout) covers the failed-restore and session-expiry paths
    // too — any of them ends the session the in-flight refresh belonged to.
    this.#sessionGeneration += 1;

    // The access-only status is session-scoped like the gateway: a teardown
    // ends the established state, and the next adoption starts clean.
    this.#mirroredSourceToken = null;
    this.#setAccessStatus('idle');

    if (this.#refreshTimer) {
      clearTimeout(this.#refreshTimer);
      this.#refreshTimer = null;
    }

    this.#gateway?.disconnect();
    this.#gateway?.destroy();
    this.#gateway = null;
    // A burst still open belonged to the session that just ended.
    this.#burst = null;
    this.#refreshedUser = null;

    // Clear hydrated UI state (U17 contract: reset on logout).
    resetForFreshSession(this.#store);
  }

  /**
   * The live gateway client, or null when not connected. U23's typing/unread
   * hooks send TYPING_START / MESSAGE_ACK through this seam; components
   * subscribe to dispatch events via the same client.
   */
  getGateway(): GatewayClient | null {
    return this.#gateway;
  }
}

/** Factory form (native wiring and tests read better than `new`). */
export function createSessionManager(options: SessionManagerOptions): SessionManager {
  return new SessionManager(options);
}
