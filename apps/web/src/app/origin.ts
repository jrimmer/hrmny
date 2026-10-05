/**
 * @cytale/web — build-time origin override and asset URL resolution.
 *
 * The browser build is same-origin: REST, gateway and assets all come from
 * `location.origin`. The Tauri desktop build is not — it loads the SPA from
 * `tauri://localhost`, so `location.origin` is the webview, not the server.
 * A packaged shell therefore needs an origin: `VITE_CYTALE_ORIGIN` (baked at
 * build time by a release pipeline, or set for a self-hosted build) wins;
 * with nothing baked in, a packaged shell falls back to the hosted
 * deployment (`HOSTED_ORIGIN`, itself a build-time value — unset in a plain
 * build, where the shell asks the user for a server). `tauri dev` is excluded from that fallback —
 * it must keep talking to the local server. When an origin is in play, the
 * API base, the gateway URL AND server-relative asset paths resolve against
 * it.
 *
 * Typed structurally because apps/web deliberately does not depend on
 * vite/client types.
 */

/**
 * Normalize a configured origin value: undefined unless it is a non-empty
 * string, with trailing slashes stripped so `${origin}/api/v1` never doubles.
 */
export function normalizeOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.replace(/\/+$/, '');
}

/**
 * The hosted deployment a packaged shell points at when no origin is baked in,
 * and the server the login form suggests: `VITE_CYTALE_HOSTED_ORIGIN`, set at
 * build time by a deployment's release pipeline (its value lives with that
 * deployment's configuration, never in the source). Unset — a self-built
 * shell — means there is no hosted fallback: the shell's login form asks for
 * a server, and the browser build stays same-origin as always.
 */
export const HOSTED_ORIGIN: string | undefined = normalizeOrigin(
  (import.meta as unknown as { env?: Record<string, unknown> }).env?.VITE_CYTALE_HOSTED_ORIGIN,
);

/**
 * True when the SPA runs inside a PACKAGED Tauri shell — `tauri://localhost`
 * on macOS/Linux, `http://tauri.localhost` on Windows. `tauri dev` serves
 * from `http://localhost:5173` and is deliberately NOT packaged: it must keep
 * talking to the local server through the Vite proxy.
 */
export function isPackagedShell(
  loc: { protocol?: string; hostname?: string } | undefined,
): boolean {
  if (!loc) return false;
  return loc.protocol === 'tauri:' || loc.hostname === 'tauri.localhost';
}

export function configuredOrigin(
  envValue: unknown = (import.meta as unknown as { env?: Record<string, unknown> }).env
    ?.VITE_CYTALE_ORIGIN,
  loc: { protocol?: string; hostname?: string } | undefined = globalThis.location,
  hosted: string | undefined = HOSTED_ORIGIN,
): string | undefined {
  const baked = normalizeOrigin(envValue);
  if (baked) return baked;
  return isPackagedShell(loc) ? normalizeOrigin(hosted) : undefined;
}

/**
 * Resolve a server-relative asset path (attachment, avatar, workspace icon)
 * against the configured origin. Absolute and inline URLs (`http(s):`,
 * `data:`, `blob:`) pass through untouched, and so do relative paths in the
 * browser build, where they are already same-origin. Empty/absent stays
 * undefined so callers keep their "no image" branch. The origin is a
 * parameter (defaulting to the configured one) so the resolution is testable
 * without stubbing the build-time env.
 */
export function assetUrl(
  path: string | null | undefined,
  origin: string | undefined = configuredOrigin(),
): string | undefined {
  if (typeof path !== 'string' || path === '') return undefined;
  if (!path.startsWith('/')) return path;
  return origin ? `${origin}${path}` : path;
}

/**
 * The ONLY attachment URL shape the server issues: a server-relative
 * `/api/v1/attachments/<id>` path, optionally with a query string (signed
 * `?e=…&s=…` params). No fragment, no backslash, no `.`/`..` segment, no
 * protocol-relative `//`.
 */
