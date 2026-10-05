/**
 * @cytale/web — ContextRail, the right column's tabbed rail.
 *
 * The right column joins the navigational top-row convention: a row of
 * icon tabs (tooltip'd) switching the rail's content — Members and
 * Call log today. Content is the host's business and stays contextual:
 * a workspace shows its directory / the active channel's call log; Home
 * shows the cross-workspace aggregate (all members, all calls).
 *
 * Search: a magnifier sits at the header's right edge. Selecting it opens
 * a borderless input expanding LEFTWARD — the active tab's icon stays at
 * the far left and the input covers the inactive tab's icon. Clicking (or
 * Tab-ing) away dismisses it — the input closes and the magnifier returns
 * to the right edge; the toggle and Escape do the same. The host owns
 * open-state + text and routes the query to the active tab's content.
 */
import { useEffect, useRef, type ReactNode } from 'react';

import { ListErrorBoundary } from '../../features/messages/ListErrorBoundary.js';

export interface ContextRailTab {
  id: string;
  /** Accessible name + mouseover tooltip for the icon tab. */
  label: string;
  testId: string;
  icon: ReactNode;
  content: ReactNode;
}

export interface ContextRailSearch {
  open: boolean;
  onToggle: () => void;
  query: string;
  onQueryChange: (query: string) => void;
  placeholder?: string;
}

export interface ContextRailProps {
  /** A mode paired with its content. The HOST owns which one shows — the rail
      no longer selects, because the selector is the icon cluster at the
      window's top right (owner direction 2026-09-12). */
  tabs: ContextRailTab[];
  /** The open mode. */
  active: string;
  search?: ContextRailSearch;
}

function MagnifierIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"
        fill="currentColor"
      />
    </svg>
  );
}

export function ContextRail({ tabs, active, search }: ContextRailProps) {
  const current = tabs.find((t) => t.id === active) ?? tabs[0];
  const searchOpen = search?.open === true;
  const headerRef = useRef<HTMLDivElement | null>(null);

  // Click-away dismisses an open search (the magnifier returns right).
  // ONE mechanism, deliberately: mousedown outside the header row. A blur
  // handler would double-fire on the same click (blur's relatedTarget is
  // null for non-focusable targets), and the unmount blur could re-toggle
  // the search straight back open. The toggle itself lives inside the
  // header, so clicking it still routes through onToggle only.
  useEffect(() => {
    if (!searchOpen || search === undefined) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (headerRef.current && !headerRef.current.contains(e.target as Node)) {
        search.onToggle();
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [searchOpen, search]);

  const toggle = (
    <button
      type="button"
      className="context-rail-tab context-rail-search-toggle"
      aria-label="Search"
      aria-pressed={searchOpen}
      title="Search"
      data-testid="rail-search-toggle"
      onClick={() => search?.onToggle()}
    >
      <MagnifierIcon />
    </button>
  );
  return (
    <div className="context-rail" data-testid="context-rail">
      <div
        ref={headerRef}
        className={
          searchOpen
            ? 'context-rail-tabs context-rail-tabs--searching'
            : 'context-rail-tabs'
        }
        data-testid="context-rail-tabs"
      >
        {searchOpen ? (
          <>
            {/* Open: the magnifier slides LEFT to sit beside the active
                context's icon, and the borderless input fills the rest —
                covering the inactive tab's icon while in use. */}
            {current ? (
              <span
                className="context-rail-tab context-rail-active-icon"
                title={current.label}
                aria-hidden="true"
                data-active="true"
              >
                {current.icon}
              </span>
            ) : null}
            {toggle}
            <input
              type="text"
              className="context-rail-search-input"
              aria-label={search?.placeholder ?? 'Search'}
              placeholder={search?.placeholder ?? 'Search…'}
              value={search?.query ?? ''}
              onChange={(e) => search?.onQueryChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') search?.onToggle();
              }}
              data-testid="rail-search-input"
              autoFocus
            />
          </>
        ) : (
          <>
            {/* No tab row: the mode is chosen from the rail icons at the
                window's top right (owner direction 2026-09-12), which answer
                "is the column open" as well as "which mode". A row here would
                be a second, contradictory control; `tabs` survives because the
                host pairs each mode with its content. */}
            {toggle}
          </>
        )}
      </div>
      <div className="context-rail-body" role="tabpanel" data-testid={`context-rail-body-${current?.id}`}>
        {/* Hardening plan 7.4: a render throw in THIS tab's content (member
            directory, call log, threads) remounts the tab under the list
            boundary's cap instead of propagating to the app-shell boundary,
            which would reload away the session, draft and route. Keyed by
            tab id, so switching tabs hands the next tab a fresh cap. */}
        <ListErrorBoundary key={current?.id} surface="rail tab" testIdPrefix="rail">
          {current?.content}
        </ListErrorBoundary>
      </div>
    </div>
  );
}
