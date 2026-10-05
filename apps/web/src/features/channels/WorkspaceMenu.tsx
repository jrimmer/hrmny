/**
 * @cytale/web — workspace dropdown (server-header menu, Discord parity).
 *
 * Discord's server-name affordance: the workspace name + caret opens the
 * workspace options menu (Invite People, Create Channel, Create Workspace,
 * Integrations — only items the surface can actually perform are listed).
 *
 * With no active workspace the menu collapses to "Create Workspace" —
 * Discord's empty-rail "+ Create My Own" flow — so a fresh install still
 * has a live affordance in the header instead of a dead caret.
 *
 * Keyboard: the trigger toggles; ArrowUp/Down move, Enter/Space activate,
 * Escape closes and restores focus to the trigger; outside click closes.
 * Same contract as the user-panel presence menu.
 */

import { useState, type ReactNode } from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/shadcn/dropdown-menu.js';
import { GearIcon } from '../../app/layout/HeaderActionsMenu.js';
import { NotificationLevelMenuGroup } from '../notifications/NotificationLevelMenu.js';
import { workspaceTarget } from '../notifications/notificationPrefs.js';

export interface WorkspaceMenuProps {
  workspaceName: string;
  /** True when a workspace is active (gates the workspace-scoped items). */
  hasActiveWorkspace: boolean;
  /**
   * The active workspace's id — the target of the menu's Notifications group
   * (the workspace level + "Use account default" + "Suppress @everyone and
   * @here"). Absent hides the group.
   */
  workspaceId?: string | null;
  /** Opens the Invite People dialog. */
  onInvitePeople?: () => void;
  /** Opens the Create Channel dialog. */
  onCreateChannel?: () => void;
  /** Opens the Create Workspace dialog. */
  onCreateWorkspace?: () => void;
  /** Opens the integrations surface (U13). */
  onOpenIntegrations?: () => void;
  /** Opens the workspace settings surface (image + name; the admin tier
   *  gates the controls — the item stays visible for everyone). */
  onOpenWorkspaceSettings?: () => void;
  /**
   * Opens the workspace Media settings dialog (calls V2 plan U8). The
   * permission posture is server-side honesty: the dialog's 403 renders
   * its own permission-denied state, so every member sees the entry.
   */
  onOpenMediaSettings?: () => void;
  /** Opens the nickname dialog for YOUR nickname in this workspace (#169). */
  onChangeNickname?: () => void;
}

interface MenuItem {
  key: string;
  label: string;
  testId: string;
  icon: ReactNode;
  onSelect?: () => void;
  /** Entries opening a full-width mobile surface must close the drawer. */
  drawerClose?: boolean;
}

function NameTagIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        d="M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6zm2 0v12h14V6H5zm2 3h6v2H7V9zm0 4h10v2H7v-2z"
        fill="currentColor"
      />
    </svg>
  );
}

function PersonAddIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        d="M10 5a4 4 0 1 1 0 8 4 4 0 0 1 0-8zm-7 15a7 7 0 0 1 14 0v1H3v-1zm18-9h2v2h-2v2h-2v-2h-2v-2h2V9h2z"
        fill="currentColor"
      />
    </svg>
  );
}

function HashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        d="M10.5 3 9.7 8H5.6l-.4 3h4.1l-.6 4H4.6l-.4 3h4.1l-.8 5h3l.8-5h3l-.8 5h3l.8-5h4.1l.4-3h-4.1l.6-4h4.1l.4-3h-4.1l.8-5h-3l-.8 5h-3l.8-5h-3zM9.9 12h3l-.6 4h-3l.6-4z"
        fill="currentColor"
      />
    </svg>
  );
}

function PlusCircleIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-4H7v-2h4V7h2v4h4v2h-4v4z"
        fill="currentColor"
      />
    </svg>
  );
}


function PuzzleIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        d="M7 2v3H4.5A1.5 1.5 0 0 0 3 6.5V11h18V6.5A1.5 1.5 0 0 0 19.5 5H17V2h-2v3H9V2H7zm-4 11v4.5A1.5 1.5 0 0 0 4.5 19H7v3h2v-3h6v3h2v-3h2.5a1.5 1.5 0 0 0 1.5-1.5V13H3z"
        fill="currentColor"
      />
    </svg>
  );
}

function MediaSettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        d="M18 6l2.3-2.3 1.4 1.4L19.4 7.4 21 9H3l1.6-1.6-2.3-2.3 1.4-1.4L6 6h12zM4 11h16v2H4v-2zm2.5 4h11l1.5 2-1.5 2h-11l-1.5-2 1.5-2z"
        fill="currentColor"
      />
    </svg>
  );
}

