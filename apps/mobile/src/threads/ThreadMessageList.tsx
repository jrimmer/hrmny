/**
 * @cytale/mobile — the thread reply list (plan 004 M9, R12 + R15).
 *
 * `MessageList` is channel-bound (`channelId` + `useChannelWindow` reading
 * `messagesByChannel`), so the thread surface composes the same pieces around
 * its own window: the same `MessageRow` (grouping, date rules, markdown,
 * mentions), the same `MessageActionsSheet` hosted ABOVE the FlashList
 * windowing boundary, and the same states-first vocabulary. Row behaviour is
 * therefore identical between a channel and a thread — only the data source
 * differs.
 *
 * Anchoring mirrors the channel list: FlashList v2's
 * `maintainVisibleContentPosition` (default on, keyed by message id) holds the
 * viewport while an older page prepends, `startRenderingFromBottom` opens on
 * the newest reply, and `onStartReached` (the TOP of this order) asks the
 * window for older history.
 *
 * Action set: edit, copy, delete — the sheet's rows without a wired handler
 * do not render. Reactions are deliberately not wired (the mobile reaction
 * seam patches `messagesByChannel`, not `messagesByThread`, and web's thread
 * panel carries no chip row either) and there is no reply-in-thread target
 * (web parity; the thread reply endpoint does not consume `reply_to_id`).
 *
 * Render cost (performance pass, P1): the same derived-rows treatment as the
 * channel list — `renderItem` reads everything it needs off the row (author
 * name, grouping, date rule) instead of closing over the live window, because
 * FlashList memoizes each cell on `renderItem` identity. `getItemType` keeps
 * divider-bearing rows out of the content recycle pool.
 */
import { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { FlashList, type ListRenderItemInfo } from '@shopify/flash-list';

import type { Message } from '@cytale/domain';
import { nicknamesForChannel, type StateStore } from '@cytale/state';

import { defaultStore, useStoreSelector } from '../navigation/store';
import { EmptyState, LoadingState } from '../navigation/SurfaceStates';
import { theme } from '../theme';
import { MessageActionsSheet } from '../messages/MessageActionsSheet';
import {
  mintMessageLink,
  type LinkableMessage,
  type PermalinkMinter,
} from '../messages/messagePermalink';
import { MessageRow, formatDateLabel } from '../messages/MessageRow';
import { useThreadWindow, type LoadThreadPage } from './useThreadWindow';
import { displayNameOf } from '@cytale/domain';

/** Static prop objects (FlashList memoizes on identity). */
const MAINTAIN_VISIBLE = { startRenderingFromBottom: true, autoscrollToBottomThreshold: 0.2 };

/**
 * One render row: the reply plus the neighbour-derived values `renderItem`
 * needs. Built once per window change (see the module docs).
 */
export interface ThreadRowData {
  message: Message;
  authorName: string;
  grouped: boolean;
  /** Date rule above this row (the calendar day changed); null = none. */
  dateLabel: string | null;
  /** Recycle-pool key (a divider row is not a content row). */
  itemType: 'divider' | 'content';
}

export interface ThreadMessageListProps {
  threadId: string;
  /** Stable page loader (see `useThreadWindow`). */
  loadPage: LoadThreadPage;
  /** Store holding the window; `defaultStore` in production. */
  store?: StateStore;
  /** Session gate — false while unauthenticated (no fetch). */
  enabled?: boolean;
  /** Current user id; defaults to the store's. */
  currentUserId?: string | null;
  /** Empty-thread copy (the surface's DoD text). */
  emptyTitle?: string;
  emptyHint?: string;
  /** Opens link runs; default is the platform browser. */
  onOpenLink?: (href: string) => void;
  /** Sheet edit commit (host owns the REST call). */
  onEditSubmit?: (messageId: string, content: string) => void;
  /** Sheet delete confirm (host owns the REST call). */
  onDeleteConfirmed?: (messageId: string) => void;
  /** True when the viewer holds MANAGE_MESSAGES (sheet delete gate). */
  canManageMessages?: boolean;
  /** Sheet copy seam; defaults to RN's Clipboard. */
  onCopy?: (text: string) => void;
  /**
   * The permalink minter (#118, `POST /permalinks`). Production omits it — the
   * default mints through the live session's api client — and tests inject one
   * (see `../messages/messagePermalink`).
   */
  mintPermalink?: PermalinkMinter;
  testID?: string;
}

export function ThreadMessageList({
  threadId,
  loadPage,
  store = defaultStore,
  enabled = true,
  currentUserId,
  emptyTitle = 'No replies yet',
  emptyHint = 'Start the conversation.',
  onOpenLink,
  onEditSubmit,
  onDeleteConfirmed,
  canManageMessages = false,
  onCopy,
  mintPermalink,
  testID = 'thread-message-list',
}: ThreadMessageListProps) {
  const { ordered, loadState, loadingOlder, olderError, retry, loadOlder } = useThreadWindow({
    threadId,
    store,
    loadPage,
    enabled,
  });

  const membersById = useStoreSelector(store, (state) => state.membersById);
  // This channel's workspace nicknames (#169); undefined in a DM.
  const nicknames = useStoreSelector(store, (state) => nicknamesForChannel(state, state.threadsById[threadId]?.channel_id));
  const selfUser = useStoreSelector(store, (state) => state.currentUser);
  const viewerId = currentUserId === undefined ? (selfUser?.id ?? null) : currentUserId;

  /**
   * #118 Copy link: the permalink is MINTED, not assembled — the token is keyed
   * server-side, so the builder here asks the session's api client
   * (`POST /permalinks`) and hands the sheet an absolute
   * `https://<origin>/m/<token>` to write.
   *
   * The ids it mints are the reply's `channel_id` — its PARENT channel, which
   * the store stamps from `threadsById` when the reply lands — and the reply's
   * own id. Never the thread id: the token is keyed `(channel, message)`, and
   * the parent channel is what makes the landing open the reply INSIDE its
   * thread.
   */
  const messageLink = useCallback(
    (message: LinkableMessage) => mintMessageLink(message, mintPermalink),
    [mintPermalink],
  );

  // One sheet for the whole list, keyed by message id, hosted above the
  // FlashList windowing boundary (a recycling row can never close it).
  const [sheetMessageId, setSheetMessageId] = useState<string | null>(null);
  const openSheet = useCallback((messageId: string) => setSheetMessageId(messageId), []);
  const closeSheet = useCallback(() => setSheetMessageId(null), []);
  const handleSheetOpenChange = useCallback(
    (open: boolean) => {
      if (!open) closeSheet();
    },
    [closeSheet],
  );
  const sheetMessage =
    sheetMessageId === null ? undefined : ordered.find((m) => m.id === sheetMessageId);

  /** Roster name → session self → raw id (web's `resolveMention` order). */
  const resolveMention = useCallback(
    (id: string): string | undefined => {
      const member = membersById[id];
      if (member) return displayNameOf({ ...member, nickname: nicknames?.[id] ?? null });
      if (selfUser && selfUser.id === id) return selfUser.username;
      return undefined;
    },
    [membersById, nicknames, selfUser],
  );

  /** Chat order plus every neighbour-derived value (see the module docs). */
  const rows = useMemo<ThreadRowData[]>(() => {
    return ordered.map((message, index) => {
      const above = index > 0 ? ordered[index - 1] : undefined;
      const dateChanged =
        above === undefined ||
        new Date(above.created_at).toDateString() !== new Date(message.created_at).toDateString();
      const grouped =
        above !== undefined && above.author_id === message.author_id && !dateChanged && !message.referenced;

      const member = membersById[message.author_id];
      const selfName =
        selfUser !== null && selfUser.id === message.author_id ? selfUser.username : undefined;
      const authorName =
        displayNameOf(member && { ...member, nickname: nicknames?.[member.id] ?? null }) ||
        selfName ||
        message.author_id;

      return {
        message,
        authorName,
        grouped,
        dateLabel: dateChanged ? formatDateLabel(message.created_at) : null,
        itemType: dateChanged ? 'divider' : 'content',
      };
    });
  }, [membersById, ordered, selfUser, nicknames]);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<ThreadRowData>) => (
      <MessageRow
        message={item.message}
        authorName={item.authorName}
        grouped={item.grouped}
        dateLabel={item.dateLabel}
        resolveMention={resolveMention}
        onLongPress={openSheet}
        onOpenLink={onOpenLink}
      />
    ),
    [onOpenLink, openSheet, resolveMention],
  );

  const keyExtractor = useCallback((row: ThreadRowData) => row.message.id, []);

  /** Divider rows get their own recycle pool (see `ThreadRowData.itemType`). */
  const getItemType = useCallback((row: ThreadRowData) => row.itemType, []);

  const body = useMemo(() => {
    if (loadState.status === 'loading') {
      return <LoadingState label="Loading replies…" testID="thread-list-loading" />;
    }
    if (loadState.status === 'error') {
      return (
        <View
          style={styles.errorBlock}
          role="alert"
          accessibilityRole="alert"
          testID="thread-list-error"
        >
          <Text style={styles.errorText}>{loadState.error}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry loading replies"
            onPress={retry}
            testID="thread-list-retry"
            style={({ pressed }) => [styles.retry, pressed ? styles.retryPressed : null]}
          >
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      );
    }
    if (ordered.length === 0) {
      return <EmptyState title={emptyTitle} hint={emptyHint} testID="thread-list-empty" />;
    }
    return (
      <>
        <FlashList
          testID={testID}
          data={rows}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          getItemType={getItemType}
          maintainVisibleContentPosition={MAINTAIN_VISIBLE}
          onStartReached={loadOlder}
        />
        {loadingOlder ? (
          <Text style={styles.footer} testID="thread-list-loading-older">
            Loading older replies…
          </Text>
        ) : null}
        {olderError === null ? null : (
          <View
            style={styles.footerError}
            role="alert"
            accessibilityRole="alert"
            testID="thread-list-older-error"
          >
            <Text style={styles.errorText}>{olderError}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retry loading older replies"
              onPress={() => void loadOlder()}
              testID="thread-list-older-retry"
              style={({ pressed }) => [styles.retry, pressed ? styles.retryPressed : null]}
            >
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          </View>
        )}
      </>
    );
  }, [
    emptyHint,
    emptyTitle,
    getItemType,
    keyExtractor,
    loadOlder,
    loadState,
    loadingOlder,
    olderError,
    ordered,
    renderItem,
    retry,
    rows,
    testID,
  ]);

  return (
    <View style={styles.root} testID={`${testID}-root`}>
      {body}
      {sheetMessage === undefined ? null : (
        <MessageActionsSheet
          message={sheetMessage}
          open
          onOpenChange={handleSheetOpenChange}
          currentUserId={viewerId}
          canManageMessages={canManageMessages}
          {...(onEditSubmit === undefined ? {} : { onEditSubmit })}
          {...(onDeleteConfirmed === undefined ? {} : { onDeleteConfirmed })}
          {...(onCopy === undefined ? {} : { onCopy })}
          onCopyLink={messageLink}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  errorBlock: {
    flexGrow: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.spacing.xl,
    gap: theme.spacing.md,
  },
  errorText: {
    color: theme.colors.danger,
    fontSize: theme.fontSizes.md,
    fontWeight: '600',
    textAlign: 'center',
  },
  footerError: {
    alignItems: 'center',
    padding: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  retry: {
    minHeight: 44,
    minWidth: 88,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radii.md,
    backgroundColor: theme.colors.surfaceEmphasized,
  },
  retryPressed: {
    backgroundColor: theme.colors.surfaceHover,
  },
  retryText: {
    color: theme.colors.textPrimary,
    fontSize: theme.fontSizes.md,
    fontWeight: '600',
  },
  footer: {
    color: theme.colors.textMuted,
    fontSize: theme.fontSizes.xs,
    textAlign: 'center',
    paddingVertical: theme.spacing.sm,
  },
});
