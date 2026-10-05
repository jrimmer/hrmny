/**
 * @cytale/web — the message permalink a "Copy Link" click writes, and the READ
 * half that recognizes one.
 *
 * Two shapes, both alive, one of them historical:
 *
 *   * `https://<origin>/m/<token>` — what Copy Link writes since #118 (option
 *     B). A single opaque segment, minted and resolved by the SERVER (the key
 *     never leaves it), so the copied link publishes nothing about our route
 *     grammar or the ids. `mintPermalinkUrl` is the writer;
 *     `permalinkTokenFromPath` + `permalinkUrlForToken` are the reader.
 *   * `https://<origin>/#/workspace/<ws>/channel/<ch>/message/<mid>` — the
 *     #114 spelling, which stays supported forever (it is in people's
 *     histories) and is still what the OS scheme and the mobile client spell.
 *     It lives in the FRAGMENT, so the server never sees it; the app parses it
 *     with `@cytale/domain`'s shared grammar. `messagePermalinkUrl` is its
 *     writer, kept for exactly that reason.
 *
 * `instancePermalinkTarget` reads BOTH forms backwards: given an href found in
 * a message body, does it address a message on THIS instance? That is the
 * question that turns a pasted link into an in-app chip — and it must be "no"
 * for every other host, or a peer-authored message could make one reader's
 * client fetch an address on somebody else's server. The two forms answer it
 * differently: the fragment grammar carries the ids (`{ kind: 'message' }`),
 * while a token is only a promise of them (`{ kind: 'token' }`) until the
 * server resolves it — recognition stays synchronous and offline either way.
 */

import { buildMessagePermalink, parsePermalinkPath, type PermalinkTarget } from '@cytale/domain';

import { permalinkOrigin } from '../../app/origin.js';
import { api } from '../auth/session.js';

export interface PermalinkMessage {
  id: string;
  channel_id: string;
  /** The thread this message is a reply in, when it is one. */
  thread_id?: string | null;
}

/** The path every copied opaque permalink lives at (#118). */
export const PERMALINK_PATH_PREFIX = '/m/';

/**
 * The absolute URL for `message` in the LEGACY fragment spelling — the #114
 * shape, kept as the writer for the surfaces that still use it (the OS scheme
 * target a desktop/Expo launch hands over, and the mobile client) and for the
 * tests that pin it. Copy Link on the web no longer calls this: since #118 it
 * mints an opaque `/m/<token>` link instead (`mintPermalinkUrl`), because only
 * the server knows the key that makes one.
 *
 * Returns null when the message is not addressable (a non-snowflake id — an
 * optimistic placeholder, say). Callers must treat null as "no link yet"
 * rather than writing something the route cannot read.
 *
 * `workspaceId` is the channel's workspace; pass null/undefined for a DM. A
 * channel the store does not know yet also yields the workspace-less form —
 * still a working link, because the channel id IS the address and the
 * workspace segment only decides which workspace is on screen (the reader's
 * own roster supplies it), so a copy before the roster hydrates is off-shape
 * but never broken. Every rendered message belongs to a channel the pane
 * loaded, so the canonical form is the one actually written in practice.
 */
export function messagePermalinkUrl(
  message: PermalinkMessage,
  workspaceId: string | null | undefined,
  origin: string = permalinkOrigin(),
): string | null {
  return buildMessagePermalink({
    origin,
    workspaceId: workspaceId ?? undefined,
    channelId: message.channel_id,
    threadId: message.thread_id ?? undefined,
    messageId: message.id,
  });
}

/** The mint call `mintPermalinkUrl` makes, as an injectable seam for tests. */
export type PermalinkMinter = (channelId: string, messageId: string) => Promise<{ token: string }>;

/** The production minter: the shared session api-client (`POST /permalinks`). */
const defaultPermalinkMinter: PermalinkMinter = (channelId, messageId) =>
  api.mintPermalink(channelId, messageId);

/**
 * Mint the message's opaque permalink and return the absolute URL to put on
 * the clipboard (#118) — `https://<origin>/m/<token>`.
 *
 * ONE round trip, and the caller must not hide it: there is no local fallback
 * to a different spelling, because a link that was not minted is a link that
 * may not resolve, and a Copy Link that puts something stale (or nothing) on
 * the clipboard is the bug the ticket names. The promise rejects when the mint
 * fails, and the caller reports the FAILURE as a failure.
 *
 * `origin` is `permalinkOrigin()` by default for the same reason it is
 * everywhere else in this module: in the packaged shell `location.origin` is
 * `tauri://localhost`, which nobody else can open. The server also returns its
 * own absolute URL (built from the deployment's public origin), which is what
 * non-browser clients use; the web client prefers its own, because it is the
 * one that knows about the shell.
 */
export async function mintPermalinkUrl(
  channelId: string,
  messageId: string,
  mint: PermalinkMinter = defaultPermalinkMinter,
  origin: string = permalinkOrigin(),
): Promise<string> {
  const { token } = await mint(channelId, messageId);
  return permalinkUrlForToken(token, origin);
}

/** The absolute address of a token: `<origin>/m/<token>`. */
export function permalinkUrlForToken(
  token: string,
  origin: string = permalinkOrigin(),
): string {
  const base = origin.replace(/\/+$/, '');
  return `${base}${PERMALINK_PATH_PREFIX}${token}`;
}

