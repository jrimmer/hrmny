/**
 * @cytale/session — TokenStorage + auth store persistence (plan 004 M4).
 *
 * The storage seam is what makes web/native share one session implementation:
 * a pair written through the store must be readable by a fresh store over the
 * same storage (the cold-launch/restore contract), and clearing must remove
 * both halves.
 */
import { describe, expect, it } from 'vitest';

import { createAuthStore } from '../authStore.js';
import { createMemoryTokenStorage, type StoredTokenPair } from '../tokenStorage.js';

const PAIR: StoredTokenPair = { accessToken: 'access-1', refreshToken: 'refresh-1' };

describe('createMemoryTokenStorage', () => {
  it('round-trips a token pair', () => {
    const storage = createMemoryTokenStorage();
    expect(storage.read()).toBeNull();

    storage.write(PAIR);
    expect(storage.read()).toEqual(PAIR);

    storage.write(null);
    expect(storage.read()).toBeNull();
  });

  it('does not leak the internal pair through read()', () => {
    const storage = createMemoryTokenStorage(PAIR);
    const first = storage.read();
    expect(first).toEqual(PAIR);
    // Mutating the returned object must not corrupt the adapter's state.
    (first as StoredTokenPair).accessToken = 'tampered';
    expect(storage.read()).toEqual(PAIR);
  });
});

describe('auth store persistence', () => {
  it('setAuthenticated persists both halves; a cold store over the same storage reads them back', () => {
    const storage = createMemoryTokenStorage();
    const store = createAuthStore(storage);

    store.getState().setAuthenticated(
      { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 900 },
      { id: '1', username: 'tester', email: 't@example.com', email_verified_at: null },
    );

    expect(storage.read()).toEqual(PAIR);

    // Cold launch: a fresh store over the same backend (the SessionManager
    // builds a new store on every app start) sees the persisted pair.
    const cold = createAuthStore(storage);
    expect(cold.getState().getRefreshToken()).toBe('refresh-1');
  });

  it('updateTokens rotates the persisted pair and reset clears it', () => {
    const storage = createMemoryTokenStorage();
    const store = createAuthStore(storage);

    store.getState().updateTokens('access-1', 'refresh-1', 900);
    expect(storage.read()).toEqual(PAIR);

    store.getState().updateTokens('access-2', 'refresh-2', 900);
    expect(storage.read()).toEqual({ accessToken: 'access-2', refreshToken: 'refresh-2' });

    store.getState().reset();
    expect(storage.read()).toBeNull();
    expect(store.getState().getRefreshToken()).toBeNull();
  });

  it('treats an empty access token as absent (restore seeding path)', () => {
    const storage = createMemoryTokenStorage(PAIR);
    const store = createAuthStore(storage);

    // SessionManager.restore() seeds the last-seen access token, which may be
    // missing; web's writeStoredAccessToken('') cleared the key — same here.
    store.getState().updateTokens('', 'refresh-1', 0);

    expect(storage.read()).toEqual({ accessToken: null, refreshToken: 'refresh-1' });
    expect(store.getState().getRefreshToken()).toBe('refresh-1');
  });

  it('a failing storage backend never breaks the in-memory session', () => {
    const storage = {
      read: () => null,
      write: () => {
        throw new Error('keychain unavailable');
      },
    };
    const store = createAuthStore(storage);

    expect(() =>
      store.getState().updateTokens('access-1', 'refresh-1', 900),
    ).not.toThrow();
    expect(store.getState().getAccessToken()).toBe('access-1');
  });
});
