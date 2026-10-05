/**
 * @cytale/mobile — native secure-storage adapter (plan 004 M4, R5/KD3).
 *
 * The adapter is tested against a fake Keychain/Keystore (the SecureStore
 * module is a structural parameter) so this suite runs before the native
 * module is installed. It proves the contract the shared SessionManager
 * depends on: the pair round-trips, a cold launch hydrates it, and clearing
 * removes both entries.
 */
import {
  ACCESS_TOKEN_KEY,
  createSecureTokenStorage,
  REFRESH_TOKEN_KEY,
  type SecureStoreLike,
  type SecureStoreWriteOptions,
} from '../secureTokenStorage';

/**
 * In-memory stand-in for expo-secure-store (async, ordered, like the real one).
 * `failNextWrite`/`failNextDelete` take an optional key (default: the next op
 * on any key) so the partial-failure paths are exercisable per key.
 *
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY` mirrors the constant the real module
 * exposes (iOS `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`); `writes`
 * records the options each `setItemAsync` was called with.
 */
function fakeSecureStore(initial: Record<string, string> = {}): SecureStoreLike & {
  entries: Map<string, string>;
  writes: Array<{ key: string; options?: SecureStoreWriteOptions }>;
  failNextWrite: (key?: string) => void;
  failNextDelete: (key?: string) => void;
} {
  const entries = new Map(Object.entries(initial));
  /** Key whose next write rejects, `'*'` for any key, null for none. */
  let failWrite: string | null = null;
  let failDelete: string | null = null;
  const writes: Array<{ key: string; options?: SecureStoreWriteOptions }> = [];
  return {
    entries,
    writes,
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    failNextWrite: (key = '*') => {
      failWrite = key;
    },
    failNextDelete: (key = '*') => {
      failDelete = key;
    },
    async getItemAsync(key) {
      await Promise.resolve();
      return entries.get(key) ?? null;
    },
    async setItemAsync(key, value, options) {
      await Promise.resolve();
      writes.push({ key, options });
      if (failWrite === '*' || failWrite === key) {
        failWrite = null;
        throw new Error('keychain write failed');
      }
      entries.set(key, value);
    },
    async deleteItemAsync(key) {
      await Promise.resolve();
      if (failDelete === '*' || failDelete === key) {
        failDelete = null;
        throw new Error('keychain delete failed');
      }
      entries.delete(key);
    },
  };
}

