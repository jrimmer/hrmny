/**
 * @cytale/mobile — the channel message list (plan 004 M6, R8 + R15; M8 R11).
 *
 * `@shopify/flash-list` (v2) over `useChannelWindow`. The list renders chat
 * order (oldest at top, newest at the bottom it opens on) and owns the three
 * states the surface cannot: the newest-page load, an older-page failure, and
 * the empty channel. Everything else — session loading, unknown channel,
 * offline, view-only, permission-denied — stays the shell scaffold's, so one
 * vocabulary serves every surface (R15).
 *
 * Anchoring: FlashList v2's `maintainVisibleContentPosition` is on by default
 * and keyed by `keyExtractor` (the message id), which is what keeps the
 * viewport still when an older page prepends; `startRenderingFromBottom`
 * lands the first render on the newest row, and `autoscrollToBottomThreshold`
 * follows new messages only while the reader is already near the bottom.
 * `onStartReached` (the TOP of this order) asks the window for older history.
 *
 * The unread divider rides `MessageRow`'s `unreadDivider` prop on the row the
 * watermark points at; `onViewableItemsChanged` retires it once scrolled past.
 *
 * M8 touch actions: rows only REPORT a long-press; the sheet state lives here,
 * ABOVE the FlashList windowing boundary, so a row recycling mid-gesture can
 * never close an open sheet. The sheet resolves its message from the current
 * window each render (web's `MessageList` rule) and every action is an
 * injected seam — the surface that owns the api client wires REST and the
 * optimistic store patch (`./reactions.ts`).
 *
 * Render cost (performance pass, P1): the list hands FlashList a DERIVED row
 * array (`MessageRowData`) that already carries everything `renderItem` used
 * to read out of the window — the neighbour's author/day (grouping + the date
 * rule), the resolved author name, and the unread flag. `renderItem` therefore
 * closes over nothing that changes when a message lands, which matters because
 * FlashList v2 memoizes each cell on `renderItem` identity
 * (`recyclerview/ViewHolder.js`): a `renderItem` that depended on `ordered`
 * changed on every window change and re-rendered every engaged cell. The
 * action seams take ids (see `MessageRow`) so no per-row closure is created,
 * and `getItemType` keeps divider-bearing rows out of the content recycle
 * pool.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { FlashList, FlashListRef, type ListRenderItemInfo } from '@shopify/flash-list';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { Message } from '@cytale/domain';
import { nicknamesForChannel, type StateStore } from '@cytale/state';

import { defaultStore, useStoreSelector } from '../navigation/store';
import { EmptyState, LoadingState } from '../navigation/SurfaceStates';
import { theme } from '../theme';
import { MessageActionsSheet } from './MessageActionsSheet';
import { mintMessageLink, type LinkableMessage, type PermalinkMinter } from './messagePermalink';
import { MessageRow, formatDateLabel } from './MessageRow';
import type { ReplyTarget } from './replyTarget';
import { useChannelWindow, type LoadMessagePage } from './useChannelWindow';
import { displayNameOf } from '@cytale/domain';

/**
 * Static prop objects: FlashList memoizes on identity, so these must not be
 * rebuilt per render (the package's own guidance).
 */
const MAINTAIN_VISIBLE = { startRenderingFromBottom: true, autoscrollToBottomThreshold: 0.2 };
const VIEWABILITY = { itemVisiblePercentThreshold: 1 };

/**
 * One render row: the message plus every value `renderItem` would otherwise
 * have to read out of the live window. Computed once per window change by the
 * list (see the module docs) — the array is what FlashList receives as `data`.
 */
export interface MessageRowData {
  message: Message;
  /** Resolved author display name (roster → self → raw id). */
  authorName: string;
  /** Continuation cadence: same author + day as the row above, not a reply. */
  grouped: boolean;
  /** Date rule above this row (the calendar day changed); null = none. */
  dateLabel: string | null;
  /** The unread "NEW" divider renders above this row. */
  unreadDivider: boolean;
  /**
   * Recycle-pool key. A divider-bearing row has a different shape from a plain
   * content row, so it must not share a pool with one (FlashList's
   * `getItemType` contract).
   */
  itemType: 'divider' | 'content';
}

