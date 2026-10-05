/**
 * @cytale/tui — reactions in column two (U14; R24, R26a).
 *
 * Three halves, and each one is the whole point of a different sentence in the
 * unit:
 *
 *   1. THE CHIP MODEL (`format/rows.ts`): a message's reactions become chips
 *      beneath its row, with the member's own distinguishable WITHOUT a colour
 *      channel, and with a stable short name for any emoji this client cannot
 *      name — so a chip is legible on a terminal whose font has no glyph for it.
 *   2. THE STORE FOLD AND THE TOGGLE (`columns/Reactions.tsx`): the member's
 *      own add/remove goes out over the real `/api/v1` endpoints (a real
 *      `CytaleApiClient` over a stubbed `fetch`, so the METHOD and the PATH are
 *      asserted, not assumed), lands optimistically in the shared store, and
 *      reconciles when the server's own echo arrives — once, never twice.
 *   3. THE PANE (`App`): the chips are drawn under the message they belong to
 *      against a store filled the way the REST leg and the gateway fill it.
 *
 * The two scenarios the unit calls out as easy to fake are asserted the hard
 * way: "the member's own is distinguishable" asserts the BRACKETS (a character
 * channel) and that the line carries no escape sequence at all; "a malformed
 * gateway reaction event does not corrupt the message's reaction set" asserts
 * the slice is the SAME REFERENCE afterwards and that the chips still render —
 * not merely that nothing threw.
 *
 * The wire shape is the unit's stated trap: `/api/v1` returns FLAT emoji
 * strings (`[{emoji, count, me}]`, the shape `CytaleApiClient`'s
 * `ReactionSummary` declares and `message_controller.ex`'s `maybe_reactions/2`
 * serves). The nested `{count, me, emoji: {id, name}}` form is the v10-compat
 * dialect (`message_codec.ex`'s `reactions_from_native/1`) and is NOT read
 * here — a test below pins that a row carrying it produces no chips rather than
 * a half-read one.
 */
import { cleanup, render } from 'ink-testing-library';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { CytaleApiClient, createInMemoryTokenProvider } from '@cytale/api-client';
import type { Channel, Message, Workspace, WorkspaceMember } from '@cytale/domain';
import { createStateStore, type StateStore, type StateState } from '@cytale/state';

import { App } from '../app.js';
import { buildContentView } from '../columns/ContentColumn.js';
import { layoutFor } from '../columns/layout.js';
import { visibleWindow } from '../columns/MessageList.js';
import { ReactionChips, applyReactionEvent, toggleOwnReaction } from '../columns/Reactions.js';
import {
  OWN_CHIP_CLOSE,
  OWN_CHIP_OPEN,
  REACTION_PALETTE,
  readReactions,
  reactionLine,
  reactionShortName,
  rowCost,
  type MessageRow,
} from '../format/rows.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORIGIN = 'https://chat.example.com';
const WORKSPACE = '100000000000000001';
const GENERAL = '300000000000000001';
const ME = '900000000000000001';
const DANA = '900000000000000002';

const SIZE = { width: 100, height: 30 } as const;

/** One reaction as the native `/api/v1` message JSON carries it. */
interface WireReaction {
  emoji: string;
  count: number;
  me: boolean;
}

type WireMessage = Message & { reactions?: WireReaction[] | null };

function channel(overrides: Partial<Channel> & Pick<Channel, 'id' | 'name'>): Channel {
  return {
    workspace_id: WORKSPACE,
    type: 'text',
    topic: null,
    position: 0,
    last_message_id: null,
    created_at: '2026-09-13T10:00:00.000Z',
    ...overrides,
  };
}

function message(overrides: Partial<Message> & Pick<Message, 'id' | 'author_id' | 'content'>): Message {
  return {
    channel_id: GENERAL,
    thread_id: null,
    created_at: '2026-09-13T12:00:00.000Z',
    edited_at: null,
    ...overrides,
  };
}

/** A message row carrying reactions, as the native projection serves them. */
function withReactions(base: Message, reactions: WireReaction[]): Message {
  return { ...base, reactions } as Message;
}

function member(id: string, username: string): WorkspaceMember {
  return { id, username, nickname: null, joined_at: '', roles: [] };
}

