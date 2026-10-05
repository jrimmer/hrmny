/**
 * @cytale/mobile — shell surface states (plan 004 M5, R15).
 *
 * The states-first contract the repo holds every unit to: loading / empty /
 * error / offline / view-only / permission-denied are first-class, announced
 * states — not missing renders. The shell owns the vocabulary; screens and
 * later units (M6 message list, M7 composer, M9 gateway) feed it.
 *
 * `shellState` is a tiny external store (the same shape as @cytale/state's
 * `defaultStore`, hand-rolled because zustand is not a direct dependency of
 * apps/mobile). Surfaces read it via `useSurfaceStates()`; whoever learns the
 * truth writes it with `setSurfaceStates`. `resetSurfaceStates()` is the test
 * hygiene seam.
 *
 * Producers, as of the gateway wiring: `SessionProvider` writes `offline`
 * (gateway connectivity) and `viewOnly` (an authenticated account that has
 * not verified its email — web's `viewOnly={!authState.emailVerified}`).
 * `permissionDenied` is produced by `useChannelPermissions`
 * (`navigation/permissions.ts`): it resolves the current user's bits for the
 * active channel with `@cytale/domain`'s `resolveChannelPermissions` — the
 * workspace's roles via `GET /workspaces/{id}/roles` (cached per workspace)
 * over the roster's held role ids — and writes the denial when the
 * resolution is definitive and lacks VIEW_CHANNEL. It fails open while
 * unresolved, so a roles read still in flight or failed never denies. One
 * caveat: the api-client has no channel-overwrites read, so the resolver is
 * handed an empty overwrite list and a channel made private by an overwrite
 * cannot be detected until that read lands; a surface that learns denial
 * from a REST 403 may still set this state directly.
 * `loading`/`empty`/`error` are per-surface (they depend on each surface's
 * own fetch) and are written by the surfaces themselves. `hydrationError` +
 * `retryHydration` are the ONE app-wide failure: `SessionProvider`'s REST
 * bootstrap writes them when it cannot fetch the workspace list and the store
 * is left with nothing to render (code-review residual 3 — a failed launch
 * used to look like an empty drawer with no way out). They are deliberately
 * NOT `error`/`retry`: a surface that does not depend on the workspace graph
 * (settings) spreads `shared` and must not be blanked by a bootstrap failure.
 * The drawer and the surfaces that render the shared states verbatim
 * (Home/Integrations/Diagnostics) render the pair; a surface with its own
 * `states` keeps its own truth.
 */
import { useSyncExternalStore } from 'react';

/** The six states, all optional — absent means "normal". */
export interface SurfaceStates {
  /** Bootstrapping: skeleton + announced progressbar. */
  loading?: boolean;
  /** Nothing to show (no channels, no messages, no members). */
  empty?: boolean;
  /** Load failure detail (rendered in an alert). */
  error?: string | null;
  /**
   * The REST bootstrap could not fetch the workspace list, so the shell has
   * nothing to render. App-wide, unlike `error`.
   */
  hydrationError?: string | null;
  /** Re-runs the bootstrap behind `hydrationError` (the error's Retry). */
  retryHydration?: (() => void) | null;
  /** Gateway offline — persistent status banner. */
  offline?: boolean;
  /** Authenticated but not allowed to send in this surface. */
  viewOnly?: boolean;
  /** Hard permission denial detail for the surface. */
  permissionDenied?: string | null;
}

type Listener = () => void;

const listeners = new Set<Listener>();
let current: SurfaceStates = {};
let snapshot: SurfaceStates = {};

function emit(): void {
  snapshot = { ...current };
  for (const listener of listeners) listener();
}

/** Merge states into the shell surface state (partial writes, no clears). */
export function setSurfaceStates(patch: SurfaceStates): void {
  const next: SurfaceStates = { ...current };
  let changed = false;
  for (const key of Object.keys(patch) as (keyof SurfaceStates)[]) {
    const value = patch[key];
    if (value === undefined) continue;
    if (!Object.is(next[key], value)) {
      (next as Record<string, unknown>)[key] = value;
      changed = true;
    }
  }
  if (!changed) return;
  current = next;
  emit();
}

/** Drop every override (tests; sign-out). */
export function resetSurfaceStates(): void {
  if (Object.keys(current).length === 0) return;
  current = {};
  emit();
}

/** Read the current surface states (non-React callers). */
export function getSurfaceStates(): SurfaceStates {
  return snapshot;
}

/** Subscribe a component to the shell surface states. */
export function useSurfaceStates(): SurfaceStates {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
    () => snapshot,
  );
}
