/**
 * @cytale/web — message item rendering (U21 slice 2, UI polish slice 2, U12).
 *
 * Renders one message: avatar, author row, inline markdown body, @mentions
 * (highlight + link), attachments (image/file from the U21a upload path),
 * and hover actions (react, reply, edit-if-author, delete-if-author-or-
 * MANAGE_MESSAGES). WCAG 2.1 AA: hover actions are also reachable via
 * keyboard focus (the action buttons are real buttons, not pointer-only).
 *
 * U12 attribution/embeds (render half): the author row carries the shared
 * machine seal (BOT/AGENT/WEBHOOK from the roster projection's `kind`, parent
 * named via title/aria) between the author name and the timestamp; webhook
 * messages override the displayed name with `author_override.username`;
 * a message's `embeds` render as simple cards below the content (text plus
 * lazy image/thumbnail media — token-disciplined, untrusted-JSON-safe).
 *
 * Discord-grade styling (corpus §2/§3b):
 *   - avatar 40px radius-full; author text-primary font-semibold; timestamp
 *     text-xs muted; compact continuation lines 24-27px (grouped messages
 *     hide avatar+author, indent by the avatar column via the `grouped` prop).
 *   - hover toolbar: absolute top-right, surface-strong + border-line,
 *     rounded-lg (8-10px), ~37px tall; quick reactions | divider | actions;
 *     destructive delete tinted danger; 40×40 hit areas.
 *   - mention highlight: accent wash + 2px left bar.
 *
 * Reactions (Discord interaction model): a chip row beneath content when the
 * message carries `reactions` (absent = no row; the user's own optimistic
 * send placeholder never shows one). Chips toggle own reactions optimistically
 * (aria-pressed = me-state, filled vs outline), a "+" picker at the row's end
 * offers the FIXED 8-emoji palette, offline disables the affordances, and a
 * failed toggle surfaces an inline role=alert with Retry/Dismiss.
 *
 * Components plan U4 (R7/R8): machine-authored messages render their action
 * rows (buttons / string selects) via MessageComponents, at the BOTTOM of the
 * message body — below the embeds and the attachments, directly above the
 * reaction row. U4's R7 text claimed the opposite ("above the embeds —
 * Discord's order") while its own Files line named the correct slot;
 * corrected 2026-09-18 on the owner's report ("move the option buttons to the
 * underside of the box asking the question"). Clicks run through the
 * store-scoped useComponentClick pending machine (see MessageComponents.tsx).
 */

import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { Attachment, PrincipalKind } from '@cytale/domain';
import { parseMarkdownBlocks, previewText, resolveMentionTokens } from '@cytale/markdown';
import { defaultStore, type StateStore } from '@cytale/state';

import { api } from '../auth/session.js';
import { formatClock, formatDateTime, formatMessageStamp } from '../../app/ui/time.js';
import { attachmentTarget, mediaProxyUrl } from '../../app/origin.js';
import { Avatar as SharedAvatar, kindTitle } from '../../app/ui/UserAvatar.js';
import { resolveAuthor } from './authorIdentity.js';
import { ThreadIcon } from '../../app/ui/icons.js';
import { ImageLightbox } from './ImageLightbox.js';
import { useOnlineStatus } from '../../app/pwa/useOnlineStatus.js';

import {
  renderMarkdown,
  renderMarkdownBlocks,
  type MentionResolver,
  type ChannelMentionRenderer,
  type ImageRenderer,
  type PermalinkChipRenderer,
} from './markdown.js';
import { InlineMessageEditor } from './InlineMessageEditor.js';
import { MessageComponents } from './MessageComponents.js';
import { PermalinkChip } from './permalinkChip.js';
import { ChannelMentionPill, channelNameOf } from './ChannelMentionPill.js';
import { mentionTagFor } from './mentionCandidates.js';
import { MarkPicker } from './MarkPicker.js';
import { ReactionPicker } from './ReactionPicker.js';
import {
  messageActionsPlacement,
  type MessageActionsPlacement,
} from './messageActionsPlacement.js';
import type { EmbedField, EmbedMediaRef, MessageEmbed, MessageWithBots } from './types.js';
import { FailedSendBar, PendingSendMark, isLocalSendRow } from './SendStatus.js';
import { isGeneratedThreadName } from '../threads/threadRows.js';

/** How far the hover pill overlaps its own row (shell.css `.message-actions`). */
const ACTIONS_OVERLAP = 6;

export interface MessageItemProps {
  message: MessageWithBots;
  /** Resolved author display name (nickname/username); falls back to the id. */
  authorName?: string;
  /** The author's TAG (username), shown muted after the name. Absent → read
   *  from the store's roster; unknown → no tag. */
  authorTag?: string;
  /** Author's uploaded avatar (roster row); absent → the hue tile. */
  authorAvatarUrl?: string | null;
  /** Host-resolved display name for the reply-context author (see
   *  ReplyContextLine) — beats the wire username when the roster knows it. */
  replyAuthorName?: string;
  /** Reply-context author's uploaded avatar (roster row). */
  replyAuthorAvatarUrl?: string | null;
  /** Resolves `<@snowflake>` mention tokens to display names (roster +
   *  session self); unresolved ids render as the raw snowflake pill. */
  resolveMention?: MentionResolver;
  /** Author's roster principal kind (U12 attribution); absent → no badge. */
  authorKind?: PrincipalKind | null;
  /** Owning human's display name for machine principals ("via <name>"). */
  authorParentName?: string | null;
  /** Current user's snowflake id (for author-scoped actions). */
  currentUserId: string | null;
  /** True when the current user holds MANAGE_MESSAGES in this channel. */
  canManageMessages?: boolean;
  /** Called with the message id when the user clicks Reply. */
  onReply?: (message: MessageWithBots, opts?: { suppressPing?: boolean }) => void;
  /** Called with the message id AND its raw content (the host prefills the
   *  app-styled edit dialog). */
  onEdit?: (messageId: string, content: string) => void;
  /** Called with the message id when the user clicks Delete. */
  onDelete?: (messageId: string) => void;
  /** Called with the message id when the user clicks React. */
  onReact?: (messageId: string) => void;
  /**
   * Called when the user clicks Copy Link (#114). The host MINTS the link
   * since #118 (one `POST /permalinks`, keyed server-side) and writes the
   * clipboard, so this row stays presentational. Wired for EVERY message —
   * a permalink is not author-scoped, unlike edit/delete.
   */
  onCopyLink?: (message: MessageWithBots) => void;
  /**
   * Called with (messageId, emoji) when a chip is toggled or the hover
   * toolbar's picker picks — the parent owns the optimistic add/remove
   * semantics (Discord: click a chip you reacted with to un-react).
   */
  onToggleReaction?: (messageId: string, emoji: string) => void;
  /** Start-thread intent: the id AND the raw content (the host derives the
   *  thread name from the seed message — no title prompt). */
  onStartThread?: (messageId: string, content: string) => void;
  /**
   * The thread this message SEEDS (undefined = none). Renders the
   * discoverability indicator under the content: "🧵 name · N replies ·
   * last activity" — the return path after the dock is closed.
   */
  thread?: { id: string; name: string; messageCount: number; latestReplyAt: string | null } | null;
  /** Opens the thread dock for the indicator's thread. */
  onOpenThread?: (threadId: string) => void;
  /** Inline edit mode (Discord/Slack): the row becomes the editor. */
  editing?: boolean;
  /** Persists the inline edit (optimistic at the hook layer). */
  onSaveEdit?: (messageId: string, content: string) => Promise<void>;
  /** Cancels the inline edit. */
  onCancelEdit?: () => void;
  /** Active reaction-toggle error for THIS message, if any (inline retry). */
  reactionError?: { emoji: string; message: string } | null;
  /** Retry the failed reaction toggle. */
  onRetryReaction?: (messageId: string, emoji: string) => void;
  /** Dismiss the reaction error affordance. */
  onDismissReaction?: () => void;
  /** Optional compact mode (thread side-panel / continuation cadence). */
  compact?: boolean;
  /**
   * Where the hover toolbar renders. Defaults to the resolved config
   * (messageActionsPlacement.ts); injectable so tests can pin either
   * placement.
   */
  actionsPlacement?: MessageActionsPlacement;
  /** True when this message is grouped under the previous author (hides
   *  avatar + author row; renders the 24-27px continuation line). */
  grouped?: boolean;
  /**
   * True when this row STARTS an author group directly under another group
   * (owner, 2026-09-29: "a bit of padding between the last messages and the
   * message from another author"). The gap is PADDING on an outer wrapper,
   * never a margin: a child margin collapses out through react-virtuoso's
   * item wrapper and escapes its measured height, which reads as rows
   * overlapping or the list jumping. The wrapper carries no background, so
   * the hover tint and the mention accent stay on the message itself.
   * MessageList leaves it off after a day or "new messages" divider, which
   * already provides the space.
   */
  groupGap?: boolean;
  /**
   * U3 touch actions: called when the row is LONG-PRESSED on a coarse
   * pointer (~450ms hold, canceled by >10px movement / scroll / early
   * pointerup). The row only REPORTS the gesture — the sheet state lives
   * above the react-virtuoso windowing boundary (MessageList hosts it), so
   * a rewindow that unmounts this row can never close an open sheet.
   * Absent (thread-panel rows) → no hold is armed. Fine pointers never
   * fire it: the hover toolbar is the desktop affordance, unchanged.
   */
  onLongPress?: (message: MessageWithBots) => void;
  /** U17 store for the component-click pending machine (defaults to the
   * module store; MessageList/ThreadSidePanel inject theirs). */
  store?: StateStore;
  /** Read-only viewer (no send right — components plan U4): action-row
   * controls pre-disabled with an explanatory title. */
  viewOnly?: boolean;
  /** #54: offer "Remind me…" on this row (channel rows the viewer can post
   * in; thread replies are out of v1). */
  canRemind?: boolean;
}