function baseState(overrides: Partial<StateState> = {}): Partial<StateState> {
  return {
    currentUser: { id: ME, username: 'tester' },
    workspaces: {
      [WORKSPACE]: {
        id: WORKSPACE,
        name: 'Acme',
        owner_id: '1',
        role_version: 1,
        created_at: '2026-09-13T09:00:00.000Z',
      } satisfies Workspace,
    },
    channels: { [GENERAL]: channel({ id: GENERAL, name: 'general' }) },
    membersById: { [ME]: member(ME, 'tester'), [DANA]: member(DANA, 'dana') },
    memberIdsByWorkspace: { [WORKSPACE]: [ME, DANA] },
    ...overrides,
  };
}

/** The store with one message in `#general`, carrying `reactions`. */
function storeWithMessage(reactions: WireReaction[] | null, id = '800000000000000001'): StateStore {
  const store = createStateStore();
  const base = message({ id, author_id: DANA, content: 'hello there' });
  // An empty set and no key are the same fact on the wire (the key is ABSENT
  // when a message has none), so both fixtures build the keyless row.
  const row =
    reactions === null || reactions.length === 0 ? base : withReactions(base, reactions);
  store.setState(
    baseState({
      messagesByChannel: {
        [GENERAL]: { items: [row], oldestId: id, hasCompleteHistory: true },
      },
    }),
  );
  return store;
}

/** The one row of `#general`, as the store currently holds it. */
function storedRow(store: StateStore, id = '800000000000000001'): WireMessage {
  const item = store
    .getState()
    .messagesByChannel[GENERAL]?.items.find((candidate) => candidate.id === id);
  if (item === undefined) throw new Error('the fixture row is gone');
  return item as WireMessage;
}

/** The row's reactions as the wire shape (undefined when the key is absent). */
const storedReactions = (store: StateStore, id?: string): WireReaction[] | undefined =>
  storedRow(store, id).reactions ?? undefined;

// ---------------------------------------------------------------------------
// The real api client over a stubbed transport
// ---------------------------------------------------------------------------

interface StubReply {
  readonly status: number;
  readonly body?: unknown;
  /** Reject instead of answering — a transport failure (offline). */
  readonly reject?: string;
}

interface Stub {
  readonly api: CytaleApiClient;
  readonly calls: { method: string; url: string }[];
}

/**
 * A real `CytaleApiClient` whose transport is the test's: the reaction routes
 * are the api-client's OWN, so a method or path that disagrees with the server
 * fails here rather than in production.
 */
function apiStub(reply: (url: string, method: string) => StubReply): Stub {
  const calls: { method: string; url: string }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url: String(url) });
    const answer = reply(String(url), method);
    if (answer.reject !== undefined) throw new TypeError(answer.reject);
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return {
    api: new CytaleApiClient({
      baseUrl: 'https://api.test',
      tokens: createInMemoryTokenProvider({
        access_token: 'a',
        refresh_token: 'r',
        expires_in: 900,
      }),
      fetchImpl,
    }),
    calls,
  };
}

const OK: StubReply = { status: 204 };

// ---------------------------------------------------------------------------
// Harness (the pane)
// ---------------------------------------------------------------------------

function mount(store: StateStore) {
  return render(
    createElement(App, {
      view: { phase: 'online', headline: `Connected to ${ORIGIN}` },
      mode: 'ssh',
      origin: ORIGIN,
      store,
      width: SIZE.width,
      height: SIZE.height,
    }),
  );
}

type Instance = ReturnType<typeof mount>;

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

const frame = (instance: Instance): string => instance.lastFrame() ?? '';

/**
 * Wait until the pane has PAINTED `needle`. Ink renders on its own schedule and
 * this suite shares the machine with other suites, so the wait is a poll with a
 * bound rather than a guess: a frame that never arrives still fails, one beat
 * late, instead of failing because the box was busy.
 */
async function painted(instance: Instance, needle: string): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (frame(instance).includes(needle)) return;
    await tick();
  }
}

/** Column two's drawn lines, sliced out of the frame by U6's own geometry. */
function contentLines(instance: Instance): string[] {
  const layout = layoutFor(SIZE);
  if (layout.kind !== 'two-column') return [];
  return frame(instance)
    .split('\n')
    .slice(2)
    .map((line) => line.slice(layout.navigationWidth + 1).trimEnd())
    .filter((line) => line.trim() !== '');
}

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// 1. The chip model (pure)
// ---------------------------------------------------------------------------

