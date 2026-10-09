/**
 * @cytale/web — what a thread roster row says (owner direction 2026-10-08).
 *
 * A thread named by a machine (`thread-388032`) or left at the composer's
 * default says nothing about itself, so the row is named by the first line of
 * the message it was started from instead. The second line previews the
 * newest reply, and the roster groups by when it last moved. Pure: the panel
 * hands in the resolvers, so these are tested without a store.
 */
import type { Message, Thread, ThreadMessagePreview } from '@cytale/domain';
import {
  previewText,
  resolveMentionTokens,
  type ChannelResolver,
  type MentionResolver,
} from '@cytale/markdown';

/** A name nobody chose: a bot's `thread-<digits>`, or the composer's default. */
export function isGeneratedThreadName(name: string): boolean {
  const n = name.trim();
  return n === '' || /^thread[-_ ]?\d+$/i.test(n) || /^new thread$/i.test(n);
}

/**
 * One line of plain text for a previewed message: its body with markup
 * dropped and mentions named, else its card's title, else what it attached.
 */
export function previewLine(
  preview: ThreadMessagePreview | null | undefined,
  resolveMention?: MentionResolver,
  resolveChannel?: ChannelResolver,
): string {
  if (!preview) return '';
  const text = resolveMentionTokens(previewText(preview.content), resolveMention, resolveChannel);
  if (text !== '') return text;
  if (preview.embed_title) return preview.embed_title;
  if (preview.attachment_count === 1) return 'Sent an attachment';
  if (preview.attachment_count > 1) return `Sent ${preview.attachment_count} attachments`;
  return '';
}

/**
 * A message already loaded on the page, in the roster's preview shape, so a
 * surface holding the start message itself can name a thread the same way.
 */
export function messagePreview(
  m: Pick<Message, 'id' | 'author_id' | 'content' | 'created_at' | 'attachments'> & {
    embeds?: readonly { title?: string | null }[] | null;
  },
): ThreadMessagePreview {
  return {
    id: m.id,
    author_id: m.author_id,
    author_name: null,
    content: m.content,
    embed_title: m.embeds?.find((e) => e.title)?.title ?? null,
    attachment_count: m.attachments?.length ?? 0,
    created_at: m.created_at,
  };
}

/** The row's title: the chosen name, or the start message when nobody chose one. */
export function threadSubject(
  thread: Pick<Thread, 'name' | 'starter'>,
  resolveMention?: MentionResolver,
  resolveChannel?: ChannelResolver,
): string {
  if (!isGeneratedThreadName(thread.name)) return thread.name;
  return previewLine(thread.starter, resolveMention, resolveChannel) || thread.name;
}

export type ActivityGroup = 'today' | 'week' | 'older';

export const ACTIVITY_GROUP_LABEL: Record<ActivityGroup, string> = {
  today: 'Today',
  week: 'This week',
  older: 'Older',
};

/** When the thread last moved: its newest reply, else its creation. */
export function lastActivity(thread: Pick<Thread, 'latest_reply_at' | 'created_at'>): string {
  return thread.latest_reply_at ?? thread.created_at;
}

/** Today (the local calendar day), the six days before it, or older. */
export function activityGroup(iso: string, now: number = Date.now()): ActivityGroup {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'older';
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  if (then >= startOfToday.getTime()) return 'today';
  const startOfWeek = new Date(startOfToday);
  startOfWeek.setDate(startOfWeek.getDate() - 6);
  return then >= startOfWeek.getTime() ? 'week' : 'older';
}

/** Newest activity first, split into the groups that have rows, in order. */
export function groupByActivity<T extends Pick<Thread, 'latest_reply_at' | 'created_at'>>(
  threads: readonly T[],
  now: number = Date.now(),
): { group: ActivityGroup; threads: T[] }[] {
  // By instant, not by string: the server's stamps vary in fractional digits.
  const at = (t: T) => Date.parse(lastActivity(t)) || 0;
  const sorted = [...threads].sort((a, b) => at(b) - at(a));
  const order: ActivityGroup[] = ['today', 'week', 'older'];
  return order
    .map((group) => ({ group, threads: sorted.filter((t) => activityGroup(lastActivity(t), now) === group) }))
    .filter((g) => g.threads.length > 0);
}
