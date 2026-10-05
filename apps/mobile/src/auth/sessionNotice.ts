/**
 * @cytale/mobile — why the sign-in screen is being shown (plan 004 M12, R6).
 *
 * A cold launch lands on sign-in with no explanation needed. An in-session
 * loss — the refresh token was revoked or expired, or the user signed out
 * elsewhere — needs one: R6's "actionable path" starts with telling the user
 * their session ended. `SessionManager` already carries that reason into
 * `logout(reason)` but the auth store drops it, so the watcher
 * (`useSessionWatch`) records it here and the sign-in screen reads it.
 *
 * Module state, like the shell's surface states: the notice is written by the
 * root gate before the sign-in screen mounts, so a React-only store would
 * miss the transition. `resetSessionNotice()` is the test-hygiene seam.
 */
import { useSyncExternalStore } from 'react';

import type { SessionManager } from '@cytale/session';

import { clearPendingRouteOnSignOut } from './pendingRoute';
import { resetVerificationGate } from './verificationGate';

export interface SessionNotice {
  /** Message to render above the sign-in form. */
  message: string;
}

/** Shown when the manager did not supply its own reason (deliberate sign-out). */
export const DEFAULT_SIGNED_OUT_MESSAGE = 'You have been signed out. Sign in to continue.';

/** Shown when the session died without a `logout()` call (refresh rejected). */
export const SESSION_EXPIRED_MESSAGE = 'Your session expired. Please sign in again.';

type Listener = () => void;

const listeners = new Set<Listener>();
let current: SessionNotice | null = null;

function emit(): void {
  for (const listener of listeners) listener();
}

/** Record the reason the next sign-in screen must explain. */
export function recordSessionNotice(message: string): void {
  if (current !== null && current.message === message) return;
  current = { message };
  emit();
}

/** Clear the notice — a successful sign-in, or a fresh deliberate sign-out. */
export function clearSessionNotice(): void {
  if (current === null) return;
  current = null;
  emit();
}

export function getSessionNotice(): SessionNotice | null {
  return current;
}

/** Reactive read for the sign-in screen. */
export function useSessionNotice(): SessionNotice | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSessionNotice,
    getSessionNotice,
  );
}

/** Test hygiene: back to "cold launch, nothing to explain". */
export function resetSessionNotice(): void {
  current = null;
}

/**
 * Watch one manager for an in-session loss. Returns the teardown.
 *
 * The reason is captured by wrapping the manager's `logout` for the lifetime
 * of the watch. That is instrumentation, not session logic: the wrapper
 * records the argument and delegates, and the original method is restored on
 * teardown. No new session behaviour is introduced (R4).
 *
 * The wrapper also drops a queued deep link on a member-initiated sign-out:
 * the gate captures the surface being left as the tree goes signed out, so
 * without this the next sign-in would resume at Settings instead of Home. An
 * expiry-driven loss is not a choice — the manager issues it through
 * `logout(SESSION_EXPIRED_MESSAGE)` (the api layer's `onLogout`) or through a
 * bare store reset — and neither is the `logout()` that cleans up a sign-in
 * whose `/users/@me` failed; both keep the intent to be resumed after re-auth.
 */
export function watchSessionLoss(session: SessionManager): () => void {
  /** The last `logout(reason)` the manager (or a screen) issued. */
  let reason: string | null = null;

  const originalLogout = session.logout.bind(session);
  session.logout = async (logoutReason?: string): Promise<void> => {
    reason = logoutReason ?? DEFAULT_SIGNED_OUT_MESSAGE;
    // Deliberate = a live session the member chose to end. The expiry hard
    // logout carries the expiry copy, and the failed-sign-in cleanup runs
    // while the store was never authenticated.
    const deliberate =
      logoutReason !== SESSION_EXPIRED_MESSAGE &&
      session.authStore.getState().status === 'authenticated';
    if (deliberate) {
      clearPendingRouteOnSignOut();
    }
    await originalLogout(logoutReason);
  };

  const unsubscribe = session.authStore.subscribe((state, previous) => {
    if (state.status === 'authenticated') {
      // A live session has nothing to explain; the next loss starts clean.
      reason = null;
      clearSessionNotice();
      return;
    }
    if (previous.status !== 'authenticated' || state.status !== 'unauthenticated') return;
    // The session is over: a later sign-in is a new one, gate included.
    resetVerificationGate();
    // An in-session loss: refresh rejected without a logout call means the
    // credential died; otherwise the manager's own reason is the truth.
    recordSessionNotice(reason ?? SESSION_EXPIRED_MESSAGE);
  });

  return () => {
    unsubscribe();
    session.logout = originalLogout;
  };
}
