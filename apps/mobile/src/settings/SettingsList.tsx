/**
 * @cytale/mobile — the settings list (plan 004 M10, R14).
 *
 * The list half of the list→section stack: Account, Appearance (dark-only, as
 * web), Integrations (read-only observe) each push their section, and Log out
 * is the FINAL row — the list's one action, not a destination (R14, AE5).
 *
 * Log out rides the app's one session manager, so the credential wipe goes
 * through the injected `TokenStorage` (expo-secure-store in production) and
 * the auth store lands on `unauthenticated` — the state the shell's gate keys
 * on. The row disables while the wipe is in flight so a double tap cannot race
 * the teardown.
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '../theme';
import { Divider } from '../navigation/ui';
import type { SettingsServices } from './services';

export const SETTINGS_SECTIONS = [
  { key: 'account', label: 'Account' },
  { key: 'appearance', label: 'Appearance' },
  // The label is the WORD, not the id: a machine principal reads as
  // "Agent" everywhere a person sees it (R1). The key stays `integrations`.
  { key: 'integrations', label: 'Agents' },
] as const;

export type SettingsSectionKey = (typeof SETTINGS_SECTIONS)[number]['key'];

export interface SettingsListProps {
  services: SettingsServices;
  /** Push a section (the route supplies expo-router's push). */
  onOpenSection(section: SettingsSectionKey): void;
}

export function SettingsList({ services, onOpenSection }: SettingsListProps) {
  const [loggingOut, setLoggingOut] = useState(false);

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await services.session.logout();
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <View testID="settings-list">
      {SETTINGS_SECTIONS.map((section) => (
        <Pressable
          key={section.key}
          accessibilityRole="button"
          accessibilityLabel={section.label}
          onPress={() => onOpenSection(section.key)}
          testID={`settings-row-${section.key}`}
          style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
        >
          <Text style={styles.label}>{section.label}</Text>
          <Text style={styles.chevron}>{'\u203A'}</Text>
        </Pressable>
      ))}
      <Divider />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Log out"
        accessibilityState={{ disabled: loggingOut }}
        disabled={loggingOut}
        onPress={() => {
          void handleLogout();
        }}
        testID="settings-row-logout"
        style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
      >
        <Text style={styles.danger}>{loggingOut ? 'Logging out…' : 'Log out'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 44,
    paddingHorizontal: theme.spacing.lg,
  },
  rowPressed: {
    backgroundColor: theme.colors.surfaceHover,
  },
  label: {
    color: theme.colors.text,
    fontSize: theme.fontSizes.lg,
  },
  chevron: {
    color: theme.colors.textMuted,
    fontSize: theme.fontSizes.lg,
  },
  danger: {
    color: theme.colors.danger,
    fontSize: theme.fontSizes.lg,
    fontWeight: '600',
  },
});
