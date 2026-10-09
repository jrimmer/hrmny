/**
 * @cytale/web — minimal safe markdown renderer (U21 slice 2; parser
 * extracted to `@cytale/markdown` by plan 004 M6).
 *
 * The PARSE half lives in `@cytale/markdown` so the native client renders the
 * identical token stream; this file is the DOM renderer over that tree.
 *
 *   inline:  **bold**  *italic*  ***bold italic***  __underline__  ~~strike~~
 *            `code`  [text](url)  ![alt](https://…)  <@snowflake>  <#snowflake>
 *            <t:unix:R> (a timestamp; `R` counts live)  \* (escape)
 *   block:   ``` fenced code ```  (with an optional language)
 *            # .. ###### ATX headings
 *            > blockquotes (and >>> to the end), - / 1. lists, - [ ] tasks
 *
 * `renderMarkdown` is the message-body entry point and handles both. Code
 * fences are a BLOCK construct: routing them through the inline path — the
 * previous behaviour — emitted the fence backticks as literal text and boxed
 * the whole run as one multi-line `code` span. `renderInlineMarkdown` stays
 * the inline-only mapping that the cross-client parity test executes.
 *
 * It never injects raw HTML (no `dangerouslySetInnerHTML` with untrusted
 * markup); every token is escaped by React.
 *
 * #118 adds ONE optional hook: a caller may inject `renderPermalinkChip`, and
 * a link node that addresses a message on THIS instance (see
 * `instancePermalinkTarget`) then renders as a chip instead of a bare URL —
 * whether the ids are in the fragment (`#/…`) or behind a token
 * (`/m/<token>`, which the chip resolves). Injection rather than an import
 * because this file is the DOM half of the shared parse tree that the mobile
 * parity suite executes, so nothing web-specific (store, API client, session)
 * may enter that graph.
 */

import React from 'react';

import {
  isOpenableLinkHref,
  parseInlineMarkdown,
  parseMarkdownBlocks,
  type ImageNode,
  type InlineNode,
  type MarkdownBlock,
  type MentionResolver,
} from '@cytale/markdown';

import { MarkdownTimestamp } from './MarkdownTimestamp.js';
import { instancePermalinkTarget, type InstancePermalinkTarget } from './messagePermalink.js';

export type { MentionResolver };

/**
 * The attributes every message-body link carries. Shared with the permalink
 * chip's degraded state (#118) so a chip that cannot resolve is the SAME
 * element as the link it replaced — one definition, not two that drift.
 *
 * Deliberately a props helper rather than a `MarkdownLink` component: the
 * parity suite pins a link NODE to an `a` element type (mobile and web must
 * agree on the tree), and a wrapper component would add a layer both clients
 * would have to learn.
 */
export function linkAnchorProps(
  href: string,
  className = 'link',
): { href: string; className: string; target: string; rel: string } {
  return { href, className, target: '_blank', rel: 'noreferrer noopener' };
}

/**
 * How a caller renders a link that addresses THIS instance (#118) — a legacy
 * `#/…` address, or an unresolved `/m/<token>` — as a chip instead of a bare
 * URL. Returns null to fall back to the plain anchor, which is also the only
 * behaviour when no renderer is injected at all: a foreign link, a shorter
 * permalink form and an unresolvable target are unchanged.
 *
 * `key` is passed in rather than added by the caller: the returned element
 * lands in a children array, and only the creator can key it.
 */
export type PermalinkChipRenderer = (
  href: string,
  text: string,
  target: InstancePermalinkTarget,
  key: number,
) => React.ReactNode | null;

/**
 * How a caller renders a `<#channel>` token. Injected for the same reason as
 * the permalink chip: the pill reads the store, and this module is the DOM
 * half the mobile parity suite executes. `key` lands on the returned element.
 */
export type ChannelMentionRenderer = (channelId: string, key: number) => React.ReactNode;

/**
 * How a caller renders an `![alt](https://…)` image node. Injected for the
 * permalink chip's reason: the image loads through the server's media proxy,
 * whose signed URL rides the MESSAGE (`content_proxy_urls`), which this
 * module never sees. Returns null to fall back to the default — a plain link
 * to the source, labelled with the alt text (or the URL when there is none) —
 * which is also the only behaviour with no renderer (the mobile parity
 * harness, previews): a client that cannot load an image still shows where
 * it points.
 */
