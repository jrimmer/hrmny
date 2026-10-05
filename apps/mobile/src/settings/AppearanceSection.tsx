/**
 * @cytale/mobile — AppearanceSection (plan 004 M10, R14).
 *
 * Theme: dark is the only theme (launch decision, `theme.scheme === 'dark'`).
 * Light is a planned pure tokens remap — the semantic layer exists for exactly
 * that swap — so its option renders visible-but-disabled with the reason,
 * never a fake choice and never hidden. Matching web's AppearanceSection.
 *
 * No fetch: the theme truth is a build-time constant, so there is nothing to
 * load and no server state to fail.
 */
import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../theme';
import { settingsStyles } from './ui';

function ThemeOption({
  label,
  detail,
  selected,
  disabled,
  testID,
}: {
  label: string;
  detail: string;
  selected: boolean;
  disabled: boolean;
  testID: string;
}) {
  return (
    <View
      style={[styles.option, selected ? styles.optionSelected : null, disabled ? styles.optionDisabled : null]}
      accessible
      accessibilityRole="radio"
      accessibilityLabel={`${label} ${detail}`}
      accessibilityState={{ checked: selected, disabled }}
      testID={testID}
    >
      <View
        style={[styles.radio, selected ? styles.radioSelected : null]}
        accessibilityElementsHidden
        importantForAccessibility="no"
      >
        {selected ? <View style={styles.radioDot} /> : null}
      </View>
      <Text style={styles.optionLabel}>{label}</Text>
      <Text style={styles.optionDetail}>{detail}</Text>
    </View>
  );
}

export function AppearanceSection() {
  return (
    <View style={settingsStyles.section} testID="settings-appearance">
      <View style={styles.block}>
        <Text style={styles.heading} accessibilityRole="header">
          Theme
        </Text>
        <View accessible accessibilityRole="radiogroup" accessibilityLabel="Color theme" style={styles.group}>
          <ThemeOption
            label="Dark"
            detail="— Hrmny's theme"
            selected
            disabled={false}
            testID="appearance-theme-dark"
          />
          <ThemeOption
            label="Light"
            detail="— coming soon"
            selected={false}
            disabled
            testID="appearance-theme-light"
          />
        </View>
        <Text style={styles.hint}>
          Light theme is planned — the token architecture ships it as a pure remap, so it arrives
          without a redesign.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    gap: theme.spacing.md,
  },
  heading: {
    color: theme.colors.textMuted,
    fontSize: theme.fontSizes.sm,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  group: {
    gap: theme.spacing.sm,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    minHeight: 44,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    borderRadius: theme.radii.md,
    backgroundColor: theme.colors.surfaceStrong,
    paddingHorizontal: theme.spacing.lg,
  },
  optionSelected: {
    borderColor: theme.colors.accent,
  },
  optionDisabled: {
    opacity: 0.6,
    backgroundColor: theme.colors.surface,
  },
  radio: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: theme.colors.inputBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioSelected: {
    borderColor: theme.colors.accent,
  },
  radioDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.accent,
  },
  optionLabel: {
    color: theme.colors.textPrimary,
    fontSize: theme.fontSizes.md,
    fontWeight: '600',
  },
  optionDetail: {
    color: theme.colors.textMuted,
    fontSize: theme.fontSizes.md,
  },
  hint: {
    color: theme.colors.textMuted,
    fontSize: theme.fontSizes.xs,
  },
});
