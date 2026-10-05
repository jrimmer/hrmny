/**
 * @cytale/web — user settings routing (the bottom-left gear surface).
 *
 * Hash-routed `#/settings/:section` on the same primitive every feature
 * surface uses (`features/auth/router.ts` `useHashRoute()`), deliberately
 * one segment deep like the integrations surface:
 *
 *   #/settings/account      — identity, email, password, sessions, danger zone
 *   #/settings/appearance   — theme + motion
 *   #/settings/emoji        — reaction + composer-emoji favorites (#43)
 *   #/settings/integrations — agents: lifecycle + the access each one holds
 *   #/settings/webhooks     — incoming URLs you own, and where each one posts
 *   #/settings/notifications — delivery state + the level hierarchy (U10)
 *   #/settings/ssh          — SSH keys + certificates (tui plan U3, R1-R6)
 *
 * Unknown sections normalize to `account`; the bare prefix opens on
 * `account` too. Back-navigation closes the surface (the hash falls back
 * to the app root), which is the whole point of riding the hash.
 *
 * No dirty-guard in v1 (the agents section's access tree is long-form and
 * carries its own; the settings sections hold only small forms, whose loss on
 * an accidental Back is an accepted rough edge for now).
 */

import { useCallback } from 'react';

import { useHashRoute } from '../auth/router.js';

export type SettingsSection =
  | 'account'
  | 'appearance'
  | 'emoji'
  | 'integrations'
  | 'webhooks'
  | 'notifications'
  | 'ssh';

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  'account',
  'appearance',
  'emoji',
  'integrations',
  'webhooks',
  'notifications',
  'ssh',
] as const;

export const SETTINGS_ROUTE_PREFIX = '/settings';

/** The removed integrations surface's prefix (KD7 — aliased, never stranded). */
export const LEGACY_INTEGRATIONS_PREFIX = '/integrations';

/**
 * Where a stale `#/integrations/...` address lands: `agents` → the agents
 * section, `webhooks` → the webhooks section, and the bare prefix (or anything
 * unrecognized) → agents, which is what it used to open on.
 *
 * One pure table, consulted once at the surface-resolution point. The surface
 * it aliases does not exist any more, so nothing may import it — a dead route
 * or a stranded deep link would be an incomplete relocation, not a tidy one.
 * Returns null for a path that is not ours, so the caller can fall through.
 */
export function aliasLegacyIntegrationsPath(path: string): string | null {
  if (path !== LEGACY_INTEGRATIONS_PREFIX && !path.startsWith(`${LEGACY_INTEGRATIONS_PREFIX}/`)) {
    return null;
  }
  const segment = path.slice(LEGACY_INTEGRATIONS_PREFIX.length).replace(/^\//, '').split('/')[0];
  const section: SettingsSection = segment === 'webhooks' ? 'webhooks' : 'integrations';
  return `${SETTINGS_ROUTE_PREFIX}/${section}`;
}

export interface SettingsRouteMatch {
  /** True when the hash addresses the settings surface at all. */
  open: boolean;
  /** Normalized section (`account` for the bare prefix / unknown segments). */
  section: SettingsSection;
}

/** Parse a raw hash path (`/settings/appearance`) into a route match. */
export function parseSettingsPath(path: string): SettingsRouteMatch {
  if (!path.startsWith(`${SETTINGS_ROUTE_PREFIX}/`) && path !== SETTINGS_ROUTE_PREFIX) {
    return { open: false, section: 'account' };
  }
  const segment =
    path.slice(SETTINGS_ROUTE_PREFIX.length).replace(/^\//, '').split('/')[0] ?? '';
  const section = (SETTINGS_SECTIONS as readonly string[]).includes(segment)
    ? (segment as SettingsSection)
    : 'account';
  return { open: true, section };
}

export interface SettingsRoute extends SettingsRouteMatch {
  /** Route to a section (drives the hash; the surface re-renders). */
  openSection(section: SettingsSection): void;
  /** Leave the surface (back to the app root). */
  close(): void;
}

/** Route binding for the in-shell settings surface. */
export function useSettingsRoute(): SettingsRoute {
  const { path, navigate } = useHashRoute();
  const { open, section } = parseSettingsPath(path);

  const openSection = useCallback(
    (next: SettingsSection) => {
      navigate(`${SETTINGS_ROUTE_PREFIX}/${next}`);
    },
    [navigate],
  );

  const close = useCallback(() => {
    navigate('/');
  }, [navigate]);

  return { open, section, openSection, close };
}
