/**
 * @cytale/web — ChannelListItem (U20; calls plan U11 extends).
 *
 * A single channel row in the sidebar: `#` prefix, name, unread indicator
 * (dot or count), and a highlighted mention count. Selection language per
 * corpus §6.4: neutral pill (`bg-surface-selected`) for the active channel —
 * color stays reserved for meaning (unread bars, mention counts, a LIVE
 * ring).
 *
 * Calls plan U11: a ringing channel carries `data-ringing` — the transient
 * accent emphasis that is the ring's VISUAL equivalent on the sidebar row
 * (WCAG: never sound-only), alive exactly while the store's ring slice
 * holds the entry (mount → toast, expiry/dismiss/join → gone).
 *
 * Calls plan U11 (AM6/AM18): the row owns the channel context menu —
 * right-click, long-press (mobile), or the keyboard-reachable "⋯" overflow
 * button (ChannelContextMenu). Keyboard: the row is a button (natively
 * focusable + Enter/Space activatable) so the sidebar is fully operable
 * without a pointer.
 */

import { memo, useRef, useState } from 'react';

import type { Channel } from '@cytale/domain';

import { ChannelContextMenu, useChannelLongPress } from './ChannelContextMenu.js';
import { useRowLevel } from '../notifications/notificationPrefs.js';
import {
  levelNameSuffix,
  MutedGlyph,
  rowNotificationAttrs,
  showsUnread,
  SidebarRowBadge,
} from './SidebarRowBadge.js';

export interface ChannelListItemProps {
  channel: Channel;
  /** True when this is the active channel (persistent selection pill). */
  active?: boolean;
  /** Unread count (0 = no badge). */
  unread?: number;
  /** Mention count (highlighted when > 0). */
  mentions?: number;
  /** True while a call is live in this channel (live-call badge, R3). */
  live?: boolean;
  /** True while a call in this channel is ringing THIS client (U11). */
  ringing?: boolean;
  /** Called when the channel is selected. */
  onSelect?: (channelId: string) => void;
  /** Opens the channel settings dialog (gear menu entry). */
  onOpenSettings?: (channelId: string) => void;
  /** Opens the channel's thread roster (gear menu entry). */
  onOpenThreads?: (channelId: string) => void;
}

/**
 * Memoized (lane D #17): the sidebar re-renders whenever ANY channel's badge
 * moves, and every row re-rendered with it. A row's props are its record,
 * primitives and stable callbacks, so an unchanged row now skips the render.
 */
export const ChannelListItem = memo(function ChannelListItem({
  channel,
  active = false,
  unread = 0,
  mentions = 0,
  live = false,
  ringing = false,
  onSelect,
  onOpenSettings,
  onOpenThreads,
}: ChannelListItemProps) {
  // The row's EFFECTIVE notification level (notification controls): a muted
  // row dims and drops its unread half, a mentions-only row drops the count.
  // Read from the shared preference slice, so a header click re-renders
  // exactly this row.
  const level = useRowLevel({ workspaceId: channel.workspace_id, channelId: channel.id });
  const hasUnread = unread > 0 && showsUnread(level);
  const hasMentions = mentions > 0;

  // The channel context menu (U11): right-click / long-press / "⋯" trigger.
  const [menuOpen, setMenuOpen] = useState(false);
  const overflowRef = useRef<HTMLButtonElement | null>(null);
  const longPress = useChannelLongPress(() => setMenuOpen(true));

  return (
    <li className="channel-list-item">
      <button
        type="button"
        data-testid={`channel-${channel.id}`}
        data-active={active || undefined}
        {...rowNotificationAttrs(level, unread)}
        data-mentions={hasMentions || undefined}
        data-live={live || undefined}
        data-ringing={ringing || undefined}
        aria-current={active ? 'page' : undefined}
        aria-label={`${channel.name}${levelNameSuffix(level)}${ringing ? ', call ringing' : ''}${live ? ', live call' : ''}${hasUnread ? `, ${unread} unread` : ''}${hasMentions ? `, ${mentions} mentions` : ''}`}
        className="channel-row"
        onClick={() => onSelect?.(channel.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuOpen(true);
        }}
        onTouchStart={longPress.onTouchStart}
        onTouchEnd={longPress.onTouchEnd}
        onTouchMove={longPress.onTouchMove}
        onTouchCancel={longPress.onTouchCancel}
      >
        <span className="channel-prefix" aria-hidden="true">
          #
        </span>
        <span className="channel-name">{channel.name}</span>

        {ringing ? (
          <span className="channel-ring" data-testid={`ringing-${channel.id}`} aria-hidden="true" />
        ) : null}

        {live && !ringing ? (
          <span className="channel-live" data-testid={`live-${channel.id}`} aria-hidden="true" />
        ) : null}

        {level === 'mute' ? <MutedGlyph testId={`muted-${channel.id}`} /> : null}

        <SidebarRowBadge
          unread={unread}
          mentions={mentions}
          level={level}
          mentionsTestId={`mentions-${channel.id}`}
          unreadTestId={`unread-${channel.id}`}
        />
      </button>

      {/* Keyboard-reachable context trigger (hover is never the only path);
          40×40 hit area per UX_SPEC §6. A GEAR glyph, right-aligned in the
          row, revealed on row hover / keyboard focus only (opacity handles
          the reveal; the layout zone is reserved so the row never shifts). */}
      <button
        type="button"
        ref={overflowRef}
        className="channel-context-trigger"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={`${channel.name} options`}
        data-testid={`channel-context-trigger-${channel.id}`}
        onClick={() => setMenuOpen(true)}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path
            d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2z"
            fill="currentColor"
          />
        </svg>
      </button>

      <ChannelContextMenu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        channelId={channel.id}
        workspaceId={channel.workspace_id ?? null}
        triggerRef={overflowRef}
        onOpenSettings={onOpenSettings}
        onOpenThreads={onOpenThreads}
      />
    </li>
  );
});