const ATTACHMENT_PATH = /^\/api\/v1\/attachments\/[A-Za-z0-9._~%-]+(?:\/[A-Za-z0-9._~%-]+)*(?:\?[^#\s\\]*)?$/;

function isAttachmentPath(path: string): boolean {
  if (!ATTACHMENT_PATH.test(path)) return false;
  const pathname = path.split('?')[0] ?? '';
  // `%2e` IS a dot to the URL parser (`/%2e%2e/` normalizes like `/../`).
  return !pathname
    .split('/')
    .map((segment) => segment.toLowerCase().replace(/%2e/g, '.'))
    .some((segment) => segment === '.' || segment === '..');
}

/**
 * The ONLY media-proxy URL shape the server mints: a server-relative
 * `/api/v1/media/proxy?u=<base64url>&e=<digits>&s=<base64url>` path. The
 * query alphabet is exactly what those three values can hold, so nothing a
 * producer smuggled into an embed (another path, a fragment, a
 * protocol-relative `//host`) can pass for one.
 */
const MEDIA_PROXY_PATH = /^\/api\/v1\/media\/proxy\?[A-Za-z0-9_\-=&]+$/;

/**
 * Resolve a server-minted media-proxy URL (an embed's `proxy_url` /
 * `proxy_icon_url`, or a `content_proxy_urls` value) to what an `<img src>`
 * may load: the same-origin path, absolutized against the configured origin
 * in the desktop shell. Anything else is `undefined` — the caller renders no
 * image. External images are ONLY ever loaded through this (the CSP's
 * `img-src 'self'` would refuse the source URL anyway).
 */
export function mediaProxyUrl(
  value: unknown,
  origin: string | undefined = configuredOrigin(),
): string | undefined {
  if (typeof value !== 'string' || !MEDIA_PROXY_PATH.test(value)) return undefined;
  return assetUrl(value, origin);
}

/** What an attachment's `url` may render as. */
export type AttachmentTarget =
  | { kind: 'attachment'; href: string }
  | { kind: 'external'; href: string };

/**
 * Classify a message attachment's `url` before it becomes an `href`/`src`.
 *
 * Attachment objects arrive inside messages, and a message body is only as
 * trustworthy as whoever wrote it (a bot, a webhook, a compat client): an
 * attachment "file chip" whose url is `javascript:…` or an arbitrary site is
 * a phishing/XSS link wearing the app's own download affordance. So:
 *
 *   * a same-origin attachment path (`/api/v1/attachments/…`, query allowed —
 *     or that path already absolutized against the configured origin) is an
 *     `attachment`, resolved through `assetUrl`;
 *   * any other absolute http(s) URL is `external` — callers must render it
 *     visibly marked as leaving the app, never as a trusted file/preview;
 *   * everything else (other schemes, relative paths elsewhere, junk) is
 *     `null` — render no link at all.
 */
export function attachmentTarget(
  url: unknown,
  origin: string | undefined = configuredOrigin(),
  loc: { origin?: string } | undefined = globalThis.location,
): AttachmentTarget | null {
  if (typeof url !== 'string' || url === '') return null;

  if (url.startsWith('/')) {
    if (url.startsWith('//')) return null;
    return isAttachmentPath(url) ? { kind: 'attachment', href: assetUrl(url, origin) ?? url } : null;
  }

  if (!/^https?:\/\//i.test(url)) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  const own = [normalizeOrigin(origin), loc?.origin && loc.origin !== 'null' ? loc.origin : undefined];
  const relative = parsed.pathname + parsed.search;
  if (own.includes(parsed.origin) && parsed.hash === '' && isAttachmentPath(relative)) {
    return { kind: 'attachment', href: parsed.href };
  }

  return { kind: 'external', href: parsed.href };
}

/**
 * Absolute URL for a server-relative API path. The api-client builds its own
 * base URL from `configuredOrigin`; the few modules that fetch directly
 * (people directory, workspace search, invite landing) must go through this
 * for the same reason — a bare `/api/v1/...` resolves against the webview
 * scheme in the packaged shell instead of the server.
 */
export function apiUrl(
  path: string,
  origin: string | undefined = configuredOrigin(),
): string {
  return origin ? `${origin}${path}` : path;
}

/**
 * The origin a SHAREABLE link has to point at (#114): what Copy Link puts in
 * front of a message permalink.
 *
 * Deliberately not `location.origin` in the packaged shell, where that is
 * `tauri://localhost` — a string nobody else can open. A configured origin
 * (baked build value, or the hosted fallback a packaged shell already talks
 * to the API on) wins; a plain browser, where the SPA is served same-origin
 * with the API, keeps its own. The trailing slash is stripped so `/#/…`
 * never becomes `//#/…`.
 */
export function permalinkOrigin(
  origin: string | undefined = configuredOrigin(),
  loc: { origin?: string } | undefined = globalThis.location,
): string {
  const resolved = origin ?? loc?.origin ?? '';
  return resolved === 'null' ? '' : resolved.replace(/\/+$/, '');
}

/**
 * Cache-busting variant of an asset URL for a retry attempt (`attempt` 0
 * returns the URL unchanged). Attachment URLs are content-addressed, so a
 * failed load of `/api/v1/attachments/<hash>` can never be "fixed" by the URL
 * changing — a retry needs a distinct URL to reach the network again.
 */
export function retryUrl(url: string, attempt = 0): string {
  if (attempt <= 0) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}retry=${attempt}`;
}