describe('the reaction vocabulary', () => {
  it('names the palette the way the shared catalog does, so one emoji never has two names', () => {
    // The palette is the web picker's, in its order (the reactions UI contract).
    expect(REACTION_PALETTE).toEqual(['👍', '👎', '❤️', '😂', '😮', '😢', '🎉', '👀']);
    // The short names are `@cytale/emoji`'s canonical shortcodes.
    expect(reactionShortName('👍')).toBe('thumbs_up');
    expect(reactionShortName('👎')).toBe('thumbs_down');
    expect(reactionShortName('❤️')).toBe('heart');
    expect(reactionShortName('😂')).toBe('joy');
    expect(reactionShortName('😮')).toBe('open_mouth');
    expect(reactionShortName('😢')).toBe('crying_face');
    expect(reactionShortName('🎉')).toBe('tada');
    expect(reactionShortName('👀')).toBe('eyes');
  });

  it('falls back to a stable code-point short name for an emoji this client cannot name', () => {
    // Stable: the same emoji always yields the same ASCII name, whatever font
    // the terminal has — that is what makes the fallback legible at all.
    expect(reactionShortName('🫠')).toBe('u1fae0');
    // A ZWJ sequence keeps every code point, so two lookalikes cannot collide.
    expect(reactionShortName('🧑‍💻')).toBe('u1f9d1-u200d-u1f4bb');
    expect(reactionShortName('🫠')).toMatch(/^[a-z0-9-]+$/);
    expect(reactionShortName('🧑‍💻')).toMatch(/^[a-z0-9-]+$/);
  });
});

describe('the chip row', () => {
  it('draws a chip per emoji with its count, and brackets the member’s own', () => {
    const row = {
      reactions: readReactions({
        reactions: [
          { emoji: '👍', count: 3, me: false },
          { emoji: '❤️', count: 1, me: true },
        ],
      }),
    };
    const line = reactionLine(row);
    // The non-colour channel, asserted as the character it is: an own chip is
    // bracketed, someone else's is bare. No SGR sequence appears anywhere.
    expect(line).toBe(`  👍 3  ${OWN_CHIP_OPEN}❤️ 1${OWN_CHIP_CLOSE}`);
    expect(line).not.toMatch(/\u001b/);
    expect(line?.startsWith(' ')).toBe(true);
    expect(OWN_CHIP_OPEN).not.toBe('');
    expect(OWN_CHIP_CLOSE).not.toBe('');
  });

  it('falls back to the short name for an emoji it cannot name, glyph for the ones it can', () => {
    const chips = readReactions({
      reactions: [
        { emoji: '👍', count: 1, me: true },
        { emoji: '🫠', count: 2, me: false },
      ],
    });
    expect(chips[0]?.label).toBe('👍');
    expect(chips[1]?.label).toBe(':u1fae0:');
    expect(reactionLine({ reactions: chips })).toBe(`  ${OWN_CHIP_OPEN}👍 1${OWN_CHIP_CLOSE}  :u1fae0: 2`);
  });

  it('renders nothing at all for a message with no reactions, and costs it no line', () => {
    expect(reactionLine({ reactions: [] })).toBeNull();
    expect(reactionLine({ reactions: undefined })).toBeNull();
    expect(reactionLine({})).toBeNull();
    // The budget agrees: no chip row, no line.
    expect(rowCost({ lines: ['a'], replies: 0, reactions: [] })).toBe(2);
    expect(rowCost({ lines: ['a'], replies: 0, reactions: undefined })).toBe(2);
    // A chip row costs exactly one line (one row, not one per chip).
    const chips = readReactions({
      reactions: [
        { emoji: '👍', count: 1, me: false },
        { emoji: '🎉', count: 2, me: false },
      ],
    });
    expect(rowCost({ lines: ['a'], replies: 0, reactions: chips })).toBe(3);
    // …and never more than it costs: the chip line is one line however many
    // chips it holds, and the reply indicator is one line whatever the count,
    // which is what keeps the pane's paging arithmetic honest.
    expect(rowCost({ lines: ['a', 'b'], replies: 2, reactions: chips })).toBe(5);
  });

  it('is part of the window budget: a chip row pushes the next row out', () => {
    const chips = readReactions({ reactions: [{ emoji: '👍', count: 1, me: false }] });
    const row = (id: string, withChips: boolean): MessageRow => ({
      id,
      authorId: DANA,
      author: 'dana',
      time: '12:00',
      lines: ['body'],
      groupStart: true,
      replies: 0,
      ...(withChips ? { reactions: chips } : {}),
    });
    // Three-line rows in a seven-line budget: two fit, not three.
    expect(visibleWindow([row('a', true), row('b', true)], 0, 0, 7)).toEqual({ start: 0, count: 2 });
    expect(visibleWindow([row('a', true), row('b', true)], 0, 0, 5)).toEqual({ start: 0, count: 1 });
  });
});

