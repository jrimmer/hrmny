/**
 * @cytale/tui — the two-column shell, driven by keyboard alone against a store
 * snapshot (U6; R15, R16, R17, R25, R26a, R28).
 *
 * The store is the ONLY data path in these tests, exactly as it is in the
 * client: `createStateStore()` is filled here the way U12's hydration fills it
 * on a real boot, and nothing in the shell reaches a loader. That is what makes
 * the integration scenario ("selecting a channel in column one drives column
 * two through the shared store") a structural fact rather than a claim — the
 * last test mutates the store and expects the shell to follow.
 *
 * Rows are asserted through Ink's own frames (`ink-testing-library`), because
 * every scenario in this unit is about what reaches the terminal: the grouped
 * column one, the space beside the id, the inert rendering of a name carrying
 * an escape sequence, and the sub-minimum notice.
 */
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Channel, Message, Thread, Workspace, WorkspaceMember } from '@cytale/domain';
import { createStateStore, type StateStore, type StateState } from '@cytale/state';
import { cleanup } from 'ink-testing-library';

import { App, type NavigationStatus } from '../app.js';
import { MIN_TWO_COLUMN_WIDTH, layoutFor } from '../columns/layout.js';
import { PRESENCE_STALE_GLYPH } from '../columns/Presence.js';
import {
  KEY_MAP,
  NO_EFFECTS,
  initialShellState,
  keystrokeOf,
  messageCursorFor,
  reduceShell,
  resolveAction,
  viewportFor,
  type ShellBounds,
} from '../keys.js';

// ---------------------------------------------------------------------------
// Fixtures — a store filled the way hydration fills it
// ---------------------------------------------------------------------------

const ORIGIN = 'https://chat.example.com';

function channel(overrides: Partial<Channel> & Pick<Channel, 'id' | 'name'>): Channel {
  return {
    workspace_id: null,
    type: 'text',
    topic: null,
    position: 0,
    last_message_id: null,
    created_at: '2026-09-13T10:00:00.000Z',
    ...overrides,
  };
}

function workspace(overrides: Partial<Workspace> & Pick<Workspace, 'id' | 'name'>): Workspace {
  return {
    owner_id: '1',
    role_version: 1,
    created_at: '2026-09-13T09:00:00.000Z',
    ...overrides,
  };
}

function member(overrides: Partial<WorkspaceMember> & Pick<WorkspaceMember, 'id' | 'username'>): WorkspaceMember {
  return {
    nickname: null,
    joined_at: '2026-09-13T09:00:00.000Z',
    roles: [],
    ...overrides,
  };
}

function message(overrides: Partial<Message> & Pick<Message, 'id' | 'channel_id' | 'author_id' | 'content'>): Message {
  return {
    thread_id: null,
    created_at: '2026-09-13T12:00:00.000Z',
    edited_at: null,
    ...overrides,
  };
}

function thread(overrides: Partial<Thread> & Pick<Thread, 'id' | 'channel_id' | 'name'>): Thread {
  return {
    parent_message_id: null,
    created_by: '1',
    archived: false,
    created_at: '2026-09-13T12:00:00.000Z',
    ...overrides,
  };
}

/**
 * Two workspaces, categories, DM conversations, members with presence, and a
 * thread — the graph U12 hands the shell. Ids are equal-length decimal strings
 * so snowflake ordering is meaningful.
 */
