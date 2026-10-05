/**
 * @cytale/tui — column two's message history and its pagination (U7; R19, R26a).
 *
 * Two halves, and both matter:
 *
 *   1. THE ROW MODEL as a pure table (`format/rows.ts`): the stated column
 *      budget, author grouping, and the width function that is `displayWidth`
 *      rather than `.length` — a terminal surface measures cells.
 *   2. THE PANE, driven by keyboard alone through `App`, against a real
 *      `createStateStore()` filled the way U12's hydration fills it. The loader
 *      is the host seam: these tests hand the shell one that folds a page into
 *      the SHARED store with `mergeChannelMessages`, exactly as U8's loader
 *      will, because that is what makes "the store is the data path" structural
 *      rather than a claim.
 *
 * The two scenarios the plan calls out as easy to fake are asserted the hard
 * way: the pagination test asserts the cursor's ANCHORED MESSAGE (not the array
 * length), and the channel switch asserts the resolved target ID (not a label).
 */
import { cleanup, render } from 'ink-testing-library';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Channel, Message, Workspace, WorkspaceMember } from '@cytale/domain';
import {
  createStateStore,
  mergeChannelMessages,
  type StateStore,
  type StateState,
} from '@cytale/state';

import { App } from '../app.js';
import { buildContentView, type ContentTarget } from '../columns/ContentColumn.js';
import { visibleWindow } from '../columns/MessageList.js';
import { MIN_CONTENT_WIDTH, layoutFor } from '../columns/layout.js';
import {
  authorBudgetFor,
  bodyBudgetFor,
  clampToWidth,
  rowCost,
  timeLabel,
  type HistoryRequest,
  type MessageRow,
  type MessageSource,
} from '../format/rows.js';

// ---------------------------------------------------------------------------
// Fixtures — a store filled the way hydration fills it
// ---------------------------------------------------------------------------

const ORIGIN = 'https://chat.example.com';
const WORKSPACE = '100000000000000001';
const GENERAL = '300000000000000001';
const RANDOM = '300000000000000002';
const ME = '900000000000000001';
const DANA = '900000000000000002';
const ERIN = '900000000000000003';

const SIZE = { width: 100, height: 30 } as const;
/**
 * A pane whose line budget fits two rows and no more, so the window has to
 * follow the cursor when a page lands under it.
 */
const SHORT = { width: 100, height: 10 } as const;

/**
 * The label a row shows for a timestamp, as the pane computes it (`HH:MM` in
 * the MEMBER's timezone, so it depends on the machine running the suite — the
 * assertions below compare against the same function rather than a literal).
 */
const at = (iso: string): string => timeLabel(iso);

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

function message(
  overrides: Partial<Message> & Pick<Message, 'id' | 'author_id' | 'content' | 'created_at'>,
): Message {
  return { channel_id: GENERAL, thread_id: null, edited_at: null, ...overrides };
}

function member(id: string, username: string): WorkspaceMember {
  return { id, username, nickname: null, joined_at: '', roles: [] };
}

/** The newest page of `#general`: three messages, one author run, incomplete. */
function newestPage(): Message[] {
  return [
    message({
      id: '800000000000000006',
      author_id: DANA,
      content: 'sixth line',
      created_at: '2026-09-13T12:03:00.000Z',
    }),
    message({
      id: '800000000000000005',
      author_id: DANA,
      content: 'fifth line',
      created_at: '2026-09-13T12:02:00.000Z',
    }),
    message({
      id: '800000000000000004',
      author_id: DANA,
      content: 'fourth line',
      created_at: '2026-09-13T12:01:00.000Z',
    }),
  ];
}

/** The page OLDER than {@link newestPage}, as a real `before=` read returns it. */
function olderPage(): Message[] {
  return [
    message({
      id: '800000000000000003',
      author_id: DANA,
      content: 'third line',
      created_at: '2026-09-13T11:03:00.000Z',
    }),
    message({
      id: '800000000000000002',
      author_id: DANA,
      content: 'second line',
      created_at: '2026-09-13T11:02:00.000Z',
    }),
    message({
      id: '800000000000000001',
      author_id: ERIN,
      content: 'first line',
      created_at: '2026-09-13T11:01:00.000Z',
    }),
  ];
}

