/**
 * @cytale/web — thread side-panel (U22).
 *
 * A docked right-hand split that takes the member-list slot. Doctrine
 * (binding, 2026-08-27): this is NOT a special-cased surface — it is the
 * same message-panel component rendered narrower. The replies ARE the U21
 * MessageList in thread mode (#15): the channel's own row (avatar, @tag,
 * grouping, date dividers, reactions, the full hover toolbar and the
 * long-press sheet), virtualized, with older replies paged in as the reader
 * scrolls up. The composer is the U21 MessageCompose (via ThreadCompose).
 * The parent channel stays visible to the left; the starter line and the
 * origin message sit above the first reply, scrolling with the thread.
 *
 * Header row: thread icon/title, the thread's notification LEVEL control
 * (2026-09-27: the shared three-state header control, thread scope,
 * inheriting its channel), ellipsis overflow, close ×. Follow/Unfollow lives
 * in the ⋯ menu and toggles the membership notify flag.
 *
 * WCAG 2.1 AA: the panel is a real region with an accessible name; the close
 * and follow controls are real buttons; the panel is keyboard-reachable.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '../../components/shadcn/dialog.js';

import type { Message, Thread } from '@cytale/domain';
import {
  defaultStore,
  draftThreadKey,
  dropEmptyDraftThread,
  nicknamesForChannel,
  type StateStore,
} from '@cytale/state';

import { useShellBand } from '../../app/layout/useShellBand.js';
import { useStoreSelector } from '../../app/useStoreSelector.js';
import { ConfirmDialog } from '../../app/ui/ConfirmDialog.js';
import { PaneErrorBanner, PaneSkeleton } from '../../app/ui/PaneStates.js';
import { MessageItem } from '../messages/MessageItem.js';
import { MessageList, type MessageListLoadState } from '../messages/MessageList.js';
import { createMentionResolver } from '../messages/mentionResolver.js';
import { dmParticipants } from '../messages/dmRoster.js';
import { actorName, resolveAuthor } from '../messages/authorIdentity.js';
import { useMessages } from '../messages/useMessages.js';
import { useReplyTarget } from '../messages/useReplyTarget.js';
import { ThreadCompose } from './ThreadCompose.js';
import type { ComposerHandle } from '../messages/MessageCompose.js';
import type { UseTyping } from '../presence/useTyping.js';
import { useFileDropZone } from '../messages/useFileDropZone.js';
import { formatClock, formatLongDate } from '../../app/ui/time.js';
import { DropOverlay } from '../messages/DropOverlay.js';
import type { ClipboardWriter } from '../messages/clipboard.js';
import { ThreadIcon } from '../../app/ui/icons.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/shadcn/dropdown-menu.js';
import type { PermalinkMinter } from '../messages/messagePermalink.js';
import { useThreads, type UseThreads } from './useThreads.js';
import { NotificationLevelControl } from '../notifications/NotificationLevelControl.js';
import { threadTarget } from '../notifications/notificationPrefs.js';
import { paneCloseButtonClass } from '../../app/ui/button.js';
import { SendRowActionsContext, useSendRowActions } from '../messages/SendStatus.js';

export interface ThreadSidePanelProps {
  /**
   * The thread to display, or `null` for a DRAFT: a thread is only created
   * when its first reply is sent, so opening the panel from "Start thread"
   * creates nothing. Closing a draft leaves nothing behind (user direction
   * 2026-09-12: "the thread shouldn't be created if there aren't any replies
   * in it"). Drafts take `parentMessageId` + `draftName` instead.
   */
  threadId: string | null;
  /** The parent channel id (for the pinned origin message + composer). */
  channelId: string;
  /** Draft only: the seed message the created thread will hang off. */
  parentMessageId?: string | null;
  /** Draft only: the name the created thread will carry (seed-derived). */
  draftName?: string;
  /** U17 store (injectable for tests; app uses the module default). */
  store?: StateStore;
  /** The threads hook (injectable for tests; defaults to useThreads). */
  threads?: UseThreads;
  /** The parent (origin) message to pin at the top. */
  parentMessage?: Message | null;
  /** Called when the user closes the panel. */
  onClose?: () => void;
  /** Called once the draft's first reply created the thread. */
  onThreadCreated?: (thread: Thread) => void;
  /**
   * A reply the panel must LAND on instead of its newest (#114): a permalink
   * to a thread reply opens the thread AT the reply. The row is scrolled into
   * view and flashed once, replacing the newest/unread landing above.
   */
  focusMessageId?: string | null;
  /** Tests inject the clipboard writer for Copy Link (#114/#118). */
  clipboardWriter?: ClipboardWriter;
  /** Tests inject the Copy Link minter (#118); defaults to the session api. */
  permalinkMinter?: PermalinkMinter;
  /** Override the typing hook (tests). Live sessions use the default — the
      composer owns the indicator, this only carries the seam through. */
  typing?: UseTyping;
  /** True when the viewer holds MANAGE_MESSAGES in the parent channel. */
  canManageMessages?: boolean;
  /** Read-only viewer: row controls pre-disabled, as in the channel pane. */
  viewOnly?: boolean;
}

