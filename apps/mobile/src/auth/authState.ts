/**
 * @cytale/mobile — auth-state bindings for the M12 surfaces (plan 004 M12).
 *
 * `@cytale/session`'s store is the single source of truth; these are the two
 * reads the auth screens need beyond `useAuthStatus()`: the signed-in user,
 * and the verified flag derived from it with the repo-wide tolerance for the
 * wire's two shapes (`email_verified` boolean vs `email_verified_at`).
 */
import { useSyncExternalStore } from 'react';

import type { CurrentUser } from '@cytale/api-client';
import type { SessionManager } from '@cytale/session';

/** The wire's verified flag, tolerating both shapes (settings/profile.ts rule). */
export function isVerified(user: CurrentUser | null): boolean {
  return user?.email_verified ?? (user?.email_verified_at != null);
}

/** Reactive read of the manager's current user. */
export function useAuthUser(session: SessionManager): CurrentUser | null {
  const store = session.authStore;
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getState().currentUser,
    () => store.getState().currentUser,
  );
}
