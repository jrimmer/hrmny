/**
 * @cytale/mobile — TitleBar, the ONE title bar per surface (plan 004 M5, R7).
 *
 * Plan-003's KTD1 carried to native: every surface renders exactly one title
 * bar. It carries the surface name (the channel name on channel surfaces),
 * the navigation affordance on the left (☰ on drawer surfaces, ‹ on pushed
 * ones), and the voice entry point on the right — RENDERED BUT DISABLED until
 * v1.1, matching the web topbar's join-voice slot without building calling.
 *
 * The members trigger is optional and only channel surfaces pass it: members
 * render as an edge-aligned drawer with scrim (plan-003 R5), never as a
 * fourth column at phone width.
 *
 * The nav-trigger face is the ACTIVE workspace's icon (device feedback 2442:
 * "replace the hamburger with the workspace icon" — web's mobileNavIcon
 * parity, AppShell 2026-09-18): the avatar/icon tile of the workspace the
 * shell currently points at, falling back to the ☰ glyph when no workspace
 * is active (or on a standalone mount with no shell — component tests).
 */
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Feather } from '@expo/vector-icons';

import { theme } from '../theme';

import { useShellOptional } from './ShellContext';
import { serverAssetUrl } from './session';
import { Avatar, avatarInitials, IconButton, MIN_TOUCH_TARGET } from './ui';

export interface TitleBarProps {
  /** The surface's name — the channel name on channel surfaces. */
  title: string;
  /** Optional second line (topic, section subtitle). */
  subtitle?: string;
  /** Drawer surfaces: opens the navigation drawer. */
  onOpenDrawer?: () => void;
  /** Pushed surfaces: pops back to the surface underneath. */
  onBack?: () => void;
  /** Channel surfaces: opens the members drawer. */
  onOpenMembers?: () => void;
  /** Accessible name for the members trigger. */
  membersLabel?: string;
  /**
   * A surface-owned control rendered before the voice slot — the channel
   * surface's notification level button (2026-09-27).
   */
  headerAction?: ReactNode;
  testID?: string;
}

/** Copy for the disabled voice control — one string, two clients. */
export const VOICE_UNAVAILABLE_LABEL = 'Voice — coming soon';

export function TitleBar({
  title,
  subtitle,
  onOpenDrawer,
  onBack,
  onOpenMembers,
  membersLabel = 'Show member list',
  headerAction,
  testID = 'title-bar',
}: TitleBarProps) {
  // The trigger face's source (see header): the shell hands the ACTIVE
  // workspace down — no store subscriptions of its own (the shell already
  // holds them). A mount without a shell just takes the ☰.
  const shell = useShellOptional();
  const iconWorkspace = onOpenDrawer === undefined ? null : (shell?.navTriggerWorkspace ?? null);

  return (
    <View style={styles.bar} testID={testID}>
      {onBack === undefined ? null : (
        <IconButton label="Back" onPress={onBack} testID="title-bar-back">
          <Feather name="chevron-left" size={22} color={theme.colors.textPrimary} />
        </IconButton>
      )}
      {onOpenDrawer === undefined ? null : (
        <IconButton label="Open navigation" onPress={onOpenDrawer} testID="title-bar-drawer">
          {iconWorkspace === null ? (
            <Feather name="menu" size={20} color={theme.colors.textPrimary} />
          ) : (
            <View style={styles.wsIconSlot} testID="title-bar-ws-icon">
              <Avatar
                id={iconWorkspace.id}
                name={avatarInitials(iconWorkspace.name).slice(0, 1) || '?'}
                size={28}
                imageUrl={serverAssetUrl(iconWorkspace.iconUrl)}
              />
            </View>
          )}
        </IconButton>
      )}

      <Pressable
        style={styles.titleSlot}
        accessibilityRole="header"
        accessibilityLabel={subtitle === undefined ? title : `${title}, ${subtitle}`}
      >
        <Text style={styles.title} numberOfLines={1} testID="title-bar-title">
          {title}
        </Text>
        {subtitle === undefined ? null : (
          <Text style={styles.subtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        )}
      </Pressable>

      {headerAction}

      {/* Voice: rendered, disabled, and explicitly announced as such. Calling
          is v1.1 — this slot is the seam, not a stub implementation. */}
      <IconButton label={VOICE_UNAVAILABLE_LABEL} disabled testID="title-bar-voice">
        <Feather name="phone-call" size={18} color={theme.colors.textMuted} />
      </IconButton>

      {onOpenMembers === undefined ? null : (
        <IconButton label={membersLabel} onPress={onOpenMembers} testID="title-bar-members">
          <Feather name="users" size={18} color={theme.colors.textPrimary} />
        </IconButton>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    minHeight: MIN_TOUCH_TARGET + theme.spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.sm,
    gap: theme.spacing.xs,
    backgroundColor: theme.colors.surfaceEmphasized,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  titleSlot: {
    flex: 1,
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.xs,
  },
  /** The trigger tile: the rail icon's 28pt face inside the 44pt control. */
  wsIconSlot: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    color: theme.colors.textPrimary,
    fontSize: theme.fontSizes.xl,
    fontWeight: '700',
  },
  subtitle: {
    color: theme.colors.textMuted,
    fontSize: theme.fontSizes.xs,
  },
});