export function ThreadSidePanel({
  threadId,
  channelId,
  parentMessageId,
  draftName,
  store: storeProp,
  threads,
  parentMessage,
  onClose,
  onThreadCreated,
  focusMessageId = null,
  clipboardWriter,
  permalinkMinter,
  typing,
  canManageMessages = false,
  viewOnly = false,
}: ThreadSidePanelProps) {
  const store = storeProp ?? defaultStore;
  const defaultThreads = useThreads(store);
  const t = threads ?? defaultThreads;
  // A draft has no thread record, no replies and no membership to follow:
  // every thread-scoped read below is gated on the id.
  const isDraft = threadId === null;
  const thread = threadId === null ? null : t.thread(threadId);
  /*
   * The window the list shows. A draft has one too (2026-10-01): its client
   * key (`draftThreadKey`), where the first reply is drawn the moment it is
   * sent — the thread itself is only created by that send, and then takes
   * the draft's window over in place.
   */
  const draftKey = parentMessageId != null ? draftThreadKey(channelId, parentMessageId) : null;
  const listThreadId = threadId ?? draftKey;
  /*
   * The list's mount identity. A draft and the thread its first reply created
   * are ONE conversation, so the list keeps the draft's key across that
   * switch: the rows on screen stay mounted, and nothing blanks or reloads
   * (owner, 2026-10-01: "the thread panel goes black with some gray
   * skeletons, the thread panel flashes" — the old key was the thread id, so
   * the switch mounted a fresh list, empty, under a loading skeleton).
   */
  const [promoted, setPromoted] = useState<{ threadId: string; key: string } | null>(null);
  const listKey = promoted !== null && promoted.threadId === threadId ? promoted.key : listThreadId;
  const handleThreadCreated = useCallback(
    (created: Thread) => {
      // Same task as the host's switch and the store's promotion: one render.
      if (draftKey !== null) setPromoted({ threadId: created.id, key: draftKey });
      onThreadCreated?.(created);
    },
    [draftKey, onThreadCreated],
  );
  const replies = listThreadId === null ? NO_REPLIES : t.replies(listThreadId);
  // A draft that was opened and closed leaves no window behind; one holding a
  // failed first reply keeps it (Retry/Edit/Delete when the draft reopens).
  useEffect(() => {
    if (draftKey === null || threadId !== null) return;
    return () => dropEmptyDraftThread(store, draftKey);
  }, [draftKey, threadId, store]);
  /** The first reply newer than the watermark captured when this thread was
      opened — the marker's position, and the open's landing target (#104). */
  const firstUnread = threadId === null ? null : t.firstUnreadId(threadId);
  const notified = threadId === null ? false : t.isNotified(threadId);
  /*
   * The panel's own store reads — SELECTED (#15). `useThreads` no longer
   * re-renders its consumers on every write (it selects the thread slices it
   * reads), so the roster, the session user and the parent channel the origin
   * row and the header resolve names from are subscribed to here, each by
   * identity: a presence flip or another channel's message re-renders
   * nothing. The replies' own rows read the same slices inside the list.
   */
  const membersById = useStoreSelector(store, (s) => s.membersById);
  const currentUser = useStoreSelector(store, (s) => s.currentUser);
  const currentUserId = currentUser?.id ?? null;
  /** This pane's parent channel — only DM identity reads it (dmRoster.ts). */
  const channel = useStoreSelector(store, (s) => s.channels[channelId]);
  // This workspace's nicknames (#169); undefined in a DM.
  const nicknames = useStoreSelector(store, (s) => nicknamesForChannel(s, channelId));
  // The thread level's fallback chain: thread → channel → workspace (a DM
  // thread has none) → account.
  const threadWorkspaceId = channel?.workspace_id ?? null;
  // Inline reply inside the thread: the channel pane's hook, so the reply bar,
  // ping toggle and Escape behave the same in both.
  const { replyTo, startReply, cancelReply, togglePing } = useReplyTarget(store, channelId);
  // A reply target belongs to the thread it was started in.
  useEffect(() => cancelReply(), [threadId, cancelReply]);

  // Mentions in the pinned origin and in every reply resolve through the SAME
  // chain the channel list uses (mentionResolver.ts: roster nickname →
  // username, then the session self, the raw id last). This panel renders
  // `MessageItem` directly, so with no resolver the pills fell back to the
  // raw snowflake (#128). The DM merge matches MessageList's: a thread can
  // hang off a DM, and the workspace roster alone would snowflake its peers.
  //
  // BOTH are memoized, and that is load-bearing, not tidiness:
  // `createMentionResolver` returns a NEW function, so building it in the
  // render body handed every reply row a fresh `resolveMention` on every
  // render — the one prop that changed — and `MessageItem`'s shallow `memo`
  // could never bail out. Every unrelated store write (a presence flip, a
  // typing tick, another channel's message) therefore re-ran the body of
  // every one of the thread's rows. `MessageList` hoisted the same seam for
  // its own rows (#137, app-level finding 3); this is the thread panel's.
  const mentionRoster = useMemo(() => {
    const dmRows = dmParticipants(channel);
    return Object.keys(dmRows).length === 0
      ? membersById
      : ({ ...membersById, ...dmRows } as typeof membersById);
  }, [channel, membersById]);
  const resolveMention = useMemo(
    () => createMentionResolver(mentionRoster, currentUser, nicknames),
    [mentionRoster, currentUser, nicknames],
  );

  // The pinned origin names its author through the shared resolver
  // (authorIdentity.ts) — the same one the reply rows below use.
  const attributionFor = (message: Message) => {
    const who = resolveAuthor(mentionRoster, message.author_id, { self: currentUser, nicknames });
    return {
      authorName: who.name,
      authorTag: who.tag,
      authorAvatarUrl: who.avatarUrl,
      authorKind: who.kind,
      authorParentName: who.parentName,
    };
  };

  /*
   * The unread slice the list lands on (#104), in the list's own shape: the
   * reply just before the first unread one is the watermark. `useThreads`
   * captured the boundary when the thread was OPENED (its read-mark clears the
   * live one), so it is derived from that capture, not from the store.
   */
  const unreadAtOpen = useMemo(() => {
    if (threadId === null) return null;
    if (firstUnread === null) return { lastReadId: null, unreadCount: 0 };
    const chronological = [...replies].reverse();
    const at = chronological.findIndex((m) => m.id === firstUnread);
    return { lastReadId: at > 0 ? chronological[at - 1]!.id : null, unreadCount: 1 };
    // `replies` is read for the boundary's neighbour only; the capture is what
    // decides, so a new reply arriving does not re-derive the landing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, firstUnread]);

  // The newest page goes through the hook (the call log and the tests share
  // that seam); older/newer pages are the list's own thread-scoped reads.
  // Deps are the STABLE loadReplies callback, NOT the hook's container
  // object — the container is a fresh object every render.
  const { loadReplies } = t;
  // Lane D #1: a fresh gateway session re-reads the replies too. The pane used
  // to be REMOUNTED for that (the shell keyed it by the session epoch), which
  // flashed it; the epoch is a dependency of the loader instead, so a new
  // session hands the list a new loader and it reloads in place.
  const sessionEpoch = useStoreSelector(store, (s) => s.sessionEpoch);
  const loadNewest = useCallback(
    () => (threadId === null ? Promise.resolve() : loadReplies(threadId)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sessionEpoch IS the trigger
    [threadId, loadReplies, sessionEpoch],
  );
  const [loadState, setLoadState] = useState<MessageListLoadState>({ status: 'loading' });
  const [retryKey, setRetryKey] = useState(0);

  // Row actions — the channel pane's, scoped to this thread's rows. The
  // reaction/edit/delete effects are the shared `useMessages` ones: they find
  // a reply in its thread slice, so a thread row reacts, edits and deletes
  // exactly as a channel row does.
  //
  // The hook's MEMBERS are stable callbacks; its container object is not —
  // every handler below depends on the members, or a panel re-render would
  // hand every row fresh props and defeat the row memo.
  const {
    edit: editMessage,
    remove: removeMessage,
    toggleReaction: toggleMessageReaction,
    reactionError: readReactionError,
    clearReactionError,
  } = useMessages(store);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const handleEdit = useCallback((messageId: string) => setEditingMessageId(messageId), []);
  const handleCancelEdit = useCallback(() => setEditingMessageId(null), []);
  const handleSaveEdit = useCallback(
    async (messageId: string, content: string) => {
      await editMessage(channelId, messageId, content);
      setEditingMessageId(null);
    },
    [editMessage, channelId],
  );
  const handleEditSubmit = useCallback(
    (messageId: string, content: string) => {
      void editMessage(channelId, messageId, content).catch(() => undefined);
    },
    [editMessage, channelId],
  );
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const handleDelete = useCallback((messageId: string) => setDeleteTarget(messageId), []);
  const handleDeleteConfirmed = useCallback(
    (messageId: string) => {
      void removeMessage(channelId, messageId).catch(() => undefined);
    },
    [removeMessage, channelId],
  );
  const toggleReaction = useCallback(
    (messageId: string, emoji: string) => {
      void toggleMessageReaction(channelId, messageId, emoji).catch(() => undefined);
    },
    [toggleMessageReaction, channelId],
  );
  const reactionError = readReactionError();
  const retryReaction = toggleReaction;

  // The toggle is NOT optimistic (useThreads patches the store only after
  // the API confirms), so a failure must say so — the silent swallow is why
  // the bell read as a dead button (2026-09-10). Drafts have no membership
  // yet, so the header hides the bell entirely (below).
  const [followError, setFollowError] = useState<string | null>(null);
  const handleFollowToggle = useCallback(() => {
    if (threadId === null) return;
    setFollowError(null);
    const action = notified ? t.unfollow(threadId) : t.follow(threadId);
    void action.catch(() =>
      setFollowError("Couldn't update notifications for this thread."),
    );
  }, [notified, threadId, t]);

  // Thread options (the ⋯ menu): Mark Unread + Leave Thread. Both are
  // destructive-ish; failures surface in the same inline alert slot as the
  // bell's. A Radix DropdownMenu like every other menu in the app (UI
  // consistency, 2026-09-27): the hand-rolled role=menu had no arrow keys,
  // never took focus, and Escape left focus nowhere.
  const [optionsOpen, setOptionsOpen] = useState(false);

  const markUnread = useCallback(() => {
    if (threadId === null) return;
    setOptionsOpen(false);
    setFollowError(null);
    void t.markUnread(threadId).catch(() =>
      setFollowError("Couldn't mark the thread unread."),
    );
  }, [t, threadId]);

  const leaveThread = useCallback(() => {
    if (threadId === null) return;
    setOptionsOpen(false);
    setFollowError(null);
    void t
      .leave(threadId)
      .then(() => onClose?.())
      .catch(() => setFollowError("Couldn't leave the thread."));
  }, [t, threadId, onClose]);

  /*
   * Archive (#109). Offered to the thread's CREATOR — the server also allows a
   * parent-channel moderator (`manage_messages`/`manage_threads`), but the
   * client holds no per-channel permission bits yet, so a moderator who did not
   * create the thread archives from another surface rather than being shown a
   * button that might 403. The unarchive direction is the same control.
   *
   * The panel does NOT close on archive: the thread stays readable (archiving
   * hides it from the listings, it does not remove it), so a surface vanishing
   * under the cursor would be a worse answer than the state notice below.
   */
  const isArchived = thread?.archived === true;
  const isCreator = thread != null && currentUserId !== null && thread.created_by === currentUserId;

  const toggleArchived = useCallback(() => {
    if (threadId === null || thread == null) return;
    const next = !thread.archived;
    setOptionsOpen(false);
    setFollowError(null);
    void t
      .archive(threadId, next)
      .catch(() =>
        setFollowError(next ? "Couldn't archive the thread." : "Couldn't unarchive the thread."),
      );
  }, [t, thread, threadId]);

  const title = thread?.name ?? draftName ?? (threadId === null ? 'New thread' : `Thread ${threadId}`);

  // Resolve the pinned parent's attribution once (three props share it).
  const parentAttribution = parentMessage == null ? null : attributionFor(parentMessage);

  // Who started the thread and when: `created_by`/`created_at` are the
  // thread's own record of its start, so a parent message missing from the
  // store (the pane can open before the channel page holds it) still names a
  // starter and a date. The starter is NEVER inferred from the seed message:
  // whoever wrote the message a thread hangs off is not who started the thread
  // (a bot starting one on your message read "<you> started this thread",
  // 2026-10-02). An unresolvable starter reads "Someone", not a wrong name.
  const starterName = actorName(mentionRoster, thread?.created_by, currentUser);
  const startedAt = isDraft
    ? null // a draft has not started yet — the seed's date is not the thread's
    : thread?.created_at ?? parentMessage?.created_at ?? null;
  const starterLine = startedAt === null ? null : formatStartLine(startedAt);

  // Drag-drop uploads target the whole panel, same as the channel pane.
  const composeRef = useRef<ComposerHandle | null>(null);
  const { isDragging, dropHandlers } = useFileDropZone((files) =>
    composeRef.current?.startUploads(files),
  );
  // Failed thread replies' row actions — Edit lands in the thread composer.
  const sendRowActions = useSendRowActions(store, channelId, composeRef, startReply);

  // The starter line + origin: above the first reply (the list's history
  // header), or the whole transcript of a draft.
  const historyHeader = useMemo(
    () => (
      <div data-testid="thread-history-header">
        {isDraft ? (
          /* The line the thread will carry once it exists, held as space:
             it appears in place when the first reply creates the thread,
             without pushing the origin down. */
          <p
            className="thread-started invisible"
            aria-hidden
            data-testid="thread-started-placeholder"
          >
            <span>
              <ThreadIcon size={14} />
            </span>
            <span>&nbsp;</span>
          </p>
        ) : starterLine !== null ? (
          <p className="thread-started" data-testid="thread-started-line">
            <span aria-hidden>
              <ThreadIcon size={14} />
            </span>
            <span>
              <strong>{starterName}</strong> started this thread
            </span>
            <span className="thread-started-time">· {starterLine}</span>
          </p>
        ) : null}
        {parentMessage != null && parentAttribution != null ? (
          <div data-testid="thread-parent-pin">
            <MessageItem
              message={parentMessage}
              authorName={parentAttribution.authorName}
              authorTag={parentAttribution.authorTag}
              authorAvatarUrl={parentAttribution.authorAvatarUrl}
              authorKind={parentAttribution.authorKind}
              authorParentName={parentAttribution.authorParentName}
              resolveMention={resolveMention}
              currentUserId={currentUserId}
              store={store}
            />
          </div>
        ) : null}
      </div>
    ),
    [
      isDraft,
      starterLine,
      starterName,
      parentMessage,
      parentAttribution?.authorName,
      parentAttribution?.authorTag,
      parentAttribution?.authorAvatarUrl,
      parentAttribution?.authorKind,
      parentAttribution?.authorParentName,
      resolveMention,
      currentUserId,
      store,
    ],
  );

  return (
    <aside
      className="relative flex h-full w-full flex-col bg-surface-emphasized"
      aria-label={`Thread: ${title}`}
      data-testid="thread-side-panel"
      data-thread-id={threadId}
      {...dropHandlers}
    >
      {isDragging ? <DropOverlay testId="thread-drop-overlay" /> : null}
      {/* Header: ~58px row (corpus §3b) — thread icon, title, notify bell,
          ellipsis, close. 40×40 hit areas, focus-visible rings. No divider
          under it: Discord's thread header shares the pane's surface and the
          body scrolls beneath, which is what makes the pane read as one
          integrated surface rather than a boxed-off panel. */}
      <div
        className="flex h-[58px] shrink-0 items-center gap-1 px-3"
        data-testid="thread-header"
      >
        <span aria-hidden className="mr-1 text-lg" data-testid="thread-icon">
          <ThreadIcon size={18} />
        </span>
        <h2
          className="min-w-0 flex-1 truncate text-base font-semibold text-text-primary"
          data-testid="thread-title"
        >
          {title}
        </h2>
        {/* Bell + ⋯ exist only once the thread does: a draft has no
            membership to follow and nothing to mark unread or leave, so
            advertising those controls would promise actions that cannot
            exist yet. They appear the moment the first reply lands. */}
        {isDraft ? null : (
          <>
            {/* Notification controls (2026-09-27): the bell is the thread's
                LEVEL now — the same three-state control as the channel
                header, defaulting to the channel (inherited look + "Use
                channel default"). Following moved into ⋯ below: follow is
                MEMBERSHIP (My Threads, the Home badge tiers), a level is how
                loudly — two questions the old bell answered as one. */}
            <NotificationLevelControl
              target={threadTarget(threadId as string, channelId, threadWorkspaceId)}
              className={
                'flex h-10 w-10 items-center justify-center rounded-md text-base text-text-muted ' +
                'transition-colors duration-[var(--duration-control)] hover:bg-surface-hover ' +
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]'
              }
              iconSize={18}
              testIdPrefix="thread-notifications"
              store={store}
            />
            <DropdownMenu open={optionsOpen} onOpenChange={setOptionsOpen}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="flex h-10 w-10 items-center justify-center rounded-md text-base text-text-muted transition-colors duration-[var(--duration-control)] hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
                  aria-label="Thread options"
                  data-testid="thread-ellipsis"
                >
                  ⋯
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                className="channel-context-menu"
                align="end"
                sideOffset={6}
                aria-label="Thread options"
                data-testid="thread-options-menu"
              >
                {/* Follow is membership (My Threads + the Home badge
                    tiers); replying still auto-follows server-side. */}
                <DropdownMenuItem
                  className="workspace-menu-item channel-context-item"
                  data-testid="thread-option-follow"
                  data-following={notified || undefined}
                  onSelect={handleFollowToggle}
                >
                  {notified ? 'Unfollow Thread' : 'Follow Thread'}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="workspace-menu-item channel-context-item"
                  data-testid="thread-option-mark-unread"
                  onSelect={markUnread}
                >
                  Mark Unread
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="workspace-menu-item channel-context-item"
                  data-testid="thread-option-leave"
                  onSelect={leaveThread}
                >
                  Leave Thread
                </DropdownMenuItem>
                {isCreator ? (
                  <DropdownMenuItem
                    className="workspace-menu-item channel-context-item"
                    data-testid="thread-option-archive"
                    onSelect={toggleArchived}
                  >
                    {isArchived ? 'Unarchive Thread' : 'Archive Thread'}
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
        <button
          type="button"
          onClick={onClose}
          className={paneCloseButtonClass}
          aria-label="Close thread panel"
          data-testid="thread-close"
        >
          ✕
        </button>
      </div>

      {followError !== null ? (
        <p
          role="alert"
          className="border-b border-line px-3 py-1 text-xs text-danger"
          data-testid="thread-follow-error"
        >
          {followError}
        </p>
      ) : null}

      {/* An archived thread says so where it is OPEN, because archiving hides it
          from every listing without removing it (#109) — a member who followed a
          link, or who had the pane open when someone archived it, would
          otherwise have no way to know why it stopped appearing in the roster. */}
      {isArchived ? (
        <p
          className="border-b border-line px-3 py-1 text-xs text-text-muted"
          data-testid="thread-archived-notice"
        >
          🗄 Archived — this thread no longer appears in the thread list.
        </p>
      ) : null}

      {/* The thread's start line and origin, then the replies — ONE scroll
          region. The origin is not a pinned block: a long origin measured
          783px on a 900px viewport (2026-09-12), which starved the reply list
          and pushed the composer below the fold. Discord scrolls the whole
          thread for the same reason. In the list it is the HISTORY HEADER: it
          shows once the window reaches the thread's first reply (older
          replies page in above the fold until then). */}
      {listThreadId === null ? (
        /* A draft with no seed message to hang off (never in the app). */
        <div
          className="thread-body min-h-0 flex-1 overflow-y-auto scrollbar-thin"
          data-testid="thread-replies"
        >
          <div data-testid="thread-content">{historyHeader}</div>
        </div>
      ) : (
        <div className="timeline-region relative min-h-0 flex-1" data-testid="thread-replies">
          <SendRowActionsContext.Provider value={sendRowActions}>
          <MessageList
              key={`${listKey}:${retryKey}`}
              channelId={channelId}
              threadId={listThreadId}
              draft={isDraft}
              onReply={startReply}
              historyHeader={historyHeader}
              loadNewestOverride={loadNewest}
              store={store}
              currentUserId={currentUserId}
              canManageMessages={canManageMessages}
              viewOnly={viewOnly}
              onEdit={handleEdit}
              editingMessageId={editingMessageId}
              onSaveEdit={handleSaveEdit}
              onCancelEdit={handleCancelEdit}
              onDelete={handleDelete}
              onEditSubmit={handleEditSubmit}
              onDeleteConfirmed={handleDeleteConfirmed}
              onToggleReaction={toggleReaction}
              reactionError={reactionError}
              onRetryReaction={retryReaction}
              onDismissReaction={clearReactionError}
              onInitialLoad={setLoadState}
              unreadAtOpen={unreadAtOpen}
              focusMessageId={focusMessageId}
              clipboardWriter={clipboardWriter}
              permalinkMinter={permalinkMinter}
            />
          </SendRowActionsContext.Provider>
          {/* The states-first DoD, in the pane's shared fragments (U23): a
              skeleton while the first page is in flight, the shared error
              banner with Retry when it failed. Both only when there is
              nothing cached to show — and never for a draft, which has no
              page to load (its rows are all local). */}
          {isDraft ? null : loadState.status === 'loading' && replies.length === 0 ? (
            <div className="absolute inset-0 flex flex-col justify-end bg-surface-emphasized px-3">
              <PaneSkeleton label="Loading replies" testId="thread-loading" />
            </div>
          ) : loadState.status === 'error' && replies.length === 0 ? (
            <div className="absolute inset-x-0 top-0 px-3 pt-2">
              <PaneErrorBanner
                testId="thread-load-error"
                retryTestId="thread-load-retry"
                message="Could not load this thread's replies."
                onRetry={() => {
                  setLoadState({ status: 'loading' });
                  setRetryKey((k) => k + 1);
                }}
              />
            </div>
          ) : null}
        </div>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null);
        }}
        title="Delete Message"
        body="Are you sure you want to delete this message? This cannot be undone."
        confirmLabel="Delete"
        danger
        testId="thread-delete-message-dialog"
        onConfirm={() => {
          const id = deleteTarget;
          setDeleteTarget(null);
          if (id !== null) void removeMessage(channelId, id).catch(() => undefined);
        }}
      />

      {/* Compose — the same U21 composer, thread-scoped. In a draft this is
          the write that CREATES the thread: create-then-send happens in one
          gesture, so nothing exists until the user actually replies. */}
      <ThreadCompose
        ref={composeRef}
        threadId={threadId}
        channelId={channelId}
        parentMessageId={parentMessageId}
        draftName={draftName}
        onThreadCreated={handleThreadCreated}
        store={store}
        channelName={title}
        typing={typing}
        replyTo={replyTo}
        onCancelReply={cancelReply}
        onTogglePing={togglePing}
      />
    </aside>
  );
}

/** Stable empty reply list (a draft has none). */
const NO_REPLIES: Message[] = [];

/** "August 26, 2026 at 6:17 PM" — the thread's start date, with its clock time
 * (the time only carries new information on the day it started, but a thread
 * read years later reads better with it than without). */
function formatStartLine(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${formatLongDate(iso)} at ${formatClock(iso)}`;
}

/**
 * U3 — the thread SURFACE host: the responsive switch between the desktop
 * presentation and the mobile one. This is the same seam CallPanelSurface
 * owns for the call pane.
 *
 * Desktop (≥768px): the docked split — the thread dock beside the parent
 * channel, where Discord docks it (the members rail stands down while a
 * thread is open: AppShell's `membersHidden`), so the pane has the room its
 * reference layout gives it.
 *
 * Mobile (<768px): the dock would crush a 390px screen, so the panel
 * renders as a full-width sheet OVER the conversation — the call-sheet
 * visual idiom (Radix Dialog: portal, focus trap, Escape, focus return;
 * scrim tap dismisses). The panel's existing ✕ header is the
 * back-to-channel close; Escape routes through the same onClose seam.
 */
export function ThreadSurface(props: ThreadSidePanelProps) {
  const band = useShellBand();

  if (band === 'tablet') {
    // 768–1279px: the thread REPLACES the conversation rather than docking
    // beside it. The dock's fixed 380px would leave the parent pane 36px at
    // 768px and 102px at the owner's 834px reference width — the conversation
    // you were reading, crushed. Owner direction 2026-09-12: *"At best the
    // thread view should 'replace' just the main message area."*
    return (
      <div className="thread-pane" data-testid="thread-pane">
        <ThreadSidePanel {...props} />
      </div>
    );
  }

  if (band === 'desktop') {
    return (
      <div className="thread-dock" data-testid="thread-dock">
        <ThreadSidePanel {...props} />
      </div>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose?.();
      }}
    >
      <DialogContent
        showCloseButton={false}
        overlayClassName="call-sheet-overlay"
        overlayTestId="thread-sheet-overlay"
        className="thread-sheet"
        data-testid="thread-sheet"
        onEscapeKeyDown={(event) => {
          // Single close path (mirrors the call sheet).
          event.preventDefault();
          // Radix hears Escape on the document BEFORE the editor does: while
          // the composer's palette is open (`@`/`#`/`:`/`/`), Escape belongs
          // to the palette — it dismisses that, not the whole sheet.
          const target = event.target as Element | null;
          if (target?.closest?.('[role="combobox"][aria-expanded="true"]')) return;
          props.onClose?.();
        }}
      >
        <DialogTitle className="sr-only">Thread</DialogTitle>
        <ThreadSidePanel {...props} />
      </DialogContent>
    </Dialog>
  );
}
