/**
 * @cytale/mobile — long-press message actions sheet (plan 004 M8, R11).
 *
 * The touch counterpart of the web hover toolbar, ported from
 * `apps/web/src/features/messages/MessageActionsSheet.tsx`: a native bottom
 * sheet over a scrim with the same action set — Add reaction, Reply, Edit
 * (author only), Start thread, Copy text, Delete (author or
 * MANAGE_MESSAGES). Rows without a wired handler do not render, so a
 * read-only host gets no dead affordances.
 *
 * Native mechanics that replace the web component's Radix dialog:
 *   * `Modal` (transparent + slide) is the sheet primitive — it owns the
 *     platform layer above the FlashList windowing boundary, so a row
 *     recycling underneath can never unmount an open sheet;
 *   * `onRequestClose` is the Android hardware-back dismiss, the scrim
 *     `Pressable` is the tap dismiss, and the grabber's responder tracks a
 *     downward drag that dismisses past `SHEET_SWIPE_DISMISS_DISTANCE`;
 *   * no system prompts (web's iOS-PWA rule, same reason): Edit and Start
 *     thread render in-sheet fields, Delete an in-sheet confirm. The copy
 *     beat ("Copied!") holds briefly, then the sheet dismisses — the same
 *     `COPY_DISMISS_MS` cadence web uses.
 *
 * Copy LINK is asynchronous and must be (#118): the URL is a token the server
 * mints (`POST /permalinks`), so the beat starts when the mint LANDS — and a
 * mint that fails is announced as a failure with nothing written to the
 * clipboard, never silently replaced by a locally-spelled legacy URL.
 *
 * The react view embeds `ReactionPicker` directly (favorites grid, one tap);
 * the picked emoji is handed to `onToggleReaction`, which is the same seam
 * the chips and the hover toolbar use, so optimistic behaviour stays in the
 * store (see `./reactions.ts`) rather than in this component.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import * as ReactNative from 'react-native';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { MessageWithReactions } from '@cytale/api-client';

import { MIN_TOUCH_TARGET } from '../navigation/ui';
import { theme } from '../theme';
import { ReactionPicker } from './ReactionPicker';
import { replyTargetFor, type ReplyTarget } from './replyTarget';

export type MessageSheetView = 'actions' | 'react' | 'edit' | 'thread' | 'delete';

export interface MessageActionsSheetProps {
  /** The long-pressed message (its id keys the sheet in `MessageList`). */
  message: MessageWithReactions;
  /** Host-controlled open state (`MessageList` owns it, keyed by message id). */
  open: boolean;
  /** Close requests (action, scrim tap, swipe, hardware back) flow here. */
  onOpenChange: (open: boolean) => void;
  /** Current user id — author-scoped gating, same rule as the hover toolbar. */
  currentUserId: string | null;
  /** True when the viewer holds MANAGE_MESSAGES (delete gate, like web). */
  canManageMessages?: boolean;
  /** Same seam as the chips / hover toolbar (toggle one emoji). */
  onToggleReaction?: (messageId: string, emoji: string) => void;
  /** Reply: the sheet builds the target, the composer focuses and consumes it. */
  onReply?: (target: ReplyTarget) => void;
  /** In-app edit commit (the prompt-free twin of the toolbar's onEdit). */
  onEditSubmit?: (messageId: string, content: string) => void;
  /** Delete after the in-sheet confirm. */
  onDeleteConfirmed?: (messageId: string) => void;
  /** Start thread with the in-sheet name (the server requires one). */
  onStartThreadNamed?: (messageId: string, name: string) => void;
  /** Copy seam; defaults to RN's Clipboard (host may inject expo-clipboard). */
  onCopy?: (text: string) => void;
  /**
   * The message permalink (#118), MINTED by the HOST: the token is keyed
   * server-side, so only the session's api client can produce one
   * (`POST /permalinks`, one round trip). Resolves to the absolute URL to put
   * on the clipboard, or to null when the message has no address at all — the
   * sheet says so instead of claiming a copy it did not make. REJECTS when the
   * mint fails, and the sheet reports that as a failure: nothing is written.
   */
  onCopyLink?: (message: MessageWithReactions) => Promise<string | null>;
  testID?: string;
}

/** Beat the "Copied!" feedback stays up before the sheet dismisses (web). */
export const COPY_DISMISS_MS = 900;
/** Downward drag past this many px dismisses the sheet. */
export const SHEET_SWIPE_DISMISS_DISTANCE = 72;

/** Best-effort clipboard write. Lazy access: RN's Clipboard getter warns. */
function writeClipboard(text: string): void {
  try {
    ReactNative.Clipboard.setString(text);
  } catch {
    // Clipboard is best-effort (hardened/absent implementations).
  }
}

