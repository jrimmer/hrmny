/**
 * @cytale/web — long-press message actions bottom sheet (U3).
 *
 * The touch counterpart of the hover toolbar (audit M1: tap on a message
 * yielded nothing — every affordance was hover-only). MessageList hosts one
 * sheet ABOVE the react-virtuoso windowing boundary, keyed by the
 * long-pressed message id; MessageItem only reports the gesture, so a
 * rewindow that unmounts the row can never close an open sheet.
 *
 * Composition mirrors the CallPanel mobile sheet exactly: a Radix Dialog
 * (portal, focus trap, Escape, focus return — the drawer pattern) anchored
 * bottom, full-width, over a scrim. The reduce-motion contract needs
 * nothing here — the sheet has no entrance animation (same as .call-sheet),
 * and tokens.css collapses any durations we inherit.
 *
 * System prompts are banned on this surface (iOS suppresses window.prompt
 * in standalone PWA mode, and they are hostile touch UX anyway):
 *   * Edit      → in-sheet input prefilled with the message content,
 *   * Start     → in-sheet thread-name field,
 *   * Delete    → in-sheet destructive confirm (never window.confirm).
 * The desktop hover toolbar keeps its prompt flows byte-for-byte; the sheet
 * drives the same underlying effects through the prompt-free callbacks the
 * host wires (onEditSubmit / onStartThreadNamed / onDeleteConfirmed).
 *
 * Add Reaction embeds the existing ReactionPicker (favorites grid + ＋
 * drill-in), opened pre-opened — the same seam the hover picker drives.
 * Copy Text is the sanctioned text extraction on touch (selection is
 * suppressed on message rows for the gesture): it rides the clipboard API
 * with an aria-live "Copied" beat, then the sheet dismisses.
 */

import { useEffect, useRef, useState } from 'react';

import { defaultStore, type StateStore, nicknamesForChannel } from '@cytale/state';

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '../../components/shadcn/dialog.js';

import { useOnlineStatus } from '../../app/pwa/useOnlineStatus.js';
import { ReactionPicker } from './ReactionPicker.js';
import { InlineMessageEditor } from './InlineMessageEditor.js';
import { mentionTagFor } from './mentionCandidates.js';
import { threadNameFromMessage } from './threadName.js';
import { dmParticipants } from './dmRoster.js';
import {
  actionIcon,
  LINK_PATH,
  PENCIL_PATH,
  TRASH_PATH,
  REPLY_PATH,
  THREAD_PATH,
  SMILEY_PATH,
} from './MessageItem.js';

// Module-scope: the sheet's icons are the hover toolbar's shared set
// (MessageItem) plus Copy, the one affordance the toolbar doesn't carry.
const COPY =
  'M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z';
import type { MessageWithBots } from './types.js';
import { REMIND_PATH } from './MarkPicker.js';
import { displayNameOf } from '@cytale/domain';

export interface MessageActionsSheetProps {
  /** The long-pressed message. */
  message: MessageWithBots;
  /** Host-controlled open state (MessageList owns it, keyed by message id). */
  open: boolean;
  /** Close requests (action, scrim tap, Escape) flow through here. */
  onOpenChange: (open: boolean) => void;
  /** Current user's snowflake id (author-scoped gating, same as the toolbar). */
  currentUserId: string | null;
  /** True when the viewer holds MANAGE_MESSAGES (delete gate, like the toolbar). */
  canManageMessages?: boolean;
  /** Same seam as the hover picker's react affordance (chip toggle / pick). */
  onToggleReaction?: (messageId: string, emoji: string) => void;
  /** Legacy react affordance (no picker) — mirrors the toolbar's fallback. */
  onReact?: (messageId: string) => void;
  /** The hover toolbar's reply handler (same callback, same semantics). */
  onReply?: (message: MessageWithBots, opts?: { suppressPing?: boolean }) => void;
  /** In-app edit commit (the prompt-free twin of the toolbar's onEdit). */
  onEditSubmit?: (messageId: string, content: string) => void;
  /** Delete after the in-sheet confirm (the prompt-free twin of onDelete). */
  onDeleteConfirmed?: (messageId: string) => void;
  /** Start thread with the message-DERIVED name (no title prompt anywhere):
   *  the sheet twin of the hover toolbar's onStartThread. */
  onStartThreadNamed?: (messageId: string, name: string) => void;
  /**
   * The hover toolbar's Copy Link seam (#114), verbatim — the touch surface
   * must offer the same permalink action the desktop pill does. The host
   * MINTS the link since #118 (one `POST /permalinks`) and writes the
   * clipboard; the sheet only reports the click.
   */
  onCopyLink?: (message: MessageWithBots) => void;
  /** #54 "Remind me…": the host opens the reminder dialog for this message. */
  onRemind?: (message: MessageWithBots) => void;
  /** The store the edit view's palettes and pills read (defaults to the app's). */
  store?: StateStore;
}

