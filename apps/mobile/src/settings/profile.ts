/**
 * @cytale/mobile — profile convergence (plan 004 M10, R14).
 *
 * `PATCH /users/@me` returns the `{ user }` envelope raw (the api-client types
 * it flat — the same drift `session.restore()` unwraps), so the section
 * normalizes before writing state. The roster write is web's exact convergence
 * (`AuthenticatedApp.handleSaveProfile`): the user's own member row picks up
 * the new display name immediately instead of waiting for a refetch.
 */
import type { CurrentUser } from '@cytale/api-client';

import type { SettingsStore } from './services';

/**
 * Accept both wire shapes: the `{ user }` envelope the server sends and the
 * flat `CurrentUser` the client's type promises (legacy seeds/tests).
 */
export function unwrapUser(response: unknown): CurrentUser | null {
  if (response === null || typeof response !== 'object') return null;
  const envelope = response as { user?: CurrentUser | null };
  if (envelope.user !== undefined && envelope.user !== null && typeof envelope.user === 'object') {
    return envelope.user;
  }
  const flat = response as CurrentUser;
  return typeof flat.id === 'string' ? flat : null;
}

/** Converge the caller's own roster row to the saved display name. */
export function convergeRoster(
  store: SettingsStore,
  userId: string | null | undefined,
  displayName: string,
): void {
  if (userId === null || userId === undefined) return;
  store.setState((state) => {
    const row = state.membersById[userId];
    if (row === undefined) return state;
    // The display name, never the nickname: a nickname is per-workspace and
    // the row is shared (#169).
    return {
      membersById: { ...state.membersById, [userId]: { ...row, display_name: displayName || null } },
    };
  });
}

/** The verified flag, tolerating both wire shapes (boolean preferred). */
export function isVerified(user: CurrentUser | null): boolean {
  return user?.email_verified ?? (user?.email_verified_at != null);
}