describe('reading a row’s reactions defensively', () => {
  it('reads the flat /api/v1 shape, and only that shape', () => {
    expect(readReactions({ reactions: [{ emoji: '👍', count: 2, me: true }] })).toEqual([
      { emoji: '👍', label: '👍', shortName: 'thumbs_up', count: 2, me: true },
    ]);
    // The nested `{id, name}` form is the v10-compat dialect: this client's
    // REST leg is `/api/v1`, so an entry in that shape is not a chip. Half-read
    // it would render an emoji of `undefined`.
    expect(
      readReactions({ reactions: [{ count: 2, me: true, emoji: { id: null, name: '👍' } }] }),
    ).toEqual([]);
  });

  it('drops malformed entries instead of drawing a chip nothing supports', () => {
    const chips = readReactions({
      reactions: [
        { emoji: '👍', count: 2, me: true },
        null,
        'thumbs up',
        { count: 2, me: true },
        { emoji: 42, count: 1, me: false },
        { emoji: '', count: 1, me: false },
        { emoji: '🎉', count: 'two', me: false },
        { emoji: '👀', count: 0, me: false },
        { emoji: '😂', count: -3, me: false },
        { emoji: '😮', count: 1.7, me: false },
        // A duplicate refuses to become a second chip: the set stays a set.
        { emoji: '👍', count: 9, me: false },
      ],
    });
    expect(chips.map((chip) => [chip.emoji, chip.count, chip.me])).toEqual([
      ['👍', 2, true],
      ['😮', 1, false],
    ]);
    // `me` is a boolean or it is not true: a truthy string is not the member.
    expect(readReactions({ reactions: [{ emoji: '👍', count: 1, me: 'yes' }] })[0]?.me).toBe(false);
  });

  it('renders a hostile emoji as inert text (R26a)', () => {
    const chips = readReactions({
      reactions: [
        { emoji: '👍\u001b[2J\u001b[31m', count: 1, me: true },
        { emoji: '\u001b[2J', count: 4, me: false },
      ],
    });
    // The sequence is stripped; what is left is a real emoji, drawn from THIS
    // client's own table rather than from the server's string.
    expect(chips[0]?.label).toBe('👍');
    expect(chips[0]?.emoji).toBe('👍');
    // A value that sanitizes to nothing is no emoji at all: no chip, no count.
    expect(chips).toHaveLength(1);
    const line = reactionLine({ reactions: chips }) ?? '';
    expect(line).not.toContain('\u001b');
    expect(line).not.toContain('[2J');
  });
});

// ---------------------------------------------------------------------------
// 2. The store fold and the toggle
// ---------------------------------------------------------------------------

