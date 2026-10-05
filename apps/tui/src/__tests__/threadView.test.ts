/**
 * @cytale/tui — the thread pane (U7; R18, R26a).
 *
 * A thread replaces column two and gives it back, so the tests are about three
 * things the pane must never confuse: the REPLIES (from `messagesByThread`,
 * which the thread endpoint fills) versus the CHANNEL's messages; the thread's
 * own header and seed context versus the channel's; and a failed thread read
 * versus a channel that was cleared.
 *
 * The store is the only data path here too: opening a thread fetches through
 * the host's `onLoadHistory` seam, whose test implementations write the thread
 * slice the way the thread endpoint's page will. Nothing in the pane synthesizes
 * a reply from the channel's rows.
 */
import { cleanup, render } from 'ink-testing-library';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Channel, Message, Thread, Workspace, WorkspaceMember } from '@cytale/domain';
import { createStateStore, type StateStore, type StateState } from '@cytale/state';

import { App } from '../app.js';
import { buildContentView, type ContentTarget } from '../columns/ContentColumn.js';
import { layoutFor } from '../columns/layout.js';
import { replyIndicatorLine, type HistoryRequest, type MessageRow } from '../format/rows.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORIGIN = 'https://chat.example.com';
const WORKSPACE = '100000000000000001';
const GENERAL = '300000000000000001';
const ME = '900000000000000001';
const DANA = '900000000000000002';
const ERIN = '900000000000000003';
const SEED = '800000000000000009';
const OLDER = '800000000000000001';
const THREAD = '500000000000000001';
const REPLY = '800000000000000050';

const SIZE = { width: 100, height: 30 } as const;

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

function member(id: string, username: string): WorkspaceMember {
  return { id, username, nickname: null, joined_at: '', roles: [] };
}

function message(
  overrides: Partial<Message> & Pick<Message, 'id' | 'author_id' | 'content'>,
): Message {
  return {
    channel_id: GENERAL,
    thread_id: null,
    created_at: '2026-09-13T12:00:00.000Z',
    edited_at: null,
    ...overrides,
  };
}

/** The channel's page: `newest line` (the seed) is the newest, so the cursor lands on it. */
function channelPage(): Message[] {
  return [
    message({ id: SEED, author_id: DANA, content: 'newest line' }),
    message({ id: OLDER, author_id: DANA, content: 'oldest line' }),
  ];
}

function threadRecord(overrides: Partial<Thread> = {}): Thread {
  return {
    id: THREAD,
    channel_id: GENERAL,
    parent_message_id: SEED,
    name: 'a thread',
    created_by: DANA,
    archived: false,
    created_at: '2026-09-13T12:00:00.000Z',
    ...overrides,
  };
}

function threadReply(overrides: Partial<Message> = {}): Message {
  return message({
    id: REPLY,
    thread_id: THREAD,
    author_id: ERIN,
    content: 'a reply from the thread endpoint',
    created_at: '2026-09-13T12:05:00.000Z',
    ...overrides,
  });
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
    membersById: {
      [ME]: member(ME, 'tester'),
      [DANA]: member(DANA, 'dana'),
      [ERIN]: member(ERIN, 'erin'),
    },
    memberIdsByWorkspace: { [WORKSPACE]: [ME, DANA, ERIN] },
    messagesByChannel: {
      [GENERAL]: { items: channelPage(), oldestId: OLDER, hasCompleteHistory: true },
    },
    threadsById: { [THREAD]: threadRecord() },
    threadIdsByChannel: { [GENERAL]: [THREAD] },
    ...overrides,
  };
}

function storeWith(state: Partial<StateState> = baseState()): StateStore {
  const store = createStateStore();
  store.setState(state);
  return store;
}

