/**
 * @cytale/mobile — settings stack (plan 004 M5, R14).
 *
 * Settings push as a stack surface over the drawer: the list is one screen,
 * each section is a pushed screen with the back affordance (plan-003 KTD5's
 * list→content stack, in native navigation).
 */
import '../../src/navigation/bootstrap';

import { Stack } from 'expo-router';

export default function SettingsLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
