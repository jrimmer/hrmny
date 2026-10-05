/**
 * @cytale/session — credential persistence seam (plan 004 M4, KTD4).
 *
 * The session orchestration is storage-agnostic: `TokenStorage` is the only
 * place tokens touch a platform. apps/web supplies the localStorage-backed
 * adapter (its documented XSS tradeoff is unchanged); apps/mobile supplies an
 * `expo-secure-store` adapter (KD3 — iOS Keychain / Android Keystore).
 *
 * Read contract: `read()` is SYNCHRONOUS. The extracted auth store's getters
 * (`getRefreshToken`) are sync by web's contract — the api-client's
 * `TokenProvider` wraps them in promises, and the refresh exchange reads the
 * last-seen pair synchronously. A backend whose reads are async
 * (`expo-secure-store`) loads its state into the adapter's in-memory mirror
 * via the optional `hydrate()`, which `SessionManager.restore()` awaits before
 * the cold-launch refresh exchange.
 *
 * Write contract: `write()` may be async. Adapters that queue async writes
 * expose `flush()` so callers can await durability; failures are tolerated
 * the same way web tolerates localStorage failures — the in-memory session
 * keeps working, the persisted copy is best-effort.
 */

/** The persisted half of a session: the token pair the refresh contract needs. */
export interface StoredTokenPair {
  /**
   * Last-seen access token. The refresh contract identifies the user by this
   * (expired-OK) JWT, so it must survive a cold launch; `null`/empty means
   * "not persisted".
   */
  accessToken: string | null;
  /** Refresh token (30-day TTL server-side; rotated on every exchange). */
  refreshToken: string | null;
}

/**
 * Platform credential storage. Implemented by apps/web (localStorage) and
 * apps/mobile (expo-secure-store); tests use `createMemoryTokenStorage()`.
 */
export interface TokenStorage {
  /** The persisted pair, or null when nothing is stored. Synchronous. */
  read(): StoredTokenPair | null;

  /**
   * Persist `pair` (null clears both entries). An empty-string token is
   * treated as absent, mirroring web's `writeStoredAccessToken('')` clearing
   * the key. Async backends may return a promise; the store never awaits it
   * (see `flush`).
   */
  write(pair: StoredTokenPair | null): void | Promise<void>;

  /**
   * Load an async backend into the synchronous read mirror. Optional: a
   * synchronous adapter (localStorage) needs nothing. Called by
   * `SessionManager.restore()` before the refresh exchange.
   */
  hydrate?(): Promise<void>;

  /** Settle queued writes (async backends). Optional; never rejects. */
  flush?(): Promise<void>;
}

/**
 * In-memory adapter — the test double and the documented fallback when no
 * platform storage exists (web private mode already degrades to memory-only
 * because its adapter's storage calls are try/caught).
 */
export function createMemoryTokenStorage(
  initial: StoredTokenPair | null = null,
): TokenStorage & { snapshot(): StoredTokenPair | null } {
  let pair: StoredTokenPair | null = initial === null ? null : { ...initial };
  return {
    read() {
      return pair === null ? null : { ...pair };
    },
    write(next) {
      pair = next === null ? null : { ...next };
    },
    snapshot() {
      return pair === null ? null : { ...pair };
    },
  };
}