/** A store whose channel already holds the thread's loaded replies. */
function storeWithReplies(state: Partial<StateState> = baseState()): StateStore {
  return storeWith({
    ...state,
    messagesByThread: {
      [THREAD]: { items: [threadReply()], oldestId: REPLY, hasCompleteHistory: true },
    },
  });
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Options {
  readonly store?: StateStore;
  readonly height?: number;
  readonly onLoadHistory?: (request: HistoryRequest) => Promise<void>;
  readonly onSendTo?: (target: ContentTarget, text: string) => void;
}

function mount(options: Options = {}) {
  return render(
    createElement(App, {
      view: { phase: 'online', headline: 'Connected' },
      mode: 'ssh',
      origin: ORIGIN,
      store: options.store ?? storeWith(),
      width: SIZE.width,
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

const KEYS = { tab: '\t', enter: '\r', escape: '\u001b' } as const;
const COLUMNS_TOP = 2;

const frame = (instance: Instance): string => instance.lastFrame() ?? '';

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

/** The pane's header: the first line of column two. */
const header = (instance: Instance): string => contentLines(instance)[0] ?? '';

/** The pane's text with its wraps joined, for a line that wraps inside it. */
const paneText = (instance: Instance): string => contentLines(instance).join(' ');

/** Open the thread on the cursor's message (the newest row). */
async function openThread(instance: Instance): Promise<void> {
  await press(instance, KEYS.tab);
  await press(instance, 't');
  await tick();
}

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// R18: opening and closing
// ---------------------------------------------------------------------------

describe('opening and closing a thread', () => {
  it('opens the thread in place of the channel and restores the channel on the way back', async () => {
    const instance = mount({ store: storeWithReplies() });
    await tick();
    expect(frame(instance)).toContain('oldest line');
    await openThread(instance);

    // The channel's OTHER messages are gone; the pane is the thread.
    expect(header(instance)).toContain('thread: a thread');
    expect(header(instance)).toContain('#general');
    expect(frame(instance)).toContain('a reply from the thread endpoint');
    expect(frame(instance)).not.toContain('oldest line');

    // One binding back (R18), and Escape is the second spelling of it.
    await press(instance, 't');
    await tick();
    expect(frame(instance)).toContain('oldest line');
    expect(frame(instance)).not.toContain('a reply from the thread endpoint');
    await openThread(instance);
    await press(instance, KEYS.escape);
    await tick();
    expect(frame(instance)).toContain('oldest line');
    expect(frame(instance)).not.toContain('thread: a thread');
  });

  it('renders the seed message as context above the replies', async () => {
    const instance = mount({ store: storeWithReplies() });
    await tick();
    await openThread(instance);
    const lines = contentLines(instance);
    const seedLine = lines.findIndex((line) => line.includes('seed'));
    const seedBody = lines.findIndex((line) => line.includes('newest line'));
    const replyBody = lines.findIndex((line) =>
      line.includes('a reply from the thread endpoint'),
    );
    // The seed is marked as such, and it is above the replies.
    expect(seedLine).toBeGreaterThan(0);
    expect(seedBody).toBeGreaterThan(seedLine);
    expect(replyBody).toBeGreaterThan(seedBody);
  });

  it('counts replies from the loaded reply set, and renders the channel row indicator', async () => {
    const instance = mount({ store: storeWithReplies() });
    await tick();
    const counted = contentLines(instance).find((line) => line.includes('1 reply'));
    expect(counted).toBeDefined();
    expect(counted).toContain('↩');
  });

  it('renders no thread indicator when no replies are loaded', async () => {
    // The rule the plan states: a zero-count thread renders nowhere. The thread
    // record exists, but nothing has loaded its replies, so the row claims
    // nothing about a count this client does not have.
    const instance = mount({ store: storeWith() });
    await tick();
    expect(frame(instance)).not.toContain('reply');
    expect(frame(instance)).not.toContain('↩');
  });

  it('sends a reply into the thread, resolved to the thread id', async () => {
    const onSendTo = vi.fn();
    const instance = mount({ store: storeWithReplies(), onSendTo });
    await tick();
    await openThread(instance);
    await press(instance, 'i');
    await press(instance, 'y');
    await press(instance, KEYS.enter);
    await tick();
    expect(onSendTo).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'thread', channelId: GENERAL, threadId: THREAD }),
      'y',
    );
  });
});

// ---------------------------------------------------------------------------
// Edge cases: no thread, a thread with only its seed, a thread at its start
// ---------------------------------------------------------------------------

describe('thread states', () => {
  it('says so when the cursor message has no thread instead of showing an empty pane', async () => {
    const store = storeWithReplies({
      ...baseState(),
      threadsById: {},
      threadIdsByChannel: {},
    });
    const onLoadHistory = vi.fn(async () => undefined);
    const onSendTo = vi.fn();
    const instance = mount({ store, onLoadHistory, onSendTo });
    await tick();
    await openThread(instance);
    expect(frame(instance)).toContain('This message has no thread');
    // The pane still names the channel it belongs to, so the way back is legible.
    expect(frame(instance)).toContain('#general');
    // Nothing to fetch: a message with no thread has no reply endpoint.
    await tick();
    expect(onLoadHistory).not.toHaveBeenCalled();
    // And nothing to send INTO: the destination falls back to the channel rather
    // than a thread id invented from a message id.
    await press(instance, 'i');
    await press(instance, 'z');
    await press(instance, KEYS.enter);
    await tick();
    expect(onSendTo).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'channel', channelId: GENERAL, threadId: null }),
      'z',
    );
  });

  it('renders a thread with only its seed, and an empty thread slice as empty', async () => {
    const store = storeWith({
      ...baseState(),
      messagesByThread: {
        [THREAD]: { items: [], oldestId: null, hasCompleteHistory: true },
      },
    });
    const instance = mount({ store });
    await tick();
    await openThread(instance);
    const lines = contentLines(instance);
    // The seed is context, and the pane says there is nothing under it.
    expect(lines.some((line) => line.includes('seed'))).toBe(true);
    expect(frame(instance)).toContain('newest line');
    expect(frame(instance)).toContain('No replies in this thread yet');
  });

  it('marks the beginning of a reply set that has been fully loaded', async () => {
    const instance = mount({ store: storeWithReplies() });
    await tick();
    await openThread(instance);
    expect(frame(instance)).toContain('beginning of the thread');
    expect(frame(instance)).not.toContain('loading earlier replies');
  });
});

