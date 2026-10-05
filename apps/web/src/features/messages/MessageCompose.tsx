/**
 * @cytale/web — message composer (U21 slice 1, bots plan U9).
 *
 * Lexical editor writing canonical CommonMark to the wire. Enter sends,
 * Shift+Enter inserts a newline. @mention nodes serialize as `<@snowflake>`
 * tokens. Per-channel persistent drafts (Slack-override kept). View-only
 * state for unverified accounts: disabled input + "verify your email to
 * post" banner + resend (driven by emailVerified from U19's auth slice);
 * ACCOUNT_UNVERIFIED from a send flips the banner.
 *
 * Composer command surface (U9): a "/" typed at compose-start opens the
 * slash autocomplete over the active workspace's commands (keyboard-driven —
 * arrows/enter/escape, focus never leaves the editor; aria-activedescendant
 * walks the listbox). Selecting a zero-option command invokes immediately;
 * a command with registered options enters an options-fill phase inline
 * beneath the composer (required options gate Run; Escape cancels back to
 * normal compose). Invocation posts /interactions and holds a bounded
 * pending affordance NEAR the composer (never an in-transcript placeholder);
 * a ~10s client timeout lands the named "no response" error with re-invoke
 * — the bot's response always arrives as a normal message through the
 * gateway, so there is nothing to clean up when it is late.
 *
 * Composer attachment affordance (U21 slice: Discord-style image posting):
 * a paperclip button opens the file picker (multi-select); picked files
 * upload immediately to the channel via the api-client (`POST /channels/
 * {id}/attachments`) and stage as removable chips above the input with an
 * in-flight indicator (errors render inline and never block sending — the
 * send just leaves them staged). Send binds the finished uploads' metadata
 * into the create-message body (`attachments`), so image-only sends (empty
 * text + chips) are valid. Enter waits out in-flight uploads rather than
 * silently dropping them.
 *
 * Optimistic send (2026-09-28): Enter clears the text, the tray and the reply
 * bar at once and the message is drawn in the list as a pending row; a
 * failure stays in the list as a failed row (Retry / Delete / Edit — see
 * SendStatus.tsx and `handleSend`), never back in this box on its own.
 */

import { memo, useCallback, useEffect, useId, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ChangeEvent } from 'react';

import { ATTACH_ACCEPT, isImageFile, namedPasteFile, uploadAllowed } from './uploadIntake.js';
import { AttachmentThumb } from './AttachmentThumb.js';

import { LexicalComposer } from '@lexical/react/LexicalComposer.js';
import { ContentEditable } from '@lexical/react/LexicalContentEditable.js';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin.js';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin.js';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary.js';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext.js';
import { mentionTagFor } from './mentionCandidates.js';
import {
  ChannelNameContext,
  MentionNameContext,
  type ChannelNameResolver,
  type MentionNameResolver,
} from './MentionNode.js';
import { channelNameOf } from './ChannelMentionPill.js';
import { COMPOSER_MD_CLASS, composerEditorConfig } from './editorConfig.js';
import { $exportComposerMarkdown, $importComposerMarkdown } from './composerMarkdown.js';
import { ComposerMarkdownPlugin } from './ComposerMarkdownPlugin.js';
import {
  $getRoot,
  $getSelection,
  $createParagraphNode,
  $isParagraphNode,
  $isRangeSelection,
  KEY_ENTER_COMMAND,
  KEY_TAB_COMMAND,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ESCAPE_COMMAND,
  BLUR_COMMAND,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_CRITICAL,
  type LexicalEditor,
} from 'lexical';
import type { ApplicationCommand, UploadedAttachment } from '@cytale/api-client';
import { defaultStore, type StateStore, nicknamesForChannel } from '@cytale/state';

import { ComposerBanner } from '../auth/ComposerBanner.js';
import { api, authStore } from '../auth/session.js';
import { TypingIndicator } from '../presence/TypingIndicator.js';
import { useTyping, useTypists, type UseTyping } from '../presence/useTyping.js';
import { useOnlineStatus } from '../../app/pwa/useOnlineStatus.js';
import { useStoreSelector } from '../../app/useStoreSelector.js';
import {
  CommandAutocomplete,
  CommandOptionsFill,
  filterCommands,
  useCommands,
  useInteraction,
  type UseCommands,
  type UseInteraction,
} from '../commands/index.js';
import { useMessageSender, type UseMessages } from './useMessages.js';
import { EmojiPickerPanel } from './EmojiPickerPanel.js';
import { paletteStep, useEditorPalettes } from './EditorPalettes.js';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/shadcn/popover.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/shadcn/dropdown-menu.js';
import { bumpFrecentEmoji } from './emojiCatalog.js';
import { readDraft as readStoredDraft, writeDraft as writeStoredDraft } from './draftStorage.js';
import { displayNameOf } from '@cytale/domain';

// Drafts are stored per signed-in member + conversation scope (see
// draftStorage.ts). The scope is the conversation the draft belongs to, not
// merely its channel: the channel composer uses the channel id, a thread
// composer `<channel>.t.<thread>` (or `<channel>.p.<seed>` for a thread not
// created yet — see `threadDraftScope`). One key per channel used to be
// shared by both, so a reply typed in a thread overwrote the channel's unsent
// message and reappeared in the channel composer.

/**
 * The draft scope of a thread composer. A draft thread (no id yet) is keyed by
 * the seed message it will hang off, so reopening "Start thread" on the same
 * message brings the unsent reply back.
 */
export function threadDraftScope(
  channelId: string,
  threadId: string | null,
  parentMessageId?: string | null,
): string {
  if (threadId !== null) return `${channelId}.t.${threadId}`;
  return `${channelId}.p.${parentMessageId ?? 'new'}`;
}

/** The signed-in member's id at call time (drafts are per member). */
function currentUserId(): string | null {
  const state = authStore.getState();
  return state.status === 'authenticated' ? (state.currentUser?.id ?? null) : null;
}

function readDraft(scope: string): string {
  return readStoredDraft(currentUserId(), scope);
}

function writeDraft(scope: string, content: string): void {
  writeStoredDraft(currentUserId(), scope, content);
}

function subscribeAuth(cb: () => void): () => void {
  return authStore.subscribe(cb);
}
function getAuthSnapshot() {
  return authStore.getState();
}

/** A clipboard data-URL image (base64 inline) as a File, for the staging tray. */
function dataUrlToFile(dataUrl: string, name: string): File {
  const comma = dataUrl.indexOf(',');
  const meta = dataUrl.slice(0, comma);
  const b64 = dataUrl.slice(comma + 1);
  const mime = /data:([^;]+)/.exec(meta)?.[1] ?? 'image/png';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name, { type: mime });
}

/** One staged attachment chip: an upload in one of three states. */
interface StagedAttachment {
  /** Stable chip identity (a file may be picked twice). */
  key: string;
  filename: string;
  sizeBytes: number;
  status: 'uploading' | 'done' | 'error';
  /** Upload result once `done` — bound into the send body. */
  attachment?: UploadedAttachment;
  /** Inline error text once `error`. */
  error?: string;
  /** The source file while staged — drives the inline image thumbnail
   *  (#56) and dies with the chip. */
  file?: File;
}

