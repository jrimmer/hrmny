/**
 * @cytale/web — ThreadSidePanel row re-render economy (plan 1.1 / 7.1).
 *
 * The panel mounts one `MessageItem` per reply with no virtualization (7.1's
 * "reuse MessageList" is blocked — the list has no seam for a non-channel
 * message source and the panel's single-scroller follow contract is pinned by
 * `ThreadSidePanelFollow.test.tsx`). So the only thing between a 500-reply
 * thread and 500 re-rendered rows is `MessageItem`'s `memo`.
 *
 * `memo` compares props SHALLOWLY. A row bails out only if every prop it
 * receives is identity-identical to the previous render — so a prop the panel
 * re-creates on each render makes the memo decoration. This file pins the one
 * prop that decides it for the thread panel: `resolveMention`
 * (`createMentionResolver` returns a NEW function, and the panel used to build
 * it inline in the render body).
 *
 * The row-render counter is `renderMarkdownBlocks`, which runs inside the
 * `MessageItem` body on every render (the parse TREE is memoized on content;
 * the render is not). Only `MessageItem` calls it in the production tree, so
 * the call count *is* "how many row bodies ran".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

import type { Message, Thread } from '@cytale/domain';
import { applyGatewayEvent, createStateStore, type StateStore } from '@cytale/state';

// Count row renders. `vi.hoisted` so the `vi.mock` factory (hoisted above the
// imports) can see the counter.
const counters = vi.hoisted(() => ({ markdownRenders: 0 }));
vi.mock('../../messages/markdown.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../messages/markdown.js')>();
  return {
    ...actual,
    renderMarkdownBlocks: (...args: Parameters<typeof actual.renderMarkdownBlocks>) => {
      counters.markdownRenders += 1;
      return actual.renderMarkdownBlocks(...args);
    },
  };
});

import { ThreadSidePanel } from '../ThreadSidePanel.js';
import type { UseThreads } from '../useThreads.js';

// jsdom has no layout: the thread's replies render through the virtualized
// MessageList (#15), so Virtuoso is the layout-free stand-in.
vi.mock('react-virtuoso', async () => (await import('../../../test/virtuosoMock.js')).virtuosoModule());


const CHANNEL = '9007199254740993';
const THREAD = '9007199254741000';
const ME = '7000000000000002';
const AUTHOR = '7000000000000001';
const REPLY_BASE = 1000000000000100;

const PARENT: Message = {
  id: '1000000000000001',
  channel_id: CHANNEL,
  thread_id: null,
  author_id: ME,
  content: 'origin message',
  created_at: '2026-08-30T12:00:00Z',
  edited_at: null,
};

const THREAD_META: Thread = {
  id: THREAD,
  channel_id: CHANNEL,
  parent_message_id: PARENT.id,
  name: 'origin message',
  created_by: ME,
  archived: false,
  member_state: { notify: true, last_read_id: null },
  created_at: '2026-08-30T12:00:00Z',
};

let replySeq = 2;

/** A store with `replyCount` replies already in `messagesByThread`. */
function makeStore(replyCount: number): StateStore {
  const store = createStateStore();
  store.setState({ currentUser: { id: ME, username: 'me' } });
  applyGatewayEvent(store, {
    op: 0,
    t: 'ThreadCreate',
    s: 1,
    d: {
      id: THREAD,
      channel_id: CHANNEL,
      name: 'origin message',
      created_by: ME,
      created_at: '2026-08-30T12:00:00Z',
    },
  } as never);
  // ThreadCreate does not carry member_state; the bell reads it, so pin it.
  store.setState((s) => ({
    threadsById: {
      ...s.threadsById,
      [THREAD]: {
        ...s.threadsById[THREAD]!,
        member_state: { notify: true, last_read_id: null },
      },
    },
  }));
  for (let i = 0; i < replyCount; i++) {
    seedReply(store, String(REPLY_BASE + i), `reply ${i}`);
  }
  return store;
}

