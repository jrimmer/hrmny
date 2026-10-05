/**
 * U19 — React binding for the auth session. Components read auth state via
 * useSyncExternalStore (tear-free reads of the zustand vanilla store) and
 * act through the SessionManager.
 */

import { useSyncExternalStore, useCallback } from 'react';

import type { AuthState } from './authStore.js';
import type { AuthTokens } from '@cytale/api-client';
import { authStore, session } from './session.js';

function subscribe(callback: () => void): () => void {
  return authStore.subscribe(callback);
}

function getSnapshot(): AuthState {
  return authStore.getState();
}

export interface UseAuth {
  state: AuthState;
  login(identifier: string, password: string): Promise<void>;
  /** #36: establish the session from a passkey login's already-minted pair. */
  loginWithTokens(tokens: AuthTokens): Promise<void>;
  register(username: string, email: string, password: string, inviteCode?: string): Promise<void>;
  verifyEmail(token: string): Promise<void>;
  resendVerification(): Promise<void>;
  requestPasswordReset(email: string): Promise<void>;
  completePasswordReset(token: string, newPassword: string): Promise<void>;
  refreshTokens(): Promise<void>;
  shouldRefreshProactively(): boolean;
  logout(): Promise<void>;
  restore(): Promise<void>;
}

export function useAuth(): UseAuth {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const login = useCallback(async (identifier: string, password: string) => {
    await session.login(identifier, password);
  }, []);

  const loginWithTokens = useCallback(async (tokens: AuthTokens) => {
    await session.loginWithTokens(tokens);
  }, []);

  const register = useCallback(
    async (username: string, email: string, password: string, inviteCode?: string) => {
      await session.register(username, email, password, inviteCode);
    },
    [],
  );

  const verifyEmail = useCallback(async (token: string) => {
    await session.verifyEmail(token);
  }, []);

  const resendVerification = useCallback(async () => {
    await session.resendVerification();
  }, []);

  const requestPasswordReset = useCallback(async (email: string) => {
    await session.requestPasswordReset(email);
  }, []);

  const completePasswordReset = useCallback(async (token: string, newPassword: string) => {
    await session.completePasswordReset(token, newPassword);
  }, []);

  const refreshTokens = useCallback(async () => {
    await session.refreshTokens();
  }, []);

  const shouldRefreshProactively = useCallback(() => {
    return session.shouldRefreshProactively();
  }, []);

  const logout = useCallback(async () => {
    await session.logout();
  }, []);

  const restore = useCallback(async () => {
    await session.restore();
  }, []);

  return {
    state,
    login,
    loginWithTokens,
    register,
    verifyEmail,
    resendVerification,
    requestPasswordReset,
    completePasswordReset,
    refreshTokens,
    shouldRefreshProactively,
    logout,
    restore,
  };
}