/**
 * A descriptor is sendable only when it names where the bytes live (#136):
 * an empty object — or an envelope the transport handed back whole — is
 * truthy but carries nothing any reader can render, so binding it would put
 * `attachments:[{}]` on the wire and store a phantom attachment stub.
 * Truthiness alone is not the test; a url is.
 */
function usableAttachment(a: UploadedAttachment | undefined): a is UploadedAttachment {
  return typeof a?.url === 'string' && a.url.length > 0;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Imperative intake seam for non-picker paths (drag-drop, clipboard paste):
 * the pane-level drop zones hold a ref and hand files straight to the same
 * staging the picker uses. (React 19: ref rides as a plain prop.)
 */
export interface ComposerHandle {
  startUploads(files: File[]): void;
  /**
   * A failed send's Edit (SendStatus.tsx): put its text and attachments back
   * into the composer — ONLY when the composer is empty (no text, no staged
   * chips). Returns false and changes nothing otherwise: the member has moved
   * on to the next message, and overwriting it is the one outcome worse than
   * the failure. Never called automatically — see `handleSend`.
   */
  restoreDraft(draft: { content: string; attachments: UploadedAttachment[] }): boolean;
  /** Put the caret back in the message line. */
  focus(): void;
}

export interface ReplyTarget {
  messageId: string;
  authorId: string;
  authorName: string;
  snippet: string;
  /** Discord semantics: ping ON by default; Shift+click starts suppressed. */
  ping: boolean;
}

export interface MessageComposeProps {
  /** Imperative upload seam (drag-drop / paste hosts hold this). */
  ref?: React.Ref<ComposerHandle>;
  channelId: string;
  /** Active channel display name for the placeholder; falls back to raw id. */
  channelName?: string;
  /** DM flavor: the placeholder reads "Message @name" instead of "#name". */
  isDm?: boolean;
  /**
   * Thread flavor: the placeholder reads "Reply in thread". Discord puts the
   * thread's NAME there in quotes, which works because its names are titles;
   * ours are the seed message's own words, so echoing the name read as the
   * message content sitting in the compose box (user report 2026-09-13).
   * Explicit rather than derived from `threadId`, because a DRAFT thread has
   * no id yet and is still a thread composer.
   */
  isThread?: boolean;
  /** Active inline-reply target; renders the reply bar until sent/cancelled. */
  replyTo?: ReplyTarget | null;
  /** Clears the reply target (X / Escape). */
  onCancelReply?: () => void;
  /** Toggles the reply ping (the @ chip in the bar). */
  onTogglePing?: () => void;
  /** Optional thread scope; null = channel message. */
  threadId?: string | null;
  /**
   * The draft's storage scope (see `draftKey`). Defaults to the channel id —
   * the channel composer; ThreadCompose passes `threadDraftScope(...)` so a
   * thread's unsent reply never shares the channel's slot.
   */
  draftScope?: string;
  /**
   * A previous draft scope this one CONTINUES (2026-10-01): when the scope
   * changes from exactly this one, the conversation was renamed, not left —
   * a draft thread became its created thread — so the editor keeps what is
   * in it and the saved text moves to the new key instead of the box being
   * reloaded (cleared) from it.
   */
  carryDraftFrom?: string;
  /** Override the messages hook (tests). */
  messages?: UseMessages;
  /**
   * Active workspace id for the slash-command palette. When omitted it is
   * derived from the store's channel map (channels carry workspace_id).
   */
  workspaceId?: string | null;
  /** Override the commands hook (tests). */
  commands?: UseCommands;
  /** Override the interaction hook (tests). */
  interaction?: UseInteraction;
  /** U17 store (injectable for tests; defaults to the module store). */
  store?: StateStore;
  /** Test seam: exposes the Lexical editor once mounted (jsdom can't drive
   *  Lexical text input, so tests set content + dispatch commands directly). */
  onEditorReady?: (editor: LexicalEditor) => void;
  /** Override the typing hook (tests). Live sessions use the default. */
  typing?: UseTyping;
}

/**
 * The typing line, subscribed to THIS channel(:thread)'s typists on its own
 * (lane D #17). The composer used to read the typists in its own body, so
 * every TypingStart re-rendered the whole Lexical composer; now a typing event
 * re-renders this line and nothing else. Rendered only while someone types,
 * so a quiet channel reserves no gap above the well (owner direction
 * 2026-09-14).
 */
function TypingLine({
  typing,
  channelId,
  threadId,
  displayName,
}: {
  typing: UseTyping;
  channelId: string;
  threadId: string | null;
  displayName: (userId: string) => string;
}) {
  const typists = useTypists(typing, channelId, threadId);
  if (typists.length === 0) return null;
  return (
    <div className="typing-line" data-testid="typing-line">
      <TypingIndicator typists={typists} displayName={displayName} />
    </div>
  );
}

/**
 * Emits a typing signal whenever the composer's content changes.
 *
 * Per keystroke is fine: `GatewayClient.sendTyping` throttles to one signal
 * per channel/thread per TYPING_THROTTLE_MS, so the emission half stays a
 * single owner (the gateway client) and this plugin only reports "the author
 * touched the box". Non-empty only — clearing an empty box is not typing, and
 * a draft restore should not announce itself as one.
 */
function TypingEmitPlugin({ onType }: { onType: () => void }) {
  const [editor] = useLexicalComposerContext();

  useEffect(
    () =>
      editor.registerUpdateListener(() => {
        const hasText = editor
          .getEditorState()
          .read(() => $getRoot().getTextContent().length > 0);
        if (hasText) onType();
      }),
    [editor, onType],
  );

  return null;
}

/**
 * Intercepts Enter (send) vs Shift+Enter (newline). Calls `onSend` with the
 * current markdown; returns true to prevent default when sending.
 */
function EnterSendPlugin({ onSend }: { onSend: (markdown: string) => void }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event: KeyboardEvent | null) => {
        if (event?.shiftKey) return false; // Shift+Enter = newline
        event?.preventDefault();
        editor.update(() => {
          const markdown = $exportComposerMarkdown();
          onSend(markdown);
        });
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, onSend]);

  return null;
}

/**
 * E2E-only bridge (e2e builds only — see the `__CYTALE_E2E__` define in
 * apps/web/vite.config.ts): exposes the composer's editor
 * state and send path to the in-shell driver (apps/web/src/e2e/driver.ts).
 * The gate is a build-time literal, so Rollup drops this component — and its
 * render site — from real bundles.
 */
function E2EBridgePlugin({ onSend }: { onSend: (markdown: string) => void }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    (window as unknown as { __cytaleE2E?: unknown }).__cytaleE2E = {
      text: () => editor.getEditorState().read(() => $getRoot().getTextContent()),
      send: () =>
        editor.update(() => {
          onSend($exportComposerMarkdown());
        }),
    };
    return () => {
      delete (window as unknown as { __cytaleE2E?: unknown }).__cytaleE2E;
    };
  }, [editor, onSend]);

  return null;
}