export interface MessageListProps {
  channelId: string;
  /** Stable page loader (see `useChannelWindow`). */
  loadPage: LoadMessagePage;
  /** Store holding the window; `defaultStore` in production. */
  store?: StateStore;
  /** Session gate — false while unauthenticated (no fetch). */
  enabled?: boolean;
  /** Current user id; defaults to the store's. */
  currentUserId?: string | null;
  /** Empty-channel copy (the surface's DoD text). */
  emptyTitle?: string;
  emptyHint?: string;
  /** Opens link runs; default is the platform browser. */
  onOpenLink?: (href: string) => void;
  /**
   * Reply seam (plan 004 M8/M7 contract): the sheet builds the target and
   * calls this; the composer focuses and renders the reply bar.
   */
  onReply?: (target: ReplyTarget) => void;
  /** Toggle one emoji on one message (chips + sheet). */
  onToggleReaction?: (messageId: string, emoji: string) => void;
  /** Sheet edit commit (host owns the REST call). */
  onEditSubmit?: (messageId: string, content: string) => void;
  /** Sheet delete confirm (host owns the REST call). */
  onDeleteConfirmed?: (messageId: string) => void;
  /** Sheet thread creation (host owns the REST call + navigation). */
  onStartThreadNamed?: (messageId: string, name: string) => void;
  /** True when the viewer holds MANAGE_MESSAGES (sheet delete gate). */
  canManageMessages?: boolean;
  /** Sheet copy seam; defaults to RN's Clipboard. */
  onCopy?: (text: string) => void;
  /**
   * The keyboard's frame height (2026-09-19/20 keyboard round): when it
   * changes the list scrolls its last row above the composer — without this
   * the newest messages stayed pinned behind the keyboard (device feedback
   * 2442).
   */
  keyboardInset?: number;
  /**
   * The permalink minter (#118, `POST /permalinks`). Production omits it — the
   * default mints through the live session's api client — and tests inject one
   * (see `./messagePermalink`).
   */
  mintPermalink?: PermalinkMinter;
  testID?: string;
}