// ---------------------------------------------------------------------------
// The thread endpoint, and what pagination of replies looks like
// ---------------------------------------------------------------------------

describe('thread replies come from the thread endpoint', () => {
  it('loads the replies of a thread whose slice is not in the store yet', async () => {
    const store = storeWith();
    const onLoadHistory = vi.fn(async (request: HistoryRequest) => {
      expect(request).toEqual(
        expect.objectContaining({ kind: 'thread', channelId: GENERAL, threadId: THREAD, before: null }),
      );
      store.setState((state) => ({
        messagesByThread: {
          ...state.messagesByThread,
          [THREAD]: { items: [threadReply()], oldestId: REPLY, hasCompleteHistory: true },
        },
      }));
    });
    const instance = mount({ store, onLoadHistory });
    await tick();
    await openThread(instance);
    await tick();
    expect(onLoadHistory).toHaveBeenCalledTimes(1);
    expect(frame(instance)).toContain('a reply from the thread endpoint');
    // The channel slice was never the source and was never touched.
    expect(store.getState().messagesByChannel[GENERAL]?.items).toHaveLength(2);
    expect(frame(instance)).not.toContain('oldest line');
  });

  it('pages older replies from the thread cursor, not the channel cursor', async () => {
    const store = storeWith({
      ...baseState(),
      messagesByThread: {
        [THREAD]: { items: [threadReply()], oldestId: REPLY, hasCompleteHistory: false },
      },
    });
    const onLoadHistory = vi.fn(async (request: HistoryRequest) => {
      // `before` is the THREAD's own cursor; the channel's is 800000000000000001.
      expect(request).toEqual(
        expect.objectContaining({ kind: 'thread', threadId: THREAD, before: REPLY }),
      );
      store.setState((state) => ({
        messagesByThread: {
          ...state.messagesByThread,
          [THREAD]: {
            items: [
              ...(state.messagesByThread[THREAD]?.items ?? []),
              threadReply({
                id: '800000000000000040',
                content: 'an older reply',
                created_at: '2026-09-13T12:04:00.000Z',
              }),
            ],
            oldestId: '800000000000000040',
            hasCompleteHistory: true,
          },
        },
      }));
    });
    const instance = mount({ store, onLoadHistory });
    await tick();
    await openThread(instance);
    await tick();
    // The single loaded reply is the cursor's row, so the top is already reached.
    expect(onLoadHistory).toHaveBeenCalledTimes(1);
    // The older reply landed in the thread's slice…
    expect(store.getState().messagesByThread[THREAD]?.items).toHaveLength(2);
    // …and the cursor stayed anchored on the reply it was on.
    expect(contentLines(instance).find((line) => line.includes('▸'))).toBeDefined();
    expect(frame(instance)).toContain('a reply from the thread endpoint');
  });
});

// ---------------------------------------------------------------------------
// Error path: a failed thread read must not touch the channel
// ---------------------------------------------------------------------------

