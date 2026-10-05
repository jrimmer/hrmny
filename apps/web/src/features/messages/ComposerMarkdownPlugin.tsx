/**
 * Markdown behaviour shared by the composer and the message editor: the live
 * shortcuts, the keys, paste, and the normalisation that keeps the editor's
 * tree inside what the timeline can draw (composerMarkdown.ts has the
 * grammar; this is the interaction).
 *
 * Keys (Enter always sends or saves — its handlers sit above these):
 *
 *   | where        | Shift+Enter                     | leaves the block                   |
 *   |--------------|---------------------------------|------------------------------------|
 *   | paragraph    | a new line (its own paragraph,  | —                                  |
 *   |              | so it can start a list or quote)|                                    |
 *   | list item    | a new item                      | Shift+Enter on an empty item       |
 *   | heading      | a new plain line                | at once (a heading is one line)    |
 *   | quote        | a new quoted line               | Shift+Enter on an empty last line  |
 *   | code block   | a new code line, indent kept    | Shift+Enter on two empty last lines|
 *
 *   Backspace at the very start of a block the shortcuts made turns it back
 *   into the text that made it: a heading into `# Title`, a quote into
 *   `> text`, a code block into "```lang code", the FIRST item of a list into
 *   `1. item` / `- item` / `[ ] item` (the rest of the list stays a list). In
 *   a later item it undoes the Shift+Enter that made the item: an empty item
 *   goes, a non-empty one joins the item above.
 *
 *   Ctrl+Z straight after a shortcut restores the literal text it replaced
 *   (`1. `, `**bold**`): every shortcut is its own undo step.
 *
 * Paste: plain text is read as Markdown with the timeline's grammar (so
 * pasting a message posts what it said); rich HTML keeps Lexical's import,
 * then the normalisation below trims it to the supported set. Files and
 * pasted images are left to the composer's intake.
 */
import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext.js';
import { CheckListPlugin } from '@lexical/react/LexicalCheckListPlugin.js';
import {
  $addUpdateTag,
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isLineBreakNode,
  $isParagraphNode,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_LOW,
  COMMAND_PRIORITY_NORMAL,
  IS_BOLD,
  IS_CODE,
  IS_ITALIC,
  IS_STRIKETHROUGH,
  IS_UNDERLINE,
  KEY_BACKSPACE_COMMAND,
  KEY_ENTER_COMMAND,
  PASTE_COMMAND,
  RootNode,
  TextNode,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  type RangeSelection,
} from 'lexical';
import { $isHeadingNode, $isQuoteNode } from '@lexical/rich-text';
import {
  $createListItemNode,
  $createListNode,
  $handleListInsertParagraph,
  $isListItemNode,
  $isListNode,
  registerList,
  type ListItemNode,
  type ListNode,
} from '@lexical/list';
import { $isLinkNode } from '@lexical/link';
import { $isCodeNode } from '@lexical/code';
import { registerMarkdownShortcuts } from '@lexical/markdown';

import { $fitMarks, $linkMarks, $markdownToNodes, COMPOSER_TRANSFORMERS } from './composerMarkdown.js';

// ---------------------------------------------------------------------------
// Normalisation: keep the tree inside what the timeline can draw
// ---------------------------------------------------------------------------

const SUPPORTED_FORMATS = IS_BOLD | IS_ITALIC | IS_UNDERLINE | IS_STRIKETHROUGH | IS_CODE;

/**
 * Keep a text node inside what the timeline can draw. Emphasis COMBINES
 * (bold, italic, underline and strike nest on the wire as they do in
 * Discord), and inline code may sit inside any of them; what the grammar
 * cannot say is taken off by `$fitMarks` (an underline glued to a word, a
 * `*` mark running straight into another). Highlight, sub/superscript, case
 * transforms and inline styles (a rich paste's colours) have no Markdown at
 * all and are dropped; a link's label is marked as a whole or not at all
 * (`**[text](url)**`), never code.
 */
export function $clampTextFormat(node: TextNode): void {
  if (node.getType() !== 'text') return;
  const parent = node.getParent();
  if ($isCodeNode(parent)) {
    if (node.getFormat() !== 0) node.setFormat(0);
    return;
  }
  const format = node.getFormat();
  let next = format & SUPPORTED_FORMATS;
  if ($isLinkNode(parent)) next = $linkMarks(parent);
  if (next !== format) node.setFormat(next);
  if (node.getStyle() !== '') node.setStyle('');
  const block = $isLinkNode(parent) ? parent.getParent() : parent;
  if (block !== null && $isElementNode(block) && !$isCodeNode(block)) $fitMarks(block);
}

