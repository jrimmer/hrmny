/**
 * @cytale/web — channel context menu (calls plan U11, AM6/AM18; calls V2
 * plan U8 extends).
 *
 * FOUNDING NOTE (recorded per the unit brief): the repo shipped NO channel
 * context menu — the only dropdown surfaces were the server-header
 * WorkspaceMenu and the channel-header call menu. This is the minimal one,
 * added to the channel row's own affordances:
 *
 *   pointer   — right-click on the row (onContextMenu) or long-press
 *               (~500 ms touch-hold; the menu's own mobile handling, AM18)
 *   keyboard  — a "⋯" overflow button always in the row's tab order (hover
 *               is never the only path, UX_SPEC §7), aria-haspopup=menu
 *
 * Items:
 *
 *   Notifications (2026-09-27) — the channel's level as a radio group (All
 *               messages / Mentions only / Nothing / Use workspace default),
 *               the shared NotificationLevelMenuGroup every level menu
 *               renders; "Mute call rings" sits inside this group.
 *
 *   Mute call rings — V1's only item (toggleCallMute → PATCH
 *               /channels/{id}/call-notification-mute, U4). Success closes
 *               the menu; failure keeps it open with the inline alert +
 *               reverted label (optimistic rollback in notificationMute.ts).
 *
 *   Media overrides (U8, R16) — per-capability tri-state entries plus a
 *               reset, rendered ONLY when the workspace allows overrides
 *               (the view's overrides_allowed — fetched on open through
 *               mediaOverrides.ts). A 403 (plain member) or 404 hides
 *               them (the server is the enforcement point); a network
 *               failure renders them DISABLED with the inline alert —
 *               visible-disabled, never silently gone while the answer is
 *               recoverable. Overrides stay OPEN on toggle (several
 *               capabilities are settable in one visit); the label flips
 *               in place, failures revert + alert (mediaOverrides.ts).
 *
 * The keyboard contract is the WorkspaceMenu one: ArrowUp/Down move,
 * Enter/Space activate the FOCUSED item, Escape/Tab close, focus returns
 * to the trigger, outside pointer-down closes.
 */

import { useEffect, useRef, type RefObject } from 'react';

import { defaultStore } from '@cytale/state';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/shadcn/dropdown-menu.js';
import { useStoreSelector } from '../../app/useStoreSelector.js';
import { NotificationLevelMenuGroup } from '../notifications/NotificationLevelMenu.js';
import { channelTarget } from '../notifications/notificationPrefs.js';

import { getCallMute, toggleCallMute, useCallMute } from '../calls/ring/notificationMute.js';
import {
  effectiveValues,
  ensureMediaOverride,
  resetMediaOverride,
  toggleMediaOverride,
  useMediaOverride,
} from './mediaOverrides.js';

function ThreadsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z"
        fill="currentColor"
      />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2z"
        fill="currentColor"
      />
    </svg>
  );
}

function BellOffIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        d="M12 3a6 6 0 0 0-6 6v3.6l-1.7 3a1 1 0 0 0 .9 1.4h9.6l4.5 4.5 1.4-1.4L3.5 3.7 2.1 5.1 4.9 7.9A6 6 0 0 1 12 3zm0 18a2.5 2.5 0 0 0 2.4-1.8h-4.8A2.5 2.5 0 0 0 12 21zM18 9a6 6 0 0 1-.7 2.8l1.5 1.5A8 8 0 0 0 20 9z"
        fill="currentColor"
      />
    </svg>
  );
}

function MediaIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        d="M4 6h11a1 1 0 0 1 1 1v2.2l4-2.4v10.4l-4-2.4V17a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z"
        fill="currentColor"
      />
    </svg>
  );
}

interface MenuItem {
  key: string;
  label: string;
  testId: string;
  icon: () => React.JSX.Element;
  disabled?: boolean;
  /**
   * Radix closes a menu on item select by default; these items opt out to
   * keep the menu open (mute decides on its own outcome — closes only on
   * success; the media toggles stay for several capabilities per visit).
   */
  keepOpen?: boolean;
  activate: () => void | Promise<void>;
}

export interface ChannelContextMenuProps {
  /** True while the menu is open (controlled by the owning row). */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The channel the menu acts on. */
  channelId: string;
  /** The channel's workspace (the level group's fallback); read from the store when absent. */
  workspaceId?: string | null;
  /** Focus-return target (the "⋯" trigger). */
  triggerRef: RefObject<HTMLButtonElement | null>;
  /** Opens the channel settings dialog (name/topic/category). */
  onOpenSettings?: (channelId: string) => void;
  /** Opens the channel's thread roster (active + archived). */
  onOpenThreads?: (channelId: string) => void;
}

