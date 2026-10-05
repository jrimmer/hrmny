/**
 * The `@`-mention typeahead plugin (#66 follow-up; caret-relative since #129).
 *
 * Structurally the EmojiAutocompletePlugin's twin — an update-listener that
 * reports the open query upward, and keyboard commands consumed at
 * COMMAND_PRIORITY_CRITICAL so they beat EnterSendPlugin. The composer keeps
 * the candidate list and the highlight; this plugin owns trigger detection,
 * key routing, and the insertion itself.
 *
 * The query is derived from the CARET, not the document tail (#129): an
 * `@query` run ending at the caret opens the palette wherever the caret sits
 * — start, middle, after a line break, or at the end — and the replacement
 * splices the mention into that same caret-derived range. Before #129 both
 * halves were end-anchored, so a mention could only ever be added as the last
 * thing typed.
 *
 * Key map (Discord's, plus the Tab completion every chat app ships):
 *
 *   ↑ / ↓      move the highlight (wraps). Nothing is highlighted until the
 *              user asks for it — the palette never pre-selects a row
 *   Tab        insert the highlighted member, else the top match — the
 *              "complete it" key
 *   Enter      insert the highlighted member; with NOTHING highlighted the
 *              palette declines the key, so Enter sends as it always does.
 *              (Owner, 2026-09-18: no autoselect, Tab is what completes.)
 *   Escape     dismiss for this token; Enter then sends again
 *   space      closes the palette naturally (a trailing space ends the token)
 *
 * A pick appends a SPACE, so the palette cannot reopen on the way out and the
 * next word starts cleanly.
 */

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext.js';
import {
  $createTextNode,
  $getNodeByKey,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_CRITICAL,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical';
import { useEffect, useRef } from 'react';

import { channelQueryOf, mentionQueryOf } from './mentionCandidates.js';
import { $createChannelMentionNode, $createMentionNode } from './MentionNode.js';

/** A trigger's caret rule: the open query before the caret, or null. */
export type TriggerQueryOf = (textBeforeCaret: string) => string | null;

/**
 * The composed text immediately BEFORE the caret, or null when there is no
 * caret to speak of (no selection yet, a drag-range, or a caret outside
 * text).
 *
 * The caret's own text node contributes its prefix up to the anchor offset,
 * and its same-parent siblings BEFORE it contribute in document order — an
 * undo, a markdown transform, or a mention insert can split what a user
 * thinks of as one run across nodes, and the query must be found across the
 * join. A LineBreakNode contributes its '\n', so the `(?:^|\s)` boundary in
 * `mentionQueryOf` treats a line break as a token edge exactly as it does a
 * space. Siblings stop at the parent: the pre-caret text never reaches into
 * another paragraph.
 *
 * This — not the document's tail — is what both the trigger and the
 * replacement derive from (#129): the palette is a CARET feature.
 */
function $textBeforeCaret(): string | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;

  const anchor = selection.anchor;
  const anchorNode = anchor.getNode();

  if ($isElementNode(anchorNode)) {
    // Caret between children (an empty paragraph, or between sibling nodes):
    // the pre-caret text is everything strictly before the anchor offset.
    return anchorNode
      .getChildren()
      .slice(0, anchor.offset)
      .map((child) => child.getTextContent())
      .join('');
  }

  if (!$isTextNode(anchorNode)) return null;

  const parts: string[] = [];
  for (
    let sibling = anchorNode.getPreviousSibling();
    sibling !== null;
    sibling = sibling.getPreviousSibling()
  ) {
    parts.unshift(sibling.getTextContent());
  }
  parts.push(anchorNode.getTextContent().slice(0, anchor.offset));
  return parts.join('');
}

/** The composer's half of the conversation (mirrors SlashHandlers). */
export interface MentionHandlers {
  isActive(): boolean;
  onText(query: string | null): void;
  onArrowUp(): void;
  onArrowDown(): void;
  /** True when a member was inserted (the key is consumed); false to let the
   *  composer's Enter handler send as usual. */
  onEnter(): boolean;
  onTab(): void;
  onEscape(): void;
}

