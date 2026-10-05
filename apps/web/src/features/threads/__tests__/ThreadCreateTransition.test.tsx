/**
 * @cytale/web — starting a thread without a blank or a flash (2026-10-01).
 *
 * Owner report: "When I start a thread the original message is at the
 * bottom. Then when I send, the thread panel goes black with some gray
 * skeletons, the thread panel flashes, then the messages render at top."
 *
 * The cause: the draft rendered its own bottom-aligned view, and the switch to
 * the created thread mounted a NEW list (keyed by the thread id) with nothing
 * in it yet — the create answered before the reply did — so the pane showed
 * its loading skeleton over a blank list until the reply landed.
 *
 * Now the draft IS the list (its window keyed by the draft's client key), the
 * reply is drawn the moment it is sent, and the created thread takes that
 * window over in place: the same list node, never a skeleton.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import React, { useState } from 'react';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  KEY_ENTER_COMMAND,
  type LexicalEditor,
} from 'lexical';

import type { Message, Thread } from '@cytale/domain';
import { createStateStore, type StateStore } from '@cytale/state';

import { ThreadSidePanel, ThreadSurface } from '../ThreadSidePanel.js';
import { mobileWidthState } from '../../../test/setup.js';
import type { UseThreads } from '../useThreads.js';
import { api, authStore } from '../../auth/session.js';

vi.mock('react-virtuoso', async () => (await import('../../../test/virtuosoMock.js')).virtuosoModule());

const CHANNEL = '9007199254740993';
const THREAD = '9007199254741000';
const ME = '7000000000000002';

const PARENT: Message = {
  id: '1000000000000001',
  channel_id: CHANNEL,
  thread_id: null,
  author_id: '7000000000000001',
  content: 'origin message',
  created_at: '2026-08-30T12:00:00Z',
  edited_at: null,
};

const CREATED: Thread = {
  id: THREAD,
  channel_id: CHANNEL,
  parent_message_id: PARENT.id,
  name: 'origin message',
  created_by: ME,
  archived: false,
  message_count: 0,
  created_at: '2026-10-01T12:00:00Z',
};

function makeStore(): StateStore {
  const store = createStateStore();
  store.setState({ currentUser: { id: ME, username: 'me' } });
  return store;
}

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
    // The background read of the created thread: answers nothing new.
    loadReplies: vi.fn(async () => {}),
    replies: (id: string) => store.getState().messagesByThread[id]?.items ?? [],
    thread: (id: string) => store.getState().threadsById[id] ?? null,
    isNotified: () => false,
    unreadCount: () => 0,
    parseDeepLink: () => null,
  };
}

/** The shell's part (AuthenticatedApp): a draft promoted to its thread. */
function Host({
  store,
  threads,
  surface = false,
}: {
  store: StateStore;
  threads: UseThreads;
  /** Render through the responsive surface (the phone sheet at mobile width). */
  surface?: boolean;
}) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const Panel = surface ? ThreadSurface : ThreadSidePanel;
  return (
    <Panel
      threadId={threadId}
      channelId={CHANNEL}
      parentMessageId={PARENT.id}
      draftName="origin message"
      store={store}
      threads={threads}
      parentMessage={PARENT}
      onThreadCreated={(t) => setThreadId(t.id)}
    />
  );
}

function composerEditor(): LexicalEditor {
  const root = document.querySelector(
    '[data-testid="thread-side-panel"] [contenteditable="true"]',
  ) as (HTMLElement & { __lexicalEditor?: LexicalEditor }) | null;
  if (!root?.__lexicalEditor) throw new Error('no composer editor');
  return root.__lexicalEditor;
}

function send(text: string): void {
  const editor = composerEditor();
  act(() => {
    editor.update(
      () => {
        const r = $getRoot();
        r.clear();
        r.append($createParagraphNode().append($createTextNode(text)));
      },
      { discrete: true },
    );
  });
  act(() => {
    editor.dispatchCommand(KEY_ENTER_COMMAND, {
      shiftKey: false,
      preventDefault: () => {},
    } as unknown as KeyboardEvent);
  });
}

/** Rows in the list, in screen order, as their text. */
function rowTexts(): string[] {
  return screen.queryAllByTestId('virtuoso-item').map((el) => el.textContent ?? '');
}

/**
 * Watch the panel for the states the owner saw: a loading skeleton, or the
 * list gone. Every DOM mutation is checked, so a state that lasted one
 * commit is caught.
 */
