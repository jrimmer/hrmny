/**
 * @cytale/markdown — link target policy (security pass).
 *
 * The grammar accepts any whitespace-free target (`parse.ts`'s `LINK_TOKEN`),
 * and a message body is authored by whoever can post in the channel. Handing
 * that target to a renderer's opener unguarded means a peer can put a
 * tappable `javascript:` run in a victim's web session, or an `intent://`,
 * `tel:` or `sms:` action in a native one — so the policy lives here, next to
 * the grammar that produces the targets, and BOTH renderers apply it.
 *
 * The allowlist is deliberately the browser's two: `http`/`https` open a tab
 * or hand the URL to the OS browser; anything that resolves through another
 * app (a dialer, an SMS composer, a market, an intent) stays inert text.
 */

const OPENABLE_LINK_SCHEMES: ReadonlySet<string> = new Set(['http', 'https']);

/**
 * True when `href` may be rendered as a live link and handed to an opener.
 *
 * The scheme is matched at position 0 and nothing is trimmed: the grammar
 * forbids whitespace in a target, so a string that only resembles a URL after
 * normalisation is rejected, not repaired.
 */
export function isOpenableLinkHref(href: string): boolean {
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(href);
  if (scheme === null) return false;
  return OPENABLE_LINK_SCHEMES.has((scheme[1] ?? '').toLowerCase());
}