describe('adding and removing the member’s own reaction', () => {
  it('adds optimistically, over the real endpoint, and the echo does not double-count', async () => {
    const store = storeWithMessage([]);
    const stub = apiStub(() => OK);
    let settled = false;
    const done = toggleOwnReaction({
      store,
      api: stub.api,
      channelId: GENERAL,
      messageId: '800000000000000001',
      emoji: '👍',
    }).then((outcome) => {
      settled = true;
      return outcome;
    });

    // Optimistic: the chip is on screen before the round trip completes.
    expect(settled).toBe(false);
    expect(storedReactions(store)).toEqual([{ emoji: '👍', count: 1, me: true }]);

    const outcome = await done;
    expect(outcome).toEqual({ applied: true, op: 'add', error: null });
    // The wire truth: the api-client's own route, percent-encoded emoji, @me.
    expect(stub.calls).toEqual([
      { method: 'PUT', url: `https://api.test/api/v1/channels/${GENERAL}/messages/800000000000000001/reactions/${encodeURIComponent('👍')}/@me` },
    ]);
    // The shape the browser client renders, once — not twice.
    expect(storedReactions(store)).toEqual([{ emoji: '👍', count: 1, me: true }]);

    // The server echoes the member's own add back (Discord semantics). It is
    // the SAME reaction, so it must not become a second one.
    expect(
      applyReactionEvent(store, {
        op: 0,
        t: 'MessageReactionAdd',
        s: 1,
        d: { channel_id: GENERAL, message_id: '800000000000000001', user_id: ME, emoji: '👍' },
      }),
    ).toBe(true);
    expect(storedReactions(store)).toEqual([{ emoji: '👍', count: 1, me: true }]);
    // …and the fold does NOT advance the sequence: the shared dispatcher owns
    // that, and the fold must read the pre-dispatch value (the ordering rule).
    expect(store.getState().lastSeq).toBe(0);
  });

  it('removes the member’s own reaction, decrementing the count', async () => {
    const store = storeWithMessage([
      { emoji: '👍', count: 2, me: true },
      { emoji: '🎉', count: 1, me: false },
    ]);
    const stub = apiStub(() => OK);
    const outcome = await toggleOwnReaction({
      store,
      api: stub.api,
      channelId: GENERAL,
      messageId: '800000000000000001',
      emoji: '👍',
    });
    expect(outcome).toEqual({ applied: true, op: 'remove', error: null });
    expect(stub.calls[0]?.method).toBe('DELETE');
    expect(stub.calls[0]?.url).toContain(`/reactions/${encodeURIComponent('👍')}/@me`);
    // The member's own is off, the count is down by one, and the other
    // member's chip is untouched.
    expect(storedReactions(store)).toEqual([
      { emoji: '👍', count: 1, me: false },
      { emoji: '🎉', count: 1, me: false },
    ]);

    // The own echo of that remove is swallowed too.
    expect(
      applyReactionEvent(store, {
        op: 0,
        t: 'MessageReactionRemove',
        s: 2,
        d: { channel_id: GENERAL, message_id: '800000000000000001', user_id: ME, emoji: '👍' },
      }),
    ).toBe(true);
    expect(storedReactions(store)).toEqual([
      { emoji: '👍', count: 1, me: false },
      { emoji: '🎉', count: 1, me: false },
    ]);
  });

  it('drops the chip when the member removes the only reaction on it', async () => {
    const store = storeWithMessage([{ emoji: '👍', count: 1, me: true }]);
    const stub = apiStub(() => OK);
    await toggleOwnReaction({
      store,
      api: stub.api,
      channelId: GENERAL,
      messageId: '800000000000000001',
      emoji: '👍',
    });
    // The wire keeps the key ABSENT when a message has none; the row hides.
    expect(storedReactions(store)).toBeUndefined();
    expect(reactionLine({ reactions: readReactions(storedRow(store)) })).toBeNull();

    // The server's own echo of that remove (the case the pending queue exists
    // for) is consumed without resurrecting the chip. Every own toggle in this
    // suite is followed by its echo, because that is the real contract the
    // queue is written against: its entry lives until the echo consumes it.
    expect(
      applyReactionEvent(store, {
        op: 0,
        t: 'MessageReactionRemove',
        s: 1,
        d: { channel_id: GENERAL, message_id: '800000000000000001', user_id: ME, emoji: '👍' },
      }),
    ).toBe(true);
    expect(storedReactions(store)).toBeUndefined();
  });

  it('reverts a rejected add, and releases the echo gate it had claimed', async () => {
    const store = storeWithMessage([
      { emoji: '🎉', count: 2, me: false },
      { emoji: '👍', count: 2, me: false },
    ]);
    const before = storedReactions(store);
    const stub = apiStub(() => ({
      status: 400,
      body: { error: { key: 'validation_failed', code: 40001, message: 'emoji must be 1-14 bytes' } },
    }));
    const outcome = await toggleOwnReaction({
      store,
      api: stub.api,
      channelId: GENERAL,
      messageId: '800000000000000001',
      emoji: '👍',
    });
    expect(outcome.applied).toBe(false);
    expect(outcome.op).toBe('add');
    // One inert line the pane can render, naming the cause.
    expect(outcome.error).toContain('Could not add your reaction');
    expect(outcome.error).toContain('emoji must be 1-14 bytes');
    expect(outcome.error).not.toMatch(/\u001b/);
    // The chip is back EXACTLY as it was: an existing others-only chip's count
    // is restored, not left bumped, and the member is not marked on it.
    expect(storedReactions(store)).toEqual(before);

    // The failed attempt left no pending entry behind, so a LATER own add is a
    // real add again rather than a swallowed echo.
    expect(
      applyReactionEvent(store, {
        op: 0,
        t: 'MessageReactionAdd',
        s: 5,
        d: { channel_id: GENERAL, message_id: '800000000000000001', user_id: ME, emoji: '👍' },
      }),
    ).toBe(true);
    expect(storedReactions(store)).toEqual([
      { emoji: '🎉', count: 2, me: false },
      { emoji: '👍', count: 3, me: true },
    ]);
  });

  it('restores the member’s own reaction when the remove fails, and reports the transport cause', async () => {
    const store = storeWithMessage([{ emoji: '👍', count: 1, me: true }]);
    const stub = apiStub(() => ({ status: 0, reject: 'fetch failed' }));
    const outcome = await toggleOwnReaction({
      store,
      api: stub.api,
      channelId: GENERAL,
      messageId: '800000000000000001',
      emoji: '👍',
    });
    expect(outcome).toEqual({
      applied: false,
      op: 'remove',
      error: '✖ Could not remove your reaction. (fetch failed)',
    });
    expect(storedReactions(store)).toEqual([{ emoji: '👍', count: 1, me: true }]);
  });

  it('reverts an add when the link is down, and the pane still draws what it had', async () => {
    const store = storeWithMessage([{ emoji: '🎉', count: 2, me: false }]);
    const stub = apiStub(() => ({ status: 0, reject: 'network unreachable' }));
    const outcome = await toggleOwnReaction({
      store,
      api: stub.api,
      channelId: GENERAL,
      messageId: '800000000000000001',
      emoji: '👍',
    });
    expect(outcome.applied).toBe(false);
    expect(outcome.error).toContain('Could not add your reaction');
    expect(outcome.error).toContain('network unreachable');
    // Offline is not a different reaction set: the message keeps exactly the
    // reactions it had, and they are still on screen.
    expect(storedReactions(store)).toEqual([{ emoji: '🎉', count: 2, me: false }]);
    expect(reactionLine({ reactions: readReactions(storedRow(store)) })).toBe('  🎉 2');
  });

  it('refuses to go to the wire at all when there is no session or no confirmed message', async () => {
    const signedOut = storeWithMessage([{ emoji: '🎉', count: 1, me: false }]);
    signedOut.setState({ currentUser: null });
    const stub = apiStub(() => OK);
    const first = await toggleOwnReaction({
      store: signedOut,
      api: stub.api,
      channelId: GENERAL,
      messageId: '800000000000000001',
      emoji: '🎉',
    });
    expect(first).toEqual({ applied: false, op: null, error: '✖ Sign in to react.' });
    expect(storedReactions(signedOut)).toEqual([{ emoji: '🎉', count: 1, me: false }]);

    // A placeholder row is the member's own send, not yet server truth: there
    // is no message id to react to yet.
    const pending = storeWithMessage([], 'pending_abc');
    const second = await toggleOwnReaction({
      store: pending,
      api: stub.api,
      channelId: GENERAL,
      messageId: 'pending_abc',
      emoji: '👍',
    });
    expect(second).toEqual({
      applied: false,
      op: null,
      error: '✖ This message has not been sent yet.',
    });
    // Nothing reached the api, and nothing was written to the store.
    expect(stub.calls).toEqual([]);
    expect(storedReactions(pending, 'pending_abc')).toBeUndefined();
  });
});

