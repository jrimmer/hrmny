/**
 * @cytale/mobile — the message composer (plan 004 M7, R9/R10/R15).
 *
 * A `TextInput` that grows with its content, a send control, `:shortcode:`
 * autocomplete over the shared `@cytale/emoji` catalog, and an attachment
 * tray fed by the image/document pickers. Text goes out through the same
 * optimistic-send contract the web client uses (`@cytale/state` +
 * `CytaleApiClient.sendMessage`), so a native send reconciles exactly like a
 * web one.
 *
 * Keyboard rule (R9): a plain Return sends; a Return carrying a shift
 * modifier inserts a newline. RN's `onKeyPress` reports only `key` ("Enter")
 * on both platforms today — the modifier is read when the platform supplies
 * it (`shiftKey` / `modifierKeys.shift`) and its absence means "plain
 * Return". `submitBehavior="submit"` keeps the native control from inserting
 * its own newline, so the composer owns both branches and the input never
 * accumulates a stray "\n" on send.
 *
 * Attachments (R10): pick → client-side mime/size prefilter (the server's
 * allowlist mirrored) → upload with a live chip → the finished rows bind
 * into the create body. A failed upload keeps its chip with Retry; the
 * message text is never cleared until a send succeeds, so nothing is
 * retyped. Enter waits out in-flight uploads rather than silently dropping
 * them.
 *
 * View-only / offline (R15): the composer is replaced by the shell's
 * view-only note, or disables its controls, respectively.
 *
 * Render fan-out (performance pass, P3): the input is a controlled field, so
 * the view MUST re-render on every keystroke — but the things around it need
 * not. The suggestion list is its own memoized component (it only changes when
 * the open `:token` does), the attachment tray and emoji panel are memoized
 * components with stable props, and every control's handler is a `useCallback`
 * so a keystroke does not hand new prop identities to the buttons. The
 * `IconButton`s themselves are owned by `navigation/ui` (not memoized there),
 * so they still re-render with this view; their props are already stable for
 * whichever side adds the boundary.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeSyntheticEvent,
  type TextInputContentSizeChangeEventData,
  type TextInputKeyPressEventData,
  type TextInputSelectionChangeEventData,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { UploadedAttachment } from '@cytale/api-client';
import type { WorkspaceMember } from '@cytale/domain';
import {
  emojiByShortcode,
  searchEmojiCatalog,
  type EmojiPreferences,
  type EmojiSearchRow,
} from '@cytale/emoji';
import { defaultStore, nicknamesForChannel, type StateStore } from '@cytale/state';

import { useSession } from '../navigation/session';
import { useSurfaceStates } from '../navigation/shellState';
import { useStoreSelector } from '../navigation/store';
import { ViewOnlyNotice } from '../navigation/SurfaceStates';
import { IconButton, MIN_TOUCH_TARGET } from '../navigation/ui';
import { theme } from '../theme';
import { AttachmentTray } from './AttachmentTray';
import { uploadRejection } from './attachmentRules';
import { EmojiPicker } from './EmojiPicker';
import { emojiPreferencesFor } from './emojiPreferences';
import {
  pickFiles as defaultPickFiles,
  pickFromCamera as defaultPickCamera,
  pickFromLibrary as defaultPickLibrary,
} from './pickers';
import type {
  PickAttachments,
  PickedAttachment,
  ReplyTarget,
  SendMessage,
  StagedAttachment,
  UploadAttachment,
} from './types';
import { useSendMessage } from './useSendMessage';
import { createNativeUpload } from './nativeUpload';
import { displayNameOf } from '@cytale/domain';

/** One-line input floor and the six-line ceiling (R9: grows with content). */
const MIN_INPUT_HEIGHT = MIN_TOUCH_TARGET;
const MAX_INPUT_HEIGHT = 132;
/** Discord-style suggestion cap. */
const MAX_SUGGESTIONS = 12;
/** Web's MENTION_LIMIT: the mention palette lists at most eight members. */
const MENTION_LIMIT = 8;

/** A trailing `:token` (≥2 chars, word-boundary before the colon) is an open
 *  emoji query; a closing colon makes it a closed token (web's rules). */
const EMOJI_OPEN = /(?:^|\s):([a-z0-9_+-]{2,32}):?$/i;
const EMOJI_CLOSED = /(?:^|\s):([a-z0-9_+-]{2,32}):$/i;

