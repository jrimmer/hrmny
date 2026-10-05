/**
 * @cytale/web — WorkspaceSettingsNav, the workspace settings surface's
 * column-2 menu.
 *
 * Mirrors SettingsNav's visual language (the banked settings doctrine:
 * col-2 menu / col-3 content). One section today — Overview — with room
 * for the workspace-scoped sections future passes add (roles, invites,
 * integrations config). The workspace's own identity heads the column so
 * the scope is unambiguous beside the user-settings gear surface.
 *
 * U5 — mobile (below 768px): the `mobile` variant renders the same list→
 * content stack as user settings — the nav as the pane's full-width LIST
 * with the header ✕ + Escape-to-close (no Log out row; that is
 * user-settings-only). The desktop col-2 menu JSX is untouched.
 */

import { useEffect, useRef } from 'react';

import type { WSettingsSection } from './router.js';

const navItemClass = (active: boolean): string =>
  'flex min-h-9 w-full items-center rounded-md px-3 py-1.5 text-left text-sm font-medium transition-colors duration-[var(--duration-control)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] ' +
  (active
    ? 'bg-surface-strong text-text-primary'
    : 'text-text-muted hover:bg-surface-hover hover:text-text');

export interface WorkspaceSettingsNavProps {
  workspaceName: string;
  active: WSettingsSection;
  onSelect(section: WSettingsSection): void;
  /** Below 768px: render as the pane's full-width list (U5). */
  mobile?: boolean;
  /** Mobile only: the list header's ✕ + Escape-to-close. */
  onClose?: () => void;
}

export function WorkspaceSettingsNav({
  workspaceName,
  active,
  onSelect,
  mobile = false,
  onClose,
}: WorkspaceSettingsNavProps) {
  // Focus enters the menu when the surface opens (SettingsNav's contract).
  const firstItemRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    firstItemRef.current?.focus();
  }, []);

  // U5: on the mobile LIST, Escape closes the whole surface (SettingsNav's
  // mobile contract). Desktop is untouched — the pane owns Escape there.
  useEffect(() => {
    if (!mobile || !onClose) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [mobile, onClose]);

  if (mobile) {
    return (
      <div className="flex h-full flex-col bg-background" data-testid="wsettings-nav" data-mobile="true">
        <header className="flex min-h-12 items-center gap-1 border-b border-line px-2">
          <h2 className="min-w-0 flex-1 truncate px-2 text-sm font-semibold uppercase tracking-wide text-text-muted">
            {workspaceName}
          </h2>
          <button
            type="button"
            aria-label="Close workspace settings"
            data-testid="wsettings-nav-close"
            className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-md text-lg text-text-muted transition-colors duration-[var(--duration-control)] hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
            onClick={onClose}
          >
            ✕
          </button>
        </header>

        <nav aria-label="Workspace settings" className="flex-1 overflow-y-auto px-2 py-2">
          <ul className="flex flex-col gap-1">
            <li>
              <button
                ref={firstItemRef}
                type="button"
                className="settings-list-row"
                data-active={active === 'overview' || undefined}
                aria-current={active === 'overview' ? 'page' : undefined}
                data-testid="wsettings-nav-overview"
                onClick={() => onSelect('overview')}
              >
                Overview
              </button>
            </li>
          </ul>
        </nav>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col" data-testid="wsettings-nav">
      <div className="flex min-h-12 items-center px-4">
        <h2 className="truncate text-sm font-semibold uppercase tracking-wide text-text-muted">
          {workspaceName}
        </h2>
      </div>

      <nav aria-label="Workspace settings" className="flex-1 overflow-y-auto px-2 py-3">
        <ul className="flex flex-col gap-1">
          <li>
            <button
              ref={firstItemRef}
              type="button"
              className={navItemClass(active === 'overview')}
              aria-current={active === 'overview' ? 'page' : undefined}
              data-testid="wsettings-nav-overview"
              onClick={() => onSelect('overview')}
            >
              Overview
            </button>
          </li>
        </ul>
      </nav>
    </div>
  );
}
