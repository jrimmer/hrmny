/**
 * @cytale/web — the in-app permalink chip (#118).
 *
 * A message that contains a permalink FOR THIS INSTANCE renders as a chip —
 * channel, author, the message's own first words — instead of a bare URL,
 * the way a `<@mention>` renders as a name. The link rule (is this ours?) is
 * `instancePermalinkTarget`; THIS module is the other half, and it serves both
 * spellings of that rule:
 *
 *   - a LEGACY `#/…` link carries the ids, so the chip resolves it through
 *     #114's point read (`GET /channels/{id}/messages/{mid}`) directly;
 *   - a `/m/<token>` link (#118 option B, what Copy Link writes now) carries
 *     ONE opaque token, so the chip resolves THAT first — `GET
 *     /permalinks/{token}`, the same call `usePathPermalink` lands with — and
 *     then makes the same point read. Newer form, identical treatment.
 *
 * Either way the chip renders only when the resolution AND the reader's own
 * roster can name both the channel and the author.
 *
 * ## It degrades, always
 *
 * A chip is decoration on a link that must work regardless. Every path that
 * is not a complete chip falls back to the plain link — the SAME anchor the
 * renderer emits for any other link — so a chip can never be the reason a
 * message fails to render, and never the reason a link stops being followable:
 *
 *   - still resolving (a chip is not worth a spinner),
 *   - a token that does not resolve (unknown, tampered, or a channel this
 *     reader cannot see — the server answers one 404 for all three),
 *   - 404 (the message is gone, or is not for this reader),
 *   - any transport failure (offline, a 500) — on the token resolve or on the
 *     point read,
 *   - a target whose channel the roster does not know,
 *   - a target whose author the roster cannot name,
 *   - a target with no text to show (an attachment-only message),
 *   - an href that only looks like a token link (`/m/<token>/extra`, a
 *     fragment, a foreign host): `instancePermalinkTarget` refuses it and no
 *     request is ever made.
 *
 * ## What it will NOT show
 *
 * Nothing about a message the reader cannot read. The chip is built from the
 * resolved payload plus the reader's own store — never from the store alone:
 * a resolution that fails leaves the link as the sender wrote it, so a
 * permalink into a channel the reader has no access to discloses exactly what
 * the pasted URL already said and not one field more. A token makes that
 * stronger, not weaker: the ids it hides are the server's to disclose, and
 * until it does, the token is the whole of what this component knows.
 *
 * ## Cost
 *
 * One resolve per unique target PER SESSION, whichever spelling the link used:
 * a legacy link memoizes the point read under `channel:message`, and a token
 * link memoizes the TOKEN's answer under the token and then shares that point
 * read. Ten messages quoting the same link therefore cost one request for a
 * legacy link, and one resolve plus one point read for a token; a re-mounted
 * row (virtualized scrollback) costs none. Memoizing by TOKEN is what keeps a
 * body that quotes the same link twice — on a channel page that re-renders
 * constantly — from asking twice, since a re-render re-parses the href into a
 * fresh object every time. Failures are deliberately NOT memoized — a drop is
 * not a verdict, so a later mount may try again.
 */

import React, { useEffect, useState } from 'react';

import { previewText, resolveMentionTokens } from '@cytale/markdown';
import type { Channel } from '@cytale/domain';
import { defaultStore, type StateState, type StateStore } from '@cytale/state';

import { useStoreSlices } from '../../app/useStoreSelector.js';
import { api } from '../auth/session.js';
import type { InstancePermalinkTarget } from './messagePermalink.js';
import { linkAnchorProps } from './markdown.js';
import { resolveAuthor, type AuthorOverrideLike } from './authorIdentity.js';
import type { MessageWithBots } from './types.js';
import { displayNameOf } from '@cytale/domain';

/** How much of the target's own words the chip shows. */
const SNIPPET_MAX = 80;

/** The slice of a resolved message a chip renders from. */
export interface ChipMessage {
  /** The resolved message's own id (the link's address, for `data-message-id`). */
  id: string;
  channelId: string;
  authorId: string;
  /** A webhook message's per-message identity (its name wins over the roster). */
  authorOverride?: AuthorOverrideLike | null;
  content: string;
}

/** What a chip's labels read off the store (lane D #17). */
const CHIP_SLICES = ['channels', 'membersById', 'currentUser', 'nicknamesByWorkspace'] as const;

