/**
 * @cytale/web — the Notifications group every menu shares (notification
 * controls, 2026-09-27).
 *
 * One component for the header control's right-click menu, the channel
 * right-click menu, the workspace menu and the thread ⋯ menu, so the four
 * never word a level differently or order it differently:
 *
 *   Notifications
 *   ( ) 🔔 All messages
 *   ( ) @  Mentions only
 *   ( ) 🔕 Nothing
 *   ( )    Use workspace default (Mentions only)
 *
 * The reset is the group's FOURTH radio rather than a loose item: "no row
 * here, inherit" is a state the target can be in, and a radio shows it as
 * selected — which is what lets a member SEE that a channel is inheriting
 * rather than infer it from which of the three is lit. Choosing it clears the
 * target's own row (DELETE), choosing a level writes one (PUT).
 *
 * Items keep the menu OPEN while the write is in flight and close it on
 * success; a refusal leaves it open with the inline alert (the house
 * inline-consequence pattern — the ring-mute item's contract). The store has
 * already rolled back by then, so the radios show the truth again.
 */

import { useState, type ReactNode } from 'react';

import { defaultStore, type StateStore } from '@cytale/state';

import { AtSignIcon, BellIcon, BellOffIcon } from '../../app/ui/icons.js';
import {
  DropdownMenuCheckboxItem,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '../../components/shadcn/dropdown-menu.js';
import {
  clearTargetLevel,
  LEVEL_LABEL,
  resetLabel,
  setTargetLevel,
  setWorkspaceBroadcastSuppressed,
  useBroadcastSuppressed,
  useNotificationTarget,
  WRITE_FAILED_MESSAGE,
  type NotificationLevel,
  type NotificationTarget,
} from './notificationPrefs.js';

/** The glyph a level is drawn with, everywhere a level is named. */
export function LevelIcon({ level, size = 16 }: { level: NotificationLevel; size?: number }) {
  if (level === 'all') return <BellIcon size={size} />;
  if (level === 'mentions') return <AtSignIcon size={size} />;
  return <BellOffIcon size={size} />;
}

const LEVELS: NotificationLevel[] = ['all', 'mentions', 'mute'];
const INHERIT = 'inherit';

export interface NotificationLevelMenuGroupProps {
  target: NotificationTarget;
  /** Close the owning menu (called after a successful write). */
  onDone?: () => void;
  /** Test-id prefix, so two menus on one page stay addressable. */
  testIdPrefix: string;
  /**
   * Workspace targets: render the "Suppress @everyone and @here" checkbox
   * under the levels (the switch lives with the workspace's own level).
   */
  withBroadcastSwitch?: boolean;
  /** Extra items grouped under Notifications (the channel menu's ring mute). */
  children?: ReactNode;
  /** The U17 store (injectable for tests; the app uses the module default). */
  store?: StateStore;
}

export function NotificationLevelMenuGroup({
  target,
  onDone,
  testIdPrefix,
  withBroadcastSwitch = false,
  children,
  store = defaultStore,
}: NotificationLevelMenuGroupProps) {
  const view = useNotificationTarget(target, store);
  const suppressed = useBroadcastSuppressed(withBroadcastSwitch ? target.workspaceId : null, store);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const run = async (write: () => Promise<void>) => {
    setError(null);
    setPending(true);
    try {
      await write();
      onDone?.();
    } catch {
      setError(WRITE_FAILED_MESSAGE);
    } finally {
      setPending(false);
    }
  };

  const value = view.explicit ? view.level : INHERIT;

  return (
    <DropdownMenuGroup aria-label="Notifications" data-testid={`${testIdPrefix}-notifications`}>
      <DropdownMenuLabel className="notif-menu-label">Notifications</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={value}>
        {LEVELS.map((level) => (
          <DropdownMenuRadioItem
            key={level}
            value={level}
            className="workspace-menu-item notif-menu-item"
            data-testid={`${testIdPrefix}-level-${level}`}
            disabled={pending}
            onSelect={(e) => {
              e.preventDefault(); // stay open until the write settles
              void run(() => setTargetLevel(target, level, store));
            }}
          >
            <span className="workspace-menu-icon" aria-hidden="true">
              <LevelIcon level={level} />
            </span>
            <span>{LEVEL_LABEL[level]}</span>
          </DropdownMenuRadioItem>
        ))}
        <DropdownMenuRadioItem
          value={INHERIT}
          className="workspace-menu-item notif-menu-item"
          data-testid={`${testIdPrefix}-level-inherit`}
          disabled={pending}
          onSelect={(e) => {
            e.preventDefault();
            void run(() => clearTargetLevel(target, store));
          }}
        >
          <span className="workspace-menu-icon" aria-hidden="true" />
          <span>
            {resetLabel(target)}{' '}
            <span className="text-text-muted">({LEVEL_LABEL[view.inheritedLevel]})</span>
          </span>
        </DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>

      {withBroadcastSwitch && target.workspaceId ? (
        <DropdownMenuCheckboxItem
          checked={suppressed}
          className="workspace-menu-item notif-menu-item"
          data-testid={`${testIdPrefix}-suppress-broadcasts`}
          disabled={pending}
          onSelect={(e) => {
            e.preventDefault();
            const workspaceId = target.workspaceId as string;
            void run(() => setWorkspaceBroadcastSuppressed(workspaceId, !suppressed, store));
          }}
        >
          <span className="workspace-menu-icon" aria-hidden="true" />
          <span>Suppress @everyone and @here</span>
        </DropdownMenuCheckboxItem>
      ) : null}

      {children}

      {error ? (
        <p className="channel-context-error" role="alert" data-testid={`${testIdPrefix}-notifications-error`}>
          {error}
        </p>
      ) : null}
    </DropdownMenuGroup>
  );
}
