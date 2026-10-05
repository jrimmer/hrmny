/**
 * @cytale/web — release-notes routing.
 *
 * Hash-routed `#/release-notes` on the same primitive as the settings
 * surfaces (`useHashRoute()`). The surface takes the CENTER column only —
 * the left cluster stays, the fourth column stands down — like the operator's
 * server settings.
 *
 * Close returns to where the member WAS, not to the app root: the notes are a
 * glance from the version badge, and the badge is reachable from any surface
 * (a channel, Home, a settings section). When the badge opened them, the
 * previous history entry is exactly that place, so close is `history.back()`
 * — the same move the browser's own Back makes. A deep link (nothing of ours
 * behind it) falls back to the root.
 */

import { useCallback, useEffect } from 'react';

import { useHashRoute } from '../auth/router.js';

export const RELEASE_NOTES_ROUTE_PREFIX = '/release-notes';

export function parseReleaseNotesPath(path: string): { open: boolean } {
  return {
    open: path === RELEASE_NOTES_ROUTE_PREFIX || path.startsWith(`${RELEASE_NOTES_ROUTE_PREFIX}/`),
  };
}

// Module scope, not state: it must survive the pane's own mount/unmount and
// is only ever about the ONE history entry the badge pushed.
let openedInApp = false;

export interface ReleaseNotesRoute {
  open: boolean;
  openSurface(): void;
  /** The pane's ✕: back to where the member was. */
  close(): void;
  /**
   * A navigation elsewhere (a channel, Home, a workspace) while the notes are
   * up: a forward move to the root, never a Back — the member chose a new
   * place, and the column swap must follow it. No-op when not open.
   */
  leave(): void;
}

export function useReleaseNotesRoute(): ReleaseNotesRoute {
  const { path, navigate } = useHashRoute();
  const { open } = parseReleaseNotesPath(path);

  // Left by any route (browser Back, a sidebar click): the pushed entry is
  // no longer the one behind us.
  useEffect(() => {
    if (!open) openedInApp = false;
  }, [open]);

  const openSurface = useCallback(() => {
    if (parseReleaseNotesPath(currentPath()).open) return;
    openedInApp = true;
    navigate(RELEASE_NOTES_ROUTE_PREFIX);
  }, [navigate]);

  const close = useCallback(() => {
    if (openedInApp) {
      openedInApp = false;
      history.back();
    } else {
      navigate('/');
    }
  }, [navigate]);

  const leave = useCallback(() => {
    if (!open) return;
    openedInApp = false;
    navigate('/');
  }, [open, navigate]);

  return { open, openSurface, close, leave };
}

function currentPath(): string {
  const hash = globalThis.location?.hash ?? '';
  return (hash.startsWith('#') ? hash.slice(1) : hash).split('?')[0] || '/';
}