/**
 * The row's timestamp. The formatting lives in app/ui/time.ts, whose
 * formatters are cached — this used to be a per-call `toLocaleTimeString`,
 * which profiled as the hottest function in the app during a wheel scroll
 * through history (2026-09-12).
 */
function formatTime(iso: string): string {
  return formatMessageStamp(iso);
}

function isImage(att: Attachment): boolean {
  return /^image\/(png|jpeg|gif|webp|svg\+xml)$/.test(att.content_type);
}

/**
 * The box a media element occupies BEFORE its bytes arrive (#10).
 *
 * An `<img loading="lazy">` with no dimensions lays out at 0px and grows when
 * it decodes — every image row in the window changed height after the list
 * had measured it, which shifted a reader scrolled up and fought the bottom
 * pin. The box is therefore sized up front: with the intrinsic width/height
 * the server recorded (attachments carry them when the upload parsed as an
 * image; embeds may carry producer hints) it is the image's own aspect ratio,
 * scaled down to fit `maxWidth` × `maxHeight` and never up; without them it
 * is a fixed `fallbackHeight` box, so the row's height is final either way.
 */
export function mediaBoxStyle(
  width: unknown,
  height: unknown,
  maxWidth: number,
  maxHeight: number,
  fallbackHeight: number,
): React.CSSProperties {
  const w = typeof width === 'number' && Number.isFinite(width) && width > 0 ? width : null;
  const h = typeof height === 'number' && Number.isFinite(height) && height > 0 ? height : null;
  if (w === null || h === null) {
    return { width: '100%', maxWidth, height: fallbackHeight };
  }
  const scale = Math.min(1, maxWidth / w, maxHeight / h);
  // width + aspect-ratio (not a fixed height) so a pane narrower than the box
  // shrinks it proportionally through max-width: 100% instead of distorting.
  return {
    width: Math.max(1, Math.round(w * scale)),
    maxWidth: '100%',
    aspectRatio: `${w} / ${h}`,
  };
}

/** Attachment preview bounds: the old `max-w-xs` × `max-h-64`. */
const ATTACHMENT_MAX_W = 320;
const ATTACHMENT_MAX_H = 256;

function AttachmentImagePreview({
  url,
  filename,
  width,
  height,
}: {
  url: string;
  filename: string;
  width?: number | null;
  height?: number | null;
}) {
  const [zoom, setZoom] = useState(false);
  return (
    <>
      <button
        type="button"
        className="mt-1 block overflow-hidden rounded-lg border border-line bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
        style={mediaBoxStyle(width, height, ATTACHMENT_MAX_W, ATTACHMENT_MAX_H, ATTACHMENT_MAX_H)}
        aria-label={`View ${filename} full size`}
        data-testid="attachment-image"
        data-sized={width && height ? 'intrinsic' : 'fallback'}
        onClick={() => setZoom(true)}
      >
        <img
          src={url}
          alt={filename}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          width={width ?? undefined}
          height={height ?? undefined}
          className={`block h-full w-full ${width && height ? 'object-cover' : 'object-contain'}`}
        />
      </button>
      {zoom ? (
        <ImageLightbox
          src={url}
          filename={filename}
          open
          onOpenChange={(open) => {
            if (!open) setZoom(false);
          }}
        />
      ) : null}
    </>
  );
}

