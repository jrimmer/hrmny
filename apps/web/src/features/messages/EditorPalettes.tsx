/**
 * @cytale/web — the editor palettes bundle (UI consistency, 2026-09-27).
 *
 * The three typeahead palettes a message editor offers — `@member`,
 * `#channel` and `:shortcode:` emoji — as ONE bundle that every editing
 * surface mounts: the composer, the desktop inline editor, and the touch
 * sheet's editor (which is the inline editor). Before this they lived inside
 * MessageCompose, so an EDIT had no palettes at all by design: typing `@` in
 * an edit produced a raw `@name` that never became a mention, and the touch
 * sheet edited the raw wire text (`<@id>`, `<#id>`) in a textarea.
 *
 * The slash-command palette is deliberately NOT here: a command runs an
 * application interaction, which means something only as a NEW message — an
 * edit cannot re-run one. The composer keeps it and passes `suppressed` while
 * it (or its option-fill form) owns the line, so the two never compete.
 *
 * Shape: `useEditorPalettes(...)` returns
 *   * `plugins`  — the Lexical plugins (mount inside the LexicalComposer);
 *   * `palettes` — the palette UIs, already wrapped in their floating
 *                  anchor (`.editor-palettes`): render it inside the host's
 *                  `position: relative` box (the composer well, the edit box)
 *                  and it floats ABOVE that box, over the timeline. It never
 *                  takes layout space, so opening it moves neither the message
 *                  list's scroll nor the composer's height (owner report
 *                  2026-09-28: `#`/`@` search pushed the conversation up);
 *   * `combobox` — the ARIA wiring for the ContentEditable (expanded /
 *                  controls / activedescendant), so the editor stays one
 *                  combobox whichever palette is open.
 *
 * The rules are unchanged from the composer (they moved, they did not
 * change): nothing is preselected; ↑/↓ move the highlight; Tab completes the
 * highlight or the top match; Enter picks ONLY a highlighted row and
 * otherwise declines (so Enter sends / saves); Escape dismisses for this
 * token; one palette at a time (emoji yields to nothing, `@` yields to emoji,
 * `#` yields to both).
 */

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext.js';
import {
  $getRoot,
  $isParagraphNode,
  $isTextNode,
  COMMAND_PRIORITY_CRITICAL,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  type LexicalEditor,
  type TextNode,
} from 'lexical';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from 'react';

import type { StateStore } from '@cytale/state';

import { avatarInitials } from '../../app/ui/avatar.js';
import { Avatar } from '../../app/ui/UserAvatar.js';
import { Command, CommandItem } from '../../components/shadcn/command.js';
import { bumpFrecentEmoji, emojiByShortcode, searchEmojiCatalog } from './emojiCatalog.js';
import {
  channelCandidatesFor,
  channelQueryOf,
  mentionCandidatesFor,
  mentionDisplayName,
  rankChannelCandidates,
  rankMentionCandidates,
} from './mentionCandidates.js';
import {
  MentionTypeaheadPlugin,
  insertChannelMention,
  insertMention,
  type MentionHandlers,
} from './MentionTypeahead.js';

/** The key/text contract every palette plugin speaks (slash's too). */
export type PaletteHandlers = MentionHandlers;

/**
 * The shared arrow step for the no-preselect palettes: -1 = nothing
 * highlighted; ↓ from nothing takes the first row, ↑ takes the last;
 * otherwise wraps. One definition so the palettes cannot drift.
 */
export function paletteStep(index: number, count: number, dir: 1 | -1): number {
  if (count === 0) return -1;
  if (index < 0) return dir === 1 ? 0 : count - 1;
  return (index + dir + count) % count;
}

// -- `:shortcode:` emoji autocomplete (Discord's "EMOJI MATCHING" palette) --

/** A trailing `:token` (≥2 chars, word-boundary before the colon) opens the
 * emoji palette; Discord's same rule. Returns the token without the colon. */
export function emojiQueryOf(text: string): string | null {
  const m = /(?:^|\s):([a-z0-9_+-]{2,32}):?$/i.exec(text);
  return m ? (m[1] ?? null) : null;
}

