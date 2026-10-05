/**
 * @cytale/web — WorkspaceRail (U18).
 *
 * The 72px vertical workspace switcher (left-most region). Structure-only in
 * U18: it renders nav items passed by the workspace (U20+ supplies workspace
 * icons/initials). Emphasis on the a11y contract: landmark name, focusable
 * items, 40×40 minimum hit areas per corpus §4.
 */
import type { ReactNode } from 'react';

export interface WorkspaceRailProps {
  children: ReactNode;
}

export function WorkspaceRail({ children }: WorkspaceRailProps) {
  return <div className="rail-inner">{children}</div>;
}
