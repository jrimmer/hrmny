/**
 * @cytale/web — MessagePane (U21 slice 3).
 *
 * Assembles the message surface for the active channel: the virtualized
 * MessageList (history + infinite scroll) and the MessageCompose (send).
 * Owns the states-first DoD for the pane:
 *
 *   loading            — newest page still fetching (progressbar)
 *   empty              — channel has no messages yet (named empty-state)
 *   error              — initial load failed (role=alert + retry)
 *   offline            — owned by the SHELL's one offline bar (AppShell), not
 *                        repeated here (two banners with the same copy stacked up)
 *   view-only          — unverified account (composer banner, disabled input)
 *   permission-denied  — no read access to this channel (alert replacing pane)
 *
 * Gateway MESSAGE_CREATE/UPDATE/DELETE are applied to the U17 store by the
 * auth session's `onAny` hook (session.ts), so the pane just reads the store
 * through MessageList — no separate dispatch wiring here.
 *
 * MessageList is ALWAYS mounted so it owns the newest-page fetch; the
 * loading/error/empty overlays sit on top of it and are driven by its
 * `onInitialLoad` report plus the store's message slice.
 */

import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

import type { StateStore } from '@cytale/state';
import {
  channelUnreadCount,
  clearChannelFloor,
  defaultStore,
  selectLiveCall,
  settleOpenChannelUnread, nicknamesForChannel } from '@cytale/state';

import { primaryButtonClass } from '../../app/ui/button.js';
import { PaneErrorBanner } from '../../app/ui/PaneStates.js';
import { ConfirmDialog } from '../../app/ui/ConfirmDialog.js';
// Plan 7.7: the shared glyph owns the phone handset — this file carried the
// fifth verbatim copy (same fill="currentColor" silhouette, same 16px default).
import { PhoneIcon } from '../../app/ui/icons.js';
import { resolveAuthor } from './authorIdentity.js';
import { dmParticipants } from './dmRoster.js';
import { MessageCompose, type ComposerHandle } from './MessageCompose.js';
import { threadNameFromMessage } from './threadName.js';
import { useFileDropZone } from './useFileDropZone.js';
import { DropOverlay } from './DropOverlay.js'
import type { Message } from '@cytale/domain';

import { useChannelCallHeader } from '../calls/useChannelCallHeader.js';
import { MEDIA_DISABLED_TITLE, useMediaEnabled } from '../calls/useMediaEnabled.js';
import { DmCallIndicator } from '../calls/dm/DmCallIndicator.js';
import { useCallCapabilities } from '../calls/CallPanel.js';
import { useDebouncedChannelAck, useUnreadActions } from '../presence/useUnread.js';
import { shallowEqual, useStoreSelector } from '../../app/useStoreSelector.js';
import { api } from '../auth/session.js';
import { useReplyTarget } from './useReplyTarget.js';
import { NotificationLevelControl } from '../notifications/NotificationLevelControl.js';
import { channelTarget } from '../notifications/notificationPrefs.js';
import { MessageList, type MessageListLoadState } from './MessageList.js';
import type { ClipboardWriter } from './clipboard.js';
import type { PermalinkMinter } from './messagePermalink.js';
import { useMessages, type UseMessages } from './useMessages.js';
import { SendRowActionsContext, useSendRowActions } from './SendStatus.js';
import { displayNameOf } from '@cytale/domain';

export interface MessagePaneProps {
  /** Active channel id; null renders the empty "no channel selected" state. */
  channelId: string | null;
  /** U17 store (injectable for tests; app uses the module default). */
  store?: StateStore;
  /** Override the messages hook (tests). */
  messages?: UseMessages;
  /** True when the current user holds MANAGE_MESSAGES in this channel. */
  canManageMessages?: boolean;
  /**
   * True when the viewer's resolved channel permissions include START_CALL
   * (resolved by the host via @cytale/domain's resolveChannelPermissions +
   * can) — gates the header's phone affordance, hidden when denied (AM17).
   */
  canStartCall?: boolean;
  /** Start-call intent from the header; defaults to the useCall seam. */
  onStartCall?: (opts: { ring: boolean }) => void;
  /** Join-call intent from the header (live state); defaults to useCall. */
  onJoinCall?: () => void;
  /**
   * Opens the channel's call log (U9's standalone surface). Defaults to a
   * telemetry no-op — the seam exists so the affordance is stable now.
   */
  onOpenCallLog?: () => void;
  /** True when the current user is unverified (view-only gate). */
  viewOnly?: boolean;
  /** Permission-denied detail; when set the pane is replaced by an alert. */
  permissionDenied?: string;
  /**
   * True when the active channel is a 1:1 DM — the header renders the DM
   * call indicator (calls plan U10) instead of the channel call actions.
   * Defaults to the store's channel record; hosts may assert it directly
   * for channels the store has not hydrated (tests, pre-nav surfaces).
   */
  isDm?: boolean;
  /** Active channel display name (header); falls back to the raw id. */
  channelName?: string;
  /** Active channel topic (header subtitle). */
  channelTopic?: string;
  /**
   * Extra control for the channel header's RIGHT cluster, after the call
   * affordances. The tablet band uses it for the members toggle: the members
   * list REPLACES this pane there (the shell has no fourth grid track below
   * 1280px), so the toggle has to ride the pane header — the only chrome that
   * band has. Undefined at phone (the topbar owns 👥) and at desktop (the
   * member rail is always visible, so there is nothing to toggle). Owner
   * direction 2026-09-12: the entry point is a three-person control at the
   * top right, not Discord's tap-the-channel-name.
   */
  headerActions?: ReactNode;
  /**
   * Start-thread intent (hover 🧵 on a message): the host owns the REST
   * call + store upsert + opening the thread dock. The pane collects the
   * thread name and hands over (channelId, parent messageId, name).
   */
  onStartThread?: (channelId: string, messageId: string, name: string) => void;
  /** Opens the thread dock from a seed message's indicator. */
  onOpenThread?: (threadId: string) => void;
  /**
   * A message a permalink (#114) must land on: the list scrolls to it, flashes
   * it, and resolves it over REST when it is not in the loaded window.
   */
  focusMessageId?: string | null;
  /**
   * The focus target, once the list resolved it — the host reads `thread_id`
   * to open the thread a reply lives in.
   */
  onFocusMessage?: (message: Message) => void;
  /** Tests inject the clipboard writer for Copy Link (#114). */
  clipboardWriter?: ClipboardWriter;
  /** Tests inject the Copy Link minter (#118); defaults to the session api. */
  permalinkMinter?: PermalinkMinter;
}

