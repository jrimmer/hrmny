/**
 * @cytale/web — a one-line message excerpt with its mention tokens rendered
 * as the SAME pills the message body uses (UI consistency, 2026-09-27).
 *
 * Previews outside the timeline — search hits, inbox rows — used to show the
 * wire's raw `<#snowflake>` (and, in search, `<@snowflake>`) because only the
 * body path had resolvers. This is the preview twin of the body renderer:
 * user tokens become `.mention` pills, channel tokens `.mention.channel-mention`
 * pills, and the rest is the body's plain text: markup the timeline renders
 * is dropped through the markdown package's `previewText` (the parser the
 * body uses), never shown raw — the inbox read `**Confirmed working:**` and
 * backticks where the message rendered them (owner report 2026-09-28). A
 * preview is one line, so formatting itself is not reproduced. The pills are SPANS, never links: excerpts live inside a link or
 * a listbox option already, and a nested interactive element is invalid.
 *
 * The display names come from the markdown package's own formatters
 * (`mentionDisplayName` / `channelDisplayName` — the functions behind
 * `resolveMentionTokens`), so a preview and the reply-context snippet cannot
 * spell a name differently. A channel the resolver cannot name reads
 * `#unknown-channel`, exactly like ChannelMentionPill: the store only holds
 * channels the reader can see, so a preview never leaks a private name.
 */

import type { ReactNode } from 'react';

import { mentionDisplayName, previewText, resolveMentionTokens } from '@cytale/markdown';

/** `<@id>`, `<@!id>` (the nickname form the server also records), `<#id>`. */
const TOKEN_RE = /<(@!?|#)(\d{1,19})>/g;

export type ExcerptSegment =
  | { kind: 'text'; text: string }
  | { kind: 'user'; id: string }
  | { kind: 'channel'; id: string };

/** Split an excerpt into text runs and mention tokens (order preserved). */
export function splitMentionTokens(text: string): ExcerptSegment[] {
  const out: ExcerptSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(TOKEN_RE)) {
    const at = match.index ?? 0;
    if (at > cursor) out.push({ kind: 'text', text: text.slice(cursor, at) });
    out.push(match[1] === '#' ? { kind: 'channel', id: match[2]! } : { kind: 'user', id: match[2]! });
    cursor = at + match[0].length;
  }
  if (cursor < text.length) out.push({ kind: 'text', text: text.slice(cursor) });
  return out;
}

export interface ExcerptResolvers {
  /** User id → display name (undefined leaves the id, as the body pill does). */
  resolveUser?: (userId: string) => string | undefined;
  /** Channel id → name (undefined renders `#unknown-channel`). */
  resolveChannel?: (channelId: string) => string | undefined;
}

function channelLabel(id: string, resolveChannel?: (id: string) => string | undefined): string {
  const name = resolveChannel?.(id);
  return name ? `#${name}` : '#unknown-channel';
}

/**
 * The excerpt as plain text (tokens resolved) — for aria-labels and titles,
 * where a pill cannot go. Same names as the pills.
 */
export function excerptPlainText(text: string, { resolveUser, resolveChannel }: ExcerptResolvers): string {
  return resolveMentionTokens(
    previewText(text),
    resolveUser,
    (id) => channelLabel(id, resolveChannel).slice(1),
  );
}

export interface MentionExcerptProps extends ExcerptResolvers {
  text: string;
  /** How a plain text run renders (search highlights its terms). */
  renderText?: (text: string, index: number) => ReactNode;
}

export function MentionExcerpt({ text, resolveUser, resolveChannel, renderText }: MentionExcerptProps) {
  return (
    <>
      {splitMentionTokens(previewText(text)).map((seg, i) => {
        if (seg.kind === 'text') {
          return renderText ? <span key={i}>{renderText(seg.text, i)}</span> : <span key={i}>{seg.text}</span>;
        }
        if (seg.kind === 'user') {
          return (
            <span key={i} className="mention" data-user-id={seg.id} data-testid="excerpt-mention">
              {mentionDisplayName(seg.id, resolveUser)}
            </span>
          );
        }
        const label = channelLabel(seg.id, resolveChannel);
        return (
          <span
            key={i}
            className={`mention channel-mention${label === '#unknown-channel' ? ' is-unknown' : ''}`}
            data-channel-id={seg.id}
            data-testid="excerpt-channel-mention"
          >
            {label}
          </span>
        );
      })}
    </>
  );
}
