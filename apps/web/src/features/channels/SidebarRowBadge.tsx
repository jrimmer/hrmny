/**
 * @cytale/web — the ONE sidebar row badge (UI consistency, 2026-09-27).
 *
 * Every sidebar destination row — a channel, a DM, a followed thread — says
 * "something new here" the same way, and the channel row is the standard:
 *
 *   * a MENTION count (red, `.channel-mentions`) when anything mentions you,
 *     and it TAKES PRECEDENCE — one badge per row, never two side by side;
 *   * otherwise the UNREAD count (`.channel-unread`);
 *   * otherwise nothing.
 *
 * Before this, channel rows showed mention-or-unread, DM rows showed BOTH
 * badges at once, and My Threads rows drew one-off colored dots. The row's
 * own weight (`data-unread` on `.channel-row`) is the host's job; this is
 * only the trailing badge. The counts are DATA the host resolves (the store's
 * unread slices) — presentation is all this owns.
 *
 * ## The notification level (notification controls, 2026-09-27)
 *
 * The row's EFFECTIVE level decides whether the unread half may show at all:
 *
 *   * `all`      — mention-or-unread, as above;
 *   * `mentions` — the mention badge only: the member asked to hear about
 *                  mentions, so a count of ordinary traffic is noise;
 *   * `mute`     — the mention badge only, and the row renders MUTED
 *                  (`rowNotificationAttrs` + `MutedGlyph`). A mention through
 *                  a mute still shows — that is the one thing a mute must not
 *                  swallow silently.
 *
 * A DM is addressed as a whole, so its host maps every level except `mute`
 * to `all` (`dmRowLevel`): "mentions only" on a conversation that is all
 * addressed to you would hide exactly what it exists to show.
 */

import { BellOffIcon } from '../../app/ui/icons.js';
import type { NotificationLevel } from '../notifications/notificationPrefs.js';

export interface SidebarRowBadgeProps {
  /** Unread messages in the destination (0 = none). */
  unread: number;
  /** Mentions of the current user in the destination (0 = none). */
  mentions: number;
  /** The destination's effective notification level (default `all`). */
  level?: NotificationLevel;
  /** testid on the mention badge. */
  mentionsTestId?: string;
  /** testid on the unread badge. */
  unreadTestId?: string;
}

/** Whether a row at this level may show its unread half (count and weight). */
export function showsUnread(level: NotificationLevel = 'all'): boolean {
  return level === 'all';
}

/** A DM's row level: only a mute changes how a conversation row reads. */
export function dmRowLevel(level: NotificationLevel): NotificationLevel {
  return level === 'mute' ? 'mute' : 'all';
}

/**
 * The `.channel-row` attributes a level contributes, shared by channel, DM
 * and thread rows so all three dim and weigh the same way. `unread` is the
 * row's raw unread count; the weight only applies where the level shows it —
 * except `mentions`, which keeps the WEIGHT (something new is here) while
 * dropping the COUNT (how much is not the member's question at that level).
 */
export function rowNotificationAttrs(level: NotificationLevel, unread: number) {
  const muted = level === 'mute';
  return {
    'data-muted': muted || undefined,
    'data-level': level,
    'data-unread': (!muted && unread > 0) || undefined,
  } as const;
}

/** The accessible-name suffix a row's level adds (", muted"). */
export function levelNameSuffix(level: NotificationLevel): string {
  return level === 'mute' ? ', muted' : '';
}

/** The trailing bell-off glyph a muted row draws (decorative: the name says "muted"). */
export function MutedGlyph({ testId }: { testId?: string }) {
  return (
    <span className="channel-muted-glyph" aria-hidden="true" data-testid={testId}>
      <BellOffIcon size={14} />
    </span>
  );
}

export function SidebarRowBadge({ unread, mentions, level = 'all', mentionsTestId, unreadTestId }: SidebarRowBadgeProps) {
  if (mentions > 0) {
    return (
      <span
        className="channel-mentions"
        data-testid={mentionsTestId}
        aria-label={`${mentions} ${mentions === 1 ? 'mention' : 'mentions'}`}
      >
        {mentions}
      </span>
    );
  }
  if (unread > 0 && showsUnread(level)) {
    return (
      <span className="channel-unread" data-testid={unreadTestId} aria-label={`${unread} unread`}>
        {unread}
      </span>
    );
  }
  return null;
}
