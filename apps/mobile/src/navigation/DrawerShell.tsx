/**
 * @cytale/mobile — DrawerShell, the app's navigation shell (plan 004 M5).
 *
 * The only router-aware piece of the shell: it reads expo-router's pathname
 * and wires navigation into `ShellProvider` (which stays router-agnostic so
 * component tests can drive it). It lives in the ROOT layout so the drawer
 * and members layers sit above every surface — drawer surfaces and pushed
 * ones (thread, settings) alike, matching the responsive contract where the
 * ☰ lives in the one title bar each surface renders.
 */
import { router, usePathname } from 'expo-router';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { theme } from '../theme';
import { NavigationDrawer } from './NavigationDrawer';
import { ShellProvider } from './ShellContext';

export function DrawerShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <ShellProvider
      routePath={pathname}
      drawer={<NavigationDrawer />}
      onNavigate={(path) => router.navigate(path as never)}
      onPush={(path) => router.push(path as never)}
    >
      {/* Safe area applies to the surface content only: the drawer and
          members layers are rendered by ShellProvider as siblings, so their
          scrims cover the full screen including the status-bar inset. */}
      <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
        {children}
      </SafeAreaView>
    </ShellProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
});
