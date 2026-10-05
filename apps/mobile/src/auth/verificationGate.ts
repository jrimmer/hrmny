/**
 * @cytale/mobile — the verification gate's state (plan 004 M12, R6).
 *
 * R6 wants an unverified account to SEE the gate, not to be silently stuck.
 * The gate is shown when the member JUST signed in (a login or register this
 * app run) and the account is unverified — a cold launch that restores an
 * unverified session is not nagged. Web's semantics stay intact: acknowledging
 * the gate puts the member back in the app read-only, which M5's `viewOnly`
 * producer enforces exactly as on the web.
 *
 * Module state, not React state: the root layout can be remounted by the
 * navigator, and the fact that "the user just signed in" must survive that.
 * `resetVerificationGate()` runs on sign-out (and in tests).
 */
import { useSyncExternalStore } from 'react';

type Listener = () => void;

const listeners = new Set<Listener>();
let freshSignIn = false;
let dismissed = false;
/** Stable snapshot: `useSyncExternalStore` re-renders forever on a new object. */
let snapshot: VerificationGateState = { freshSignIn, dismissed };

function emit(): void {
  snapshot = { freshSignIn, dismissed };
  for (const listener of listeners) listener();
}

/** A login/register completed in this app run (called by the auth screens). */
export function markFreshSignIn(): void {
  if (freshSignIn) return;
  freshSignIn = true;
  emit();
}

/** "Continue read-only": stop showing the gate for this session. */
export function dismissVerificationGate(): void {
  if (dismissed) return;
  dismissed = true;
  emit();
}

export function isVerificationGateDismissed(): boolean {
  return dismissed;
}

export interface VerificationGateState {
  /** A login/register happened in this app run. */
  freshSignIn: boolean;
  /** The member acknowledged the gate for this session. */
  dismissed: boolean;
}

function getSnapshot(): VerificationGateState {
  return snapshot;
}

/** Reactive read for the root gate. */
export function useVerificationGate(): VerificationGateState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot,
    getSnapshot,
  );
}

/** Sign-out (and test hygiene): a new session starts unacknowledged. */
export function resetVerificationGate(): void {
  if (!freshSignIn && !dismissed) return;
  freshSignIn = false;
  dismissed = false;
  emit();
}
