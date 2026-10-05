/**
 * @cytale/mobile — MembersDrawer (plan 004 M5; plan-003 R5).
 *
 * Members render as an edge-aligned drawer with a scrim, exactly as the
 * responsive contract settled it — never as a fourth column at phone width.
 * The layer is mounted only while open and sits above the navigation drawer,
 * so the platform back gesture closes it first (ShellContext's ordering).
 */
import { useEffect, useRef } from 'react';
import { Animated, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { theme } from '../theme';
import type { MemberRow } from './store';
import { Avatar, IconButton, SectionLabel } from './ui';
import { EmptyState } from './SurfaceStates';

/** Members panel width: 85% of the window, capped at 320pt (same as nav). */
export function membersWidth(windowWidth: number): number {
  return Math.min(320, Math.round(windowWidth * 0.85));
}

export interface MembersDrawerProps {
  /** Members of the active workspace (ShellProvider owns the projection). */
  members: MemberRow[];
  onClose: () => void;
}

export function MembersDrawer({ members, onClose }: MembersDrawerProps) {
  const { width } = useWindowDimensions();
  const panelWidth = membersWidth(width);
  const translateX = useRef(new Animated.Value(panelWidth)).current;

  useEffect(() => {
    Animated.timing(translateX, {
      toValue: 0,
      duration: 180,
      useNativeDriver: true,
    }).start();
  }, [translateX]);

  return (
    // The whole layer is the modal surface (scrim included) — see DrawerLayer.
    <View style={StyleSheet.absoluteFill} accessibilityViewIsModal testID="members-layer">
      <Pressable
        style={styles.scrim}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Dismiss member list"
        testID="members-scrim"
      />
      <Animated.View
        style={[styles.panel, { width: panelWidth, transform: [{ translateX }] }]}
        testID="members-panel"
      >
        <View style={styles.header}>
          <Text style={styles.title} accessibilityRole="header">
            Members
          </Text>
          <IconButton label="Close member list" onPress={onClose} testID="members-close">
            {'\u2715'}
          </IconButton>
        </View>
        {members.length === 0 ? (
          <EmptyState
            title="No members to show"
            hint="Members appear once this workspace loads."
            testID="members-empty"
          />
        ) : (
          <ScrollView contentContainerStyle={styles.list}>
            <SectionLabel>{`Members — ${members.length}`}</SectionLabel>
            {members.map((member) => (
              <View key={member.id} style={styles.row} testID={`member-row-${member.id}`}>
                <Avatar id={member.id} name={member.name} status={member.status} />
                <View style={styles.rowText}>
                  <Text style={styles.name} numberOfLines={1}>
                    {member.name}
                  </Text>
                  <Text style={styles.status} numberOfLines={1}>
                    {presenceLabel(member.status)}
                  </Text>
                </View>
              </View>
            ))}
          </ScrollView>
        )}
      </Animated.View>
    </View>
  );
}

function presenceLabel(status: 'online' | 'idle' | 'dnd' | 'offline'): string {
  switch (status) {
    case 'online':
      return 'Online';
    case 'idle':
      return 'Idle';
    case 'dnd':
      return 'Do not disturb';
    default:
      return 'Offline';
  }
}

const styles = StyleSheet.create({
  scrim: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: theme.colors.scrim,
  },
  panel: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
    backgroundColor: theme.colors.surfaceEmphasized,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: theme.colors.border,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: theme.spacing.lg,
    paddingRight: theme.spacing.sm,
    minHeight: 56,
  },
  title: {
    color: theme.colors.textPrimary,
    fontSize: theme.fontSizes.lg,
    fontWeight: '700',
  },
  list: {
    paddingBottom: theme.spacing.xl,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
    minHeight: 44,
  },
  rowText: {
    flex: 1,
  },
  name: {
    color: theme.colors.text,
    fontSize: theme.fontSizes.md,
    fontWeight: '600',
  },
  status: {
    color: theme.colors.textMuted,
    fontSize: theme.fontSizes.xs,
  },
});