/**
 * The store U12 hands the shell: one workspace, `#general` with a message page,
 * and `#random` with NO slice (a channel whose history still has to be fetched
 * — the switch test's subject).
 */
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
    channels: {
      [GENERAL]: channel({ id: GENERAL, name: 'general', position: 0 }),
      [RANDOM]: channel({ id: RANDOM, name: 'random', position: 1 }),
    },
    membersById: {
      [ME]: member(ME, 'tester'),
      [DANA]: member(DANA, 'dana'),
      [ERIN]: member(ERIN, 'erin'),
    },
    memberIdsByWorkspace: { [WORKSPACE]: [ME, DANA, ERIN] },
    messagesByChannel: {
      [GENERAL]: { items: newestPage(), oldestId: '800000000000000004', hasCompleteHistory: false },
    },
    ...overrides,
  };
}

function storeWith(state: Partial<StateState> = baseState()): StateStore {
  const store = createStateStore();
  store.setState(state);
  return store;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Options {
  readonly store?: StateStore;
  readonly width?: number;
  readonly height?: number;
  readonly phase?: 'connecting' | 'online' | 'offline' | 'expired' | 'failed' | 'signed_out';
  readonly onLoadHistory?: (request: HistoryRequest) => Promise<void>;
  readonly onSendTo?: (target: ContentTarget, text: string) => void;
}

function mount(options: Options = {}) {
  return render(
    createElement(App, {
      view:
        options.phase === undefined || options.phase === 'online'
          ? { phase: 'online', headline: `Connected to ${ORIGIN}` }
          : { phase: options.phase, headline: `Phase ${options.phase}` },
      mode: 'ssh',
      origin: ORIGIN,
      store: options.store ?? storeWith(),
      width: options.width ?? SIZE.width,
      height: options.height ?? SIZE.height,
      ...(options.onLoadHistory === undefined ? {} : { onLoadHistory: options.onLoadHistory }),
      ...(options.onSendTo === undefined ? {} : { onSendTo: options.onSendTo }),
    }),
  );
}

type Instance = ReturnType<typeof mount>;

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

async function press(instance: Instance, input: string): Promise<void> {
  instance.stdin.write(input);
  await tick();
}

const KEYS = {
  tab: '\t',
  enter: '\r',
  escape: '\u001b',
} as const;

const frame = (instance: Instance): string => instance.lastFrame() ?? '';

/** The banner's first line is the headline; the two columns start below it. */
const COLUMNS_TOP = 2;

/** Column two, sliced out of the side-by-side frame by U6's own geometry. */
function contentLines(
  instance: Instance,
  size: { width: number; height: number } = SIZE,
): string[] {
  const layout = layoutFor(size);
  if (layout.kind !== 'two-column') return [];
  return frame(instance)
    .split('\n')
    .slice(COLUMNS_TOP)
    .map((line) => line.slice(layout.navigationWidth + 1).trimEnd())
    .filter((line) => line.trim() !== '');
}

/** A row is its gutter line (marker, author, time) followed by its body lines. */
function gutterFor(
  instance: Instance,
  body: string,
  size: { width: number; height: number } = SIZE,
): string {
  const all = contentLines(instance, size);
  const at = all.findIndex((line) => line.includes(body));
  return at > 0 ? (all[at - 1] ?? '') : '';
}

/** Every drawn body line, so "no duplication" can be counted. */
const bodyLines = (instance: Instance, size = SIZE): string[] => contentLines(instance, size);

/** The pane's text with its wraps joined, for a line that wraps inside it. */
const paneText = (instance: Instance, size: { width: number; height: number } = SIZE): string =>
  contentLines(instance, size).join(' ');

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// The row model: the budget, grouping, and cell-accurate widths
// ---------------------------------------------------------------------------

describe('the column budget', () => {
  it('reserves the gutter, the time column, and the gap, at the minimum pane width', () => {
    // The stated budget: a 24-cell pane is 2 gutter + 16 author + 1 gap + 5 time.
    expect(authorBudgetFor(MIN_CONTENT_WIDTH)).toBe(16);
    expect(bodyBudgetFor(MIN_CONTENT_WIDTH)).toBe(22);
    // A degenerate width still leaves a cell to draw in, never a negative budget.
    expect(authorBudgetFor(1)).toBe(1);
    expect(bodyBudgetFor(0)).toBe(1);
  });

  it('measures in terminal cells, not code units', () => {
    // Four wide CJK glyphs are eight cells: a `.length` cut would overflow.
    expect(clampToWidth('日本語のテキスト', 4)).toBe('日本');
    expect(clampToWidth('日本語のテキスト', 100)).toBe('日本語のテキスト');
    // A wide glyph that does not fit is not half-printed.
    expect(clampToWidth('日', 1)).toBe('');
    expect(clampToWidth('abc', 0)).toBe('');
  });

  it('costs a row by its gutter, its wrapped body, and its thread indicator', () => {
    expect(rowCost({ lines: ['a', 'b'], replies: 0 })).toBe(3);
    expect(rowCost({ lines: ['a'], replies: 3 })).toBe(3);
    expect(rowCost({ lines: [], replies: 0 })).toBe(1);
  });

  it('draws the rows the budget fits, and follows the cursor to reach it', () => {
    const row = (id: string): MessageRow => ({
      id,
      authorId: '900000000000000002',
      author: 'dana',
      time: '12:00',
      lines: ['body'],
      groupStart: true,
      replies: 0,
    });
    const rows = ['a', 'b', 'c', 'd'].map(row);
    // Four two-line rows in a five-line budget: two fit.
    expect(visibleWindow(rows, 0, 0, 5)).toEqual({ start: 0, count: 2 });
    // The cursor is on the last row: the window advances until it is drawn,
    // which is what keeps a page prepended ABOVE the member's message from
    // pushing that message off the pane.
    expect(visibleWindow(rows, 0, 3, 5)).toEqual({ start: 2, count: 2 });
    // Scrolled back with the cursor above the scroll position: show the cursor.
    expect(visibleWindow(rows, 3, 1, 5)).toEqual({ start: 1, count: 2 });
    // An empty pane has no window to place.
    expect(visibleWindow([], 4, 9, 5)).toEqual({ start: 0, count: 0 });
  });
});

describe('the row projection', () => {
  const source: MessageSource = {
    channels: { [GENERAL]: channel({ id: GENERAL, name: 'general' }) },
    membersById: { [DANA]: member(DANA, 'dana') },
    currentUser: { id: ME, username: 'tester' },
  };

  it('reads oldest-first and groups a consecutive author run under one header', () => {
    const view = buildContentView({
      source: { ...source, messagesByChannel: { [GENERAL]: { items: newestPage(), oldestId: null, hasCompleteHistory: false } } },
      conversationId: GENERAL,
      openThreadMessageId: null,
      width: MIN_CONTENT_WIDTH,
    });
    // Newest-last: the oldest message is the first row (R19).
    expect(view.rows.map((row) => row.id)).toEqual([
      '800000000000000004',
      '800000000000000005',
      '800000000000000006',
    ]);
    // One author run: the first row opens the group, the rest continue it.
    expect(view.rows.map((row) => row.groupStart)).toEqual([true, false, false]);
    expect(view.rows[0]?.author).toBe('dana');
    expect(view.rows[0]?.time).toBe(at('2026-09-13T12:01:00.000Z'));
    expect(view.rows[0]?.time).toMatch(/^\d{2}:\d{2}$/);
  });

  it('opens a new group when the day changes, even for one author', () => {
    const view = buildContentView({
      source: {
        ...source,
        messagesByChannel: {
          [GENERAL]: {
            items: [
              message({
                id: '800000000000000006',
                author_id: DANA,
                content: 'today',
                created_at: '2026-09-13T09:00:00.000Z',
              }),
              message({
                id: '800000000000000001',
                author_id: DANA,
                content: 'yesterday',
                created_at: '2026-09-12T22:00:00.000Z',
              }),
            ],
            oldestId: null,
            hasCompleteHistory: true,
          },
        },
      },
      conversationId: GENERAL,
      openThreadMessageId: null,
      width: MIN_CONTENT_WIDTH,
    });
    // Same author, different calendar day: the author and time are re-stated
    // (web's rule, held here so the two clients agree).
    expect(view.rows.map((row) => row.groupStart)).toEqual([true, true]);
  });
});

// ---------------------------------------------------------------------------
// R19: history, grouping, and the pending/start markers
// ---------------------------------------------------------------------------

describe('message history in column two', () => {
  it('renders oldest-to-newest, groups one author run, and aligns the time column', async () => {
    const instance = mount({
      store: storeWith(
        baseState({
          messagesByChannel: {
            [GENERAL]: {
              items: [
                ...newestPage(),
                message({
                  id: '800000000000000003',
                  author_id: ERIN,
                  content: 'third line',
                  created_at: '2026-09-13T11:59:00.000Z',
                }),
              ],
              oldestId: '800000000000000003',
              hasCompleteHistory: true,
            },
          },
        }),
      ),
    });
    await tick();
    const lines = bodyLines(instance);
    const order = ['third line', 'fourth line', 'fifth line', 'sixth line'].map((body) =>
      lines.findIndex((line) => line.includes(body)),
    );
    // Every body is present, and in newest-last order.
    expect(order.every((index) => index > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));

    // The three-message run renders ONE author header; continuations keep the
    // glyph instead of repeating the name.
    expect(lines.filter((line) => line.includes('dana'))).toHaveLength(1);
    expect(gutterFor(instance, 'fourth line')).toContain('dana');
    expect(gutterFor(instance, 'fourth line')).toContain(at('2026-09-13T12:01:00.000Z'));
    expect(gutterFor(instance, 'fifth line')).toContain('↳');
    expect(gutterFor(instance, 'fifth line')).toContain(at('2026-09-13T12:02:00.000Z'));
    expect(gutterFor(instance, 'sixth line')).toContain('↳');

    // The time column is a fixed offset, so authors of different name widths do
    // not shift the timestamps out of alignment.
    const erinGutter = gutterFor(instance, 'third line');
    expect(erinGutter).toContain('erin');
    const erinTime = at('2026-09-13T11:59:00.000Z');
    expect(erinGutter.indexOf(erinTime)).toBe(
      gutterFor(instance, 'fourth line').indexOf(at('2026-09-13T12:01:00.000Z')),
    );
    expect(erinGutter.indexOf(erinTime)).toBeGreaterThan(0);
  });

  it('marks the beginning of history once the oldest page is loaded', async () => {
    const store = storeWith(
      baseState({
        messagesByChannel: {
          [GENERAL]: { items: newestPage(), oldestId: null, hasCompleteHistory: true },
        },
      }),
    );
    const instance = mount({ store });
    await tick();
    expect(frame(instance)).toContain('beginning of history');
    // The start of history is NOT the pending state: they read differently.
    expect(frame(instance)).not.toContain('loading earlier messages');
  });

  it('shows a pending marker while a page is in flight, so a slow load is not the start', async () => {
    const gate: { release: (() => void) | null } = { release: null };
    const onLoadHistory = vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        }),
    );
    const instance = mount({ store: storeWith(), onLoadHistory });
    await tick();
    await press(instance, KEYS.tab);
    await press(instance, 'k');
    await press(instance, 'k');
    await tick();
    expect(frame(instance)).toContain('loading earlier messages');
    expect(frame(instance)).not.toContain('beginning of history');

    gate.release?.();
    await tick();
    expect(frame(instance)).not.toContain('loading earlier messages');
  });

  it('names the target while its history loads, and sends to the new channel', async () => {
    const onSendTo = vi.fn();
    // `#random` has no slice: selecting it starts a load that never settles here.
    const onLoadHistory = vi.fn(async () => await new Promise<void>(() => undefined));
    const instance = mount({ store: storeWith(), onLoadHistory, onSendTo });
    await tick();
    expect(frame(instance)).toContain('fourth line');

    await press(instance, 'j');
    await tick();
    // The pane names the NEW target while it loads, and the old channel's rows
    // are gone — a message typed now cannot be misattributed.
    expect(frame(instance)).toContain('#random');
    expect(frame(instance)).toMatch(/Loading #random|loading earlier messages/);
    expect(frame(instance)).not.toContain('fourth line');
    expect(onLoadHistory).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'channel', channelId: RANDOM, before: null }),
    );

    await press(instance, 'i');
    await press(instance, 'h');
    await press(instance, 'i');
    await press(instance, KEYS.enter);
    await tick();
    // The destination is asserted as an ID, not as the `#random` label.
    expect(onSendTo).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'channel', channelId: RANDOM, threadId: null }),
      'hi',
    );
  });
});

