/**
 * @cytale/mobile — the drawer's channel rows (plan 004 M5, R7; 2026-09-19
 * drawer rework).
 *
 * The active workspace's text channels, position-ordered, with unread and
 * mention badges. Selection language matches the web sidebar: the active row
 * gets the neutral selected surface (color stays reserved for meaning —
 * mentions are the red badge, unread the neutral one).
 *
 * Rendered INDENTED underneath the selected workspace row in the strip
 * (WorkspaceStrip) — the owner's model is a tree: workspaces are the primary
 * list, their channels hang beneath the chosen one.
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '../theme';
import { channelHref } from './routes';
import { useShell } from './ShellContext';
import { useChannelRows } from './store';
import { Badge } from './ui';
import { EmptyState } from './SurfaceStates';

export function ChannelRows({ indent = false }: { indent?: boolean }) {
  const { store, activeWorkspaceId, activeChannelId, navigate, closeDrawer } = useShell();
  const channels = useChannelRows(store, activeWorkspaceId);

  return (
    <View style={styles.section} testID="drawer-channel-list">
      {channels.length === 0 ? (
        <EmptyState
          title="No channels yet"
          hint="Channels for this workspace will appear here."
          testID="drawer-channels-empty"
        />
      ) : (
        channels.map((channel) => {
          const selected = channel.id === activeChannelId;
          const badgeLabel = [
            channel.name,
            channel.unread > 0 ? `${channel.unread} unread` : null,
            channel.mentions > 0 ? `${channel.mentions} mentions` : null,
          ]
            .filter((part): part is string => part !== null)
            .join(', ');

          return (
            <Pressable
              key={channel.id}
              accessibilityRole="button"
              accessibilityLabel={badgeLabel}
              accessibilityState={{ selected }}
              onPress={() => {
                navigate(channelHref(channel.id));
                closeDrawer();
              }}
              testID={`drawer-channel-${channel.id}`}
              style={({ pressed }) => [
                styles.row,
                indent ? styles.rowIndented : null,
                selected ? styles.rowSelected : null,
                pressed ? styles.rowPressed : null,
              ]}
            >
              <Text style={styles.hash}>{'#'}</Text>
              <Text style={styles.name} numberOfLines={1}>
                {channel.name}
              </Text>
              <Badge count={channel.mentions} tone="mention" testID={`drawer-channel-mentions-${channel.id}`} />
              <Badge count={channel.unread} testID={`drawer-channel-unread-${channel.id}`} />
            </Pressable>
          );
        })
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    flexShrink: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    minHeight: 44,
    paddingHorizontal: theme.spacing.md,
  },
  rowIndented: {
    paddingLeft: theme.spacing.xl,
  },
  rowSelected: {
    backgroundColor: theme.colors.surfaceSelected,
  },
  rowPressed: {
    backgroundColor: theme.colors.surfaceHover,
  },
  hash: {
    color: theme.colors.textMuted,
    fontSize: theme.fontSizes.lg,
    width: 16,
    textAlign: 'center',
  },
  name: {
    flex: 1,
    color: theme.colors.text,
    fontSize: theme.fontSizes.md,
  },
});