/**
 * The @-mention trigger (web's `mentionQueryOf` parity): an `@token` run
 * ending at the CARET, a word boundary before the `@` so `me@example.com`
 * and `foo@bar` never fire. The query may be EMPTY — a bare `@` opens the
 * palette with the whole roster, exactly as web (and Discord) do.
 */
const MENTION_OPEN = /(?:^|\s)@([\p{L}\p{N}._-]{0,32})$/u;

/** The subset of the key event that can carry a modifier. */
type KeyPressNative = TextInputKeyPressEventData & {
  shiftKey?: boolean;
  modifierKeys?: { shift?: boolean };
};

/** True when the platform reported Shift held for this Return. */
function shiftHeld(native: KeyPressNative): boolean {
  return native.shiftKey === true || native.modifierKeys?.shift === true;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface EmojiSuggestionsProps {
  /** The open `:token` (without its colons). */
  query: string;
  /** Catalog matches, already capped by the composer. */
  matches: EmojiSearchRow[];
  /** Highlighted row (keyboard selection). */
  activeIndex: number;
  onAccept: (emoji: string) => void;
}

/**
 * The `:shortcode:` suggestion list, on its own memo boundary: it is rendered
 * from memoized values (`emojiMatches` is keyed on the open token) and one
 * stable callback, so a keystroke that does not change the open token — and
 * any other composer state change — leaves this list alone (performance pass,
 * P3). Mounting is still gated by the composer's `suggestionsOpen`.
 */
const EmojiSuggestions = memo(function EmojiSuggestions({
  query,
  matches,
  activeIndex,
  onAccept,
}: EmojiSuggestionsProps) {
  return (
    <View
      style={styles.suggestions}
      accessibilityLabel={`Emoji matching ${query}`}
      testID="emoji-autocomplete"
    >
      <Text style={styles.suggestionsTitle} accessibilityRole="header">
        EMOJI MATCHING :{query}
      </Text>
      {matches.length === 0 ? (
        <Text style={styles.suggestionsEmpty} testID="emoji-autocomplete-empty">
          No emoji match :{query}
        </Text>
      ) : (
        matches.map((row, index) => (
          <Pressable
            key={`${row.n}-${index}`}
            accessibilityRole="button"
            accessibilityLabel={`Insert ${row.e} :${row.n}:`}
            accessibilityState={{ selected: index === activeIndex }}
            onPress={() => onAccept(row.e)}
            testID="emoji-option"
            style={({ pressed }) => [
              styles.suggestion,
              index === activeIndex ? styles.suggestionActive : null,
              pressed ? styles.pressed : null,
            ]}
          >
            <Text style={styles.suggestionGlyph} accessibilityElementsHidden>
              {row.e}
            </Text>
            <Text style={styles.suggestionName}>{`:${row.n}:`}</Text>
          </Pressable>
        ))
      )}
    </View>
  );
});
EmojiSuggestions.displayName = 'EmojiSuggestions';

export interface ComposerProps {
  channelId: string;
  /** Thread scope; null = channel message. */
  threadId?: string | null;
  /** Active inline-reply target; renders the reply bar until sent/cancelled. */
  replyTo?: ReplyTarget | null;
  /** Clears the reply target (✕ / after a successful send). */
  onCancelReply?: () => void;
  /** Store holding the optimistic rows; `defaultStore` in production. */
  store?: StateStore;
  /** Send seam (injected with `upload` to render without a session). */
  send?: SendMessage;
  /** Upload seam; defaults to the session's api-client. */
  upload?: UploadAttachment;
  /** Picker seams (tests / future sources). */
  pickImageLibrary?: PickAttachments;
  pickCamera?: PickAttachments;
  pickFiles?: PickAttachments;
  /** Emoji preferences; defaults to the per-account binding. */
  preferences?: EmojiPreferences;
  /** Current user id; defaults to the store's. */
  currentUserId?: string | null;
  /** Shell state overrides (tests); default: the shared surface states. */
  viewOnly?: boolean;
  offline?: boolean;
  testID?: string;
}

// #136: an attachment descriptor is usable only if it can actually be
// fetched by a reader — an empty object is truthy and must not pass.
function usableAttachment(a: UploadedAttachment | undefined): a is UploadedAttachment {
  return typeof a?.url === 'string' && a.url.length > 0;
}

/**
 * Session-bound entry: supplies the api-client-backed send/upload defaults.
 * Split from `ComposerView` so the view can render in tests without a
 * `SessionProvider` (the same reason `useSession` throws outside one).
 */
function SessionComposer(props: ComposerProps) {
  const session = useSession();
  const api = session.api;
  const send = useSendMessage({ api, store: props.store });
  const upload = useCallback<UploadAttachment>(
    // Native multipart upload (expo-file-system): the winter fetch cannot
    // convert RN's {uri} FormData parts — every upload died with
    // "Unsupported FormDataPart implementation" on device. The token rides
    // the same live store the api client reads, so a mid-upload refresh is
    // picked up by the next attempt.
    createNativeUpload({
      accessToken: () => session.authStore.getState().accessToken,
    }),
    [api, session],
  );
  return <ComposerView {...props} send={send} upload={upload} />;
}

export function Composer(props: ComposerProps) {
  if (props.send !== undefined && props.upload !== undefined) {
    return <ComposerView {...props} send={props.send} upload={props.upload} />;
  }
  return <SessionComposer {...props} />;
}

export function ComposerView({
  channelId,
  threadId = null,
  replyTo = null,
  onCancelReply,
  store = defaultStore,
  send,
  upload,
  pickImageLibrary = defaultPickLibrary,
  pickCamera = defaultPickCamera,
  pickFiles = defaultPickFiles,
  preferences,
  currentUserId,
  viewOnly,
  offline,
  testID = 'message-compose',
}: ComposerProps & { send: SendMessage; upload: UploadAttachment }) {
  const shared = useSurfaceStates();
  const insets = useSafeAreaInsets();
  const isViewOnly = viewOnly ?? shared.viewOnly ?? false;
  const isOffline = offline ?? shared.offline ?? false;

  // -- identity / preferences ---------------------------------------------
  const storeUserId = useStoreSelector(store, (state) => state.currentUser?.id ?? null);
  const userId = currentUserId !== undefined ? currentUserId : storeUserId;
  const activePreferences = preferences ?? emojiPreferencesFor(userId);
  const membersById = useStoreSelector(store, (state) => state.membersById);
  // This channel's workspace nicknames (#169); undefined in a DM.
  const nicknames = useStoreSelector(store, (state) => nicknamesForChannel(state, channelId));
  const selfUsername = useStoreSelector(store, (state) => state.currentUser?.username ?? null);

  const replyAuthorName = useMemo(() => {
    if (!replyTo) return '';
    const member = membersById[replyTo.authorId];
    if (member) return displayNameOf({ ...member, nickname: nicknames?.[member.id] ?? null });
    if (userId !== null && userId === replyTo.authorId && selfUsername) return selfUsername;
    return replyTo.authorId;
  }, [replyTo, membersById, nicknames, userId, selfUsername]);

  // -- text state ----------------------------------------------------------
  const [value, setValue] = useState('');
  const valueRef = useRef('');
  useEffect(() => {
    valueRef.current = value;
  }, [value]);
  const [inputHeight, setInputHeight] = useState(MIN_INPUT_HEIGHT);
  const [forcedSelection, setForcedSelection] = useState<{
    start: number;
    end: number;
  } | null>(null);
  const selectionRef = useRef({ start: 0, end: 0 });
  const inputRef = useRef<TextInput | null>(null);

  /** Splice `insert` into the value at the caret (or replace a token range). */
  const splice = useCallback(
    (insert: string, replace?: { start: number; end: number }) => {
      const current = valueRef.current;
      const start = Math.min(replace?.start ?? selectionRef.current.start, current.length);
      const end = Math.min(replace?.end ?? selectionRef.current.end, current.length);
      const next = current.slice(0, start) + insert + current.slice(end);
      const caret = start + insert.length;
      valueRef.current = next;
      setValue(next);
      selectionRef.current = { start: caret, end: caret };
      setForcedSelection({ start: caret, end: caret });
    },
    [],
  );

  // -- @-mention typeahead (2026-09-19: mentions had to be typed out) ------
  // The palette is a CARET feature (web #129): the query recomputes when the
  // caret moves without a text change too (tap / arrow keys) — a stale token
  // range could otherwise replace the wrong span on pick. `caretTick` is the
  // selection-change signal the memo needs (the ref below never re-renders).
  const [caretTick, setCaretTick] = useState(0);
  const mentionQuery = useMemo(() => {
    const caret = selectionRef.current.start;
    const before = value.slice(0, caret);
    const match = MENTION_OPEN.exec(before);
    const query = match?.[1];
    if (query === undefined) return null;
    return { query: query.toLowerCase(), start: caret - query.length - 1 };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- caretTick re-runs the read on caret moves
  }, [value, caretTick]);

  // Web's ranking (mentionCandidates.ts): username prefixes first, then
  // nickname prefixes, then substring matches anywhere — each band
  // alphabetical. A bare `@` (empty query) prefix-matches everything, so the
  // whole roster comes up in name order.
  const mentionCandidates = useMemo(() => {
    if (mentionQuery === null) return [];
    const query = mentionQuery.query;
    const usernamePrefix: WorkspaceMember[] = [];
    const nicknamePrefix: WorkspaceMember[] = [];
    const elsewhere: WorkspaceMember[] = [];
    for (const row of Object.values(membersById)) {
      // This workspace's nickname (#169), never the shared row's.
      const member = { ...row, nickname: nicknames?.[row.id] ?? null };
      const username = (member.username ?? '').toLowerCase();
      // The names a person is SHOWN by (#168): nickname and display name.
      const shown = [member.nickname, member.display_name]
        .filter((n): n is string => typeof n === 'string' && n !== '')
        .map((n) => n.toLowerCase());
      if (username.startsWith(query)) usernamePrefix.push(member);
      else if (shown.some((n) => n.startsWith(query))) nicknamePrefix.push(member);
      else if (username.includes(query) || shown.some((n) => n.includes(query))) elsewhere.push(member);
    }
    const byUsername = (a: WorkspaceMember, b: WorkspaceMember) =>
      (a.username ?? '').localeCompare(b.username ?? '');
    usernamePrefix.sort(byUsername);
    nicknamePrefix.sort(byUsername);
    elsewhere.sort(byUsername);
    return [...usernamePrefix, ...nicknamePrefix, ...elsewhere].slice(0, MENTION_LIMIT);
  }, [mentionQuery, membersById, nicknames]);

  function pickMention(member: { id: string }): void {
    if (mentionQuery === null) return;
    // The WIRE token, not the display name (web's insertMention contract):
    // `<@id> ` is what the server pings and what every client's markdown
    // parses — an inserted `@name` is prose no library can detect. The
    // trailing space also closes the palette: it cannot reopen on the way
    // out. (The raw token shows in this plain TextInput; the composer input
    // cannot render web's inline mention chip.)
    splice(`<@${member.id}> `, {
      start: mentionQuery.start,
      end: selectionRef.current.start,
    });
  }

  // -- `:shortcode:` autocomplete -----------------------------------------
  const [emojiDismissed, setEmojiDismissed] = useState(false);
  const [emojiIndex, setEmojiIndex] = useState(0);
  const [emojiPanelOpen, setEmojiPanelOpen] = useState(false);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [sending, setSending] = useState(false);
  /** Synchronous gate: `sending` state lags re-render, and the upload-wait
   *  window is long enough for a double-Enter to slip through. */
  const sendingRef = useRef(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const emojiQuery = useMemo(() => {
    if (emojiDismissed) return null;
    const match = EMOJI_OPEN.exec(value);
    return match ? (match[1] ?? null) : null;
  }, [value, emojiDismissed]);
  const emojiMatches = useMemo(
    () => (emojiQuery === null ? [] : searchEmojiCatalog(emojiQuery).slice(0, MAX_SUGGESTIONS)),
    [emojiQuery],
  );
  const emojiClamped = Math.min(emojiIndex, Math.max(emojiMatches.length - 1, 0));
  const suggestionsOpen = emojiQuery !== null;

  useEffect(() => {
    setEmojiIndex(0);
  }, [emojiQuery]);

  /** Replace the trailing `:token` with the picked emoji (web's rule). */
  const acceptEmoji = useCallback(
    (emoji: string) => {
      const current = valueRef.current;
      const match = EMOJI_OPEN.exec(current);
      if (match && match.index !== undefined) {
        const tokenStart = match.index + (match[0].length - match[0].trimStart().length);
        splice(emoji, { start: tokenStart, end: current.length });
      } else {
        splice(emoji);
      }
      activePreferences.bumpFrecents(emoji);
      setEmojiDismissed(true);
    },
    [activePreferences, splice],
  );

  /** Picker-panel insert: at the caret, without touching the token rules. */
  const insertEmoji = useCallback(
    (emoji: string) => {
      splice(emoji);
      activePreferences.bumpFrecents(emoji);
    },
    [activePreferences, splice],
  );

  const handleChangeText = useCallback((next: string) => {
    valueRef.current = next;
    setValue(next);
    setEmojiDismissed(false);
    // A CLOSED `:name:` with an exact catalog match converts the moment the
    // closing colon lands — Discord's typing behavior (web parity).
    const closed = EMOJI_CLOSED.exec(next);
    if (closed) {
      const hit = emojiByShortcode(closed[1] ?? '');
      if (hit) {
        valueRef.current = next.replace(/:[a-z0-9_+-]{2,32}:$/i, hit.e);
        setValue(valueRef.current);
        activePreferences.bumpFrecents(hit.e);
      }
    }
  }, [activePreferences]);

  // -- attachments ---------------------------------------------------------
  const [staged, setStaged] = useState<StagedAttachment[]>([]);
  const stagedRef = useRef<StagedAttachment[]>([]);
  const uploadSeq = useRef(0);
  /** key → in-flight upload promise; Enter waits these out before sending. */
  const inFlight = useRef(new Map<string, Promise<void>>());

  const updateStaged = useCallback((next: StagedAttachment[]) => {
    stagedRef.current = next;
    setStaged(next);
  }, []);

  const uploadChip = useCallback(
    (key: string, file: PickedAttachment) => {
      updateStaged(
        stagedRef.current.map((chip) =>
          chip.key === key
            ? { ...chip, status: 'uploading', error: undefined, retryable: undefined, attachment: undefined }
            : chip,
        ),
      );
      const promise = (async () => {
        try {
          const uploaded: UploadedAttachment = await upload(channelId, file);
          // #136 producer gate, twin of the web composer's: a 201 without a
          // usable descriptor (the api-client `?? res` fallback can ride the
          // whole envelope through) must land as an error chip, never as a
          // `done` chip the send filter would bind.
          if (!usableAttachment(uploaded)) {
            throw new Error('upload returned no attachment descriptor');
          }
          updateStaged(
            stagedRef.current.map((chip) =>
              chip.key === key ? { ...chip, status: 'done', attachment: uploaded } : chip,
            ),
          );
        } catch (err) {
          updateStaged(
            stagedRef.current.map((chip) =>
              chip.key === key
                ? { ...chip, status: 'error', error: messageOf(err), retryable: true }
                : chip,
            ),
          );
        } finally {
          inFlight.current.delete(key);
        }
      })();
      inFlight.current.set(key, promise);
    },
    [channelId, updateStaged, upload],
  );

  /** Prefilter first: a blocked/oversize file never leaves the device. */
  const addPicked = useCallback(
    (files: PickedAttachment[]) => {
      for (const file of files) {
        const key = `staged-${++uploadSeq.current}`;
        const rejection = uploadRejection(file);
        if (rejection !== null) {
          updateStaged([
            ...stagedRef.current,
            { key, file, status: 'error', error: rejection, retryable: false },
          ]);
          continue;
        }
        updateStaged([...stagedRef.current, { key, file, status: 'uploading' }]);
        uploadChip(key, file);
      }
    },
    [updateStaged, uploadChip],
  );

  const runPicker = useCallback(
    (pick: PickAttachments) => {
      setAttachMenuOpen(false);
      void (async () => {
        try {
          addPicked(await pick());
        } catch (err) {
          setSendError(messageOf(err));
        }
      })();
    },
    [addPicked],
  );

  const removeStaged = useCallback(
    (key: string) => {
      inFlight.current.delete(key);
      updateStaged(stagedRef.current.filter((chip) => chip.key !== key));
    },
    [updateStaged],
  );

  const retryStaged = useCallback(
    (key: string) => {
      const chip = stagedRef.current.find((candidate) => candidate.key === key);
      if (chip) uploadChip(key, chip.file);
    },
    [uploadChip],
  );

  // Staged chips are channel-scoped: switching channels drops the tray
  // rather than leaking uploads across targets.
  useEffect(() => {
    updateStaged([]);
    inFlight.current.clear();
    valueRef.current = '';
    setValue('');
  }, [channelId, updateStaged]);

  // -- send ----------------------------------------------------------------
  const readyAttachments = useCallback(
    (): UploadedAttachment[] =>
      stagedRef.current
        // #136: a usable descriptor (a url), not merely a truthy object — an
        // entry that cannot be fetched by a reader must never ride the send.
        .filter((chip) => chip.status === 'done' && usableAttachment(chip.attachment))
        .map((chip) => chip.attachment as UploadedAttachment),
    [],
  );

  const handleSend = useCallback(async () => {
    if (sendingRef.current || isViewOnly || isOffline) return;
    const text = valueRef.current.trim();
    if (!text && readyAttachments().length === 0 && inFlight.current.size === 0) return;
    sendingRef.current = true;
    setSending(true);
    setSendError(null);
    try {
      // Enter never silently drops a still-uploading chip: wait the in-flight
      // uploads out, then bind whatever finished (failed chips stay staged).
      if (inFlight.current.size > 0) {
        await Promise.allSettled([...inFlight.current.values()]);
      }
      const finalText = valueRef.current.trim();
      const attachments = readyAttachments();
      if (!finalText && attachments.length === 0) return;
      const content = replyTo?.ping ? `<@${replyTo.authorId}> ${finalText}`.trim() : finalText;
      await send({
        channelId,
        threadId,
        content,
        replyToId: replyTo?.messageId ?? null,
        attachments,
      });
      // Success clears the input + tray; a failure keeps both (no retyping).
      valueRef.current = '';
      setValue('');
      updateStaged([]);
      setEmojiDismissed(false);
      setEmojiPanelOpen(false);
      onCancelReply?.();
    } catch (err) {
      setSendError(messageOf(err));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [
    channelId,
    isOffline,
    isViewOnly,
    onCancelReply,
    readyAttachments,
    replyTo,
    send,
    threadId,
    updateStaged,
  ]);

  // -- keyboard ------------------------------------------------------------
  /** Set when a shifted Return was seen, consumed by `onSubmitEditing`. */
  const shiftReturnRef = useRef(false);

  const insertNewline = useCallback(() => {
    splice('\n');
  }, [splice]);

  const handleKeyPress = useCallback(
    (event: NativeSyntheticEvent<KeyPressNative>) => {
      const native = event.nativeEvent;
      if (native.key !== 'Enter') return;
      if (shiftHeld(native)) {
        // Shift+Enter newlines; the submit that follows is swallowed.
        shiftReturnRef.current = true;
        insertNewline();
      }
    },
    [insertNewline],
  );

  const handleSubmitEditing = useCallback(() => {
    if (shiftReturnRef.current) {
      shiftReturnRef.current = false;
      return;
    }
    if (suggestionsOpen) {
      const row = emojiMatches[emojiClamped];
      if (row) acceptEmoji(row.e);
      else setEmojiDismissed(true);
      return;
    }
    void handleSend();
  }, [acceptEmoji, emojiClamped, emojiMatches, handleSend, suggestionsOpen]);

  // A reply target means the user's next act is typing — focus the input so
  // the caret is already in the message line (each reply creates a new target).
  useEffect(() => {
    if (replyTo) inputRef.current?.focus();
  }, [replyTo]);

  // -- stable control handlers (the view re-renders per keystroke) ----------
  const toggleAttachMenu = useCallback(() => setAttachMenuOpen((open) => !open), []);
  const toggleEmojiPanel = useCallback(() => setEmojiPanelOpen((open) => !open), []);
  /** Stable identity so the memoized panel is not re-rendered per keystroke. */
  const closeEmojiPanel = useCallback(() => setEmojiPanelOpen(false), []);
  const retrySend = useCallback(() => void handleSend(), [handleSend]);

  const handleContentSizeChange = useCallback(
    (event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>) => {
      setInputHeight(
        Math.max(
          MIN_INPUT_HEIGHT,
          Math.min(MAX_INPUT_HEIGHT, Math.ceil(event.nativeEvent.contentSize.height)),
        ),
      );
    },
    [],
  );

  const handleSelectionChange = useCallback(
    (event: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
      selectionRef.current = event.nativeEvent.selection;
      // The mention palette follows the caret: bump the tick so its memo
      // recomputes even when the text did not change (a tap that parked the
      // caret elsewhere must close/reopen it — and must never leave a stale
      // token range for the next pick to splice over).
      setCaretTick((tick) => tick + 1);
      // Functional form keeps this handler identity-stable (no dependency on
      // `forcedSelection`), and returning the current value lets React skip
      // the render when there is nothing to clear.
      setForcedSelection((current) => (current === null ? current : null));
    },
    [],
  );

  // -- render --------------------------------------------------------------
  const sendDisabled =
    sending ||
    isViewOnly ||
    isOffline ||
    (value.trim().length === 0 && staged.length === 0);

  const attachDisabled = isViewOnly || isOffline;

  return (
    <View style={styles.root} testID={testID}>
      {isViewOnly ? (
        <ViewOnlyNotice />
      ) : (
        <>
          {replyTo ? (
            <View
              style={styles.replyBar}
              accessibilityLabel={`Replying to ${replyAuthorName}`}
              testID="reply-bar"
            >
              <View style={styles.replyText}>
                <Text style={styles.replyTitle} numberOfLines={1}>
                  Replying to {replyAuthorName}
                </Text>
                <Text style={styles.replyPreview} numberOfLines={1} testID="reply-bar-preview">
                  {replyTo.preview}
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Cancel reply"
                onPress={onCancelReply}
                testID="reply-bar-cancel"
                style={({ pressed }) => [styles.barButton, pressed ? styles.pressed : null]}
              >
                <Text style={styles.barButtonText}>✕</Text>
              </Pressable>
            </View>
          ) : null}

          {suggestionsOpen ? (
            <EmojiSuggestions
              query={emojiQuery ?? ''}
              matches={emojiMatches}
              activeIndex={emojiClamped}
              onAccept={acceptEmoji}
            />
          ) : null}

          <AttachmentTray items={staged} onRemove={removeStaged} onRetry={retryStaged} />

          {sendError === null ? null : (
            <View style={styles.errorRow} role="alert" accessibilityRole="alert">
              <Text style={styles.errorText} testID="composer-error">
                {sendError}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Retry sending"
                onPress={retrySend}
                testID="composer-error-retry"
                style={({ pressed }) => [styles.barButton, pressed ? styles.pressed : null]}
              >
                <Text style={styles.barButtonText}>Retry</Text>
              </Pressable>
            </View>
          )}

          {attachMenuOpen ? (
            <View style={styles.menu} accessibilityLabel="Add to message" testID="composer-attach-menu">
              {(
                [
                  ['Photo Library', pickImageLibrary, 'composer-attach-library'],
                  ['Take Photo', pickCamera, 'composer-attach-camera'],
                  ['Choose File', pickFiles, 'composer-attach-file'],
                ] as const
              ).map(([label, pick, id]) => (
                <Pressable
                  key={label}
                  accessibilityRole="button"
                  accessibilityLabel={label}
                  disabled={attachDisabled}
                  onPress={() => runPicker(pick)}
                  testID={id}
                  style={({ pressed }) => [styles.menuItem, pressed ? styles.pressed : null]}
                >
                  <Text style={styles.menuItemText}>{label}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}

          {mentionCandidates.length > 0 ? (
            <View style={styles.mentionPanel} testID="composer-mention-panel">
              {mentionCandidates.map((member) => {
                const label = displayNameOf(member, member.id);
                return (
                  <Pressable
                    key={member.id}
                    accessibilityRole="button"
                    accessibilityLabel={`Mention ${label}`}
                    onPress={() => pickMention(member)}
                    style={styles.mentionRow}
                    testID={`composer-mention-${member.id}`}
                  >
                    <Text style={styles.mentionRowText}>{`@${label}`}</Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}

          {emojiPanelOpen ? (
            <EmojiPicker
              onPick={insertEmoji}
              onClose={closeEmojiPanel}
              preferences={activePreferences}
            />
          ) : null}

          <View
            style={[styles.row, { paddingBottom: Math.max(insets.bottom, theme.spacing.sm) }]}
          >
            <IconButton
              label="Add to message"
              onPress={toggleAttachMenu}
              disabled={attachDisabled}
              selected={attachMenuOpen}
              expanded={attachMenuOpen}
              testID="composer-attach"
            >
              ＋
            </IconButton>

            <TextInput
              ref={inputRef}
              value={value}
              onChangeText={handleChangeText}
              onKeyPress={handleKeyPress}
              onSubmitEditing={handleSubmitEditing}
              submitBehavior="submit"
              onContentSizeChange={handleContentSizeChange}
              onSelectionChange={handleSelectionChange}
              {...(forcedSelection === null ? {} : { selection: forcedSelection })}
              multiline
              scrollEnabled={inputHeight >= MAX_INPUT_HEIGHT}
              placeholder="Message"
              placeholderTextColor={theme.colors.textMuted}
              accessibilityLabel="Message"
              testID="composer-input"
              style={[styles.input, { height: inputHeight }]}
            />

            <IconButton
              label="Emoji"
              onPress={toggleEmojiPanel}
              selected={emojiPanelOpen}
              expanded={emojiPanelOpen}
              testID="composer-emoji"
            >
              🙂
            </IconButton>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send message"
              accessibilityState={{ disabled: sendDisabled, busy: sending }}
              disabled={sendDisabled}
              onPress={retrySend}
              testID="composer-send"
              style={({ pressed }) => [
                styles.send,
                sendDisabled ? styles.sendDisabled : null,
                pressed && !sendDisabled ? styles.pressed : null,
              ]}
            >
              {sending ? (
                <ActivityIndicator size="small" color={theme.colors.onAccent} />
              ) : (
                <Text style={styles.sendGlyph}>➤</Text>
              )}
            </Pressable>
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  mentionPanel: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    borderRadius: 8,
    backgroundColor: theme.colors.surfaceStrong,
    marginBottom: theme.spacing.xs,
    overflow: 'hidden',
  },
  mentionRow: {
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.md,
  },
  mentionRowText: {
    color: theme.colors.text,
    fontSize: theme.fontSizes.sm,
  },
  root: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceEmphasized,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: theme.spacing.xs,
    paddingHorizontal: theme.spacing.sm,
    paddingTop: theme.spacing.sm,
  },
  input: {
    flex: 1,
    minHeight: MIN_INPUT_HEIGHT,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: Platform.OS === 'ios' ? theme.spacing.md : theme.spacing.sm,
    borderRadius: theme.radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.inputBorder,
    backgroundColor: theme.colors.input,
    color: theme.colors.textPrimary,
    fontSize: theme.fontSizes.lg,
  },
  send: {
    minWidth: MIN_TOUCH_TARGET,
    minHeight: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radii.md,
    backgroundColor: theme.colors.accent,
  },
  sendDisabled: {
    opacity: 0.4,
  },
  sendGlyph: {
    color: theme.colors.onAccent,
    fontSize: theme.fontSizes.lg,
  },
  pressed: {
    backgroundColor: theme.colors.surfaceHover,
  },
  replyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.sm,
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.accent,
  },
  replyText: {
    flex: 1,
  },
  replyTitle: {
    color: theme.colors.textPrimary,
    fontSize: theme.fontSizes.sm,
    fontWeight: '600',
  },
  replyPreview: {
    color: theme.colors.textMuted,
    fontSize: theme.fontSizes.xs,
  },
  barButton: {
    minWidth: MIN_TOUCH_TARGET,
    minHeight: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.sm,
    borderRadius: theme.radii.md,
  },
  barButtonText: {
    color: theme.colors.text,
    fontSize: theme.fontSizes.md,
    fontWeight: '600',
  },
  suggestions: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceEmphasized,
    paddingVertical: theme.spacing.xs,
    maxHeight: 260,
  },
  suggestionsTitle: {
    color: theme.colors.textMuted,
    fontSize: theme.fontSizes.xs,
    fontWeight: '700',
    letterSpacing: 0.6,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.xs,
  },
  suggestionsEmpty: {
    color: theme.colors.textMuted,
    fontSize: theme.fontSizes.sm,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  suggestion: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
    minHeight: MIN_TOUCH_TARGET,
    paddingHorizontal: theme.spacing.md,
  },
  suggestionActive: {
    backgroundColor: theme.colors.surfaceSelected,
  },
  suggestionGlyph: {
    fontSize: theme.fontSizes.xl,
  },
  suggestionName: {
    color: theme.colors.text,
    fontSize: theme.fontSizes.md,
  },
  errorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.sm,
  },
  errorText: {
    flex: 1,
    color: theme.colors.danger,
    fontSize: theme.fontSizes.sm,
  },
  menu: {
    paddingHorizontal: theme.spacing.sm,
    paddingTop: theme.spacing.xs,
  },
  menuItem: {
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radii.md,
  },
  menuItemText: {
    color: theme.colors.textPrimary,
    fontSize: theme.fontSizes.md,
  },
});