const TASK_PREFIX = /^[ \t]*\[([ xX])\] /;

/** Keep a caret that sat in `node` on the same character after a cut. */
function $shiftSelection(node: TextNode, removed: number): void {
  const sel = $getSelection();
  if (!$isRangeSelection(sel)) return;
  for (const point of [sel.anchor, sel.focus]) {
    if (point.key === node.getKey()) point.set(point.key, Math.max(0, point.offset - removed), 'text');
  }
}

/** A list's items, with any nested list hoisted after its parent item. */
function $flattenList(list: ListNode): void {
  for (const item of list.getChildren()) {
    if (!$isListItemNode(item)) continue;
    let anchor: ListItemNode = item;
    for (const child of item.getChildren()) {
      if (!$isListNode(child)) continue;
      $flattenList(child);
      for (const inner of child.getChildren()) {
        if (!$isListItemNode(inner)) continue;
        anchor.insertAfter(inner);
        anchor = inner;
      }
      child.remove();
    }
    if (item.getChildrenSize() === 0 && anchor !== item) item.remove();
  }
}

/** A line break inside a list item, heading or paragraph splits it (one line each). */
function $splitBreaks(block: ElementNode, makeNext: () => ElementNode): void {
  const breaks = block.getChildren().filter($isLineBreakNode);
  for (const br of breaks.reverse()) {
    const next = makeNext();
    const tail = br.getNextSiblings();
    br.getParentOrThrow().insertAfter(next);
    next.append(...tail);
    br.remove();
  }
}

/** A bullet list whose every item starts `[ ] ` / `[x] ` is a task list. */
function $promoteTaskList(list: ListNode): void {
  if (list.getListType() !== 'bullet') return;
  const items = list.getChildren().filter($isListItemNode);
  if (items.length === 0) return;
  const heads = items.map((item) => item.getFirstChild());
  if (!heads.every((h) => $isTextNode(h) && h.getFormat() === 0 && TASK_PREFIX.test(h.getTextContent()))) return;
  list.setListType('check');
  items.forEach((item, i) => {
    const head = heads[i] as TextNode;
    const m = TASK_PREFIX.exec(head.getTextContent())!;
    item.setChecked(m[1] !== ' ');
    const rest = head.getTextContent().slice(m[0].length);
    $shiftSelection(head, m[0].length);
    if (rest === '') {
      const sel = $getSelection();
      const caretHere = $isRangeSelection(sel) && sel.anchor.key === head.getKey();
      head.remove();
      if (caretHere) item.select(0, 0);
    } else head.setTextContent(rest);
  });
}