/**
 * Entries each session-long cache keeps (lane D #16). Both caches were
 * unbounded maps for the life of the tab — a long session that scrolled
 * through many linked messages kept every one. An LRU at this size holds far
 * more than a screenful of chips, and an evicted entry is simply re-read.
 */
export const CHIP_CACHE_MAX = 200;

/** A Map bounded to `max` entries, least-recently-used first out. */
class LruMap<K, V> {
  readonly #map = new Map<K, V>();
  constructor(readonly max: number) {}
  get(key: K): V | undefined {
    const value = this.#map.get(key);
    if (value !== undefined) {
      // Re-insert: Map iteration order IS recency order.
      this.#map.delete(key);
      this.#map.set(key, value);
    }
    return value;
  }
  set(key: K, value: V): void {
    this.#map.delete(key);
    this.#map.set(key, value);
    while (this.#map.size > this.max) {
      const oldest = this.#map.keys().next().value as K;
      this.#map.delete(oldest);
    }
  }
  get size(): number {
    return this.#map.size;
  }
  clear(): void {
    this.#map.clear();
  }
}

const cache = new LruMap<string, ChipMessage>(CHIP_CACHE_MAX);
const inFlight = new Map<string, Promise<ChipMessage | null>>();

/** Test probe: how many resolved messages / tokens the caches hold. */
export function permalinkChipCacheSizesForTests(): { messages: number; tokens: number } {
  return { messages: cache.size, tokens: tokenCache.size };
}

const cacheKey = (channelId: string, messageId: string): string => `${channelId}:${messageId}`;

/**
 * The message a chip needs, or null when this reader cannot have it — the
 * point read (#114's `GET /channels/{id}/messages/{mid}`) that BOTH spellings
 * end at: a `#/…` link calls it directly, a `/m/<token>` link after
 * `resolvePermalinkChipToken` above.
 *
 * Exported for the tests (the component below is the only production caller):
 * it is the cache and the de-duplication, and pinning "one request for two
 * copies of the same link" needs to reach it directly.
 */