/**
 * Slash-command trigger + keyboard interception (U9). Watches the editor's
 * text: "/" at compose-start (single line, no spaces) reports the filter
 * query upward; anything else closes. While the palette is open, arrows /
 * Enter / Escape are consumed at CRITICAL priority — above EnterSendPlugin —
 * so Enter selects instead of sending. Consumed keys stop native propagation
 * so outer handlers (e.g. the reply bar's Escape) don't double-fire.
 */
interface SlashHandlers {
  isActive(): boolean;
  onText(query: string | null): void;
  onArrowUp(): void;
  onArrowDown(): void;
  /** True when the palette acted (the key is consumed); false to decline so
   *  Enter falls through and sends — the no-autoselect rule every palette in
   *  this composer follows (owner, 2026-09-18: "don't autoselect; wait for
   *  the user to hit tab"). */
  onEnter(): boolean;
  /** The completion key: the highlighted row, else the top match. */
  onTab(): void;
  onEscape(): void;
}

function slashQueryOf(text: string): string | null {
  if (!text.startsWith('/')) return null;
  if (text.includes('\n') || text.includes(' ')) return null;
  return text.slice(1);
}

function SlashCommandPlugin({
  enabled,
  handlers,
}: {
  enabled: boolean;
  handlers: SlashHandlers;
}) {
  const [editor] = useLexicalComposerContext();
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    return editor.registerUpdateListener(() => {
      if (!enabledRef.current) {
        handlersRef.current.onText(null);
        return;
      }
      const text = editor.getEditorState().read(() => $getRoot().getTextContent());
      handlersRef.current.onText(slashQueryOf(text));
    });
  }, [editor]);

  useEffect(() => {
    const armed = () => enabledRef.current && handlersRef.current.isActive();
    const consume = (e: KeyboardEvent | null): void => {
      e?.preventDefault();
      e?.stopPropagation();
    };
    const disposers = [
      editor.registerCommand(
        KEY_ARROW_DOWN_COMMAND,
        (e) => {
          if (!armed()) return false;
          consume(e);
          handlersRef.current.onArrowDown();
          return true;
        },
        COMMAND_PRIORITY_CRITICAL,
      ),
      editor.registerCommand(
        KEY_ARROW_UP_COMMAND,
        (e) => {
          if (!armed()) return false;
          consume(e);
          handlersRef.current.onArrowUp();
          return true;
        },
        COMMAND_PRIORITY_CRITICAL,
      ),
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (e) => {
          if (!armed()) return false;
          // Only a palette that ACTS may take Enter; with nothing
          // highlighted the key declines and the message sends as typed.
          if (!handlersRef.current.onEnter()) return false;
          consume(e);
          return true;
        },
        COMMAND_PRIORITY_CRITICAL,
      ),
      // Tab is the completion key and never needs a highlight first (the
      // highlighted row if there is one, else the top match).
      editor.registerCommand(
        KEY_TAB_COMMAND,
        (e) => {
          if (!armed()) return false;
          consume(e);
          handlersRef.current.onTab();
          return true;
        },
        COMMAND_PRIORITY_CRITICAL,
      ),
      editor.registerCommand(
        KEY_ESCAPE_COMMAND,
        (e) => {
          if (!armed()) return false;
          consume(e);
          handlersRef.current.onEscape();
          return true;
        },
        COMMAND_PRIORITY_CRITICAL,
      ),
    ];
    return () => disposers.forEach((d) => d());
  }, [editor]);

  return null;
}

/** Bridges the Lexical editor instance to a ref for draft load/clear. */
function EditorRefPlugin({ onReady }: { onReady: (editor: LexicalEditor) => void }) {  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    onReady(editor);
  }, [editor, onReady]);
  return null;
}

/**
 * Persists the editor's markdown to localStorage, DEBOUNCED (hardening plan
 * 7.5).
 *
 * The old plugin serialized the whole document and wrote localStorage on
 * EVERY update — i.e. every keystroke paid a synchronous storage write of
 * the full markdown. A ~300ms debounce collapses a typing burst into one
 * write.
 *
 * The flush reads the CURRENT editor state rather than a value captured when
 * the timer was armed, so a pending timer can never resurrect text a later
 * `.clear()` (send / command invoke) already removed.
 *
 * Flush points: BLUR and unmount. Blur covers tabbing/clicking out of the
 * composer; unmount covers a channel switch, a pane teardown and a tab close
 * — the case a debounce-only implementation loses, because the last <300ms
 * of typing never reaches storage.
 */
const DRAFT_DEBOUNCE_MS = 300;

/** Persists the editor's markdown to localStorage, debounced with flushes. */
function DraftPlugin({ scope }: { scope: string }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const persist = () => {
      editor.getEditorState().read(() => {
        const markdown = $exportComposerMarkdown();
        writeDraft(scope, markdown);
      });
    };
    const cancel = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const flush = () => {
      cancel();
      persist();
    };
    const schedule = () => {
      cancel();
      timer = setTimeout(() => {
        timer = null;
        persist();
      }, DRAFT_DEBOUNCE_MS);
    };

    const unregisterUpdate = editor.registerUpdateListener(schedule);
    const unregisterBlur = editor.registerCommand(
      BLUR_COMMAND,
      () => {
        flush();
        // Not consumed (returns false): a blur may have other listeners to
        // reach. HIGH priority so no listener above can consume the command
        // and skip the flush.
        return false;
      },
      COMMAND_PRIORITY_HIGH,
    );

    // A REAL page close (tab close, navigation away, mobile backgrounding) does
    // NOT run React's effect cleanup, so unmount alone cannot save the last
    // burst: `pagehide` is the event the browser guarantees on that path, and it
    // is the only one that fires reliably in both the web and the Tauri shell.
    // (`beforeunload` is not used — it is blocked by bfcache-friendly engines and
    // would ship an unload dialog we do not want.)
    const onPageHide = () => flush();
    window.addEventListener('pagehide', onPageHide);

    return () => {
      // Flush BEFORE unregistering: the trailing keystrokes must land even
      // though this effect is being torn down.
      flush();
      window.removeEventListener('pagehide', onPageHide);
      unregisterUpdate();
      unregisterBlur();
    };
  }, [editor, scope]);
  return null;
}