export function $normalizeRoot(root: RootNode): void {
  for (const child of root.getChildren()) {
    if ($isListNode(child)) {
      $flattenList(child);
      for (const item of child.getChildren()) {
        if ($isListItemNode(item)) {
          $splitBreaks(item, () => $createListItemNode(child.getListType() === 'check' ? false : undefined));
        }
      }
      $promoteTaskList(child);
    } else if ($isHeadingNode(child) || $isParagraphNode(child)) {
      // One line per paragraph, as Shift+Enter makes them (a rich paste can
      // bring `<br>`s): a line can then start a list, and a blank line is a
      // blank paragraph everywhere.
      $splitBreaks(child, () => $createParagraphNode());
    }
  }
  // Directly adjacent lists of one type, and adjacent quotes, are ONE block
  // in the timeline — show them as one.
  let prev: LexicalNode | null = null;
  for (const child of root.getChildren()) {
    if ($isListNode(prev) && $isListNode(child) && prev.getListType() === child.getListType()) {
      prev.append(...child.getChildren());
      child.remove();
      continue;
    }
    if ($isQuoteNode(prev) && $isQuoteNode(child)) {
      prev.append($createLineBreakNode(), ...child.getChildren());
      child.remove();
      continue;
    }
    prev = child;
  }
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** The block element the caret is in (list item, heading, quote, code, paragraph). */
function $blockOf(node: LexicalNode): ElementNode | null {
  let cur: LexicalNode | null = node;
  while (cur !== null) {
    if ($isListItemNode(cur) || $isHeadingNode(cur) || $isQuoteNode(cur) || $isCodeNode(cur) || $isParagraphNode(cur)) {
      return cur as ElementNode;
    }
    cur = cur.getParent();
  }
  return null;
}

/** True when a collapsed caret sits before everything in `block`. */
function $atBlockStart(sel: RangeSelection, block: ElementNode): boolean {
  if (!sel.isCollapsed() || sel.anchor.offset !== 0) return false;
  let cur: LexicalNode | null = sel.anchor.getNode();
  while (cur !== null && cur !== block) {
    if (cur.getPreviousSibling() !== null) return false;
    cur = cur.getParent();
  }
  return cur === block;
}

/** True when a collapsed caret sits after everything in `block`. */
function $atBlockEnd(sel: RangeSelection, block: ElementNode): boolean {
  if (!sel.isCollapsed()) return false;
  const node = sel.anchor.getNode();
  if (node === block) return sel.anchor.offset === block.getChildrenSize();
  if ($isTextNode(node) && sel.anchor.offset !== node.getTextContentSize()) return false;
  let cur: LexicalNode | null = node;
  while (cur !== null && cur !== block) {
    if (cur.getNextSibling() !== null) return false;
    cur = cur.getParent();
  }
  return cur === block;
}

/** Replace `block` by a paragraph that starts with `marker`, caret after it. */
function $revertTo(block: ElementNode, marker: string): ElementNode {
  const paragraph = $createParagraphNode();
  const text = $createTextNode(marker);
  paragraph.append(text, ...block.getChildren());
  block.replace(paragraph);
  text.select(marker.length, marker.length);
  return paragraph;
}

function $revertListItem(item: ListItemNode, list: ListNode): void {
  const items = list.getChildren().filter($isListItemNode);
  const index = items.indexOf(item);
  const type = list.getListType();
  const marker =
    type === 'number' ? `${list.getStart() + index}. ` : type === 'check' ? `[${item.getChecked() ? 'x' : ' '}] ` : '- ';
  const paragraph = $createParagraphNode();
  const text = $createTextNode(marker);
  paragraph.append(text, ...item.getChildren());
  const after = items.slice(index + 1);
  list.insertAfter(paragraph);
  if (after.length > 0) {
    const rest = $createListNode(type, type === 'number' ? list.getStart() + index + 1 : 1);
    rest.append(...after);
    paragraph.insertAfter(rest);
  }
  item.remove();
  if (list.getChildrenSize() === 0) list.remove();
  text.select(marker.length, marker.length);
}

export function $handleBackspace(): boolean {
  const sel = $getSelection();
  if (!$isRangeSelection(sel) || !sel.isCollapsed()) return false;
  const block = $blockOf(sel.anchor.getNode());
  if (block === null || $isParagraphNode(block) || !$atBlockStart(sel, block)) return false;
  if ($isListItemNode(block)) {
    const list = block.getParent();
    if (!$isListNode(list)) return false;
    const prev = block.getPreviousSibling();
    if (!$isListItemNode(prev)) {
      $revertListItem(block, list);
      return true;
    }
    // A later item: undo the Shift+Enter that made it.
    const empty = block.getChildrenSize() === 0;
    const children = block.getChildren();
    const end = prev.getChildrenSize();
    prev.append(...children);
    block.remove();
    if (empty || children.length === 0) prev.selectEnd();
    else prev.select(end, end);
    return true;
  }
  if ($isHeadingNode(block)) {
    $revertTo(block, '#'.repeat(Number(block.getTag().slice(1))) + ' ');
    return true;
  }
  if ($isQuoteNode(block)) {
    $revertTo(block, '> ');
    return true;
  }
  if ($isCodeNode(block)) {
    $revertTo(block, '```' + (block.getLanguage() ?? '') + ' ');
    return true;
  }
  return false;
}

export function $handleShiftEnter(): boolean {
  const sel = $getSelection();
  if (!$isRangeSelection(sel) || !sel.isCollapsed()) return false;
  const block = $blockOf(sel.anchor.getNode());
  if (block === null) return false;
  if ($isParagraphNode(block)) {
    // A new line is a new paragraph (the wire is the same `\n` either way),
    // so a line can start a list, a quote or a heading: "Steps:" then
    // Shift+Enter then `1. ` makes a list.
    sel.insertParagraph();
    return true;
  }
  if ($isListItemNode(block)) {
    // An empty item leaves the list; otherwise a new item.
    if (!$handleListInsertParagraph()) sel.insertParagraph();
    return true;
  }
  if ($isHeadingNode(block) || $isCodeNode(block)) {
    // A heading: the next line is a paragraph. A code block: a new line with
    // its indent, or out after two empty last lines (CodeNode's own rule).
    sel.insertParagraph();
    return true;
  }
  if ($isQuoteNode(block)) {
    const last = block.getLastChild();
    if ($isLineBreakNode(last) && $atBlockEnd(sel, block)) {
      last.remove();
      const paragraph = $createParagraphNode();
      block.insertAfter(paragraph);
      paragraph.select();
      return true;
    }
    return false; // a new quoted line (the rich-text line break)
  }
  return false;
}

// ---------------------------------------------------------------------------
// Paste
// ---------------------------------------------------------------------------

/** HTML that carries structure we read — anything else pastes as its text. */
const SEMANTIC_HTML = /<(h[1-6]|ul|ol|li|blockquote|pre|strong|b|em|i|s|del|strike|a|code)[\s>]/i;

export function $pasteMarkdown(text: string): boolean {
  const sel = $getSelection();
  if (!$isRangeSelection(sel)) return false;
  if ($blockOf(sel.anchor.getNode()) !== null && $isCodeNode($blockOf(sel.anchor.getNode()))) return false;
  const nodes = $markdownToNodes(text);
  if (nodes.length === 0) return true;
  const only = nodes[0]!;
  // One line of prose lands inline at the caret; anything more as blocks.
  if (nodes.length === 1 && $isParagraphNode(only)) sel.insertNodes(only.getChildren());
  else sel.insertNodes(nodes);
  return true;
}

function onPaste(event: ClipboardEvent | KeyboardEvent | InputEvent): boolean {
  if (!('clipboardData' in event) || event.clipboardData === null) return false;
  const data = event.clipboardData;
  if (data.files.length > 0) return false; // the composer's intake stages files
  const html = data.getData('text/html');
  if (/<img\s/i.test(html)) return false;
  if (html !== '' && SEMANTIC_HTML.test(html)) return false; // rich paste → Lexical
  const text = data.getData('text/plain');
  if (text === '') return false;
  // Command listeners already run inside an editor update.
  if (!$pasteMarkdown(text)) return false;
  event.preventDefault();
  return true;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * `registerMarkdownShortcuts`, with each transform on its OWN undo step: the
 * shortcut's update is tagged `history-push`, so Ctrl+Z straight after it
 * lands on the literal text it replaced (`1. `) rather than merging back
 * through the typing. Only updates that actually changed the text are
 * tagged — the shortcut checker runs an update on every keystroke.
 */
function registerShortcutsWithUndoSteps(editor: LexicalEditor): () => void {
  const proxy = new Proxy(editor, {
    get(target, prop, receiver) {
      if (prop === 'update') {
        return (fn: () => void, options?: Parameters<LexicalEditor['update']>[1]) =>
          target.update(() => {
            const before = $getRoot().getTextContent();
            fn();
            if ($getRoot().getTextContent() !== before) $addUpdateTag('history-push');
          }, options);
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return registerMarkdownShortcuts(proxy, COMPOSER_TRANSFORMERS);
}

export function registerComposerMarkdown(editor: LexicalEditor): () => void {
  const disposers = [
    registerList(editor),
    registerShortcutsWithUndoSteps(editor),
    editor.registerNodeTransform(TextNode, $clampTextFormat),
    editor.registerNodeTransform(RootNode, $normalizeRoot),
    editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event: KeyboardEvent | null) => {
        if (!event?.shiftKey) return false;
        if (!$handleShiftEnter()) return false;
        event.preventDefault();
        return true;
      },
      COMMAND_PRIORITY_NORMAL,
    ),
    editor.registerCommand(
      KEY_BACKSPACE_COMMAND,
      (event: KeyboardEvent) => {
        if (!$handleBackspace()) return false;
        event.preventDefault();
        return true;
      },
      COMMAND_PRIORITY_LOW,
    ),
    editor.registerCommand(PASTE_COMMAND, (event) => onPaste(event), COMMAND_PRIORITY_LOW),
  ];
  return () => disposers.forEach((d) => d());
}

/** Everything above, plus Lexical's check-list toggling, for one editor. */
export function ComposerMarkdownPlugin() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => registerComposerMarkdown(editor), [editor]);
  return <CheckListPlugin />;
}

