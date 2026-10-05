/**
 * @cytale/web — workspace settings routing.
 *
 * Hash-routed `#/wsettings/:section` on the same primitive as the user
 * settings surface (`useHashRoute()`), one segment deep:
 *
 *   #/wsettings/overview — workspace image + name (admin-gated controls)
 *
 * Unknown sections normalize to `overview`; the bare prefix opens there
 * too. Back-navigation closes the surface (the hash falls back to the app
 * root). The surface mounts like user settings: col-2 menu / col-3 content
 * / col-4 hidden — the banked navigation doctrine.
 */

import { useCallback } from 'react';

import { useHashRoute } from '../auth/router.js';

export type WSettingsSection = 'overview';

export const WSETTINGS_SECTIONS: readonly WSettingsSection[] = ['overview'] as const;

export const WSETTINGS_ROUTE_PREFIX = '/wsettings';

export interface WSettingsRouteMatch {
  /** True when the hash addresses the workspace settings surface at all. */
  open: boolean;
  section: WSettingsSection;
}

/** Parse a raw hash path (`/wsettings/overview`) into a route match.
 *  Mirrors the settings router: unknown segments normalize to the single
 *  section via the SECTIONS list (future sections join there). */
export function parseWSettingsPath(path: string): WSettingsRouteMatch {
  if (!path.startsWith(`${WSETTINGS_ROUTE_PREFIX}/`) && path !== WSETTINGS_ROUTE_PREFIX) {
    return { open: false, section: 'overview' };
  }
  const segment =
    path.slice(WSETTINGS_ROUTE_PREFIX.length).replace(/^\//, '').split('/')[0] ?? '';
  const section = (WSETTINGS_SECTIONS as readonly string[]).includes(segment)
    ? (segment as WSettingsSection)
    : 'overview';
  return { open: true, section };
}

export interface WSettingsRoute extends WSettingsRouteMatch {
  openSection(section: WSettingsSection): void;
  close(): void;
}

/** Route binding for the in-shell workspace settings surface. */
export function useWSettingsRoute(): WSettingsRoute {
  const { path, navigate } = useHashRoute();
  const { open, section } = parseWSettingsPath(path);

  const openSection = useCallback(
    (next: WSettingsSection) => {
      navigate(`${WSETTINGS_ROUTE_PREFIX}/${next}`);
    },
    [navigate],
  );

  const close = useCallback(() => {
    navigate('/');
  }, [navigate]);

  return { open, section, openSection, close };
}
