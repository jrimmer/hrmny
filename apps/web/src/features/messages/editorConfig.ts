/**
 * ONE Lexical configuration for every surface that edits a message body —
 * the composer (MessageCompose) and the in-place message editor
 * (InlineMessageEditor, also the touch sheet's editor).
 *
 * Owner report 2026-09-28: "I enter `1.` and a space right after that and the
 * `1.` disappears. But when I hit enter it's in the message posted to the
 * channel." The live Markdown shortcut DID fire — it built a real ordered
 * list — but both editors ran with `theme: {}`, and Tailwind's preflight
 * zeroes list markers, heading sizes, quote bars and code panels. The
 * structure existed and painted as plain text; the send then serialised it
 * back to `1. …`, which the timeline drew as a list.
 *
 * The theme below maps every node the shortcuts can create onto the SAME
 * classes the timeline's renderer (markdown.tsx) paints — `md-list`,
 * `md-heading-N`, `md-quote`, `code-block`, `inline-code`, `bold`, `italic`,
 * `md-strike`, `md-underline`, `link` — so a shortcut looks, the moment it
 * fires, like the message it will post. `.composer-md` (on each editor's
 * content element) scales the headings and block margins down to the
 * composer's single-line rhythm; the rules live in shell.css beside the
 * timeline's.
 */
import type { EditorThemeClasses, Klass, LexicalNode, LexicalNodeReplacement } from 'lexical';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { ListNode, ListItemNode } from '@lexical/list';
import { LinkNode, AutoLinkNode } from '@lexical/link';
import { CodeNode, CodeHighlightNode } from '@lexical/code';

import { MENTION_NODES } from './MentionNode.js';
import { CHAT_HEADING_REPLACEMENT, ChatHeadingNode } from './composerMarkdown.js';

/** Class on each editor's ContentEditable: scopes the compact overrides. */
export const COMPOSER_MD_CLASS = 'composer-md';

export const COMPOSER_THEME: EditorThemeClasses = {
  heading: {
    h1: 'md-heading md-heading-1',
    h2: 'md-heading md-heading-2',
    h3: 'md-heading md-heading-3',
    h4: 'md-heading md-heading-4',
    h5: 'md-heading md-heading-5',
    h6: 'md-heading md-heading-6',
  },
  quote: 'md-quote',
  list: {
    ul: 'md-list',
    ol: 'md-list',
    listitem: 'md-list-item',
    listitemChecked: 'md-check-item md-check-item-checked',
    listitemUnchecked: 'md-check-item',
    nested: { listitem: 'md-list-item-nested' },
  },
  code: 'code-block',
  link: 'link',
  text: {
    bold: 'bold',
    italic: 'italic',
    underline: 'md-underline',
    strikethrough: 'md-strike',
    underlineStrikethrough: 'md-underline md-strike',
    code: 'inline-code',
  },
};

/** Every node a Markdown shortcut, a draft or an edited message can create. */
export const COMPOSER_NODES: ReadonlyArray<Klass<LexicalNode> | LexicalNodeReplacement> = [
  HeadingNode,
  ChatHeadingNode,
  CHAT_HEADING_REPLACEMENT,
  QuoteNode,
  ListNode,
  ListItemNode,
  LinkNode,
  AutoLinkNode,
  CodeNode,
  CodeHighlightNode,
  ...MENTION_NODES,
];

/** The initial config both editors mount with; only the namespace differs. */
export function composerEditorConfig(namespace: string) {
  return {
    namespace,
    theme: COMPOSER_THEME,
    nodes: [...COMPOSER_NODES],
    onError: (err: Error) => {
      // eslint-disable-next-line no-console
      console.error(err);
    },
  };
}
