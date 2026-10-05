/**
 * @cytale/mobile — settings services (plan 004 M10).
 *
 * The sections' dependency seam. In production a section gets the app's ONE
 * session manager (`useSession()`), its real `CytaleApiClient` (`session.api`),
 * and `@cytale/state`'s `defaultStore` — the store the session hydrates, so a
 * profile save converges the same roster the member lists read.
 *
 * Tests inject `createSettingsServices(session, { api, store })` with a real
 * client on a stubbed transport (`fetchImpl`) and a real manager on memory
 * storage — the section code under test never knows the wire is fake.
 */
import { useMemo, useSyncExternalStore } from 'react';

import type { CurrentUser, CytaleApiClient } from '@cytale/api-client';
import type { AuthStore, SessionManager } from '@cytale/session';
import { defaultStore, type StateStore } from '@cytale/state';

import { useSession } from '../navigation/session';

/** The store slice the settings surfaces read/write (roster convergence). */
export type SettingsStore = Pick<StateStore, 'getState' | 'setState'>;

export interface SettingsServices {
  /** The app's real API client (`session.api` in production). */
  api: CytaleApiClient;
  /** The one session manager — sign-out-everywhere and log out ride it. */
  session: SessionManager;
  /** Roster convergence target (the session's store). */
  store: SettingsStore;
}

export interface SettingsServiceOverrides {
  api?: CytaleApiClient;
  store?: SettingsStore;
}

/** Build the services from a session manager; overrides are the test seam. */
export function createSettingsServices(
  session: SessionManager,
  overrides: SettingsServiceOverrides = {},
): SettingsServices {
  return {
    api: overrides.api ?? session.api,
    session,
    store: overrides.store ?? defaultStore,
  };
}

/** The production binding: one memoized services object per session. */
export function useSettingsServices(): SettingsServices {
  const session = useSession();
  return useMemo(() => createSettingsServices(session), [session]);
}

/**
 * Subscribe a section to the auth store's current user. The sections render
 * the identity the session owns; a save updates it, and this binding makes the
 * form re-seed from the fresh value.
 */
export function useCurrentUser(authStore: AuthStore): CurrentUser | null {
  return useSyncExternalStore(
    (onChange) => authStore.subscribe(onChange),
    () => authStore.getState().currentUser,
  );
}
