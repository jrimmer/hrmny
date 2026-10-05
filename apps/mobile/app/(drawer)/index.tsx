/**
 * @cytale/mobile — Home surface (plan 004 M5; populated 2026-09-19 per the
 * owner's device feedback: "Home's contents are also not populated").
 *
 * The landing surface lists every conversation the store knows — workspace
 * channels first by unread, then the rest — with the same unread/mention
 * badges the drawer uses, and each row routes into its channel. The full
 * #117 inbox (durable mention backlog + done/sweep) stays a web feature
 * until its REST port lands here; this is the store-derived core.
 */
import '../../src/navigation/bootstrap';

import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { StateStore } from '@cytale/state';

import { useShell } from '../../src/navigation/ShellContext';
import { SurfaceScaffold } from '../../src/navigation/SurfaceScaffold';
import { useInbox } from '../../src/home/useInbox';
import { renderExcerpt } from '../../src/home/inbox';
import { Badge, SectionLabel } from '../../src/navigation/ui';
import { useStoreSelector } from '../../src/navigation/store';
import { channelHref } from '../../src/navigation/routes';
import { theme } from '../../src/theme';

export default function HomeScreen() {
  const { openDrawer, store, navigate } = useShell();
  const inbox = useInbox(store as StateStore);
  const channels = useStoreSelector(store, (s) => s.channels);
  const unread = useStoreSelector(store, (s) => s.unreadByChannel);

  const dmRows = Object.values(channels)
    .filter((channel) => channel.workspace_id === null)
    .map((channel) => ({
      id: channel.id,
      name: channel.name,
      unread: unread[channel.id]?.unread_count ?? 0,
      mentions: unread[channel.id]?.mention_count ?? 0,
    }))
    .sort((a, b) => b.mentions - a.mentions || b.unread - a.unread || a.name.localeCompare(b.name));

  return (
    <SurfaceScaffold testID="surface-home" title="Home" onOpenDrawer={openDrawer}>
      <View style={styles.body} testID="home-inbox">
        <SectionLabel>Inbox</SectionLabel>

        {inbox.status === 'error' ? (
          <Pressable accessibilityRole="button" onPress={inbox.retry} style={styles.row} testID="home-inbox-error">
            <Text style={styles.name}>{inbox.error ?? 'Could not load your mentions.'}</Text>
            <Text style={styles.inboxMeta}>Tap to retry</Text>
          </Pressable>
        ) : inbox.items.length === 0 ? (
          <Text style={styles.empty}>No unread mentions. You{'\u2019'}re all caught up.</Text>
        ) : (
          <>
            {inbox.items.map((item) => (
              <Pressable
                key={item.message_id}
                accessibilityRole="button"
                accessibilityLabel={`Mention from ${item.author_username ?? item.author_id}`}
                onPress={() => navigate(channelHref(item.channel_id))}
                style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
                testID={`home-inbox-${item.message_id}`}
              >
                <Text style={styles.inboxAuthor} numberOfLines={1}>
                  {item.author_username ?? item.author_id}
                </Text>
                <Text style={styles.inboxExcerpt} numberOfLines={2}>
                  {renderExcerpt(item.excerpt, (id) =>
                    store.getState().membersById[id]?.username ?? id,
                  )}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Mark done"
                  onPress={() => inbox.dismiss(item.message_id)}
                  style={styles.doneButton}
                  testID={`home-inbox-done-${item.message_id}`}
                >
                  <Text style={styles.doneLabel}>Done</Text>
                </Pressable>
              </Pressable>
            ))}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Mark all mentions done"
              disabled={inbox.busy}
              onPress={inbox.sweep}
              style={styles.sweepRow}
              testID="home-inbox-sweep"
            >
              <Text style={styles.sweepLabel}>{inbox.busy ? 'Working…' : 'Mark all done'}</Text>
            </Pressable>
          </>
        )}

        <SectionLabel>Direct messages</SectionLabel>

        {dmRows.length === 0 ? (
          <Text style={styles.empty}>
            No direct messages yet.
          </Text>
        ) : (
          dmRows.map((row) => (
            <Pressable
              key={row.id}
              accessibilityRole="button"
              accessibilityLabel={[row.name, row.unread > 0 ? `${row.unread} unread` : null]
                .filter((part): part is string => part !== null)
                .join(', ')}
              onPress={() => navigate(channelHref(row.id))}
              testID={`home-dm-${row.id}`}
              style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
            >
              <Text style={styles.name} numberOfLines={1}>
                {row.name}
              </Text>
              <View style={styles.badges}>
                {row.mentions > 0 ? <Badge count={row.mentions} tone="mention" /> : null}
                {row.unread > 0 ? <Badge count={row.unread} /> : null}
              </View>
            </Pressable>
          ))
        )}

      </View>
    </SurfaceScaffold>
  );
}

const styles = StyleSheet.create({
  body: {
    paddingHorizontal: theme.spacing.md,
    gap: theme.spacing.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    minHeight: 48,
    paddingHorizontal: theme.spacing.sm,
    borderRadius: 8,
    backgroundColor: theme.colors.surfaceEmphasized,
  },
  rowPressed: {
    backgroundColor: theme.colors.surfaceHover,
  },
  name: {
    flex: 1,
    color: theme.colors.text,
    fontSize: theme.fontSizes.md,
  },
  badges: {
    flexDirection: 'row',
    gap: theme.spacing.xs,
  },
  inboxAuthor: {
    color: theme.colors.textPrimary,
    fontSize: theme.fontSizes.sm,
    fontWeight: '700',
    flex: 1,
  },
  inboxExcerpt: {
    color: theme.colors.textMuted,
    fontSize: theme.fontSizes.xs,
    flex: 2,
  },
  inboxMeta: {
    color: theme.colors.textMuted,
    fontSize: theme.fontSizes.xs,
  },
  doneButton: {
    minHeight: 32,
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.sm,
    borderRadius: 6,
    backgroundColor: theme.colors.surfaceSelected,
  },
  doneLabel: {
    color: theme.colors.textPrimary,
    fontSize: theme.fontSizes.xs,
    fontWeight: '600',
  },
  sweepRow: {
    minHeight: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sweepLabel: {
    color: theme.colors.textPrimary,
    fontSize: theme.fontSizes.sm,
    fontWeight: '600',
  },
  empty: {
    color: theme.colors.textMuted,
    fontSize: theme.fontSizes.sm,
    paddingHorizontal: theme.spacing.sm,
    paddingTop: theme.spacing.md,
  },
});