type SheetView = 'actions' | 'react' | 'edit' | 'delete';

/** Beat the "Copied" feedback stays up before the sheet dismisses. */
const COPY_DISMISS_MS = 900;

const sheetActionClass =
  'flex w-full items-center gap-3 min-h-[44px] px-3 rounded-md text-left ' +
  'text-[15px] text-text-primary transition-colors ' +
  'duration-[var(--duration-control)] hover:bg-surface-hover ' +
  'focus-visible:outline-none focus-visible:bg-surface-hover ' +
  'focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]';

const sheetActionIcon =
  'flex h-10 w-10 shrink-0 items-center justify-center text-text-muted [&>svg]:h-5 [&>svg]:w-5';

export function MessageActionsSheet({
  message,
  open,
  onOpenChange,
  currentUserId,
  canManageMessages = false,
  onToggleReaction,
  onReact,
  onReply,
  onEditSubmit,
  onDeleteConfirmed,
  onStartThreadNamed,
  onCopyLink,
  onRemind,
  store = defaultStore,
}: MessageActionsSheetProps) {
  const online = useOnlineStatus();
  const [view, setView] = useState<SheetView>('actions');
/**
   * Which copy affordance is mid-beat. A union rather than a boolean so the
   * "Copied!" label lands on the row that was actually pressed — the sheet has
   * two of them since #114.
   */
  const [copied, setCopied] = useState<'text' | 'link' | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  // Focus-return contract (the touch twin of "focus returns to the toolbar
  // button"): when the sheet UNMOUNTS, focus goes back to the message row.
  // It must happen in unmount cleanup — Radix's focus trap is torn down in
  // the same commit (children first), so a synchronous focus during close
  // would be pulled back into the sheet before it disappears. Message ids
  // are snowflakes / pending_<nonce> — attribute-selector-safe.
  const messageIdRef = useRef(message.id);
  messageIdRef.current = message.id;
  useEffect(() => {
    return () => {
      document
        .querySelector<HTMLElement>(`[data-message-id="${messageIdRef.current}"]`)
        ?.focus?.();
    };
  }, []);

  const isAuthor = currentUserId !== null && message.author_id === currentUserId;
  const canDelete = isAuthor || canManageMessages;
  const canEdit = isAuthor;
  // Content is optional-safe (same contract as MessageItem's rendering).
  const content = message.content ?? '';

  // Reset to the action list whenever the sheet opens for a (different)
  // message — a stale edit/thread view must never survive a new long-press.
  useEffect(() => {
    if (open) {
      setView('actions');
      setCopied(null);
    }
  }, [open, message.id]);

  // Never leak the copy-dismiss timer.
  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    },
    [],
  );

  const close = () => onOpenChange(false);

  // A pending copy-dismiss must not close the sheet under a follow-up
  // action: every sub-view switch cancels it.
  const cancelCopyDismiss = () => {
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    }
  };

  const handleReactionPick = (emoji: string) => {
    if (onToggleReaction) {
      onToggleReaction(message.id, emoji);
    } else {
      onReact?.(message.id);
    }
    close();
  };

  const handleLegacyReact = () => {
    // No picker seam (legacy host): mirror the toolbar's plain react button.
    onReact?.(message.id);
    close();
  };

  const handleThreadStart = () => {
    // No prompt: the thread is named after the seed message (the server
    // requires a non-empty name; the deriver guarantees one).
    // Names resolve the way MessagePane's toolbar path resolves them (a DM's
    // participants first, the workspace roster after): without a resolver
    // every mention was DROPPED from the name on touch while the desktop
    // toolbar kept it.
    const state = store.getState();
    const dm = dmParticipants(state.channels[message.channel_id]);
    const nicknames = nicknamesForChannel(state, message.channel_id);
    const name = threadNameFromMessage(content, (id) => {
      const m = dm[id] ?? state.membersById[id];
      return m ? displayNameOf({ ...m, nickname: nicknames?.[id] ?? null }) : undefined;
    });
    onStartThreadNamed?.(message.id, name);
    close();
  };

  const handleCopy = () => {
    // Clipboard API — jsdom and hardened browsers may not expose it; the
    // feedback still shows (the write is best-effort, not a gate).
    void navigator.clipboard?.writeText?.(content).catch(() => undefined);
    setCopied('text');
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => {
      copyTimerRef.current = null;
      close();
    }, COPY_DISMISS_MS);
  };

  /**
   * #114 Copy link: the host builds and writes the URL (it owns the origin and
   * the channel's workspace), this shows the same beat Copy text uses. The
   * sheet lingers for that beat on purpose — the confirmation is a VISIBLE
   * one, and the host's status pill renders under this sheet's layer, so a
   * label swap here is the only confirmation the member can see.
   */
  const handleCopyLink = () => {
    onCopyLink?.(message);
    setCopied('link');
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => {
      copyTimerRef.current = null;
      close();
    }, COPY_DISMISS_MS);
  };

  const reactions = Array.isArray(message.reactions) ? message.reactions : [];
  const appliedEmojis = reactions.map((r) => r.emoji);

  if (!open) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        overlayClassName="call-sheet-overlay"
        overlayTestId="message-actions-overlay"
        className="call-sheet message-actions-sheet"
        aria-label="Message actions"
        data-testid="message-actions-sheet"
        data-message-id={message.id}
        onEscapeKeyDown={(event) => {
          // Single close path (mirrors the call sheet): Radix's default
          // dismiss is prevented; our onOpenChange does the closing.
          event.preventDefault();
          close();
        }}
      >
          <DialogTitle className="sr-only">Message actions</DialogTitle>

          {view === 'actions' ? (
            <>
              <div role="menu" aria-label="Message actions" data-testid="sheet-actions">
              {(onToggleReaction || onReact) && (
                <button
                  type="button"
                  role="menuitem"
                  className={sheetActionClass}
                  data-testid="sheet-action-react"
                  onClick={() => (onToggleReaction ? (cancelCopyDismiss(), setView('react')) : handleLegacyReact())}
                >
                  <span aria-hidden className={sheetActionIcon}>
                    {actionIcon(SMILEY_PATH)}
                  </span>
                  Add reaction
                </button>
              )}
              {onReply && (
                <button
                  type="button"
                  role="menuitem"
                  className={sheetActionClass}
                  data-testid="sheet-action-reply"
                  onClick={() => {
                    onReply(message);
                    close();
                  }}
                >
                  <span aria-hidden className={sheetActionIcon}>
                    {actionIcon(REPLY_PATH)}
                  </span>
                  Reply
                </button>
              )}
              {canEdit && onEditSubmit && (
                <button
                  type="button"
                  role="menuitem"
                  className={sheetActionClass}
                  data-testid="sheet-action-edit"
                  onClick={() => { cancelCopyDismiss(); setView('edit'); }}
                >
                  <span aria-hidden className={sheetActionIcon}>
                    {actionIcon(PENCIL_PATH)}
                  </span>
                  Edit message
                </button>
              )}
              {onStartThreadNamed && (
                <button
                  type="button"
                  role="menuitem"
                  className={sheetActionClass}
                  data-testid="sheet-action-thread"
                  onClick={() => { cancelCopyDismiss(); handleThreadStart(); }}
                >
                  <span aria-hidden className={sheetActionIcon}>
                    {actionIcon(THREAD_PATH)}
                  </span>
                  Start thread
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                className={sheetActionClass}
                data-testid="sheet-action-copy"
                onClick={handleCopy}
              >
                <span aria-hidden className={sheetActionIcon}>
                  {actionIcon(COPY)}
                </span>
                {copied === 'text' ? 'Copied!' : 'Copy text'}
              </button>
              {/* #114: the permalink action sits with Copy text (the two copy
                  affordances belong together) and above the destructive row.
                  Its "Copied!" beat is the row's own label, exactly like Copy
                  text's — the host's status pill renders under this sheet. */}
              {onCopyLink && !message.id.startsWith('pending_') && (
                <button
                  type="button"
                  role="menuitem"
                  className={sheetActionClass}
                  data-testid="sheet-action-copy-link"
                  onClick={handleCopyLink}
                >
                  <span aria-hidden className={sheetActionIcon}>
                    {actionIcon(LINK_PATH)}
                  </span>
                  {copied === 'link' ? 'Copied!' : 'Copy link'}
                </button>
              )}
              {onRemind && !message.id.startsWith('pending_') && !message.thread_id && (
                <button
                  type="button"
                  role="menuitem"
                  className={sheetActionClass}
                  data-testid="sheet-action-remind"
                  onClick={() => {
                    onOpenChange(false);
                    onRemind(message);
                  }}
                >
                  <span aria-hidden className={sheetActionIcon}>
                    {actionIcon(REMIND_PATH)}
                  </span>
                  Remind me…
                </button>
              )}
              {canDelete && onDeleteConfirmed && (
                <button
                  type="button"
                  role="menuitem"
                  className={sheetActionClass + ' text-danger'}
                  data-testid="sheet-action-delete"
                  onClick={() => { cancelCopyDismiss(); setView('delete'); }}
                >
                  <span aria-hidden className={sheetActionIcon + ' text-danger'}>
                    {actionIcon(TRASH_PATH)}
                  </span>
                  Delete message
                </button>
              )}
              </div>
              {/* Spoken copy feedback lives OUTSIDE the menu (an aria-live
                  region is not a legal menu child). */}
              <span aria-live="polite" className="sr-only" data-testid="sheet-copy-status">
                {copied === null
                  ? ''
                  : copied === 'link'
                    ? 'Link copied to clipboard'
                    : 'Copied to clipboard'}
              </span>
            </>
          ) : view === 'react' ? (
            <div data-testid="sheet-reaction-picker">
              <button
                type="button"
                className={sheetActionClass}
                data-testid="sheet-react-back"
                onClick={() => setView('actions')}
              >
                <span aria-hidden className={sheetActionIcon}>
                  ←
                </span>
                Back
              </button>
              {/* The SAME picker the hover toolbar hosts — favorites grid +
                  ＋ drill-in — embedded pre-opened (one tap, not two). */}
              <div className="flex justify-center px-2 pb-2">
                <ReactionPicker
                  defaultOpen
                  disabled={!online}
                  appliedEmojis={appliedEmojis}
                  onPick={handleReactionPick}
                />
              </div>
            </div>
          ) : view === 'edit' ? (
            <div className="flex flex-col gap-2 px-1 pb-1" data-testid="sheet-edit-form">
              <p className="m-0 text-xs font-semibold uppercase tracking-wide text-text-muted">
                Edit message
              </p>
              {/* The SAME editor the desktop row edits in (InlineMessageEditor):
                  mention/channel pills instead of the raw `<@id>` / `<#id>`
                  wire text a textarea showed, the shared `@`/`#`/`:` palettes,
                  Enter saves, Escape cancels. */}
              <InlineMessageEditor
                testId="sheet-edit"
                initialContent={content}
                store={store}
                channelId={message.channel_id}
                mentionResolver={(id) => mentionTagFor(store, id)}
                onSave={async (next) => {
                  onEditSubmit?.(message.id, next);
                  close();
                }}
                onCancel={() => setView('actions')}
              />
            </div>
          ) : (
            <div className="flex flex-col gap-2 px-1 pb-1" data-testid="sheet-delete-view">
              <p className="m-0 px-1 text-sm text-text" data-testid="sheet-delete-prompt">
                Delete this message? This cannot be undone.
              </p>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  className="modal-btn-secondary"
                  data-testid="sheet-delete-cancel"
                  onClick={() => setView('actions')}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="modal-btn-danger"
                  data-testid="sheet-delete-confirm"
                  onClick={() => {
                    onDeleteConfirmed?.(message.id);
                    close();
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          )}
      </DialogContent>
    </Dialog>
  );
}
