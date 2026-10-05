/**
 * U19 — auth state slice, web binding (plan 004 M4 extraction).
 *
 * The store logic now lives in `@cytale/session` (shared with the native
 * client); this module is the WEB adapter: it supplies the localStorage-backed
 * `TokenStorage` and re-exports the store factory/types so existing web
 * imports (`createAuthStore`, `readStoredRefreshToken`, `AuthState`, …) keep
 * working unchanged.
 *
 * Token storage strategy (documented tradeoff, unchanged): the ACCESS token is
 * mirrored to localStorage as the last-seen token (short 15-min TTL limits
 * blast radius) because the U9 refresh contract identifies the user by the
 * (expired-OK) access JWT in the Authorization header — without a persisted
 * copy, a page reload cannot restore the session. The REFRESH token lives in
 * localStorage too (30-day TTL; localStorage is readable to any XSS payload,
 * but httpOnly cookies are not viable for the gateway Identify flow this
 * launch, which needs the raw token client-side). Both tokens in localStorage
 * + short-lived access + server-side rotation limiting the replay window.
 *
 * Native diverges deliberately (KD3): the same pair persists in iOS Keychain /
 * Android Keystore instead, where the XSS vector does not exist.
 */

import { isTauri } from '../../tauri/index.js';
import { tauriTokenStorage } from './tauriTokenStorage.js';

import {
  createAuthStore as createSharedAuthStore,
  type AuthStore,
  type AuthState,
  type AuthStatus,
  type StoredTokenPair,
  type TokenStorage,
} from '@cytale/session';

export type { AuthState, AuthStatus, AuthStore, StoredTokenPair, TokenStorage };

const REFRESH_KEY = 'cytale.refresh_token';
const ACCESS_KEY = 'cytale.access_token';

/** Read the persisted refresh token (localStorage; see tradeoff above). */
export function readStoredRefreshToken(): string | null {
  try {
    return globalThis.localStorage?.getItem(REFRESH_KEY) ?? null;
  } catch {
    return null; // storage unavailable (private mode, SSR, tests)
  }
}

/**
 * Last-seen access token (localStorage). The U9 refresh contract requires an
 * (expired OK) access token in the Authorization header to identify the user;
 * the refresh body alone carries no user claim.
 */
export function readStoredAccessToken(): string | null {
  try {
    return globalThis.localStorage?.getItem(ACCESS_KEY) ?? null;
  } catch {
    return null;
  }
}

export function writeStoredAccessToken(token: string | null): void {
  try {
    if (token === null || token === '') {
      globalThis.localStorage?.removeItem(ACCESS_KEY);
    } else {
      globalThis.localStorage?.setItem(ACCESS_KEY, token);
    }
  } catch {
    // ignore storage failures
  }
}

/** Persist or clear the refresh token. */
export function writeStoredRefreshToken(token: string | null): void {
  try {
    if (token === null || token === '') {
      globalThis.localStorage?.removeItem(REFRESH_KEY);
    } else {
      globalThis.localStorage?.setItem(REFRESH_KEY, token);
    }
  } catch {
    // ignore storage failures — auth still works in-memory for the session
  }
}

/**
 * The web `TokenStorage`: localStorage, fully synchronous, so `hydrate` and
 * `flush` are unnecessary (reads are live and writes land immediately).
 */
export const webTokenStorage: TokenStorage = {
  read(): StoredTokenPair | null {
    const accessToken = readStoredAccessToken();
    const refreshToken = readStoredRefreshToken();
    return accessToken === null && refreshToken === null ? null : { accessToken, refreshToken };
  },
  write(pair: StoredTokenPair | null): void {
    writeStoredAccessToken(pair?.accessToken ?? null);
    writeStoredRefreshToken(pair?.refreshToken ?? null);
  },
};

/** Web-bound store factory (same no-arg signature as before the extraction). */
export function createAuthStore(): AuthStore {
  return createSharedAuthStore(isTauri() ? tauriTokenStorage() : webTokenStorage);
}