function AttachmentView({ att }: { att: Attachment }) {
  // Only a same-origin attachment path (`/api/v1/attachments/<id>[?…]`) is
  // trusted as a file/preview; it resolves against the configured origin in
  // the desktop shell and is unchanged in the browser. Anything else a
  // message carries is either an explicitly EXTERNAL link or no link at all
  // (attachmentTarget — a `javascript:` or look-alike URL must never wear the
  // app's own download chip).
  const target = attachmentTarget(att.url);

  if (target?.kind === 'attachment' && isImage(att)) {
    // #56: the inline render is a bounded preview; the lightbox owns the
    // full-size view (Esc/overlay close, focus restored).
    // Intrinsic dimensions ride the attachment when the upload sniffed as
    // PNG/GIF/JPEG (absent otherwise, and on older rows — the box then falls
    // back to a fixed height; mediaBoxStyle validates both numbers).
    return (
      <AttachmentImagePreview
        url={target.href}
        filename={att.filename ?? 'image'}
        width={att.width ?? null}
        height={att.height ?? null}
      />
    );
  }

  const label = (
    <>
      <span aria-hidden>📎</span>
      <span>{att.filename}</span>
      <span className="text-text-muted">{formatBytes(att.size)}</span>
    </>
  );
  const chipClass =
    'mt-1 inline-flex items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm text-text';

  if (target === null) {
    return (
      <span className={chipClass} data-testid="attachment-file" data-link="none">
        {label}
      </span>
    );
  }

  if (target.kind === 'external') {
    const host = (() => {
      try {
        return new URL(target.href).host;
      } catch {
        return target.href;
      }
    })();
    return (
      <a
        href={target.href}
        target="_blank"
        rel="noreferrer noopener nofollow"
        className={`${chipClass} transition-colors duration-[var(--duration-control)] hover:bg-surface-hover`}
        data-testid="attachment-file"
        data-link="external"
        title={`External link — opens ${host}`}
      >
        {label}
        <span className="text-text-muted">
          <span aria-hidden>↗</span>
          <span className="sr-only">(external link to {host})</span>
          <span aria-hidden> {host}</span>
        </span>
      </a>
    );
  }

  return (
    <a
      href={target.href}
      target="_blank"
      rel="noreferrer noopener"
      className={`${chipClass} transition-colors duration-[var(--duration-control)] hover:bg-surface-hover`}
      data-testid="attachment-file"
      data-link="attachment"
    >
      {label}
    </a>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Embed media bounds: the card's content width, ~200px tall (Discord). */
const EMBED_MAX_W = 400;
const EMBED_MAX_H = 200;

/**
 * What an embed media slot may load, and the original it came from.
 *
 * The app's CSP is `img-src 'self'`, so an EXTERNAL image only ever loads
 * through the server's media proxy — the slot's `proxy_url`, minted per
 * render (Discord's field). Our own attachment URLs are same-origin and load
 * as themselves. Anything else (no proxy URL, a junk value, a proxy URL of
 * the wrong shape) is no image at all: the card simply shows no media, as a
 * blocked external image always did.
 */
function embedMedia(ref: EmbedMediaRef | null | undefined): { src: string; original: string | null } | null {
  if (!ref || typeof ref !== 'object') return null;
  const url = typeof ref.url === 'string' && ref.url !== '' ? ref.url : null;
  const proxied = mediaProxyUrl(ref.proxy_url);
  if (proxied !== undefined) {
    const target = url !== null ? attachmentTarget(url) : null;
    return { src: proxied, original: target?.kind === 'external' ? target.href : null };
  }
  const target = url !== null ? attachmentTarget(url) : null;
  return target?.kind === 'attachment' ? { src: target.href, original: null } : null;
}

/** One embed media image (Discord embed rendering): lazy, no-referrer,
 * object-contain capped at ~200px, token rounding/border. `src` is always
 * same-origin (the proxy copy, or our own attachment — see `embedMedia`). A
 * load failure hides the img AND its reserved box (no broken-image icon, no
 * empty frame); the alt falls back to the generic "embed image" when the
 * embed has no title. The box is sized before load from the producer's
 * width/height hints when both are numbers, else a fixed 200px box (#10).
 * With an external `original`, the image links to it ("open original"). */
function EmbedImage({
  src,
  alt,
  original = null,
  width,
  height,
  testId = 'embed-image',
}: {
  src: string;
  alt: string;
  original?: string | null;
  width?: unknown;
  height?: unknown;
  testId?: string;
}) {
  const [failed, setFailed] = useState(false);
  const img = (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      className="block h-full w-full object-contain"
      data-testid={testId}
      onError={(e) => {
        e.currentTarget.style.display = 'none';
        setFailed(true);
      }}
    />
  );
  const boxStyle = failed ? { display: 'none' } : mediaBoxStyle(width, height, EMBED_MAX_W, EMBED_MAX_H, EMBED_MAX_H);
  if (original !== null) {
    return (
      <a
        href={original}
        target="_blank"
        rel="noreferrer noopener"
        title="Open original"
        className="block overflow-hidden rounded-md border border-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
        style={boxStyle}
        data-testid={`${testId}-box`}
      >
        {img}
      </a>
    );
  }
  return (
    <span className="block overflow-hidden rounded-md border border-line" style={boxStyle} data-testid={`${testId}-box`}>
      {img}
    </span>
  );
}

/**
 * A Markdown `![alt](https://…)` in a message body, loaded through the
 * server's media proxy (`content_proxy_urls`). The embed image's rules:
 * lazy, no-referrer, capped like embed media in a box reserved before load
 * (a body image has no size hints, so the fixed 200px box — #10), alt text as
 * the accessible name, a failure that hides the whole box quietly, and a
 * link to the original. Block-level, as Discord and Slack show a posted image.
 */
function MarkdownImage({ src, alt, title, original }: { src: string; alt: string; title: string | null; original: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <a
      href={original}
      target="_blank"
      rel="noreferrer noopener"
      title={title ?? 'Open original'}
      className="md-image my-1 block overflow-hidden rounded-md border border-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
      style={failed ? { display: 'none' } : mediaBoxStyle(undefined, undefined, EMBED_MAX_W, EMBED_MAX_H, EMBED_MAX_H)}
      data-testid="markdown-image-box"
    >
      <img
        src={src}
        alt={alt !== '' ? alt : 'Image'}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        className="block h-full w-full object-contain"
        data-testid="markdown-image"
        onError={(e) => {
          e.currentTarget.style.display = 'none';
          setFailed(true);
        }}
      />
    </a>
  );
}

/** One embed as a card (U12 render half): title, description, and name/value
 * fields in a definition-style layout, plus the embed's image/thumbnail
 * rendered as lazy images below the fields (Discord embed media). Cards sit
 * below the content, token-disciplined only — no colors from embed data, no
 * unfurling (v1), unknown embed keys inert. Every value is untrusted JSON:
 * string-checked before render, malformed pieces drop out (degraded, never
 * crash) — a fully unrenderable embed renders nothing.
 *
 * The description and each field VALUE are Markdown, as on Discord (#167),
 * through `renderText`: the message body's own renderer, so mentions and
 * channel mentions resolve the same way. The title and field names stay
 * plain, as Discord's do. `renderText` carries no image renderer, so an
 * `![…](…)` in an embed stays a link: an embed's media comes only from its
 * `image`/`thumbnail`, through the proxy. */
function EmbedCard({
  embed,
  renderText,
}: {
  embed: MessageEmbed;
  renderText: (text: string) => React.ReactNode;
}) {
  const title = typeof embed?.title === 'string' ? embed.title : null;
  const description =
    typeof embed?.description === 'string' ? embed.description : null;
  const fields: EmbedField[] = Array.isArray(embed?.fields)
    ? embed.fields.filter(
        (f): f is EmbedField =>
          !!f &&
          typeof f === 'object' &&
          typeof f.name === 'string' &&
          typeof f.value === 'string',
      )
    : [];
  // Media loads ONLY through the proxy copy (or our own attachment URL):
  // never the producer's external URL, which the CSP refuses anyway.
  const image = embedMedia(embed?.image);
  const imageRef = image !== null ? embed.image : null;
  const thumbnail = embedMedia(embed?.thumbnail);
  const thumbnailRef = thumbnail !== null ? embed.thumbnail : null;

  if (!title && !description && fields.length === 0 && !image && !thumbnail) {
    return null;
  }
  const mediaAlt = title ?? 'embed image';

  return (
    <div
      data-testid="embed-card"
      className="mt-1 max-w-md rounded-md border border-line border-l-4 border-l-accent bg-surface px-3 py-2"
    >
      {title ? (
        <h4 data-testid="embed-title" className="text-sm font-semibold text-text-primary">
          {title}
        </h4>
      ) : null}
      {description ? (
        <div
          data-testid="embed-description"
          className="whitespace-pre-wrap break-words text-sm text-text"
        >
          {renderText(description)}
        </div>
      ) : null}
      {fields.length > 0 ? (
        <dl data-testid="embed-fields" className="mt-1 flex flex-col gap-1.5">
          {fields.map((f, i) => (
            <div key={i} className="min-w-0">
              <dt className="text-sm font-semibold text-text-primary">{f.name}</dt>
              <dd className="whitespace-pre-wrap break-words text-sm text-text-muted">
                {renderText(f.value)}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {image || thumbnail ? (
        <div data-testid="embed-media" className="mt-2 flex flex-col gap-1.5">
          {image ? (
            <EmbedImage
              src={image.src}
              original={image.original}
              alt={mediaAlt}
              width={imageRef?.width}
              height={imageRef?.height}
            />
          ) : null}
          {thumbnail ? (
            <EmbedImage
              src={thumbnail.src}
              original={thumbnail.original}
              alt={mediaAlt}
              width={thumbnailRef?.width}
              height={thumbnailRef?.height}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Discord-style reply context line: mini avatar, name, snippet, spine
 * connecting down to the reply; clicking jumps to the original. */
function ReplyContextLine({
  referenced,
  resolvedName,
  resolvedAvatarUrl,
  resolveMention,
  resolveChannel,
}: {
  referenced: NonNullable<MessageWithBots['referenced']>;
  /** Host-resolved display name (members roster + self); wire username is
   *  the next fallback, the raw id the last resort — never sooner. */
  resolvedName?: string;
  /** Host-resolved avatar (roster row) for the small tile before the name. */
  resolvedAvatarUrl?: string | null;
  /** Mention resolver — the snippet is plain text, so `<@id>` tokens are
   *  rewritten to `@name` rather than rendered as pills. */
  resolveMention?: MentionResolver;
  /** Channel resolver for `<#id>` tokens in the snippet (plain text too). */
  resolveChannel?: (channelId: string) => string | undefined;
}) {
  const onJump = () => {
    const el = document.querySelector(
      `[data-message-id="${referenced.message_id}"]`,
    );
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('reply-flash');
    window.setTimeout(() => el.classList.remove('reply-flash'), 1400);
  };

  const refName = resolvedName ?? referenced.author_username ?? referenced.author_id;
  // The body's plain text (markup dropped by the body's own parser), then
  // names for tokens — the quote read raw `**bold**` and backticks while the
  // message it quotes rendered them (owner report 2026-09-28).
  const snippet = resolveMentionTokens(previewText(referenced.content), resolveMention, resolveChannel);

  // A quote block UNDER the reply's own header (owner, 2026-09-27, after
  // Clickclack): an accent bar, the replied-to author in the accent colour,
  // one muted line of what they said — keeping the small avatar before the
  // name that the earlier Discord-style line had (owner). It replaces that
  // line, which sat ABOVE the header. Still a button: a click jumps to (and
  // flashes) the original.
  return (
    <button
      type="button"
      className="reply-context"
      data-testid="reply-context"
      data-referenced-id={referenced.message_id}
      onClick={onJump}
      title="Jump to message"
      aria-label={`Reply to ${refName}: ${snippet}. Jump to message`}
    >
      <span className="reply-context-head">
        <SharedAvatar
          id={referenced.author_id}
          name={refName}
          src={resolvedAvatarUrl}
          className="reply-context-avatar"
        />
        <span className="reply-context-name">{refName}</span>
      </span>
      <span className="reply-context-snippet">{snippet}</span>
    </button>
  );
}

/** Author avatar: 40px circle — the uploaded image when the roster row
 * carries one, the deterministic hue tile otherwise. Grouped (continuation)
 * rows replace the avatar with the timestamp in
 * the left gutter, revealed on row hover (Discord's grouped-message
 * convention — the time is otherwise absent from continuation lines). */
function AuthorAvatar({
  authorName,
  authorId,
  authorAvatarUrl,
  authorKind,
  authorParentName,
  grouped,
  time,
}: {
  authorName: string;
  authorId: string;
  authorAvatarUrl?: string | null;
  authorKind?: PrincipalKind | null;
  authorParentName?: string | null;
  grouped: boolean;
  time: string;
}) {
  if (grouped) {
    // Gutter time (Discord): a fixed spacer holds the avatar column so
    // content alignment never moves; the time itself is an absolutely
    // positioned overlay revealed on row hover, STACKED as two centered
    // lines inside the avatar column's width (date over clock) — the
    // age-aware stamp ("Yesterday, 9:00 AM") is wider than the 40px gutter,
    // and one nowrap line clipped into the message text (owner report
    // 2026-09-20). It never wraps and never pushes the body.
    return (
      <>
        <span aria-hidden className="mt-0.5 w-10 shrink-0 select-none" />
        <span
          aria-hidden
          className="pointer-events-none absolute left-0 top-0 z-10 flex w-[68px] select-none flex-col items-center justify-start gap-0 pt-[3px] text-[10px] leading-[13px] text-text-muted opacity-0 transition-opacity duration-[var(--duration-control)] group-hover:opacity-100"
          data-testid="message-hover-time"
        >
          {/* Two lines, stacked inside the avatar column (owner report
              2026-09-20: the age-aware stamp is wider than the 40px gutter
              and centering one nowrap line clipped it into the message text).
              Today's stamp carries no date part, so it renders one line. */}
          {time.includes(', ') ? (
            time.split(', ').map((part) => (
              <span key={part} className="whitespace-nowrap">
                {part}
              </span>
            ))
          ) : (
            <span className="whitespace-nowrap">{time}</span>
          )}
        </span>
      </>
    );
  }
  return (
    <SharedAvatar
      id={authorId}
      name={authorName}
      src={authorAvatarUrl}
      kind={authorKind}
      parentName={authorParentName}
      className="message-avatar mt-0.5"
      data-testid="message-avatar"
    />
  );
}

// Hover-toolbar buttons: PHAT (40×40 hit, 20px glyphs), outline SVGs in
// currentColor, no emoji colors. The ONE hue is Delete's danger tint — the
// destructive action reads red here exactly as it does in the touch sheet and
// in the reference toolbar (corpus §3b; owner decision 2026-09-27).
const actionBtn =
  'flex h-10 w-10 items-center justify-center rounded-md text-text-muted ' +
  'transition-colors duration-[var(--duration-control)] ' +
  'hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]';

const actionBtnDanger =
  'flex h-10 w-10 items-center justify-center rounded-md text-danger ' +
  'transition-colors duration-[var(--duration-control)] ' +
  'hover:bg-danger/10 hover:text-danger focus-visible:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]';

export const actionIcon = (d: string, extra = '') => (
  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" className={extra}>
    <path d={d} fill="currentColor" />
  </svg>
);

export const PENCIL_PATH =
  'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z';
export const TRASH_PATH =
  'M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z';
export const REPLY_PATH =
  'M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z';
export const THREAD_PATH =
  'M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z';
/** #114: a chain link — Copy Link's glyph (monochrome, like its neighbours). */
export const LINK_PATH =
  'M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7a5 5 0 0 0 0 10h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4a5 5 0 0 0 0-10z';
export const SMILEY_PATH =
  'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zM9 9.5a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0zm8.5 0a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0zM12 17.5c2.03 0 3.8-1.11 4.75-2.75h-9.5A5.47 5.47 0 0 0 12 17.5z';

// Reaction chips (Discord interaction model): me-state is FILLED (accent
// wash + accent border), others are OUTLINE (line border + surface) — token
// classes only. aria-pressed carries the state semantically.
const chipBase =
  'flex h-6 items-center gap-1 rounded-full border px-2 text-xs ' +
  'transition-[background-color,border-color,color,scale] duration-[var(--duration-control)] ' +
  'active:scale-[0.96] ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] ' +
  'disabled:cursor-not-allowed disabled:opacity-50';
const chipMine =
  chipBase + ' border-accent bg-accent/20 text-text-primary hover:bg-accent/30';
const chipOthers =
  chipBase + ' border-line bg-surface text-text-muted hover:border-border-strong hover:text-text';

const OFFLINE_REACTIONS_TITLE =
  'You are offline — reactions are unavailable until reconnection';

// -- U3 long-press gesture (coarse pointers only) ---------------------------
// Hold ~450ms to open the touch action sheet; canceled by movement past the
// slop (it's a scroll, not a press), by any scroll under the finger, or by
// lifting early (a tap — existing tap behaviors stay intact).
const LONG_PRESS_MS = 450;
const LONG_PRESS_SLOP_PX = 10;

/**
 * Coarse-pointer gate for the long-press. matchMedia is authoritative
 * whenever it exists (the jsdom mock flips `(pointer: coarse)` for tests;
 * real browsers report the primary input modality). The touch-capability
 * sniff is ONLY for engines without matchMedia — never a second vote.
 */
function isCoarsePointer(): boolean {
  try {
    const mql = window.matchMedia?.('(pointer: coarse)');
    if (mql) return mql.matches === true;
  } catch {
    // no matchMedia — fall through to capability sniffing
  }
  return (
    'ontouchstart' in window || (navigator.maxTouchPoints ?? 0) > 0
  );
}

/** Accessible chip label: emoji name (when known), count, own-reaction note. */
function reactionChipLabel(emoji: string, count: number, me: boolean): string {
  const n = count === 1 ? '1 reaction' : `${count} reactions`;
  return me ? `${emoji} ${n}, including you` : `${emoji} ${n}`;
}

/**
 * The reaction chip's hover tooltip (Discord's "who reacted"): lazily
 * fetches the emoji's reacted-users page once per hover-target and lists
 * names above the chip. Falls back quietly on error (no tooltip content
 * beats a broken chip). Fetch is injectable for tests.
 */
function useReactedUsers(
  channelId: string,
  messageId: string,
  emoji: string,
  enabled: boolean,
  fetchUsers: typeof api.listReactionUsers,
): { names: string[] | null; loading: boolean } {
  const [names, setNames] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const cache = useRef(new Map<string, string[]>());

  useEffect(() => {
    if (!enabled) return;
    const key = `${messageId}:${emoji}`;
    const hit = cache.current.get(key);
    if (hit) {
      setNames(hit);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setNames(null);
    fetchUsers(channelId, messageId, emoji)
      .then((page) => {
        const list = page.users.map((u) => u.username);
        cache.current.set(key, list);
        if (!cancelled) setNames(list);
      })
      .catch(() => {
        if (!cancelled) setNames([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [channelId, messageId, emoji, enabled, fetchUsers]);

  return { names, loading };
}

/** One reaction chip + its hover tooltip. */
function ReactionChip({
  channelId,
  messageId,
  emoji,
  count,
  me,
  online,
  onToggle,
}: {
  channelId: string;
  messageId: string;
  emoji: string;
  count: number;
  me: boolean;
  online: boolean;
  onToggle: () => void;
}) {
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const { names, loading } = useReactedUsers(channelId, messageId, emoji, tooltipOpen, api.listReactionUsers);

  return (
    <span className="relative inline-flex" data-testid="reaction-chip-wrap">
      <button
        type="button"
        className={me ? chipMine : chipOthers}
        aria-pressed={me}
        aria-label={reactionChipLabel(emoji, count, me)}
        title={
          online
            ? me
              ? 'Click to remove your reaction'
              : 'Click to react with this emoji'
            : OFFLINE_REACTIONS_TITLE
        }
        data-testid="reaction-chip"
        data-emoji={emoji}
        data-me={me || undefined}
        disabled={!online}
        onClick={onToggle}
        onMouseEnter={() => setTooltipOpen(true)}
        onMouseLeave={() => setTooltipOpen(false)}
        onFocus={() => setTooltipOpen(true)}
        onBlur={() => setTooltipOpen(false)}
      >
        <span aria-hidden>{emoji}</span>
        <span className="tabular-nums">{count}</span>
      </button>
      {tooltipOpen ? (
        <div
          className="reaction-tooltip"
          role="tooltip"
          data-testid="reaction-tooltip"
          aria-hidden="true"
        >
          <div className="reaction-tooltip-title">
            {count === 1 ? '1 reacted with' : `${count} reacted with`} {emoji}
          </div>
          {loading && names === null ? (
            <div className="reaction-tooltip-name">…</div>
          ) : (
            (names ?? []).map((name) => (
              <div key={name} className="reaction-tooltip-name">
                {name}
              </div>
            ))
          )}
        </div>
      ) : null}
    </span>
  );
}

/**
 * One message row.
 *
 * MEMOIZED (#137, app-level finding 4): this is the leaf the virtualized list
 * instantiates once per visible message, and its props are all identity-stable
 * values the list derives (the message row, resolved names, the memoized
 * mention resolver, the host's hoisted handlers). Without `memo` every row in
 * the window re-rendered — and re-parsed its markdown body — on ANY parent
 * render, including renders caused by traffic in a completely different
 * channel or by a presence flip.
 *
 * The comparison is the default shallow one; that is exactly the contract
 * MessageList keeps, so an unchanged row bails out and only a real prop change
 * (a new message object, an edited body, a resolved author, an active inline
 * edit, a reaction error on THIS row) reaches the DOM.
 */
export const MessageItem = memo(function MessageItem({
  message,
  authorName,
  authorTag,
  authorAvatarUrl,
  replyAuthorName,
  replyAuthorAvatarUrl,
  resolveMention,
  authorKind: rosterAuthorKind,
  authorParentName,
  currentUserId,
  canManageMessages = false,
  onReply,
  onEdit,
  onDelete,
  onReact,
  onCopyLink,
  onToggleReaction,
  onStartThread,
  thread,
  onOpenThread,
  editing = false,
  onSaveEdit,
  onCancelEdit,
  reactionError,
  onRetryReaction,
  onDismissReaction,
  compact = false,
  actionsPlacement,
  grouped = false,
  groupGap = false,
  onLongPress,
  store,
  viewOnly = false,
  canRemind = false,
}: MessageItemProps) {
  const threadNamed = thread != null && !isGeneratedThreadName(thread.name);
  const online = useOnlineStatus();
  const isAuthor = currentUserId !== null && message.author_id === currentUserId;
  const canDelete = isAuthor || canManageMessages;
  const canEdit = isAuthor;
  // The optimistic send's local row (SendStatus.tsx): pending, or held after
  // a failure. It has no server id yet, so none of the row's server actions
  // (hover toolbar, long-press sheet, reactions) apply to it.
  const localSend = isLocalSendRow(message);
  const sendPending = localSend && message.send_state === 'pending';
  // Content is optional-safe: in-flight rows (optimistic placeholder swaps,
  // gateway echoes landing mid-confirm) may transiently lack it, and one
  // malformed row must never unmount the whole tree.
  const content = message.content ?? '';
  /**
   * The body's PARSE TREE, memoized on the text (#137, app-level finding 5).
   *
   * The tokenizer used to run on every render of every visible row — once per
   * gateway event, since any store write re-rendered the whole window. It is a
   * pure function of the text and nothing else: mentions, links and emphasis
   * are resolved later, by `renderMarkdownBlocks`, against the live resolver.
   * So the tree is exactly as fresh as before (`content` is the dep) while an
   * unchanged body — a roster name arriving, a reaction landing, the row's
   * author flaring — no longer re-tokenizes. No module-level cache: the tree
   * dies with the row instead of accumulating in a global map.
   */
  const blocks = useMemo(() => parseMarkdownBlocks(content), [content]);
  /**
   * #118 — a link in the body that addresses a message on THIS instance
   * renders as a chip (channel, author, the target's first words) instead of
   * a bare URL, the way a mention renders as a name. `renderMarkdown` owns
   * the "is this one of ours" rule and calls this only for those links;
   * returning null, or a chip that degrades to the anchor it replaced, leaves
   * every other link exactly as it was.
   */
  const renderPermalinkChip: PermalinkChipRenderer = (href, text, target, key) => (
    <PermalinkChip key={key} href={href} text={text} target={target} store={store} />
  );
  // `![alt](https://…)`: the server's proxy copy of the source, from the
  // message's own `content_proxy_urls` (the client cannot sign). No entry
  // (proxy off, an old row, a source the server would not proxy) → null, and
  // the renderer falls back to a plain link to the source.
  const contentProxyUrls = message.content_proxy_urls;
  const renderImage: ImageRenderer = (node, key) => {
    const proxied = mediaProxyUrl(contentProxyUrls?.[node.src]);
    if (proxied === undefined) return null;
    return <MarkdownImage key={key} src={proxied} alt={node.alt} title={node.title} original={node.src} />;
  };
  // `<#channel>` tokens: resolved from the reader's own store at render.
  const renderChannelMention: ChannelMentionRenderer = (channelId, key) => (
    <ChannelMentionPill key={key} channelId={channelId} store={store} />
  );
  const mentionsMe =
    currentUserId !== null && content.includes(`<@${currentUserId}>`);
  // Webhook per-message identity override (U12): the override username wins,
  // the roster name is the fallback. `author_override.avatar_url` is
  // STORED-ONLY in v1 — kept on the row, never rendered (the deterministic
  // initials avatar stays; remote webhook avatars are a later unit).
  // The override branch of the shared resolver (authorIdentity.ts).
  const overrideIdentity =
    typeof message.author_override?.username === 'string'
      ? resolveAuthor(null, message.author_id, { override: message.author_override })
      : null;
  const overrideName = overrideIdentity?.name;
  const name = overrideName ?? authorName ?? message.author_id;
  // Tier 3 B (10b): a message carrying a per-message identity override is a
  // WEBHOOK message, whatever the roster says (or does not say yet) — the
  // badge must come from the message, or an override naming a member would
  // read as that member.
  const authorKind: PrincipalKind | null | undefined = overrideIdentity
    ? overrideIdentity.kind
    : rosterAuthorKind;
  // The handle beside the name (owner, 2026-09-27: name, @tag, time). A
  // webhook's per-message identity has no account behind it, so no tag, and a
  // member with no nickname would only repeat their name, so none there either.
  const resolvedTag =
    overrideName === undefined
      ? (authorTag ?? mentionTagFor(store ?? defaultStore, message.author_id))
      : undefined;
  const tag = resolvedTag !== name ? resolvedTag : undefined;

  const handleReply = useCallback(
    (e?: React.MouseEvent) => onReply?.(message, { suppressPing: e?.shiftKey === true }),
    [onReply, message],
  );
  const handleEdit = useCallback(() => onEdit?.(message.id, content), [onEdit, message.id, content]);
  const handleDelete = useCallback(() => onDelete?.(message.id), [onDelete, message.id]);
  const handleReact = useCallback(() => onReact?.(message.id), [onReact, message.id]);
  // Permalinks are addressable for CONFIRMED rows only: an optimistic
  // placeholder's id is not a snowflake, so the URL builder would refuse it
  // anyway — this keeps the affordance honest instead of failing on click.
  const canCopyLink = Boolean(onCopyLink) && !message.id.startsWith('pending_');
  const showRemind = canRemind && !message.id.startsWith('pending_') && !message.thread_id;
  const handleCopyLink = useCallback(() => onCopyLink?.(message), [onCopyLink, message]);

  // -- U3 long-press report (see onLongPress prop doc) -----------------------
  // Refs hold the in-flight gesture: the arm timer, the press origin, and a
  // one-shot click swallow (the gesture's trailing tap-click must not fall
  // through to whatever sits under the finger — chips, links).
  const holdTimerRef = useRef<number | null>(null);
  const holdOriginRef = useRef<{ x: number; y: number } | null>(null);
  const swallowClickRef = useRef(false);

  const cancelPress = useCallback(() => {
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    holdOriginRef.current = null;
    window.removeEventListener('scroll', cancelPress, true);
    window.removeEventListener('pointerup', cancelPress);
    window.removeEventListener('pointercancel', cancelPress);
  }, []);

  // Never leak the timer or the window listeners past unmount (a row can be
  // unmounted mid-hold by a rewindow — that's exactly why the sheet state
  // does NOT live here).
  useEffect(() => cancelPress, [cancelPress]);

  const onRowPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!onLongPress || !isCoarsePointer()) return;
      cancelPress();
      // Each new gesture starts clean: the swallow flag must never outlive
      // the gesture it belongs to (the sheet's overlay usually eats the
      // trailing click, so the click-capture reset can't be relied on).
      swallowClickRef.current = false;
      holdOriginRef.current = { x: e.clientX, y: e.clientY };
      const el = e.currentTarget;
      holdTimerRef.current = window.setTimeout(() => {
        holdTimerRef.current = null;
        holdOriginRef.current = null;
        cancelPress();
        swallowClickRef.current = true;
        // The row is the focus-return anchor: Radix restores focus to the
        // pre-dialog active element, so put the row there first.
        el.focus();
        onLongPress(message);
      }, LONG_PRESS_MS);
      // Scroll under the finger cancels the hold (capture: the list, its
      // ancestors, or document can all be the scroller).
      window.addEventListener('scroll', cancelPress, { capture: true, passive: true });
      window.addEventListener('pointerup', cancelPress);
      window.addEventListener('pointercancel', cancelPress);
    },
    [onLongPress, cancelPress, message],
  );

  const onRowPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const origin = holdOriginRef.current;
      if (holdTimerRef.current === null || origin === null) return;
      const dx = e.clientX - origin.x;
      const dy = e.clientY - origin.y;
      if (Math.sqrt(dx * dx + dy * dy) > LONG_PRESS_SLOP_PX) cancelPress();
    },
    [cancelPress],
  );

  const onRowClickCapture = useCallback((e: React.MouseEvent) => {
    if (swallowClickRef.current) {
      e.preventDefault();
      e.stopPropagation();
      swallowClickRef.current = false;
    }
  }, []);

  const onRowContextMenu = useCallback((e: React.MouseEvent) => {
    // Coarse pointers get the action sheet instead of the native callout —
    // Copy Text in the sheet is the sanctioned extraction path. Desktop
    // context menus are untouched.
    if (isCoarsePointer()) e.preventDefault();
  }, []);

  // Reaction chips: only for CONFIRMED rows (never the user's own optimistic
  // send placeholder — chips appear when the server row replaces it, matching
  // the optimistic-send pattern's wholesale confirm swap) and only when the
  // message carries reactions (the key is ABSENT when none — wire contract).
  const reactions = Array.isArray(message.reactions)
    ? message.reactions.filter(
        (r) =>
          !!r &&
          typeof r.emoji === 'string' &&
          typeof r.count === 'number' &&
          typeof r.me === 'boolean',
      )
    : [];
  const showReactionRow =
    !message.id.startsWith('pending_') &&
    (reactions.length > 0 || (reactionError ?? null) !== null);

  const placement = actionsPlacement ?? messageActionsPlacement();

  // Both placements hang off the row and both can run past the scroller, so
  // one reveal-time measurement serves them: :hover has laid the toolbar out
  // by the time we read it, and each placement shifts itself just enough to
  // stay visible — its resting geometry is untouched wherever there is room.
  //
  //   'left-rail' — a centred rail is taller than a one-line row (225px
  //   against 60px, measured 2026-09-12), so for the first rows in view it ran
  //   its top off the scroller and hid its own reply action.
  //
  //   'top-right' — the pill is 46px tall on a 24px one-line row, so it
  //   ALWAYS hangs 26px below its own bottom edge. That straddle is the
  //   intended look (it is what makes the pill read as attached to its message
  //   rather than to the one below) right up until the row is the newest one,
  //   where "below the row" is the composer: the pill was clipped at the pane's
  //   bottom edge and read as having flipped the wrong way (user report
  //   2026-09-15, with a screenshot of exactly that). Lifting it only when it
  //   would overflow keeps every other row's geometry as it was.
  const railRef = useRef<HTMLDivElement | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const clampRail = useCallback(() => {
    const rail = railRef.current;
    const row = rowRef.current;
    if (rail === null || row === null) return;
    // The channel timeline is a Virtuoso scroller; the thread panel's body is
    // a plain overflow container — both clip the pill, so both clamp it.
    const scroller = row.closest('[data-virtuoso-scroller="true"], .thread-body');
    if (scroller === null) return;
    const sb = scroller.getBoundingClientRect();
    const rb = row.getBoundingClientRect();
    const h = rail.offsetHeight;

    if (placement === 'left-rail') {
      const desired = rb.top + rb.height / 2 - h / 2;
      const clamped = Math.min(Math.max(desired, sb.top + 8), sb.bottom - h - 8);
      rail.style.setProperty('--rail-shift', `${Math.round(clamped - desired)}px`);
      return;
    }

    // The pill rides ABOVE its message: only its bottom ACTIONS_OVERLAP px
    // sit on the row, so it never covers the text it acts on (owner report
    // 2026-09-28 — at `top: 4px` it hid the first line). Where the scroller
    // has no room above (the first visible row) it is pushed down just far
    // enough to stay whole; past the bottom edge it is lifted, as before.
    // A grouped follow-up row has no header — its text starts at the row's
    // top — so the overlap stops at the text wherever that comes first.
    const text = row.querySelector('[data-testid="message-content"]');
    const textTop = text === null ? Infinity : text.getBoundingClientRect().top;
    const desiredTop = Math.min(rb.top + ACTIONS_OVERLAP, textTop) - h;
    const clampedTop = Math.min(Math.max(desiredTop, sb.top + 4), sb.bottom - h - 8);
    rail.style.setProperty('--actions-top', `${Math.round(clampedTop - rb.top)}px`);
  }, [placement]);

  /**
   * The hover toolbar mounts LAZILY (#14): on the first pointer entry, focus
   * entering the row, or a long-press — never at rest. It used to mount on
   * every row in the window while `hidden`, a ReactionPicker (favorites read
   * + parse) and a MarkPicker included, so scrolling paid for a dozen
   * controls per row nobody was pointing at. Once mounted it stays (a row
   * unmounts when it scrolls out of the window anyway), so the reveal is the
   * same CSS hover/focus rule as before — only the first hover builds it.
   */
  const [actionsMounted, setActionsMounted] = useState(false);
  const mountActions = useCallback(() => setActionsMounted(true), []);
  const onRowMouseEnter = useCallback(() => {
    setActionsMounted(true);
    clampRail();
  }, [clampRail]);
  // The clamp measures the toolbar the same hover reveals; on the FIRST hover
  // the toolbar is not in the DOM until that render commits, so it is measured
  // again as it lands (before paint — no frame at the unclamped position).
  useLayoutEffect(() => {
    if (actionsMounted) clampRail();
  }, [actionsMounted, clampRail]);

  const showActions = !localSend && Boolean(
    onToggleReaction ||
      onReact ||
      onReply ||
      onStartThread ||
      canCopyLink ||
      (canEdit && onEdit) ||
      (canDelete && onDelete),
  );

  const row = (
    <div
      ref={rowRef}
      className={`group message-actions-host relative flex gap-3 px-4 transition-colors duration-[var(--duration-control)] hover:bg-surface-strong/25 ${
        grouped ? (compact ? 'py-0.5' : 'py-0') : compact ? 'py-1' : 'py-[6px]'
      } ${mentionsMe ? 'border-l-2 border-accent bg-accent/10' : ''}${
        // A local send's attachments read as not-sent-yet, like its text.
        localSend ? ' [&_[data-testid^=attachment-]]:opacity-60' : ''
      }`}
      data-testid="message-item"
      data-message-id={message.id}
      data-grouped={grouped || undefined}
      data-mentions-me={mentionsMe || undefined}
      data-send-state={localSend ? message.send_state : undefined}
      aria-busy={sendPending || undefined}
      // Programmatically focusable only (never a tab stop): the long-press
      // focuses the row so the action sheet's close returns focus here.
      tabIndex={-1}
      onPointerDown={onLongPress && !localSend ? onRowPointerDown : undefined}
      onPointerMove={onLongPress && !localSend ? onRowPointerMove : undefined}
      onClickCapture={onLongPress && !localSend ? onRowClickCapture : undefined}
      onContextMenu={onRowContextMenu}
      onMouseEnter={onRowMouseEnter}
      onPointerEnter={actionsMounted ? undefined : mountActions}
      onFocusCapture={actionsMounted ? undefined : mountActions}
    >
      <AuthorAvatar
        authorName={name}
        authorId={message.author_id}
        authorAvatarUrl={authorAvatarUrl}
        authorKind={authorKind}
        authorParentName={authorParentName}
        grouped={grouped}
        time={formatTime(message.created_at)}
      />
      {grouped ? <span className="sr-only">{formatTime(message.created_at)}</span> : null}
      {sendPending ? <PendingSendMark /> : null}

      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex items-baseline gap-2 leading-tight">
            <span
              className={`${compact ? 'text-sm' : 'text-base'} font-semibold text-text-primary`}
              data-testid="message-author"
            >
              {name}
            </span>
            {tag ? (
              <span
                className={`${compact ? 'text-[13px]' : 'text-sm'} text-text-muted`}
                data-testid="message-author-tag"
              >
                @{tag}
              </span>
            ) : null}
            {kindTitle(authorKind, authorParentName) ? (
              <span className="sr-only">{kindTitle(authorKind, authorParentName)}</span>
            ) : null}
            <span
              className={`${compact ? 'text-[11px]' : 'text-xs'} text-text-muted`}
              data-testid="message-time"
            >
              {formatTime(message.created_at)}
            </span>
            {message.edited_at ? (
              <span
                className={`${compact ? 'text-[11px]' : 'text-xs'} text-text-muted`}
                data-testid="message-edited"
                title={`Edited ${formatDateTime(message.edited_at)}`}
              >
                (edited)
              </span>
            ) : null}
          </div>
        )}
        {message.referenced && !grouped ? (
          <ReplyContextLine
            referenced={message.referenced}
            resolvedName={replyAuthorName}
            resolvedAvatarUrl={replyAuthorAvatarUrl}
            resolveMention={resolveMention}
            resolveChannel={(id) => channelNameOf(store ?? defaultStore, id) ?? 'unknown-channel'}
          />
        ) : null}
        {editing ? (
          <InlineMessageEditor
            initialContent={content}
            // The editor's pills show the member's TAG, as the composer's do;
            // the display name is only the fallback for an id the roster lacks.
            mentionResolver={(id) => mentionTagFor(store ?? defaultStore, id) ?? resolveMention?.(id)}
            // The shared palettes (`@`/`#`/`:`) read their candidates here.
            store={store ?? defaultStore}
            channelId={message.channel_id}
            onSave={async (next) => {
              if (!onSaveEdit) return;
              await onSaveEdit(message.id, next);
            }}
            onCancel={() => onCancelEdit?.()}
          />
        ) : (
          <div
            className={`whitespace-pre-wrap break-words leading-[24px] ${compact ? 'text-sm' : 'text-base'}${
              localSend ? ' text-text-muted' : ''
            }`}
            data-testid="message-content"
          >
            {renderMarkdownBlocks(blocks, resolveMention, renderPermalinkChip, renderChannelMention, renderImage)}
            {/* Grouped rows have no author row to hang the (edited) marker
                on, so it rides the end of the text (Slack's placement);
                non-grouped rows show it beside the timestamp instead. */}
            {grouped && message.edited_at ? (
              <span
                className="ml-1 text-xs text-text-muted"
                data-testid="message-edited"
                title={`Edited ${formatDateTime(message.edited_at)}`}
              >
                (edited)
              </span>
            ) : null}
          </div>
        )}
        {thread != null ? (
          /* The count leads in the accent color with Discord's chevron, so a
             thread under a message reads as a way INTO a conversation rather
             than as a footnote to the message above it (user direction
             2026-09-12: "the thread existence indicator's ... a little too
             inconspicuous"). The thread's name is the seed message's own
             words, so it stays secondary, and a name nobody chose (a bot's
             `thread-388032`) is left out: the message it would stand for is
             right above. */
          <button
            type="button"
            className="thread-indicator"
            data-testid="thread-indicator"
            data-thread-id={thread.id}
            onClick={() => onOpenThread?.(thread.id)}
            title={threadNamed ? `Open thread: ${thread.name}` : 'Open thread'}
            aria-label={`${threadNamed ? `Open thread: ${thread.name}` : 'Open thread'}. ${
              thread.messageCount === 1 ? '1 reply' : `${thread.messageCount} replies`
            }.`}
          >
            <span aria-hidden className="thread-indicator-icon">
              <ThreadIcon size={14} />
            </span>
            <span className="thread-indicator-count">
              {thread.messageCount === 1 ? '1 reply' : `${thread.messageCount} replies`}
            </span>
            {threadNamed ? (
              <>
                <span aria-hidden className="thread-indicator-chevron">
                  ›
                </span>
                <span className="thread-indicator-name">{thread.name}</span>
              </>
            ) : null}
            {thread.latestReplyAt !== null ? (
              <span className="thread-indicator-meta">
                · last activity {formatTime(thread.latestReplyAt)}
              </span>
            ) : null}
          </button>
        ) : null}

        {/* Components plan U4 (R7) claimed action rows sit "above the embeds —
            Discord's order". That claim was wrong, and the owner hit the
            consequence on 2026-09-18 ("move the option buttons to the
            underside of the box asking the question instead of above the
            top"): the buttons sat ABOVE the card they decide about. Discord
            renders action rows LAST in the message body, and U4's own Files
            slot already said so ("action-row block between attachments and
            the reaction row") — R7 contradicted its own unit. Corrected
            order: content → embeds → attachments → components → reactions. */}
        {Array.isArray(message.embeds)
          ? message.embeds.map((embed, i) => (
              <EmbedCard
                key={i}
                embed={embed}
                renderText={(text) =>
                  renderMarkdown(text, resolveMention, renderPermalinkChip, renderChannelMention)
                }
              />
            ))
          : null}
        {message.attachments?.map((att, i) => (
          // Keyed by position + url, not id: the optimistic row's attachments
          // carry local ids, and the confirmed row's server ids must not
          // remount (and re-decode) the same image at the ack.
          <AttachmentView key={`${i}:${att.url}`} att={att} />
        ))}
        {localSend && !sendPending ? <FailedSendBar message={message} store={store} /> : null}
        {/* Mounted only for a row that carries action rows (#14): the
            component subscribes to the click store, and every plain message
            in the window used to hold that subscription for nothing. */}
        {Array.isArray(message.components) && message.components.length > 0 ? (
          <MessageComponents
            message={message}
            authorKind={authorKind}
            viewOnly={viewOnly}
            store={store}
          />
        ) : null}
        {showReactionRow && (
          <div
            className="mt-1 flex flex-wrap items-center gap-1"
            data-testid="reaction-row"
            data-message-id={message.id}
          >
            {reactions.map((r) => (
              <ReactionChip
                key={r.emoji}
                channelId={message.channel_id}
                messageId={message.id}
                emoji={r.emoji}
                count={r.count}
                me={r.me}
                online={online}
                onToggle={() => onToggleReaction?.(message.id, r.emoji)}
              />
            ))}

            <ReactionPicker
              disabled={!online}
              appliedEmojis={reactions.map((r) => r.emoji)}
              onPick={(emoji) => onToggleReaction?.(message.id, emoji)}
            />

            {reactionError ? (
              <span
                role="alert"
                className="inline-flex flex-wrap items-center gap-1.5 text-xs text-danger"
                data-testid="reaction-error"
              >
                <span data-testid="reaction-error-message">{reactionError.message}</span>
                <button
                  type="button"
                  className="rounded px-1 font-medium text-accent transition-colors duration-[var(--duration-control)] hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
                  data-testid="reaction-retry"
                  onClick={() => onRetryReaction?.(message.id, reactionError.emoji)}
                >
                  Retry
                </button>
                <button
                  type="button"
                  className="rounded px-1 text-text-muted transition-colors duration-[var(--duration-control)] hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
                  data-testid="reaction-dismiss"
                  onClick={() => onDismissReaction?.()}
                >
                  Dismiss
                </button>
              </span>
            ) : null}
          </div>
        )}
      </div>

      {showActions && actionsMounted && !editing && (
        <div
          // Reveal is `group-hover:` here plus the KEYBOARD-focus rule in
          // shell.css (`.message-actions-host:has(:focus-visible)`). A plain
          // `group-focus-within:` also matched a mouse click — the row is
          // tabIndex={-1}, so clicking it focuses it and the toolbar stayed
          // pinned open over the message above, blocking that row's hover
          // (user report 2026-09-11).
          // WHERE it sits is config-driven (messageActionsPlacement.ts):
          // 'top-right' is the horizontal pill pinned to the hovered message's
          // own top-right (the reference client's placement, which replaced
          // `bottom-full` because a bar over the message above made ownership
          // ambiguous — user report 2026-09-12); 'left-rail' is a vertical
          // stack in the gutter left of the message, vertically centered on
          // it. Both are hover-only; the geometry lives in shell.css so the
          // switch is one attribute.
          ref={railRef}
          data-placement={placement}
          // `hidden` at rest, NOT merely transparent: a laid-out 225px rail
          // adds its own overflow to the message scroller, which moved the
          // timeline's settle point and sliced the newest row (caught by
          // e2e/pane-layout.spec.ts, 2026-09-12). Hidden costs nothing and is
          // pointer-inert by construction; the clamp measures the rail in the
          // same hover that reveals it.
          className="message-actions popover absolute z-20 hidden items-center gap-0.5 py-0.5 pl-1 pr-1 opacity-0 transition-opacity duration-[var(--duration-control)] group-hover:flex group-hover:opacity-100"
          data-testid="message-actions"
        >
          {onToggleReaction ? (
            // The hover toolbar's react affordance is ALWAYS available —
            // even when the message already carries reactions — with the
            // already-applied emojis disabled inside (removal rides the
            // chips). Icon variant matches the toolbar's SVG set.
            <ReactionPicker
              variant="icon"
              disabled={!online}
              appliedEmojis={reactions.map((r) => r.emoji)}
              onPick={(emoji) => onToggleReaction?.(message.id, emoji)}
            />
          ) : onReact ? (
            <button
              type="button"
              onClick={handleReact}
              className={actionBtn}
              aria-label="React to message"
              data-testid="action-react"
            >
              {actionIcon(SMILEY_PATH)}
            </button>
          ) : null}
          {/* The popover separator token (text-derived): --color-line
              disappears against the pill's near-black plate, and the old
              white/20 vanished on the light theme's white one. */}
          {(onToggleReaction || onReact) &&
            (onReply ||
              onStartThread ||
              canCopyLink ||
              showRemind ||
              (canEdit && onEdit) ||
              (canDelete && onDelete)) && (
              <span aria-hidden className="message-actions-divider mx-0.5 h-5 w-px bg-separator" />
            )}
          {onReply && (
            <button
              type="button"
              onClick={(e) => handleReply(e)}
              className={actionBtn}
              aria-label="Reply to message"
              title="Reply (Shift+click: don't ping)"
              data-testid="action-reply"
            >
              {actionIcon(REPLY_PATH)}
            </button>
          )}
          {/* #114 Copy Link: sits with Reply, BEFORE the author/moderator
              controls — it is a share action on the message, not a mutation
              of it, so it must not read as a neighbour of Delete. It is the
              only action here with no permission gate (a permalink is not
              author-scoped), which is why it is emitted unconditionally from
              configuration rather than from a capability check. */}
          {canCopyLink && (
            <button
              type="button"
              onClick={handleCopyLink}
              className={actionBtn}
              aria-label="Copy link to message"
              title="Copy link to message"
              data-testid="action-copy-link"
            >
              {actionIcon(LINK_PATH)}
            </button>
          )}
          {/* #54 "Remind me…": a personal action beside the share action —
              like Copy Link it changes nothing anyone else can see. */}
          {showRemind && (
            <MarkPicker
              channelId={message.channel_id}
              messageId={message.id}
              disabled={!online}
              buttonClassName={actionBtn}
              icon={actionIcon}
            />
          )}
          {onStartThread && (
            <button
              type="button"
              onClick={() => onStartThread?.(message.id, content)}
              className={actionBtn}
              aria-label="Start thread"
              title="Start thread"
              data-testid="action-start-thread"
            >
              {actionIcon(THREAD_PATH)}
            </button>
          )}
          {canEdit && onEdit && (
            <button
              type="button"
              onClick={handleEdit}
              className={actionBtn}
              aria-label="Edit message"
              data-testid="action-edit"
            >
              {actionIcon(PENCIL_PATH)}
            </button>
          )}
          {canDelete && onDelete && (
            <button
              type="button"
              onClick={handleDelete}
              className={actionBtnDanger}
              aria-label="Delete message"
              data-testid="action-delete"
            >
              {actionIcon(TRASH_PATH)}
            </button>
          )}
        </div>
      )}
    </div>
  );

  // The author-group gap (see `groupGap`) sits OUTSIDE the highlighted row:
  // padding on this plain wrapper, so the hover tint, the mention accent and
  // the toolbar's geometry all belong to the message box inside it. The
  // wrapper is always rendered, so toggling the gap never remounts the row.
  return (
    <div
      className={groupGap ? (compact ? 'pt-2' : 'pt-3') : undefined}
      data-testid="message-row"
      data-group-gap={groupGap || undefined}
    >
      {row}
    </div>
  );
});