function baseState(): Partial<StateState> {
  return {
    currentUser: { id: '900000000000000001', username: 'tester' },
    workspaces: {
      '100000000000000001': workspace({ id: '100000000000000001', name: 'Acme' }),
      '100000000000000002': workspace({ id: '100000000000000002', name: 'Beta' }),
    },
    channels: {
      '300000000000000001': channel({
        id: '300000000000000001',
        workspace_id: '100000000000000001',
        name: 'general',
        position: 0,
      }),
      '300000000000000002': channel({
        id: '300000000000000002',
        workspace_id: '100000000000000001',
        name: 'random',
        position: 1,
        parent_id: '300000000000000009',
      }),
      '300000000000000009': channel({
        id: '300000000000000009',
        workspace_id: '100000000000000001',
        name: 'Text channels',
        type: 'category',
        position: 2,
      }),
      '300000000000000010': channel({
        id: '300000000000000010',
        workspace_id: '100000000000000002',
        name: 'beta-general',
        position: 0,
      }),
      '400000000000000001': channel({
        id: '400000000000000001',
        name: 'dana',
        type: 'dm',
        recipients: [{ id: '900000000000000002', username: 'dana' }],
        last_message_id: '800000000000000002',
      }),
      '400000000000000002': channel({
        id: '400000000000000002',
        name: 'erin',
        type: 'dm',
        recipients: [{ id: '900000000000000003', username: 'erin' }],
        last_message_id: '800000000000000004',
      }),
    },
    membersById: {
      '900000000000000001': member({ id: '900000000000000001', username: 'tester' }),
      '900000000000000002': member({ id: '900000000000000002', username: 'dana' }),
      '900000000000000003': member({ id: '900000000000000003', username: 'erin' }),
    },
    memberIdsByWorkspace: {
      // erin is in both workspaces: presence is a property of the member, not
      // of the workspace they are being listed in.
      '100000000000000001': [
        '900000000000000001',
        '900000000000000002',
        '900000000000000003',
      ],
      '100000000000000002': ['900000000000000001', '900000000000000003'],
    },
    presenceByUser: {
      '900000000000000001': { status: 'online', last_seen_at: '2026-09-13T12:00:00.000Z' },
      '900000000000000002': { status: 'online', last_seen_at: '2026-09-13T12:00:00.000Z' },
      '900000000000000003': { status: 'offline', last_seen_at: '2026-09-13T11:00:00.000Z' },
    },
    messagesByChannel: {
      '300000000000000001': {
        items: [
          message({
            id: '800000000000000009',
            channel_id: '300000000000000001',
            author_id: '900000000000000002',
            content: 'newest line',
          }),
          message({
            id: '800000000000000001',
            channel_id: '300000000000000001',
            author_id: '900000000000000002',
            content: 'oldest line',
          }),
        ],
        oldestId: '800000000000000001',
        hasCompleteHistory: true,
      },
      '300000000000000010': {
        items: [
          message({
            id: '800000000000000020',
            channel_id: '300000000000000010',
            author_id: '900000000000000003',
            content: 'beta line',
          }),
        ],
        oldestId: '800000000000000020',
        hasCompleteHistory: true,
      },
      '400000000000000001': {
        items: [
          message({
            id: '800000000000000002',
            channel_id: '400000000000000001',
            author_id: '900000000000000002',
            content: 'dm line',
          }),
        ],
        oldestId: '800000000000000002',
        hasCompleteHistory: true,
      },
    },
    threadsById: {
      '500000000000000001': thread({
        id: '500000000000000001',
        channel_id: '300000000000000001',
        name: 'a thread',
        parent_message_id: '800000000000000009',
      }),
    },
    threadIdsByChannel: { '300000000000000001': ['500000000000000001'] },
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

interface ShellOptions {
  readonly store?: StateStore;
  readonly width?: number;
  readonly height?: number;
  readonly phase?: 'connecting' | 'online' | 'offline' | 'expired' | 'failed' | 'signed_out';
  readonly navigation?: NavigationStatus;
  readonly onQuit?: () => void;
  readonly onSearch?: () => void;
  readonly onMarkRead?: (channelId: string) => void;
  readonly onMarkUnread?: (messageId: string, conversationId: string) => void;
  readonly onSend?: (text: string) => void;
}

function mount(options: ShellOptions = {}) {
  return render(
    createElement(App, {
      view:
        options.phase === undefined || options.phase === 'online'
          ? { phase: 'online', headline: `Connected to ${ORIGIN}` }
          : { phase: options.phase, headline: `Phase ${options.phase}` },
      mode: 'ssh',
      origin: ORIGIN,
      store: options.store ?? storeWith(),
      width: options.width ?? 100,
      height: options.height ?? 30,
      ...(options.navigation === undefined ? {} : { navigation: options.navigation }),
      ...(options.onQuit === undefined ? {} : { onQuit: options.onQuit }),
      ...(options.onSearch === undefined ? {} : { onSearch: options.onSearch }),
      ...(options.onMarkRead === undefined ? {} : { onMarkRead: options.onMarkRead }),
      ...(options.onMarkUnread === undefined ? {} : { onMarkUnread: options.onMarkUnread }),
      ...(options.onSend === undefined ? {} : { onSend: options.onSend }),
    }),
  );
}

type Instance = ReturnType<typeof mount>;

/**
 * Ink folds input on the next tick, and it holds a lone Escape for ~20ms while
 * it decides whether more of an escape sequence is coming — so the frame is
 * read after both.
 */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

async function press(instance: Instance, input: string): Promise<void> {
  instance.stdin.write(input);
  await tick();
}

/** The escape sequence a terminal sends for an arrow / page / tab key. */
const KEYS = {
  down: '\u001b[B',
  up: '\u001b[A',
  pageUp: '\u001b[5~',
  pageDown: '\u001b[6~',
  tab: '\t',
  shiftTab: '\u001b[Z',
  enter: '\r',
  escape: '\u001b',
  ctrlC: '\u0003',
  backspace: '\u007f',
} as const;

const frame = (instance: Instance): string => instance.lastFrame() ?? '';
const lines = (instance: Instance): string[] => frame(instance).split('\n');

/** The size `mount` defaults to; a test that resizes passes its own. */
const SIZE = { width: 100, height: 30 } as const;
/** The banner occupies the frame's first two lines (headline + footer). */
const COLUMNS_TOP = 2;

/**
 * The two columns, sliced out of the side-by-side frame by the layout's own
 * geometry: column one is exactly `navigationWidth` cells, then the one-cell
 * rule, then column two. `null` under the sub-minimum policy, where there is
 * only one column to read.
 */
function sliceColumns(
  instance: Instance,
  size: { width: number; height: number } = SIZE,
): { navigation: string[]; content: string[] } | null {
  const layout = layoutFor(size);
  if (layout.kind !== 'two-column') return null;
  const region = lines(instance).slice(COLUMNS_TOP).map((line) => line.trimEnd());
  return {
    navigation: region.map((line) => line.slice(0, layout.navigationWidth).trimEnd()),
    content: region.map((line) => line.slice(layout.navigationWidth + 1).trimEnd()),
  };
}

const navLines = (instance: Instance, size: { width: number; height: number } = SIZE): string[] =>
  (sliceColumns(instance, size)?.navigation ?? []).filter((line) => line.trim() !== '');
const contentLines = (instance: Instance, size: { width: number; height: number } = SIZE): string[] =>
  (sliceColumns(instance, size)?.content ?? []).filter((line) => line.trim() !== '');

/** A single rendered line holding both, which proves a side-by-side split. */
const joinedLine = (instance: Instance, a: string, b: string): boolean =>
  lines(instance).some((line) => line.includes(a) && line.includes(b));
/** Focus markers are the only thing a focus move changes. */
const stripMarkers = (text: string): string => text.replaceAll('▸', '').replaceAll('·', '');
/**
 * A message row is its header line (marker, author, time) followed by the body
 * lines, so the row owning `body` is the line above it.
 */
const rowHeaderFor = (
  instance: Instance,
  body: string,
  size: { width: number; height: number } = SIZE,
): string => {
  const all = contentLines(instance, size);
  const at = all.findIndex((line) => line.includes(body));
  return at > 0 ? (all[at - 1] ?? '') : '';
};

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// R15/R16: the two-column split and Channels mode
// ---------------------------------------------------------------------------

describe('the two-column shell', () => {
  it('renders both columns side by side, with the connection banner above them', async () => {
    const instance = mount();
    await tick();
    expect(frame(instance)).toContain(`Connected to ${ORIGIN}`);
    // Both columns on ONE line: the split is horizontal, not stacked.
    expect(joinedLine(instance, 'Channels mode', 'general')).toBe(true);
    expect(frame(instance)).toContain('oldest line');
  });

  it('renders the sub-minimum policy one column below the minimum', async () => {
    const instance = mount({ width: MIN_TWO_COLUMN_WIDTH - 1 });
    await tick();
    expect(frame(instance)).toContain(String(MIN_TWO_COLUMN_WIDTH));
    expect(frame(instance)).toContain('Tab');
    // The clamped two-column split is NOT rendered: no second column border
    // and no side-by-side line.
    expect(joinedLine(instance, 'Channels mode', 'general')).toBe(false);
    expect(frame(instance)).toContain('general');
  });

  it('survives resizing, in and out of the sub-minimum policy', async () => {
    const instance = mount();
    await tick();
    instance.rerender(
      createElement(App, {
        view: { phase: 'online', headline: `Connected to ${ORIGIN}` },
        mode: 'ssh',
        origin: ORIGIN,
        store: storeWith(),
        width: MIN_TWO_COLUMN_WIDTH - 1,
        height: 30,
      }),
    );
    await tick();
    expect(joinedLine(instance, 'Channels mode', 'general')).toBe(false);
    instance.rerender(
      createElement(App, {
        view: { phase: 'online', headline: `Connected to ${ORIGIN}` },
        mode: 'ssh',
        origin: ORIGIN,
        store: storeWith(),
        width: 100,
        height: 30,
      }),
    );
    await tick();
    expect(joinedLine(instance, 'Channels mode', 'general')).toBe(true);
  });

  it('groups the active workspace channels by category, parentless first and unlabelled', async () => {
    const instance = mount();
    await tick();
    const nav = navLines(instance);
    expect(nav[0]).toContain('Channels mode');
    // Parentless channel first, immediately (no header above it), then the
    // category, then its child.
    expect(nav[1]).toContain('#general');
    expect(nav[2]).toContain('Text channels');
    expect(nav[3]).toContain('#random');
    // The active workspace's channels only.
    expect(frame(instance)).not.toContain('beta-general');
  });

  it('renders presence beside the workspace members in column one', async () => {
    const instance = mount();
    await tick();
    const section = navLines(instance).slice(
      navLines(instance).findIndex((line) => line.includes('Members')),
    );
    expect(section.length).toBeGreaterThan(1);
    // R25 with a non-colour channel as well as a colour: online is a filled
    // dot, offline a hollow one, so a monochrome terminal still reads it.
    const online = section.find((line) => line.includes('dana')) ?? '';
    const offline = section.find((line) => line.includes('erin')) ?? '';
    expect(online).toContain('●');
    expect(offline).toContain('○');
    expect(offline).not.toContain('●');
  });

  it('draws presence stale — not the last value — when the gateway link is down', async () => {
    // U15's rule reaching the column: with the link down, a member the store
    // last saw online must NOT still read as online. The reading is stale for
    // both members regardless of what the store holds, so no glyph here can
    // imply a currency the client cannot confirm.
    const instance = mount({ phase: 'offline' });
    await tick();
    const lines = navLines(instance);
    const section = lines.slice(lines.findIndex((line) => line.includes('Members')));
    const online = section.find((line) => line.includes('dana')) ?? '';
    const offline = section.find((line) => line.includes('erin')) ?? '';
    expect(online).toContain(PRESENCE_STALE_GLYPH);
    expect(online).not.toContain('●');
    expect(offline).toContain(PRESENCE_STALE_GLYPH);
    expect(offline).not.toContain('○');
  });

  it('marks the focused column with the non-colour focus marker', async () => {
    const instance = mount();
    await tick();
    // Column one owns input at start: its header carries the focus marker and
    // column two's does not.
    const navHeader = (navLines(instance)[0] ?? '');
    const contentHeader = (contentLines(instance)[0] ?? '');
    expect(navHeader).toContain('Channels mode');
    expect(contentHeader).toContain('#general');
    expect(navHeader).toContain('▸');
    expect(contentHeader).not.toContain('▸');
    await press(instance, KEYS.tab);
    const navAfter = navLines(instance)[0] ?? '';
    const contentAfter = contentLines(instance)[0] ?? '';
    expect(navAfter).not.toContain('▸');
    expect(contentAfter).toContain('▸');
  });
});

// ---------------------------------------------------------------------------
// R15/R17: DMs mode, account-wide
// ---------------------------------------------------------------------------

describe('DMs mode', () => {
  it('lists conversations account-wide, whatever workspace is active', async () => {
    const instance = mount();
    await tick();
    await press(instance, 'm');
    expect(frame(instance)).toContain('Direct Messages');
    expect(frame(instance)).toContain('dana');
    expect(frame(instance)).toContain('erin');
    // Account-wide: the second workspace's DM-ish members are irrelevant, but
    // no workspace channel leaks into the DM list.
    expect(frame(instance)).not.toContain('beta-general');
    expect(frame(instance)).not.toContain('general');
  });

  it('carries the peer presence beside the conversation', async () => {
    const instance = mount();
    await tick();
    await press(instance, 'm');
    const row = navLines(instance).find((line) => line.includes('erin')) ?? '';
    expect(row).toContain('○');
  });

  it('renders the message list of the selected conversation', async () => {
    const instance = mount();
    await tick();
    await press(instance, 'm');
    await tick();
    // The DM list is recency-ordered, so erin (the newest conversation) is the
    // landing selection; moving down lands on dana and her messages show.
    expect(frame(instance)).toContain('erin');
    expect(frame(instance)).not.toContain('dm line');
    await press(instance, 'j');
    await tick();
    expect(frame(instance)).toContain('dm line');
  });

  it('switching modes preserves each mode selection and scroll', async () => {
    const instance = mount();
    await tick();
    // Put column two's cursor on the older message, then move the DM selection.
    await press(instance, KEYS.tab);
    await press(instance, 'k');
    await tick();
    expect(rowHeaderFor(instance, 'oldest line')).toContain('▸');
    await press(instance, 'm');
    await press(instance, 'j');
    await tick();
    const dms = frame(instance);
    expect(dms).toContain('Direct Messages');
    // Back to Channels: the channel list, its selection, and column two's
    // cursor are exactly where they were.
    await press(instance, 'm');
    await tick();
    expect(frame(instance)).toContain('general');
    expect(rowHeaderFor(instance, 'oldest line')).toContain('▸');
    // And the DM selection is still where it was left.
    await press(instance, 'm');
    await tick();
    expect(stripMarkers(frame(instance))).toBe(stripMarkers(dms));
  });
});

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

describe('the workspace switch', () => {
  it('reloads column one when the member chooses another workspace', async () => {
    const instance = mount();
    await tick();
    expect(frame(instance)).toContain('general');
    await press(instance, 'w');
    expect(frame(instance)).toContain('Beta');
    await press(instance, 'j');
    await press(instance, KEYS.enter);
    await tick();
    expect(frame(instance)).toContain('beta-general');
    expect(frame(instance)).not.toContain('random');
    // Column two followed the reload rather than keeping the old workspace's
    // messages.
    expect(frame(instance)).toContain('beta line');
  });

  it('needs no selection step for a member with one workspace', async () => {
    const single = storeWith({
      ...baseState(),
      workspaces: { '100000000000000001': workspace({ id: '100000000000000001', name: 'Acme' }) },
    });
    const instance = mount({ store: single });
    await tick();
    expect(frame(instance)).toContain('general');
    await press(instance, 'w');
    await tick();
    // `w` opens nothing: there is nothing to choose.
    expect(frame(instance)).not.toContain('Choose a workspace');
    expect(frame(instance)).toContain('general');
  });

  it('tells a member with no workspace where to go in a browser', async () => {
    const empty = storeWith({
      ...baseState(),
      workspaces: {},
      channels: {},
      memberIdsByWorkspace: {},
    });
    const instance = mount({ store: empty });
    await tick();
    expect(frame(instance)).toContain(ORIGIN);
    expect(frame(instance)).toContain('workspace');
    // Column two has nothing selected, and says so.
    expect(frame(instance)).toContain('Select');
  });

  it('still reaches DMs with zero workspaces', async () => {
    const empty = storeWith({
      ...baseState(),
      workspaces: {},
      channels: {
        '400000000000000001': channel({
          id: '400000000000000001',
          name: 'dana',
          type: 'dm',
          recipients: [{ id: '900000000000000002', username: 'dana' }],
        }),
      },
      memberIdsByWorkspace: {},
    });
    const instance = mount({ store: empty });
    await tick();
    await press(instance, 'm');
    await tick();
    expect(frame(instance)).toContain('dana');
  });
});

// ---------------------------------------------------------------------------
// Moving, focus, and the composer
// ---------------------------------------------------------------------------

describe('moving and focus', () => {
  it('changes the selection within a column, and column two follows it', async () => {
    const instance = mount();
    await tick();
    // The channels-mode order is [general, random] (parentless first).
    expect(frame(instance)).toContain('oldest line');
    await press(instance, 'j');
    await tick();
    // random has no message slice: column two states that rather than keeping
    // the previous channel's messages on screen.
    expect(frame(instance)).not.toContain('oldest line');
    expect(frame(instance)).toMatch(/No messages in|Loading/);
  });

  it('switches columns without changing the selection', async () => {
    const instance = mount();
    await tick();
    const before = frame(instance);
    expect(before).toContain('general');
    await press(instance, KEYS.tab);
    await tick();
    const after = frame(instance);
    // Focus moved and NOTHING else did: same channel's messages, same rows —
    // only the focus indicator differs.
    expect(after).toContain('oldest line');
    expect(after).not.toBe(before);
    expect(stripMarkers(after)).toBe(stripMarkers(before));
  });

  it('moves the message cursor with j/k and the viewport with PageUp/PageDown', async () => {
    const short = { width: 100, height: 12 } as const;
    const instance = mount({ height: short.height });
    await tick();
    await press(instance, KEYS.tab);
    await tick();
    // The cursor lands on the newest message; moving up highlights the older.
    expect(rowHeaderFor(instance, 'newest line', short)).toContain('▸');
    await press(instance, 'k');
    await tick();
    expect(rowHeaderFor(instance, 'oldest line', short)).toContain('▸');
    // PageDown scrolls the viewport without moving the cursor.
    await press(instance, KEYS.pageDown);
    await tick();
    expect(rowHeaderFor(instance, 'oldest line', short)).toContain('▸');
  });

  it('gives the composer Enter only while it is focused', async () => {
    const onSend = vi.fn();
    const instance = mount({ onSend });
    await tick();
    // Not focused: Enter is column one's, and types nothing anywhere.
    await press(instance, KEYS.enter);
    await tick();
    expect(onSend).not.toHaveBeenCalled();
    // Focus the composer and type.
    await press(instance, 'i');
    await press(instance, 'h');
    await press(instance, 'i');
    await tick();
    expect(frame(instance)).toContain('hi');
    // The composer swallows `q`, so this does NOT quit.
    await press(instance, 'q');
    await tick();
    expect(frame(instance)).toContain('hiq');
    await press(instance, KEYS.backspace);
    await tick();
    await press(instance, KEYS.enter);
    await tick();
    expect(onSend).toHaveBeenCalledWith('hi');
  });

  it('leaves the composer on Escape', async () => {
    const instance = mount();
    await tick();
    await press(instance, 'i');
    await tick();
    await press(instance, KEYS.escape);
    await tick();
    // Focus is back on a column, so a movement key moves the cursor again.
    expect(rowHeaderFor(instance, 'newest line')).toContain('▸');
    await press(instance, 'k');
    await tick();
    expect(rowHeaderFor(instance, 'oldest line')).toContain('▸');
  });
});

// ---------------------------------------------------------------------------
// Threads (R18's trigger; U7 owns the view)
// ---------------------------------------------------------------------------

describe('opening and closing a thread', () => {
  it('opens the thread on the highlighted message and closes it with one binding', async () => {
    const instance = mount();
    await tick();
    await press(instance, KEYS.tab);
    await press(instance, 't');
    await tick();
    expect(frame(instance)).toContain('a thread');
    await press(instance, 't');
    await tick();
    expect(frame(instance)).not.toContain('a thread');
    expect(frame(instance)).toContain('newest line');
  });

  it('closes an open thread on Escape', async () => {
    const instance = mount();
    await tick();
    await press(instance, KEYS.tab);
    await press(instance, 't');
    await tick();
    expect(frame(instance)).toContain('a thread');
    await press(instance, KEYS.escape);
    await tick();
    expect(frame(instance)).not.toContain('a thread');
  });
});

// ---------------------------------------------------------------------------
// Empty, error, and offline states
// ---------------------------------------------------------------------------

describe('column one states', () => {
  it('names what is missing in a workspace with no channels', async () => {
    const bare = storeWith({
      ...baseState(),
      channels: {
        '400000000000000001': channel({
          id: '400000000000000001',
          name: 'dana',
          type: 'dm',
          recipients: [{ id: '900000000000000002', username: 'dana' }],
        }),
      },
    });
    const instance = mount({ store: bare });
    await tick();
    expect(frame(instance)).toContain('no channels');
    // It names the reachable thing instead of leaving the member at a dead end.
    expect(frame(instance)).toContain('direct messages');
  });

  it('names the empty DM list', async () => {
    const bare = storeWith({
      ...baseState(),
      channels: {
        '300000000000000001': channel({
          id: '300000000000000001',
          workspace_id: '100000000000000001',
          name: 'general',
        }),
      },
    });
    const instance = mount({ store: bare });
    await tick();
    await press(instance, 'm');
    await tick();
    expect(frame(instance)).toContain('No direct messages');
    expect(frame(instance)).toContain(ORIGIN);
  });

  it('renders a single channel with no headers and no empty state', async () => {
    const one = storeWith({
      ...baseState(),
      channels: {
        '300000000000000001': channel({
          id: '300000000000000001',
          workspace_id: '100000000000000001',
          name: 'general',
        }),
      },
      memberIdsByWorkspace: { '100000000000000001': [] },
    });
    const instance = mount({ store: one });
    await tick();
    expect(frame(instance)).toContain('general');
    expect(frame(instance)).not.toContain('Text channels');
    expect(frame(instance)).not.toContain('no channels');
  });

  it('shows an error state for a failed channel fetch while column two is empty', async () => {
    const instance = mount({
      store: storeWith({ currentUser: { id: '900000000000000001', username: 'tester' } }),
      navigation: { phase: 'failed', error: 'the channel list could not be loaded' },
    });
    await tick();
    // The reason wraps inside the column, so the sentence is read joined.
    expect(navLines(instance).join(' ')).toContain('the channel list could not be loaded');
    expect(contentLines(instance).join(' ')).toContain('Select');
    // The error replaces the empty state: one honest reason, not two.
    expect(frame(instance)).not.toContain('No workspaces');
  });

  it('shows a loading state before the boot load lands', async () => {
    const instance = mount({
      store: storeWith({}),
      navigation: { phase: 'loading' },
    });
    await tick();
    expect(navLines(instance).join(' ')).toMatch(/Loading your workspaces/);
  });

  it('renders the load\u2019s own empty notice, not a generic failure', async () => {
    // U12's snapshot says `empty` for an account with no workspaces and names
    // the browser URL; that is a state, not an error, and the DMs still work.
    const instance = mount({
      store: storeWith({ currentUser: { id: '900000000000000001', username: 'tester' } }),
      navigation: {
        phase: 'empty',
        notice: `No workspaces yet. Open ${ORIGIN} in a browser to create one.`,
      },
    });
    await tick();
    const nav = navLines(instance).join(' ');
    expect(nav).toContain(ORIGIN);
    expect(nav).toContain('No workspaces yet');
    expect(nav).not.toContain('Could not load');
  });

  it('keeps the DMs reachable when only the workspace read failed', async () => {
    const instance = mount({
      store: storeWith({
        ...baseState(),
        // The workspace read failed, but the account-wide DM read landed.
        workspaces: {},
        channels: {
          '400000000000000001': channel({
            id: '400000000000000001',
            name: 'dana',
            type: 'dm',
            recipients: [{ id: '900000000000000002', username: 'dana' }],
          }),
        },
        memberIdsByWorkspace: {},
      }),
      navigation: { phase: 'failed', error: 'Could not load your workspaces.' },
    });
    await tick();
    expect(navLines(instance).join(' ')).toContain('Could not load your workspaces');
    await press(instance, 'm');
    await tick();
    // DMs mode is account-wide (R17): the failed workspace read does not blank it.
    expect(navLines(instance).join(' ')).toContain('dana');
    expect(navLines(instance).join(' ')).not.toContain('Could not load');
  });

  it('degrades only the DM list when the DM read is the one that failed', async () => {
    const instance = mount({ navigation: { phase: 'ready', dmsFailed: true } });
    await tick();
    // Channels mode is untouched.
    expect(navLines(instance).join(' ')).toContain('#general');
    await press(instance, 'm');
    await tick();
    expect(navLines(instance).join(' ')).toContain('Could not load your direct messages');
    expect(navLines(instance).join(' ')).not.toContain('No direct messages');
  });

  it('keeps both columns while the gateway is offline, with the banner saying so', async () => {
    const instance = mount({ phase: 'offline' });
    await tick();
    expect(frame(instance)).toContain('Phase offline');
    expect(joinedLine(instance, 'Channels mode', 'general')).toBe(true);
  });

  it('derives an error state in column one from a failed session', async () => {
    // Nothing was loaded: the session's own failure is the only thing column
    // one can honestly say, and column two has nothing selected.
    const instance = mount({ phase: 'failed', store: storeWith({}) });
    await tick();
    expect(navLines(instance).join('\n')).toContain('Phase failed');
    expect(contentLines(instance).join('\n')).toContain('Select');
  });
});

// ---------------------------------------------------------------------------
// R26a: inert server strings
// ---------------------------------------------------------------------------

describe('server-supplied names are inert', () => {
  const ESCAPE = '\u001b[2J\u001b[31m';

  it('renders a channel, workspace, and display name with an escape sequence as text', async () => {
    const hostile = storeWith({
      ...baseState(),
      workspaces: {
        '100000000000000001': workspace({ id: '100000000000000001', name: `${ESCAPE}Acme` }),
      },
      channels: {
        ...baseState().channels,
        '300000000000000001': channel({
          id: '300000000000000001',
          workspace_id: '100000000000000001',
          name: `${ESCAPE}general`,
          position: 0,
        }),
      },
      membersById: {
        '900000000000000001': member({ id: '900000000000000001', username: 'tester' }),
        '900000000000000002': member({
          id: '900000000000000002',
          username: `${ESCAPE}root`,
        }),
      },
    });
    const instance = mount({ store: hostile });
    await tick();
    const drawn = frame(instance);
    // The escape sequences are gone (no screen clear, no cursor movement),
    // and the text survives.
    expect(drawn).not.toContain('\u001b[2J');
    expect(drawn).not.toContain('\u001b[31m');
    expect(drawn).toContain('Acme');
    expect(drawn).toContain('general');
    expect(drawn).toContain('root');
  });

  it('renders a hostile DM peer name and message body inertly', async () => {
    const hostile = storeWith({
      ...baseState(),
      channels: {
        '400000000000000001': channel({
          id: '400000000000000001',
          name: `${ESCAPE}dana`,
          type: 'dm',
          recipients: [{ id: '900000000000000002', username: `${ESCAPE}dana` }],
        }),
      },
      messagesByChannel: {
        '400000000000000001': {
          items: [
            message({
              id: '800000000000000002',
              channel_id: '400000000000000001',
              author_id: '900000000000000002',
              content: `hello ${ESCAPE}world`,
            }),
          ],
          oldestId: '800000000000000002',
          hasCompleteHistory: true,
        },
      },
    });
    const instance = mount({ store: hostile });
    await tick();
    await press(instance, 'm');
    await press(instance, KEYS.tab);
    await tick();
    const drawn = frame(instance);
    expect(drawn).not.toContain('\u001b[2J');
    expect(drawn).not.toContain('\u001b[31m');
    expect(drawn).toContain('hello world');
  });
});

// ---------------------------------------------------------------------------
// R28: help, search, read state, quit
// ---------------------------------------------------------------------------

describe('the key reference and the rest of the map', () => {
  it('renders the key map table itself on `?`', async () => {
    const instance = mount();
    await tick();
    await press(instance, '?');
    await tick();
    const drawn = frame(instance);
    for (const binding of KEY_MAP) {
      expect(drawn, binding.action).toContain(binding.label);
      expect(drawn, binding.action).toContain(binding.keys[0] ?? '');
    }
    await press(instance, '?');
    await tick();
    expect(frame(instance)).not.toContain(KEY_MAP[0]?.label ?? '');
  });

  it('hands search, mark-read, and mark-unread to the host with the selected ids', async () => {
    const onSearch = vi.fn();
    const onMarkRead = vi.fn();
    const onMarkUnread = vi.fn();
    const instance = mount({ onSearch, onMarkRead, onMarkUnread });
    await tick();
    await press(instance, '/');
    expect(onSearch).toHaveBeenCalledTimes(1);
    await press(instance, 'r');
    expect(onMarkRead).toHaveBeenCalledWith('300000000000000001');
    await press(instance, KEYS.tab);
    await press(instance, 'u');
    // U10's floor is written through the channel-scoped ack route, so the
    // conversation travels with the message id.
    expect(onMarkUnread).toHaveBeenCalledWith('800000000000000009', '300000000000000001');
  });
});

describe('quitting', () => {
  it('ends the session on q and ignores everything after it', async () => {
    const onQuit = vi.fn();
    const onSearch = vi.fn();
    const instance = mount({ onQuit, onSearch });
    await tick();
    expect(frame(instance)).toContain('general');
    await press(instance, 'q');
    await tick();
    expect(onQuit).toHaveBeenCalledTimes(1);
    // A session that has ended handles nothing more: no second quit, and no
    // further action escapes the shell (the Ink tree comes down with it, so
    // there is no frame left to act on either).
    await press(instance, 'q');
    await press(instance, '/');
    await press(instance, 'j');
    await tick();
    expect(onQuit).toHaveBeenCalledTimes(1);
    expect(onSearch).not.toHaveBeenCalled();
  });

  it('quits on Ctrl+C as well as q', async () => {
    const onQuit = vi.fn();
    const instance = mount({ onQuit });
    await tick();
    await press(instance, KEYS.ctrlC);
    await tick();
    expect(onQuit).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The message cursor and viewport are per conversation
// ---------------------------------------------------------------------------

describe('column two is driven by the shared store', () => {
  it('follows the store when it changes after mount, with no parallel cache', async () => {
    const store = storeWith();
    const instance = mount({ store });
    await tick();
    expect(frame(instance)).toContain('oldest line');
    expect(frame(instance)).not.toContain('arrived later');

    // The gateway folds a new message into the shared store. The shell has no
    // loader of its own, so this is the only way the text can reach column two.
    const slice = store.getState().messagesByChannel['300000000000000001'];
    store.setState({
      messagesByChannel: {
        ...store.getState().messagesByChannel,
        '300000000000000001': {
          items: [
            message({
              id: '800000000000000099',
              channel_id: '300000000000000001',
              author_id: '900000000000000002',
              content: 'arrived later',
            }),
            ...(slice?.items ?? []),
          ],
          oldestId: slice?.oldestId ?? null,
          hasCompleteHistory: slice?.hasCompleteHistory ?? false,
        },
      },
    });
    await tick();
    expect(frame(instance)).toContain('arrived later');
  });

  it('renders the thread slice when a thread is open, not the channel list', async () => {
    const store = storeWith({
      ...baseState(),
      messagesByThread: {
        '500000000000000001': {
          items: [
            message({
              id: '800000000000000050',
              channel_id: '300000000000000001',
              thread_id: '500000000000000001',
              author_id: '900000000000000003',
              content: 'a reply in the thread',
            }),
          ],
          oldestId: '800000000000000050',
          hasCompleteHistory: true,
        },
      },
    });
    const instance = mount({ store });
    await tick();
    await press(instance, KEYS.tab);
    await press(instance, 't');
    await tick();
    expect(frame(instance)).toContain('a reply in the thread');
  });
});

// ---------------------------------------------------------------------------
// The keyboard model, as a pure table (no terminal, no Ink)
// ---------------------------------------------------------------------------

describe('the shell reducer', () => {
  const bounds: ShellBounds = {
    workspaceIds: ['100000000000000001'],
    navigationKey: 'channels:100000000000000001',
    navigationCount: 2,
    conversationId: '300000000000000001',
    messageCount: 2,
    currentMessageId: '800000000000000009',
    contentHeight: 20,
  };

  it('clamps movement at both ends of a column and at the shrunken end of a list', () => {
    const start = initialShellState({ navigationIndex: { [bounds.navigationKey]: 1 } });
    expect(reduceShell(start, 'move-down', bounds).state.navigationIndex[bounds.navigationKey]).toBe(1);
    expect(reduceShell(start, 'move-up', bounds).state.navigationIndex[bounds.navigationKey]).toBe(0);
    // A count that shrank below the stored index re-derives rather than sticking.
    expect(reduceShell(start, 'move-up', { ...bounds, navigationCount: 1 }).state.navigationIndex[
      bounds.navigationKey
    ]).toBe(0);
    expect(reduceShell(start, 'move-down', { ...bounds, navigationCount: 0 }).state.navigationIndex[
      bounds.navigationKey
    ]).toBe(0);
  });

  it('opens a conversation at its newest message and keeps the cursor on screen', () => {
    // Absent cursor = the newest message, per conversation.
    const newest = messageCursorFor(initialShellState(), bounds);
    expect(newest).toBe(1);
    expect(viewportFor(initialShellState(), { ...bounds, contentHeight: 1 })).toBe(0);
    // A viewport of one row follows the cursor when it moves down.
    const scrolled = reduceShell(
      initialShellState({ focus: 'content', viewport: { [bounds.conversationId]: 0 } }),
      'move-down',
      { ...bounds, contentHeight: 1 },
    ).state;
    expect(scrolled.viewport[bounds.conversationId]).toBe(1);
  });

  it('keeps each conversation, mode, and workspace cursor where the member left it', () => {
    const state = initialShellState({
      navigationIndex: { 'channels:100000000000000001': 1, dms: 0 },
    });
    const switched = reduceShell(state, 'switch-mode', bounds).state;
    expect(switched.mode).toBe('dms');
    expect(switched.navigationIndex['channels:100000000000000001']).toBe(1);
    expect(reduceShell(switched, 'switch-mode', bounds).state.navigationIndex[
      'channels:100000000000000001'
    ]).toBe(1);
    // The message cursor is keyed by conversation, so another conversation's
    // cursor is untouched.
    const moved = reduceShell(
      initialShellState({ focus: 'content', messageCursor: { other: 5 } }),
      'move-down',
      bounds,
    ).state;
    expect(moved.messageCursor.other).toBe(5);
  });

  it('ends the session once and ignores every action after that', () => {
    const quit = reduceShell(initialShellState(), 'quit', bounds);
    expect(quit.state.quit).toBe(true);
    expect(quit.effects.quit).toBe(true);
    // The session-end order: nothing else can fire afterwards.
    for (const action of ['search', 'mark-read', 'help', 'move-down', 'switch-mode'] as const) {
      const after = reduceShell(quit.state, action, bounds);
      expect(after.state).toBe(quit.state);
      expect(after.effects).toEqual(NO_EFFECTS);
    }
  });

  it('hands the search, read, and send requests to the caller as one-shot effects', () => {
    const search = reduceShell(initialShellState(), 'search', bounds);
    expect(search.effects.search).toBe(true);
    expect(search.effects.markRead).toBeNull();

    const read = reduceShell(initialShellState(), 'mark-read', bounds);
    expect(read.effects.markRead).toBe(bounds.conversationId);

    const unread = reduceShell(initialShellState(), 'mark-unread', bounds);
    expect(unread.effects.markUnread).toBe(bounds.currentMessageId);

    // With nothing selected there is nothing to mark.
    const empty = reduceShell(initialShellState(), 'mark-read', { ...bounds, conversationId: '' });
    expect(empty.effects.markRead).toBeNull();

    const send = reduceShell(initialShellState({ focus: 'composer' }), 'activate', bounds);
    expect(send.effects.send).toBe(true);
  });

  it('routes the reaction key to the row the cursor is on, and nowhere behind an overlay', () => {
    const toggle = reduceShell(initialShellState({ focus: 'content' }), 'toggle-reaction', bounds);
    expect(toggle.effects.reaction).toBe(bounds.currentMessageId);
    expect(toggle.effects.send).toBe(false);

    // `e` is bound in the map (the key reference prints it) and resolved to the
    // action rather than being typed as text.
    expect(resolveAction(keystrokeOf('e', {}), 'content')).toBe('toggle-reaction');
    expect(resolveAction(keystrokeOf('e', {}), 'composer')).toBeNull();

    // The key reference and the workspace chooser are modal: nothing is
    // toggled while one is open.
    expect(
      reduceShell(initialShellState({ overlay: 'help' }), 'toggle-reaction', bounds).effects.reaction,
    ).toBeNull();
    expect(
      reduceShell(initialShellState({ overlay: 'workspaces' }), 'toggle-reaction', bounds).effects
        .reaction,
    ).toBeNull();

    // Nothing under the cursor: nothing to react to.
    const empty = reduceShell(initialShellState(), 'toggle-reaction', {
      ...bounds,
      currentMessageId: null,
    });
    expect(empty.effects.reaction).toBeNull();
  });

  it('steps out of a surface in one order: overlay, thread, composer, then column', () => {
    const overlay = reduceShell(initialShellState({ overlay: 'help' }), 'cancel', bounds).state;
    expect(overlay.overlay).toBe('none');
    expect(overlay.focus).toBe('navigation');

    const thread = reduceShell(
      initialShellState({ openThreadMessageId: '800000000000000009', focus: 'content' }),
      'cancel',
      bounds,
    ).state;
    expect(thread.openThreadMessageId).toBeNull();
    expect(thread.focus).toBe('content');

    expect(reduceShell(initialShellState({ focus: 'composer' }), 'cancel', bounds).state.focus).toBe(
      'content',
    );
    expect(reduceShell(initialShellState({ focus: 'content' }), 'cancel', bounds).state.focus).toBe(
      'navigation',
    );
  });

  it('will not open a workspace chooser when there is no choice to make', () => {
    expect(reduceShell(initialShellState(), 'switch-workspace', bounds).state.overlay).toBe('none');
    const chooser = reduceShell(initialShellState(), 'switch-workspace', {
      ...bounds,
      workspaceIds: ['100000000000000001', '100000000000000002'],
    }).state;
    expect(chooser.overlay).toBe('workspaces');
  });
});
