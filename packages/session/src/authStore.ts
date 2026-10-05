/**
 * @cytale/session — auth state slice (extracted from apps/web U19 authStore,
 * plan 004 M4).
 *
 * Holds the auth session surface the whole app reads:
 *   isAuthenticated, currentUser, emailVerified, tokens, status.
 *
 * Persistence is the injected `TokenStorage` (KTD4): web keeps its documented
 * localStorage tradeoff (both tokens persisted + short-lived access +
 * server-side rotation limiting the replay window); native persists the same
 * pair in platform secure storage (KD3).
 *
 * The access token is also held in memory because the api-client's request
 * path reads it synchronously through a promise wrapper; the persisted copy
 * exists so a cold launch can restore the session — the refresh contract
 * identifies the user by the (expired-OK) access JWT in the Authorization
 * header, so the refresh body alone cannot restore a session.
 */

import { createStore } from 'zustand/vanilla';

import type { CurrentUser, StoredTokens } from '@cytale/api-client';

import type { StoredTokenPair, TokenStorage } from './tokenStorage.js';

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

export interface AuthState {
  status: AuthStatus;
  currentUser: CurrentUser | null;
  emailVerified: boolean;
  /** Live access token (mirrored to storage as last-seen; see below). */
  accessToken: string | null;
  /** Access token expiry in ms since epoch (0 = unknown). */
  accessExpiresAt: number;
  /** Server-reported TTL seconds for the access token (for proactive refresh). */
  expiresIn: number;

  isAuthenticated(): boolean;

  setAuthenticated(tokens: StoredTokens, user: CurrentUser): void;
  setVerified(verified: boolean): void;
  updateTokens(access: string, refresh: string, expiresIn: number): void;
  setAccessToken(access: string, expiresIn: number): void;
  getAccessToken(): string | null;
  getRefreshToken(): string | null;
  setUser(user: CurrentUser): void;
  setStatus(status: AuthStatus): void;
  reset(): void;
}

/**
 * Persist a pair, tolerating storage failures exactly as web's localStorage
 * helpers do (a broken backend degrades to memory-only auth, it never breaks
 * the session). Async adapters are fire-and-forget here; `flush()` is the
 * durability barrier.
 */
function persist(storage: TokenStorage, pair: StoredTokenPair | null): void {
  // Empty-string tokens mean "absent" (web clears the key on ''), so the
  // adapter never has to special-case the restore() seeding path.
  const normalized =
    pair === null
      ? null
      : {
          accessToken: pair.accessToken === '' ? null : pair.accessToken,
          refreshToken: pair.refreshToken === '' ? null : pair.refreshToken,
        };
  try {
    void Promise.resolve(storage.write(normalized)).catch(() => undefined);
  } catch {
    // ignore storage failures — auth still works in-memory for the session
  }
}

export function createAuthStore(storage: TokenStorage) {
  const store = createStore<AuthState>()((set, get) => ({
    status: 'loading',
    currentUser: null,
    emailVerified: false,
    accessToken: null,
    accessExpiresAt: 0,
    expiresIn: 0,

    isAuthenticated: () => get().accessToken !== null,

    setAuthenticated(tokens, user) {
      persist(storage, { accessToken: tokens.access_token, refreshToken: tokens.refresh_token });
      set({
        status: 'authenticated',
        currentUser: user,
        emailVerified: user.email_verified_at !== null,
        accessToken: tokens.access_token,
        accessExpiresAt: Date.now() + tokens.expires_in * 1000,
        expiresIn: tokens.expires_in,
      });
    },

    setVerified(verified) {
      set((s) => ({
        emailVerified: verified,
        currentUser: s.currentUser
          ? { ...s.currentUser, email_verified_at: verified ? (s.currentUser.email_verified_at ?? new Date().toISOString()) : null }
          : s.currentUser,
      }));
    },

    updateTokens(access, refresh, expiresIn) {
      persist(storage, { accessToken: access, refreshToken: refresh });
      set({
        accessToken: access,
        accessExpiresAt: Date.now() + expiresIn * 1000,
        expiresIn,
      });
    },

    setAccessToken(access, expiresIn) {
      set({
        accessToken: access,
        accessExpiresAt: Date.now() + expiresIn * 1000,
        expiresIn,
      });
    },

    getAccessToken() {
      return get().accessToken;
    },

    getRefreshToken() {
      // Read through storage (not a cached field) — the same live-read
      // semantics web's `readStoredRefreshToken()` had, so an out-of-band
      // write (web tests seed tokens directly) is honoured.
      return storage.read()?.refreshToken ?? null;
    },

    setUser(user) {
      // The wire's own boolean wins; `email_verified_at` is the legacy shape.
      // Reading only the legacy key made this always true (the key is absent).
      set({
        currentUser: user,
        emailVerified: user.email_verified ?? (user.email_verified_at != null),
      });
    },

    setStatus(status) {
      set({ status });
    },

    reset() {
      persist(storage, null);
      set({
        status: 'unauthenticated',
        currentUser: null,
        emailVerified: false,
        accessToken: null,
        accessExpiresAt: 0,
        expiresIn: 0,
      });
    },
  }));

  return store;
}

export type AuthStore = ReturnType<typeof createAuthStore>;
