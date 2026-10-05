/**
 * @cytale/mobile — the root auth gate (plan 004 M12, R4/R6).
 *
 * One hook owns every decision the root layout makes about identity:
 *
 *   `loading`        → splash (restore has not settled; nothing else is safe)
 *   `unauthenticated` → `/sign-in`, capturing the deep link that was asked for
 *   signed in, unverified, just signed in → `/verify-email` (the gate R6 names)
 *   `authenticated`  → the drawer, resuming any captured deep link first
 *
 * It also records WHY a session ended (see `useSessionWatch`) so the sign-in
 * screen can explain a revoked session instead of silently looping.
 *
 * The hook is deliberately router-aware but render-free: `app/_layout.tsx`
 * decides what to draw from the returned phase, and tests can drive the same
 * decisions through `renderRouter` on the real app tree.
 */
import { useEffect } from 'react';
import { router, useGlobalSearchParams, usePathname } from 'expo-router';

import { ROUTES } from '../navigation/routes';
import { useAuthStatus, useSession, useSessionRestored } from '../navigation/session';
import { isVerified, useAuthUser } from './authState';
import { capturePendingRoute, takePendingRoute } from './pendingRoute';
import { AUTH_ROUTES, isAuthRoute, isVerificationRoute, pendingHref } from './routes';
import { useVerificationGate } from './verificationGate';
import { useSessionWatch } from './useSessionWatch';

export type AuthGatePhase = 'restoring' | 'signed-out' | 'verify-required' | 'signed-in';

export interface AuthGate {
  phase: AuthGatePhase;
  /**
   * True while the gate is moving the router to where the phase belongs. The
   * layout draws the splash instead of a surface so a deep link never flashes
   * a screen the user is not allowed to see (the `+not-found` the router
   * resolves an unavailable route to, or the drawer on a fresh install).
   */
  redirecting: boolean;
}

export function useAuthGate(): AuthGate {
  const session = useSession();
  const status = useAuthStatus();
  const restored = useSessionRestored();
  const pathname = usePathname();
  const params = useGlobalSearchParams();

  useSessionWatch();
  const gate = useVerificationGate();

  const user = useAuthUser(session);
  const verified = isVerified(user);
  const signedIn = status === 'authenticated';

  /**
   * R6's gate: an unverified account that JUST signed in (the auth screens
   * mark that) sees the verification screen, unless it already chose to
   * continue read-only. A cold launch that restores an unverified session is
   * not nagged — `markFreshSignIn` never ran.
   */
  const verifyRequired = signedIn && !verified && gate.freshSignIn && !gate.dismissed;

  // Capture the deep link while signed out: it is the user's intent, and the
  // redirect below is about to erase the URL that expresses it.
  useEffect(() => {
    if (!restored || signedIn) return;
    if (isAuthRoute(pathname)) return;
    capturePendingRoute(pendingHref(pathname, params));
  }, [restored, signedIn, pathname, params]);

  // Move the router to where the phase belongs, and resume a captured link
  // once the user is actually allowed into the app.
  useEffect(() => {
    if (!restored) return;

    if (!signedIn) {
      if (!isAuthRoute(pathname)) router.replace(AUTH_ROUTES.signIn as never);
      return;
    }

    if (verifyRequired) {
      if (!isVerificationRoute(pathname)) router.replace(AUTH_ROUTES.verifyEmail as never);
      return;
    }

    const pending = takePendingRoute();
    if (pending !== null) {
      router.replace(pending.href as never);
      return;
    }

    // Sign-in / sign-up are never a destination for a signed-in member. The
    // verification screen is: it is also the emailed-token landing, and the
    // member may have opened that link while already signed in.
    if (isAuthRoute(pathname) && !isVerificationRoute(pathname)) {
      router.replace(ROUTES.home as never);
    }
  }, [restored, signedIn, verifyRequired, pathname]);

  const phase: AuthGatePhase = !restored
    ? 'restoring'
    : signedIn
      ? verifyRequired
        ? 'verify-required'
        : 'signed-in'
      : 'signed-out';

  // Only `/verify-email` is allowed to render for a signed-in user outside the
  // drawer: it is both the verification gate and the emailed-token landing.
  const redirecting =
    phase === 'restoring' ||
    (phase === 'signed-out' && !isAuthRoute(pathname)) ||
    (phase === 'verify-required' && !isVerificationRoute(pathname)) ||
    (phase === 'signed-in' && isAuthRoute(pathname) && !isVerificationRoute(pathname));

  return { phase, redirecting };
}
