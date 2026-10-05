/**
 * @cytale/session — shared session orchestration (plan 004 M4).
 *
 * The auth/session lifecycle extracted from `apps/web/src/features/auth/`
 * (session.ts + authStore.ts), parameterised by a `TokenStorage` adapter so
 * web (localStorage) and native (expo-secure-store, KD3) share ONE
 * implementation of the reconnect/refresh logic instead of forking it:
 *
 *   * proactive refresh armed at login (F6) and re-armed on every exchange;
 *   * single-flight refresh, 401 → refresh → one retry via the api-client's
 *     TokenProvider seam;
 *   * gateway (re-)Identify always presents a live JWT (tokenProvider
 *     refreshes when the in-memory token is within 10s of expiry);
 *   * revoked/expired sessions land on the same states web surfaces
 *     (`unauthenticated` after a dead refresh token; the reason string for
 *     the session-expired transition).
 *
 * That is the default shape, and it stays the ONLY shape web, the desktop
 * shell, and mobile use. The ONE exception is opt-in and additive: pass
 * `tokenSource` and the session is access-only (tui plan U11, KTD5/KTD8) —
 * established by `SessionManager.authenticateFromTokenSource()` from a token
 * the client's host renews out of band, with no token persisted (R27), no
 * refresh timer armed (R9), and a 401 treated as recoverable rather than a
 * logout. Both shapes share this implementation; the token strategy does not
 * fork. See `session.ts`'s header for the full policy, including what an
 * access-only client must not do with a `session_expired` error.
 *
 * Platform seams stay injectable: `resolveOrigin` (web's `configuredOrigin`,
 * the terminal's host configuration), `gatewayPreprocessors` (web's reactions
 * + call-signal dispatch seams), and `tokenSource` (the access-only renewal
 * seam).
 */

export {
  createAuthStore,
  type AuthState,
  type AuthStatus,
  type AuthStore,
} from './authStore.js';

export {
  createSessionManager,
  SessionManager,
  ServerOriginError,
  validateServerOrigin,
  type AccessStatus,
  type AccessTokenSource,
  type GatewayPreprocessor,
  type SessionManagerOptions,
} from './session.js';

export {
  createMemoryTokenStorage,
  type StoredTokenPair,
  type TokenStorage,
} from './tokenStorage.js';