/**
 * Replace the `@query` run ENDING AT THE CARET with a mention token and a
 * trailing space, and park the caret right after the space (#129).
 *
 * The range is derived from the same pre-caret text the trigger matched:
 * `query.length + 1` characters (`@` + query) back from the anchor, walking
 * through preceding TEXT siblings when the run straddles a node boundary. A
 * non-text sibling mid-run bails without touching the document — the commit
 * can then never land anywhere but where the palette opened, whether that is
 * the end of the message, its start, mid-sentence, or after a line break.
 *
 * Selection-range rather than manual node surgery: the selection is aimed at
 * exactly `[caret − runLength, caret)` and Lexical's `insertNodes` splices the
 * mention and space in, preserving any text that followed the caret.
 * `$createMentionNode` supplies the token form, so what reaches the wire is
 * `<@id> ` — exactly what the compat projection and every Discord client
 * parse.
 */
export function insertMention(editor: LexicalEditor, userId: string): void {
  insertTokenAtCaret(editor, mentionQueryOf, '@', () => $createMentionNode(userId));
}

/** The `#` twin: replace the `#query` run at the caret with a channel token. */
export function insertChannelMention(editor: LexicalEditor, channelId: string): void {
  insertTokenAtCaret(editor, channelQueryOf, '#', () => $createChannelMentionNode(channelId));
}

function insertTokenAtCaret(
  editor: LexicalEditor,
  queryOf: TriggerQueryOf,
  trigger: string,
  createNode: () => LexicalNode,
): void {
  editor.update(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;

    const anchor = selection.anchor;
    const anchorNode = anchor.getNode();
    if (!$isTextNode(anchorNode)) return;

    // Recompute from the LIVE state — the trigger reported from the previous
    // commit, and the document may have moved since.
    const before = $textBeforeCaret();
    if (before === null) return;
    const query = queryOf(before);
    if (query === null) return;
    // Invariant guard: the rule's match must be the run at the caret.
    if (!before.endsWith(`${trigger}${query}`)) return;

    // Walk the run's start back through text siblings if it predates the
    // caret's own node.
    let startNode = anchorNode;
    let startOffset = anchor.offset - (query.length + 1);
    while (startOffset < 0) {
      const prev = startNode.getPreviousSibling();
      if (prev === null || !$isTextNode(prev)) return; // not plain text — leave it alone
      startNode = prev;
      startOffset += prev.getTextContent().length;
    }
    selection.anchor.set(startNode.getKey(), startOffset, 'text');

    const space = $createTextNode(' ');
    selection.insertNodes([createNode(), space]);

    // Caret after the space, so the next keystroke continues the sentence IN
    // PLACE — never selectEnd(), which would jump past text that followed the
    // run. insertNodes already leaves the caret there; pinning it keeps the
    // contract explicit and immune to implementation drift.
    const placed = $getNodeByKey(space.getKey());
    if ($isTextNode(placed)) placed.select(1, 1);
  });
}

/**
 * Trigger detection + key routing. `enabled` lets the host suppress mentions
 * while another palette (slash / emoji) owns the keyboard.
 */
export function MentionTypeaheadPlugin({
  enabled,
  handlers,
  queryOf = mentionQueryOf,
}: {
  enabled: boolean;
  handlers: MentionHandlers;
  /** The trigger rule — `@` members by default; `channelQueryOf` for `#`. */
  queryOf?: TriggerQueryOf;
}): null {
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
      // The query lives BEFORE THE CARET, not at the document's tail (#129):
      // feed the pre-caret text to the same trailing-run rule, so the `$`
      // anchor lands on the caret wherever the caret sits.
      const query = editor.getEditorState().read(() => {
        const text = $textBeforeCaret();
        return text === null ? null : queryOf(text);
      });
      handlersRef.current.onText(query);
    });
  }, [editor, queryOf]);

  useEffect(() => {
    const armed = (): boolean => enabledRef.current && handlersRef.current.isActive();
    const consume = (e: KeyboardEvent | null): void => {
      // Defensive: the composer's own test seams (and any synthetic event)
      // dispatch partial objects, and a throw here would swallow the key.
      e?.preventDefault?.();
      e?.stopPropagation?.();
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
          // The palette only takes Enter when it actually inserts something —
          // with no highlighted row there is nothing to pick, and the key is
          // the composer's to send with.
          if (!handlersRef.current.onEnter()) return false;
          consume(e);
          return true;
        },
        COMMAND_PRIORITY_CRITICAL,
      ),
      // Tab is the unambiguous "complete it" key: Enter sends everywhere else
      // in this composer, so Tab is what a user reaches for when they do NOT
      // want to send yet. Discord spends Tab on the same job.
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

    return () => disposers.forEach((dispose) => dispose());
  }, [editor]);

  return null;
}
