/**
 * @cytale/mobile — secure credential storage (plan 004 M4, KD3).
 *
 * The native `TokenStorage` implementation: the same token pair the web app
 * keeps in localStorage persists in iOS Keychain / Android Keystore via
 * `expo-secure-store`. Native has no XSS vector, and users expect to stay
 * signed in, so the storage posture deliberately diverges from web (KD3,
 * ratified 2026-09-09) — the session SEMANTICS do not: this adapter is the
 * only native-specific piece of the extracted `@cytale/session` orchestration
 * (R4/R6 ride the shared code unchanged).
 *
 * The factory takes the SecureStore module as a parameter (structural type)
 * so it is testable without the native module installed, and so the
 * `expo-secure-store` import stays confined to `./secureStorage.ts`.
 *
 * Async → sync bridge: `expo-secure-store` reads are async, but the auth
 * store's `getRefreshToken()` is synchronous by contract (the web store reads
 * localStorage live). `hydrate()` loads both keys into an in-memory mirror
 * that `read()` serves; `SessionManager.restore()` awaits `hydrate()` before
 * the cold-launch refresh exchange (R5). Writes update the mirror immediately
 * and are queued to SecureStore in order; `flush()` is the durability
 * barrier (`SessionManager` awaits it after login/refresh/logout).
 *
 * Failure posture matches web's localStorage helpers: a failing keychain
 * read/write never breaks the in-memory session, and `flush()` never rejects.
 */

import type { StoredTokenPair, TokenStorage } from '@cytale/session';

/**
 * Write options for a SecureStore `setItemAsync` call. Only the subset this
 * adapter sets is modelled (structural type — no `expo-secure-store` import).
 */
export interface SecureStoreWriteOptions {
  /**
   * iOS `kSecAttrAccessible`. We always request
   * `WHEN_UNLOCKED_THIS_DEVICE_ONLY`: `WHEN_UNLOCKED` (the module's default)
   * entries are included in encrypted backups and MIGRATE on restore, so a
   * restored backup would carry a working 30-day refresh token to the new
   * device. `..._THIS_DEVICE_ONLY` entries never leave the device.
   * Ignored on Android (its record has no such field).
   */
  keychainAccessible?: number;
}

/** The subset of `expo-secure-store` this adapter consumes. */
export interface SecureStoreLike {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: SecureStoreWriteOptions): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
  /**
   * iOS accessibility constant (`SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY`).
   * Optional: the module only defines it on iOS, and test doubles may omit it.
   */
  WHEN_UNLOCKED_THIS_DEVICE_ONLY?: number;
}

/** SecureStore keys (the same names web uses in localStorage). */
export const ACCESS_TOKEN_KEY = 'cytale.access_token';
export const REFRESH_TOKEN_KEY = 'cytale.refresh_token';

export interface SecureTokenStorageOptions {
  accessKey?: string;
  refreshKey?: string;
  /**
   * Override the accessibility applied to every write. Defaults to the
   * module's `WHEN_UNLOCKED_THIS_DEVICE_ONLY`; pass `null` to omit the option
   * entirely.
   *
   * `requireAuthentication: true` (biometric/passcode gate) was considered for
   * the refresh key and deliberately NOT used: expo-secure-store prompts on
   * every read AND write, `hydrate()` runs on cold launch before the UI can
   * explain a prompt, Android requires authentication for every operation,
   * and iOS invalidates the entry whenever the enrolled biometrics change —
   * each of which turns a background token rotation into a silent sign-out.
   * Device-bound accessibility already removes the backup-migration vector;
   * a biometric gate is a UX contract the launch plan does not define.
   */
  keychainAccessible?: number | null;
}

/**
 * Build the native `TokenStorage` over a SecureStore-like module.
 *
 * `read()` is null until `hydrate()` resolves (or a write lands) — the
 * SessionManager always hydrates before restoring, so a cold launch sees the
 * persisted pair.
 */
export function createSecureTokenStorage(
  store: SecureStoreLike,
  options: SecureTokenStorageOptions = {},
): TokenStorage {
  const accessKey = options.accessKey ?? ACCESS_TOKEN_KEY;
  const refreshKey = options.refreshKey ?? REFRESH_TOKEN_KEY;

  // F4: every keychain write is device-bound. Resolved once at construction:
  // the module supplies the iOS constant; a module without one (Android, test
  // doubles) yields no option, which is a no-op there.
  const accessible =
    options.keychainAccessible === null
      ? undefined
      : options.keychainAccessible ?? store.WHEN_UNLOCKED_THIS_DEVICE_ONLY;
  const writeOptions: SecureStoreWriteOptions | undefined =
    accessible === undefined ? undefined : { keychainAccessible: accessible };

  let mirror: StoredTokenPair | null = null;
  /** Serialized write chain — SecureStore ops must not interleave. */
  let queue: Promise<void> = Promise.resolve();

  function enqueue(task: () => Promise<void>): Promise<void> {
    const next = queue.then(task, task).catch(() => undefined);
    queue = next;
    return next;
  }

  return {
    read(): StoredTokenPair | null {
      return mirror === null ? null : { ...mirror };
    },

    write(pair: StoredTokenPair | null): Promise<void> {
      const next =
        pair === null
          ? null
          : {
              accessToken: pair.accessToken === '' ? null : pair.accessToken,
              refreshToken: pair.refreshToken === '' ? null : pair.refreshToken,
            };
      // The mirror updates synchronously so the in-memory session is never
      // blocked on the keychain; the queued task is the durable copy.
      mirror = next;
      return enqueue(async () => {
        // Each key is applied independently: a keychain failure on one key
        // must not skip the other. Skipping the refresh-token delete leaves a
        // credential that silently re-authenticates the user on the next cold
        // launch; skipping the refresh-token write loses half the pair.
        // Both writes carry `keychainAccessible` (see writeOptions above).
        await Promise.allSettled([
          next?.accessToken
            ? store.setItemAsync(accessKey, next.accessToken, writeOptions)
            : store.deleteItemAsync(accessKey),
          next?.refreshToken
            ? store.setItemAsync(refreshKey, next.refreshToken, writeOptions)
            : store.deleteItemAsync(refreshKey),
        ]);
      });
    },

    async hydrate(): Promise<void> {
      const [accessToken, refreshToken] = await Promise.all([
        store.getItemAsync(accessKey),
        store.getItemAsync(refreshKey),
      ]);
      // Never clobber a newer in-memory write with stale storage (a hydrate
      // racing a login would otherwise resurrect the previous session).
      if (mirror !== null) return;
      mirror =
        accessToken === null && refreshToken === null ? null : { accessToken, refreshToken };
    },

    async flush(): Promise<void> {
      await queue;
    },
  };
}
