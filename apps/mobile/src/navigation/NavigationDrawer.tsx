/**
 * @cytale/mobile — NavigationDrawer, the drawer's content (plan 004 M5, R7;
 * 2026-09-19 drawer rework per device feedback #146).
 *
 * The drawer is the workspace tree: Home + the workspace list with the
 * selected workspace's channels indented beneath it (WorkspaceStrip), the
 * user panel as the footer. The drawer carries its own safe-area insets —
 * it renders as a full-screen sibling layer, so the notch gutter and the
 * screen curve must be padded here (the avatar was being eaten by the
 * device curve before this).
 */
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { theme } from '../theme';
import { ROUTES } from './routes';
import { useShell } from './ShellContext';
import { useSurfaceStates } from './shellState';
import { ErrorState } from './SurfaceStates';
import { UserPanel } from './UserPanel';
import { WorkspaceStrip } from './WorkspaceStrip';

export function NavigationDrawer() {
  const { routePath, navigate, closeDrawer } = useShell();
  // The REST bootstrap's failure (residual 3): without it the channel list
  // renders "No channels yet", which reads as "there are no channels".
  const { hydrationError, retryHydration } = useSurfaceStates();
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[
        styles.drawer,
        {
          paddingTop: insets.top,
          paddingLeft: insets.left,
          paddingRight: insets.right,
        },
      ]}
      accessibilityLabel="Channels"
      testID="navigation-drawer"
    >
      <ScrollView contentContainerStyle={styles.body} testID="drawer-scroll">
        {/* A bootstrap failure REPLACES the channel block: a stale list
            reads as real channels (residual 3). */}
        <WorkspaceStrip showChannels={!hydrationError} />
        {hydrationError ? (
          <ErrorState
            message={hydrationError}
            onRetry={retryHydration ?? undefined}
            testID="drawer-hydration-error"
          />
        ) : null}
      </ScrollView>

      <UserPanel />
      <DevFooter routePath={routePath} onOpen={() => {
        navigate(ROUTES.diagnostics);
        closeDrawer();
      }} />
    </View>
  );
}

/**
 * Dev-only drawer footer. `__DEV__` is false in release bundles, so the
 * diagnostics route stays reachable on development builds and disappears
 * from shipping ones.
 */
function DevFooter({ routePath, onOpen }: { routePath: string; onOpen: () => void }) {
  if (!__DEV__) return null;
  return (
    <View style={styles.devFooter} testID="drawer-dev-footer">
      <Text
        accessibilityRole="button"
        accessibilityLabel="Diagnostics"
        accessibilityState={{ selected: routePath === ROUTES.diagnostics }}
        onPress={onOpen}
        style={styles.devLink}
        testID="drawer-diagnostics"
      >
        Diagnostics
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  drawer: {
    flex: 1,
  },
  body: {
    paddingBottom: theme.spacing.sm,
  },
  devFooter: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    paddingHorizontal: theme.spacing.md,
  },
  devLink: {
    color: theme.colors.textMuted,
    fontSize: theme.fontSizes.sm,
    minHeight: 44,
    lineHeight: 44,
  },
});
