/**
 * @cytale/web — InlineMessageEditor: edit a message in place.
 *
 * Discord/Slack shape (2026-09-10 decision): the message row becomes the
 * editor instead of opening a dialog. Seeded with the message's raw
 * markdown; Enter saves, Shift+Enter inserts a newline, Escape cancels;
 * visible Save/Cancel buttons carry the same actions for discoverability.
 *
 * The Lexical configuration mirrors MessageCompose (same nodes, same
 * markdown transformers), so what you type edits with the same formatting
 * rules you composed with — and, since 2026-09-27, with the SAME `@member`,
 * `#channel` and `:shortcode:` palettes (the shared EditorPalettes bundle):
 * an edit used to turn a typed `@name` into plain text that never became a
 * mention. Still composer-only: attachments (immutable once sent) and slash
 * commands (a command is an interaction, which only a NEW message can run).
 *
 * The same component is the touch sheet's editor (MessageActionsSheet), so
 * the mobile edit shows pills, not the raw `<@id>` / `<#id>` wire text.
 */
import { LexicalComposer } from '@lexical/react/LexicalComposer.js';
import { ContentEditable } from '@lexical/react/LexicalContentEditable.js';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin.js';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin.js';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary.js';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext.js';
import {
  ChannelNameContext,
  MentionNameContext,
  type ChannelNameResolver,
  type MentionNameResolver,
} from './MentionNode.js';
import { defaultStore, type StateStore } from '@cytale/state';
import { channelNameOf } from './ChannelMentionPill.js';
import { useEditorPalettes } from './EditorPalettes.js';
import { COMPOSER_MD_CLASS, composerEditorConfig } from './editorConfig.js';
import { $exportComposerMarkdown, $importComposerMarkdown } from './composerMarkdown.js';
import { ComposerMarkdownPlugin } from './ComposerMarkdownPlugin.js';
import {
  $getRoot,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  COMMAND_PRIORITY_HIGH,
  type LexicalEditor,
} from 'lexical';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

export interface InlineMessageEditorProps {
  /** The message's raw content (markdown as stored) — seeds the editor. */
  initialContent: string;
  /** Persists the edit; resolves on success, rejects to keep the editor open. */
  onSave: (content: string) => Promise<void>;
  /** Escape / Cancel — the host closes the editor (no write). */
  onCancel: () => void;
  /** Test seam (the composer's onEditorReady precedent). */
  onEditorReady?: (editor: LexicalEditor) => void;
  /** Roster-backed display names for mention pills while editing. */
  mentionResolver?: MentionNameResolver;
  /** The store the palettes' candidates (roster, channels) come from. */
  store?: StateStore;
  /** The edited message's channel — scopes the palettes to its workspace. */
  channelId?: string;
  /** Test id prefix override (the touch sheet hosts a second instance). */
  testId?: string;
}

/** Seeds the editor from markdown and parks the caret at the end. */
function SeedPlugin({ content, onReady }: { content: string; onReady?: (e: LexicalEditor) => void }) {
  const [editor] = useLexicalComposerContext();
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    editor.update(() => {
      $importComposerMarkdown(content);
      $getRoot().selectEnd();
    });
    editor.focus();
    onReady?.(editor);
  }, [editor, content, onReady]);
  return null;
}

/** Enter saves (Shift+Enter newline), Escape cancels — the composer contract. */
function EditKeysPlugin({
  onSave,
  onCancel,
}: {
  onSave: () => void;
  onCancel: () => void;
}) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    const disposers = [
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (event: KeyboardEvent | null) => {
          if (event?.shiftKey) return false; // newline
          event?.preventDefault();
          onSave();
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_ESCAPE_COMMAND,
        (event: KeyboardEvent | null) => {
          event?.preventDefault();
          onCancel();
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    ];
    return () => disposers.forEach((d) => d());
  }, [editor, onSave, onCancel]);
  return null;
}

export function InlineMessageEditor({
  initialContent,
  onSave,
  onCancel,
  onEditorReady,
  mentionResolver,
  store = defaultStore,
  channelId,
  testId = 'inline-edit',
}: InlineMessageEditorProps) {
  const editorRef = useRef<LexicalEditor | null>(null);
  const idPrefix = useId();
  // The channel pills resolve the way the composer's do (a workspace text
  // channel the reader can see, else `#unknown-channel`).
  const channelResolver = useMemo<ChannelNameResolver>(
    () => (id: string) => channelNameOf(store, id),
    [store],
  );
  const workspaceId =
    channelId !== undefined ? (store.getState().channels[channelId]?.workspace_id ?? null) : null;
  const palettes = useEditorPalettes({
    editorRef,
    store,
    workspaceId,
    enabled: true,
    idPrefix,
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const readMarkdown = useCallback((): string => {
    const editor = editorRef.current;
    if (!editor) return '';
    return editor.getEditorState().read(() => $exportComposerMarkdown());
  }, []);

  const save = useCallback(() => {
    if (pending) return;
    const content = readMarkdown().trim();
    // Empty content never saves (the server's 1-byte floor, enforced here
    // so the user sees why instead of a 400).
    if (content === '') {
      setError('Message cannot be empty.');
      return;
    }
    setError(null);
    setPending(true);
    void onSave(content)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not save the edit. Try again.');
      })
      .finally(() => setPending(false));
  }, [pending, readMarkdown, onSave]);

  const config = composerEditorConfig('cytale-inline-edit');

  return (
    <div className="inline-edit" data-testid={testId}>
      {/* The palettes float ABOVE the edit box (EditorPalettes wraps them in
          their own anchor): in-flow they would reflow the timeline row. */}
      {palettes.palettes}
      <MentionNameContext.Provider value={mentionResolver ?? null}>
      <ChannelNameContext.Provider value={channelResolver}>
      <LexicalComposer initialConfig={config}>
        <RichTextPlugin
          contentEditable={
            <ContentEditable
              className={`inline-edit-input ${COMPOSER_MD_CLASS}`}
              aria-label="Edit message"
              data-testid={`${testId}-input`}
              role="combobox"
              aria-haspopup="listbox"
              aria-autocomplete="list"
              aria-expanded={palettes.open}
              aria-controls={palettes.controls}
              aria-activedescendant={palettes.activeDescendant}
            />
          }
          placeholder={
            <div className="inline-edit-placeholder" aria-hidden="true">
              Edit message
            </div>
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <ComposerMarkdownPlugin />
        <SeedPlugin
          content={initialContent}
          onReady={(editor) => {
            editorRef.current = editor;
            onEditorReady?.(editor);
          }}
        />
        <EditKeysPlugin onSave={save} onCancel={onCancel} />
        {palettes.plugins}
      </LexicalComposer>
      </ChannelNameContext.Provider>
      </MentionNameContext.Provider>

      {error !== null ? (
        <p role="alert" className="inline-edit-error" data-testid={`${testId}-error`}>
          {error}
          <button
            type="button"
            className="inline-edit-retry"
            data-testid={`${testId}-retry`}
            onClick={save}
          >
            Retry
          </button>
        </p>
      ) : null}

      <div className="inline-edit-actions">
        <button
          type="button"
          className="modal-btn-secondary"
          data-testid={`${testId}-cancel`}
          disabled={pending}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="modal-btn-primary"
          data-testid={`${testId}-save`}
          disabled={pending}
          onClick={save}
        >
          {pending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
