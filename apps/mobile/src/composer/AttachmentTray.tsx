/**
 * @cytale/mobile — staged attachment chips (plan 004 M7, R10).
 *
 * One chip per picked file, above the input: name, size, and the upload's
 * live state (spinner while in flight, the readable error when it failed, a
 * done check when it is bound into the next send). Failed uploads keep a
 * Retry control — the message text is untouched, so the user never retypes.
 * A prefilter rejection shows the same error treatment without Retry (the
 * bytes would be refused again).
 *
 * Memoized (performance pass, P3): the tray sits inside the composer, which
 * re-renders on every keystroke, but its inputs only change when the staging
 * list does — `items` is a state array and both callbacks are stable, so a
 * keystroke no longer walks the chips.
 */
import { memo } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { MIN_TOUCH_TARGET } from '../navigation/ui';
import { theme } from '../theme';
import { formatBytes } from './attachmentRules';
import type { StagedAttachment } from './types';

export interface AttachmentTrayProps {
  items: StagedAttachment[];
  onRemove: (key: string) => void;
  onRetry: (key: string) => void;
  testID?: string;
}

function AttachmentTrayView({
  items,
  onRemove,
  onRetry,
  testID = 'attachment-tray',
}: AttachmentTrayProps) {
  if (items.length === 0) return null;

  return (
    <View style={styles.tray} accessibilityLabel="Staged attachments" testID={testID}>
      {items.map((chip) => (
        <View key={chip.key} style={styles.chip} testID="attachment-chip">
          <Text style={styles.paperclip} accessibilityElementsHidden importantForAccessibility="no">
            📎
          </Text>
          <Text style={styles.name} numberOfLines={1} testID="attachment-chip-name">
            {chip.file.name}
          </Text>
          {chip.file.size === null ? null : (
            <Text style={styles.size}>{formatBytes(chip.file.size)}</Text>
          )}

          {chip.status === 'uploading' ? (
            <View style={styles.statusRow} accessibilityLabel={`Uploading ${chip.file.name}`}>
              <ActivityIndicator
                size="small"
                color={theme.colors.accent}
                testID="attachment-upload-pending"
              />
              <Text style={styles.muted}>Uploading…</Text>
            </View>
          ) : null}

          {chip.status === 'error' ? (
            <Text style={styles.error} testID="attachment-upload-error">
              {chip.error ?? 'Upload failed'}
            </Text>
          ) : null}

          {chip.status === 'error' && chip.retryable === true ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Retry uploading ${chip.file.name}`}
              onPress={() => onRetry(chip.key)}
              testID="attachment-chip-retry"
              style={({ pressed }) => [styles.action, pressed ? styles.actionPressed : null]}
            >
              <Text style={styles.actionText}>Retry</Text>
            </Pressable>
          ) : null}

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Remove ${chip.file.name}`}
            onPress={() => onRemove(chip.key)}
            testID="attachment-chip-remove"
            style={({ pressed }) => [styles.action, pressed ? styles.actionPressed : null]}
          >
            <Text style={styles.actionText}>✕</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

/** Skips a re-render when the staging list and callbacks are unchanged. */
export const AttachmentTray = memo(AttachmentTrayView);
AttachmentTray.displayName = 'AttachmentTray';

const styles = StyleSheet.create({
  tray: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.sm,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
    maxWidth: '100%',
    paddingLeft: theme.spacing.sm,
    borderRadius: theme.radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceEmphasized,
  },
  paperclip: {
    fontSize: theme.fontSizes.sm,
  },
  name: {
    flexShrink: 1,
    color: theme.colors.textPrimary,
    fontSize: theme.fontSizes.sm,
  },
  size: {
    color: theme.colors.textMuted,
    fontSize: theme.fontSizes.xs,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
  },
  muted: {
    color: theme.colors.textMuted,
    fontSize: theme.fontSizes.xs,
  },
  error: {
    flexShrink: 1,
    color: theme.colors.danger,
    fontSize: theme.fontSizes.xs,
  },
  action: {
    minWidth: MIN_TOUCH_TARGET,
    minHeight: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.xs,
    borderRadius: theme.radii.sm,
  },
  actionPressed: {
    backgroundColor: theme.colors.surfaceHover,
  },
  actionText: {
    color: theme.colors.text,
    fontSize: theme.fontSizes.sm,
    fontWeight: '600',
  },
});