export type ImageRenderer = (node: ImageNode, key: number) => React.ReactNode | null;

/** Render a single parse-tree node to a React node (the DOM mapping). */
function renderNode(
  node: InlineNode,
  key: number,
  resolveMention?: MentionResolver,
  renderPermalinkChip?: PermalinkChipRenderer,
  renderChannelMention?: ChannelMentionRenderer,
  renderImage?: ImageRenderer,
): React.ReactNode {
  switch (node.type) {
    case 'mention': {
      const name = resolveMention?.(node.userId);
      return (
        <span key={key} className="mention" data-user-id={node.userId}>
          @{name ?? node.userId}
        </span>
      );
    }
    case 'channel':
      // `<#id>`: the host injects the pill (it needs the store, which may not
      // enter this module's graph); without one the token shows as `#id`.
      return (
        renderChannelMention?.(node.channelId, key) ?? (
          <span key={key} className="mention channel-mention" data-channel-id={node.channelId}>
            #{node.channelId}
          </span>
        )
      );
    case 'timestamp':
      return <MarkdownTimestamp key={key} node={node} />;
    case 'code':
      return (
        <code key={key} className="inline-code">
          {node.text}
        </code>
      );
    case 'image': {
      const image = renderImage?.(node, key);
      if (image !== null && image !== undefined) return image;
      // No renderer, or no proxied copy: the source as a plain link (the
      // parser admits http(s) sources only, so the policy always passes).
      return (
        <a key={key} {...linkAnchorProps(node.src)} data-link="image">
          {node.alt !== '' ? node.alt : node.src}
        </a>
      );
    }
    case 'link': {
      // A target the policy refuses is not a link: render its label as plain
      // text rather than an anchor that would hand `javascript:` (or any
      // other scheme) to the browser. The message body is peer-authored, so
      // the renderer is the last gate — the policy is the shared one in
      // `@cytale/markdown`, which the native client applies to `openURL`.
      if (!isOpenableLinkHref(node.href)) {
        return <React.Fragment key={key}>{node.text}</React.Fragment>;
      }
      // #118: a link that addresses a message ON THIS INSTANCE becomes a chip
      // — for a caller that supplied a chip renderer (the message list does;
      // the mobile parity harness does not), and only while that renderer
      // keeps it chipped. That includes the `/m/<token>` form, whose ids the
      // chip resolves; a token that does not resolve degrades there, so this
      // gate never waits on the network. Every other link renders exactly as
      // it always has.
      if (renderPermalinkChip !== undefined) {
        const target = instancePermalinkTarget(node.href);
        const chip =
          target === null ? null : renderPermalinkChip(node.href, node.text, target, key);
        if (chip !== null && chip !== undefined) return chip;
      }
      return (
        <a key={key} {...linkAnchorProps(node.href)}>
          {node.text}
        </a>
      );
    }
    case 'underline':
    case 'strike':
    case 'bold':
    case 'italic': {
      // Emphasis nests (`~~**x**~~` is bold inside strike): the span's
      // children render inside its element, with the same injected renderers.
      const children = node.children.map((child, i) =>
        renderNode(child, i, resolveMention, renderPermalinkChip, renderChannelMention, renderImage),
      );
      switch (node.type) {
        case 'underline':
          return (
            <span key={key} className="md-underline">
              {children}
            </span>
          );
        case 'strike':
          return (
            <s key={key} className="md-strike">
              {children}
            </s>
          );
        case 'bold':
          return (
            <strong key={key} className="bold">
              {children}
            </strong>
          );
        default:
          return (
            <em key={key} className="italic">
              {children}
            </em>
          );
      }
    }
    case 'text':
    default:
      // React escapes text nodes itself — HTML-entity-escaping here would
      // DOUBLE-encode and show users literal '&#39;' for an apostrophe.
      return <React.Fragment key={key}>{node.text}</React.Fragment>;
  }
}

/**
 * Render a message body as inline markdown. Returns React nodes; the caller
 * places them inside a `whitespace-pre-wrap` container so newlines survive.
 */
export function renderInlineMarkdown(
  text: string,
  resolveMention?: MentionResolver,
  renderPermalinkChip?: PermalinkChipRenderer,
  renderChannelMention?: ChannelMentionRenderer,
  renderImage?: ImageRenderer,
): React.ReactNode {
  return parseInlineMarkdown(text).map((node, i) =>
    renderNode(node, i, resolveMention, renderPermalinkChip, renderChannelMention, renderImage),
  );
}

