/**
 * @cytale/tui — presence in column one: who is online, and whether that answer
 * is still true (U15; R25, KTD10).
 *
 * R25 is one sentence — "column one shows which members are online" — and the
 * plan splits it into the two things that can go wrong. The first is the value:
 * a per-member status folded from the gateway's PRESENCE_UPDATE into the shared
 * store's `presenceByUser` slice, which is the SAME path apps/web reads
 * (`usePresence.ts`), so the two clients cannot disagree. The second is the
 * value's AGE: a member whose gateway link dropped still has the last status
 * folded into the store, and drawing that dot unchanged would present a stale
 * reading as a current one.
 *
 * ---------------------------------------------------------------------------
 * What these tests drive, and what they do not
 * ---------------------------------------------------------------------------
 *
 * The store is the only data path, exactly as in the client — and the presence
 * update is a REAL dispatch: `applyGatewayEvent` (U17's own reconcile) receives
 * a wire-shaped `PresenceUpdate` frame with its sequence number, which is the
 * same fold `@cytale/session` pipes the gateway's dispatch stream into. No
 * fixture invents a presence value that the wire could not produce.
 *
 * The mounted surface subscribes to the store the way the shell does
 * (`useSyncExternalStore(store.subscribe, store.getState, store.getState)` — see
 * `app.tsx`), so the "without a reload" and "reflected in the terminal"
 * scenarios are structural: the frame is re-read after the dispatch and nothing
 * is remounted.
 *
 * What is NOT here: the two-column shell. `app.tsx` and
 * `columns/NavigationColumn.tsx` belong to other units, and this unit's job was
 * a clean surface for them to wire (see Presence.tsx's header for the one
 * prop the shell has to pass). Asserting through the shell would test those
 * files' current internals instead.
 */
