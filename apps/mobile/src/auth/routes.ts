/**
 * @cytale/mobile — auth route contract (plan 004 M12, R4/R6).
 *
 * The auth surface's paths, in one place, plus the two pure helpers the gate
 * needs: "is this pathname an auth screen" (never capture it as a deep-link
 * intent) and "rebuild the href a deep link asked for" (replay it after
 * sign-in).
 *
 * Route tree → URLs (the `(auth)` group folder does not appear in the URL):
 *
 *   app/(auth)/sign-in.tsx      →  /sign-in
 *   app/(auth)/sign-up.tsx      →  /sign-up
 *   app/(auth)/verify-email.tsx →  /verify-email[?token=…]
 *
 * Web's equivalents (`#/login`, `#/register`, `#/verify-email?token=…`) are
 * the behaviour reference; the paths differ only in spelling.
 */

export const AUTH_ROUTES = {
  signIn: '/sign-in',
  signUp: '/sign-up',
  verifyEmail: '/verify-email',
} as const;

export type AuthRoute = (typeof AUTH_ROUTES)[keyof typeof AUTH_ROUTES];

/** True when the pathname addresses one of the auth screens. */
export function isAuthRoute(pathname: string): boolean {
  return Object.values(AUTH_ROUTES).includes(stripQuery(pathname) as AuthRoute);
}

/** True when the pathname is the verification screen (token landing / gate). */
export function isVerificationRoute(pathname: string): boolean {
  return stripQuery(pathname) === AUTH_ROUTES.verifyEmail;
}

/**
 * Rebuild the href a captured deep link pointed at.
 *
 * `params` is expo-router's global search-params map: for `/channel/<id>` it
 * contains `{ id }`, and that id is already part of the pathname. Only values
 * that are NOT path segments become query parameters, so a replay never turns
 * a path param into a duplicate query param (`/channel/1?id=1`).
 */
export function pendingHref(pathname: string, params: Record<string, string | string[]>): string {
  const segments = stripQuery(pathname).split('/');
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item === undefined || item === '') continue;
      if (segments.includes(item)) continue; // path param — already in the pathname
      query.append(key, item);
    }
  }

  const queryString = query.toString();
  return queryString === '' ? pathname : `${pathname}?${queryString}`;
}

function stripQuery(pathname: string): string {
  const [path = ''] = pathname.split('?');
  return path;
}
