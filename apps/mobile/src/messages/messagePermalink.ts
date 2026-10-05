/**
 * @cytale/mobile — the message permalink a "Copy link" tap writes, and the
 * only spelling this client writes.
 *
 * ONE shape, MINTED (#118 option B): `https://<origin>/m/<token>`. The token is
 * a keyed `(channel_id, message_id)` — the key never leaves the server — so a
 * client cannot compute one: `mintMessageLink` asks the live session's api
 * client (`POST /permalinks`, ONE round trip) and turns the token into the
 * absolute URL the clipboard gets. A single opaque segment publishes nothing
 * about our route grammar, the workspace/channel/message layout, or the ids,
 * and the same address opens in a browser, in the desktop shell, and on
 * another phone.
 *
 * The legacy fragment form
 * (`https://<origin>/#/workspace/<ws>/channel/<ch>/[thread/<t>/]message/<mid>`)
 * is still RESOLVED everywhere — it is in people's message histories, so
 * `@cytale/domain` keeps its grammar and the web client still writes it for its
 * in-app routes — but this client no longer writes it: it hands the ids (and
 * our route grammar) to anyone the link is sent to, which is exactly what #118
 * replaced.
 *
 * Two facts are the host's, not the mint's:
 *   * the ORIGIN — a build-time input on native (`EXPO_PUBLIC_CYTALE_ORIGIN`,
 *     `buildTimeOrigin`). With none configured there is no address to write, so
 *     this answers null rather than inventing a host (and rather than spending
 *     a round trip on a URL nobody could open);
 *   * the CHANNEL — a thread reply's `channel_id` is its PARENT channel (the
 *     store stamps it from `threadsById` when the reply lands), which is the id
 *     the server keys the token with, so the landing resolves the reply INSIDE
 *     its thread. Never the thread id.
 *
 * A failed mint REJECTS. The caller must report that as a failure and write
 * NOTHING: a link that was not minted may not resolve, and a stale/legacy
 * fallback would publish exactly what the token exists to keep private.
 */

import { isSnowflake } from '@cytale/domain';

import { buildTimeOrigin, getSessionManager } from '../navigation/session';

/** The path every minted permalink lives at (#118), as web spells it. */
export const PERMALINK_PATH_PREFIX = '/m/';

/** The fields a message needs to be addressable. */
export interface LinkableMessage {
  id: string;
  /** The PARENT channel id — for a thread reply as much as for a channel message. */
  channel_id: string;
  /** The thread the message is a reply in, when it is one. */
  thread_id?: string | null;
}

/** The mint call `mintMessageLink` makes, as an injectable seam for tests. */
export type PermalinkMinter = (channelId: string, messageId: string) => Promise<{ token: string }>;

/**
 * The production minter: the live session's api client (`POST /permalinks`),
 * the composition root `SessionProvider` publishes. It REJECTS when there is no
 * session to mint through — the sheet then reports the copy as failed, which is
 * the honest answer (the alternative is a link nobody minted).
 */
export function sessionPermalinkMinter(
  channelId: string,
  messageId: string,
): Promise<{ token: string }> {
  const manager = getSessionManager();
  if (manager === null) {
    return Promise.reject(new Error('mintMessageLink: no signed-in session to mint through'));
  }
  return manager.api.mintPermalink(channelId, messageId);
}

/** The absolute address of a token: `<origin>/m/<token>` (web's spelling). */
export function permalinkUrlForToken(token: string, origin: string): string {
  const base = origin.replace(/\/+$/, '');
  return `${base}${PERMALINK_PATH_PREFIX}${token}`;
}

/**
 * Mint `message`'s opaque permalink and resolve the absolute URL to copy —
 * `https://<origin>/m/<token>` — or null when the message has no address to
 * mint one for.
 *
 * ONE round trip, and the caller must not hide it: there is no local fallback
 * to another spelling, because a link that was not minted is a link that may
 * not resolve. Null is reserved for the two LOCAL "nothing to mint" facts — a
 * build with no configured origin, and an optimistic `pending_…` placeholder
 * whose id is not a snowflake yet (web's `isSnowflake` guard, same rule). Every
 * other outcome — offline, a 404 for a channel the caller cannot read, a
 * malformed answer — REJECTS, and the caller reports the failure as a failure.
 */
export function mintMessageLink(
  message: LinkableMessage,
  mint: PermalinkMinter = sessionPermalinkMinter,
  origin: string | undefined = buildTimeOrigin(),
): Promise<string | null> {
  if (origin === undefined) return Promise.resolve(null);
  if (!isSnowflake(message.id)) return Promise.resolve(null);
  return mint(message.channel_id, message.id).then(({ token }) =>
    permalinkUrlForToken(token, origin),
  );
}
