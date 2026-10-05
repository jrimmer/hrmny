/**
 * @cytale/mobile — the inline-reply target (plan 004 M8, R11).
 *
 * The seam the action sheet hands to the composer: the sheet knows the
 * message, the composer owns the reply bar and the send. This module is the
 * contract between the two units (M8 writes it, M7's composer consumes it),
 * so the shape lives on its own — importing `MessageActionsSheet` from the
 * composer (or the reverse) would drag a whole component tree across a unit
 * boundary for one object.
 *
 * Parity note: web's `ReplyTarget` carries the resolved `authorName` because
 * its `MessagePane` builds the target while it holds the roster. Mobile
 * carries `authorId` only — the composer already resolves names through the
 * store's `membersById` (the same lookup `MessageList` uses for author lines),
 * so a target built by the sheet stays correct when the roster hydrates after
 * the long-press.
 *
 * `preview` is a ONE-LINE summary: web slices the raw content to 80 chars
 * (`MessagePane.startReply`), which can carry newlines into its reply bar.
 * Native renders the bar as a single line, so whitespace runs collapse and
 * the result is ellipsized at the same budget.
 */
import type { Message } from '@cytale/domain';

/** Preview budget in characters (web's `snippet` is 80; same contract). */
export const REPLY_PREVIEW_MAX = 80;

/**
 * The message a composer is replying to. `ping` follows Discord semantics:
 * omitted/false-y is a silent reply, true pings the author (web defaults to
 * ping on; Shift+click starts suppressed).
 */
export interface ReplyTarget {
  messageId: string;
  authorId: string;
  /** One-line, whitespace-collapsed content summary (never multi-line). */
  preview: string;
  ping?: boolean;
}

/** Flatten arbitrary message content into the one-line preview. */
export function replyPreview(content: string | null | undefined): string {
  const flat = (content ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= REPLY_PREVIEW_MAX) return flat;
  return `${flat.slice(0, REPLY_PREVIEW_MAX - 1)}…`;
}

/**
 * Build the target the sheet's Reply action emits. `ping` defaults to true
 * (Discord: replying pings unless explicitly suppressed).
 */
export function replyTargetFor(message: Message, options: { ping?: boolean } = {}): ReplyTarget {
  return {
    messageId: message.id,
    authorId: message.author_id,
    preview: replyPreview(message.content),
    ping: options.ping !== false,
  };
}