function MessageComposeImpl({
  ref: composeRef,
  channelId,
  channelName,
  isDm = false,
  isThread = false,
  replyTo = null,
  onCancelReply,
  onTogglePing,
  threadId = null,
  draftScope: draftScopeProp,
  carryDraftFrom,
  messages,
  workspaceId,
  commands,
  interaction,
  store,
  onEditorReady,
  typing,
}: MessageComposeProps) {
  const effectiveStore = store ?? defaultStore;
  const draftScope = draftScopeProp ?? channelId;
  /**
   * The fallback send seam (#137, app-level finding 6).
   *
   * This used to be `useMessages()`, whose whole-store subscription made the
   * always-mounted Lexical composer re-render on every gateway event in the
   * app — while the ONLY thing read off it here is `send` (both real hosts,
   * MessagePane and ThreadCompose, pass their own `messages` hook, so the
   * hook's `messages()` read was dead). `useMessageSender` is the same send
   * path with no subscription at all: `send` resolves the store with
   * `getState()` when it is called, so nothing it does needs a re-render.
   */
  const fallbackSender = useMessageSender(effectiveStore);
  const send = (messages ?? fallbackSender).send;
  // Typing (U23): mount the display half and emit the signal from the same
  // surface, so the composer is the ONE owner of both. `useTyping()` binds to
  // the live session gateway (a no-op when disconnected); tests inject one.
  const liveTyping = useTyping();
  const typingClient = typing ?? liveTyping;
  const emitTyping = useCallback(() => {
    typingClient.sendTyping(channelId, threadId ?? null);
  }, [typingClient, channelId, threadId]);
  const typistName = useCallback(
    (userId: string) => {
      const st = effectiveStore.getState();
      const member = st.membersById[userId];
      if (member) {
        return displayNameOf({ ...member, nickname: nicknamesForChannel(st, channelId)?.[userId] ?? null });
      }
      const self = st.currentUser;
      if (self && self.id === userId) return self.username;
      return userId;
    },
    [effectiveStore],
  );
  const online = useOnlineStatus();
  const authState = useSyncExternalStore(subscribeAuth, getAuthSnapshot, getAuthSnapshot);
  const emailVerified = authState.emailVerified;
  const [error, setError] = useState<string | null>(null);
  /**
   * The send announcer (a polite live region): "Sending…" when Enter hands a
   * message to the queue, "Sent" when it is confirmed. A failure is announced
   * by the failed row itself (its reason line is an alert), wherever the
   * retry came from.
   */
  const [sendAnnouncement, setSendAnnouncement] = useState('');
  const [showVerifyBanner, setShowVerifyBanner] = useState(!emailVerified);
  const [forceVerifyBanner, setForceVerifyBanner] = useState(false);
  const editorRef = useRef<LexicalEditor | null>(null);
  // `editorRef` is filled by a CHILD effect, so anything that needs the editor
  // must depend on readiness too — a ref alone never re-renders, and a first
  // pass that reads it would silently skip the work (the mention auto-insert
  // learned this the hard way).
  const [editorReady, setEditorReady] = useState(false);
  /**
   * Synchronous hold while an Enter waits out in-flight UPLOADS: a second
   * Enter in that window is the same message, not a new one. The ordinary send never holds it — the
   * composer is cleared before any network work, so a repeated Enter finds an
   * empty box and the next message is free to go.
   */
  const sendingRef = useRef(false);

  // -- attachment staging (paperclip → upload → chips → send body) --------
  const [staged, setStaged] = useState<StagedAttachment[]>([]);
  // Synchronous mirror so async upload completions and the send path read
  // fresh chips without waiting on a render.
  const stagedRef = useRef<StagedAttachment[]>([]);
  const uploadKeySeq = useRef(0);
  /** key → in-flight upload promise; Enter waits these out before sending. */
  const inFlightUploads = useRef(new Map<string, Promise<void>>());
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const updateStaged = useCallback((next: StagedAttachment[]) => {
    stagedRef.current = next;
    setStaged(next);
  }, []);

  const removeStaged = useCallback(
    (key: string) => {
      inFlightUploads.current.delete(key);
      updateStaged(stagedRef.current.filter((chip) => chip.key !== key));
    },
    [updateStaged],
  );

  const startUpload = useCallback(
    (file: File) => {
      const key = `staged-${++uploadKeySeq.current}`;
      updateStaged([
        ...stagedRef.current,
        { key, filename: file.name, sizeBytes: file.size, status: 'uploading', file },
      ]);
      const promise = (async () => {
        try {
          const uploaded = await api.uploadChannelAttachment(channelId, file);
          // #136 producer gate: a 201 whose body carries no usable descriptor
          // fails the chip HERE — a truthy-but-empty object marked done below
          // would ride every later send as `attachments:[{}]`, which the
          // server then stores as a phantom attachment stub.
          if (!usableAttachment(uploaded)) {
            throw new Error('The upload answered without an attachment — try again.');
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
                ? {
                    ...chip,
                    status: 'error',
                    error: err instanceof Error ? err.message : String(err),
                  }
                : chip,
            ),
          );
        } finally {
          inFlightUploads.current.delete(key);
        }
      })();
      inFlightUploads.current.set(key, promise);
    },
    [channelId, updateStaged],
  );

  const onFilesPicked = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      e.target.value = ''; // allow re-picking the same file later
      for (const file of files) startUpload(file);
    },
    [startUpload],
  );

  /**
   * Shared intake for the non-picker paths (pane drop zones, composer
   * paste). Prefilters against the server allowlist — a disallowed file
   * stages an error chip immediately, no upload attempt — and no-ops the
   * whole gesture while gated (offline/unverified), matching the ＋ menu's
   * picker gating.
   */
  const startUploads = useCallback(
    (files: File[]) => {
      if (!online || !emailVerified) return;
      for (const file of files) {
        if (uploadAllowed(file)) {
          startUpload(file);
        } else {
          updateStaged([
            ...stagedRef.current,
            {
              key: `staged-${++uploadKeySeq.current}`,
              filename: file.name || 'file',
              sizeBytes: file.size,
              status: 'error',
              error: 'File type not allowed.',
              file,
            },
          ]);
        }
      }
    },
    [online, emailVerified, startUpload, updateStaged],
  );

  // React 19 ref-as-prop: expose the intake seam to the pane-level drop
  // zones. useImperativeHandle also nulls the handle on unmount.
  const restoreDraft = useCallback(
    (draft: { content: string; attachments: UploadedAttachment[] }): boolean => {
      const editor = editorRef.current;
      if (!editor) return false;
      const occupied =
        stagedRef.current.length > 0 ||
        editor.getEditorState().read(() => $getRoot().getTextContent().trim().length > 0);
      if (occupied) return false;
      editor.update(() => {
        $importComposerMarkdown(draft.content);
        $getRoot().selectEnd();
      });
      if (draft.attachments.length > 0) {
        updateStaged(
          draft.attachments.map((attachment) => ({
            key: `staged-${++uploadKeySeq.current}`,
            filename: attachment.filename,
            sizeBytes: attachment.size,
            status: 'done' as const,
            attachment,
          })),
        );
      }
      editor.focus();
      return true;
    },
    [updateStaged],
  );

  useImperativeHandle(
    composeRef,
    () => ({ startUploads, restoreDraft, focus: () => editorRef.current?.focus() }),
    [startUploads, restoreDraft],
  );

    /** Clipboard paste on the well: files (screenshots!) stage as uploads and
   *  never reach the editor as text or lost content. The FILE-LESS image
   *  paste stages too: macOS screenshot tools put `<img src="data:…">` on
   *  the clipboard as HTML with NO file entry, and letting that paste run
   *  natively inserted the image into the message line at natural size —
   *  uncontained, unserializable, and a silent dead Enter afterwards (owner
   *  report 2026-09-16). The data URL becomes a File and rides the same
   *  staging as every other image. */
  const onPasteFiles = useCallback(
    (e: React.ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length > 0) {
        e.preventDefault();
        const seq = Date.now();
        startUploads(files.map((f, i) => namedPasteFile(f, seq + i)));
        return;
      }

      const html = e.clipboardData?.getData('text/html') ?? '';
      if (!/<img\s/i.test(html)) return;

      const srcs = [...html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)]
        .map((m) => m[1]!)
        .filter((src) => src.startsWith('data:image/'));

      if (srcs.length > 0) {
        e.preventDefault();
        const seq = Date.now();
        startUploads(srcs.map((src, i) => dataUrlToFile(src, `pasted-image-${seq + i}.png`)));
      }
    },
    [startUploads],
  );

  // The emoji PICKER panel (the button beside the editor). The `:shortcode:`
  // palette lives in the shared editor palettes bundle (EditorPalettes).
  const [emojiPanelOpen, setEmojiPanelOpen] = useState(false);

  // Picker-panel insert: at the caret (or end of the last paragraph).
  const insertEmojiAtCaret = useCallback((emoji: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.update(() => {
      const selection = $getSelection();
      if (selection && $isRangeSelection(selection)) {
        selection.insertText(emoji);
        return;
      }
      const para = $getRoot().getLastChild();
      if (para && $isParagraphNode(para)) para.selectEnd().insertText(emoji);
    });
    bumpFrecentEmoji(emoji);
  }, []);

  // -- ＋ actions popover (app-based actions; upload for now) --------------
  // A Radix DropdownMenu like every menu in the app (UI consistency,
  // 2026-09-27): arrow keys, focus into the menu, Escape back to ＋.
  const [plusOpen, setPlusOpen] = useState(false);

  // -- slash-command surface state (U9) ----------------------------------
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [slashQuery, setSlashQuery] = useState('');
  // -1 = nothing highlighted (the no-autoselect rule; see paletteStep).
  const [activeIndex, setActiveIndex] = useState(-1);
  const [fillCommand, setFillCommand] = useState<ApplicationCommand | null>(null);
  const [fillValues, setFillValues] = useState<Record<string, string>>({});

  // Workspace scoping: explicit prop wins; otherwise derive from the store's
  // channel map (DM channels carry no workspace → no palette).
  // Stable subscription (lane D #17): the inline `(cb) => subscribe(cb)`
  // resubscribed on every composer render.
  const channelWorkspaceId = useStoreSelector(
    effectiveStore,
    (s) => s.channels[channelId]?.workspace_id ?? null,
  );
  const activeWorkspaceId = workspaceId ?? channelWorkspaceId;

  const defaultCommands = useCommands(activeWorkspaceId);
  const cmds = commands ?? defaultCommands;
  const defaultInteraction = useInteraction(effectiveStore);
  const inter = interaction ?? defaultInteraction;

  const ariaId = useId();
  const listboxId = `${ariaId}-commands-listbox`;
  const optionId = useCallback((i: number) => `${ariaId}-command-opt-${i}`, [ariaId]);

  const matches = useMemo(
    () =>
      cmds.state.status === 'ready'
        ? filterCommands(cmds.state.commands, slashQuery)
        : [],
    [cmds.state, slashQuery],
  );
  const clampedActive = Math.min(activeIndex, Math.max(matches.length - 1, 0));
  // The command the user pointed at (arrows); undefined while nothing is.
  const slashHighlighted = activeIndex >= 0 ? matches[clampedActive] : undefined;
  // The dismissed latch: Escape (or a no-match Enter) closes the palette for
  // as long as the text stays slash-shaped; leaving slash shape resets it.
  const showAutocomplete = slashOpen && !slashDismissed && !fillCommand;
  const activeOptionId =
    showAutocomplete && slashHighlighted ? optionId(clampedActive) : undefined;

  // The `@` / `#` / `:shortcode:` palettes — ONE bundle shared with the
  // inline editor (EditorPalettes.tsx). The slash palette and its fill form
  // own the line while open, so the bundle stands down for them.
  const editorPalettes = useEditorPalettes({
    editorRef,
    store: effectiveStore,
    workspaceId: activeWorkspaceId,
    enabled: emailVerified,
    suppressed: slashOpen || fillCommand !== null,
    idPrefix: ariaId,
  });

  // Roster-backed TAGS for the pills (rename-safe: resolved at render, never
  // stored on the node). The pill shows `@username`, not the display name
  // the palette lists (owner, 2026-09-27).
  const mentionResolver = useMemo<MentionNameResolver>(
    () => (userId: string) => mentionTagFor(effectiveStore, userId),
    [effectiveStore],
  );
  const channelResolver = useMemo<ChannelNameResolver>(
    () => (channelId: string) => channelNameOf(effectiveStore, channelId),
    [effectiveStore],
  );

  // Load the workspace's command roster when the palette opens (debounced
  // inside the hook); suppressed offline and in the view-only state.
  const loadCommands = cmds.load;
  useEffect(() => {
    if (slashOpen && online && emailVerified) loadCommands();
  }, [slashOpen, online, emailVerified, loadCommands]);

  // Load the persisted draft into the editor on mount / scope change. On a
  // CHANGE of scope (one thread to another in the same panel) an empty draft
  // clears the editor too: the previous scope's text has already been flushed
  // to its own key by DraftPlugin's cleanup (passive cleanups all run before
  // any setup), and leaving it on screen would save it under the new key.
  const loadedScopeRef = useRef<string | null>(null);
  useEffect(() => {
    const previous = loadedScopeRef.current;
    const changed = previous !== null && previous !== draftScope;
    loadedScopeRef.current = draftScope;
    if (changed && carryDraftFrom !== undefined && previous === carryDraftFrom) {
      // Same conversation, new key: DraftPlugin's cleanup already flushed the
      // box to the old key; move it, and leave the editor (and caret) alone.
      const carried = readDraft(previous);
      if (carried && !readDraft(draftScope)) writeDraft(draftScope, carried);
      writeDraft(previous, '');
      return;
    }
    const draft = readDraft(draftScope);
    if ((draft || changed) && editorRef.current) {
      const editor = editorRef.current;
      editor.update(() => {
        $importComposerMarkdown(draft);
      });
    }
    // `carryDraftFrom` is read at the scope change only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftScope]);

  // A reply target (hover ↩) means the user's next act is typing — focus
  // the editor so the caret is already in the message line. Runs per
  // click (each startReply creates a fresh target object).
  useEffect(() => {
    if (replyTo) editorRef.current?.focus();
  }, [replyTo]);

  // Staged chips are channel-scoped (uploads bind to the channel they rode):
  // switching channels drops the tray rather than leaking it across targets.
  useEffect(() => {
    updateStaged([]);
    inFlightUploads.current.clear();
  }, [channelId, updateStaged]);

  const clearComposer = useCallback(() => {
    editorRef.current?.update(() => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      root.append(paragraph);
      // RE-ANCHOR the caret. Clearing the root leaves the selection pointing
      // at the removed content, so the next keystroke inserts as a NEW
      // paragraph and the fresh empty one stays behind — a single-line message
      // then renders two lines tall (reproduced: the well grew 58px → 80px when
      // typing straight after Enter, which keeps the caret in the editor; a
      // click first masked it by normalising the caret).
      paragraph.select();
    });
    writeDraft(draftScope, '');
  }, [draftScope]);

  /**
   * A send's failure, as the composer sees it. The message itself is not
   * the composer's any more — the failed row in the list holds it, with
   * Retry/Delete/Edit (SendStatus.tsx) — so all that is left here is the
   * account gate: an unverified account flips the verify banner.
   */
  const onSendFailed = useCallback((err: unknown) => {
    const key = err instanceof Error && 'key' in err ? (err as { key: string }).key : '';
    // 6.4 rename window: both spellings until no pre-rename bundle can be live.
    if (key === 'account_unverified' || key === 'ACCOUNT_UNVERIFIED') {
      setShowVerifyBanner(true);
      setForceVerifyBanner(true);
    }
  }, []);

  /**
   * Enter (optimistic send, 2026-09-28 — the Discord/Slack model).
   *
   * The composer is cleared FIRST — text, staged tray, reply bar — in the
   * same Lexical update as the Enter, before any network work; `send` then
   * draws the message in the list (a muted pending row) and queues the POST
   * behind this conversation's earlier sends. So the member can type and send
   * the next message at once, and a burst goes out in order.
   *
   * A failure does NOT refill the composer, even an empty one: the member may
   * already be typing the next message, and text jumping back into the box
   * under their fingers is the jarring case. The failed row keeps the message
   * (and its attachments and reply) with Retry — same nonce, never twice —
   * Delete, and Edit, which moves it back here only if the box is empty
   * (`restoreDraft`).
   *
   * The one wait left is an in-flight UPLOAD: its descriptor is not known
   * yet, and a row cannot draw an attachment it does not have. Enter holds
   * the composer until the uploads settle, then sends as above.
   */
  const handleSend = useCallback(
    (markdown: string) => {
      const trimmed = markdown.trim();
      if (sendingRef.current) return;
      setError(null);

      const commit = (): void => {
        const ready = stagedRef.current
          // #136: `chip.attachment` truthiness once let a descriptor-less
          // object ride the send; a done chip binds only with a usable
          // descriptor (the producer gate above should make this unreachable,
          // the filter is the second lock on the same door).
          .filter((chip) => chip.status === 'done' && usableAttachment(chip.attachment))
          .map((chip) => chip.attachment as UploadedAttachment);
        if (!trimmed && ready.length === 0) {
          // A dead Enter must SAY it is dead (owner report 2026-09-16: "when
          // sending the first time nothing happened"). Staged chips that are
          // still uploading (unlikely here — they were awaited) or FAILED,
          // and an image sitting in the message line that cannot serialize,
          // are the two ways an Enter lands on nothing. (An Enter on an EMPTY
          // box — a key repeat right after a send — stays silent.)
          const stagedChips = stagedRef.current.length;
          const imageInLine = editorRef.current?.getRootElement()?.querySelector('img') != null;
          if (stagedChips > 0) {
            setError('Attachments are not ready — wait for the upload or remove the failed one.');
          } else if (imageInLine) {
            setError('An image in the message line cannot be sent — attach it with ＋ or paste it again.');
          }
          return;
        }
        const content =
          replyTo && replyTo.ping ? `<@${replyTo.authorId}> ${trimmed}` : trimmed;
        const replyToId = replyTo?.messageId ?? null;
        const dispatch = (): Promise<void> =>
          ready.length > 0
            ? send(channelId, content, threadId, replyToId, ready)
            : send(channelId, content, threadId, replyToId);

        // Clear first — nothing below may wait on the network.
        clearComposer();
        updateStaged([]);
        onCancelReply?.();
        setSendAnnouncement('Sending…');
        let pending: Promise<void>;
        try {
          pending = dispatch();
        } catch (err) {
          pending = Promise.reject(err);
        }
        pending.then(
          () => setSendAnnouncement('Sent'),
          (err: unknown) => {
            setSendAnnouncement('');
            onSendFailed(err);
          },
        );
      };

      // Enter never silently drops a still-uploading chip: wait the in-flight
      // uploads out, then bind whatever finished (failed chips stay staged
      // and simply don't ride this send).
      if (inFlightUploads.current.size > 0) {
        sendingRef.current = true;
        void Promise.allSettled([...inFlightUploads.current.values()]).then(() => {
          sendingRef.current = false;
          commit();
        });
        return;
      }
      commit();
    },
    [
      channelId,
      threadId,
      send,
      replyTo,
      onCancelReply,
      clearComposer,
      updateStaged,
      onSendFailed,
    ],
  );

  // -- slash-command phase machine ---------------------------------------

  const handleSlashText = useCallback((query: string | null) => {
    if (query === null) {
      setSlashOpen(false);
      setSlashDismissed(false);
      setSlashQuery('');
      return;
    }
    setSlashQuery(query);
    setActiveIndex(-1);
    setSlashOpen(true);
  }, []);

  const selectCommand = useCallback(
    (command: ApplicationCommand) => {
      clearComposer();
      setSlashOpen(false);
      setSlashDismissed(false);
      setSlashQuery('');
      setActiveIndex(0);
      if ((command.options ?? []).length > 0) {
        setFillCommand(command);
        setFillValues({});
      } else if (online) {
        void inter.invoke(command, channelId, {});
      }
    },
    [clearComposer, inter, channelId, online],
  );

  const slashHandlers: SlashHandlers = useMemo(
    () => ({
      isActive: () => slashOpen && !fillCommand,
      onText: handleSlashText,
      onArrowUp: () => setActiveIndex((i) => paletteStep(i, matches.length, -1)),
      onArrowDown: () => setActiveIndex((i) => paletteStep(i, matches.length, 1)),
      // Enter runs ONLY a command the user pointed at; with nothing
      // highlighted it declines and the message sends the literal `/…` text
      // (the mention palette's rule, applied here by owner direction
      // 2026-09-19).
      onEnter: () => {
        if (!slashHighlighted) return false;
        selectCommand(slashHighlighted);
        return true;
      },
      onTab: () => {
        const pick = slashHighlighted ?? matches[0];
        if (pick) selectCommand(pick);
      },
      onEscape: () => {
        setSlashOpen(false);
        setSlashDismissed(true);
      },
    }),
    [slashOpen, fillCommand, handleSlashText, matches, slashHighlighted, selectCommand],
  );

  const submitFill = useCallback(() => {
    const command = fillCommand;
    if (!command || !online) return;
    const options: Record<string, unknown> = {};
    for (const option of command.options ?? []) {
      const value = fillValues[option.name]?.trim();
      if (value) options[option.name] = value;
    }
    setFillCommand(null);
    setFillValues({});
    void inter.invoke(command, channelId, options);
  }, [fillCommand, fillValues, inter, channelId, online]);

  const cancelFill = useCallback(() => {
    setFillCommand(null);
    setFillValues({});
  }, []);

  const onEditorReadyCb = useCallback(
    (editor: LexicalEditor) => {
      editorRef.current = editor;
      setEditorReady(true);
      onEditorReady?.(editor);
    },
    [onEditorReady],
  );

  const initialConfig = composerEditorConfig('cytale-composer');

  const interStatus = inter.status;

  return (
    <div
      // Owner direction 2026-09-14/15: the 8px SIDE inset is gone (the well
      // runs to the column's edges) but BOTH 12px gutters stay. The bottom one
      // puts the well's bottom edge on the same line as the user status card in
      // the next column over (4px region padding + 8px card margin). The top
      // one is the breathing room the timeline needs: it keeps the newest row
      // clear of the composer (owner report 2026-09-15 — rows were landing
      // flush against it, and a row that overshoots the settle was sliced by
      // the scroller edge with nothing to spare). Its size is the measured
      // contract in e2e/pane-layout.spec.ts (gap >= 12px), which is what the
      // removed typing band used to supply.
      // px-4: the same 16px gutter the message rows use, so the well lines up
      // with the text above it and never sits on the pane's edge (owner,
      // 2026-09-27: "smashed up against the border"). Both hosts, the channel
      // pane and the thread side panel, get it from here.
      className="relative px-4 pt-3 pb-3"
      data-testid="message-compose"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && replyTo) {
          e.preventDefault();
          e.stopPropagation();
          onCancelReply?.();
        }
      }}
    >
      {/* U23 typing line — FLOATING (issue #153, owner report 2026-09-25:
          "the typing indicator is popping up and down"). The in-flow render
          made the well step down while a typist is live; the line is now
          anchored ABOVE the well by .typing-line's absolute positioning
          (shell.css), overlapping the timeline's 12px breathing gap. Content
          never moves, nothing is reserved while the channel is quiet (the
          2026-09-14 direction holds), and the painted pill is opaque
          (--color-surface-strong) so the overlapped row edge stays legible. */}
      <TypingLine
        typing={typingClient}
        channelId={channelId}
        threadId={threadId ?? null}
        displayName={typistName}
      />
      {showVerifyBanner && <ComposerBanner force={forceVerifyBanner} />}
      {replyTo ? (
        <div className="reply-bar" data-testid="reply-bar" aria-label={`Replying to ${replyTo.authorName}`}>
          <span className="reply-bar-name" title={replyTo.authorName}>
            Replying to {replyTo.authorName}
          </span>
          <span className="reply-bar-snippet" data-testid="reply-bar-snippet">
            {replyTo.snippet}
          </span>
          <button
            type="button"
            className="reply-bar-ping"
            aria-pressed={replyTo.ping}
            data-testid="reply-bar-ping"
            title={replyTo.ping ? 'Pinging the author — click to silence' : 'Silent reply — click to ping'}
            onClick={onTogglePing}
          >
            @{replyTo.ping ? '' : '̶'}
          </button>
          <button
            type="button"
            className="reply-bar-cancel"
            aria-label="Cancel reply"
            data-testid="reply-bar-cancel"
            onClick={onCancelReply}
          >
            ✕
          </button>
        </div>
      ) : null}

      {/* Interaction affordance (pending / no-response / error) — NEAR the
          composer, never an in-transcript placeholder. */}
      {interStatus.kind === 'pending' ? (
        <div
          role="status"
          className="mb-2 flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-text-muted"
          data-testid="command-pending"
        >
          <span
            aria-hidden
            className="inline-block h-2 w-2 animate-pulse motion-reduce:animate-none rounded-full bg-accent"
          />
          Running /{interStatus.command.name}…
        </div>
      ) : interStatus.kind === 'no-response' ? (
        <div
          role="alert"
          className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/15 px-3 py-1.5 text-sm text-text"
          data-testid="command-no-response"
        >
          <span>
            No response from /{interStatus.command.name} yet — it may still be
            processing. If it arrives, it will appear as a normal message.
          </span>
          <button
            type="button"
            onClick={() => void inter.reinvoke()}
            className="rounded-md px-2 py-1 text-sm font-medium text-accent transition-colors duration-[var(--duration-control)] hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
            data-testid="command-reinvoke"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={inter.dismiss}
            className="rounded-md px-2 py-1 text-sm text-text-muted transition-colors duration-[var(--duration-control)] hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
            data-testid="command-dismiss"
          >
            Dismiss
          </button>
        </div>
      ) : interStatus.kind === 'error' ? (
        <div
          role="alert"
          className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-1.5 text-sm text-danger"
          data-testid="command-error"
        >
          <span data-testid="command-error-message">
            {interStatus.forbidden
              ? `You can't run /${interStatus.command.name} here.`
              : `Couldn't run /${interStatus.command.name}: ${interStatus.error}`}
          </span>
          <button
            type="button"
            onClick={() => void inter.reinvoke()}
            className="rounded-md px-2 py-1 text-sm font-medium text-accent transition-colors duration-[var(--duration-control)] hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
            data-testid="command-retry-invoke"
          >
            Retry
          </button>
          <button
            type="button"
            onClick={inter.dismiss}
            className="rounded-md px-2 py-1 text-sm text-text-muted transition-colors duration-[var(--duration-control)] hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
            data-testid="command-error-dismiss"
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {fillCommand ? (
        <div className="mb-2">
          <CommandOptionsFill
            command={fillCommand}
            values={fillValues}
            onChange={(name, value) =>
              setFillValues((v) => ({ ...v, [name]: value }))
            }
            onSubmit={submitFill}
            onCancel={cancelFill}
            disabled={!online || interStatus.kind === 'pending'}
          />
        </div>
      ) : null}

      {/* Owner direction 2026-09-14: the thin border stays, the gray FILL goes.
          The well's bg-input made the box read as a tall gray slab; with a
          transparent fill the same 1px outline marks the composer without it.
          The height still comes from --shell-composer-height so the bottom row
          keeps matching the identity panel above the sidebar. */}
      <div
        className="composer-well relative rounded-xl border border-input-line transition-colors duration-[var(--duration-control)] focus-within:border-accent"
        aria-disabled={!emailVerified}
        data-testid="composer-well"
        onPaste={onPasteFiles}
      >
        {showAutocomplete ? (
          <CommandAutocomplete
            state={cmds.state}
            matches={matches}
            query={slashQuery}
            activeIndex={clampedActive}
            listboxId={listboxId}
            optionId={optionId}
            onActiveIndexChange={setActiveIndex}
            onSelect={selectCommand}
            onRetry={cmds.retry}
            online={online}
          />
        ) : null}
        {/* The shared editor palettes (`@` / `#` / `:shortcode:`) — the same
            bundle the inline editor mounts (EditorPalettes.tsx). */}
        {editorPalettes.palettes}
        {staged.length > 0 ? (
          <ul
            // #56: the strip scrolls past ~2 rows of thumbs so a big pick can
            // never stretch the composer. The p-1.5/-m pairing keeps the
            // thumbs' overhanging remove buttons out of the scrollport clip.
            className="mb-2 flex max-h-54 max-w-full flex-wrap gap-2 overflow-y-auto p-1.5 -mx-1.5 -mt-1.5"
            aria-label="Staged attachments"
            data-testid="attachment-tray"
          >
            {staged.map((chip) =>
              // #56: images render as inline Slack-style thumbnails (local
              // object URL instantly, served descriptor once uploaded);
              // every other file keeps the chip form.
              chip.file && isImageFile(chip.file) ? (
                <AttachmentThumb
                  key={chip.key}
                  file={chip.file}
                  uploadedUrl={chip.attachment?.url ?? null}
                  status={chip.status}
                  error={chip.error}
                  onRemove={() => removeStaged(chip.key)}
                />
              ) : (
              <li
                key={chip.key}
                data-testid="attachment-chip"
                data-status={chip.status}
                className="flex max-w-full items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm"
              >
                <span aria-hidden>📎</span>
                <span className="min-w-0 truncate text-text" title={chip.filename}>
                  {chip.filename}
                </span>
                <span className="shrink-0 text-text-muted">{formatBytes(chip.sizeBytes)}</span>
                {chip.status === 'uploading' ? (
                  <span
                    role="status"
                    data-testid="attachment-upload-pending"
                    className="flex shrink-0 items-center gap-1.5 text-text-muted"
                  >
                    <span
                      aria-hidden
                      className="inline-block h-2 w-2 animate-pulse motion-reduce:animate-none rounded-full bg-accent"
                    />
                    Uploading…
                  </span>
                ) : chip.status === 'error' ? (
                  <span
                    role="alert"
                    data-testid="attachment-upload-error"
                    className="shrink-0 text-danger"
                  >
                    {chip.error ?? 'Upload failed'}
                  </span>
                ) : null}
                <button
                  type="button"
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-muted transition-colors duration-[var(--duration-control)] hover:bg-surface-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
                  aria-label={`Remove ${chip.filename}`}
                  data-testid="attachment-chip-remove"
                  onClick={() => removeStaged(chip.key)}
                >
                  ✕
                </button>
              </li>
              ),
            )}
          </ul>
        ) : null}
        <div className="composer-row" data-testid="composer-row">
          <div className="composer-ctl relative flex shrink-0 items-center">
            <DropdownMenu open={plusOpen} onOpenChange={setPlusOpen}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="composer-icon-btn"
                  aria-label="Add to message"
                  data-testid="composer-plus"
                  disabled={!online || !emailVerified}
                  title={online ? 'Add to message' : 'You are offline — attachments are unavailable until reconnection'}
                >
                  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                    <path
                      d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5z"
                      fill="currentColor"
                    />
                  </svg>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                className="composer-plus-menu"
                side="top"
                align="start"
                sideOffset={8}
                aria-label="Add to message"
                data-testid="composer-plus-menu"
              >
                <DropdownMenuItem
                  className="composer-plus-item"
                  data-testid="composer-plus-upload"
                  disabled={!online || !emailVerified}
                  onSelect={() => fileInputRef.current?.click()}
                >
                  <span aria-hidden>📎</span> Upload a File
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ATTACH_ACCEPT}
              className="hidden"
              tabIndex={-1}
              aria-hidden="true"
              data-testid="composer-file-input"
              onChange={onFilesPicked}
            />
          </div>
          <div className="relative min-w-0 flex-1">
            <MentionNameContext.Provider value={mentionResolver}>
            <ChannelNameContext.Provider value={channelResolver}>
            <LexicalComposer initialConfig={initialConfig}>
            <RichTextPlugin
              contentEditable={
                <ContentEditable
                  className={`${COMPOSER_MD_CLASS} min-h-[44px] px-3 py-[11px] text-base leading-[22px] text-text outline-none placeholder-shown:text-text-muted`}
                  aria-label="Message"
                  data-testid="composer-input"
                  aria-disabled={!emailVerified}
                  role="combobox"
                  aria-haspopup="listbox"
                  aria-autocomplete="list"
                  aria-expanded={showAutocomplete || editorPalettes.open}
                  aria-controls={
                    editorPalettes.controls ??
                    (showAutocomplete && matches.length > 0 ? listboxId : undefined)
                  }
                  aria-activedescendant={editorPalettes.activeDescendant ?? activeOptionId}
                />
              }
              placeholder={
                <div
                  className="pointer-events-none absolute inset-x-3 top-1/2 -translate-y-1/2 text-base leading-[22px] text-text-muted"
                  data-testid="composer-placeholder"
                >
                  {isDm
                    ? `Message @${channelName ?? '…'}`
                    : isThread
                      ? 'Reply in thread'
                      : `Message #${channelName ?? channelId}`}
                </div>
              }
              ErrorBoundary={LexicalErrorBoundary}
            />
            <HistoryPlugin />
            <ComposerMarkdownPlugin />
            <EnterSendPlugin onSend={handleSend} />
            {__CYTALE_E2E__ ? <E2EBridgePlugin onSend={handleSend} /> : null}
            <SlashCommandPlugin enabled={emailVerified} handlers={slashHandlers} />
            {editorPalettes.plugins}
            <DraftPlugin scope={draftScope} />
            <TypingEmitPlugin onType={emitTyping} />
            <EditorRefPlugin onReady={onEditorReadyCb} />
            </LexicalComposer>
            </ChannelNameContext.Provider>
            </MentionNameContext.Provider>
          </div>
          <div className="composer-icons">
            {/* One popover primitive for pickers (UI consistency, 2026-09-27):
                Radix Popover owns the trigger toggle (a click on the trigger
                closes — the hand-rolled outside-click closed on mousedown and
                the click re-opened it), Escape, outside dismiss, and focus.
                Closing hands focus back to the EDITOR, where the picked emoji
                landed — not to the button. */}
            <Popover open={emojiPanelOpen} onOpenChange={setEmojiPanelOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="composer-icon-btn"
                  aria-label="Emoji"
                  data-testid="composer-emoji"
                  title="Emoji"
                >
                  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                    <path
                      d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zM9 9.5a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0zm8.5 0a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0zM12 17.5c2.03 0 3.8-1.11 4.75-2.75h-9.5A5.47 5.47 0 0 0 12 17.5z"
                      fill="currentColor"
                    />
                  </svg>
                </button>
              </PopoverTrigger>
              <PopoverContent
                side="top"
                align="end"
                sideOffset={8}
                className="w-auto border-0 bg-transparent p-0 shadow-none"
                onOpenAutoFocus={(e) => e.preventDefault()}
                onCloseAutoFocus={(e) => {
                  e.preventDefault();
                  editorRef.current?.focus();
                }}
              >
                <EmojiPickerPanel
                  onPick={insertEmojiAtCaret}
                  onClose={() => setEmojiPanelOpen(false)}
                  dismissOnOutsideClick={false}
                />
              </PopoverContent>
            </Popover>
          </div>
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger" data-testid="composer-error">
          {error}
        </p>
      )}
      <div role="status" aria-live="polite" className="sr-only" data-testid="composer-send-status">
        {sendAnnouncement}
      </div>
    </div>
  );
}

/**
 * Memoized (lane D #17): the always-mounted Lexical composer is the costliest
 * leaf under the pane, and the pane re-renders for timeline state the composer
 * does not read. React 19 forwards `ref` through `memo` as a plain prop.
 */
export const MessageCompose = memo(MessageComposeImpl);
