/**
 * @cytale/web — server settings routing (#121).
 *
 * Hash-routed `#/serversettings` on the same primitive as the other
 * settings surfaces (`useHashRoute()`). Operator-only in ENTRY (the Home
 * gear's menu item renders only when `/users/@me` carries `is_operator`);
 * the ROUTES are gated server-side by RequireOperator regardless, so a
 * hand-typed hash just meets the 403 the page renders as an error state.
 */

import { useCallback } from 'react';

import { useHashRoute } from '../auth/router.js';

export const SERVER_SETTINGS_ROUTE_PREFIX = '/serversettings';

export interface ServerSettingsRouteMatch {
  /** True when the hash addresses the server settings surface. */
  open: boolean;
}

export function parseServerSettingsPath(path: string): ServerSettingsRouteMatch {
  return {
    open: path === SERVER_SETTINGS_ROUTE_PREFIX || path.startsWith(`${SERVER_SETTINGS_ROUTE_PREFIX}/`),
  };
}

export interface ServerSettingsRoute extends ServerSettingsRouteMatch {
  openSurface(): void;
  close(): void;
}

/** Route binding for the in-shell server settings surface. */
export function useServerSettingsRoute(): ServerSettingsRoute {
  const { path, navigate } = useHashRoute();
  const { open } = parseServerSettingsPath(path);

  const openSurface = useCallback(() => {
    navigate(SERVER_SETTINGS_ROUTE_PREFIX);
  }, [navigate]);

  const close = useCallback(() => {
    navigate('/');
  }, [navigate]);

  return { open, openSurface, close };
}
