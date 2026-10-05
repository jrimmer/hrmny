/**
 * @cytale/tui — presence: who is online, and whether that answer is still true
 * (U15; R25, KTD10).
 *
 * R25 is one sentence — "column one shows which members are online" — and it
 * hides two separate failures.
 *
 * ---------------------------------------------------------------------------
 * 1. The value comes from the shared store, over the shared fold
 * ---------------------------------------------------------------------------
 *
 * Presence is read from `@cytale/state`'s `presenceByUser` slice — the same
 * slice apps/web's member list reads (`usePresence.ts`) and the same one
 * `applyGatewayEvent` folds the gateway's PRESENCE_UPDATE dispatch into. This
 * module owns no fetch, no cache, and no second derivation: `presenceFor` is a
 * projection of `{ presenceByUser }`, so a member's terminal and their browser
 * cannot disagree about who is online, and a dispatch that lands while the
 * member is looking at the list is on screen without a reload.
 *
 * ---------------------------------------------------------------------------
 * 2. The value has an age, and a dropped link does not refresh it
 * ---------------------------------------------------------------------------
 *
 * The store keeps the last status it was told. If the gateway link drops, that
 * status stays there — and drawing it unchanged is a lie, because the client
 * has no idea what happened since. So the reading is a function of the status
 * AND the link, and the rule is stated here rather than left to a call site:
 *
 *   * `'live'` — a confirmed gateway link (`client.ts` reports `online`). The
 *     status is presented as current.
 *   * `'stale'` — anything else: not connected yet, dropped, an access token
 *     that will not authenticate, a failed attempt, or local mode with no
 *     credential. Presence is presented as UNKNOWN (`◌`), not as the last value
 *     and not as `offline`.
 *
 * Unknown is deliberately a third rendering, not a synonym for offline: nobody
 * signs off when a laptop's wifi drops, so "we cannot know right now" and "they
 * are gone" must not read the same. `presenceLinkForPhase` is a total function
 * over the connection phase, and its default is `'stale'` — the honest default
 * is "not current", never "current".
 *
 * ---------------------------------------------------------------------------
 * The non-colour channel, and the glyphs that already exist
 * ---------------------------------------------------------------------------
 *
 * Every state carries a glyph and a word as well as a colour, so a monochrome
 * terminal and a colour-blind member both read it (the rule the banner's
 * `PHASE_MARKERS`, the column focus marker, and U6's presence rows follow).
 * Colour is decorative here and never load-bearing: nothing is asserted to
 * depend on it, and the glyph alone decides the state.
 *
 * This module OWNS the glyph table and `presenceGlyph`, which U6 first defined
 * in `columns/NavigationColumn.js`. They moved here when the column needed to
 * draw a stale reading: the call site has to ask this module, and this module
 * imported the table from the column, so leaving them put would have made the
 * two files import each other. Presence logic lives with the presence code.
 *
 * The lookup is also hardened here, because the original was reachable: its
 * `PRESENCE_GLYPHS[status] ?? offline` fallback catches an unknown string but
 * not a prototype key, so `presenceGlyph('constructor')` returned `Object`'s
 * constructor — a FUNCTION where a glyph belongs, which React refuses to
 * render. Every lookup is now gated on `Object.hasOwn`. `normalizePresenceStatus`
 * remains the outer gate, so the only arguments that reach the table are its own
 * four keys — but the table no longer depends on a caller having normalized
 * first, and `readPresence` has no input it cannot render.
 *
 * ---------------------------------------------------------------------------
 * KTD10: the name is the member's own
 * ---------------------------------------------------------------------------
 *
 * `PresenceIndicator` can render a member's display name beside the glyph, and
 * a member sets their own display name. So the name crosses
 * `sanitizeTerminalText` HERE, through `layout.ts`'s `inertText`, before it can
 * reach a cell: otherwise a member could clear another member's screen, move
 * their cursor, or write their clipboard from a name. A name whose sanitized
 * form is empty falls back to a label saying what the row is, rather than a
 * nameless row (the sanitizer removes sequences, it never invents text).
 *
 * ---------------------------------------------------------------------------
 * The states this surface has, and the ones it does not
 * ---------------------------------------------------------------------------
 *
 *   * `offline` — `PresenceLink === 'stale'`. Covered above.
 *   * `loading` — before U12's roster lands, `presenceByUser` is empty, so every
 *     member reads absent under a live link and every member reads UNKNOWN while
 *     the link is still being established. Both are honest; neither is an error.
 *   * `empty` — there are no member rows, so there is nothing to draw. The
 *     roster's empty state is column one's (U6), not the indicator's.
 *   * `error` — a roster read that failed (`membersFailed` in the hydration
 *     snapshot) leaves no members to annotate, so that state is column one's
 *     too. This module has no rows of its own to fail.
 */