export function MessageActionsSheet({
  message,
  open,
  onOpenChange,
  currentUserId,
  canManageMessages = false,
  onToggleReaction,
  onReply,
  onEditSubmit,
  onDeleteConfirmed,
  onStartThreadNamed,
  onCopy,
  onCopyLink,
  testID = 'message-actions-sheet',
}: MessageActionsSheetProps) {
  const [view, setView] = useState<MessageSheetView>('actions');
  /**
   * The copy beat: what the live region says, and which row may claim the
   * "Copied!" label. Two copy affordances share one beat (#114) and only the
   * row that was actually pressed may claim the word.
   */
  const [copyBeat, setCopyBeat] = useState<{
    note: string;
    row: 'copy' | 'link' | null;
  } | null>(null);
  const [editText, setEditText] = useState('');
  const [threadName, setThreadName] = useState('');
  const [dragY, setDragY] = useState(0);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** A mint in flight: a second tap must not spend a second round trip. */
  const linkPending = useRef(false);
  const dragStartY = useRef<number | null>(null);

  const isAuthor = currentUserId !== null && message.author_id === currentUserId;
  const canDelete = isAuthor || canManageMessages;
  const canEdit = isAuthor;
  const content = message.content ?? '';
  const reactions = (Array.isArray(message.reactions) ? message.reactions : []).filter(
    (r) => r && typeof r.emoji === 'string' && typeof r.count === 'number' && typeof r.me === 'boolean',
  );
  const appliedEmojis = reactions.map((r) => r.emoji);

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  // A stale edit/thread view must never survive a new long-press.
  useEffect(() => {
    if (!open) return;
    setView('actions');
    setCopyBeat(null);
    setEditText('');
    setThreadName('');
    linkPending.current = false;
  }, [open, message.id]);

  // Never leak the copy-dismiss timer.
  useEffect(
    () => () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    },
    [],
  );

  /** A pending copy-dismiss must not close under a follow-up action. */
  const cancelCopyDismiss = useCallback(() => {
    if (copyTimer.current !== null) {
      clearTimeout(copyTimer.current);
      copyTimer.current = null;
    }
  }, []);

  const handleReactionPick = (emoji: string) => {
    onToggleReaction?.(message.id, emoji);
    close();
  };

  const handleEditSave = () => {
    if (!editText.trim()) return; // an emptied edit never commits
    onEditSubmit?.(message.id, editText);
    close();
  };

  const handleThreadStart = () => {
    if (!threadName.trim()) return; // the server requires a name
    onStartThreadNamed?.(message.id, threadName);
    close();
  };

  /** Start the copy beat: show the note briefly, then dismiss the sheet. */
  const beginCopyBeat = (note: string, row: 'copy' | 'link' | null) => {
    setCopyBeat({ note, row });
    cancelCopyDismiss();
    copyTimer.current = setTimeout(() => {
      copyTimer.current = null;
      close();
    }, COPY_DISMISS_MS);
  };

  const handleCopy = () => {
    if (onCopy) onCopy(content);
    else writeClipboard(content);
    beginCopyBeat('Copied to clipboard', 'copy');
  };

  /**
   * #118 Copy link: the host MINTS the URL (one round trip through the
   * session's api client), this writes it and shows the SAME beat Copy text
   * uses. Three outcomes, all visible, and only ONE of them touches the
   * clipboard:
   *
   *   * a null URL — the message has no address to mint from ("This message
   *     has no link yet."), reported, never dressed up as a copy;
   *   * a REJECTION — the mint failed (offline, a 404, a malformed answer). Told
   *     to the user as a failure, with nothing written: a stale link, or the
   *     legacy fragment spelling, is worse than the honest error;
   *   * a URL — written, then announced. The "Copied!" label belongs to the row
   *     that was pressed, and it is only claimed for a mint that landed.
   */
  const handleCopyLink = () => {
    if (onCopyLink === undefined || linkPending.current) return;
    linkPending.current = true;
    void onCopyLink(message).then(
      (url) => {
        linkPending.current = false;
        if (url === null) {
          beginCopyBeat('This message has no link yet.', null);
          return;
        }
        writeClipboard(url);
        beginCopyBeat('Link copied to clipboard', 'link');
      },
      () => {
        linkPending.current = false;
        beginCopyBeat('Could not copy the link.', null);
      },
    );
  };

  // -- swipe-down dismiss (grabber only: the action rows own their taps) ----
  const onGrab = (pageY: number) => {
    dragStartY.current = pageY;
  };
  const onDrag = (pageY: number) => {
    const start = dragStartY.current;
    if (start === null) return;
    setDragY(Math.max(0, pageY - start));
  };
  const onDragEnd = (pageY: number) => {
    const start = dragStartY.current;
    dragStartY.current = null;
    setDragY(0);
    if (start !== null && pageY - start > SHEET_SWIPE_DISMISS_DISTANCE) close();
  };
  const onDragCancel = () => {
    dragStartY.current = null;
    setDragY(0);
  };

  const body = () => {
    if (view === 'react') {
      return (
        <View testID="sheet-reaction-picker">
          <SheetAction
            label="Back"
            testID="sheet-react-back"
            onPress={() => setView('actions')}
          />
          <ReactionPicker
            appliedEmojis={appliedEmojis}
            disabled={onToggleReaction === undefined}
            onPick={handleReactionPick}
          />
        </View>
      );
    }
    if (view === 'edit') {
      return (
        <View style={styles.form} testID="sheet-edit-form">
          <Text style={styles.fieldLabel}>Edit message</Text>
          <TextInput
            key={`edit-${message.id}`}
            style={styles.input}
            testID="sheet-edit-input"
            accessibilityLabel="Edit message"
            multiline
            defaultValue={content}
            onChangeText={setEditText}
          />
          <View style={styles.formActions}>
            <SheetAction label="Cancel" testID="sheet-edit-cancel" onPress={() => setView('actions')} />
            <SheetAction
              label="Save"
              testID="sheet-edit-save"
              emphasis
              disabled={!editText.trim()}
              onPress={handleEditSave}
            />
          </View>
        </View>
      );
    }
    if (view === 'thread') {
      return (
        <View style={styles.form} testID="sheet-thread-form">
          <Text style={styles.fieldLabel}>Thread name</Text>
          <TextInput
            key={`thread-${message.id}`}
            style={styles.input}
            testID="sheet-thread-name"
            accessibilityLabel="Thread name"
            placeholder="Thread name"
            defaultValue=""
            onChangeText={setThreadName}
          />
          <View style={styles.formActions}>
            <SheetAction
              label="Cancel"
              testID="sheet-thread-cancel"
              onPress={() => setView('actions')}
            />
            <SheetAction
              label="Start thread"
              testID="sheet-thread-start"
              emphasis
              disabled={!threadName.trim()}
              onPress={handleThreadStart}
            />
          </View>
        </View>
      );
    }
    if (view === 'delete') {
      return (
        <View style={styles.form} testID="sheet-delete-view">
          <Text style={styles.confirmText} testID="sheet-delete-prompt">
            Delete this message? This cannot be undone.
          </Text>
          <View style={styles.formActions}>
            <SheetAction
              label="Cancel"
              testID="sheet-delete-cancel"
              onPress={() => setView('actions')}
            />
            <SheetAction
              label="Delete"
              testID="sheet-delete-confirm"
              destructive
              onPress={() => {
                onDeleteConfirmed?.(message.id);
                close();
              }}
            />
          </View>
        </View>
      );
    }
    return (
      <View role="menu" accessibilityLabel="Message actions" testID="sheet-actions">
        {onToggleReaction === undefined ? null : (
          <SheetAction
            label="Add reaction"
            testID="sheet-action-react"
            onPress={() => {
              cancelCopyDismiss();
              setView('react');
            }}
          />
        )}
        {onReply === undefined ? null : (
          <SheetAction
            label="Reply"
            testID="sheet-action-reply"
            onPress={() => {
              onReply(replyTargetFor(message));
              close();
            }}
          />
        )}
        {canEdit && onEditSubmit !== undefined ? (
          <SheetAction
            label="Edit message"
            testID="sheet-action-edit"
            onPress={() => {
              cancelCopyDismiss();
              setView('edit');
            }}
          />
        ) : null}
        {onStartThreadNamed === undefined ? null : (
          <SheetAction
            label="Start thread"
            testID="sheet-action-thread"
            onPress={() => {
              cancelCopyDismiss();
              setView('thread');
            }}
          />
        )}
        <SheetAction
          label={copyBeat?.row === 'copy' ? 'Copied!' : 'Copy text'}
          testID="sheet-action-copy"
          onPress={handleCopy}
        />
        {/* #118: the permalink action sits with Copy text — the two copy
            affordances belong together, and both stay above the destructive
            row. Feedback rides the shared beat below; the sheet dismisses on
            it, so the label swap would be invisible on this row. */}
        {onCopyLink === undefined ? null : (
          <SheetAction
            label={copyBeat?.row === 'link' ? 'Copied!' : 'Copy link'}
            testID="sheet-action-copy-link"
            onPress={handleCopyLink}
          />
        )}
        {canDelete && onDeleteConfirmed !== undefined ? (
          <SheetAction
            label="Delete message"
            testID="sheet-action-delete"
            destructive
            onPress={() => {
              cancelCopyDismiss();
              setView('delete');
            }}
          />
        ) : null}
      </View>
    );
  };

  return (
    <Modal
      visible={open}
      transparent
      animationType="slide"
      onRequestClose={close}
      statusBarTranslucent
      testID={`${testID}-modal`}
    >
      <View style={styles.backdrop}>
        <Pressable
          style={styles.scrim}
          onPress={close}
          testID="message-actions-scrim"
          accessibilityRole="button"
          accessibilityLabel="Dismiss message actions"
        />
        <View
          style={[styles.sheet, dragY > 0 ? { transform: [{ translateY: dragY }] } : null]}
          testID={testID}
          accessibilityViewIsModal
        >
          <View
            style={styles.grabberArea}
            testID="message-actions-grabber"
            accessibilityLabel="Drag down to dismiss"
            onStartShouldSetResponder={() => true}
            onResponderGrant={(event) => onGrab(event.nativeEvent.pageY)}
            onResponderMove={(event) => onDrag(event.nativeEvent.pageY)}
            onResponderRelease={(event) => onDragEnd(event.nativeEvent.pageY)}
            onResponderTerminate={onDragCancel}
            onResponderTerminationRequest={() => true}
          >
            <View style={styles.grabber} />
          </View>
          {body()}
          {/* Dismissal for assistive tech: `accessibilityViewIsModal` hides
              the scrim from VoiceOver (it is a sibling of this view), and iOS
              has no hardware back — swipe-down is not a VoiceOver gesture.
              Same 44pt row, below the action set. */}
          <SheetAction label="Close" testID="sheet-action-close" role="button" onPress={close} />
          <Text style={styles.status} accessibilityLiveRegion="polite" testID="sheet-copy-status">
            {copyBeat?.note ?? ''}
          </Text>
        </View>
      </View>
    </Modal>
  );
}