export async function resolvePermalinkChipMessage(
  channelId: string,
  messageId: string,
): Promise<ChipMessage | null> {
  const key = cacheKey(channelId, messageId);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const pending = inFlight.get(key);
  if (pending !== undefined) return pending;

  const attempt = (async () => {
    try {
      const message = await api.getMessage(channelId, messageId);
      const resolved: ChipMessage = {
        id: message.id,
        channelId,
        authorId: message.author_id,
        authorOverride: (message as MessageWithBots).author_override ?? null,
        content: message.content ?? '',
      };
      cache.set(key, resolved);
      return resolved;
    } catch {
      // Out of reach, gone, or forbidden — one shape for all of them, and the
      // answer to the reader is the same: keep the link you were given.
      return null;
    } finally {
      // Asked once: a failure is not cached (see the moduledoc), a success is.
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, attempt);
  return attempt;
}

/** The pair a `/m/<token>` resolves to — what `GET /permalinks/{token}` answers. */
export interface ResolvedChipTarget {
  channelId: string;
  messageId: string;
}

const tokenCache = new LruMap<string, ResolvedChipTarget>(CHIP_CACHE_MAX);
const tokenInFlight = new Map<string, Promise<ResolvedChipTarget | null>>();

/**
 * The token half of a chip's resolve (#118 option B): the ids behind an opaque
 * `/m/<token>`, through the same call `usePathPermalink` lands with.
 *
 * Exported for the tests, like `resolvePermalinkChipMessage` above: the cache
 * and the de-duplication live here, and "one resolve for two copies of the
 * same link in one body" is pinned by reaching this seam.
 *
 * Memoized by TOKEN, never per render: a body may quote the same link twice
 * and a channel page re-renders constantly (a re-render re-parses the href
 * into a fresh target object), so the answer is per session and the concurrent
 * asks are de-duplicated exactly like the point read's. A token that does not
 * resolve — unknown, tampered, or a channel this reader cannot see, which the
 * server answers identically — is NOT memoized: the reader may sign in
 * differently a moment from now, and a failure is not a verdict.
 */
export async function resolvePermalinkChipToken(
  token: string,
): Promise<ResolvedChipTarget | null> {
  const hit = tokenCache.get(token);
  if (hit !== undefined) return hit;
  const pending = tokenInFlight.get(token);
  if (pending !== undefined) return pending;

  const attempt = (async () => {
    try {
      const resolved = await api.resolvePermalink(token);
      const target: ResolvedChipTarget = {
        channelId: resolved.channel_id,
        messageId: resolved.message_id,
      };
      tokenCache.set(token, target);
      return target;
    } catch {
      // One shape for every miss, because the server deliberately answers one:
      // an unresolvable token and a channel out of reach are the same 404.
      return null;
    } finally {
      tokenInFlight.delete(token);
    }
  })();

  tokenInFlight.set(token, attempt);
  return attempt;
}

/** Test hook: drop the session's resolutions (module state outlives a test). */
export function forgetPermalinkChipMessages(): void {
  cache.clear();
  inFlight.clear();
  tokenCache.clear();
  tokenInFlight.clear();
}

/** What the chip shows, once both halves have answered. */
interface ChipDescriptor {
  channel: string;
  author: string;
  snippet: string;
}

/**
 * The channel's display label: `#name` for a channel, the peer's name for a
 * DM (a DM channel has no name of its own — the same fallback the DM column
 * uses). Null when neither is known, which is a "render the plain link".
 */
function channelLabel(channel: Channel, state: StateState): string | null {
  if (channel.type === 'dm' || channel.workspace_id === null) {
    const selfId = state.currentUser?.id ?? null;
    const peer = channel.recipients?.find((recipient) => recipient.id !== selfId)?.username;
    // `name` is typed as a string but a DM row can carry null on the wire.
    return peer || channel.name || null;
  }
  return channel.name ? `#${channel.name}` : null;
}

/**
 * The author's display name, through the shared resolver (authorIdentity.ts):
 * a webhook's own name, the roster (nickname, then username — people and bots
 * alike), the session's own user for your own messages, then the DM channel's
 * recipients — a DM peer may share no workspace with the reader, so the roster
 * can miss an author whose message resolved fine (exactly the case the DM
 * column covers from `recipients`). Null = render the plain link.
 */
function authorLabel(message: ChipMessage, channel: Channel, state: StateState): string | null {
  // A username can be null on the wire (a deleted peer).
  const peer = channel.recipients?.find((recipient) => recipient.id === message.authorId)?.username;
  const who = resolveAuthor(state.membersById, message.authorId, {
    self: state.currentUser,
    nicknames: channel.workspace_id ? state.nicknamesByWorkspace?.[channel.workspace_id] : undefined,
    override: message.authorOverride ?? null,
    wireName: peer || null,
  });
  return who.known && who.name ? who.name : null;
}

/**
 * The message's own first words, as the shared one-line preview (`previewText`:
 * markup dropped by the body's own parser, whitespace collapsed) with its
 * mention and channel tokens named, and capped. Deliberately NOT re-rendered
 * markdown: a chip is a pointer to a message, not a place for its formatting
 * (or its code fences) to spill into the row above it — and not a place for
 * raw `**` markers or `<@snowflake>` tokens either, which it used to print.
 */
function snippetOf(content: string, state: StateState): string | null {
  const flat = resolveMentionTokens(
    previewText(content),
    (id) => {
      const m = state.membersById[id];
      if (m) return displayNameOf(m);
      return state.currentUser?.id === id ? state.currentUser.username : undefined;
    },
    (id) => {
      const c = state.channels[id];
      return c && c.type === 'text' && c.workspace_id ? (c.name ?? 'unknown-channel') : 'unknown-channel';
    },
  );
  if (flat === '') return null;
  return flat.length > SNIPPET_MAX ? `${flat.slice(0, SNIPPET_MAX - 1).trimEnd()}…` : flat;
}

/** The chip's text as ONE comparable value (see the chip's selector). */
function chipKeyOf(message: ChipMessage | null, state: StateState): string | null {
  if (message === null) return null;
  const chip = describe(message, state.channels[message.channelId], state);
  return chip === null ? null : `${chip.channel}\u0000${chip.author}\u0000${chip.snippet}`;
}

/** Everything a chip needs, or null when any piece is unavailable. */
function describe(
  message: ChipMessage,
  channel: Channel | undefined,
  state: StateState,
): ChipDescriptor | null {
  if (channel === undefined) return null;
  const snippet = snippetOf(message.content, state);
  if (snippet === null) return null;
  const channelName = channelLabel(channel, state);
  if (channelName === null) return null;
  const author = authorLabel(message, channel, state);
  if (author === null) return null;
  return { channel: channelName, author, snippet };
}

export interface PermalinkChipProps {
  /** The href the body carried — what the chip (and its degraded form) links to. */
  href: string;
  /**
   * The parsed target: `instancePermalinkTarget(href)`. `kind: 'message'`
   * carries the ids; `kind: 'token'` is a `/m/<token>` link whose ids this
   * component resolves for itself.
   */
  target: InstancePermalinkTarget;
  /** The link's own label, for the degraded anchor. */
  text: string;
  /** Injected by tests; the app renders against the module store. */
  store?: StateStore;
}

/**
 * The chip: a real anchor (focusable, openable, copy-link-address works), so
 * it is the SAME affordance as the plain link plus a name — with an
 * accessible name that spells out the channel, the author and that it is a
 * link ("Link to a message in #release from Dana: the deploy is green"),
 * because the visible text alone ("#release · Dana · the deploy is green")
 * leaves a screen reader guessing at the relationship. The separators are
 * aria-hidden: the label already says it in words.
 */
export function PermalinkChip({
  href,
  target,
  text,
  store = defaultStore,
}: PermalinkChipProps): React.ReactElement {
  // A `#/…` link already knows the pair; a `/m/<token>` link does not, and
  // gets it from the resolve call. Only one of the two is ever non-empty.
  const token = target.kind === 'token' ? target.token : null;
  const channelId = target.channelId ?? '';
  const messageId = target.messageId ?? '';
  const [message, setMessage] = useState<ChipMessage | null>(null);
  /** The resolve answered with nothing (unknown / unreachable): plain link. */
  const [unresolved, setUnresolved] = useState(false);

  // Lazy by construction: a chip only exists where a message rendered, and
  // the resolution starts when it mounts (virtualized rows mount when seen).
  // Keyed on the PRIMITIVES, never on `target` — the renderer re-parses the
  // href on every render, so a fresh object identity must not re-run a resolve
  // the cache would answer anyway (the redraw churn the memoization exists for).
  useEffect(() => {
    let live = true;
    const pending: Promise<ChipMessage | null> =
      token === null
        ? resolvePermalinkChipMessage(channelId, messageId)
        : resolvePermalinkChipToken(token).then((ids) =>
            ids === null ? null : resolvePermalinkChipMessage(ids.channelId, ids.messageId),
          );
    void pending.then((resolved) => {
      if (!live) return;
      if (resolved !== null) setMessage(resolved);
      else setUnresolved(true);
    });
    return () => {
      live = false;
    };
  }, [token, channelId, messageId]);

  // The names come from the reader's own store, read live: a roster that
  // hydrates after the message did still turns the link into a chip (and a
  // nickname change reaches it), which is why only the message is cached.
  // Only what the labels read (lane D #17; was whole-store — every chip on
  // screen re-rendered for every gateway event). The chip's text is derived
  // as ONE comparable value (channel · author · snippet), which is what the
  // pending box below keys on.
  const state = useStoreSlices(store, CHIP_SLICES);
  const chipKey = chipKeyOf(message, state);

  // Degraded: the very anchor the renderer emits for any other link (the same
  // props helper), so "no chip" is byte-for-byte what the message contained.
  const plain = <a {...linkAnchorProps(href)}>{text}</a>;
  if (chipKey === null) {
    if (unresolved || message !== null) return plain;
    // Still resolving: the link holds the chip's one-line box (#14), so the
    // swap to the chip does not change the row's height under the list's
    // measurement — a long URL used to wrap to several lines and then
    // collapse into a one-line chip.
    // The anchor itself is the plain link, byte for byte; only its box is
    // the chip's.
    return (
      <span className="permalink-chip-pending" data-testid="permalink-chip-pending">
        {plain}
      </span>
    );
  }
  const [channelName, author, snippet] = chipKey.split('\u0000') as [string, string, string];
  const chip: ChipDescriptor = { channel: channelName, author, snippet };

  return (
    <a
      {...linkAnchorProps(href, 'permalink-chip')}
      data-testid="permalink-chip"
      data-message-id={message?.id}
      aria-label={`Link to a message in ${chip.channel} from ${chip.author}: ${chip.snippet}`}
    >
      <span className="permalink-chip-channel">{chip.channel}</span>
      <span className="permalink-chip-sep" aria-hidden="true">
        ·
      </span>
      <span className="permalink-chip-author">{chip.author}</span>
      <span className="permalink-chip-sep" aria-hidden="true">
        :
      </span>
      <span className="permalink-chip-snippet">{chip.snippet}</span>
    </a>
  );
}
