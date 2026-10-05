/**
 * @cytale/mobile — root layout and the auth gate (plan 004 M5/M12).
 *
 * This file is the app entry now that `package.json#main` is
 * `expo-router/entry` (the old `index.ts` + `registerRootComponent` pair is
 * gone). Its jobs:
 *
 * 1. Install the Hermes/Expo runtime shims (M1) BEFORE any shared `@cytale/*`
 *    package is used. `installShims()` is idempotent; the side-effect import
 *    guarantees the ordering even when a route module is evaluated first.
 * 2. Provide the ONE `SessionManager` (M4) to the tree and restore the
 *    persisted session on launch (R5).
 * 3. Gate on identity (M12): `loading` → splash, `unauthenticated` → the auth
 *    group, `authenticated` → the drawer. `useAuthGate` owns the decisions and
 *    the redirects (including resuming a deep link captured while signed out);
 *    this file only maps the phase to a tree.
 * 4. Provide the gesture + safe-area roots and the root stack. Every surface
 *    renders its own title bar, so the native header is off everywhere.
 */
import '../src/navigation/bootstrap';

import { Stack, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { installShims } from '../src/shims';
import { logMediaProbe, mediaProbeEnabled } from '../src/calls/mediaProbe';
import { DevCallHarness } from '../src/calls/devCallHarness';
import { isVerificationRoute } from '../src/auth/routes';
import { LoadingState } from '../src/navigation/SurfaceStates';
import { DrawerShell } from '../src/navigation/DrawerShell';
import { SessionProvider } from '../src/navigation/session';
import { useAuthGate } from '../src/auth/useAuthGate';
// #88: RN's global error handler + the unhandled-rejection hook, installed at
// MODULE SCOPE (after the bootstrap import above, whose `installShims()` must
// run before any `@cytale/*` module is evaluated — the import order is
// load-bearing). Installing here rather than inside the component means an
// error thrown while the tree is mounting is already reportable; the api
// client that carries the report is late-bound by the session provider.
import {
  installMobileErrorHandlers,
  setClientErrorRoute,
} from '../src/observability/clientErrors';

installMobileErrorHandlers();

// The entry-point call the old index.ts used to make. The import above
// already ran it; keeping the explicit call documents the contract and is
// free (installShims is idempotent).
installShims();

export default function RootLayout() {
  // Media spike, step 2: the platform probe runs at boot so it is reachable
  // WITHOUT a signed-in session (the drawer is gated, and the backend may be
  // down). Opt-in via EXPO_PUBLIC_CYTALE_MEDIA_PROBE=1, dev-only — see
  // src/calls/mediaProbe.ts. Removing this is deleting two lines.
  useEffect(() => {
    if (!__DEV__) return;
    // Reports its own inputs: "the probe stayed silent" must not be ambiguous
    // between "not enabled" and "enabled but produced nothing".
    console.log(
      `[media-probe] gate enabled=${String(mediaProbeEnabled())} ` +
        `flag=${JSON.stringify(process.env.EXPO_PUBLIC_CYTALE_MEDIA_PROBE)}`,
    );
    if (mediaProbeEnabled()) void logMediaProbe();
  }, []);

  // #88: the report's `route` field. `usePathname` is the router's own answer,
  // and the reporter redacts ids out of it before anything leaves the device.
  const pathname = usePathname();
  useEffect(() => {
    setClientErrorRoute(pathname);
  }, [pathname]);

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <SessionProvider>
          <StatusBar style="light" />
          {/* Media spike, step 2: a headless call + frame-cost harness, inside
              the ONE provider so it can use the session. Renders null and does
              nothing unless its dev env vars are set. See devCallHarness.tsx. */}
          <DevCallHarness />
          <RootNavigator />
        </SessionProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

/**
 * The gate's render half. One Stack hosts every route; `Stack.Protected`
 * removes the drawer group from the navigator while the member may not see it
 * (and expo-router then refuses to navigate there at all), so a signed-out
 * deep link can never mount the shell — not even for a frame.
 */
function RootNavigator() {
  const { phase, redirecting } = useAuthGate();
  const pathname = usePathname();

  // Cold-launch restore, or a redirect in flight: nothing is allowed to render
  // yet. A surface here would be either the drawer on a fresh install or the
  // `+not-found` the router resolves an unavailable deep link to.
  if (redirecting) {
    return (
      <View style={styles.splash} testID="auth-splash">
        <LoadingState label="Loading Hrmny…" />
      </View>
    );
  }

  const signedIn = phase === 'signed-in';

  return (
    <DrawerShell>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Protected guard={signedIn}>
          <Stack.Screen name="(drawer)" />
          <Stack.Screen name="settings" />
          <Stack.Screen name="thread/[id]" />
        </Stack.Protected>
        {/* The auth group is reachable while signed in only for the emailed
            verification link (`/verify-email?token=…`), which must be
            consumable by an already-signed-in member. */}
        <Stack.Protected guard={!signedIn || isVerificationRoute(pathname)}>
          <Stack.Screen name="(auth)" />
        </Stack.Protected>
      </Stack>
    </DrawerShell>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  splash: {
    flex: 1,
    justifyContent: 'center',
  },
});
