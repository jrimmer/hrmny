/**
 * @cytale/web — VersionBadge: the running build's short commit hash.
 *
 * Sits at the bottom of the workspace rail (column 1), under the rail's own
 * surface — chrome, not content, so it stays small and muted in somewhat
 * small letters behind a 'v'. The title repeats the value for hover.
 *
 * It is a LINK to the release notes (owner request 2026-09-27: "make the
 * version a link that replaces the center/main column with release notes").
 * A real `<a href="#/release-notes">` rather than a button, so a modified
 * click (new tab/window) does what a link does; a plain click goes through
 * the route's `openSurface`, which remembers that the badge pushed the entry
 * so the pane's close can step back to exactly where the member was. The
 * hash stays copyable from the notes pane's header, where it is plain text.
 */
import type { MouseEvent } from 'react';

import { RELEASE_NOTES_ROUTE_PREFIX, useReleaseNotesRoute } from '../../features/releasenotes/router.js';
import { versionLabel } from '../version.js';

export function VersionBadge() {
  const label = versionLabel();
  const { open, openSurface } = useReleaseNotesRoute();
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    openSurface();
  };
  return (
    <a
      href={`#${RELEASE_NOTES_ROUTE_PREFIX}`}
      className="rail-version"
      data-testid="rail-version"
      data-drawer-close
      title={`Hrmny build ${label} — release notes`}
      aria-label={`Release notes (build ${label})`}
      aria-current={open ? 'page' : undefined}
      onClick={onClick}
    >
      {label}
    </a>
  );
}