import { Text } from 'ink';
import type { ReactElement } from 'react';

import type { PresenceStatus } from '@cytale/protocol';

import { inertText } from './layout.js';

// ---------------------------------------------------------------------------
// The glyph table (R25) — a non-colour channel as well as a colour
// ---------------------------------------------------------------------------

/**
 * One glyph per status. Presence is also coloured at the call site; a glyph
 * alone carries the state, so a monochrome terminal reads it too (the same rule
 * the banner's phase markers and the column focus marker follow). An idle or
 * do-not-disturb member is NOT online, and an unknown value is offline rather
 * than an error — the store may simply not have heard about that member yet.
 */
export const PRESENCE_GLYPHS: Record<PresenceStatus, string> = {
  online: '●',
  idle: '◐',
  dnd: '◔',
  offline: '○',
};

/**
 * A status's glyph, or the offline glyph when there is no status to read.
 *
 * `Object.hasOwn` is load-bearing, not defensive: indexing the record directly
 * with a prototype key resolves through `Object.prototype` and hands back a
 * function, which React will not render. An unnormalized string from the wire,
 * or a member id that collides with `constructor`/`toString`, must degrade to
 * offline rather than take the pane down with it.
 */
export function presenceGlyph(status: PresenceStatus | null | undefined): string {
  if (status === null || status === undefined) return PRESENCE_GLYPHS.offline;
  return Object.hasOwn(PRESENCE_GLYPHS, status)
    ? PRESENCE_GLYPHS[status]
    : PRESENCE_GLYPHS.offline;
}

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

/**
 * Whether the reading behind a glyph is current.
 *
 * `'live'` is a confirmed gateway link; `'stale'` is every other state,
 * including "not connected yet". The type is a two-value union rather than a
 * boolean so a call site reads as a statement — `link: 'stale'` — instead of
 * `stale: true` with no noun.
 */
export type PresenceLink = 'live' | 'stale';

/**
 * The connection phases that mean the gateway is up (`client.ts`'s own reading
 * of `ConnectionState`: `connected`/`ready` → online).
 *
 * A `Set` of strings, on purpose: `app.tsx`'s `ConnectionPhase` satisfies it
 * structurally, so the shell passes its own view without this module importing
 * the shell (which another unit owns) or forking its phase vocabulary.
 */
const LIVE_PHASES: ReadonlySet<string> = new Set(['online']);

/**
 * The freshness a connection phase implies. Total: an absent, unknown, or
 * future phase is `'stale'`, because a client that cannot confirm its link must
 * not present presence as current.
 */
export function presenceLinkForPhase(phase: string | null | undefined): PresenceLink {
  return typeof phase === 'string' && LIVE_PHASES.has(phase) ? 'live' : 'stale';
}

// ---------------------------------------------------------------------------
// The reading
// ---------------------------------------------------------------------------

/** The word for each status — the second non-colour channel. */
export const PRESENCE_WORDS: Record<PresenceStatus, string> = {
  online: 'online',
  idle: 'idle',
  dnd: 'do not disturb',
  offline: 'offline',
};

/**
 * What a stale reading draws. `◌` is the banner's "not current, and not
 * finished" glyph (`PHASE_MARKERS.expired`), reused deliberately so "this
 * reading is not current" looks the same wherever the client says it.
 */
export const PRESENCE_STALE_GLYPH = '◌';

/**
 * The stale reading's word. Not "offline": the member's status is unknown, and
 * spelling it "offline" would report a fact the client does not have.
 */
export const PRESENCE_STALE_WORD = 'unknown';

