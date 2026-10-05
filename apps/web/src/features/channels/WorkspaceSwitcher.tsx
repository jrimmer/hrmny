/**
 * @cytale/web — WorkspaceSwitcher (U20).
 *
 * The vertical rail of the user's workspaces (avatars/icons). Click to
 * switch; each workspace shows an unread badge. Keyboard: each workspace is
 * a button (natively focusable + Enter/Space activatable).
 *
 * The badge is the channel row's (SidebarRowBadge): red with the count only
 * when something in the workspace mentions you, otherwise the neutral unread
 * pill. It used to be red for ANY unread, so the rail shouted where the rows
 * beneath it stayed quiet.
 */

import type { Workspace } from '@cytale/domain';

import { assetUrl } from '../../app/origin.js';
import { avatarInitials, avatarTileStyle } from '../../app/ui/avatar.js';
import { useRetryingImage } from '../../app/ui/useRetryingImage.js';
import { SidebarRowBadge } from './SidebarRowBadge.js';

/**
 * The rail's icon for one workspace. Extracted so the retry hook can live at
 * component level (the rail renders a list) — a failed load retries with a
 * cache bust before falling back to the initial tile, because the attachment
 * URL never changes for a given image.
 *
 * Exported since 2026-09-18: the mobile topbar's nav trigger reuses it for
 * the active workspace (the ☰ glyph's replacement) — one icon renderer so
 * the two surfaces cannot drift.
 */
export function RailIcon({ workspace }: { workspace: Workspace }) {
  const { url, onError, onLoad } = useRetryingImage(assetUrl(workspace.icon_url));

  if (!url) {
    return (
      <span
        className="workspace-initial"
        aria-hidden="true"
        style={avatarTileStyle(workspace.id)}
      >
        {/* avatarInitials' code-point rule, first character only — the rail
            tile is a one-character tile by design (PR #132 review: the old
            charAt(0) split surrogate pairs exactly as the avatar rule's doc
            condemns). */}
        {avatarInitials(workspace.name).slice(0, 1) || '?'}
      </span>
    );
  }

  return <img src={url} alt="" className="workspace-icon" onError={onError} onLoad={onLoad} />;
}

export interface WorkspaceSwitcherProps {
  workspaces: Workspace[];
  /** Active workspace id (persistent selection pill). */
  activeWorkspaceId: string | null;
  /** Per-workspace unread count for the rail badge. */
  unreadFor?: (workspaceId: string) => number;
  /** Per-workspace mention count: when non-zero the badge turns red. */
  mentionsFor?: (workspaceId: string) => number;
  /** Called when a workspace is selected. */
  onSelect?: (workspaceId: string) => void;
}

export function WorkspaceSwitcher({
  workspaces,
  activeWorkspaceId,
  unreadFor = () => 0,
  mentionsFor = () => 0,
  onSelect,
}: WorkspaceSwitcherProps) {
  return (
    <ul className="workspace-rail-list" aria-label="Workspaces">
      {workspaces.map((ws) => {
        const unread = unreadFor(ws.id);
        const mentions = mentionsFor(ws.id);
        const active = ws.id === activeWorkspaceId;
        return (
          <li key={ws.id}>
            <button
              type="button"
              data-testid={`workspace-${ws.id}`}
              data-active={active || undefined}
              data-unread={unread > 0 || mentions > 0 || undefined}
              aria-current={active ? 'page' : undefined}
              aria-label={`${ws.name}${unread > 0 ? `, ${unread} unread` : ''}${
                mentions > 0 ? `, ${mentions} ${mentions === 1 ? 'mention' : 'mentions'}` : ''
              }`}
              className="workspace-rail-item"
              onClick={() => onSelect?.(ws.id)}
            >
              <RailIcon workspace={ws} />
              {unread > 0 || mentions > 0 ? (
                <span className="workspace-badge" aria-hidden="true">
                  <SidebarRowBadge
                    unread={unread}
                    mentions={mentions}
                    unreadTestId={`workspace-unread-${ws.id}`}
                    mentionsTestId={`workspace-mentions-${ws.id}`}
                  />
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
