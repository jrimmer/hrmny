/**
 * @cytale/mobile — the navigation contract (plan 004 M5, R7).
 *
 * One place for route paths, href builders, and the deep-link mapping. The
 * file tree under `app/` is the routing truth (expo-router); this module is
 * the *string* truth the rest of the app speaks, so a surface never hardcodes
 * a path twice.
 *
 * Route tree → URLs (group folders in parentheses do not appear in the URL):
 *
 *   app/(drawer)/index.tsx          →  /
 *   app/(drawer)/integrations.tsx   →  /integrations
 *   app/(drawer)/diagnostics.tsx    →  /diagnostics      (dev-only entry)
 *   app/(drawer)/channel/[id].tsx   →  /channel/<id>
 *   app/settings/index.tsx          →  /settings
 *   app/settings/[section].tsx      →  /settings/<section>
 *   app/thread/[id].tsx             →  /thread/<id>
 *
 * Deep links use the `scheme: "cytale"` set in app.json (KTD2):
 *
 *   cytale://channel/<id>   →  /channel/<id>
 *   cytale://thread/<id>    →  /thread/<id>
 *   cytale://settings/...   →  /settings/...
 *
 * `cytale://channel/<id>` parses as host=`channel`, path=`/id`, and Expo
 * Router's native URL extraction keeps only what follows the scheme — so the
 * host segment must be folded back into the path. `app/+native-intent.tsx`
 * runs `normalizeDeepLink` before routing, which is why the mapping lives
 * here (pure, unit-tested) instead of inline in the intent file.
 */

/** The app's URL scheme (app.json `expo.scheme`). */
export const APP_SCHEME = 'cytale';

/** Every surface's path prefix, for building and parsing hrefs. */
export const ROUTES = {
  home: '/',
  integrations: '/integrations',
  diagnostics: '/diagnostics',
  channel: '/channel',
  thread: '/thread',
  settings: '/settings',
} as const;

export function channelHref(channelId: string): string {
  return `${ROUTES.channel}/${channelId}`;
}

export function threadHref(threadId: string): string {
  return `${ROUTES.thread}/${threadId}`;
}

/** Settings href: the list (`/settings`) or one section (`/settings/<name>`). */
export function settingsHref(section?: string): string {
  return section === undefined ? ROUTES.settings : `${ROUTES.settings}/${section}`;
}

/**
 * Rewrite an incoming system URL into the in-app path expo-router routes.
 *
 * Accepts `cytale://<route>/<params>` (host = first route segment), the
 * empty-host form `cytale:///route/...`, a bare `route/...` fragment, or an
 * already-absolute in-app path. Query strings survive untouched. Unknown
 * shapes pass through unchanged rather than being invented.
 */
export function normalizeDeepLink(url: string): string {
  const trimmed = url.trim();
  if (trimmed === '') return '/';

  const schemeMatch = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.exec(trimmed);
  let rest = trimmed;
  if (schemeMatch) {
    rest = trimmed.slice(schemeMatch[0].length);
  } else if (trimmed.startsWith('/')) {
    // Already an in-app path; just drop the trailing slash (but keep `/`).
    return trimmed.length > 1 && trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
  }

  const [pathPart, ...queryParts] = rest.split('?');
  const segments = pathPart.split('/').filter((segment) => segment !== '');
  const path = `/${segments.join('/')}`;
  const normalized = path === '/' ? '/' : path.replace(/\/$/, '');
  return queryParts.length > 0 ? `${normalized}?${queryParts.join('?')}` : normalized;
}

/** The surface a pathname addresses — what the shell switches on. */
export type RouteDescriptor =
  | { surface: 'home' }
  | { surface: 'integrations' }
  | { surface: 'diagnostics' }
  | { surface: 'channel'; channelId: string }
  | { surface: 'thread'; threadId: string }
  | { surface: 'settings'; section?: string }
  | { surface: 'unknown' };

/**
 * Parse a pathname (with or without a leading slash) into its surface. Used
 * by the drawer to decide which row is selected and which title bar shows.
 */
export function parseRoute(pathname: string): RouteDescriptor {
  const [pathPart] = pathname.split('?');
  const segments = pathPart.split('/').filter((segment) => segment !== '');

  if (segments.length === 0) return { surface: 'home' };

  const [head, second] = segments;
  if (head === 'channel' && second !== undefined) {
    return { surface: 'channel', channelId: second };
  }
  if (head === 'thread' && second !== undefined) {
    return { surface: 'thread', threadId: second };
  }
  if (head === 'integrations' && segments.length === 1) return { surface: 'integrations' };
  if (head === 'diagnostics' && segments.length === 1) return { surface: 'diagnostics' };
  if (head === 'settings') {
    return second === undefined ? { surface: 'settings' } : { surface: 'settings', section: second };
  }
  return { surface: 'unknown' };
}
