/**
 * @cytale/web — thread name derivation.
 *
 * Threads are named after the message that starts them (no title prompt):
 * the parent message's text, mention-resolved, markdown-stripped, whitespace-
 * collapsed and truncated. Discord's shape — a thread reads as a continuation
 * of its seed message, and the user never types a title.
 *
 * The server requires a non-empty name, so a media-only message (no text)
 * falls back to a generic label rather than failing the call.
 */

/** Longest derived name (server accepts any non-empty string; UI stays sane). */
export const THREAD_NAME_MAX = 100;

/** Fallback when the seed message carries no text (image/file-only). */
export const THREAD_NAME_FALLBACK = 'Thread';

/**
 * Derive a thread name from a message's raw content.
 *
 * @param content        message markdown (`<@snowflake>` tokens included)
 * @param resolveMention optional id → display-name lookup; unresolved
 *                       mentions are dropped rather than leaking a snowflake
 */
export function threadNameFromMessage(
  content: string,
  resolveMention?: (userId: string) => string | undefined,
): string {
  const cleaned = content
    // Mentions: @display-name when known, dropped when not (a raw snowflake
    // in a thread title is worse than nothing).
    .replace(/<@(\d{1,19})>/g, (_match, id: string) => {
      const name = resolveMention?.(id);
      return name ? `@${name}` : '';
    })
    // Markdown links keep their text; inline emphasis/code markers go.
    .replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1')
    .replace(/[*_~`]+/g, '')
    // Newlines/tabs collapse to single spaces.
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned === '') return THREAD_NAME_FALLBACK;
  if (cleaned.length <= THREAD_NAME_MAX) return cleaned;
  return `${cleaned.slice(0, THREAD_NAME_MAX - 1).trimEnd()}…`;
}