describe('createSecureTokenStorage', () => {
  it('round-trips a token pair through the keychain', async () => {
    const store = fakeSecureStore();
    const storage = createSecureTokenStorage(store);

    await storage.write({ accessToken: 'access-1', refreshToken: 'refresh-1' });
    await storage.flush?.();

    expect(store.entries.get(ACCESS_TOKEN_KEY)).toBe('access-1');
    expect(store.entries.get(REFRESH_TOKEN_KEY)).toBe('refresh-1');
    expect(storage.read()).toEqual({ accessToken: 'access-1', refreshToken: 'refresh-1' });
  });

  it('survives a simulated cold start (hydrate → read)', async () => {
    const store = fakeSecureStore();

    // First app run: login persisted the pair.
    const firstRun = createSecureTokenStorage(store);
    await firstRun.write({ accessToken: 'access-1', refreshToken: 'refresh-1' });
    await firstRun.flush?.();

    // Cold launch: a fresh adapter (fresh process) sees nothing until hydrate.
    const cold = createSecureTokenStorage(store);
    expect(cold.read()).toBeNull();

    await cold.hydrate?.();

    expect(cold.read()).toEqual({ accessToken: 'access-1', refreshToken: 'refresh-1' });
  });

  it('hydrates to null when the keychain is empty', async () => {
    const storage = createSecureTokenStorage(fakeSecureStore());
    await storage.hydrate?.();
    expect(storage.read()).toBeNull();
  });

  it('clears both entries on write(null) (sign-out, R5)', async () => {
    const store = fakeSecureStore({ [ACCESS_TOKEN_KEY]: 'access-1', [REFRESH_TOKEN_KEY]: 'refresh-1' });
    const storage = createSecureTokenStorage(store);
    await storage.hydrate?.();

    await storage.write(null);
    await storage.flush?.();

    expect(store.entries.size).toBe(0);
    expect(storage.read()).toBeNull();
  });

  it('clears the surviving key when the first delete rejects (sign-out, R5)', async () => {
    const store = fakeSecureStore({ [ACCESS_TOKEN_KEY]: 'access-1', [REFRESH_TOKEN_KEY]: 'refresh-1' });
    const storage = createSecureTokenStorage(store);
    await storage.hydrate?.();

    // A keychain hiccup on the FIRST key must not skip the second: a refresh
    // token left in the Keychain re-authenticates the user on the next cold
    // launch, silently undoing the sign-out.
    store.failNextDelete(ACCESS_TOKEN_KEY);

    await storage.write(null);
    await storage.flush?.();

    expect(store.entries.has(REFRESH_TOKEN_KEY)).toBe(false);
    expect(storage.read()).toBeNull();
  });

  it('clears the mirror and resolves flush even when both deletes reject', async () => {
    const store = fakeSecureStore({ [ACCESS_TOKEN_KEY]: 'access-1', [REFRESH_TOKEN_KEY]: 'refresh-1' });
    const storage = createSecureTokenStorage(store);
    await storage.hydrate?.();

    store.failNextDelete(ACCESS_TOKEN_KEY);
    store.failNextDelete(REFRESH_TOKEN_KEY);

    await storage.write(null);
    await expect(storage.flush?.()).resolves.toBeUndefined();

    expect(storage.read()).toBeNull();
  });

  it('still writes the second key when the first keychain write rejects', async () => {
    const store = fakeSecureStore();
    const storage = createSecureTokenStorage(store);

    // The pair is only useful whole: one failed write must not skip the other.
    store.failNextWrite(ACCESS_TOKEN_KEY);

    await storage.write({ accessToken: 'access-1', refreshToken: 'refresh-1' });
    await storage.flush?.();

    expect(store.entries.get(REFRESH_TOKEN_KEY)).toBe('refresh-1');
    expect(storage.read()).toEqual({ accessToken: 'access-1', refreshToken: 'refresh-1' });
  });

  it('treats an empty token as absent (restore seeding path)', async () => {
    const store = fakeSecureStore({ [ACCESS_TOKEN_KEY]: 'access-1', [REFRESH_TOKEN_KEY]: 'refresh-1' });
    const storage = createSecureTokenStorage(store);
    await storage.hydrate?.();

    await storage.write({ accessToken: '', refreshToken: 'refresh-1' });
    await storage.flush?.();

    expect(store.entries.has(ACCESS_TOKEN_KEY)).toBe(false);
    expect(store.entries.get(REFRESH_TOKEN_KEY)).toBe('refresh-1');
  });

  it('serializes writes so the last rotation wins', async () => {
    const store = fakeSecureStore();
    const storage = createSecureTokenStorage(store);

    // Two rotations without awaiting the first — SecureStore ops must not
    // interleave (a stale pair landing last would resurrect a dead token).
    const first = storage.write({ accessToken: 'access-1', refreshToken: 'refresh-1' });
    const second = storage.write({ accessToken: 'access-2', refreshToken: 'refresh-2' });
    await Promise.all([first, second]);
    await storage.flush?.();

    expect(store.entries.get(ACCESS_TOKEN_KEY)).toBe('access-2');
    expect(store.entries.get(REFRESH_TOKEN_KEY)).toBe('refresh-2');
    expect(storage.read()).toEqual({ accessToken: 'access-2', refreshToken: 'refresh-2' });
  });

  it('keeps the in-memory session working when the keychain write fails', async () => {
    const store = fakeSecureStore();
    store.failNextWrite();
    const storage = createSecureTokenStorage(store);

    await storage.write({ accessToken: 'access-1', refreshToken: 'refresh-1' });

    // flush never rejects (web's localStorage failure posture) …
    await expect(storage.flush?.()).resolves.toBeUndefined();
    // … and the mirror still serves the live session.
    expect(storage.read()).toEqual({ accessToken: 'access-1', refreshToken: 'refresh-1' });
  });

  it('does not clobber a newer write when hydrate resolves late', async () => {
    const store = fakeSecureStore({ [ACCESS_TOKEN_KEY]: 'stale', [REFRESH_TOKEN_KEY]: 'stale-refresh' });
    const storage = createSecureTokenStorage(store);

    await storage.write({ accessToken: 'fresh', refreshToken: 'fresh-refresh' });
    await storage.hydrate?.();

    expect(storage.read()).toEqual({ accessToken: 'fresh', refreshToken: 'fresh-refresh' });
  });

  it('reads a custom key pair when configured', async () => {
    const store = fakeSecureStore();
    const storage = createSecureTokenStorage(store, { accessKey: 'a', refreshKey: 'r' });

    await storage.write({ accessToken: 'access-1', refreshToken: 'refresh-1' });
    await storage.flush?.();

    expect(store.entries.get('a')).toBe('access-1');
    expect(store.entries.get('r')).toBe('refresh-1');
  });

  it('writes every entry with the device-bound keychain accessibility (F4)', async () => {
    const store = fakeSecureStore();
    const storage = createSecureTokenStorage(store);

    await storage.write({ accessToken: 'access-1', refreshToken: 'refresh-1' });
    await storage.flush?.();

    // Both keys, every write: expo-secure-store defaults to WHEN_UNLOCKED
    // (kSecAttrAccessibleWhenUnlocked), which IS backed up and restored onto a
    // new device — a restored backup would carry a working 30-day refresh
    // token. THIS_DEVICE_ONLY entries never migrate.
    expect(store.writes).toHaveLength(2);
    for (const write of store.writes) {
      expect(write.options).toEqual({ keychainAccessible: 6 });
    }
    expect(store.writes.map((w) => w.key).sort()).toEqual([ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY]);

    // Rotations keep the posture (the common case: every refresh writes).
    store.writes.length = 0;
    await storage.write({ accessToken: 'access-2', refreshToken: 'refresh-2' });
    await storage.flush?.();
    expect(store.writes.map((w) => w.options)).toEqual([
      { keychainAccessible: 6 },
      { keychainAccessible: 6 },
    ]);
  });

  it('honours an explicit keychainAccessible override', async () => {
    const store = fakeSecureStore();
    const storage = createSecureTokenStorage(store, { keychainAccessible: 5 });

    await storage.write({ accessToken: 'access-1', refreshToken: 'refresh-1' });
    await storage.flush?.();

    expect(store.writes.map((w) => w.options)).toEqual([
      { keychainAccessible: 5 },
      { keychainAccessible: 5 },
    ]);
  });

  it('still writes on a module that exposes no accessibility constant (Android/web)', async () => {
    // Android's SecureStoreOptions has no `keychainAccessible` field at all
    // (the option is iOS-only) and its module exposes none of the constants:
    // an undefined option must not break the write path.
    const store = fakeSecureStore();
    delete (store as { WHEN_UNLOCKED_THIS_DEVICE_ONLY?: number }).WHEN_UNLOCKED_THIS_DEVICE_ONLY;
    const storage = createSecureTokenStorage(store);

    await storage.write({ accessToken: 'access-1', refreshToken: 'refresh-1' });
    await storage.flush?.();

    expect(store.entries.get(ACCESS_TOKEN_KEY)).toBe('access-1');
    expect(store.writes.map((w) => w.options)).toEqual([undefined, undefined]);
  });
});
