/**
 * @cytale/markdown — public API (plan 004 M6).
 *
 * One inline markdown parser, two renderers: `apps/web` maps the parse tree
 * to DOM elements (its existing `renderInlineMarkdown`), `apps/mobile` maps
 * the same tree to nested `<Text>` runs. Parity is asserted from both sides
 * against this package — see the web `MessageItem` tests and the mobile
 * `markdown.parity` test, which executes the web renderer directly.
 *
 * The link-target policy (`isOpenableLinkHref`) lives here too: both
 * renderers must apply the SAME allowlist before a target reaches an opener.
 */

export {
  channelDisplayName,
  classifyInlineToken,
  imagePlainText,
  INLINE_NODE_TYPES,
  isEmphasisNode,
  mentionDisplayName,
  parseInlineMarkdown,
  parseMarkdownBlocks,
  previewText,
  resolveMentionTokens,
  tokenizeInline,
  type ChannelResolver,
  type EmphasisNode,
  type EmphasisType,
  type ImageNode,
  type InlineNode,
  type MarkdownBlock,
  type MentionResolver,
} from './parse.js';
export { isOpenableLinkHref } from './links.js';