function watchForBlanking(): { seen: string[]; stop: () => void } {
  const seen: string[] = [];
  const check = () => {
    if (document.querySelector('[data-testid="thread-loading"]')) seen.push('skeleton');
    if (!document.querySelector('[data-testid="message-list"]')) seen.push('no list');
    if (!document.querySelector('[data-testid="thread-parent-pin"]')) seen.push('no origin');
  };
  const observer = new MutationObserver(check);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  return { seen, stop: () => observer.disconnect() };
}

beforeEach(() => {
  authStore.getState().reset();
  authStore.getState().setStatus('authenticated');
  authStore.getState().setVerified(true);
  authStore.getState().setUser({
    id: ME,
    username: 'me',
    email: 'me@example.com',
    email_verified_at: '2026-08-30T00:00:00Z',
  });
  globalThis.localStorage?.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  mobileWidthState.mobile = false;
});

describe('starting a thread — the draft is laid out like the thread it becomes', () => {
  it('the origin sits at the TOP of the draft, in the same list a thread uses', () => {
    const store = makeStore();
    render(<Host store={store} threads={makeThreads(store)} />);

    const list = screen.getByTestId('message-list');
    // The draft is the thread's own list (not a separate bottom-aligned view)…
    expect(within(list).getByTestId('virtuoso-mock')).toBeTruthy();
    expect(screen.queryByTestId('list-history-only')).toBeNull();
    // …and the origin is the first thing in it: the list's history header.
    const items = within(list).getByTestId('virtuoso-item-list');
    expect(items.firstElementChild?.getAttribute('data-testid')).toBe('thread-history-header');
    expect(within(items).getByTestId('thread-parent-pin').textContent).toContain('origin message');
    // Nothing pushes it to the bottom: no wrapper in the panel body aligns
    // its content to the end.
    let node: HTMLElement | null = screen.getByTestId('thread-parent-pin');
    while (node && node.getAttribute('data-testid') !== 'thread-side-panel') {
      expect(node.className).not.toMatch(/justify-end/);
      node = node.parentElement;
    }
    // No skeleton for a thread that has nothing to load.
    expect(screen.queryByTestId('thread-loading')).toBeNull();
  });
});

