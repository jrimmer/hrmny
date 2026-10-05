/**
 * @cytale/mobile — the drawer group's layout (plan 004 M5).
 *
 * Drawer surfaces (Home, Integrations, Diagnostics, the channel surface)
 * render inside this stack. The drawer itself lives in the ROOT layout
 * (`DrawerShell`), so its layer sits above pushed surfaces too.
 */
import '../../src/navigation/bootstrap';

import { Stack } from 'expo-router';

export default function DrawerGroupLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
