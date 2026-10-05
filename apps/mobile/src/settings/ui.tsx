/**
 * @cytale/mobile — settings UI primitives (plan 004 M10).
 *
 * The small pieces the three sections share: the scroll frame, the uppercase
 * section heading, the label/value detail row, the labeled field wrapper, and
 * the one button (44pt floor, explicit accessible name, announced disabled
 * state) — the same contract `src/navigation/ui` holds the shell to, sized
 * for form controls.
 */
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { theme } from '../theme';
import { MIN_TOUCH_TARGET } from '../navigation/ui';

/**
 * The section body's scroll frame, used by `app/settings/[section]`. The
 * shell's `SurfaceScaffold` scrolls the settings LIST, but a FORM needs
 * `keyboardShouldPersistTaps="handled"` — otherwise the first tap on Save just
 * dismisses the keyboard and the button never fires (AE5's edit-name step).
 */
export function SectionScroll({ children, testID }: { children: ReactNode; testID?: string }) {
  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.scrollContent}
      keyboardShouldPersistTaps="handled"
      testID={testID}
    >
      {children}
    </ScrollView>
  );
}

export function SectionHeading({ children, testID }: { children: string; testID?: string }) {
  return (
    <Text style={styles.heading} accessibilityRole="header" testID={testID}>
      {children}
    </Text>
  );
}

export interface DetailRowProps {
  label: string;
  children: ReactNode;
}

/** One read-only identity row (label left, value right). */
export function DetailRow({ label, children }: DetailRowProps) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <View style={styles.detailValue}>{children}</View>
    </View>
  );
}

export interface FieldProps {
  label: string;
  hint?: string;
  children: ReactNode;
}

/** A labeled form field: uppercase label, control, optional hint. */
export function Field({ label, hint, children }: FieldProps) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
      {hint === undefined ? null : <Text style={styles.hint}>{hint}</Text>}
    </View>
  );
}

export type ActionButtonVariant = 'primary' | 'subtle' | 'danger';

export interface ActionButtonProps {
  label: string;
  onPress(): void;
  variant?: ActionButtonVariant;
  disabled?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

export function ActionButton({
  label,
  onPress,
  variant = 'subtle',
  disabled = false,
  testID,
  style,
}: ActionButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.button,
        styles[variant],
        pressed && !disabled ? styles.buttonPressed : null,
        disabled ? styles.buttonDisabled : null,
        style,
      ]}
    >
      <Text style={[styles.buttonLabel, variant === 'primary' ? styles.primaryLabel : null]}>
        {label}
      </Text>
    </Pressable>
  );
}

export const settingsStyles = StyleSheet.create({
  section: {
    gap: theme.spacing.xl,
    padding: theme.spacing.lg,
  },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    borderRadius: theme.radii.md,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.lg,
    gap: theme.spacing.md,
  },
  bodyText: {
    color: theme.colors.textMuted,
    fontSize: theme.fontSizes.md,
    lineHeight: theme.fontSizes.md + 6,
  },
  statusText: {
    color: theme.colors.text,
    fontSize: theme.fontSizes.md,
  },
  errorText: {
    color: theme.colors.danger,
    fontSize: theme.fontSizes.md,
    fontWeight: '600',
  },
  confirm: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.warning,
    borderRadius: theme.radii.md,
    backgroundColor: theme.colors.surfaceStrong,
    padding: theme.spacing.md,
    gap: theme.spacing.md,
  },
  confirmRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.spacing.sm,
  },
});

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
  },
  heading: {
    color: theme.colors.textMuted,
    fontSize: theme.fontSizes.sm,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.md,
    minHeight: MIN_TOUCH_TARGET,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  detailLabel: {
    color: theme.colors.text,
    fontSize: theme.fontSizes.md,
    fontWeight: '600',
  },
  detailValue: {
    flexShrink: 1,
    alignItems: 'flex-end',
  },
  field: {
    gap: theme.spacing.xs,
  },
  fieldLabel: {
    color: theme.colors.textMuted,
    fontSize: theme.fontSizes.xs,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  hint: {
    color: theme.colors.textMuted,
    fontSize: theme.fontSizes.xs,
  },
  button: {
    minHeight: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radii.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  primary: {
    backgroundColor: theme.colors.accent,
    borderColor: theme.colors.accent,
  },
  subtle: {
    backgroundColor: theme.colors.surfaceStrong,
    borderColor: theme.colors.border,
  },
  danger: {
    backgroundColor: theme.colors.surfaceStrong,
    borderColor: theme.colors.danger,
  },
  buttonPressed: {
    backgroundColor: theme.colors.surfaceHover,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonLabel: {
    color: theme.colors.text,
    fontSize: theme.fontSizes.md,
    fontWeight: '600',
  },
  primaryLabel: {
    color: theme.colors.onAccent,
  },
});