/**
 * The `:token` watcher + keyboard interception — structurally the
 * SlashCommandPlugin's twin (update-listener query reporting; arrows/Enter/
 * Escape consumed at CRITICAL priority while the palette is open). The two
 * palettes are mutually exclusive by their trigger shapes (slash requires a
 * leading "/", emoji a trailing ":token"), and the host additionally gates
 * this one off while the slash palette is open.
 */
export function EmojiAutocompletePlugin({
  enabled,
  handlers,
}: {
  enabled: boolean;
  handlers: PaletteHandlers;
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
      handlersRef.current.onText(emojiQueryOf(text));
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

/** Replaces a trailing `:token` (in the last text node) with the picked
 * emoji and parks the caret at the end of the inserted character. */
export function replaceTrailingEmojiToken(editor: LexicalEditor, emoji: string): void {
  editor.update(() => {
    const para = $getRoot().getLastChild();
    if (para === null || !$isParagraphNode(para)) return;
    const children = para.getChildren();
    const lastText = [...children]
      .reverse()
      .find((c): c is TextNode => $isTextNode(c));
    if (lastText === undefined) return;
    const text = lastText.getTextContent();
    const m = /:([a-z0-9_+-]{2,32}):?$/i.exec(text);
    if (!m) return;
    const next = text.slice(0, m.index) + emoji;
    if (next) lastText.setTextContent(next);
    else lastText.remove();
    para.selectEnd();
  });
}

export interface UseEditorPalettesOptions {
  /** The host's editor handle (set by its ready/seed plugin). */
  editorRef: MutableRefObject<LexicalEditor | null>;
  /** The store the candidates come from (roster, channels). */
  store: StateStore;
  /** The workspace scoping the candidates; null (a DM) = no `#` palette. */
  workspaceId: string | null;
  /** False disables every palette (e.g. the unverified composer). */
  enabled: boolean;
  /** True while something else owns the line (the composer's slash palette
   *  or its option-fill form): the palettes stand down. */
  suppressed?: boolean;
  /** Stable id prefix for the listbox/option ids (the host's useId()). */
  idPrefix: string;
}

export interface EditorPalettes {
  plugins: ReactNode;
  palettes: ReactNode;
  /** True while any of the three palettes is showing. */
  open: boolean;
  /** The listbox the editor controls right now (undefined = none). */
  controls: string | undefined;
  /** The highlighted option's id (undefined = none). */
  activeDescendant: string | undefined;
}

export function useEditorPalettes({
  editorRef,
  store,
  workspaceId,
  enabled,
  suppressed = false,
  idPrefix,
}: UseEditorPalettesOptions): EditorPalettes {
  // -- `:shortcode:` emoji autocomplete ------------------------------------
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [emojiDismissed, setEmojiDismissed] = useState(false);
  const [emojiQuery, setEmojiQuery] = useState('');
  /** Bumped on every palette report — the closed-form check must re-run
   * even when the query string itself is unchanged (`:name` → `:name:`). */
  const [emojiReport, setEmojiReport] = useState(0);
  // -1 = nothing highlighted (the no-autoselect rule; see paletteStep).
  const [emojiIndex, setEmojiIndex] = useState(-1);
  const emojiMatches = useMemo(() => searchEmojiCatalog(emojiQuery), [emojiQuery]);
  const emojiClamped = Math.min(emojiIndex, Math.max(emojiMatches.length - 1, 0));
  // The row the user pointed at (arrows or hover); undefined while nothing is.
  const emojiHighlighted = emojiIndex >= 0 ? emojiMatches[emojiClamped] : undefined;
  const showEmojiAutocomplete = emojiOpen && !emojiDismissed;

  const handleEmojiText = useCallback((query: string | null) => {
    if (query === null) {
      setEmojiOpen(false);
      setEmojiDismissed(false);
      setEmojiQuery('');
      return;
    }
    setEmojiQuery(query);
    setEmojiIndex(-1);
    setEmojiOpen(true);
    setEmojiReport((n) => n + 1);
  }, []);

  const insertEmoji = useCallback(
    (emoji: string) => {
      const editor = editorRef.current;
      if (!editor) return;
      replaceTrailingEmojiToken(editor, emoji);
      bumpFrecentEmoji(emoji);
      setEmojiOpen(false);
      setEmojiDismissed(false);
      setEmojiQuery('');
    },
    [editorRef],
  );

  // CLOSED shortcode (:name:) with an exact catalog match converts the
  // moment the closing colon lands — Discord's typing behavior. Runs as an
  // effect (post-render, outside Lexical's commit), so the replacement
  // update commits cleanly; insertEmoji also retires the palette.
  useEffect(() => {
    if (!emojiOpen) return;
    const editor = editorRef.current;
    if (!editor) return;
    const text = editor.getEditorState().read(() => $getRoot().getTextContent());
    const closed = /(?:^|\s):([a-z0-9_+-]{2,32}):$/i.exec(text);
    if (closed) {
      const hit = emojiByShortcode(closed[1] ?? '');
      if (hit) insertEmoji(hit.e);
    }
  }, [emojiOpen, emojiReport, insertEmoji, editorRef]);

  const emojiHandlers: PaletteHandlers = useMemo(
    () => ({
      isActive: () => emojiOpen && !suppressed,
      onText: handleEmojiText,
      onArrowUp: () => setEmojiIndex((i) => paletteStep(i, emojiMatches.length, -1)),
      onArrowDown: () => setEmojiIndex((i) => paletteStep(i, emojiMatches.length, 1)),
      // Enter inserts ONLY a row the user pointed at; with nothing
      // highlighted it declines and the message sends as typed (owner
      // direction 2026-09-19 — every palette follows one rule).
      onEnter: () => {
        if (!emojiHighlighted) return false;
        insertEmoji(emojiHighlighted.e);
        return true;
      },
      onTab: () => {
        const pick = emojiHighlighted ?? emojiMatches[0];
        if (pick) insertEmoji(pick.e);
      },
      onEscape: () => {
        setEmojiOpen(false);
        setEmojiDismissed(true);
      },
    }),
    [emojiOpen, suppressed, handleEmojiText, emojiMatches, emojiHighlighted, insertEmoji],
  );

  // -- `@`-mention typeahead -------------------------------------------------
  // A mention is a TOKEN plus an array. The editor is where the token is
  // produced, so the typeahead inserts a `MentionNode` (rendering the tag)
  // that serializes to `<@id>` — the shape the shared markdown parser reads.
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  // -1 = NOTHING highlighted. The palette never pre-selects a row (owner,
  // 2026-09-18): arrow keys (and hover) are the only things that set this.
  const [mentionIndex, setMentionIndex] = useState(-1);

  // Read LAZILY (per keystroke, only while open): the roster is one store
  // read and an idle editor subscribes to nothing.
  const mentionMatches = useMemo(() => {
    if (mentionQuery === null) return [];
    return rankMentionCandidates(mentionQuery, mentionCandidatesFor(store, workspaceId));
  }, [mentionQuery, store, workspaceId]);

  const mentionClamped = Math.min(mentionIndex, Math.max(mentionMatches.length - 1, 0));

  // The highlight belongs to the LIST it was set on: when the matches
  // recompute, a positional index could clamp onto a DIFFERENT member and
  // Enter would complete the wrong row (PR #140 review). Reset with it.
  useEffect(() => {
    setMentionIndex(-1);
  }, [mentionMatches]);
  const mentionHighlighted = mentionIndex >= 0 ? mentionMatches[mentionClamped] : undefined;
  const mentionListboxId = `${idPrefix}-mentions-listbox`;

  // One palette at a time: the emoji palette wins over this one.
  const showMentionTypeahead =
    enabled && mentionQuery !== null && !mentionDismissed && !suppressed && !emojiOpen;

  const commitMention = useCallback(
    (userId: string) => {
      const editor = editorRef.current;
      if (!editor) return;
      insertMention(editor, userId);
      setMentionQuery(null);
      setMentionDismissed(false);
      setMentionIndex(-1);
    },
    [editorRef],
  );

  const handleMentionText = useCallback((query: string | null) => {
    if (query === null) {
      setMentionQuery(null);
      setMentionDismissed(false);
      // No highlight may survive a close — a stale index would turn the NEXT
      // palette's Enter from "send" into "pick that row" (PR #140 review).
      setMentionIndex(-1);
      return;
    }
    setMentionQuery(query);
    setMentionIndex(-1);
    // Typing after an Escape re-arms the palette for the new token.
    setMentionDismissed(false);
  }, []);

  const mentionHandlers: PaletteHandlers = useMemo(
    () => ({
      // A PICKABLE row is required for the palette to hold the keys: with
      // nothing matched it is information only, so Enter still sends.
      // Mirrors showMentionTypeahead exactly (PR #140 review).
      isActive: () =>
        mentionQuery !== null &&
        mentionMatches.length > 0 &&
        !mentionDismissed &&
        !suppressed &&
        !emojiOpen,
      onText: handleMentionText,
      onArrowUp: () => setMentionIndex((i) => paletteStep(i, mentionMatches.length, -1)),
      onArrowDown: () => setMentionIndex((i) => paletteStep(i, mentionMatches.length, 1)),
      onEnter: () => {
        // No highlighted row → decline the key: Enter means send/save.
        if (!mentionHighlighted) return false;
        commitMention(mentionHighlighted.id);
        return true;
      },
      onTab: () => {
        const pick = mentionHighlighted ?? mentionMatches[0];
        if (pick) commitMention(pick.id);
      },
      onEscape: () => {
        setMentionDismissed(true);
        setMentionQuery(null);
      },
    }),
    [
      mentionQuery,
      mentionMatches,
      mentionHighlighted,
      mentionDismissed,
      suppressed,
      emojiOpen,
      commitMention,
      handleMentionText,
    ],
  );

  // -- `#`-channel typeahead -------------------------------------------------
  // The `@` palette's twin over the workspace's channel list: same caret rule,
  // same keys, and the pick inserts a `ChannelMentionNode` (`<#id>`).
  const [channelQuery, setChannelQuery] = useState<string | null>(null);
  const [channelDismissed, setChannelDismissed] = useState(false);
  const [channelIndex, setChannelIndex] = useState(-1);

  const channelMatches = useMemo(() => {
    if (channelQuery === null) return [];
    return rankChannelCandidates(channelQuery, channelCandidatesFor(store, workspaceId));
  }, [channelQuery, store, workspaceId]);

  const channelClamped = Math.min(channelIndex, Math.max(channelMatches.length - 1, 0));
  useEffect(() => {
    setChannelIndex(-1);
  }, [channelMatches]);
  const channelHighlighted = channelIndex >= 0 ? channelMatches[channelClamped] : undefined;
  const channelListboxId = `${idPrefix}-channels-listbox`;

  // DMs have no workspace channel list, so the palette never opens there.
  const showChannelTypeahead =
    enabled &&
    channelQuery !== null &&
    !channelDismissed &&
    !suppressed &&
    !emojiOpen &&
    !showMentionTypeahead &&
    Boolean(workspaceId);

  const commitChannel = useCallback(
    (channelId: string) => {
      const editor = editorRef.current;
      if (!editor) return;
      insertChannelMention(editor, channelId);
      setChannelQuery(null);
      setChannelDismissed(false);
      setChannelIndex(-1);
    },
    [editorRef],
  );

  const handleChannelText = useCallback((query: string | null) => {
    setChannelIndex(-1);
    if (query === null) {
      setChannelQuery(null);
      setChannelDismissed(false);
      return;
    }
    setChannelQuery(query);
    setChannelDismissed(false);
  }, []);

  const channelHandlers: PaletteHandlers = useMemo(
    () => ({
      isActive: () => showChannelTypeahead && channelMatches.length > 0,
      onText: handleChannelText,
      onArrowUp: () => setChannelIndex((i) => paletteStep(i, channelMatches.length, -1)),
      onArrowDown: () => setChannelIndex((i) => paletteStep(i, channelMatches.length, 1)),
      onEnter: () => {
        if (!channelHighlighted) return false;
        commitChannel(channelHighlighted.id);
        return true;
      },
      onTab: () => {
        const pick = channelHighlighted ?? channelMatches[0];
        if (pick) commitChannel(pick.id);
      },
      onEscape: () => {
        setChannelDismissed(true);
        setChannelQuery(null);
      },
    }),
    [showChannelTypeahead, channelMatches, channelHighlighted, commitChannel, handleChannelText],
  );

  const pluginsEnabled = enabled && !suppressed;
  const plugins = (
    <>
      <EmojiAutocompletePlugin enabled={pluginsEnabled} handlers={emojiHandlers} />
      <MentionTypeaheadPlugin enabled={pluginsEnabled} handlers={mentionHandlers} />
      <MentionTypeaheadPlugin
        enabled={pluginsEnabled}
        handlers={channelHandlers}
        queryOf={channelQueryOf}
      />
    </>
  );

  const open = (showEmojiAutocomplete && enabled) || showMentionTypeahead || showChannelTypeahead;

  // The floating anchor: absolutely placed above the host box (see the
  // header), capped in height with its own scroll (shell.css .editor-palettes).
  const palettes = open ? (
    <div className="editor-palettes" data-testid="editor-palettes">
      {showEmojiAutocomplete && enabled ? (
        // cmdk renders the rows (role/semantics/scroll-into-view), the host
        // controls the selection from the Lexical key routing. Click commits.
        <div
          className="emoji-autocomplete"
          aria-label={`Emoji matching ${emojiQuery}`}
          data-testid="emoji-autocomplete"
        >
          <Command
            shouldFilter={false}
            value={
              emojiMatches.length > 0 && emojiClamped >= 0
                ? `${emojiMatches[emojiClamped]!.n}-${emojiClamped}`
                : ''
            }
            role="listbox"
            aria-label={`Emoji matching ${emojiQuery}`}
          >
            <div className="emoji-autocomplete-title" aria-hidden="true">
              EMOJI MATCHING :{emojiQuery}
            </div>
            {emojiMatches.length === 0 ? (
              <div className="emoji-autocomplete-empty" data-testid="emoji-autocomplete-empty">
                No emoji match :{emojiQuery}
              </div>
            ) : (
              emojiMatches.slice(0, 12).map((row, i) => (
                <CommandItem
                  key={`${row.n}-${i}`}
                  value={`${row.n}-${i}`}
                  className="emoji-autocomplete-option"
                  data-testid="emoji-option"
                  data-emoji={row.e}
                  onMouseEnter={() => setEmojiIndex(i)}
                  onClick={() => insertEmoji(row.e)}
                >
                  <span aria-hidden className="emoji-autocomplete-char">
                    {row.e}
                  </span>
                  <span>{`:${row.n}:`}</span>
                </CommandItem>
              ))
            )}
          </Command>
        </div>
      ) : null}
      {showMentionTypeahead ? (
        // #150: the rows render through cmdk's Item, CONTROLLED — the keys
        // arrive at the Lexical editor, so the host keeps the routing and
        // flows its active index in as cmdk's `value`. Hover stays
        // host-driven (mouseEnter sets the index, leaving the palette clears
        // it, Enter unambiguously means send — PR #140 review).
        <div
          className="emoji-autocomplete mention-autocomplete"
          id={mentionListboxId}
          aria-label={`Members matching ${mentionQuery ?? ''}`}
          data-testid="mention-autocomplete"
          onMouseLeave={() => setMentionIndex(-1)}
        >
          <Command
            shouldFilter={false}
            value={mentionMatches[mentionClamped]?.id ?? ''}
            role="listbox"
            aria-label={`Members matching ${mentionQuery ?? ''}`}
          >
            <div className="emoji-autocomplete-title" aria-hidden="true">
              MEMBERS MATCHING @{mentionQuery}
            </div>
            {mentionMatches.length === 0 ? (
              <div className="emoji-autocomplete-empty" data-testid="mention-autocomplete-empty">
                No member matches @{mentionQuery}
              </div>
            ) : (
              mentionMatches.map((candidate, i) => (
                <CommandItem
                  key={candidate.id}
                  value={candidate.id}
                  className={`emoji-autocomplete-option mention-autocomplete-option${
                    i === mentionClamped ? ' is-active' : ''
                  }`}
                  data-testid="mention-option"
                  data-user-id={candidate.id}
                  onMouseEnter={() => setMentionIndex(i)}
                  // mousedown, not click: the editor must keep its selection
                  // so the token lands at the caret, not at the start.
                  onMouseDown={(e: React.MouseEvent) => {
                    e.preventDefault();
                    commitMention(candidate.id);
                  }}
                >
                  {/* cmdk generates its own item id, so the editor's
                      aria-activedescendant points at this wrapper instead —
                      the virtualized-list convention. */}
                  <span
                    id={`${idPrefix}-mention-opt-${candidate.id}`}
                    className="mention-autocomplete-row-content"
                  >
                    <Avatar
                      id={candidate.id}
                      name={
                        avatarInitials(mentionDisplayName(candidate))
                          ? mentionDisplayName(candidate)
                          : candidate.username || '?'
                      }
                      src={candidate.avatar_url ?? null}
                      kind={candidate.kind ?? null}
                      className="mention-autocomplete-avatar"
                    />
                    <span className="mention-autocomplete-name">{mentionDisplayName(candidate)}</span>
                    {mentionDisplayName(candidate) !== candidate.username ? (
                      <span className="mention-autocomplete-username" aria-hidden>
                        @{candidate.username}
                      </span>
                    ) : null}
                  </span>
                </CommandItem>
              ))
            )}
          </Command>
        </div>
      ) : null}
      {showChannelTypeahead ? (
        // The `@` palette's twin (same controlled cmdk shape, same hover and
        // mousedown rules) over the workspace's channels.
        <div
          className="emoji-autocomplete mention-autocomplete"
          id={channelListboxId}
          aria-label={`Channels matching ${channelQuery ?? ''}`}
          data-testid="channel-autocomplete"
          onMouseLeave={() => setChannelIndex(-1)}
        >
          <Command
            shouldFilter={false}
            value={channelMatches[channelClamped]?.id ?? ''}
            role="listbox"
            aria-label={`Channels matching ${channelQuery ?? ''}`}
          >
            <div className="emoji-autocomplete-title" aria-hidden="true">
              CHANNELS MATCHING #{channelQuery}
            </div>
            {channelMatches.length === 0 ? (
              <div className="emoji-autocomplete-empty" data-testid="channel-autocomplete-empty">
                No channel matches #{channelQuery}
              </div>
            ) : (
              channelMatches.map((candidate, i) => (
                <CommandItem
                  key={candidate.id}
                  value={candidate.id}
                  className={`emoji-autocomplete-option mention-autocomplete-option${
                    i === channelClamped ? ' is-active' : ''
                  }`}
                  data-testid="channel-option"
                  data-channel-id={candidate.id}
                  onMouseEnter={() => setChannelIndex(i)}
                  onMouseDown={(e: React.MouseEvent) => {
                    e.preventDefault();
                    commitChannel(candidate.id);
                  }}
                >
                  <span
                    id={`${idPrefix}-channel-opt-${candidate.id}`}
                    className="mention-autocomplete-row-content"
                  >
                    <span aria-hidden className="mention-autocomplete-glyph">
                      #
                    </span>
                    <span className="mention-autocomplete-name">{candidate.name}</span>
                  </span>
                </CommandItem>
              ))
            )}
          </Command>
        </div>
      ) : null}
    </div>
  ) : null;

  return {
    plugins,
    palettes,
    open,
    controls: showMentionTypeahead
      ? mentionListboxId
      : showChannelTypeahead
        ? channelListboxId
        : undefined,
    activeDescendant:
      showMentionTypeahead && mentionHighlighted
        ? `${idPrefix}-mention-opt-${mentionHighlighted.id}`
        : showChannelTypeahead && channelHighlighted
          ? `${idPrefix}-channel-opt-${channelHighlighted.id}`
          : undefined,
  };
}