export function MessageList({
  channelId,
  loadPage,
  keyboardInset,
  store = defaultStore,
  enabled = true,
  currentUserId,
  emptyTitle = 'No messages yet',
  emptyHint = 'Be the first to say something in this channel.',
  onOpenLink,
  onReply,
  onToggleReaction,
  onEditSubmit,
  onDeleteConfirmed,
  onStartThreadNamed,
  canManageMessages = false,
  onCopy,
  mintPermalink,
  testID = 'message-list',
}: MessageListProps) {
  const {
    ordered,
    loadState,
    loadingOlder,
    olderError,
    dividerId,
    retry,
    loadOlder,
    handleViewableItemsChanged,
  } = useChannelWindow({
    channelId,
    store,
    loadPage,
    enabled,
    ...(currentUserId === undefined ? {} : { currentUserId }),
  });

  const membersById = useStoreSelector(store, (state) => state.membersById);
  // This channel's workspace nicknames (#169); undefined in a DM.
  const nicknames = useStoreSelector(store, (state) => nicknamesForChannel(state, channelId));
  const selfUser = useStoreSelector(store, (state) => state.currentUser);
  const viewerId = currentUserId === undefined ? (selfUser?.id ?? null) : currentUserId;

  /**
   * #118 Copy link: the permalink is MINTED, not assembled — the token is keyed
   * server-side, so the builder here asks the session's api client
   * (`POST /permalinks`) and hands the sheet an absolute
   * `https://<origin>/m/<token>` to write. One round trip, and the sheet
   * reports a failure as a failure: there is no legacy fragment fallback,
   * which would publish the ids the token exists to keep off the link.
   */
  const messageLink = useCallback(
    (message: LinkableMessage) => mintMessageLink(message, mintPermalink),
    [mintPermalink],
  );

  // -- M8 touch actions: one sheet for the whole list, keyed by message id --
  const [sheetMessageId, setSheetMessageId] = useState<string | null>(null);
  const openSheet = useCallback((messageId: string) => setSheetMessageId(messageId), []);
  const closeSheet = useCallback(() => setSheetMessageId(null), []);
  const handleSheetOpenChange = useCallback(
    (open: boolean) => {
      if (!open) closeSheet();
    },
    [closeSheet],
  );
  // Resolve against the live window each render: a reaction/edit lands on the
  // same row object the sheet is showing, and a row leaving the window (never
  // a rewindow — the sheet is outside FlashList) closes the sheet.
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

  /**
   * The render rows: chat order plus every neighbour-derived value (grouping
   * cadence, date rule, resolved author, unread flag). Recomputed only when
   * the window, the divider, or the roster changes — NOT when the list
   * re-renders for an unrelated reason, and never inside `renderItem`.
   */
  const rows = useMemo<MessageRowData[]>(() => {
    return ordered.map((message, index) => {
      const above = index > 0 ? ordered[index - 1] : undefined;
      // Calendar day change vs the row above → date rule.
      const dateChanged =
        above === undefined ||
        new Date(above.created_at).toDateString() !== new Date(message.created_at).toDateString();
      // Same author, same day, not a reply context → continuation cadence.
      const grouped =
        above !== undefined && above.author_id === message.author_id && !dateChanged && !message.referenced;

      const member = membersById[message.author_id];
      const selfName =
        selfUser !== null && selfUser.id === message.author_id ? selfUser.username : undefined;
      const authorName =
        displayNameOf(member && { ...member, nickname: nicknames?.[member.id] ?? null }) ||
        selfName ||
        message.author_id;
      const unreadDivider = message.id === dividerId;

      return {
        message,
        authorName,
        grouped,
        dateLabel: dateChanged ? formatDateLabel(message.created_at) : null,
        unreadDivider,
        itemType: dateChanged || unreadDivider ? 'divider' : 'content',
      };
    });
  }, [dividerId, membersById, ordered, selfUser, nicknames]);

  /**
   * Stable by construction: every input comes off the row (the derived data),
   * or is a stable callback. This identity is what keeps FlashList's per-cell
   * memo intact across window changes (see the module docs).
   */
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<MessageRowData>) => (
      <MessageRow
        message={item.message}
        authorName={item.authorName}
        grouped={item.grouped}
        dateLabel={item.dateLabel}
        unreadDivider={item.unreadDivider}
        resolveMention={resolveMention}
        onLongPress={openSheet}
        onOpenLink={onOpenLink}
        onToggleReaction={onToggleReaction}
      />
    ),
    [onOpenLink, onToggleReaction, openSheet, resolveMention],
  );

  const keyExtractor = useCallback((row: MessageRowData) => row.message.id, []);

  /** Divider rows get their own recycle pool (see `MessageRowData.itemType`). */
  const getItemType = useCallback((row: MessageRowData) => row.itemType, []);

  const body = useMemo(() => {
    if (loadState.status === 'loading') return <LoadingState label="Loading messages…" />;
    if (loadState.status === 'error') {
      return (
        <View style={styles.errorBlock} role="alert" accessibilityRole="alert" testID="message-list-error">
          <Text style={styles.errorText}>{loadState.error}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry loading messages"
            onPress={retry}
            testID="message-list-retry"
            style={({ pressed }) => [styles.retry, pressed ? styles.retryPressed : null]}
          >
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      );
    }
    if (ordered.length === 0) return <EmptyState title={emptyTitle} hint={emptyHint} />;
    return (
      <>
        <FlashList
          ref={listRef}
          onLayout={(event) => {
            const height = event.nativeEvent.layout.height;
            const previous = lastListHeight.current;
            lastListHeight.current = height;
            // Only a SHRINK follows the keyboard (opening). Growing (the
            // keyboard closing) needs no scroll — the anchored top keeps
            // context, and the reader's position was already above.
            if (previous !== null && height < previous - 1) scrollToEndSettled();
          }}
          testID={testID}
          data={rows}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          getItemType={getItemType}
          maintainVisibleContentPosition={MAINTAIN_VISIBLE}
          viewabilityConfig={VIEWABILITY}
          onViewableItemsChanged={handleViewableItemsChanged}
          onStartReached={loadOlder}
        />
        {loadingOlder ? (
          <Text style={styles.footer} testID="message-list-loading-older">
            Loading older messages…
          </Text>
        ) : null}
        {olderError === null ? null : (
          <View style={styles.footerError} role="alert" accessibilityRole="alert" testID="message-list-older-error">
            <Text style={styles.errorText}>{olderError}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retry loading older messages"
              onPress={loadOlder}
              testID="message-list-older-retry"
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
    handleViewableItemsChanged,
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

  const listRef = useRef<FlashListRef<MessageRowData> | null>(null);

  // Keyboard round (device feedback 2442, twice): the timer-based
  // scrollToEnd did not survive the keyboard animation — the container's
  // resize re-anchors the list (maintainVisibleContentPosition holds the
  // TOP item) and cuts the newest rows behind the composer. Layout-driven
  // instead: whenever the list's own height SHRINKS (the keyboard inset
  // took it), scroll to the end after the layout settles — onLayout fires
  // when the resize is committed, so the scroll lands on the final tree.
  const lastListHeight = useRef<number | null>(null);
  const scrollToEndSettled = useCallback(() => {
    // Two rAF-equivalent beats: the layout commit, then the content
    // re-measure FlashList performs after it.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        listRef.current?.scrollToEnd({ animated: false });
      });
    });
  }, []);

  return (
    <View style={styles.root} testID={`${testID}-root`}>
      {body}
      {/* M8: the long-press actions sheet — hosted ABOVE the FlashList
          windowing boundary (one sheet for the whole list; rows only report
          the gesture). `Modal` is the platform layer above every cell. */}
      {sheetMessage === undefined ? null : (
        <MessageActionsSheet
          message={sheetMessage}
          open
          onOpenChange={handleSheetOpenChange}
          currentUserId={viewerId}
          canManageMessages={canManageMessages}
          {...(onToggleReaction === undefined ? {} : { onToggleReaction })}
          {...(onReply === undefined ? {} : { onReply })}
          {...(onEditSubmit === undefined ? {} : { onEditSubmit })}
          {...(onDeleteConfirmed === undefined ? {} : { onDeleteConfirmed })}
          {...(onStartThreadNamed === undefined ? {} : { onStartThreadNamed })}
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