/**
 * A known status, or `'offline'` for anything else.
 *
 * The gate described in the header: `null`, `undefined`, a value the wire could
 * not produce, and a prototype key (`'constructor'`, `'toString'`, …) all land
 * on `'offline'`, so no caller can reach `PRESENCE_GLYPHS` with a key that
 * resolves to something that is not a glyph. Unknown is offline rather than an
 * error — the store may simply not have heard about that member yet (the rule
 * apps/web's `presenceOf` follows).
 */
export function normalizePresenceStatus(status: PresenceStatus | null | undefined): PresenceStatus {
  return typeof status === 'string' && Object.hasOwn(PRESENCE_GLYPHS, status)
    ? (status as PresenceStatus)
    : 'offline';
}

/**
 * What to draw for one member: the glyph, the word, and the status the reading
 * actually presents.
 *
 * `status` is `null` on a stale reading, so the three fields can never
 * contradict each other — a caller that renders `status` instead of the glyph
 * gets "nothing is current", not the last value the store happened to hold. The
 * last-known value stays in the store, where it belongs.
 */
export interface PresenceReading {
  /** The status presented; `null` when nothing about the member is current. */
  readonly status: PresenceStatus | null;
  readonly link: PresenceLink;
  /** The cell's non-colour channel (U6's table for the live states). */
  readonly glyph: string;
  /** The same state spelled out, for a surface with room for it. */
  readonly word: string;
}

/** One member's reading, from their status and the link behind it. */
export function readPresence(
  status: PresenceStatus | null | undefined,
  link: PresenceLink = 'live',
): PresenceReading {
  if (link === 'stale') {
    return {
      status: null,
      link: 'stale',
      glyph: PRESENCE_STALE_GLYPH,
      word: PRESENCE_STALE_WORD,
    };
  }
  const known = normalizePresenceStatus(status);
  return {
    status: known,
    link: 'live',
    // Safe by construction: `known` is one of the table's own keys (see
    // `normalizePresenceStatus`), so this returns a glyph for every input.
    glyph: presenceGlyph(known),
    word: PRESENCE_WORDS[known],
  };
}

/** The store slice the indicator reads (structural: `StateState` satisfies it). */
export interface PresenceSource {
  readonly presenceByUser?: Record<string, { status: PresenceStatus } | undefined> | undefined;
}

/** One member's reading straight off the shared store — the only data path. */
export function presenceFor(
  source: PresenceSource,
  userId: string,
  link: PresenceLink = 'live',
): PresenceReading {
  return readPresence(source.presenceByUser?.[userId]?.status, link);
}

// ---------------------------------------------------------------------------
// The indicator
// ---------------------------------------------------------------------------

/** The colour channel. Decorative: the glyph decides the state, not this. */
const LIVE_COLORS: Record<PresenceStatus, string> = {
  online: 'green',
  idle: 'yellow',
  dnd: 'red',
  offline: 'gray',
};

export interface PresenceIndicatorProps {
  /**
   * The member's status from the store (`presenceByUser[id]?.status`). Absent or
   * unknown renders as offline; nothing here throws on a wire value.
   */
  readonly status: PresenceStatus | null | undefined;
  /**
   * The gateway link behind that status. Defaults to `'live'` so a caller with
   * no connection signal renders exactly what U6's inline glyph drew.
   */
  readonly link?: PresenceLink;
  /**
   * The member's display name, when the indicator labels its own row. It is
   * theirs to set, so it is made inert here (KTD10).
   */
  readonly name?: string | null;
}

/**
 * The dot (and, when asked, the name) beside a member: a glyph plus a colour,
 * with the glyph carrying the state and the reading refusing to draw a stale
 * value as a current one.
 */
export function PresenceIndicator({
  status,
  link = 'live',
  name,
}: PresenceIndicatorProps): ReactElement {
  const reading = readPresence(status, link);
  const label = name === undefined || name === null ? null : inertText(name, 'unnamed member');
  const text = label === null ? reading.glyph : `${reading.glyph} ${label}`;
  // Colour present ⟺ a live reading; a stale one is dimmed and colourless, so
  // no colour can imply a currency the client does not have.
  const tint = reading.status === null ? null : LIVE_COLORS[reading.status];
  return (
    <Text color={tint ?? undefined} dimColor={tint === null}>
      {text}
    </Text>
  );
}
