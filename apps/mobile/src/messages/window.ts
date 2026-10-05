/**
 * @cytale/mobile — message-window derivations (plan 004 M6, R8).
 *
 * The pure half of the channel screen's list behaviour, kept out of the
 * component so the two behaviours the plan singles out — anchoring and the
 * unread divider — are testable without a native list:
 *
 *   * `chatOrder` flips the store's newest-first slice into chat order (the
 *     list's data order: oldest at top, newest at the bottom it opens on);
 *   * `firstUnreadMessageId` reproduces the web divider rule exactly
 *     (`apps/web/src/features/messages/MessageList.tsx`): the first message
 *     newer than the read watermark, skipping my own rows and optimistic
 *     placeholders, with a null watermark meaning "everything is new";
 *   * `dividerRetired` decides when the divider is scrolled past (it sits
 *     above the viewport) AFTER it has been on screen, the mobile contract's
 *     clearing rule. The `seen` gate is load-bearing: the list opens on the
 *     newest message (R8), so the divider starts life above the viewport and
 *     an ungated "first viewable is past it" test would retire it before the
 *     reader could ever scroll up to it.
 *
 * Prepend anchoring itself is FlashList's `maintainVisibleContentPosition`
 * (v2, on by default, keyed by `keyExtractor`) — this module supplies the
 * stable identities it needs and the assertions the tests make.
 */
import type { Message } from '@cytale/domain';
import { compareSnowflakes } from '@cytale/domain';
import type { UnreadState } from '@cytale/state';

/** Optimistic placeholder ids never carry the divider (web's rule). */
const PLACEHOLDER_PREFIX = 'pending_';

/** The store's newest-first window, flipped to chat order (oldest first). */
export function chatOrder(items: readonly Message[]): Message[] {
  return [...items].reverse();
}

export interface DividerSource {
  /** The window in chat order (oldest first). */
  ordered: readonly Message[];
  /** The channel's unread slice; absent = no unread information. */
  unread: Pick<UnreadState, 'last_read_id' | 'unread_count'> | undefined;
  /** Current user id — own rows never open an unread run. */
  currentUserId: string | null;
}

/**
 * The id of the message the "NEW" divider renders above, or null when there
 * is nothing new. Mirrors web's capture: badge count > 0, then the first
 * non-own, non-placeholder row newer than `last_read_id`.
 */
export function firstUnreadMessageId({
  ordered,
  unread,
  currentUserId,
}: DividerSource): string | null {
  if (unread === undefined || unread.unread_count === 0) return null;
  const lastRead = unread.last_read_id;
  for (const message of ordered) {
    if (message.author_id === currentUserId) continue;
    if (message.id.startsWith(PLACEHOLDER_PREFIX)) continue;
    if (lastRead === null || compareSnowflakes(message.id, lastRead) > 0) {
      return message.id;
    }
  }
  return null;
}

/**
 * True once the divider's row has been seen AND has since scrolled above the
 * viewport — the "scrolling past clears it" rule.
 *
 * `null` for either index means "not known yet" — the divider stays. The
 * `seen` gate exists because the list opens at the newest message: the
 * divider is above the viewport from the first frame, so only a reader who
 * has scrolled up to (or above) the divider and come back down has actually
 * passed it.
 */
export function dividerRetired(
  dividerIndex: number | null,
  firstViewableIndex: number | null,
  seen: boolean,
): boolean {
  if (!seen) return false;
  if (dividerIndex === null || firstViewableIndex === null) return false;
  return firstViewableIndex > dividerIndex;
}

/** Index of a message in chat order, or -1. */
export function indexOfMessage(ordered: readonly Message[], id: string | null): number {
  if (id === null) return -1;
  return ordered.findIndex((message) => message.id === id);
}