interface SheetActionProps {
  label: string;
  testID: string;
  onPress: () => void;
  /** Menu rows are `menuitem`; the dismissal footer is a plain button. */
  role?: 'menuitem' | 'button';
  /** Primary/destructive emphasis for form footers. */
  emphasis?: boolean;
  destructive?: boolean;
  disabled?: boolean;
}

/** One 44pt menu row (web's `sheetActionClass`). */
function SheetAction({
  label,
  testID,
  onPress,
  role = 'menuitem',
  emphasis,
  destructive,
  disabled,
}: SheetActionProps) {
  return (
    <Pressable
      role={role}
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled === true }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.action,
        pressed && disabled !== true ? styles.actionPressed : null,
      ]}
    >
      <Text
        style={[
          styles.actionText,
          emphasis ? styles.actionEmphasis : null,
          destructive ? styles.actionDestructive : null,
          disabled === true ? styles.actionDisabled : null,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  scrim: {
    // Owner direction 2026-09-20: do NOT shade the message above the sheet —
    // the backdrop stays fully transparent and is only the tap-to-dismiss
    // affordance (the sheet itself carries the visual separation).
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'transparent',
  },
  sheet: {
    backgroundColor: theme.colors.surfaceEmphasized,
    borderTopLeftRadius: theme.radii.lg,
    borderTopRightRadius: theme.radii.lg,
    paddingBottom: theme.spacing.xl,
  },
  grabberArea: {
    minHeight: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  grabber: {
    width: 40,
    height: 4,
    borderRadius: theme.radii.full,
    backgroundColor: theme.colors.inputBorder,
  },
  action: {
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radii.md,
  },
  actionPressed: {
    backgroundColor: theme.colors.surfaceHover,
  },
  actionText: {
    color: theme.colors.textPrimary,
    fontSize: theme.fontSizes.lg,
  },
  actionEmphasis: {
    color: theme.colors.accent,
    fontWeight: '600',
  },
  actionDestructive: {
    color: theme.colors.danger,
  },
  actionDisabled: {
    color: theme.colors.textMuted,
  },
  form: {
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.sm,
    gap: theme.spacing.sm,
  },
  fieldLabel: {
    color: theme.colors.textMuted,
    fontSize: theme.fontSizes.xs,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  input: {
    minHeight: MIN_TOUCH_TARGET,
    maxHeight: 160,
    borderWidth: 1,
    borderColor: theme.colors.inputBorder,
    borderRadius: theme.radii.md,
    backgroundColor: theme.colors.input,
    color: theme.colors.textPrimary,
    fontSize: theme.fontSizes.lg,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    textAlignVertical: 'top',
  },
  formActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: theme.spacing.sm,
  },
  confirmText: {
    color: theme.colors.text,
    fontSize: theme.fontSizes.lg,
    paddingVertical: theme.spacing.sm,
  },
  status: {
    color: theme.colors.textMuted,
    fontSize: theme.fontSizes.xs,
    textAlign: 'center',
    minHeight: theme.fontSizes.xs,
  },
});
