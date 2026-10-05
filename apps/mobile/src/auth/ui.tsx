/**
 * @cytale/mobile — auth surface primitives (plan 004 M12, R18).
 *
 * The three screens share one vocabulary, so it lives here: a centred card,
 * a labelled field, a 44pt control, an inline alert. Every interactive element
 * is at least `MIN_TOUCH_TARGET` tall and carries an accessible name — the
 * same contract the shell's `IconButton` enforces, applied to forms.
 *
 * Styling reads `src/theme` (M3 tokens) only; the auth screens never hardcode
 * a colour, a size, or a radius.
 */
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';

import { MIN_TOUCH_TARGET } from '../navigation/ui';
import { theme } from '../theme';

export interface AuthScreenProps {
  testID: string;
  title: string;
  subtitle?: string;
  children: ReactNode;
}

/** One centred column per auth screen; scrolls so the keyboard never hides a field. */
export function AuthScreen({ testID, title, subtitle, children }: AuthScreenProps) {
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.screenContent}
      keyboardShouldPersistTaps="handled"
      testID={testID}
    >
      <View style={styles.card}>
        <Text style={styles.heading} accessibilityRole="header">
          {title}
        </Text>
        {subtitle === undefined ? null : <Text style={styles.subtitle}>{subtitle}</Text>}
        {children}
      </View>
    </ScrollView>
  );
}

export interface AuthFieldProps extends TextInputProps {
  label: string;
  testID: string;
}

/** A labelled text field; the label is the control's accessible name. */
export function AuthField({ label, testID, style, ...props }: AuthFieldProps) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={theme.colors.textMuted}
        style={[styles.input, style]}
        testID={testID}
        {...props}
      />
    </View>
  );
}

export interface AuthButtonProps {
  label: string;
  /** Rendered while the action is in flight (also the busy announcement). */
  busyLabel?: string;
  busy?: boolean;
  disabled?: boolean;
  onPress?: () => void;
  testID: string;
  tone?: 'primary' | 'quiet';
}

export function AuthButton({
  label,
  busyLabel,
  busy = false,
  disabled = false,
  onPress,
  testID,
  tone = 'primary',
}: AuthButtonProps) {
  const inactive = busy || disabled;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={busy ? (busyLabel ?? label) : label}
      accessibilityState={{ disabled: inactive, busy }}
      disabled={inactive}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.button,
        tone === 'quiet' ? styles.buttonQuiet : styles.buttonPrimary,
        pressed && !inactive ? styles.buttonPressed : null,
        inactive ? styles.buttonDisabled : null,
      ]}
    >
      {busy ? <ActivityIndicator color={theme.colors.onAccent} /> : null}
      <Text style={tone === 'quiet' ? styles.buttonQuietLabel : styles.buttonLabel}>
        {busy ? (busyLabel ?? label) : label}
      </Text>
    </Pressable>
  );
}

/** A text link that is still a 44pt target. */
export function AuthLink({
  label,
  onPress,
  testID,
}: {
  label: string;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={label}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [styles.link, pressed ? styles.linkPressed : null]}
    >
      <Text style={styles.linkLabel}>{label}</Text>
    </Pressable>
  );
}

/** Inline server error (alert role — screen readers announce it immediately). */
export function AuthError({ message, testID }: { message: string; testID: string }) {
  return (
    <View role="alert" accessibilityRole="alert" style={styles.error} testID={testID}>
      <Text style={styles.errorText}>{message}</Text>
    </View>
  );
}

/** Inline status/notice (verification pending, session expired, …). */
export function AuthNotice({ message, testID }: { message: string; testID: string }) {
  return (
    <View role="status" accessibilityRole="alert" style={styles.notice} testID={testID}>
      <Text style={styles.noticeText}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  screenContent: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: theme.spacing.xl,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center',
    gap: theme.spacing.lg,
  },
  heading: {
    color: theme.colors.textPrimary,
    fontSize: theme.fontSizes.xl,
    fontWeight: '700',
    textAlign: 'center',
  },
  subtitle: {
    color: theme.colors.textMuted,
    fontSize: theme.fontSizes.md,
    textAlign: 'center',
  },
  field: {
    gap: theme.spacing.xs,
  },
  label: {
    color: theme.colors.textMuted,
    fontSize: theme.fontSizes.sm,
    fontWeight: '600',
  },
  input: {
    minHeight: MIN_TOUCH_TARGET,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radii.md,
    borderWidth: 1,
    borderColor: theme.colors.inputBorder,
    backgroundColor: theme.colors.input,
    color: theme.colors.text,
    fontSize: theme.fontSizes.lg,
  },
  button: {
    minHeight: MIN_TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radii.md,
  },
  buttonPrimary: {
    backgroundColor: theme.colors.accent,
  },
  buttonQuiet: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: theme.colors.inputBorder,
  },
  buttonPressed: {
    backgroundColor: theme.colors.accentHover,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonLabel: {
    color: theme.colors.onAccent,
    fontSize: theme.fontSizes.lg,
    fontWeight: '600',
  },
  buttonQuietLabel: {
    color: theme.colors.text,
    fontSize: theme.fontSizes.lg,
    fontWeight: '600',
  },
  link: {
    minHeight: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  linkPressed: {
    opacity: 0.8,
  },
  linkLabel: {
    color: theme.colors.focusRing,
    fontSize: theme.fontSizes.lg,
  },
  error: {
    borderRadius: theme.radii.md,
    borderWidth: 1,
    borderColor: theme.colors.danger,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.md,
  },
  errorText: {
    color: theme.colors.danger,
    fontSize: theme.fontSizes.md,
    fontWeight: '600',
  },
  notice: {
    borderRadius: theme.radii.md,
    borderWidth: 1,
    borderColor: theme.colors.warning,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.md,
  },
  noticeText: {
    color: theme.colors.text,
    fontSize: theme.fontSizes.md,
  },
});
