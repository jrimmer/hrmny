/**
 * @cytale/mobile — the auth group's layout (plan 004 M12).
 *
 * Sign-in / sign-up / verify-email render inside this stack. The gate that
 * decides whether the group is reachable at all lives in the ROOT layout
 * (`useAuthGate`), because the drawer must be unavailable whenever one of
 * these screens is the right surface.
 */
import '../../src/navigation/bootstrap';

import { Stack } from 'expo-router';

export default function AuthGroupLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