function MessagePaneImpl({
  channelId,
  store = defaultStore,
  messages,
  canManageMessages = false,
  // No default: undefined = "host didn't assert" → the server-resolved
  // capability decides (below); `false` stays an explicit host override.
  canStartCall,
  onStartCall,
  onJoinCall,
  onOpenCallLog,
  viewOnly: _viewOnly = false,
  permissionDenied,
  isDm,
  channelName,
  channelTopic,
  headerActions,
  onStartThread,
  onOpenThread,
  focusMessageId = null,
  onFocusMessage,
  clipboardWriter,
  permalinkMinter,
}: MessagePaneProps) {
  const defaultMessages = useMessages(store);
  const msgs = messages ?? defaultMessages;
  const currentUserId = msgs.currentUserId();
  // Components plan U4 (R7/KD2): the read-only gate applies to action-row
  // controls too — pre-disabled with an explanatory title down in
  // MessageComponents, never enabled-buttons-that-403.
  const viewOnly = _viewOnly;

  const [loadState, setLoadState] = useState<MessageListLoadState>({ status: 'loading' });
  // App-styled replacements for window.prompt/confirm (banned: unthemeable,
  // blocking, suppressed on some platforms). Editing is INLINE (the row
  // becomes the editor); delete keeps its confirm dialog.
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  // Inline reply (Discord semantics): shared with the thread panel.
  const { replyTo, startReply, cancelReply, togglePing } = useReplyTarget(store, channelId);
  // The header notification control's fallback chain (notification
  // controls): a workspace channel inherits its workspace, a DM (no
  // workspace) the account.
  const headerWorkspaceId = useStoreSelector(store, (s) =>
    channelId === null ? null : (s.channels[channelId]?.workspace_id ?? null),
  );
  // Start thread (hover 🧵): NO title prompt — the thread is named after the
  // seed message (threadNameFromMessage: mention-resolved, markdown-stripped,
  // truncated). The host owns the REST call + opening the dock. Focus is
  // dropped after the click so the hover toolbar isn't pinned by
  // group-focus-within.
  const startThreadFromMessage = useCallback(
    (messageId: string, content: string) => {
      if (channelId === null || onStartThread === undefined) return;
      (document.activeElement as HTMLElement | null)?.blur?.();
      // Names inside the seed content resolve the way the pane renders them:
      // a DM's own participants first (dmRoster.ts), the workspace roster after.
      const state = store?.getState();
      const dm = dmParticipants(state?.channels[channelId ?? '']);
      const nicknames = state ? nicknamesForChannel(state, channelId) : undefined;
      const name = threadNameFromMessage(content, (id) => {
        const m = dm[id] ?? state?.membersById[id];
        return m ? displayNameOf({ ...m, nickname: nicknames?.[id] ?? null }) : undefined;
      });
      onStartThread(channelId, messageId, name);
    },
    [channelId, onStartThread, store],
  );
  // MessageDelete while editing: the row unmounts, so retire the editing
  // state too (a stale id would be invisible but would reopen on re-render
  // if the same id ever reappeared in the slice).
  useEffect(() => {
    if (editingMessageId === null || channelId === null) return;
    const still = store
      ?.getState()
      .messagesByChannel[channelId]?.items.some((m) => m.id === editingMessageId);
    if (!still) setEditingMessageId(null);
  }, [editingMessageId, store, channelId, msgs]);


  // Hooks BEFORE the early returns below (Rules of Hooks): the pane returns
  // early for no-channel/permission-denied, and the read-ack effect must run
  // in every branch ordering.
  // Destructure the STABLE callback: the hook's returned container is a
  // fresh object every render, and depending on it re-acks → store update →
  // render → re-ack (infinite loop).
  // The ack ACTION only (lane D #17): `useUnread` subscribes to the unread
  // slices to serve badge reads this pane never makes, so every badge change
  // anywhere re-rendered the open conversation.
  const { markChannelRead } = useUnreadActions(store);
  const loadedMessages = channelId ? msgs.messages(channelId) : [];
  const newestId = loadedMessages[0]?.id;

  /**
   * #104 — the unread slice AS IT WAS when this channel was opened, taken
   * BEFORE the read-ack below clears it, and handed to MessageList (which
   * lands the open on it and draws the NEW rule there).
   *
   * The capture lives here because the ack is decided here: the list cannot
   * take it, because on the first render of a channel the store slice is
   * already cleared by the time its rows exist — the exact race that left
   * every channel landing at the newest. `useThreads.openThread` solves the
   * same problem the same way (capture in the same function that invalidates
   * it, one level above the surface that reads it).
   *
   * One capture per channel VISIT (`visitRef`): a second one after the ack
   * would only ever record the cleared slice, and re-deriving the rule while
   * the pane is open would move the divider under the reader (Discord's
   * retention is the opposite: it stays where the open put it). Switching
   * away and back is a new visit, so the claim — and the held slice itself —
   * reset with the channel: a capture from the last visit of THIS channel is
   * not this visit's boundary, and handing it over would land the open on a
   * stale rule.
   */
  const [unreadAtOpen, setUnreadAtOpen] = useState<{
    channelId: string;
    lastReadId: string | null;
    unreadCount: number;
    /** The exclusive floor at open (#54): a fired reminder, or a hand
     * mark-unread — that message and everything after it is unread. */
    unreadFloor: string | null;
  } | null>(null);
  const [capturedChannel, setCapturedChannel] = useState(channelId);
  if (capturedChannel !== channelId) {
    // Adjusted during render (React's "a prop changed" pattern), so the list
    // never mounts with the previous visit's capture in its props.
    setCapturedChannel(channelId);
    setUnreadAtOpen(null);
  }
  const visitRef = useRef<{ channelId: string | null; claimed: boolean }>({
    channelId: null,
    claimed: false,
  });
  useEffect(() => {
    if (channelId === null) return;
    if (visitRef.current.channelId !== channelId) {
      visitRef.current = { channelId, claimed: false };
    }
    if (visitRef.current.claimed) return;
    // Keyed on `newestId` as well as the channel: on a cold boot the read-state
    // hydration can land a tick after this pane's first render, and the ack
    // fires the moment rows exist — so the capture is claimed on the first
    // commit that has a slice, which is still one commit before the ack (this
    // effect is declared above it).
    const before = store.getState().unreadByChannel[channelId];
    // No entry at all for this channel: do not claim the visit yet — the
    // hydration may simply not have arrived. An entry with count 0 is a real
    // answer (nothing unread) and is captured as one.
    if (before === undefined) return;
    visitRef.current.claimed = true;
    setUnreadAtOpen({
      channelId,
      lastReadId: before.last_read_id ?? null,
      // Lane D #2: the shared badge rule (server snapshot + live accrual).
      unreadCount: channelUnreadCount(before),
      unreadFloor: before.unread_floor ?? null,
    });
  }, [channelId, store, newestId]);

  // Read acknowledgement (U23 wiring): an open pane IS a read view — ack on
  // channel open and again whenever a newer message lands while open, so
  // badges clear live (multi-device convergence rides the MessageAck
  // dispatch the server fans back). Lane D #20: the open acks at once, but
  // live traffic is TRAILING-DEBOUNCED and never acked while the tab is
  // hidden (a busy channel open in a background tab is not being read).
  // Placeholders (pending_<nonce>) are skipped inside the hook — acking a
  // non-snowflake throws in the gateway client's validation.
  useDebouncedChannelAck(channelId, newestId, markChannelRead);

  // An open channel with nothing unread in it shows no badge. The ack above
  // clears a badge by moving the watermark to a newer message; when every
  // unread message was deleted there is none to move to (the channel is empty
  // or its newest row is already read), so a count left over from live
  // accrual or a restored device snapshot is settled here instead, from the
  // loaded window the member is looking at.
  const loadReady = loadState.status === 'ready';
  useEffect(() => {
    if (channelId === null || !loadReady) return;
    settleOpenChannelUnread(store, channelId);
  }, [channelId, loadReady, newestId, store]);

  // The floor LIVE (#54): a reminder can fire while this channel is open. The
  // pane's forward acks own the watermark only, so they cannot erase it; the
  // list moves its divider to the floored message without a scroll jump.
  const liveUnreadFloor = useSyncExternalStore(
    store.subscribe,
    () => (channelId ? (store.getState().unreadByChannel[channelId]?.unread_floor ?? null) : null),
    () => null,
  );

  // Leaving a channel with a floor the member was SHOWN clears it (#54,
  // KTD9: evidence, not focus). "Shown" = the floored message was in the
  // loaded window, which is where the open landed. The server clears only on
  // that evidence (`unread_floor: null`), and its ReadStateUpdate converges
  // the member's other devices. A floor the pane never loaded stays set.
  useEffect(() => {
    if (channelId === null) return;
    const leaving = channelId;
    return () => {
      const s = store.getState();
      const floor = s.unreadByChannel[leaving]?.unread_floor ?? null;
      if (floor === null) return;
      const items = s.messagesByChannel[leaving]?.items ?? [];
      if (!items.some((m) => m.id === floor)) return;
      const newest = items.find((m) => /^\d{1,19}$/.test(m.id))?.id ?? floor;
      clearChannelFloor(store, leaving);
      void api.ackChannel(leaving, newest, { unreadFloor: null }).catch(() => undefined);
    };
  }, [channelId, store]);

  const handleInitialLoad = useCallback((state: MessageListLoadState) => {
    setLoadState(state);
  }, []);

  const retry = useCallback(() => {
    setLoadState({ status: 'loading' });
    setRetryKey((k) => k + 1);
  }, []);

  // Reactions (Discord model): chip/picker toggles run through the messages
  // hook's optimistic path; a failure surfaces inline on the failing row via
  // `reactionError` with Retry/Dismiss (mirrors the composer error pattern).
  //
  // Bound to the METHODS, not to `msgs` (#137, app-level finding 2): the hook
  // returns a fresh container literal every render, so `[msgs]` as a
  // dependency re-created all three of these on every render — and all three
  // are `MessageList` props, which put them straight into `itemContent`'s
  // dep list and re-ran the whole virtualized window. The methods themselves
  // are `useCallback`s over the store, so they hold still.
  const reactionError = msgs.reactionError();
  const toggleReactionOnMessage = msgs.toggleReaction;
  const clearReactionError = msgs.clearReactionError;
  const editMessage = msgs.edit;
  const removeMessage = msgs.remove;
  const toggleReaction = useCallback(
    (messageId: string, emoji: string) => {
      if (channelId === null) return; // no pane → no rows to toggle
      void toggleReactionOnMessage(channelId, messageId, emoji).catch(() => undefined);
    },
    [toggleReactionOnMessage, channelId],
  );
  const retryReaction = toggleReaction;
  const dismissReaction = useCallback(() => clearReactionError(), [clearReactionError]);

  // -------------------------------------------------------------------------
  // The row-action seams (#137, app-level finding 2)
  // -------------------------------------------------------------------------
  // Every one of these used to be an inline arrow in the JSX below, so each
  // render of this pane handed `MessageList` a new function. `itemContent`
  // lists them all as dependencies, so it was a new function too — and
  // Virtuoso re-ran EVERY row in the window, each one re-parsing its markdown
  // body, whenever anything at all re-rendered the pane (a gateway event in
  // another channel, a reply bar opening, a load-state flip). They are
  // `useCallback`s now, over the values they actually close on: the message
  // hook's stable methods, the channel id, the pane's own setters and the
  // start-thread intent. Bodies are byte-for-byte the ones they replaced.
  const handleEdit = useCallback((messageId: string) => {
    // Focus hygiene: the toolbar button keeps focus otherwise and
    // group-focus-within pins the hover toolbar open.
    (document.activeElement as HTMLElement | null)?.blur?.();
    setEditingMessageId(messageId);
  }, []);
  const handleSaveEdit = useCallback(
    async (messageId: string, content: string) => {
      // Optimistic at the hook layer (rollback on failure); the editor stays
      // open on rejection so its Retry works.
      if (channelId === null) return; // unreachable: the pane returns early
      await editMessage(channelId, messageId, content);
      setEditingMessageId(null);
    },
    [editMessage, channelId],
  );
  const handleCancelEdit = useCallback(() => setEditingMessageId(null), []);
  const handleDelete = useCallback((messageId: string) => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    setDeleteTarget(messageId);
  }, []);
  // U3 touch actions: the sheet's prompt-free twins drive the SAME effects
  // (msgs.edit / msgs.remove / the host's thread start) — desktop keeps the
  // prompt flows above byte-for-byte.
  const handleEditSubmit = useCallback(
    (messageId: string, content: string) => {
      if (channelId === null) return; // unreachable: the pane returns early
      void editMessage(channelId, messageId, content).catch(() => undefined);
    },
    [editMessage, channelId],
  );
  const handleDeleteConfirmed = useCallback(
    (messageId: string) => {
      (document.activeElement as HTMLElement | null)?.blur?.();
      if (channelId === null) return; // unreachable: the pane returns early
      void removeMessage(channelId, messageId).catch(() => undefined);
    },
    [removeMessage, channelId],
  );
  const handleStartThreadNamed = useCallback(
    (messageId: string, name: string) => {
      if (channelId === null) return; // unreachable: the pane returns early
      if (onStartThread === undefined) return;
      onStartThread(channelId, messageId, name);
    },
    [channelId, onStartThread],
  );

  // Calls plan U7 (U2 lift): the header phone affordance's derivation —
  // live-ness, ring emphasis, and the start/join intents — lives in the
  // shared useChannelCallHeader hook so the mobile topbar's join-voice
  // control reads the exact same seam (chrome, not a second header
  // implementation). The hook carries its own store subscription, keeping
  // the Start→Join flip reactive standalone; host overrides keep their
  // U7 seams (onStartCall/onJoinCall replace the engine intents).
  const {
    live: callLive,
    ringing: headerRinging,
    start: startCallFromHeader,
    join: joinCallFromHeader,
  } = useChannelCallHeader(store, channelId, { isDm, onStartCall, onJoinCall });
  // Ticket #124: the media master switch's declarative read (READY → store).
  // false hides the header's Start-call affordances behind an honest
  // visible-disabled state — the server refuses start/join/ICE regardless,
  // so this is cosmetics with an explanation, never the gate.
  const mediaEnabled = useMediaEnabled(store);
  // The Call log affordance moved to the right rail's tab (contextual per
  // channel); the header keeps the seam — when the host passes
  // onOpenCallLog the button renders, otherwise the rail owns the entry.

  // Drag-drop uploads: the WHOLE pane is the target (Discord parity) —
  // files land in the composer's staging via the imperative seam, same as
  // the picker. (Above the early returns: the empty/permission shells are
  // render paths of THIS component, so its hooks must run for them too.)
  const composeRef = useRef<ComposerHandle | null>(null);
  const { isDragging, dropHandlers } = useFileDropZone((files) =>
    composeRef.current?.startUploads(files),
  );
  // A failed send's row actions (SendStatus.tsx): Edit moves it back into
  // THIS composer, Retry/Delete hand the caret back to it.
  const sendRowActions = useSendRowActions(store, channelId, composeRef, startReply);

  // The header's phone affordance needs START_CALL, which only the server
  // can resolve (the store carries no role data) — the call endpoint's
  // server-resolved capability `start` (W1 finding: the prop was never
  // host-wired, so the button was invisible in the real shell until now).
  // Lives with the hooks ABOVE the early returns (Rules of Hooks): the pane
  // returns early for no-channel/permission-denied, which would skip it.
  const resolvedCaps = useCallCapabilities(channelId ?? '', {
    enabled: channelId !== null && !channelId.startsWith('dm-'),
  });

  // No channel selected — the pane's "empty" shell state.
  if (channelId === null) {
    return (
      <div
        className="flex h-full items-center justify-center"
        data-testid="message-pane"
        data-state="no-channel"
      >
        <p className="text-text-muted" data-testid="no-channel-selected">
          Select a channel to start chatting.
        </p>
      </div>
    );
  }

  // Permission denied replaces the whole pane (accessibility: alert).
  if (permissionDenied) {
    return (
      <div
        className="flex h-full items-center justify-center"
        data-testid="message-pane"
        data-permission-denied="true"
      >
        <div role="alert" data-testid="pane-permission-denied">
          {permissionDenied}
        </div>
      </div>
    );
  }

  const isEmpty = loadState.status === 'ready' && loadedMessages.length === 0;
  const headerName = channelName ?? channelId;
  // Calls plan U10: DM conversations render the DM call indicator (the same
  // pane IS the DM header surface — no separate DM header exists). Derived
  // from the store's channel record unless the host asserts it. (The ring
  // emphasis derivation lives in useChannelCallHeader now — same isDm
  // default, U11's non-DM exclusion preserved.)
  const dmConversation =
    isDm ?? (store.getState().channels[channelId]?.type === 'dm');

  return (
    <div
      className="relative flex h-full flex-col"
      data-testid="message-pane"
      data-state="ready"
      {...dropHandlers}
    >
      {isDragging ? <DropOverlay testId="pane-drop-overlay" className="rounded-lg" /> : null}

      {/* Channel header (corpus §2: ~48px band, border-b, name + topic).
          items-center so the band reads level with the sidebar's 48px
          server-header band. Right-aligned call affordances (calls plan U7):
          phone Start/Join (START_CALL-gated, AM17) + Call log (always).
          DM conversations (calls plan U10, R11) render the DmCallIndicator
          instead — participation IS the authorization, and DMs have no call
          log; the name band carries an @ sigil, Discord's DM convention. */}
      <header
        className="flex h-12 shrink-0 items-center gap-2 px-4"
        data-testid="channel-header"
        data-dm={dmConversation || undefined}
      >
        <h1
          className="truncate text-lg font-semibold text-text-primary"
          data-testid="channel-header-name"
        >
          {dmConversation ? (
            <span aria-hidden className="mr-0.5 text-text-muted">
              @
            </span>
          ) : (
            <span aria-hidden className="mr-0.5 text-text-muted">
              #
            </span>
          )}
          {headerName}
        </h1>
        {channelTopic && !dmConversation ? (
          <p
            className="hidden min-w-0 truncate border-l border-line pl-2 text-sm text-text-muted sm:block"
            data-testid="channel-header-topic"
          >
            {channelTopic}
          </p>
        ) : null}
        {dmConversation ? (
          <DmCallIndicator channelId={channelId} store={store} />
        ) : (
          <ChannelHeaderCallActions
            live={callLive}
            ringing={headerRinging}
            canStartCall={canStartCall === undefined ? resolvedCaps.start !== false : canStartCall}
            mediaDisabled={!mediaEnabled}
            onStart={startCallFromHeader}
            onJoin={joinCallFromHeader}
            onOpenLog={onOpenCallLog}
          />
        )}
        {/* Notification controls (2026-09-27): one button beside the call
            affordances that cycles this channel's (or DM's) level; right-
            click / long-press opens the full menu. */}
        <NotificationLevelControl
          target={channelTarget(channelId, headerWorkspaceId)}
          className={headerActionClass}
          testIdPrefix="header-notifications"
          store={store}
        />
        {/* Rightmost: host-supplied header controls (tablet: the members
            toggle). Owner direction — a three-person control at the top
            right, in the position the call affordances don't already own. */}
        {headerActions}
      </header>

      {/* `timeline-region`: the jump-to-latest button reads the composer
          that follows this box (shell.css .jump-latest). */}
      <div className="timeline-region relative min-h-0 flex-1">
        <SendRowActionsContext.Provider value={sendRowActions}>
        <MessageList
            key={`${channelId}:${retryKey}`}
            channelId={channelId}
            store={store}
            currentUserId={currentUserId}
            canManageMessages={canManageMessages}
            viewOnly={viewOnly}
            onReply={startReply}
            onStartThread={startThreadFromMessage}
            onOpenThread={onOpenThread}
            unreadAtOpen={unreadAtOpen}
            liveUnreadFloor={liveUnreadFloor}
            focusMessageId={focusMessageId}
            onFocusMessage={onFocusMessage}
            clipboardWriter={clipboardWriter}
            permalinkMinter={permalinkMinter}
            onEdit={handleEdit}
            editingMessageId={editingMessageId}
            onSaveEdit={handleSaveEdit}
            onCancelEdit={handleCancelEdit}
            onDelete={handleDelete}
            // U3 touch actions: the sheet's prompt-free twins drive the SAME
            // effects (msgs.edit / msgs.remove / the host's thread start) —
            // desktop keeps the prompt flows above byte-for-byte.
            onEditSubmit={handleEditSubmit}
            onDeleteConfirmed={handleDeleteConfirmed}
            onStartThreadNamed={handleStartThreadNamed}
            onInitialLoad={handleInitialLoad}
            onToggleReaction={toggleReaction}
            reactionError={reactionError}
            onRetryReaction={retryReaction}
            onDismissReaction={dismissReaction}
          />
        </SendRowActionsContext.Provider>

        {loadState.status === 'loading' ? (
          <div
            role="progressbar"
            aria-busy="true"
            aria-label="Loading messages"
            /* Opaque and BOTTOM-aligned (#13): a conversation opens at its
               newest message, so the placeholder rows sit where the real rows
               will land — on the composer — instead of at the top of a
               transparent overlay the (unmounted) list showed through. */
            className="absolute inset-0 flex flex-col justify-end overflow-hidden bg-surface-emphasized pb-2"
            data-testid="pane-loading"
          >
            {/* Content-shaped placeholder, not a flat slab: the pane used to
                paint its whole surface with "Loading messages…" and the
                conversation appeared to vanish (user report 2026-09-11). Each
                row has a message row's geometry — 40px avatar, 16px gutter
                (px-4), 12px gap, an author line then a body line, 6px row
                padding — so nothing jumps when the real rows replace it. */}
            <span className="sr-only">Loading messages…</span>
            {[0.35, 0.6, 0.45, 0.7, 0.5].map((w, i) => (
              <div key={i} aria-hidden="true" className="mt-0.5 flex items-start gap-3 px-4 py-[6px]">
                <div className="mt-0.5 h-10 w-10 shrink-0 animate-pulse rounded-full bg-surface-hover motion-reduce:animate-none" />
                <div className="min-w-0 flex-1 pt-[3px]">
                  <div className="h-3.5 w-28 animate-pulse rounded bg-surface-hover motion-reduce:animate-none" />
                  <div
                    className="mt-[9px] h-3.5 animate-pulse rounded bg-surface-hover motion-reduce:animate-none"
                    style={{ width: `${Math.round(w * 100)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        ) : loadState.status === 'error' ? (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-surface-emphasized px-6"
            data-testid="pane-error"
          >
            {/* The shared banner + Retry (app/ui/PaneStates) — one error
                treatment across every pane, not a primary button here and a
                secondary one in the threads list. */}
            <PaneErrorBanner
              testId="pane-error-banner"
              retryTestId="pane-retry"
              message={loadState.error}
              onRetry={retry}
            />
          </div>
        ) : isEmpty ? (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface-emphasized px-6 text-center"
            data-testid="pane-empty"
          >
            <span aria-hidden className="text-4xl opacity-40">
              💬
            </span>
            <h2 className="text-lg font-semibold text-text-primary">
              This is the beginning of #{headerName}
            </h2>
            <p className="text-sm text-text-muted">
              No messages yet — say hello to start the conversation.
            </p>
          </div>
        ) : null}
      </div>

      {/* Calls plan U9 (R5): the live-call marker row. PLACEMENT DECISION —
          pinned at the bottom of the timeline (above the composer), not
          interpolated at the call's started_at: the channel timeline is a
          virtualized list over Message[] (interpolation would fork the row
          contract), and while a call is live its started_at is frequently
          OLDER than the loaded newest page (call-log messages never land in
          the channel), so an interpolated marker would often sit outside
          the window and be invisible. Bottom-pinned is always visible and
          stands exactly where the excluded chatter would appear — which is
          R5's reading of the marker ("a call live marker instead of the
          chatter"). */}
      {callLive ? (
        <TimelineCallMarker
          channelId={channelId}
          store={store}
          onJoin={joinCallFromHeader}
          mediaDisabled={!mediaEnabled}
        />
      ) : null}

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null);
        }}
        title="Delete Message"
        body="Are you sure you want to delete this message? This cannot be undone."
        confirmLabel="Delete"
        danger
        testId="delete-message-dialog"
        onConfirm={() => {
          const id = deleteTarget;
          setDeleteTarget(null);
          if (id !== null) void msgs.remove(channelId, id).catch(() => undefined);
        }}
      />

      <MessageCompose
        ref={composeRef}
        channelId={channelId}
        messages={msgs}
        channelName={headerName}
        isDm={dmConversation}
        replyTo={replyTo}
        onCancelReply={cancelReply}
        onTogglePing={togglePing}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Calls plan U9 — the timeline's live-call marker row (R5, system-row style)
// ---------------------------------------------------------------------------

/**
 * "Call — started by <user> · N in call · Join" while a call is live in
 * the channel. Data is the store's LiveCall slice (CALL_START/CALL_SYNC/
 * CALL_UPDATE hydrated); the roster count is live. started_by unknown to
 * the roster projection (or the slice — a SYNC-only call carries no
 * started_by) degrades to "someone".
 */
function TimelineCallMarker({
  channelId,
  store,
  onJoin,
  mediaDisabled = false,
}: {
  channelId: string;
  store: StateStore;
  onJoin: () => void;
  /** Ticket #124: media off → joining is refused; render the honest disabled state. */
  mediaDisabled?: boolean;
}) {
  // Identity-stable subscribe/getSnapshot (same churn rationale as
  // useChannelCallHeader): inline closures would resubscribe per store write.
  // Lane D #17: the call and its starter's roster row only — this was a
  // WHOLE-STORE snapshot, so every gateway event re-rendered the marker.
  // The starter is named by the shared author resolver (authorIdentity.ts);
  // the selector returns the NAME, so only a change to it re-renders.
  const { call, starterName } = useStoreSelector(
    store,
    (s) => {
      const live = selectLiveCall(s, channelId);
      const starter =
        live?.started_by != null
          ? resolveAuthor(s.membersById, live.started_by, {
              self: s.currentUser,
              nicknames: nicknamesForChannel(s, channelId),
            })
          : null;
      return {
        call: live,
        starterName: starter?.known ? starter.name : 'someone',
      };
    },
    shallowEqual,
  );
  if (call === undefined) return null; // CALL_END raced the parent's render

  const count = Object.keys(call.participants).length;

  return (
    <div
      className="flex shrink-0 items-center gap-2 border-t border-line bg-surface-hover px-4 py-2 text-sm"
      data-testid="timeline-call-marker"
      data-call-id={call.call_id}
    >
      <span aria-hidden className="text-accent">
        <PhoneIcon />
      </span>
      <p className="min-w-0 flex-1 truncate text-text-muted">
        <span className="font-medium text-text-primary">Call</span> — started by{' '}
        {starterName} · {count} {count === 1 ? 'person' : 'people'} in call
      </p>
      {mediaDisabled ? (
        // Media disabled on the server: the call runs out naturally but NEW
        // joins refuse — the affordance stays visible-disabled with the why
        // (states-first), never silently missing.
        <button
          type="button"
          className={primaryButtonClass + ' shrink-0 opacity-50'}
          aria-label={MEDIA_DISABLED_TITLE}
          aria-disabled="true"
          title={MEDIA_DISABLED_TITLE}
          data-testid="marker-join-call-disabled"
          disabled
        >
          Join
        </button>
      ) : (
        <button
          type="button"
          className={primaryButtonClass + ' shrink-0'}
          aria-label="Join call"
          data-testid="marker-join-call"
          onClick={onJoin}
        >
          Join
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Calls plan U7 — header call affordances (AM17/AM18)
// ---------------------------------------------------------------------------

const headerActionClass =
  'flex min-h-10 min-w-10 items-center justify-center gap-1.5 rounded-md px-2.5 ' +
  'text-sm font-medium text-text-muted transition-colors duration-[var(--duration-control)] ' +
  'hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]';

interface ChannelHeaderCallActionsProps {
  /** True while a call is live in this channel (button reads "Join"). */
  live: boolean;
  /**
   * True while the channel's call is ringing this client (U11): the phone
   * affordance carries the transient accent emphasis — the ring's visual
   * equivalent in the header.
   */
  ringing?: boolean;
  /** START_CALL-gated (hidden when denied, AM17). */
  canStartCall: boolean;
  /**
   * Ticket #124: the server's media master switch is OFF — start/join refuse
   * server-side. The affordances render the honest visible-disabled state
   * (title explains) instead of silently missing: hidden-because-disabled
   * must be distinguishable from not-built.
   */
  mediaDisabled?: boolean;
  onStart(opts: { ring: boolean }): void;
  onJoin(): void;
  /** Absent → the header hides the Call log action (the rail owns it). */
  onOpenLog?: () => void;
}

/**
 * The channel header's call affordances:
 *
 *   idle  + START_CALL → "Start call" (silent) + a caret menu offering
 *                        "Start and ring" (AM17's secondary action)
 *   live  + START_CALL → "Join" (the same affordance flipped, AM17)
 *   otherwise          → phone affordance hidden (permission-denied state)
 *   media off (#124)   → phone affordance VISIBLE-DISABLED with the honest
 *                        "calls are off on this server" title (join/start
 *                        refuse server-side; live calls run out naturally)
 *   "Call log"         → always available (idle-state entry to U9's log;
 *                        the log is REST history, not the media plane)
 *
 * The caret menu follows the WorkspaceMenu keyboard contract: ArrowUp/Down
 * move, Enter/Space activate, Escape closes and restores focus to the
 * trigger, outside click closes.
 */
function ChannelHeaderCallActions({
  live,
  ringing = false,
  canStartCall,
  mediaDisabled = false,
  onStart,
  onJoin,
  onOpenLog,
}: ChannelHeaderCallActionsProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const items = [
    {
      key: 'silent',
      label: 'Start call',
      testId: 'start-call-menu-silent',
      ring: false,
    },
    {
      key: 'ring',
      label: 'Start and ring',
      testId: 'start-call-menu-ring',
      ring: true,
    },
  ];

  useEffect(() => {
    if (!menuOpen) return;

    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [menuOpen]);

  const closeMenu = () => {
    setMenuOpen(false);
    triggerRef.current?.focus();
  };

  const choose = (item: (typeof items)[number]) => {
    closeMenu();
    onStart({ ring: item.ring });
  };

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusIndex((i) => (i + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusIndex((i) => (i - 1 + items.length) % items.length);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const item = items[focusIndex];
      if (item) choose(item);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu();
    } else if (e.key === 'Tab') {
      setMenuOpen(false);
    }
  };

  return (
    <div
      className="ml-auto flex shrink-0 items-center gap-1"
      data-testid="channel-header-actions"
    >
      {mediaDisabled ? (
        // Ticket #124: the honest disabled state — visible, inert, explained.
        // The instance-level master switch sits ABOVE the START_CALL bit and
        // the live/join flip, so it wins over every other arm here.
        <button
          type="button"
          className={headerActionClass + ' cursor-not-allowed opacity-50'}
          aria-label={MEDIA_DISABLED_TITLE}
          aria-disabled="true"
          title={MEDIA_DISABLED_TITLE}
          data-testid="header-call-disabled"
          disabled
        >
          <PhoneIcon />
          <span className="hidden sm:inline">Calls off</span>
        </button>
      ) : live ? (
        <button
          type="button"
          className={headerActionClass + (ringing ? ' ring-emph' : '')}
          aria-label={ringing ? 'Join call — ringing' : 'Join call'}
          title={ringing ? 'Join call — ringing' : 'Join call'}
          data-testid="header-join-call"
          data-ringing={ringing || undefined}
          onClick={onJoin}
        >
          <PhoneIcon />
          <span className="hidden sm:inline">Join</span>
        </button>
      ) : canStartCall ? (
        <>
          <button
            type="button"
            className={headerActionClass + (ringing ? ' ring-emph' : '')}
            aria-label="Start call"
            title="Start call"
            data-testid="header-start-call"
            data-ringing={ringing || undefined}
            onClick={() => onStart({ ring: false })}
          >
            <PhoneIcon />
            <span className="hidden sm:inline">Start call</span>
          </button>
          <div className="call-menu" ref={rootRef} onKeyDown={menuOpen ? onMenuKeyDown : undefined}>
            <button
              type="button"
              ref={triggerRef}
              className={headerActionClass}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="Start call options"
              title="Start call options"
              data-testid="header-start-call-options"
              onClick={() => {
                setFocusIndex(0);
                setMenuOpen((o) => !o);
              }}
            >
              <span aria-hidden="true" className="text-xs">
                ⌄
              </span>
            </button>

            {menuOpen ? (
              <div
                className="call-menu-popover"
                role="menu"
                aria-label="Start call options"
                data-testid="start-call-menu"
              >
                {items.map((item, i) => (
                  <button
                    key={item.key}
                    type="button"
                    role="menuitem"
                    className="call-menu-item"
                    data-testid={item.testId}
                    tabIndex={-1}
                    ref={i === focusIndex ? (el) => el?.focus() : undefined}
                    onClick={() => choose(item)}
                  >
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      {onOpenLog ? (
        <button
          type="button"
          className={headerActionClass}
          aria-label="Call log"
          title="Call log"
          data-testid="header-call-log"
          onClick={onOpenLog}
        >
          Call log
        </button>
      ) : null}
    </div>
  );
}

/**
 * Memoized (lane D #17): the pane is the heaviest subtree under the shell,
 * and the shell re-renders for roster/navigation state the pane does not
 * read. With stable props from the host it now re-renders only for its own.
 */
export const MessagePane = memo(MessagePaneImpl);