describe('folding the gateway’s reaction events', () => {
  it('applies another member’s add without marking the member', () => {
    const store = storeWithMessage([{ emoji: '👍', count: 2, me: false }]);
    expect(
      applyReactionEvent(store, {
        op: 0,
        t: 'MessageReactionAdd',
        s: 1,
        d: { channel_id: GENERAL, message_id: '800000000000000001', user_id: DANA, emoji: '👍' },
      }),
    ).toBe(true);
    expect(storedReactions(store)).toEqual([{ emoji: '👍', count: 3, me: false }]);

    // The other member's remove takes the count back down.
    expect(
      applyReactionEvent(store, {
        op: 0,
        t: 'MessageReactionRemove',
        s: 2,
        d: { channel_id: GENERAL, message_id: '800000000000000001', user_id: DANA, emoji: '👍' },
      }),
    ).toBe(true);
    expect(storedReactions(store)).toEqual([{ emoji: '👍', count: 2, me: false }]);
  });

  it('clears the whole chip row on a remove-all', () => {
    const store = storeWithMessage([
      { emoji: '👍', count: 2, me: false },
      { emoji: '🎉', count: 1, me: true },
    ]);
    expect(
      applyReactionEvent(store, {
        op: 0,
        t: 'MessageReactionRemoveAll',
        s: 1,
        d: { channel_id: GENERAL, message_id: '800000000000000001' },
      }),
    ).toBe(true);
    expect(storedReactions(store)).toBeUndefined();
    expect(reactionLine({ reactions: readReactions(storedRow(store)) })).toBeNull();
  });

  it('accepts every non-reaction frame and every replay as an unmoved no-op', () => {
    const store = storeWithMessage([{ emoji: '👍', count: 1, me: false }]);
    store.setState({ lastSeq: 7 });
    const before = store.getState();

    // A dispatch the member's own device already applied: its sequence is not
    // newer than the last applied one, so it is dropped — never double-counted.
    expect(
      applyReactionEvent(store, {
        op: 0,
        t: 'MessageReactionAdd',
        s: 7,
        d: { channel_id: GENERAL, message_id: '800000000000000001', user_id: DANA, emoji: '👍' },
      }),
    ).toBe(false);
    // A frame that is not a reaction at all is a pass-through.
    expect(applyReactionEvent(store, { op: 0, t: 'MessageCreate', s: 8, d: {} })).toBe(false);
    expect(applyReactionEvent(store, { op: 1, t: 'Hello', s: 8, d: {} })).toBe(false);
    expect(applyReactionEvent(store, null)).toBe(false);
    // Not one of them wrote anything: the store did not even notify.
    expect(store.getState()).toBe(before);
    expect(storedReactions(store)).toEqual([{ emoji: '👍', count: 1, me: false }]);
  });

  it('leaves the reaction set unchanged — and still renderable — on a malformed event', () => {
    const store = storeWithMessage([
      { emoji: '👍', count: 2, me: false },
      { emoji: '🎉', count: 1, me: true },
    ]);
    const before = store.getState();
    const malformed: unknown[] = [
      { op: 0, t: 'MessageReactionAdd', s: 9, d: null },
      { op: 0, t: 'MessageReactionAdd', s: 9, d: 'thumbs up' },
      { op: 0, t: 'MessageReactionAdd', s: 9, d: { channel_id: GENERAL, message_id: '800000000000000001', user_id: ME } },
      { op: 0, t: 'MessageReactionAdd', s: 9, d: { channel_id: GENERAL, message_id: '800000000000000001', user_id: ME, emoji: '' } },
      { op: 0, t: 'MessageReactionAdd', s: 9, d: { channel_id: GENERAL, message_id: '800000000000000001', user_id: 42, emoji: '👍' } },
      { op: 0, t: 'MessageReactionAdd', s: 9, d: { channel_id: 7, message_id: '800000000000000001', user_id: ME, emoji: '👍' } },
      { op: 0, t: 'MessageReactionRemoveAll', s: 9, d: { message_id: '800000000000000001' } },
      { op: 0, t: 'MessageReactionRemoveAll', s: 9, d: { channel_id: GENERAL } },
    ];
    for (const bad of malformed) {
      expect(applyReactionEvent(store, bad)).toBe(false);
    }
    // The SET — and the whole state — is the same object: not one write
    // happened, which is a stronger claim than "the values happen to match"…
    expect(store.getState()).toBe(before);
    // …and the pane can still draw every chip it had.
    const chips = readReactions(storedRow(store));
    expect(chips.map((chip) => [chip.emoji, chip.count, chip.me])).toEqual([
      ['👍', 2, false],
      ['🎉', 1, true],
    ]);
    expect(reactionLine({ reactions: chips })).toBe(`  👍 2  ${OWN_CHIP_OPEN}🎉 1${OWN_CHIP_CLOSE}`);
  });

  it('accepts an event for a message this pane does not hold, without inventing a row', () => {
    const store = storeWithMessage([{ emoji: '👍', count: 2, me: false }]);
    const slice = store.getState().messagesByChannel[GENERAL];
    expect(
      applyReactionEvent(store, {
        op: 0,
        t: 'MessageReactionAdd',
        s: 1,
        d: { channel_id: GENERAL, message_id: '800000000000000999', user_id: DANA, emoji: '👍' },
      }),
    ).toBe(true);
    expect(store.getState().messagesByChannel[GENERAL]).toBe(slice);
    // A channel with no slice at all is a no-op too: the fold never creates one.
    const empty = createStateStore();
    empty.setState(baseState());
    expect(
      applyReactionEvent(empty, {
        op: 0,
        t: 'MessageReactionRemoveAll',
        s: 1,
        d: { channel_id: GENERAL, message_id: '800000000000000001' },
      }),
    ).toBe(true);
    expect(empty.getState().messagesByChannel[GENERAL]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. The pane
// ---------------------------------------------------------------------------

describe('chips in column two', () => {
  it('draws the chip line under the message it belongs to', async () => {
    const store = storeWithMessage([
      { emoji: '👍', count: 3, me: false },
      { emoji: '❤️', count: 1, me: true },
      { emoji: '🫠', count: 2, me: false },
    ]);
    const instance = mount(store);
    await painted(instance, '👍 3');

    const lines = contentLines(instance);
    const body = lines.findIndex((line) => line.includes('hello there'));
    const chips = lines.findIndex((line) => line.includes('👍 3'));
    expect(body).toBeGreaterThan(0);
    // Beneath the message (the row's gutter is the line above its body).
    expect(chips).toBeGreaterThan(body);
    expect(lines[chips]).toContain('❤️ 1');
    expect(lines[chips]).toContain(':u1fae0: 2');
    // The member's own chip is bracketed — the non-colour channel — and the
    // frame carries no escape sequence at all (colour is off in this suite).
    expect(lines[chips]).toContain(`${OWN_CHIP_OPEN}❤️ 1${OWN_CHIP_CLOSE}`);
    expect(frame(instance)).not.toContain('\u001b');
  });

  it('adds nothing to a pane whose messages carry no reactions', async () => {
    const instance = mount(storeWithMessage(null));
    await painted(instance, 'hello there');
    const drawn = frame(instance);
    expect(drawn).toContain('hello there');
    // No chip row for any palette emoji, and no bracket that could be one.
    for (const emoji of REACTION_PALETTE) expect(drawn).not.toContain(emoji);
    expect(drawn).not.toContain('[👍');
    expect(drawn).not.toContain(':u1fae0:');
  });

  it('renders the chip line through the component, null when there is nothing to draw', async () => {
    const chips = readReactions({
      reactions: [{ emoji: '🎉', count: 4, me: true }],
    });
    const drawn = render(createElement(ReactionChips, { reactions: chips }));
    expect(drawn.lastFrame()).toContain(`${OWN_CHIP_OPEN}🎉 4${OWN_CHIP_CLOSE}`);
    cleanup();

    const empty = render(createElement(ReactionChips, { reactions: [] }));
    // Not a blank line: nothing at all, so the pane's row cost stays honest.
    expect((empty.lastFrame() ?? '').trim()).toBe('');
    cleanup();
  });

  it('writes into the SHARED slice the browser client reads, as one count', async () => {
    const store = storeWithMessage([]);
    const stub = apiStub(() => OK);
    const instance = mount(store);
    await painted(instance, 'hello there');
    await toggleOwnReaction({
      store,
      api: stub.api,
      channelId: GENERAL,
      messageId: '800000000000000001',
      emoji: '👍',
    });
    await painted(instance, '[👍 1]');

    // The browser client renders `messagesByChannel[channelId].items[].reactions`
    // (apps/web's MessageItem over the same `@cytale/state` store), so the value
    // this test reads is the one the browser would render — one array, in one
    // slice, with the count stated once and the member's `me` flag set.
    const rows = store.getState().messagesByChannel[GENERAL]?.items ?? [];
    expect(rows).toHaveLength(1);
    expect((rows[0] as WireMessage).reactions).toEqual([{ emoji: '👍', count: 1, me: true }]);
    expect((rows[0] as WireMessage).reactions?.filter((r) => r.me)).toHaveLength(1);

    // The server's echo of the member's own add: consumed, so the count the
    // browser renders is still one.
    applyReactionEvent(store, {
      op: 0,
      t: 'MessageReactionAdd',
      s: 1,
      d: { channel_id: GENERAL, message_id: '800000000000000001', user_id: ME, emoji: '👍' },
    });
    expect((store.getState().messagesByChannel[GENERAL]?.items[0] as WireMessage).reactions).toEqual(
      [{ emoji: '👍', count: 1, me: true }],
    );
  });

  it('reads the pane model from the store, so a fold is on screen without a reload', async () => {
    const store = storeWithMessage([{ emoji: '👍', count: 1, me: false }]);
    const view = buildContentView({
      source: store.getState(),
      conversationId: GENERAL,
      openThreadMessageId: null,
      width: SIZE.width,
    });
    expect(view.rows[0]?.reactions?.map((chip) => chip.label)).toEqual(['👍']);
    expect(view.rows[0]?.reactions?.[0]?.me).toBe(false);

    const instance = mount(store);
    await painted(instance, '👍 1');
    expect(frame(instance)).toContain('👍 1');
    expect(frame(instance)).not.toContain('[👍 1]');

    // A peer reacts: the store notification is the whole update path.
    applyReactionEvent(store, {
      op: 0,
      t: 'MessageReactionAdd',
      s: 1,
      d: { channel_id: GENERAL, message_id: '800000000000000001', user_id: ME, emoji: '👍' },
    });
    await painted(instance, '[👍 2]');
    const lines = contentLines(instance);
    expect(lines.some((line) => line.includes('[👍 2]'))).toBe(true);
  });
});
