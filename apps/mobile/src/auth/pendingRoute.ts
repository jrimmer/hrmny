/**
 * @cytale/mobile — the deep link captured while signed out (plan 004 M12, R4).
 *
 * A deep link is an intent, not a route: `cytale://channel/<id>` opened on a
 * fresh install must land on sign-in and then RESUME at that channel, not
 * dump the user on Home. The root gate captures the intent here before it
 * redirects to `/sign-in`, and consumes it once the user is actually inside
 * the app.
 *
 * Deliberately module state, not React state: the intent must survive the
 * gate re-rendering between the capture and the replay, and it is per-app-run
 * (a cold launch with no link has nothing to resume). `clearPendingRoute()`
 * is the test-hygiene seam, matching `resetSurfaceStates()`.
 *
 * A deliberate sign-out needs one extra step. The gate captures whatever
 * surface it is showing whenever it renders signed out (`useAuthGate`), and a
 * sign-out render happens BEFORE the redirect to `/sign-in` — so clearing the
 * queue on sign-out alone would be undone by the gate re-capturing the screen
 * the member just left, and the next sign-in would land there instead of
 * Home. `clearPendingRouteOnSignOut()` therefore drops the queued intent AND
 * remembers that the next capture is that abandoned surface, not an intent.
 * An expiry-driven loss is not a choice and keeps both (R6).
 */

export interface PendingRoute {
  /** The in-app path the link asked for (`/channel/<id>`, `/thread/<id>`, …). */
  href: string;
}

let pending: PendingRoute | null = null;
/** The surface a deliberate sign-out left behind (the gate re-captures it). */
let abandonedOnSignOut: string | null = null;
/** True until the gate's first capture after a deliberate sign-out. */
let awaitingSignOutCapture = false;

/** Remember the deep link to resume after sign-in (last link wins). */
export function capturePendingRoute(href: string): void {
  if (awaitingSignOutCapture) {
    // The gate's signed-out render: this is the surface the member just left,
    // not an intent to resume. Remember it so its re-captures are dropped too.
    awaitingSignOutCapture = false;
    abandonedOnSignOut = href;
    return;
  }
  if (abandonedOnSignOut !== null && href === abandonedOnSignOut) return;
  abandonedOnSignOut = null;
  if (href === '' || href === '/') {
    // The app's default surface is not an intent worth resuming.
    return;
  }
  pending = { href };
}

/** The captured intent without consuming it. */
export function peekPendingRoute(): PendingRoute | null {
  return pending;
}

/** The captured intent, consumed exactly once. */
export function takePendingRoute(): PendingRoute | null {
  const route = pending;
  pending = null;
  // Back inside the app: the abandoned surface is no longer relevant.
  abandonedOnSignOut = null;
  return route;
}

/**
 * Drop any captured intent (tests; `clearPendingRouteOnSignOut` in the app).
 *
 * A plain reset: it clears the sign-out bookkeeping too, so a test that leaves
 * a sign-out behind cannot leak it into the next one.
 */
export function clearPendingRoute(): void {
  pending = null;
  abandonedOnSignOut = null;
  awaitingSignOutCapture = false;
}

/**
 * The deliberate-sign-out path (called by `watchSessionLoss`): drop the queued
 * intent AND the capture the gate's signed-out render is about to make of the
 * surface being left, so the next sign-in lands on Home. A deep link opened
 * later while signed out is still captured.
 */
export function clearPendingRouteOnSignOut(): void {
  clearPendingRoute();
  awaitingSignOutCapture = true;
}