// ---------------------------------------------------------------------------
// R19: pagination
// ---------------------------------------------------------------------------

describe('loading earlier history', () => {
  it('prepends the previous page without moving the cursor off its message', async () => {
    const store = storeWith();
    const onLoadHistory = vi.fn(async () => {
      mergeChannelMessages(store, GENERAL, olderPage(), { isLastPage: false });
    });
    const instance = mount({ store, onLoadHistory });
    await tick();
    await press(instance, KEYS.tab);
    // Two moves reach the oldest loaded row, and REACHING it is the trigger.
    await press(instance, 'k');
    await press(instance, 'k');
    await tick();

    expect(onLoadHistory).toHaveBeenCalledTimes(1);
    // The store's own cursor is what was paged from (R19's `before=`).
    expect(onLoadHistory).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: GENERAL, before: '800000000000000004' }),
    );
    // The page landed in the shared store, oldest-first and deduped…
    expect(store.getState().messagesByChannel[GENERAL]?.items).toHaveLength(6);
    // …and the cursor is still anchored on the SAME message…
    expect(gutterFor(instance, 'fourth line')).toContain('▸');
    expect(gutterFor(instance, 'sixth line')).not.toContain('▸');
    // …with nothing duplicated or lost on the page.
    const drawn = bodyLines(instance);
    for (const body of ['first', 'second', 'third', 'fourth', 'fifth', 'sixth']) {
      expect(drawn.filter((line) => line.includes(`${body} line`))).toHaveLength(1);
    }
  });

  it('keeps the anchored message at the same visible position when the pane overflows', async () => {
    const store = storeWith();
    const onLoadHistory = vi.fn(async () => {
      mergeChannelMessages(store, GENERAL, olderPage(), { isLastPage: false });
    });
    const instance = mount({ store, onLoadHistory, height: SHORT.height });
    await tick();
    await press(instance, KEYS.tab);
    await press(instance, 'k');
    await press(instance, 'k');
    await tick();

    // The pane is too short to hold the whole history, so the anchored row can
    // only still be on screen because the window followed the cursor to it.
    const pane = contentLines(instance, SHORT);
    expect(gutterFor(instance, 'fourth line', SHORT)).toContain('▸');
    expect(pane.some((line) => line.includes('fourth line'))).toBe(true);
    expect(gutterFor(instance, 'first line', SHORT)).not.toContain('▸');
  });

  it('stops cleanly at the beginning: an empty page changes nothing and no loop follows', async () => {
    const store = storeWith();
    const onLoadHistory = vi.fn(async () => {
      // A real loader marks the slice complete when the page comes back short.
      mergeChannelMessages(store, GENERAL, [], { isLastPage: true });
    });
    const instance = mount({ store, onLoadHistory });
    await tick();
    await press(instance, KEYS.tab);
    await press(instance, 'k');
    await press(instance, 'k');
    await tick();
    expect(onLoadHistory).toHaveBeenCalledTimes(1);
    // The rows and the cursor are exactly as they were.
    expect(store.getState().messagesByChannel[GENERAL]?.items).toHaveLength(3);
    expect(gutterFor(instance, 'fourth line')).toContain('▸');
    // Asking again cannot re-fire: the page proved there is no older history.
    await press(instance, 'k');
    await press(instance, 'k');
    await tick();
    expect(onLoadHistory).toHaveBeenCalledTimes(1);
    expect(frame(instance)).toContain('beginning of history');
  });

  it('renders an inline error with a retry affordance, and the retry works', async () => {
    const store = storeWith();
    let attempt = 0;
    const onLoadHistory = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('history endpoint unreachable');
      mergeChannelMessages(store, GENERAL, olderPage(), { isLastPage: true });
    });
    const instance = mount({ store, onLoadHistory });
    await tick();
    await press(instance, KEYS.tab);
    await press(instance, 'k');
    await press(instance, 'k');
    await tick();
    // The pane is 66 cells wide, so the line wraps: read it joined. The error
    // REPLACES the loading notice — two answers to one question is how a state
    // starts reading as a different state.
    expect(paneText(instance)).not.toContain('Loading #general');
    expect(paneText(instance)).toContain('Could not load earlier messages');
    expect(paneText(instance)).toContain('history endpoint unreachable');
    expect(paneText(instance)).toContain('Press k to try again');
    // The rows the member already had are untouched by the failure.
    expect(frame(instance)).toContain('fourth line');

    // The affordance: `k` at the top asks again.
    await press(instance, 'k');
    await tick();
    expect(onLoadHistory).toHaveBeenCalledTimes(2);
    expect(frame(instance)).toContain('first line');
    expect(frame(instance)).not.toContain('Could not load earlier messages');
  });

  it('renders the transport cause inertly (R26a)', async () => {
    const onLoadHistory = vi.fn(async () => {
      throw new Error('bad gateway \u001b[2J\u001b[31m whoops');
    });
    const instance = mount({ store: storeWith(), onLoadHistory });
    await tick();
    await press(instance, KEYS.tab);
    await press(instance, 'k');
    await press(instance, 'k');
    await tick();
    const drawn = frame(instance);
    expect(drawn).not.toContain('\u001b[2J');
    expect(drawn).not.toContain('\u001b[31m');
    expect(drawn).toContain('bad gateway');
    expect(drawn).toContain('whoops');
  });

  it('keeps the history on screen while the gateway is offline', async () => {
    const onLoadHistory = vi.fn(async () => {
      throw new Error('network unreachable');
    });
    const instance = mount({ store: storeWith(), onLoadHistory, phase: 'offline' });
    await tick();
    expect(frame(instance)).toContain('Phase offline');
    expect(frame(instance)).toContain('fourth line');
    // A failed page is reported, never a blanked pane.
    await press(instance, KEYS.tab);
    await press(instance, 'k');
    await press(instance, 'k');
    await tick();
    expect(paneText(instance)).toContain('Could not load earlier messages');
    expect(frame(instance)).toContain('fifth line');
  });

  it('loads a channel with nothing in the store once, then names it empty', async () => {
    const store = storeWith(
      baseState({
        channels: {
          [GENERAL]: channel({ id: GENERAL, name: 'general' }),
          [RANDOM]: channel({ id: RANDOM, name: 'random', position: 1 }),
        },
        messagesByChannel: {},
      }),
    );
    const onLoadHistory = vi.fn(async () => {
      mergeChannelMessages(store, GENERAL, [], { isLastPage: true });
    });
    const instance = mount({ store, onLoadHistory });
    await tick();
    expect(onLoadHistory).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'channel', channelId: GENERAL, before: null }),
    );
    expect(onLoadHistory).toHaveBeenCalledTimes(1);
    await tick();
    expect(frame(instance)).toContain('No messages in #general yet.');
  });
});