describe('starting a thread — the first reply lands without a blank or a flash', () => {
  it('draws the reply at once, keeps the same list node through the create, and never shows a skeleton', async () => {
    const store = makeStore();
    const threads = makeThreads(store);
    let answerCreate: (t: Thread) => void = () => {};
    let answerSend: (m: unknown) => void = () => {};
    const startThread = vi.spyOn(api, 'startThread').mockImplementation(
      () => new Promise<Thread>((resolve) => (answerCreate = resolve)),
    );
    const sendThread = vi.spyOn(api, 'sendThreadMessage').mockImplementation(
      () => new Promise((resolve) => (answerSend = resolve as (m: unknown) => void)) as never,
    );
    render(<Host store={store} threads={threads} />);
    await waitFor(() => composerEditor());

    const list = screen.getByTestId('message-list');
    const origin = screen.getByTestId('thread-parent-pin');
    const watch = watchForBlanking();

    send('first reply');
    // The same frame: the reply is a pending row under the origin, and the
    // box is clear — while the create has not even answered.
    expect(rowTexts()).toHaveLength(1);
    expect(rowTexts()[0]).toContain('first reply');
    const row = screen.getByTestId('virtuoso-item');
    expect(origin.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await waitFor(() =>
      expect(composerEditor().getEditorState().read(() => $getRoot().getTextContent())).toBe(''),
    );

    // The create answers (a slow one): the draft becomes the thread IN PLACE.
    await waitFor(() => expect(startThread).toHaveBeenCalled());
    await act(async () => {
      answerCreate(CREATED);
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.getByTestId('thread-side-panel').getAttribute('data-thread-id')).toBe(THREAD),
    );
    expect(screen.getByTestId('message-list'), 'the list was not remounted').toBe(list);
    expect(screen.getByTestId('message-list').getAttribute('data-thread-id')).toBe(THREAD);
    expect(screen.getByTestId('thread-parent-pin'), 'the origin was not remounted').toBe(origin);
    expect(screen.getByTestId('virtuoso-item'), 'the reply row was not remounted').toBe(row);
    expect(rowTexts()[0]).toContain('first reply');
    // The thread now exists: its controls appear.
    expect(screen.getByTestId('thread-ellipsis')).toBeTruthy();

    // The reply is confirmed: still the same nodes, now the server's row.
    await waitFor(() => expect(sendThread).toHaveBeenCalled());
    await act(async () => {
      answerSend({
        id: '1000000000000050',
        channel_id: CHANNEL,
        thread_id: THREAD,
        author_id: ME,
        content: 'first reply',
        created_at: '2026-10-01T12:00:01Z',
        edited_at: null,
      });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(store.getState().messagesByThread[THREAD]?.items[0]?.id).toBe('1000000000000050'),
    );
    expect(screen.getByTestId('message-list')).toBe(list);
    expect(screen.getByTestId('virtuoso-item')).toBe(row);
    // The created thread's replies were read in the background.
    expect(threads.loadReplies).toHaveBeenCalledWith(THREAD);

    watch.stop();
    expect(watch.seen, 'never a skeleton, never a missing list or origin').toEqual([]);
  });

  it('a failed create keeps the reply as a failed row with Retry — the text is not lost', async () => {
    const store = makeStore();
    const startThread = vi
      .spyOn(api, 'startThread')
      .mockRejectedValueOnce(
        Object.assign(new Error('The server could not start the thread.'), {
          key: 'internal',
          code: 50000,
        }),
      )
      .mockResolvedValueOnce(CREATED);
    vi.spyOn(api, 'sendThreadMessage').mockResolvedValue({
      id: '1000000000000051',
      channel_id: CHANNEL,
      author_id: ME,
      content: 'do not lose me',
      created_at: '2026-10-01T12:00:02Z',
      edited_at: null,
    } as never);
    render(<Host store={store} threads={makeThreads(store)} />);
    await waitFor(() => composerEditor());

    send('do not lose me');
    await waitFor(() => expect(screen.getByTestId('message-send-failed')).toBeTruthy());
    // The draft is still a draft (no thread was created), and its row keeps
    // the text with the reason and the row's actions.
    expect(screen.getByTestId('thread-side-panel').getAttribute('data-thread-id')).toBeNull();
    expect(rowTexts()[0]).toContain('do not lose me');
    expect(screen.getByTestId('message-send-failed').textContent).toContain(
      'The server could not start the thread.',
    );
    expect(screen.getByTestId('message-send-edit')).toBeTruthy();

    // Retry runs the create again and the reply lands in the new thread.
    await act(async () => {
      screen.getByTestId('message-send-retry').click();
    });
    await waitFor(() =>
      expect(screen.getByTestId('thread-side-panel').getAttribute('data-thread-id')).toBe(THREAD),
    );
    expect(startThread).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByTestId('message-send-failed')).toBeNull());
    expect(rowTexts()).toHaveLength(1);
    expect(rowTexts()[0]).toContain('do not lose me');
  });

  it("a failed create's Edit puts the text back in the box", async () => {
    const store = makeStore();
    vi.spyOn(api, 'startThread').mockRejectedValue(
      Object.assign(new Error('nope'), { key: 'internal', code: 50000 }),
    );
    render(<Host store={store} threads={makeThreads(store)} />);
    await waitFor(() => composerEditor());

    send('bring me back');
    await waitFor(() => expect(screen.getByTestId('message-send-edit')).toBeTruthy());
    await act(async () => {
      screen.getByTestId('message-send-edit').click();
    });
    await waitFor(() =>
      expect(composerEditor().getEditorState().read(() => $getRoot().getTextContent())).toBe(
        'bring me back',
      ),
    );
    expect(rowTexts()).toEqual([]);
  });
});

describe('starting a thread on a phone — the sheet does the same', () => {
  it('the reply lands under the origin in the sheet, and the sheet keeps its list through the create', async () => {
    mobileWidthState.mobile = true;
    const store = makeStore();
    let answerCreate: (t: Thread) => void = () => {};
    const startThread = vi.spyOn(api, 'startThread').mockImplementation(
      () => new Promise<Thread>((resolve) => (answerCreate = resolve)),
    );
    vi.spyOn(api, 'sendThreadMessage').mockResolvedValue({
      id: '1000000000000052',
      channel_id: CHANNEL,
      author_id: ME,
      content: 'from the phone',
      created_at: '2026-10-01T12:00:03Z',
      edited_at: null,
    } as never);
    render(<Host store={store} threads={makeThreads(store)} surface />);
    const sheet = await screen.findByTestId('thread-sheet');
    await waitFor(() => composerEditor());
    const list = within(sheet).getByTestId('message-list');
    const watch = watchForBlanking();

    send('from the phone');
    expect(rowTexts()[0]).toContain('from the phone');
    await waitFor(() => expect(startThread).toHaveBeenCalled());
    await act(async () => {
      answerCreate(CREATED);
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.getByTestId('thread-side-panel').getAttribute('data-thread-id')).toBe(THREAD),
    );
    await waitFor(() =>
      expect(store.getState().messagesByThread[THREAD]?.items[0]?.id).toBe('1000000000000052'),
    );
    expect(screen.getByTestId('thread-sheet')).toBe(sheet);
    expect(within(sheet).getByTestId('message-list')).toBe(list);
    watch.stop();
    expect(watch.seen).toEqual([]);
  });
});