/**
 * Render an ALREADY-PARSED message body.
 *
 * Split out of `renderMarkdown` so a caller that re-renders with unchanged
 * text can MEMOIZE the parse. The tokenization is a pure function of the
 * text alone (`parseMarkdownBlocks`), while this mapping depends on the
 * resolver and the chip renderer as well — so a row whose body did not
 * change (a roster name resolving, a reaction landing) can keep its tree and
 * re-map only this half.
 */
export function renderMarkdownBlocks(
  blocks: readonly MarkdownBlock[],
  resolveMention?: MentionResolver,
  renderPermalinkChip?: PermalinkChipRenderer,
  renderChannelMention?: ChannelMentionRenderer,
  renderImage?: ImageRenderer,
): React.ReactNode {
  return blocks.map((block, i) => {
    if (block.type === 'heading') {
      // A styled DIV, not an <h1>: a message is not a document section, and
      // emitting real headings per message would fill the accessibility
      // outline with noise (axe's heading-order rule included). Slack styles
      // headers the same way; the SIZE carries the level.
      return (
        <div key={`block-${i}`} className={`md-heading md-heading-${block.level}`}>
          {block.nodes.map((node, j) => renderNode(node, j, resolveMention, renderPermalinkChip, renderChannelMention, renderImage))}
        </div>
      );
    }
    if (block.type === 'blockquote') {
      // A real <blockquote>: a quote IS a quotation, unlike a heading-in-chat.
      return (
        <blockquote key={`block-${i}`} className="md-quote">
          {block.nodes.map((node, j) => renderNode(node, j, resolveMention, renderPermalinkChip, renderChannelMention, renderImage))}
        </blockquote>
      );
    }
    if (block.type === 'list') {
      const items = block.items.map((item, j) => (
        <li key={`item-${j}`} className="md-list-item">
          {item.task ? (
            <>
              <span className="md-task" aria-hidden="true">
                {item.task.checked ? '☑' : '☐'}
              </span>{' '}
              <span className="sr-only">{item.task.checked ? 'checked' : 'unchecked'} </span>
            </>
          ) : null}
          {item.nodes.map((node, k) => renderNode(node, k, resolveMention, renderPermalinkChip, renderChannelMention, renderImage))}
        </li>
      ));
      // Real list elements: a list IS a list, so the UA's markers and the
      // screen reader's item count are correct for free.
      return block.ordered ? (
        <ol key={`block-${i}`} className="md-list" start={block.start}>
          {items}
        </ol>
      ) : (
        <ul key={`block-${i}`} className="md-list">
          {items}
        </ul>
      );
    }
    if (block.type === 'code-block') {
      return (
        <pre
          key={`block-${i}`}
          className="code-block"
          data-lang={block.lang ?? undefined}
          data-testid="code-block"
        >
          {/* A code block's body is literal: no inline parsing, so mentions,
              links and emphasis inside it stay exactly as authored. */}
          <code>{block.text}</code>
        </pre>
      );
    }
    return (
      <React.Fragment key={`block-${i}`}>
        {block.nodes.map((node, j) => renderNode(node, j, resolveMention, renderPermalinkChip, renderChannelMention, renderImage))}
      </React.Fragment>
    );
  });
}

/**
 * Render a message body — inline markdown plus fenced code blocks. This is
 * what message bodies use; keep `whitespace-pre-wrap` on the caller's
 * container so newlines outside code blocks survive.
 *
 * A one-shot caller (a test, the mobile parity harness) parses and maps in
 * one go. A re-rendering caller should hold on to the parse tree and call
 * `renderMarkdownBlocks` instead — see MessageItem, which memoizes the tree
 * on the body text.
 */
export function renderMarkdown(
  text: string,
  resolveMention?: MentionResolver,
  renderPermalinkChip?: PermalinkChipRenderer,
  renderChannelMention?: ChannelMentionRenderer,
  renderImage?: ImageRenderer,
): React.ReactNode {
  return renderMarkdownBlocks(
    parseMarkdownBlocks(text),
    resolveMention,
    renderPermalinkChip,
    renderChannelMention,
    renderImage,
  );
}