export function WorkspaceMenu({
  workspaceName,
  hasActiveWorkspace,
  workspaceId = null,
  onInvitePeople,
  onCreateChannel,
  onCreateWorkspace,
  onOpenIntegrations,
  onOpenWorkspaceSettings,
  onOpenMediaSettings,
  onChangeNickname,
}: WorkspaceMenuProps) {
  // #150: Radix DropdownMenu owns open state, outside-click, Escape, focus
  // trap, and roving focus — the ~80 lines of hand-rolled equivalents this
  // file carried (pointer-down listeners, keydown roving, blur returns) are
  // deleted. Testids preserved so the suites ride unchanged.
  const [open, setOpen] = useState(false);

  // Discord parity: only list actions this client can actually perform.
  const candidates: Array<MenuItem | null> = [
    hasActiveWorkspace && onInvitePeople
      ? {
          key: 'invite',
          label: 'Invite People',
          testId: 'workspace-menu-invite',
          icon: <PersonAddIcon />,
          onSelect: onInvitePeople,
        }
      : null,
    hasActiveWorkspace && onChangeNickname
      ? {
          key: 'change-nickname',
          label: 'Change Nickname',
          testId: 'workspace-menu-change-nickname',
          icon: <NameTagIcon />,
          onSelect: onChangeNickname,
        }
      : null,
    hasActiveWorkspace && onCreateChannel
      ? {
          key: 'create-channel',
          label: 'Create Channel',
          testId: 'workspace-menu-create-channel',
          icon: <HashIcon />,
          onSelect: onCreateChannel,
        }
      : null,
    onCreateWorkspace
      ? {
          key: 'create-workspace',
          label: 'Create Workspace',
          testId: 'workspace-menu-create-workspace',
          icon: <PlusCircleIcon />,
          onSelect: onCreateWorkspace,
        }
      : null,
    onOpenIntegrations
      ? {
          key: 'integrations',
          label: 'Integrations',
          testId: 'workspace-menu-integrations',
          icon: <PuzzleIcon />,
          onSelect: onOpenIntegrations,
        }
      : null,
    hasActiveWorkspace && onOpenWorkspaceSettings
      ? {
          key: 'workspace-settings',
          label: 'Workspace Settings',
          testId: 'workspace-menu-settings',
          drawerClose: true,
          icon: <GearIcon />,
          onSelect: onOpenWorkspaceSettings,
        }
      : null,
    hasActiveWorkspace && onOpenMediaSettings
      ? {
          key: 'media-settings',
          label: 'Media Settings',
          testId: 'workspace-menu-media-settings',
          icon: <MediaSettingsIcon />,
          onSelect: onOpenMediaSettings,
        }
      : null,
  ];
  const items = candidates.filter((item): item is MenuItem => item !== null);

  return (
    // #150: Radix DropdownMenu (through the house wrapper). The trigger is
    // asChild so the gear keeps its house class and testid; the content
    // keeps the workspace-menu-popover look plus the house elevation token.
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <div className="workspace-menu">
        {/* Owner direction 2026-09-12: the name is a LABEL, not a trigger.
            The caret that used to sit here and the separate ⋯ Actions button
            both led to (or duplicated) this menu — the ⋯ offered only "Create
            channel", which this menu already carries — so the header
            centralises on one gear in the right slot. */}
        <span className="server-name-text server-name-label" data-testid="workspace-name">
          {workspaceName}
        </span>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="server-action"
            /* NOT prefixed with the workspace name: only one workspace header
               is mounted at a time, and a name-prefixed label made every
               `getByRole('button', { name: /^<workspace>/ })` ambiguous — it
               matched this gear as well as the rail's workspace button, which
               is how the gear broke two phone-shell e2e tests. */
            aria-label="Workspace settings and actions"
            title="Workspace settings and actions"
            data-testid="workspace-menu-trigger"
          >
            <GearIcon />
          </button>
        </DropdownMenuTrigger>
      </div>

      <DropdownMenuContent
        className="workspace-menu-popover"
        align="end"
        sideOffset={6}
        aria-label={`${workspaceName} options`}
        data-testid="workspace-menu"
      >
        {items.map((item) => (
          <DropdownMenuItem
            key={item.key}
            className="workspace-menu-item"
            data-testid={item.testId}
            {...item.drawerClose ? { 'data-drawer-close': true } : {}}
            onSelect={() => {
              item.onSelect?.();
            }}
          >
            <span className="workspace-menu-icon" aria-hidden="true">
              {item.icon}
            </span>
            <span>{item.label}</span>
          </DropdownMenuItem>
        ))}
        {/* Notification controls (2026-09-27): the workspace's own level,
            "Use account default", and the per-workspace broadcast switch —
            the one place a member quiets a whole workspace at once. */}
        {hasActiveWorkspace && workspaceId ? (
          <>
            <DropdownMenuSeparator />
            <NotificationLevelMenuGroup
              target={workspaceTarget(workspaceId)}
              testIdPrefix="workspace-menu"
              withBroadcastSwitch
              onDone={() => setOpen(false)}
            />
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