describe('a failed thread fetch', () => {
  it('renders an inline error, keeps the channel, and retries on the next key', async () => {
    const store = storeWith();
    let attempt = 0;
    const onLoadHistory = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('thread endpoint unreachable');
      store.setState((state) => ({
        messagesByThread: {
          ...state.messagesByThread,
          [THREAD]: { items: [threadReply()], oldestId: REPLY, hasCompleteHistory: true },
        },
      }));
    });
    const instance = mount({ store, onLoadHistory });
    await tick();
    await openThread(instance);
    await tick();
    // The pane wraps, so the error is read joined: the copy and the cause. The
    // error REPLACES the loading notice rather than sitting beside it.
    expect(paneText(instance)).not.toContain('Loading replies');
    expect(paneText(instance)).toContain("Could not load this thread's replies");
    expect(paneText(instance)).toContain('thread endpoint unreachable');
    // The channel's own slice is untouched by the failure.
    expect(store.getState().messagesByChannel[GENERAL]?.items).toHaveLength(2);
    expect(frame(instance)).not.toContain('oldest line');

    // The retry: any key on the pane asks again.
    await press(instance, 'k');
    await tick();
    expect(onLoadHistory).toHaveBeenCalledTimes(2);
    expect(frame(instance)).toContain('a reply from the thread endpoint');
    expect(frame(instance)).not.toContain('Could not load');

    // …and closing the thread still gives the channel back.
    await press(instance, 't');
    await tick();
    expect(frame(instance)).toContain('oldest line');
  });

  it('does not clear the channel when a thread read fails on a channel pane', async () => {
    const store = storeWith();
    const onLoadHistory = vi.fn(async () => {
      throw new Error('network unreachable');
    });
    const instance = mount({ store, onLoadHistory });
    await tick();
    // The channel pane is intact after the failure…
    await openThread(instance);
    await tick();
    await press(instance, KEYS.escape);
    await tick();
    expect(frame(instance)).toContain('oldest line');
    expect(frame(instance)).toContain('newest line');
    expect(store.getState().messagesByChannel[GENERAL]?.items).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// R26a: the thread pane is inert too
// ---------------------------------------------------------------------------

describe('server-supplied thread strings are inert', () => {
  const ESCAPE = '\u001b[2J\u001b[31m';

  it('renders a hostile thread name, author, and reply body as text', async () => {
    const store = storeWith({
      ...baseState(),
      threadsById: { [THREAD]: threadRecord({ name: `${ESCAPE}hostile thread` }) },
      membersById: {
        [ME]: member(ME, 'tester'),
        [DANA]: member(DANA, 'dana'),
        [ERIN]: member(ERIN, `${ESCAPE}root`),
      },
      messagesByThread: {
        [THREAD]: {
          items: [threadReply({ content: `hello ${ESCAPE}world` })],
          oldestId: REPLY,
          hasCompleteHistory: true,
        },
      },
    });
    const instance = mount({ store });
    await tick();
    await openThread(instance);
    await tick();
    const drawn = frame(instance);
    expect(drawn).not.toContain('\u001b[2J');
    expect(drawn).not.toContain('\u001b[31m');
    expect(drawn).toContain('hostile thread');
    expect(drawn).toContain('root');
    expect(drawn).toContain('hello world');
  });
});

describe('the reply indicator', () => {
  const row = (replies: number): MessageRow => ({
    id: '800000000000000050',
    authorId: ERIN,
    author: 'erin',
    time: '12:05',
    lines: ['a reply'],
    groupStart: true,
    replies,
  });

  it('states a count from the loaded replies, and nothing at zero', () => {
    expect(replyIndicatorLine(row(1))).toContain('1 reply');
    expect(replyIndicatorLine(row(2))).toContain('2 replies');
    expect(replyIndicatorLine(row(0))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The view model, as a pure table (no terminal)
// ---------------------------------------------------------------------------

describe('the thread view model', () => {
  it('resolves the thread header, the send target, and the pane identity', () => {
    const source = storeWithReplies().getState();
    const view = buildContentView({
      source,
      conversationId: GENERAL,
      openThreadMessageId: SEED,
      width: 40,
    });
    expect(view.pane).toBe('thread');
    expect(view.header).toBe('#general · thread: a thread · 1 reply');
    expect(view.sendTarget).toEqual({
      kind: 'thread',
      channelId: GENERAL,
      threadId: THREAD,
      label: '#general',
    });
    expect(view.rows.map((row) => row.id)).toEqual([REPLY]);
    expect(view.seed?.id).toBe(SEED);
    // The pane pages the THREAD, not the channel it hangs off.
    expect(view.history).toEqual(
      expect.objectContaining({ kind: 'thread', threadId: THREAD, before: REPLY, atStart: true }),
    );
  });

  it('keeps the channel pane target when no thread is open', () => {
    const view = buildContentView({
      source: storeWithReplies().getState(),
      conversationId: GENERAL,
      openThreadMessageId: null,
      width: 40,
    });
    expect(view.pane).toBe('channel');
    expect(view.header).toBe('#general');
    expect(view.sendTarget).toEqual({
      kind: 'channel',
      channelId: GENERAL,
      threadId: null,
      label: '#general',
    });
    expect(view.seed).toBeNull();
    expect(view.history.threadId).toBeNull();
    expect(view.rows.map((row) => row.id)).toEqual([OLDER, SEED]);
  });
});
