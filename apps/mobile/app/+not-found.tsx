/**
 * @cytale/mobile — unmatched route (plan 004 M5).
 *
 * A deep link the app does not know (or a stale link from a previous
 * version) lands here with a way back instead of a blank screen.
 */
import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { ROUTES } from '../src/navigation/routes';
import { theme } from '../src/theme';
import { MIN_TOUCH_TARGET } from '../src/navigation/ui';

export default function NotFoundScreen() {
  return (
    <View style={styles.screen} testID="surface-not-found">
      <Text style={styles.title} accessibilityRole="header">
        Page not found
      </Text>
      <Text style={styles.hint}>That link does not point at a Hrmny surface.</Text>
      <Text
        accessibilityRole="button"
        accessibilityLabel="Go to Home"
        onPress={() => router.replace(ROUTES.home as never)}
        style={styles.link}
        testID="not-found-home"
      >
        Go to Home
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.sm,
    backgroundColor: theme.colors.background,
    padding: theme.spacing.xl,
  },
  title: {
    color: theme.colors.textPrimary,
    fontSize: theme.fontSizes.xl,
    fontWeight: '700',
  },
  hint: {
    color: theme.colors.textMuted,
    fontSize: theme.fontSizes.md,
    textAlign: 'center',
  },
  link: {
    color: theme.colors.focusRing,
    fontSize: theme.fontSizes.lg,
    minHeight: MIN_TOUCH_TARGET,
    lineHeight: MIN_TOUCH_TARGET,
  },
});
