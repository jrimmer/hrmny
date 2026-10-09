/**
 * @cytale/mobile — native inline-markdown renderer (plan 004 M6).
 *
 * The renderer half of the shared parser: `@cytale/markdown` produces the
 * same token stream the web app renders to DOM (mentions, links, code spans,
 * bold, italic, literal text — including literal `:shortcode:` text, which
 * web's read path never expands), and this module maps it to React Native
 * "runs". A run is one styled `<Text>` child; the row nests them inside the
 * message body's `<Text>` so wrapping, selection, and newlines behave like a
 * single paragraph (RN has no inline elements — nesting is the idiom).
 *
 * No browser APIs and no HTML escaping: RN `<Text>` renders its string
 * children literally, so the parser's raw payload is already safe here.
 */
import {
  channelDisplayName,
  isEmphasisNode,
  isOpenableLinkHref,
  parseInlineMarkdown,
  timestampPlainText,
  type EmphasisType,
  type InlineNode,
  type MentionResolver,
} from '@cytale/markdown';

export type { MentionResolver };

/**
 * Re-exported for the row, which gates both the render and the `openURL` call
 * with it. The policy lives in `@cytale/markdown` next to the grammar that
 * produces the targets, so web's `<a href>` applies the same rule.
 */
export { isOpenableLinkHref };

/** The emphasis kinds a run can carry at once (`~~**x**~~` is bold AND strike). */
export type InlineMark = EmphasisType;

/** The run kinds: emphasis is not a kind but a set of {@link InlineRun.marks}. */
export type InlineRunKind = 'text' | 'mention' | 'channel' | 'code' | 'link';

/**
 * One renderable inline run. `kind` decides the run's own style; `marks` are
 * the emphasis spans it sits inside, outermost first — RN `<Text>` can nest,
 * but one flat run per leaf keeps the row's children a simple list, so the
 * shared tree's nesting is flattened here into a mark set per leaf.
 */
export interface InlineRun {
  kind: InlineRunKind;
  /** Display text — mentions already carry the `@name` (or `@id`) form. */
  text: string;
  /** Present on `link` runs: the target to open. */
  href?: string;
  /** Present on `mention` runs: the raw snowflake (a11y + tests). */
  userId?: string;
  /** Present when the run sits inside emphasis: `bold`, `italic`, `underline`, `strike`. */
  marks?: readonly InlineMark[];
}

/** Map parse-tree nodes to runs (mentions resolved to their display name). */
export function inlineRunsFromNodes(
  nodes: readonly InlineNode[],
  resolveMention?: MentionResolver,
  marks: readonly InlineMark[] = [],
): InlineRun[] {
  const withMarks = (run: InlineRun): InlineRun => (marks.length > 0 ? { ...run, marks } : run);
  return nodes.flatMap((node): InlineRun[] => {
    if (isEmphasisNode(node)) {
      // A mark already in force adds nothing (`**a **b** c**` is not bolder).
      const inner = marks.includes(node.type) ? marks : [...marks, node.type];
      return inlineRunsFromNodes(node.children, resolveMention, inner);
    }
    if (node.type === 'mention') {
      return [
        withMarks({
          kind: 'mention',
          text: `@${resolveMention?.(node.userId) ?? node.userId}`,
          userId: node.userId,
        }),
      ];
    }
    if (node.type === 'channel') {
      // `<#id>`: no channel resolver is wired on mobile yet — the id shows,
      // as an unresolved mention's does.
      return [withMarks({ kind: 'channel', text: channelDisplayName(node.channelId) })];
    }
    if (node.type === 'timestamp') {
      // `<t:…>`: this client has no ticking label yet, so a countdown (`R`)
      // shows the moment it counts to rather than a frozen "in 5 minutes".
      return [withMarks({ kind: 'text', text: timestampPlainText(node) })];
    }
    if (node.type === 'link') {
      return [withMarks({ kind: 'link', text: node.text, href: node.href })];
    }
    if (node.type === 'image') {
      // `![alt](https://…)`: this client does not display images yet, so the
      // image degrades to what web renders without a proxied copy — a link
      // to the source, labelled with its alt text (or the URL without one).
      return [withMarks({ kind: 'link', text: node.alt !== '' ? node.alt : node.src, href: node.src })];
    }
    return [withMarks({ kind: node.type, text: node.text })];
  });
}

/**
 * Parse + map in one step — what `MessageRow` calls per message body.
 * `parseInlineMarkdown` is the same function the web renderer consumes, so
 * the run list and the web element list are two views of one tree.
 */
export function inlineRuns(text: string, resolveMention?: MentionResolver): InlineRun[] {
  return inlineRunsFromNodes(parseInlineMarkdown(text), resolveMention);
}

