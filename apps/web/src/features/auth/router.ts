/**
 * U19 — minimal hash router (react-router NOT installed at this layer; the
 * plan keeps web dependencies pinned). Routes:
 *   #/login, #/register, #/verify-email?token=..., #/forgot-password,
 *   #/reset-password?token=..., '' (app shell placeholder).
 */

import { useSyncExternalStore, useCallback } from 'react';

function subscribe(callback: () => void): () => void {
  globalThis.addEventListener('hashchange', callback);
  return () => globalThis.removeEventListener('hashchange', callback);
}

function getSnapshot(): string {
  return globalThis.location?.hash ?? '';
}

export interface HashRoute { path: string; query: URLSearchParams; navigate(to: string): void; }

export function useHashRoute(): HashRoute {
  const hash = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const [path, queryPart = ''] = raw.split('?');

  const navigate = useCallback((to: string) => {
    globalThis.location.hash = to;
  }, []);

  return { path: path || '/', query: new URLSearchParams(queryPart), navigate };
}