/** Items rendered inside the Notifications group rather than above it. */
const NOTIFICATION_GROUP_KEYS = new Set(['mute-rings']);

export function ChannelContextMenu({
  open,
  onOpenChange,
  channelId,
  workspaceId: workspaceIdProp,
  triggerRef,
  onOpenSettings,
  onOpenThreads,
}: ChannelContextMenuProps) {
  const mute = useCallMute(channelId);
  // The channel's workspace names the level group's fallback ("Use workspace
  // default"). The owning row knows it; a host that does not say reads it
  // from the store (a channel the store does not hold reads workspace-less).
  const storeWorkspaceId = useStoreSelector(defaultStore, (s) => s.channels[channelId]?.workspace_id ?? null);
  const workspaceId = workspaceIdProp === undefined ? storeWorkspaceId : workspaceIdProp;
  const media = useMediaOverride(channelId);

  // Fetch the override view on open (once per channel — the store guards).
  useEffect(() => {
    if (open) void ensureMediaOverride(channelId);
  }, [open, channelId]);

  /**
   * Toggle the ring mute. Success closes the menu (focus back to the
   * trigger); failure keeps it OPEN with the inline alert + reverted label
   * (the house inline-consequence pattern — no native dialogs).
   */
  const chooseMute = async () => {
    await toggleCallMute(channelId); // never throws; status carries outcome
    if (getCallMute(channelId).status !== 'error') onOpenChange(false);
  };

  // The media-override group: rendered only when the workspace allows
  // overrides (visibility rule, mediaOverrides.ts). A network failure
  // keeps the entries VISIBLE but disabled (the honest-disabled posture).
  const mediaKnown = media.status === 'ready' || media.status === 'error';
  const showMedia = mediaKnown && (media.status === 'error' || media.overridesAllowed);
  const mediaDisabled = media.status === 'error';

  const effective = effectiveValues(media);
  const capLabel = (cap: 'calls' | 'video' | 'screenshare', name: string) => {
    const value = effective[cap] ? 'On' : 'Off';
    const inherited = media.override[cap] == null ? 'inherited' : 'override';
    return `${name}: ${value} (${inherited})`;
  };

  const items: MenuItem[] = [
    ...(onOpenSettings
      ? ([
          {
            key: 'settings',
            label: 'Channel settings',
            testId: 'channel-context-settings',
            icon: GearIcon,
            activate: () => onOpenSettings(channelId),
          },
        ] as MenuItem[])
      : []),
    ...(onOpenThreads
      ? ([
          {
            key: 'threads',
            label: 'Threads',
            testId: 'channel-context-threads',
            icon: ThreadsIcon,
            activate: () => onOpenThreads(channelId),
          },
        ] as MenuItem[])
      : []),
    {
      key: 'mute-rings',
      label: mute.muted ? 'Unmute call rings' : 'Mute call rings',
      testId: 'channel-context-mute-rings',
      icon: BellOffIcon,
      disabled: mute.status === 'pending',
      keepOpen: true,
      activate: chooseMute,
    },
    ...(showMedia
      ? ([
          {
            key: 'media-calls',
            label: capLabel('calls', 'Calls'),
            testId: 'channel-context-media-calls',
            icon: MediaIcon,
            disabled: mediaDisabled,
            keepOpen: true,
            activate: () => toggleMediaOverride(channelId, 'calls'),
          },
          {
            key: 'media-video',
            label: capLabel('video', 'Video'),
            testId: 'channel-context-media-video',
            icon: MediaIcon,
            disabled: mediaDisabled,
            keepOpen: true,
            activate: () => toggleMediaOverride(channelId, 'video'),
          },
          {
            key: 'media-screenshare',
            label: capLabel('screenshare', 'Screenshare'),
            testId: 'channel-context-media-screenshare',
            icon: MediaIcon,
            disabled: mediaDisabled,
            keepOpen: true,
            activate: () => toggleMediaOverride(channelId, 'screenshare'),
          },
          {
            key: 'media-reset',
            label: 'Reset to workspace media defaults',
            testId: 'channel-context-media-reset',
            icon: MediaIcon,
            disabled: mediaDisabled,
            keepOpen: true,
            activate: () => resetMediaOverride(channelId),
          },
        ] as MenuItem[])
      : []),
  ];

  const renderItem = (item: MenuItem) => (
    <DropdownMenuItem
      key={item.key}
      className="workspace-menu-item channel-context-item"
      data-testid={item.testId}
      data-muted={item.key === 'mute-rings' ? mute.muted || undefined : undefined}
      data-status={item.key === 'mute-rings' ? mute.status : media.status}
      disabled={item.disabled}
      onSelect={(e) => {
        // keepOpen items cancel Radix's close-on-select (see MenuItem).
        if (item.keepOpen) e.preventDefault();
        if (!item.disabled) void item.activate();
      }}
    >
      <span className="workspace-menu-icon" aria-hidden="true">
        <item.icon />
      </span>
      <span>{item.label}</span>
    </DropdownMenuItem>
  );

  // #150: Radix DropdownMenu — the primitive owns outside-click, Escape,
  // focus trap, and roving focus (the hand-rolled keydown/pointer-down/
  // focusIndex machinery this file carried is deleted). The props contract
  // is unchanged: controlled open/onOpenChange, anchor via the owning row's
  // overflow button (virtual trigger through DropdownMenuTrigger's ref).
  if (!open) return null;

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      {/* Virtual anchor: the menu also opens from right-click / long-press on
          the row (not just the ⋯ button), so the Radix anchor is an inert
          zero-width span at the row's end — positioning only (stretched to
          the row's full height so "bottom" + sideOffset clears the row; see
          .channel-context-anchor in shell.css). The REAL ⋯ button keeps
          aria-haspopup/expanded and receives focus back on close
          (onCloseAutoFocus below). */}
      <DropdownMenuTrigger asChild>
        <span className="channel-context-anchor" aria-hidden="true" tabIndex={-1} data-testid="channel-context-anchor" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="channel-context-menu"
        align="end"
        alignOffset={4}
        sideOffset={4}
        aria-label="Channel options"
        data-testid="channel-context-menu"
        data-channel-id={channelId}
        onOpenAutoFocus={(e) => {
          // First item focused on open — ready for Enter (the hand-rolled
          // menu's contract; preventDefault suppresses Radix's default
          // container focus — see the wrapper's doc note).
          e.preventDefault();
          const first = (e.currentTarget as HTMLElement).querySelector<HTMLElement>(
            '[role="menuitem"]:not([data-disabled])',
          );
          first?.focus();
        }}
        onCloseAutoFocus={(e) => {
          // The owning row's ⋯ regains focus on close (the old contract).
          e.preventDefault();
          triggerRef.current?.focus();
        }}
      >
      {items.filter((item) => !NOTIFICATION_GROUP_KEYS.has(item.key) && !item.key.startsWith('media-')).map(renderItem)}
      {/* Notification controls (2026-09-27): the channel's level as a radio
          group plus "Use workspace default", with the call-ring mute grouped
          UNDER it — both answer "how loudly can this channel reach me". */}
      <DropdownMenuSeparator />
      <NotificationLevelMenuGroup
        target={channelTarget(channelId, workspaceId)}
        testIdPrefix="channel-context"
        onDone={() => onOpenChange(false)}
      >
        {items.filter((item) => NOTIFICATION_GROUP_KEYS.has(item.key)).map(renderItem)}
      </NotificationLevelMenuGroup>
      {showMedia ? <DropdownMenuSeparator /> : null}
      {items.filter((item) => item.key.startsWith('media-')).map(renderItem)}
      {mute.status === 'error' ? (
        <p className="channel-context-error" role="alert" data-testid="channel-context-error">
          Couldn&apos;t update the mute — check your connection and try again.
        </p>
      ) : null}
      {media.status === 'error' ? (
        <p className="channel-context-error" role="alert" data-testid="channel-context-media-error">
          Couldn&apos;t load media overrides — check your connection and try again.
        </p>
      ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Long-press detection for the owning row (the menu's mobile handling):
 * a ~500 ms touch-hold opens the menu; any move/end/cancel before that
 * aborts (a scroll must never open a menu). Returns the handlers plus a
 * guard flag so the row can swallow the synthetic click a fired long-press
 * would otherwise produce.
 */
export const LONG_PRESS_MS = 500;

export interface LongPressHandlers {
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchEnd: (e: React.TouchEvent) => void;
  onTouchMove: () => void;
  onTouchCancel: () => void;
}

export function useChannelLongPress(onLongPress: () => void): LongPressHandlers {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firedRef = useRef(false);

  const clear = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  return {
    onTouchStart: () => {
      firedRef.current = false;
      clear();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        firedRef.current = true;
        onLongPress();
      }, LONG_PRESS_MS);
    },
    onTouchEnd: (e: React.TouchEvent) => {
      const fired = firedRef.current;
      clear();
      if (fired) e.preventDefault(); // swallow the post-long-press click
    },
    onTouchMove: clear,
    onTouchCancel: clear,
  };
}