import { cleanup, render } from 'ink-testing-library';
import { createElement, useSyncExternalStore, type ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import type { GatewayEvent, PresenceStatus, PresenceUpdate } from '@cytale/protocol';
import { applyGatewayEvent, createStateStore, type StateStore } from '@cytale/state';

import {
  PRESENCE_STALE_GLYPH,
  PRESENCE_WORDS,
  PresenceIndicator,
  presenceFor,
  presenceLinkForPhase,
  readPresence,
  type PresenceLink,
} from '../columns/Presence.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The member whose row is on screen. */
const PEER = '900000000000000002';
/** A member the store has never heard of — the pre-hydration shape. */
const STRANGER = '900000000000000099';

const SEEN_AT = '2026-09-13T12:00:00.000Z';

/** A store filled the way reconcile fills it: `presenceByUser`, nothing else. */
function storeWithPresence(entries: Record<string, PresenceStatus> = {}): StateStore {
  const store = createStateStore();
  store.setState({
    presenceByUser: Object.fromEntries(
      Object.entries(entries).map(([id, status]) => [id, { status, last_seen_at: SEEN_AT }]),
    ),
  });
  return store;
}

/**
 * A wire-shaped presence dispatch. The sequence number matters: reconcile's seq
 * gate drops a dispatch at or below `lastSeq`, which is how a RESUMED replay
 * stays duplicate-free.
 */
function presenceUpdate(s: number, user_id: string, status: PresenceStatus): GatewayEvent {
  return {
    op: 0,
    t: 'PresenceUpdate',
    s,
    d: { user_id, status, last_seen_at: SEEN_AT } satisfies PresenceUpdate,
  };
}

// ---------------------------------------------------------------------------
// Harness — the shell's own subscription, with the connection signal injected
// ---------------------------------------------------------------------------

interface RowProps {
  readonly store: StateStore;
  readonly link: PresenceLink;
  readonly userId?: string;
}

/**
 * One member row, subscribed to the shared store exactly as `app.tsx` is. The
 * indicator holds no copy of its own, so a frame change here IS the store→glyph
 * path and nothing else.
 */
function MemberRow({ store, link, userId = PEER }: RowProps): ReactElement {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  return createElement(PresenceIndicator, { status: state.presenceByUser[userId]?.status, link });
}

const mountRow = (props: RowProps): ReturnType<typeof render> =>
  render(createElement(MemberRow, props));

type Instance = ReturnType<typeof mountRow>;

/** Ink folds input and external-store notifications on the next tick. */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

const frame = (instance: Instance): string => instance.lastFrame() ?? '';

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Happy path: the value
// ---------------------------------------------------------------------------

describe('the presence value (R25)', () => {
  it('reads an online member as present and an offline member as absent', () => {
    const online = readPresence('online');
    expect(online.status).toBe('online');
    expect(online.glyph).toBe('●');
    expect(online.word).toBe('online');
    expect(online.link).toBe('live');

    const offline = readPresence('offline');
    expect(offline.glyph).toBe('○');
    expect(offline.word).toBe('offline');
    expect(offline.glyph).not.toBe(online.glyph);
  });

  it('draws a present indicator beside an online member and an absent one beside an offline member', async () => {
    const present = mountRow({ store: storeWithPresence({ [PEER]: 'online' }), link: 'live' });
    await tick();
    expect(frame(present)).toContain('●');

    const absent = mountRow({ store: storeWithPresence({ [PEER]: 'offline' }), link: 'live' });
    await tick();
    expect(frame(absent)).toContain('○');
    expect(frame(absent)).not.toContain('●');
  });

  it('gives every status its own glyph AND its own word, so colour is never the only channel', () => {
    // U6's surviving convention: a monochrome terminal and a colour-blind
    // member both read the state. Two distinct channels, four distinct values.
    const statuses: readonly PresenceStatus[] = ['online', 'idle', 'dnd', 'offline'];
    const glyphs = statuses.map((status) => readPresence(status).glyph);
    const words = statuses.map((status) => readPresence(status).word);
    expect(new Set(glyphs).size).toBe(statuses.length);
    expect(new Set(words).size).toBe(statuses.length);
    expect(words).toEqual(statuses.map((status) => PRESENCE_WORDS[status]));
    // Idle and do-not-disturb are NOT online: neither may borrow the dot that
    // means reachable.
    expect(glyphs[1]).not.toBe(glyphs[0]);
    expect(glyphs[2]).not.toBe(glyphs[0]);
  });
});

// ---------------------------------------------------------------------------
// Happy path + integration: the gateway moves the value, with no reload
// ---------------------------------------------------------------------------

describe('a presence update from the gateway', () => {
  it('changes the indicator without a reload', async () => {
    const store = storeWithPresence({ [PEER]: 'dnd' });
    const instance = mountRow({ store, link: 'live' });
    await tick();
    expect(frame(instance)).toContain('◔');

    applyGatewayEvent(store, presenceUpdate(1, PEER, 'online'));
    await tick();
    // Same mounted instance: the glyph followed the store, not a remount.
    expect(frame(instance)).toContain('●');
    expect(frame(instance)).not.toContain('◔');
  });

  it('reflects a member going offline in the browser, and back, with no cache of its own', async () => {
    const store = storeWithPresence({ [PEER]: 'online' });
    const instance = mountRow({ store, link: 'live' });
    await tick();
    expect(frame(instance)).toContain('●');

    // The other client signs off: the gateway announces it on the same
    // PRESENCE_UPDATE the web client folds.
    applyGatewayEvent(store, presenceUpdate(1, PEER, 'offline'));
    await tick();
    expect(frame(instance)).toContain('○');
    expect(frame(instance)).not.toContain('●');
    // The frame and the store slice agree, because the frame IS the slice.
    expect(presenceFor(store.getState(), PEER).glyph).toBe('○');

    applyGatewayEvent(store, presenceUpdate(2, PEER, 'online'));
    await tick();
    expect(frame(instance)).toContain('●');
  });

  it('ignores a replayed dispatch, as the store does', async () => {
    const store = storeWithPresence({ [PEER]: 'online' });
    const instance = mountRow({ store, link: 'live' });
    await tick();
    applyGatewayEvent(store, presenceUpdate(2, PEER, 'offline'));
    await tick();
    expect(frame(instance)).toContain('○');
    // A duplicate of an already-applied sequence (a RESUMED replay) must not
    // resurrect the older status.
    applyGatewayEvent(store, presenceUpdate(1, PEER, 'online'));
    await tick();
    expect(frame(instance)).toContain('○');
  });
});

// ---------------------------------------------------------------------------
// Edge case: nothing known is not an error
// ---------------------------------------------------------------------------

describe('an unknown or missing presence value', () => {
  it('renders as offline rather than erroring', async () => {
    expect(readPresence(null).glyph).toBe('○');
    expect(readPresence(undefined).glyph).toBe('○');
    expect(readPresence(null).status).toBe('offline');
    // A value the wire could not produce is still not a crash.
    expect(readPresence('busy' as PresenceStatus).status).toBe('offline');
    expect(readPresence('busy' as PresenceStatus).glyph).toBe('○');

    const instance = mountRow({ store: storeWithPresence({}), link: 'live' });
    await tick();
    expect(frame(instance)).toContain('○');
  });

  it('does not hand a prototype key back as a glyph', async () => {
    // `PRESENCE_GLYPHS[status] ?? offline` misses these: the lookup succeeds and
    // returns Object.prototype's members, so a status of "constructor" would put
    // a FUNCTION in the tree and React would refuse to render it. The reading
    // must normalize before it looks anything up.
    for (const hostile of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      const reading = readPresence(hostile as PresenceStatus);
      expect(reading.status, hostile).toBe('offline');
      expect(reading.glyph, hostile).toBe('○');
      expect(typeof reading.glyph, hostile).toBe('string');
    }

    const instance = mountRow({
      store: storeWithPresence({ [PEER]: 'constructor' as PresenceStatus }),
      link: 'live',
    });
    await tick();
    expect(frame(instance)).toContain('○');
  });

  it('covers the pre-hydration state: a member the store has never heard of is offline', () => {
    // The boot state before U12's roster lands: the slice is empty, so every
    // member reads absent — and that is a state, not a failure.
    const empty = storeWithPresence({});
    expect(presenceFor(empty.getState(), STRANGER).glyph).toBe('○');
    expect(presenceFor(empty.getState(), STRANGER).link).toBe('live');

    const known = storeWithPresence({ [PEER]: 'online' });
    expect(presenceFor(known.getState(), PEER).glyph).toBe('●');
    expect(presenceFor(known.getState(), STRANGER).glyph).toBe('○');
  });
});

// ---------------------------------------------------------------------------
// Error path: the disconnected gateway
// ---------------------------------------------------------------------------

describe('a disconnected gateway', () => {
  it('marks presence stale instead of showing the last value as current', async () => {
    const store = storeWithPresence({ [PEER]: 'online' });
    const live = mountRow({ store, link: presenceLinkForPhase('online') });
    await tick();
    expect(frame(live)).toContain('●');

    // The same store, the same member, a dropped link. The last folded value is
    // still in the slice and must NOT be drawn as a live dot.
    const stale = mountRow({ store, link: presenceLinkForPhase('offline') });
    await tick();
    expect(frame(stale)).toContain(PRESENCE_STALE_GLYPH);
    expect(frame(stale)).not.toContain('●');
    // Distinguishable from "offline", too: nobody signs off when the link drops,
    // so "we do not know" and "they are gone" must not read the same either.
    expect(frame(stale)).not.toContain('○');
    expect(frame(stale)).not.toBe(frame(live));
    // The reading itself drops the last value: it is not carried out of the
    // store as something a caller could render as current.
    const reading = readPresence('online', 'stale');
    expect(reading.status).toBeNull();
    expect(reading.word).toBe('unknown');
    expect(reading.word).not.toBe(PRESENCE_WORDS.online);
  });

  it('treats only a live link as current', () => {
    expect(presenceLinkForPhase('online')).toBe('live');
    // Everything else is an absence of a confirmed link: not yet connected,
    // dropped, an access token that will not authenticate, a failed attempt, or
    // a local client with no credential at all.
    for (const phase of ['connecting', 'offline', 'expired', 'failed', 'signed_out']) {
      expect(presenceLinkForPhase(phase), phase).toBe('stale');
    }
    // Missing or unfamiliar signals are stale: the honest default is "not
    // current", never "current".
    expect(presenceLinkForPhase(undefined)).toBe('stale');
    expect(presenceLinkForPhase(null)).toBe('stale');
    expect(presenceLinkForPhase('some-future-phase')).toBe('stale');
  });

  it('renders every member stale at once, not just the ones last seen online', async () => {
    const store = storeWithPresence({ [PEER]: 'online', [STRANGER]: 'idle' });
    const live = mountRow({ store, link: 'live', userId: STRANGER });
    await tick();
    expect(frame(live)).toContain('◐');

    const stale = mountRow({ store, link: 'stale', userId: STRANGER });
    await tick();
    expect(frame(stale)).toContain(PRESENCE_STALE_GLYPH);
    expect(frame(stale)).not.toContain('◐');
  });
});

// ---------------------------------------------------------------------------
// KTD10: a member's own display name is inert
// ---------------------------------------------------------------------------

describe('a display name reaching the indicator', () => {
  const HOSTILE = '\u001b[2J\u001b]52;c;cGF3bmVk\u0007';

  it('is stripped of its escape sequences and its text survives', () => {
    // A member sets their own display name, so this string is theirs: a screen
    // clear and a clipboard write, if the indicator wrote them through.
    const instance = render(
      createElement(PresenceIndicator, { status: 'online', name: `${HOSTILE}dana` }),
    );
    const drawn = frame(instance);
    expect(drawn).not.toContain('\u001b[2J');
    expect(drawn).not.toContain('52;c;');
    expect(drawn).toContain('dana');
    expect(drawn).toContain('●');
  });

  it('keeps the glyph when a hostile name sanitizes away entirely', () => {
    const instance = render(createElement(PresenceIndicator, { status: 'online', name: HOSTILE }));
    const drawn = frame(instance);
    expect(drawn).not.toContain('\u001b[2J');
    expect(drawn).toContain('●');
    // A name that sanitizes to nothing gets a label saying what the row is,
    // rather than a nameless row (U6's fallback rule).
    expect(drawn).toContain('unnamed member');
  });

  it('draws the glyph alone when no name is given', () => {
    const instance = render(createElement(PresenceIndicator, { status: 'idle' }));
    expect(frame(instance)).toBe('◐');
  });
});
