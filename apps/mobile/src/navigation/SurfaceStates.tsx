/**
 * @cytale/mobile — states-first surface components (plan 004 M5, R15).
 *
 * Every state the repo's DoD names renders through one of these: loading
 * (progressbar), empty (status), error (alert), offline (status banner),
 * view-only (note), permission-denied (alert). They are deliberately dumb —
 * a surface passes the state, the component announces it correctly — so a
 * missing state is a missing render, which is exactly what the tests assert.
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '../theme';
import { MIN_TOUCH_TARGET } from './ui';

export function LoadingState({ label = 'Loading…', testID = 'surface-loading' }: { label?: string; testID?: string }) {
  return (
    <View
      style={styles.block}
      role="progressbar"
      aria-busy
      aria-label={label}
      accessibilityLabel={label}
      testID={testID}
    >
      <Text style={styles.muted}>{label}</Text>
    </View>
  );
}

export function EmptyState({ title, hint, testID = 'surface-empty' }: { title: string; hint?: string; testID?: string }) {
  return (
    <View style={styles.block} accessibilityRole="summary" testID={testID}>
      <Text style={styles.title}>{title}</Text>
      {hint === undefined ? null : <Text style={styles.muted}>{hint}</Text>}
    </View>
  );
}

export function ErrorState({
  message,
  onRetry,
  testID = 'surface-error',
}: {
  message: string;
  /** Re-runs the failed fetch (the shell's bootstrap retry). */
  onRetry?: () => void;
  testID?: string;
}) {
  return (
    <View style={styles.block} role="alert" accessibilityRole="alert" testID={testID}>
      <Text style={styles.error}>{message}</Text>
      {onRetry === undefined ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Retry"
          onPress={onRetry}
          testID={`${testID}-retry`}
          style={({ pressed }) => [styles.retry, pressed ? styles.retryPressed : null]}
        >
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      )}
    </View>
  );
}

/** Persistent banner while the gateway is offline (rendered above content). */
export function OfflineBanner({ testID = 'offline-banner' }: { testID?: string }) {
  return (
    <View style={styles.banner} role="status" accessibilityRole="alert" testID={testID}>
      <Text style={styles.bannerText}>
        You are offline — reconnecting. Messages will sync when the connection returns.
      </Text>
    </View>
  );
}

/** The composer's replacement when the member may read but not send. */
export function ViewOnlyNotice({ testID = 'view-only-note' }: { testID?: string }) {
  return (
    <View style={styles.notice} testID={testID}>
      <Text style={styles.muted}>View-only — you cannot send messages here.</Text>
    </View>
  );
}

/** Hard permission denial for a whole surface. */
export function PermissionDenied({ message, testID = 'permission-denied' }: { message: string; testID?: string }) {
  return (
    <View style={styles.block} role="alert" accessibilityRole="alert" testID={testID}>
      <Text style={styles.error}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    flexGrow: 1,
    minHeight: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.spacing.xl,
    gap: theme.spacing.sm,
  },
  banner: {
    backgroundColor: theme.colors.warning,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
  },
  bannerText: {
    color: theme.colors.surfaceStrong,
    fontSize: theme.fontSizes.sm,
    fontWeight: '600',
  },
  notice: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
  },
  title: {
    color: theme.colors.textPrimary,
    fontSize: theme.fontSizes.lg,
    fontWeight: '600',
    textAlign: 'center',
  },
  muted: {
    color: theme.colors.textMuted,
    fontSize: theme.fontSizes.md,
    textAlign: 'center',
  },
  error: {
    color: theme.colors.danger,
    fontSize: theme.fontSizes.md,
    fontWeight: '600',
    textAlign: 'center',
  },
  retry: {
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radii.md,
    backgroundColor: theme.colors.surfaceSelected,
  },
  retryPressed: {
    backgroundColor: theme.colors.surfaceHover,
  },
  retryText: {
    color: theme.colors.textPrimary,
    fontSize: theme.fontSizes.md,
    fontWeight: '600',
  },
});