/**
 * The token in a `/m/<token>` PATH (the page path a copied link opens), or
 * null when the path is something else.
 *
 * Deliberately loose about the token itself (`[0-9A-Za-z]`, bounded) and strict
 * about the shape: the token's real grammar is the server's, and a path that
 * LOOKS like a permalink but does not resolve deserves the app's "this link
 * does not work" answer rather than a silent fall-through to Home. A path that
 * is not `/m/…` at all is not ours to interpret.
 */
export function permalinkTokenFromPath(pathname: string): string | null {
  if (typeof pathname !== 'string') return null;
  const match = /^\/m\/([0-9A-Za-z]{1,64})\/?$/.exec(pathname);
  return match?.[1] ?? null;
}

/**
 * A `/m/<token>` link on this instance (#118 option B) — the token form's
 * half of {@link InstancePermalinkTarget}.
 *
 * The ids are typed as ABSENT (`undefined`), not merely unknown, on purpose: a
 * token is not a pair of ids until the server resolves it, and the one mistake
 * worth a compiler error is a token reaching a call that expects a message id
 * (`GET /channels/{id}/messages/{id}`). It also keeps the union a
 * discriminated one, so a consumer that reads `channelId`/`messageId` without
 * narrowing to `kind === 'message'` gets exactly the empty string the
 * degraded-anchor path wants.
 */
export interface TokenPermalinkTarget {
  kind: 'token';
  /** The opaque token, exactly as the href spelled it. */
  token: string;
  channelId?: undefined;
  messageId?: undefined;
}

/**
 * What an href in a message body addresses on THIS instance: a message whose
 * ids the fragment grammar carried (`kind: 'message'`), or a token the server
 * has yet to resolve (`kind: 'token'`). Null from
 * {@link instancePermalinkTarget} means "not ours" — never "not resolved yet",
 * which is a state only the chip can be in.
 */
export type InstancePermalinkTarget = PermalinkTarget | TokenPermalinkTarget;

/**
 * The READ half (#118): the target an href addresses on THIS instance, or null
 * when it does not — a link to another host, a link to a page rather than a
 * hash route, a permalink for a workspace/channel/thread rather than a
 * message, or the malformed shape the grammars refuse.
 *
 * Only a MESSAGE address qualifies: a chip shows the target's author and a
 * snippet of its text, and the shorter forms carry neither to show.
 *
 * Three spellings are accepted, and `origin` is a parameter for the same reason
 * it is one in `messagePermalinkUrl` — the packaged shell's own origin is
 * `tauri://localhost`, so the links people paste there are the SERVER's, and
 * `permalinkOrigin()` is what knows that:
 *
 *   - `https://<origin>/#/workspace/…/message/…` — an absolute link (the
 *     normal case: it is what Copy Link wrote before #118, on one machine or
 *     another);
 *   - `/#/workspace/…/message/…` — the same address written relative to this
 *     page, which is always this instance by construction;
 *   - `https://<origin>/m/<token>` — the form Copy Link writes since #118, and
 *     `/m/<token>` relative to this page. The ids are NOT in the URL: the
 *     answer is `{ kind: 'token' }` and whoever wants the message resolves it
 *     (`GET /permalinks/{token}`, the call `usePathPermalink` lands with and
 *     the chip makes). Recognition never resolves — it runs inside the render
 *     of every link in every message body, and a token that turns out not to
 *     resolve is the chip's degradation, not a parse failure here.
 *
 * A same-origin URL whose PATH is neither the SPA root nor the token route is
 * not a permalink: the app is served at the root and routes on the fragment,
 * so `/foo/#/…` is some other page's link.
 */
export function instancePermalinkTarget(
  href: string,
  origin: string = permalinkOrigin(),
): InstancePermalinkTarget | null {
  if (typeof href !== 'string' || href.length === 0) return null;

  let fragment: string;
  if (href.startsWith('/#')) {
    fragment = href.slice(1);
  } else if (href.startsWith('#')) {
    fragment = href;
  } else if (href.startsWith(PERMALINK_PATH_PREFIX)) {
    // The token form written relative to this page (#118 option B) — this
    // instance by construction, exactly like the `/#…` case above.
    return tokenTarget(href);
  } else {
    // Relative-href case is settled; anything else has to be an absolute
    // http(s) URL on this instance's origin (an unknown origin — a build with
    // no configured origin and no `location` — matches nothing).
    if (origin === '') return null;
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.origin !== origin) return null;
    if (url.pathname.startsWith(PERMALINK_PATH_PREFIX)) {
      // The absolute token form. The fragment is not part of a token address
      // (we never write one), so `/m/<token>#…` is not the link Copy Link
      // wrote and not one this function will vouch for.
      return url.hash === '' ? tokenTarget(url.pathname) : null;
    }
    if (url.pathname !== '/' && url.pathname !== '') return null;
    if (!url.hash.startsWith('#')) return null;
    fragment = url.hash;
  }

  const target = parsePermalinkPath(fragment.slice(1));
  return target !== null && target.kind === 'message' ? target : null;
}

/**
 * The token form's target, or null when the path is not exactly `/m/<token>`.
 * The grammar is `permalinkTokenFromPath`'s — one definition, so the chip and
 * the `/m/<token>` landing can never disagree about what a token path is.
 */
function tokenTarget(pathname: string): TokenPermalinkTarget | null {
  const token = permalinkTokenFromPath(pathname);
  return token === null ? null : { kind: 'token', token };
}
