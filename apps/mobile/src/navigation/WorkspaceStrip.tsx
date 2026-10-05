/**
 * @cytale/mobile — the drawer's workspace strip (plan 004 M5, R7; 2026-09-19
 * drawer rework per device feedback #146).
 *
 * The drawer's PRIMARY list is the workspaces: Home, then each workspace,
 * with the selected workspace's channels hanging INDENTED beneath it. One
 * selection at a time — choosing a workspace deselects Home; choosing Home
 * clears the workspace selection. Integrations left the drawer with the web
 * main menu (2026-09-19).
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Feather } from '@expo/vector-icons';

import { theme } from '../theme';
import { useEffect, useState } from 'react';

import { ChannelRows } from './ChannelList';
import { parseRoute, ROUTES } from './routes';
import { serverAssetUrl } from './session';
import { useShell } from './ShellContext';
import { useWorkspaceRows } from './store';
import { Avatar, Badge, SectionLabel } from './ui';

export function WorkspaceStrip({ showChannels = true }: { showChannels?: boolean }) {
  const { store, routePath, activeWorkspaceId, activeChannelId, selectWorkspace, closeDrawer, navigate } = useShell();
  const workspaces = useWorkspaceRows(store);
  const route = parseRoute(routePath);

  // ONE selection at a time (device feedback 2441): the drawer highlights
  // either Home or ONE workspace — seeded with the active workspace so its
  // channels hang indented beneath it from the first open.
  const [selection, setSelection] = useState<string | null>(activeWorkspaceId);
  useEffect(() => {
    setSelection(activeWorkspaceId);
  }, [activeWorkspaceId]);

  const go = (path: string) => {
    navigate(path);
    closeDrawer();
  };

  return (
    <View testID="drawer-workspace-strip">
      <SectionLabel>Workspaces</SectionLabel>

      <StripRow
        label="Home"
        testID="drawer-home"
        selected={selection === 'home'}
        onPress={() => {
          setSelection('home');
          go(ROUTES.home);
        }}
      >
        <Feather name="home" size={20} color={theme.colors.textPrimary} />
        <Text style={styles.label}>Home</Text>
      </StripRow>

      {workspaces.map((workspace) => {
        // Two independent states (double-highlight device feedback 2441):
        //   expanded — the workspace's channels hang beneath it;
        //   highlighted — the row lights up only while no channel is the
        //   active destination (once one is, only the channel stays lit).
        const expanded = selection === workspace.id;
        const highlighted = expanded && activeChannelId === null;
        return (
          <View key={workspace.id}>
            <StripRow
              label={workspace.unread > 0 ? `${workspace.name}, ${workspace.unread} unread` : workspace.name}
              testID={`drawer-workspace-${workspace.id}`}
              selected={highlighted}
              onPress={() => {
                setSelection(workspace.id);
                selectWorkspace(workspace.id);
              }}
            >
              <Avatar
                id={workspace.id}
                name={workspace.initial}
                size={24}
                imageUrl={serverAssetUrl(workspace.iconUrl)}
              />
              <Text style={styles.label} numberOfLines={1}>
                {workspace.name}
              </Text>
              <Badge count={workspace.unread} testID={`drawer-workspace-unread-${workspace.id}`} />
            </StripRow>
            {expanded && showChannels ? (
              <View style={styles.channelIndent}>
                <ChannelRows indent />
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

function StripRow({
  label,
  testID,
  selected,
  onPress,
  children,
}: {
  label: string;
  testID: string;
  selected: boolean;
  onPress: () => void;
  children: React.ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [styles.row, selected ? styles.rowSelected : null, pressed ? styles.rowPressed : null]}
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
    minHeight: 44,
    paddingHorizontal: theme.spacing.md,
  },
  rowSelected: {
    backgroundColor: theme.colors.surfaceSelected,
  },
  rowPressed: {
    backgroundColor: theme.colors.surfaceHover,
  },
  glyph: {
    width: 24,
    textAlign: 'center',
    color: theme.colors.textMuted,
    fontSize: theme.fontSizes.lg,
  },
  label: {
    flex: 1,
    color: theme.colors.text,
    fontSize: theme.fontSizes.md,
    fontWeight: '600',
  },
  channelIndent: {
    borderLeftWidth: 2,
    borderLeftColor: theme.colors.border,
    marginLeft: theme.spacing.lg,
  },
});