function seedReply(store: StateStore, id: string, content: string): void {
  applyGatewayEvent(store, {
    op: 0,
    t: 'ThreadMessageCreate',
    s: replySeq++,
    d: {
      id,
      thread_id: THREAD,
      author_id: AUTHOR,
      content,
      created_at: '2026-08-30T12:01:00Z',
      edited_at: null,
    },
  } as never);
}

/** The thread hook mock: an injected hook makes the panel's OWN props the
 * only thing a re-render can change. */
function makeThreads(store: StateStore): UseThreads {
  return {
    openThreadId: null,
    firstUnreadId: () => null,
    openThread: vi.fn(),
    closeThread: vi.fn(),
    follow: vi.fn(async () => {}),
    unfollow: vi.fn(async () => {}),
    markUnread: vi.fn(async () => {}),
    leave: vi.fn(async () => {}),
    archive: vi.fn(async () => {}),
    loadReplies: vi.fn(async () => {}),
    replies: (id: string) => store.getState().messagesByThread[id]?.items ?? [],
    thread: (id: string) => store.getState().threadsById[id] ?? null,
    isNotified: (id: string) => store.getState().threadsById[id]?.member_state?.notify === true,
    unreadCount: (id: string) => store.getState().unreadByThread[id]?.unread_count ?? 0,
    parseDeepLink: () => null,
  };
}

function renderPanel(store: StateStore, threads: UseThreads) {
  return render(
    <ThreadSidePanel
      threadId={THREAD}
      channelId={CHANNEL}
      store={store}
      threads={threads}
      parentMessage={PARENT}
    />,
  );
}

beforeEach(() => {
  counters.markdownRenders = 0;
  replySeq = 2;
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ThreadSidePanel — reply rows bail out of re-rendering', () => {
  it('a parent re-render with unchanged props does not re-run any row body', async () => {
    const store = makeStore(3);
    const threads = makeThreads(store);
    const view = renderPanel(store, threads);

    // The origin pin + the three replies are all mounted.
    await waitFor(() => {
      expect(screen.getAllByTestId('message-item').length).toBe(4);
    });
    const base = counters.markdownRenders;
    expect(base).toBeGreaterThanOrEqual(4);

    // A re-render of the panel with byte-identical props. React re-renders the
    // panel; `MessageItem`'s shallow memo must bail out for every row — which
    // it can only do if every prop it receives is identity-stable. A fresh
    // `resolveMention` per render (the pre-fix panel) defeats it and every row
    // body runs again.
    act(() => {
      view.rerender(
        <ThreadSidePanel
          threadId={THREAD}
          channelId={CHANNEL}
          store={store}
          threads={threads}
          parentMessage={PARENT}
        />,
      );
    });

    expect(counters.markdownRenders).toBe(base);
  });

  it('a store write outside the thread does not re-run any reply row', async () => {
    const store = makeStore(3);
    const threads = makeThreads(store);
    renderPanel(store, threads);

    await waitFor(() => {
      expect(screen.getAllByTestId('message-item').length).toBe(4);
    });
    const base = counters.markdownRenders;

    // A presence flip is not thread data. `useThreads` (which the panel always
    // calls) holds a whole-store subscription, so the panel itself re-renders;
    // every row's props are unchanged, so the memo must drop all of them.
    act(() => {
      store.setState({
        presenceByUser: { [ME]: { status: 'online', last_seen_at: '2026-08-30T12:05:00Z' } },
      });
    });

    expect(counters.markdownRenders).toBe(base);
  });

  it('a reply landing in THIS thread still renders (the memo is not over-bailing)', async () => {
    const store = makeStore(3);
    const threads = makeThreads(store);
    renderPanel(store, threads);

    await waitFor(() => {
      expect(screen.getAllByTestId('message-item').length).toBe(4);
    });
    const base = counters.markdownRenders;

    act(() => {
      seedReply(store, String(REPLY_BASE + 100), 'the newest word');
    });

    expect(await screen.findByText('the newest word')).toBeTruthy();
    expect(counters.markdownRenders).toBeGreaterThan(base);
    expect(screen.getAllByTestId('message-item').length).toBe(5);
  });
});
