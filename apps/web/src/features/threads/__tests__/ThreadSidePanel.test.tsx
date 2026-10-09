/**
 * @cytale/web — ThreadSidePanel tests (U22).
 *
 * Covers the plan's happy paths: reply opens the panel, parent message pinned
 * at top, reply appears in the panel, follow/unfollow toggles the notify
 * bell, close × closes. The threads hook is injected (no gateway/fetch
 * needed); the store is a real U17 store so replies reconcile.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor, act, fireEvent, within } from '@testing-library/react';
import { axe } from 'vitest-axe';
import type { AxeMatchers } from 'vitest-axe/matchers';
import React from 'react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

declare module 'vitest' {
  interface Assertion<T> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}

import type { Message, Thread } from '@cytale/domain';
import {
  createStateStore,
  applyGatewayEvent,
  mergeThreadMessages,
  type StateStore,
} from '@cytale/state';

import { ThreadSidePanel, ThreadSurface } from '../ThreadSidePanel.js';
import type { UseThreads } from '../useThreads.js';
import type { UseTyping } from '../../presence/useTyping.js';
import { mobileWidthState } from '../../../test/setup.js';
import { virtuosoMockState } from '../../../test/virtuosoMock.js';
import { revealMessageActions } from '../../../test/revealActions.js';
import { api, authStore } from '../../auth/session.js';
import { resetComponentClicks } from '../../commands/useComponentClick.js';
import { receiveInteractionSuccess, resetInteractionAnswers } from '../../interactions/interactionAnswers.js';

// jsdom has no layout: the thread's replies render through the virtualized
// MessageList (#15), so Virtuoso is the layout-free stand-in.
vi.mock('react-virtuoso', async () => (await import('../../../test/virtuosoMock.js')).virtuosoModule());

const CHANNEL = '9007199254740993';
const THREAD = '9007199254741000';
const ME = '7000000000000002';

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

/** Open the thread's ⋯ menu (Radix opens on pointer, so userEvent). */
async function openThreadOptions() {
  await act(async () => {
    await userEvent.setup().click(screen.getByTestId('thread-ellipsis'));
  });
}

function makeStore(): StateStore {
  const store = createStateStore();
  store.setState({ currentUser: { id: ME, username: 'me' } });
  // Seed the thread metadata + a reply in the store.
  applyGatewayEvent(store, {
    op: 0,
    t: 'ThreadCreate',
    s: 1,
    d: { id: THREAD, channel_id: CHANNEL, name: 'origin message', created_by: ME, created_at: '2026-08-30T12:00:00Z' },
  } as never);
  // The store's ThreadCreate doesn't set member_state; set it directly so the
  // notify bell reflects the follow state (notify=true).
  store.setState((s) => ({
    threadsById: {
      ...s.threadsById,
      [THREAD]: { ...s.threadsById[THREAD]!, member_state: { notify: true, last_read_id: null } },
    },
  }));
  applyGatewayEvent(store, {
    op: 0,
    t: 'ThreadMessageCreate',
    s: 2,
    d: {
      id: '1000000000000002',
      thread_id: THREAD,
      author_id: '7000000000000001',
      content: 'a reply',
      created_at: '2026-08-30T12:01:00Z',
      edited_at: null,
    },
  } as never);
  return store;
}

function makeThreads(store: StateStore): UseThreads {
  return {
    openThreadId: null,
    firstUnreadId: () => null,
    openThread: vi.fn((id: string) => {
      store.setState({});
    }),
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

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(404, {})));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
  } as unknown as Response;
}

describe('ThreadSidePanel', () => {
  it('renders the thread’s start line, then the origin and replies in ONE scroll region', () => {
    const store = makeStore();
    // The starter's display name comes from the roster (created_by → member).
    store.setState((s) => ({
      membersById: {
        ...s.membersById,
        [ME]: {
          id: ME,
          username: 'me',
          nickname: null,
          joined_at: '2026-08-01T00:00:00Z',
          roles: [],
        },
      },
    }));
    const threads = makeThreads(store);
    render(
      <ThreadSidePanel
        threadId={THREAD}
        channelId={CHANNEL}
        store={store}
        threads={threads}
        parentMessage={PARENT}
      />,
    );

    expect(screen.getByTestId('thread-side-panel')).toBeTruthy();
    const body = screen.getByTestId('thread-replies');
    expect(body.textContent).toContain('origin message');
    // The reply appears in the panel.
    expect(body.textContent).toContain('a reply');

    // The origin is NOT a pinned sibling: it scrolls with the thread (a
    // pinned, unbounded origin starved the reply list — 2026-09-12).
    const origin = screen.getByTestId('thread-parent-pin');
    expect(body.contains(origin)).toBe(true);

    // Who started it, with the date, ABOVE the origin so a long origin
    // cannot bury it.
    const started = screen.getByTestId('thread-started-line');
    expect(started.textContent).toContain('me');
    expect(started.textContent).toContain('started this thread');
    expect(started.textContent).toContain('2026');
    expect(
      started.compareDocumentPosition(origin) & Node.DOCUMENT_POSITION_FOLLOWING,
      'the start line precedes the origin',
    ).toBeTruthy();
  });

  it('draft mode: a thread with no replies yet is not created — the panel offers only the origin and the composer', () => {
    const store = makeStore();
    const threads = makeThreads(store);
    const onThreadCreated = vi.fn();
    render(
      <ThreadSidePanel
        threadId={null}
        channelId={CHANNEL}
        parentMessageId={PARENT.id}
        draftName="A brand new thread"
        store={store}
        threads={threads}
        parentMessage={PARENT}
        onThreadCreated={onThreadCreated}
      />,
    );

    // The title comes from the draft's own name (the seed-derived one).
    expect(screen.getByTestId('thread-title').textContent).toBe('A brand new thread');
    // Nothing is read from the server for a thread that does not exist.
    expect(threads.loadReplies).not.toHaveBeenCalled();

    // Nothing to follow and nothing to leave yet: no level control, no ⋯.
    expect(screen.queryByTestId('thread-notifications')).toBeNull();
    expect(screen.queryByTestId('thread-ellipsis')).toBeNull();

    // The origin is context; there is no start line (it has not started), no
    // empty-state copy, and no content box around the message.
    expect(screen.getByTestId('thread-parent-pin').textContent).toContain('origin message');
    expect(screen.queryByTestId('thread-started-line')).toBeNull();
    // A transcript with nothing in it says nothing — the composer is the
    // affordance (user direction 2026-09-13).
    expect(screen.queryByTestId('thread-empty')).toBeNull();

    // The composer reads neutral, not the thread's name: our names are the seed
    // message's own words, so echoing one read as content in the box (user
    // report 2026-09-13).
    expect(screen.getByTestId('composer-placeholder').textContent).toBe('Reply in thread');
  });

  it('draft mode: closing posts nothing (the host has no thread to clean up)', () => {
    const store = makeStore();
    const threads = makeThreads(store);
    const onClose = vi.fn();
    render(
      <ThreadSidePanel
        threadId={null}
        channelId={CHANNEL}
        parentMessageId={PARENT.id}
        draftName="A brand new thread"
        store={store}
        threads={threads}
        parentMessage={PARENT}
        onClose={onClose}
      />,
    );
    screen.getByTestId('thread-close').click();
    expect(onClose).toHaveBeenCalledTimes(1);
    // No create, no follow, no leave — the draft touched the API not at all.
    expect(threads.follow).not.toHaveBeenCalled();
    expect(threads.leave).not.toHaveBeenCalled();
    expect(threads.markUnread).not.toHaveBeenCalled();
  });

  it("names a thread with a generated name by its start message (2026-10-08)", () => {
    const store = makeStore();
    store.setState((s) => ({
      threadsById: { ...s.threadsById, [THREAD]: { ...s.threadsById[THREAD]!, name: 'thread-388032' } },
    }));
    const threads = makeThreads(store);
    render(
      <ThreadSidePanel
        threadId={THREAD}
        channelId={CHANNEL}
        store={store}
        threads={threads}
        parentMessage={{ ...PARENT, content: '**Backup** finished: 3 hosts' }}
      />,
    );
    expect(screen.getByTestId('thread-title').textContent).toBe('Backup finished: 3 hosts');
  });

  it('keeps a generated name when the start message is not loaded', () => {
    const store = makeStore();
    store.setState((s) => ({
      threadsById: { ...s.threadsById, [THREAD]: { ...s.threadsById[THREAD]!, name: 'thread-388032' } },
    }));
    const threads = makeThreads(store);
    render(<ThreadSidePanel threadId={THREAD} channelId={CHANNEL} store={store} threads={threads} />);
    expect(screen.getByTestId('thread-title').textContent).toBe('thread-388032');
  });

  it('shows the thread title and the thread-scope level control, inheriting its channel', () => {
    const store = makeStore();
    const threads = makeThreads(store);
    render(
      <ThreadSidePanel threadId={THREAD} channelId={CHANNEL} store={store} threads={threads} />,
    );

    expect(screen.getByTestId('thread-title').textContent).toBe('origin message');
    // 2026-09-27: the bell is the thread's LEVEL, not follow. With no thread
    // row it inherits (dimmed) and names the next state.
    const control = screen.getByTestId('thread-notifications');
    expect(control.hasAttribute('data-inherited')).toBe(true);
    expect(control.getAttribute('aria-label')).toBe(
      'Notifications: Mentions only (account default) — click for Nothing',
    );
  });

  it('a channel level shows through the thread control as the channel default', () => {
    const store = makeStore();
    store.setState((s) => ({
      notificationPrefs: { ...s.notificationPrefs, overrides: { [`channel:${CHANNEL}`]: 'all' } },
    }));
    const threads = makeThreads(store);
    render(
      <ThreadSidePanel threadId={THREAD} channelId={CHANNEL} store={store} threads={threads} />,
    );
    expect(screen.getByTestId('thread-notifications').getAttribute('aria-label')).toBe(
      'Notifications: All messages (channel default) — click for Mentions only',
    );
  });

  it('Follow/Unfollow lives in the ⋯ menu and toggles membership', async () => {
    const store = makeStore();
    const threads = makeThreads(store);
    render(
      <ThreadSidePanel threadId={THREAD} channelId={CHANNEL} store={store} threads={threads} />,
    );

    await openThreadOptions();
    const follow = screen.getByTestId('thread-option-follow');
    // member_state.notify=true → the item offers to unfollow.
    expect(follow.textContent).toBe('Unfollow Thread');
    await act(async () => {
      fireEvent.click(follow);
    });
    expect(threads.unfollow).toHaveBeenCalledWith(THREAD);
    // The level control is untouched by following.
    expect(threads.follow).not.toHaveBeenCalled();
  });

  it('the ⋯ menu offers Follow Thread for an unfollowed thread', async () => {
    const store = makeStore();
    store.setState((s) => ({
      threadsById: {
        ...s.threadsById,
        [THREAD]: { ...s.threadsById[THREAD]!, member_state: { notify: false, last_read_id: null } },
      },
    }));
    const threads = makeThreads(store);
    render(
      <ThreadSidePanel threadId={THREAD} channelId={CHANNEL} store={store} threads={threads} />,
    );
    await openThreadOptions();
    await act(async () => {
      fireEvent.click(screen.getByTestId('thread-option-follow'));
    });
    expect(threads.follow).toHaveBeenCalledWith(THREAD);
  });

  it('close × calls onClose', () => {
    const store = makeStore();
    const threads = makeThreads(store);
    const onClose = vi.fn();
    render(
      <ThreadSidePanel
        threadId={THREAD}
        channelId={CHANNEL}
        store={store}
        threads={threads}
        onClose={onClose}
      />,
    );

    screen.getByTestId('thread-close').click();
    expect(onClose).toHaveBeenCalled();
  });

  it('has no axe violations', async () => {
    const store = makeStore();
    const threads = makeThreads(store);
    const { container } = render(
      <ThreadSidePanel
        threadId={THREAD}
        channelId={CHANNEL}
        store={store}
        threads={threads}
        parentMessage={PARENT}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});


  it('drag-drop uploads: overlay while hovering, drop reaches the composer staging (#47)', async () => {
    authStore.getState().reset();
    authStore.getState().setStatus('authenticated');
    authStore.getState().setVerified(true);
    const upload = vi.spyOn(api, 'uploadChannelAttachment').mockResolvedValue({
      filename: 'cat.png',
      content_type: 'image/png',
      size: 4,
      url: '/api/v1/attachments/x',
    });
    const store = makeStore();
    const threads = makeThreads(store);
    render(
      <ThreadSidePanel
        threadId={THREAD}
        channelId={CHANNEL}
        store={store}
        threads={threads}
        parentMessage={PARENT}
      />,
    );

    const panel = screen.getByTestId('thread-side-panel');
    fireEvent.dragEnter(panel, { dataTransfer: { types: ['Files'] } });
    expect(screen.getByTestId('thread-drop-overlay')).toBeTruthy();

    const file = new File(['bits'], 'cat.png', { type: 'image/png' });
    fireEvent.drop(panel, { dataTransfer: { types: ['Files'], files: [file] } });
    expect(screen.queryByTestId('thread-drop-overlay')).toBeNull();

    await waitFor(() => expect(upload).toHaveBeenCalled());
    upload.mockRestore();
  });

describe('ThreadSidePanel — attribution fold-in (U9 queue, mirrors MessageList)', () => {
  const PARENT_HUMAN = '7000000000000100';
  const BOT = '7000000000000101';

  function memberRow(
    id: string,
    username: string,
    kind?: 'bot',
    parentUserId?: string,
  ) {
    return {
      id,
      username,
      nickname: null,
      joined_at: '2026-01-01T00:00:00Z',
      roles: [],
      kind,
      parent_user_id: parentUserId,
    };
  }

  /** Store seeded with a bot-authored parent pin + bot-authored reply. */
  function makeBotStore(): StateStore {
    const store = createStateStore();
    store.setState({ currentUser: { id: ME, username: 'me' } });
    store.setState({
      membersById: {
        [PARENT_HUMAN]: memberRow(PARENT_HUMAN, 'janedoe'),
        [BOT]: memberRow(BOT, 'release-bot', 'bot', PARENT_HUMAN),
      },
    });
    applyGatewayEvent(store, {
      op: 0,
      t: 'ThreadCreate',
      s: 1,
      d: { id: THREAD, channel_id: CHANNEL, name: 'origin message', created_by: ME, created_at: '2026-08-30T12:00:00Z' },
    } as never);
    applyGatewayEvent(store, {
      op: 0,
      t: 'ThreadMessageCreate',
      s: 2,
      d: {
        id: '1000000000000003',
        thread_id: THREAD,
        author_id: BOT,
        content: 'bot reply',
        created_at: '2026-08-30T12:01:00Z',
        edited_at: null,
      },
    } as never);
    return store;
  }

  const BOT_PARENT: Message = {
    ...PARENT,
    id: '1000000000000001',
    author_id: BOT,
    content: 'bot origin',
  };

  it('badges the pinned parent pin for machine authors, naming the parent', () => {
    const store = makeBotStore();
    const threads = makeThreads(store);
    render(
      <ThreadSidePanel
        threadId={THREAD}
        channelId={CHANNEL}
        store={store}
        threads={threads}
        parentMessage={BOT_PARENT}
      />,
    );

    const pin = screen.getByTestId('thread-parent-pin');
    const badge = pin.querySelector('[data-testid="kind-badge"]');
    expect(badge).not.toBeNull();
    expect(badge!.getAttribute('data-kind')).toBe('bot');
    // The seal rides the avatar; the attribution is in its tooltip and in the
    // row's sr-only text (the avatar is aria-hidden).
    expect(badge!.getAttribute('title')).toBe('Agent account, via janedoe');
    expect(pin.textContent).toContain('Agent account, via janedoe');
  });

  it('badges bot-authored replies through the same members projection', () => {
    const store = makeBotStore();
    const threads = makeThreads(store);
    render(
      <ThreadSidePanel
        threadId={THREAD}
        channelId={CHANNEL}
        store={store}
        threads={threads}
        parentMessage={PARENT}
      />,
    );

    const replies = screen.getByTestId('thread-replies');
    const badge = replies.querySelector('[data-testid="kind-badge"]');
    expect(badge).not.toBeNull();
    expect(badge!.getAttribute('data-kind')).toBe('bot');
    expect(badge!.getAttribute('title')).toBe('Agent account, via janedoe');
    // The reply's author name resolves through the projection too.
    expect(replies.textContent).toContain('release-bot');
  });

  it('renders no badge for human authors (absence is the human marker)', () => {
    const store = makeBotStore();
    const threads = makeThreads(store);
    render(
      <ThreadSidePanel
        threadId={THREAD}
        channelId={CHANNEL}
        store={store}
        threads={threads}
        parentMessage={PARENT}
      />,
    );

    // PARENT is authored by ME — a human absent from the projection → no badge.
    const pinBadge = screen
      .getByTestId('thread-parent-pin')
      .querySelector('[data-testid="kind-badge"]');
    expect(pinBadge).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Thread cards — a bot's interactive card (content + embed + buttons) posted
// into a THREAD renders in the side panel exactly as the channel timeline
// renders it, and a click resolves on the THREAD slice's flip.
// ---------------------------------------------------------------------------

describe('ThreadSidePanel — bot cards in a thread (parity with the channel timeline)', () => {
  const BOT = '7000000000000201';
  const CARD_ID = '1000000000000050';
  const APPROVE_ROW = [
    {
      type: 1,
      components: [
        { type: 2, style: 3, label: 'Approve', custom_id: 'approve' },
        { type: 2, style: 4, label: 'Deny', custom_id: 'deny' },
      ],
    },
  ];
  const RESOLVED_ROW = [
    {
      type: 1,
      components: [{ type: 2, style: 2, label: 'Approved', custom_id: 'approve', disabled: true }],
    },
  ];

  function makeCardStore(card: Record<string, unknown>): StateStore {
    const store = createStateStore();
    store.setState({
      currentUser: { id: ME, username: 'me' },
      membersById: {
        [BOT]: {
          id: BOT,
          username: 'hermes',
          nickname: null,
          joined_at: '2026-01-01T00:00:00Z',
          roles: [],
          kind: 'bot',
        },
      } as never,
    });
    applyGatewayEvent(store, {
      op: 0,
      t: 'ThreadCreate',
      s: 1,
      d: { id: THREAD, channel_id: CHANNEL, name: 'origin message', created_by: ME, created_at: '2026-08-30T12:00:00Z' },
    } as never);
    applyGatewayEvent(store, {
      op: 0,
      t: 'ThreadMessageCreate',
      s: 2,
      d: {
        id: CARD_ID,
        channel_id: CHANNEL,
        thread_id: THREAD,
        author_id: BOT,
        created_at: '2026-08-30T12:02:00Z',
        edited_at: null,
        ...card,
      },
    } as never);
    return store;
  }

  afterEach(() => {
    resetComponentClicks();
    resetInteractionAnswers();
  });

  it('renders the card — content, embed and action rows — inside the thread panel', () => {
    const store = makeCardStore({
      content: 'Run the deploy?',
      embeds: [{ title: 'Deploy prod', description: 'web · 3 commits' }],
      components: APPROVE_ROW,
    });
    render(<ThreadSidePanel threadId={THREAD} channelId={CHANNEL} store={store} threads={makeThreads(store)} />);

    const replies = screen.getByTestId('thread-replies');
    expect(replies.textContent).toContain('Run the deploy?');
    expect(within(replies).getByTestId('embed-title').textContent).toBe('Deploy prod');
    const block = within(replies).getByTestId('component-block');
    expect(block.getAttribute('data-message-id')).toBe(CARD_ID);
    const labels = within(block)
      .getAllByTestId('component-button')
      .map((b) => b.textContent);
    expect(labels).toEqual(['Approve', 'Deny']);
  });

  it('an embed-only card (no content) renders its embed and buttons', () => {
    const store = makeCardStore({
      content: '',
      embeds: [{ title: 'Clarify: which environment?' }],
      components: APPROVE_ROW,
    });
    render(<ThreadSidePanel threadId={THREAD} channelId={CHANNEL} store={store} threads={makeThreads(store)} />);

    const replies = screen.getByTestId('thread-replies');
    expect(within(replies).getByTestId('embed-title').textContent).toBe('Clarify: which environment?');
    expect(within(replies).getAllByTestId('component-button')).toHaveLength(2);
  });

  it('a click POSTs the card (parent channel + message), goes pending, and the thread-slice flip resolves it', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) =>
      String(url).includes('/interactions')
        ? jsonResponse(202, { interaction_id: '9300000000000009' })
        : jsonResponse(404, {}),
    );
    vi.stubGlobal('fetch', fetchMock);
    const store = makeCardStore({
      content: 'Run the deploy?',
      embeds: [{ title: 'Deploy prod' }],
      components: APPROVE_ROW,
    });
    render(<ThreadSidePanel threadId={THREAD} channelId={CHANNEL} store={store} threads={makeThreads(store)} />);

    const replies = screen.getByTestId('thread-replies');
    const approve = within(replies)
      .getAllByTestId('component-button')
      .find((b) => b.getAttribute('data-custom-id') === 'approve')!;
    await act(async () => {
      fireEvent.click(approve);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/interactions')) as
      | [string, RequestInit]
      | undefined;
    expect(call).toBeDefined();
    expect(JSON.parse(String(call![1].body))).toEqual({
      channel_id: CHANNEL,
      message_id: CARD_ID,
      custom_id: 'approve',
      component_type: 2,
      nonce: expect.any(String),
    });
    expect(approve.getAttribute('data-pending')).toBe('true');

    // The bot's type-7 flip: the card's MessageUpdate lands in the THREAD
    // slice — buttons replaced, embed swapped — and resolves the click.
    act(() => {
      applyGatewayEvent(store, {
        op: 0,
        t: 'MessageUpdate',
        s: 3,
        d: {
          id: CARD_ID,
          channel_id: CHANNEL,
          thread_id: THREAD,
          content: 'Run the deploy?',
          edited_at: '2026-08-30T12:03:00Z',
          components: RESOLVED_ROW,
          embeds: [{ title: 'Approved by me' }],
        },
      } as never);
    });

    await waitFor(() => {
      const button = within(screen.getByTestId('thread-replies')).getByTestId('component-button');
      expect(button.textContent).toBe('Approved');
      expect(button.getAttribute('disabled')).toBe('');
      expect(button.getAttribute('data-pending')).toBe(null);
    });
    expect(within(screen.getByTestId('thread-replies')).getByTestId('embed-title').textContent).toBe(
      'Approved by me',
    );
    expect(screen.queryByTestId('component-error')).toBeNull();
  });

  it("the bot's answer landing IN the thread resolves the click (type 4 / follow-up)", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) =>
      String(url).includes('/interactions')
        ? jsonResponse(202, { interaction_id: '9300000000000010' })
        : jsonResponse(404, {}),
    );
    vi.stubGlobal('fetch', fetchMock);
    const store = makeCardStore({ content: 'Pick one', components: APPROVE_ROW });
    render(<ThreadSidePanel threadId={THREAD} channelId={CHANNEL} store={store} threads={makeThreads(store)} />);

    const deny = within(screen.getByTestId('thread-replies'))
      .getAllByTestId('component-button')
      .find((b) => b.getAttribute('data-custom-id') === 'deny')!;
    await act(async () => {
      fireEvent.click(deny);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(deny.getAttribute('data-pending')).toBe('true');

    act(() => {
      applyGatewayEvent(store, {
        op: 0,
        t: 'ThreadMessageCreate',
        s: 4,
        d: {
          id: '1000000000000060',
          channel_id: CHANNEL,
          thread_id: THREAD,
          author_id: BOT,
          content: 'Denied — nothing ran.',
          created_at: '2026-08-30T12:04:00Z',
          edited_at: null,
        },
      } as never);
    });
    // The reply alone is not the answer; its InteractionSuccess is.
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/interactions')) as unknown as [
      string,
      RequestInit,
    ];
    const { nonce } = JSON.parse(String(call[1].body)) as { nonce: string };
    act(() => {
      receiveInteractionSuccess({
        interaction_id: '9300000000000010',
        nonce,
        application_id: BOT,
        channel_id: CHANNEL,
        thread_id: THREAD,
        message_id: CARD_ID,
        custom_id: 'deny',
        response_type: 4,
      });
    });

    await waitFor(() => {
      const button = within(screen.getByTestId('thread-replies'))
        .getAllByTestId('component-button')
        .find((b) => b.getAttribute('data-custom-id') === 'deny')!;
      expect(button.getAttribute('data-pending')).toBe(null);
    });
    expect(screen.getByTestId('thread-replies').textContent).toContain('Denied — nothing ran.');
  });

  it("a deferred answer (InteractionSuccess naming the thread) resolves a thread card's click", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) =>
      String(url).includes('/interactions')
        ? jsonResponse(202, { interaction_id: '9300000000000011' })
        : jsonResponse(404, {}),
    );
    vi.stubGlobal('fetch', fetchMock);
    const store = makeCardStore({ content: 'Run the deploy?', components: APPROVE_ROW });
    render(<ThreadSidePanel threadId={THREAD} channelId={CHANNEL} store={store} threads={makeThreads(store)} />);

    const approve = within(screen.getByTestId('thread-replies'))
      .getAllByTestId('component-button')
      .find((b) => b.getAttribute('data-custom-id') === 'approve')!;
    await act(async () => {
      fireEvent.click(approve);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(approve.getAttribute('data-pending')).toBe('true');

    const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/interactions')) as unknown as [
      string,
      RequestInit,
    ];
    const { nonce } = JSON.parse(String(call[1].body)) as { nonce: string };
    act(() => {
      receiveInteractionSuccess({
        interaction_id: '9300000000000011',
        nonce,
        application_id: BOT,
        channel_id: CHANNEL,
        thread_id: THREAD,
        message_id: CARD_ID,
        custom_id: 'approve',
        response_type: 6,
      });
    });

    await waitFor(() => expect(approve.getAttribute('data-pending')).toBe(null));
    expect(screen.queryByTestId('component-error')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// U3 — mobile thread sheet: ThreadSurface swaps the 380px dock for a
// full-width sheet below 768px; desktop dock stays byte-for-byte.
// ---------------------------------------------------------------------------

describe('ThreadSurface — mobile sheet vs desktop dock (U3)', () => {
  const WEB_ROOT = join(__dirname, '..', '..', '..', '..');
  function renderSurface(onClose = vi.fn()) {
    const store = makeStore();
    const threads = makeThreads(store);
    const view = render(
      <ThreadSurface
        threadId={THREAD}
        channelId={CHANNEL}
        store={store}
        threads={threads}
        parentMessage={PARENT}
        onClose={onClose}
      />,
    );
    return { onClose, threads, container: view.container };
  }

  afterEach(() => {
    mobileWidthState.mobile = false;
  });

  it('desktop width: the 380px thread-dock contract is untouched', () => {
    mobileWidthState.mobile = false;
    renderSurface();
    expect(screen.getByTestId('thread-dock')).toBeTruthy();
    expect(screen.getByTestId('thread-side-panel')).toBeTruthy();
    expect(screen.queryByTestId('thread-sheet')).toBeNull();
  });

  it('mobile width: the thread renders as a full-width sheet OVER the pane, with a back-to-channel close', () => {
    mobileWidthState.mobile = true;
    const { onClose } = renderSurface();
    const sheet = screen.getByTestId('thread-sheet');
    expect(sheet).toBeTruthy();
    expect(screen.getByTestId('thread-sheet-overlay')).toBeTruthy();
    // The full panel content rides inside the sheet.
    expect(sheet.contains(screen.getByTestId('thread-side-panel'))).toBe(true);
    expect(screen.getByTestId('thread-replies').textContent).toContain('a reply');

    // Back to channel: the panel's existing ✕ closes the surface.
    fireEvent.click(screen.getByTestId('thread-close'));
    expect(onClose).toHaveBeenCalledTimes(1);

    // Escape routes through the same close seam.
    fireEvent.keyDown(sheet, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('mobile width: Escape inside an open composer palette dismisses the palette, not the sheet', () => {
    mobileWidthState.mobile = true;
    const { onClose } = renderSurface();
    const sheet = screen.getByTestId('thread-sheet');
    // Radix hears Escape at the document first; an open combobox (the
    // composer with its `@`/`#` palette up) keeps the key for the palette.
    const combo = document.createElement('div');
    combo.setAttribute('role', 'combobox');
    combo.setAttribute('aria-expanded', 'true');
    combo.tabIndex = 0;
    sheet.appendChild(combo);
    fireEvent.keyDown(combo, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('thread-sheet')).toBeTruthy();
    // Palette closed → Escape closes the sheet again.
    combo.setAttribute('aria-expanded', 'false');
    fireEvent.keyDown(combo, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stylesheet pin: the sheet is full-width and bottom-anchored INSIDE the mobile breakpoint; the dock keeps its 380px', () => {
    const css = readFileSync(join(WEB_ROOT, 'src', 'app', 'theme', 'shell.css'), 'utf8');
    const mobileBlock = css.slice(css.indexOf('@media (max-width: 767px)'));
    const sheetBlock = mobileBlock.slice(mobileBlock.indexOf('.thread-sheet'));
    expect(sheetBlock).not.toBe('');
    expect(sheetBlock).toContain('position: fixed');
    expect(sheetBlock).toContain('left: 0');
    expect(sheetBlock).toContain('right: 0');
    expect(sheetBlock).toContain('bottom: 0');

    // Desktop dock contract: width var + flex-shrink 0, untouched.
    const dockRule = css.slice(css.indexOf('.thread-dock {'), css.indexOf('}', css.indexOf('.thread-dock {')));
    expect(dockRule).toContain('flex-shrink: 0');
    expect(dockRule).toContain('380px');
  });

  it('axe: the mobile thread sheet has no violations', async () => {
    mobileWidthState.mobile = true;
    const { container } = renderSurface();
    expect(await axe(document.body)).toHaveNoViolations();
  });
});

describe('ThreadSidePanel — follow toggle failure surface', () => {
  it('a failed unfollow shows an inline alert instead of silently doing nothing', async () => {
    const store = makeStore();
    const threads = makeThreads(store);
    (threads.unfollow as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('404'));
    render(
      <ThreadSidePanel threadId={THREAD} channelId={CHANNEL} store={store} threads={threads} />,
    );

    await openThreadOptions();
    await act(async () => {
      fireEvent.click(screen.getByTestId('thread-option-follow'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('thread-follow-error').textContent).toMatch(/couldn't update/i);
    });
    expect(screen.getByTestId('thread-follow-error').getAttribute('role')).toBe('alert');
  });

  it('a successful toggle leaves no error behind', async () => {
    const store = makeStore();
    const threads = makeThreads(store);
    render(
      <ThreadSidePanel threadId={THREAD} channelId={CHANNEL} store={store} threads={threads} />,
    );
    await openThreadOptions();
    await act(async () => {
      fireEvent.click(screen.getByTestId('thread-option-follow'));
    });
    expect(screen.queryByTestId('thread-follow-error')).toBeNull();
  });
});

describe('ThreadSidePanel — options menu (Mark Unread / Leave Thread)', () => {
  it('Mark Unread calls the hook and closes the menu', async () => {
    const store = makeStore();
    const threads = makeThreads(store);
    render(
      <ThreadSidePanel threadId={THREAD} channelId={CHANNEL} store={store} threads={threads} />,
    );
    await act(async () => {
      await userEvent.setup().click(screen.getByTestId('thread-ellipsis'));
    });
    expect(screen.getByTestId('thread-options-menu')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTestId('thread-option-mark-unread'));
    });
    expect(threads.markUnread).toHaveBeenCalledWith(THREAD);
    expect(screen.queryByTestId('thread-options-menu')).toBeNull();
  });

  it('Leave Thread leaves and closes the panel', async () => {
    const store = makeStore();
    const threads = makeThreads(store);
    const onClose = vi.fn();
    render(
      <ThreadSidePanel
        threadId={THREAD}
        channelId={CHANNEL}
        store={store}
        threads={threads}
        onClose={onClose}
      />,
    );
    await act(async () => {
      await userEvent.setup().click(screen.getByTestId('thread-ellipsis'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('thread-option-leave'));
    });
    expect(threads.leave).toHaveBeenCalledWith(THREAD);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('a failed leave surfaces the inline alert instead of closing', async () => {
    const store = makeStore();
    const threads = makeThreads(store);
    (threads.leave as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('nope'));
    const onClose = vi.fn();
    render(
      <ThreadSidePanel
        threadId={THREAD}
        channelId={CHANNEL}
        store={store}
        threads={threads}
        onClose={onClose}
      />,
    );
    await act(async () => {
      await userEvent.setup().click(screen.getByTestId('thread-ellipsis'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('thread-option-leave'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('thread-follow-error').textContent).toMatch(/couldn't leave/i),
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// #109 — archive
//
// The write is the server's (creator-or-moderator); this asserts the CLIENT
// half: who is offered the control, what the pane says while a thread is
// archived, and that a failure is visible rather than swallowed.
// ---------------------------------------------------------------------------
describe('ThreadSidePanel — archive (#109)', () => {
  const openMenu = async () => {
    await act(async () => {
      await userEvent.setup().click(screen.getByTestId('thread-ellipsis'));
    });
  };

  it('the creator is offered Archive Thread, and it calls the hook', async () => {
    const store = makeStore();
    const threads = makeThreads(store);
    render(
      <ThreadSidePanel threadId={THREAD} channelId={CHANNEL} store={store} threads={threads} />,
    );

    // Nothing to notice yet: an active thread says nothing about archiving.
    expect(screen.queryByTestId('thread-archived-notice')).toBeNull();

    await openMenu();
    const item = screen.getByTestId('thread-option-archive');
    expect(item.textContent).toMatch(/^Archive Thread$/);

    await act(async () => {
      fireEvent.click(item);
    });
    expect(threads.archive).toHaveBeenCalledWith(THREAD, true);
    expect(screen.queryByTestId('thread-options-menu')).toBeNull();
  });

  it('an archived thread shows the notice, offers Unarchive, and does not close', async () => {
    const store = makeStore();
    store.setState((s) => ({
      threadsById: { ...s.threadsById, [THREAD]: { ...s.threadsById[THREAD]!, archived: true } },
    }));
    const threads = makeThreads(store);
    const onClose = vi.fn();
    render(
      <ThreadSidePanel
        threadId={THREAD}
        channelId={CHANNEL}
        store={store}
        threads={threads}
        onClose={onClose}
      />,
    );

    // The pane stays OPEN and explains itself — a surface that vanishes under
    // the cursor is worse than one that says what happened.
    expect(screen.getByTestId('thread-archived-notice')).toBeTruthy();

    await openMenu();
    const item = screen.getByTestId('thread-option-archive');
    expect(item.textContent).toMatch(/^Unarchive Thread$/);

    await act(async () => {
      fireEvent.click(item);
    });
    expect(threads.archive).toHaveBeenCalledWith(THREAD, false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a thread someone else created offers no archive control', async () => {
    const store = makeStore();
    store.setState((s) => ({
      threadsById: { ...s.threadsById, [THREAD]: { ...s.threadsById[THREAD]!, created_by: '7000000000000009' } },
    }));
    const threads = makeThreads(store);
    render(
      <ThreadSidePanel threadId={THREAD} channelId={CHANNEL} store={store} threads={threads} />,
    );

    await openMenu();
    // The menu is open (Mark Unread is there) — the archive item alone is absent.
    expect(screen.getByTestId('thread-option-mark-unread')).toBeTruthy();
    expect(screen.queryByTestId('thread-option-archive')).toBeNull();
  });

  it('is a real menu: focus enters it, arrows rove, Escape returns focus to ⋯', async () => {
    const store = makeStore();
    const threads = makeThreads(store);
    render(<ThreadSidePanel threadId={THREAD} channelId={CHANNEL} store={store} threads={threads} />);
    const user = userEvent.setup();
    const trigger = screen.getByTestId('thread-ellipsis');
    trigger.focus();
    await user.keyboard('{Enter}');
    const menu = screen.getByTestId('thread-options-menu');
    expect(menu.getAttribute('role')).toBe('menu');
    await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));
    await user.keyboard('{ArrowDown}');
    expect(menu.contains(document.activeElement)).toBe(true);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('thread-options-menu')).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it('a failed archive surfaces the inline alert', async () => {
    const store = makeStore();
    const threads = makeThreads(store);
    (threads.archive as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('nope'));
    render(
      <ThreadSidePanel threadId={THREAD} channelId={CHANNEL} store={store} threads={threads} />,
    );

    await openMenu();
    await act(async () => {
      fireEvent.click(screen.getByTestId('thread-option-archive'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('thread-follow-error').textContent).toMatch(/couldn't archive/i),
    );
  });
});

// ---------------------------------------------------------------------------
// #104 — the thread unread rule
//
// The e2e leg covers the NO-unread case (it lands at the newest, no rule). The
// positive case is asserted here instead: overriding `firstUnreadId` is exactly
// what the capture in `openThread` produces when a reply arrived while the
// client was open, and a unit test states it deterministically rather than
// depending on a browser, a second actor and the timing of a live event.
// ---------------------------------------------------------------------------
describe('thread unread rule (#104)', () => {
  const REPLY_ID = '1000000000000002';

  function renderWith(firstUnreadId: () => string | null) {
    const store = makeStore();
    const threads: UseThreads = { ...makeThreads(store), firstUnreadId };
    return render(
      <ThreadSurface
        threadId={THREAD}
        channelId={CHANNEL}
        store={store}
        threads={threads}
        parentMessage={PARENT}
        onClose={vi.fn()}
      />,
    );
  }

  it('draws the rule BEFORE the first unread reply', () => {
    renderWith(() => REPLY_ID);
    expect(screen.getByTestId('unread-divider')).toBeTruthy();
    // Precedence, not just presence: a rule that renders after the reply it
    // marks puts the boundary on the wrong side of the message.
    const html = screen.getByTestId('thread-replies').innerHTML;
    const ruleAt = html.indexOf('unread-divider');
    const replyAt = html.indexOf(REPLY_ID);
    expect(replyAt, 'the reply is in the region at all').toBeGreaterThan(-1);
    expect(ruleAt).toBeLessThan(replyAt);
  });

  it('draws NO rule when there is nothing unread', () => {
    renderWith(() => null);
    expect(screen.getByTestId('thread-replies')).toBeTruthy();
    expect(screen.queryByTestId('unread-divider')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #114/#118 — Copy Link on a reply
//
// The panel renders the same `MessageItem` the channel pane does, but it is NOT
// `MessageList`: it has no copy state of its own until this seam, and it must
// never reach into the list's (the list hosts its confirmation above its own
// windowing boundary, owned by whoever asked). So these tests pin three things
// the shape of the feature depends on:
//
//   * the reply mints `(channel_id, message.id)` — the reply's PARENT channel,
//     which is `CHANNEL` and never `THREAD` (proved by taking the stored row
//     from a real `ThreadMessageCreate` dispatch, not a hand-built fixture);
//   * the clipboard gets the opaque `/m/<token>` form, no `#` and no ids;
//   * a failed mint is announced by a `role="status"` notice OWNED BY THE PANEL
//     and writes nothing — the loud-failure trade the channel pane already made.
// ---------------------------------------------------------------------------
describe('ThreadSidePanel — Copy Link on a reply (#114/#118)', () => {
  const REPLY_ID = '1000000000000002';
  /** A token shaped exactly like a minted one (30 base62 characters). */
  const TOKEN = '3kQm9Xb2Qp7ZtR4vN8wY1cKdQ3uP';

  /** The reply's row in the panel (the pinned parent is a different row). */
  function replyRow(): HTMLElement {
    const row = screen.getByTestId('thread-replies').querySelector<HTMLElement>(
      `[data-message-id="${REPLY_ID}"]`,
    );
    expect(row).not.toBeNull();
    // The toolbar mounts on the row's first hover (#14).
    revealMessageActions(row!);
    return row!;
  }

  it('offers Copy Link on the reply and mints it with the PARENT channel id', async () => {
    const store = makeStore();
    const threads = makeThreads(store);

    // The proof that `channel_id` is the PARENT channel, taken from the store
    // the way the wire delivers it: `makeStore` dispatches ThreadCreate
    // (channel_id = CHANNEL) and then a real ThreadMessageCreate, so the row's
    // channel_id is stamped by the store's own rule — and the thread id is a
    // different value, which is what makes the assertion mean something.
    const row = store
      .getState()
      .messagesByThread[THREAD]?.items.find((m) => m.id === REPLY_ID);
    expect(row?.channel_id).toBe(CHANNEL);
    expect(row?.channel_id).not.toBe(THREAD);

    const writeText = vi.fn(async () => undefined);
    const mint = vi.fn(async () => ({ token: TOKEN }));

    render(
      <ThreadSidePanel
        threadId={THREAD}
        channelId={CHANNEL}
        store={store}
        threads={threads}
        parentMessage={PARENT}
        clipboardWriter={writeText}
        permalinkMinter={mint}
      />,
    );

    const button = within(replyRow()).getByTestId('action-copy-link');
    await act(async () => {
      button.click();
    });

    // ONE round trip, carrying the pair the server keys the token with: the
    // parent channel, never the thread.
    expect(mint).toHaveBeenCalledTimes(1);
    expect(mint).toHaveBeenCalledWith(CHANNEL, REPLY_ID);

    // The EXACT string a second browser opens: the origin, the page path, the
    // token. No hash, no grammar, no ids.
    const expected = `${globalThis.location.origin}/m/${TOKEN}`;
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expected));
    expect(expected).not.toContain('#');
    expect(expected).not.toContain(CHANNEL);
    expect(expected).not.toContain(REPLY_ID);
    expect(expected).not.toContain(THREAD);

    // The confirmation is announced — by the LIST's notice, the same one a
    // channel row's copy uses (#15: one row, one set of affordances) — and it
    // is NOT inside the hover toolbar
    // (which is `hidden` while the pointer is away — a notice that vanished
    // with the row would be the silent copy the ticket calls a bug report).
    const notice = await screen.findByTestId('copy-link-notice');
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.textContent).toBe('Link copied');
    expect(notice.closest('[data-testid="message-actions"]')).toBeNull();
  });

  it('reports a failed mint as a failure and writes nothing to the clipboard', async () => {
    const store = makeStore();
    const threads = makeThreads(store);
    const writeText = vi.fn(async () => undefined);
    const mint = vi.fn(async () => {
      throw new Error('offline');
    });

    render(
      <ThreadSidePanel
        threadId={THREAD}
        channelId={CHANNEL}
        store={store}
        threads={threads}
        parentMessage={PARENT}
        clipboardWriter={writeText}
        permalinkMinter={mint}
      />,
    );

    const copy = within(replyRow()).getByTestId('action-copy-link');
    await act(async () => {
      copy.click();
    });

    const notice = await screen.findByTestId('copy-link-notice');
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.textContent).toMatch(/could not copy/i);
    // Not "nothing on the clipboard silently": nothing at all, and the user was
    // told. A stale/legacy fallback URL is exactly what is NOT allowed.
    expect(writeText).not.toHaveBeenCalled();
  });

  it('the control is a real keyboard-reachable button with an accessible name', () => {
    const store = makeStore();
    const threads = makeThreads(store);
    render(
      <ThreadSidePanel
        threadId={THREAD}
        channelId={CHANNEL}
        store={store}
        threads={threads}
        parentMessage={PARENT}
        clipboardWriter={vi.fn(async () => undefined)}
        permalinkMinter={vi.fn(async () => ({ token: TOKEN }))}
      />,
    );

    // Queried BY ROLE + NAME: that is the accessibility contract, not the
    // testid. The panel's other actions (bell, ⋯, ✕) are the model: real
    // buttons, named, in the tab order.
    const button = within(replyRow()).getByRole('button', {
      name: 'Copy link to message',
    });
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.getAttribute('aria-hidden')).toBeNull();
    expect(button.tabIndex).toBe(0);
    // The panel's own controls are the model for the shape, so this one is
    // reachable exactly when they are.
    expect(screen.getByTestId('thread-close').tabIndex).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// #128 — mentions resolve, and the typing line renders, in the thread pane
//
// The panel renders the SAME `MessageItem` the channel list does, but it built
// no mention resolver of its own, so every `<@snowflake>` in an origin or a
// reply fell back to the raw id in the pill. The fix builds the SHARED chain
// (mentionResolver.ts — the exact chain MessageList passes to its rows) over
// the panel's members projection, and the same panel is where the typing line
// has to be observable: the composer inside it owns the indicator, keyed by
// the thread scope.
// ---------------------------------------------------------------------------
describe('ThreadSidePanel — mention pills + typing line (#128)', () => {
  const ALICE = '7000000000000101';
  const STRANGER = '7000000000000199';
  const REPLY_ID = '1000000000000002';

  /** Store with a rostered member and a reply that mentions her + a stranger. */
  function makeMentionStore(): StateStore {
    const store = createStateStore();
    store.setState({ currentUser: { id: ME, username: 'me' } });
    store.setState({
      membersById: {
        [ALICE]: {
          id: ALICE,
          username: 'alice_h',
          display_name: 'Alice',
          nickname: null,
          joined_at: '2026-01-01T00:00:00Z',
          roles: [],
        },
      },
    });
    applyGatewayEvent(store, {
      op: 0,
      t: 'ThreadCreate',
      s: 1,
      d: { id: THREAD, channel_id: CHANNEL, name: 'origin message', created_by: ME, created_at: '2026-08-30T12:00:00Z' },
    } as never);
    applyGatewayEvent(store, {
      op: 0,
      t: 'ThreadMessageCreate',
      s: 2,
      d: {
        id: REPLY_ID,
        thread_id: THREAD,
        author_id: '7000000000000007',
        content: `hey <@${ALICE}> and <@${STRANGER}>`,
        created_at: '2026-08-30T12:01:00Z',
        edited_at: null,
      },
    } as never);
    return store;
  }

  const MENTION_PARENT: Message = {
    ...PARENT,
    content: `origin for <@${ALICE}>`,
  };

  it('renders roster display-name pills in thread REPLIES, not the raw id', () => {
    const store = makeMentionStore();
    const threads = makeThreads(store);
    render(
      <ThreadSidePanel
        threadId={THREAD}
        channelId={CHANNEL}
        store={store}
        threads={threads}
        parentMessage={PARENT}
      />,
    );

    const reply = screen
      .getByTestId('thread-replies')
      .querySelector<HTMLElement>(`[data-message-id="${REPLY_ID}"]`);
    expect(reply).not.toBeNull();
    // The rostered member resolves to her NICKNAME — the same chain the
    // channel list uses (nickname → username → session self).
    const pills = reply!.querySelectorAll('.mention');
    expect(pills).toHaveLength(2);
    expect(pills[0]!.getAttribute('data-user-id')).toBe(ALICE);
    expect(pills[0]!.textContent).toBe('@Alice');
    // An id with no roster row stays the raw snowflake — the honest fallback
    // (undefined leaves the id showing), not a crash or a blank.
    expect(pills[1]!.getAttribute('data-user-id')).toBe(STRANGER);
    expect(pills[1]!.textContent).toBe(`@${STRANGER}`);
  });

  it('resolves mentions in the pinned ORIGIN message through the same chain', () => {
    const store = makeMentionStore();
    const threads = makeThreads(store);
    render(
      <ThreadSidePanel
        threadId={THREAD}
        channelId={CHANNEL}
        store={store}
        threads={threads}
        parentMessage={MENTION_PARENT}
      />,
    );

    const pill = screen
      .getByTestId('thread-parent-pin')
      .querySelector('.mention');
    expect(pill).not.toBeNull();
    expect(pill!.getAttribute('data-user-id')).toBe(ALICE);
    expect(pill!.textContent).toBe('@Alice');
  });

  it('falls back to the session self for an unrostered self-mention', () => {
    const store = makeMentionStore();
    store.setState((s) => ({
      messagesByThread: {
        ...s.messagesByThread,
        [THREAD]: {
          ...s.messagesByThread[THREAD]!,
          items: s.messagesByThread[THREAD]!.items.map((m) =>
            m.id === REPLY_ID ? { ...m, content: `note to self <@${ME}>` } : m,
          ),
        },
      },
    }));
    const threads = makeThreads(store);
    render(
      <ThreadSidePanel
        threadId={THREAD}
        channelId={CHANNEL}
        store={store}
        threads={threads}
        parentMessage={PARENT}
      />,
    );

    const pill = screen
      .getByTestId('thread-replies')
      .querySelector('.mention');
    // The session record is the second link of the chain: the author of your
    // own mention still gets a name, never a snowflake.
    expect(pill!.textContent).toBe('@me');
  });

  it('renders the typing line inside the pane from THREAD-scoped typing data', () => {
    const store = makeMentionStore();
    const threads = makeThreads(store);
    // The composer consults its typing source with the pane's scope: the
    // PARENT channel + the thread id. Only that exact pair may light the line.
    const typists = vi.fn((_channelId: string, threadId?: string | null) =>
      threadId === THREAD ? [{ userId: ALICE, lastTypedAt: 1 }] : [],
    );
    const typing: UseTyping = { typists, sendTyping: vi.fn() };
    render(
      <ThreadSidePanel
        threadId={THREAD}
        channelId={CHANNEL}
        store={store}
        threads={threads}
        parentMessage={PARENT}
        typing={typing}
      />,
    );

    // The THREAD scope is what was consulted — a channel-only lookup would
    // key a different bucket and render nowhere.
    expect(typists).toHaveBeenCalledWith(CHANNEL, THREAD);
    // The line lives inside the pane's composer, and the typist's name
    // resolves through the panel's own members projection.
    const line = screen.getByTestId('typing-line');
    expect(line.closest('[data-testid="thread-side-panel"]')).not.toBeNull();
    expect(screen.getByTestId('typing-indicator').textContent).toContain('Alice');
  });

  it('shows no typing line when nobody is typing in the thread', () => {
    const store = makeMentionStore();
    const threads = makeThreads(store);
    render(
      <ThreadSidePanel
        threadId={THREAD}
        channelId={CHANNEL}
        store={store}
        threads={threads}
        parentMessage={PARENT}
        typing={{ typists: () => [], sendTyping: vi.fn() }}
      />,
    );
    // The line reserves nothing (owner direction 2026-09-14): a quiet thread
    // has no line in its document at all.
    expect(screen.queryByTestId('typing-line')).toBeNull();
  });
});


// ---------------------------------------------------------------------------
// #15 — the thread's replies ARE the channel's rows, virtualized and paged
// ---------------------------------------------------------------------------
describe('ThreadSidePanel — replies are channel rows (#15)', () => {
  const ALICE = '7000000000000101';
  const REPLY = '1000000000000002';

  function richStore(): StateStore {
    const store = makeStore();
    store.setState((s) => ({
      membersById: {
        ...s.membersById,
        [ALICE]: {
          id: ALICE,
          username: 'alice',
          nickname: 'Alice A',
          avatar_url: '/avatars/alice.png',
          joined_at: '2026-08-01T00:00:00Z',
          roles: [],
        } as never,
      },
    }));
    mergeThreadMessages(store, THREAD, [
      {
        id: '1000000000000003',
        channel_id: CHANNEL,
        thread_id: THREAD,
        author_id: ALICE,
        content: 'with a picture',
        created_at: '2026-08-30T12:02:00Z',
        edited_at: null,
        attachments: [
          {
            id: '2000000000000001',
            message_id: '1000000000000003',
            filename: 'pic.png',
            content_type: 'image/png',
            size: 10,
            url: '/api/v1/attachments/pic.png',
          },
        ],
        reactions: [{ emoji: '👍', count: 2, me: false }],
      } as never,
    ]);
    return store;
  }

  it('renders avatar, @tag, attachments and reactions on a reply — the channel row', () => {
    const store = richStore();
    render(
      <ThreadSidePanel
        threadId={THREAD}
        channelId={CHANNEL}
        store={store}
        threads={makeThreads(store)}
        parentMessage={PARENT}
      />,
    );
    const row = screen
      .getByTestId('thread-replies')
      .querySelector<HTMLElement>('[data-message-id="1000000000000003"]')!;
    expect(row).not.toBeNull();
    expect(within(row).getByTestId('message-author').textContent).toBe('Alice A');
    expect(within(row).getByTestId('message-author-tag').textContent).toBe('@alice');
    expect(row.querySelector('img[src$="/avatars/alice.png"]')).not.toBeNull();
    expect(within(row).getByTestId('attachment-image')).toBeTruthy();
    expect(within(row).getByTestId('reaction-chip').textContent).toContain('2');
    // Not the compact transcript row: the channel's own type size.
    expect(within(row).getByTestId('message-content').className).toContain('text-base');
    // The list is in THREAD mode over the thread's own window.
    expect(screen.getByTestId('message-list').getAttribute('data-thread-id')).toBe(THREAD);
  });

  it('a reaction on a reply goes to the API and lands on the THREAD row', async () => {
    const store = richStore();
    authStore.getState().setUser({
      id: ME,
      username: 'me',
      email: 'me@example.com',
      email_verified_at: '2026-08-30T00:00:00Z',
    } as never);
    const add = vi.spyOn(api, 'addReaction').mockResolvedValue(undefined as never);
    render(
      <ThreadSidePanel
        threadId={THREAD}
        channelId={CHANNEL}
        store={store}
        threads={makeThreads(store)}
        parentMessage={PARENT}
      />,
    );
    const row = screen
      .getByTestId('thread-replies')
      .querySelector<HTMLElement>('[data-message-id="1000000000000003"]')!;
    await act(async () => {
      within(row).getByTestId('reaction-chip').click();
    });
    expect(add).toHaveBeenCalledWith(CHANNEL, '1000000000000003', '👍');
    const reply = store
      .getState()
      .messagesByThread[THREAD]!.items.find((m) => m.id === '1000000000000003') as {
      reactions?: Array<{ emoji: string; count: number; me: boolean }>;
    };
    expect(reply.reactions).toEqual([{ emoji: '👍', count: 3, me: true }]);
  });

  it('offers edit and delete on your own reply', () => {
    const store = makeStore();
    mergeThreadMessages(store, THREAD, [
      {
        id: '1000000000000004',
        channel_id: CHANNEL,
        thread_id: THREAD,
        author_id: ME,
        content: 'mine',
        created_at: '2026-08-30T12:03:00Z',
        edited_at: null,
      },
    ]);
    render(
      <ThreadSidePanel
        threadId={THREAD}
        channelId={CHANNEL}
        store={store}
        threads={makeThreads(store)}
        parentMessage={PARENT}
      />,
    );
    const row = screen
      .getByTestId('thread-replies')
      .querySelector<HTMLElement>('[data-message-id="1000000000000004"]')!;
    fireEvent.pointerEnter(row);
    expect(within(row).getByTestId('action-edit')).toBeTruthy();
    expect(within(row).getByTestId('action-delete')).toBeTruthy();
    // Replies do not seed threads.
    expect(within(row).queryByTestId('action-start-thread')).toBeNull();
  });

  it('pages OLDER replies through the thread read when the reader scrolls up', async () => {
    const store = makeStore();
    // The thread holds 60 replies; the window has only the newest one.
    store.setState((s) => ({
      threadsById: { ...s.threadsById, [THREAD]: { ...s.threadsById[THREAD]!, message_count: 60 } },
    }));
    const older = Array.from({ length: 50 }, (_, i) => ({
      id: String(1000000000000001 - i - 1),
      channel_id: CHANNEL,
      thread_id: THREAD,
      author_id: ME,
      content: `older ${i}`,
      created_at: '2026-08-30T11:00:00Z',
      edited_at: null,
    }));
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        urls.push(String(input));
        return jsonResponse(200, { messages: older, oldest_id: older.at(-1)!.id });
      }),
    );
    render(
      <ThreadSidePanel
        threadId={THREAD}
        channelId={CHANNEL}
        store={store}
        threads={makeThreads(store)}
        parentMessage={PARENT}
      />,
    );
    // Not at the start yet: the origin is not shown above a partial window.
    expect(screen.queryByTestId('thread-parent-pin')).toBeNull();
    const startReached = virtuosoMockState.lastProps!.startReached as () => void;
    await act(async () => {
      startReached();
    });
    await waitFor(() =>
      expect(store.getState().messagesByThread[THREAD]!.items.length).toBe(51),
    );
    expect(urls.some((u) => u.includes(`/threads/${THREAD}/messages`) && u.includes('before=1000000000000002'))).toBe(true);
  });

  it('shows the shared skeleton while the first page loads, and the shared error + Retry when it fails', async () => {
    const store = createStateStore();
    store.setState({ currentUser: { id: ME, username: 'me' } });
    let fail: (() => void) | null = null;
    const loadReplies = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = () => reject(new Error('offline'));
        }),
    );
    const threads = { ...makeThreads(store), loadReplies };
    render(
      <ThreadSidePanel
        threadId={THREAD}
        channelId={CHANNEL}
        store={store}
        threads={threads}
        parentMessage={PARENT}
      />,
    );
    expect(screen.getByTestId('thread-loading').getAttribute('role')).toBe('progressbar');
    await act(async () => {
      fail!();
    });
    expect(await screen.findByTestId('thread-load-error')).toBeTruthy();
    loadReplies.mockImplementation(() => Promise.resolve());
    await act(async () => {
      screen.getByTestId('thread-load-retry').click();
    });
    await waitFor(() => expect(screen.queryByTestId('thread-load-error')).toBeNull());
    expect(loadReplies).toHaveBeenCalledTimes(2);
  });
});

/*
 * Bot attribution (2026-10-02). A bot (Hermes) started a thread on the
 * viewer's message and replied in it. The viewer's roster learned of the bot
 * only later — by the MemberAdd its owner's grant now emits — and before the
 * fix every lookup missed: the replies read as the bot's raw snowflake, and
 * the header, falling back to the seed message's author, said the VIEWER
 * started the thread. People and machines resolve through one resolver
 * (authorIdentity.ts); an unknown starter reads "Someone", never a wrong name.
 */
describe('ThreadSidePanel — who wrote it, who started it (bots resolve like people)', () => {
  const BOT = '99587434064379904';
  const BOT_REPLY = '1000000000000010';
  const BOT_AVATAR = '/api/v1/attachments/' + 'b'.repeat(64);

  function botThreadStore(createdBy: string, opts: { botInRoster: boolean }): StateStore {
    const store = createStateStore();
    store.setState({ currentUser: { id: ME, username: 'me' } });
    applyGatewayEvent(store, {
      op: 0,
      t: 'MemberAdd',
      s: 1,
      d: { workspace_id: '400', user: { id: ME, username: 'me' }, joined_at: '2026-08-01T00:00:00Z', kind: 'human' },
    } as never);
    if (opts.botInRoster) {
      // The grant's MemberAdd: the people row's shape (label, avatar, kind, owner).
      applyGatewayEvent(store, {
        op: 0,
        t: 'MemberAdd',
        s: 2,
        d: {
          workspace_id: '400',
          user: { id: BOT, username: 'hermes', display_name: 'Hermes', avatar_url: BOT_AVATAR },
          nickname: null,
          joined_at: '2026-10-02T00:00:00Z',
          roles: [],
          kind: 'bot',
          parent_user_id: ME,
          dm_support: 'humans',
        },
      } as never);
    }
    applyGatewayEvent(store, {
      op: 0,
      t: 'ThreadCreate',
      s: 3,
      d: {
        id: THREAD,
        channel_id: CHANNEL,
        name: 'Approval: deploy',
        created_by: createdBy,
        created_at: '2026-10-02T12:00:00Z',
        parent_message_id: PARENT.id,
      },
    } as never);
    applyGatewayEvent(store, {
      op: 0,
      t: 'ThreadMessageCreate',
      s: 4,
      d: {
        id: BOT_REPLY,
        thread_id: THREAD,
        channel_id: CHANNEL,
        author_id: BOT,
        content: 'Hermes needs your OK to run the deploy',
        created_at: '2026-10-02T12:00:01Z',
        edited_at: null,
      },
    } as never);
    return store;
  }

  function renderPanel(store: StateStore) {
    render(
      <ThreadSidePanel
        threadId={THREAD}
        channelId={CHANNEL}
        store={store}
        threads={makeThreads(store)}
        parentMessage={PARENT}
      />,
    );
  }

  it('a bot-authored reply shows the bot’s name, avatar and badge — never its snowflake', () => {
    renderPanel(botThreadStore(BOT, { botInRoster: true }));
    const row = screen
      .getByTestId('thread-replies')
      .querySelector(`[data-testid="message-item"][data-message-id="${BOT_REPLY}"]`) as HTMLElement;
    expect(row).toBeTruthy();
    expect(within(row).getByTestId('message-author').textContent).toBe('Hermes');
    expect(row.textContent).not.toContain(BOT);
    const avatar = within(row).getByTestId('message-avatar');
    expect(avatar.querySelector('img')?.getAttribute('src')).toContain('b'.repeat(64));
    const badge = within(avatar).getByTestId('kind-badge');
    expect(badge.getAttribute('data-kind')).toBe('bot');
    // "via <owner>": the owning person resolves through the same roster.
    expect(badge.getAttribute('title')).toContain('via me');
  });

  it('the header names the bot as the one who started the thread, not the viewer', () => {
    renderPanel(botThreadStore(BOT, { botInRoster: true }));
    const started = screen.getByTestId('thread-started-line');
    expect(started.textContent).toContain('Hermes started this thread');
    expect(started.querySelector('strong')?.textContent).toBe('Hermes');
  });

  it('an unknown starter reads "Someone started this thread" — never the viewer who wrote the seed', () => {
    renderPanel(botThreadStore(BOT, { botInRoster: false }));
    const started = screen.getByTestId('thread-started-line');
    expect(started.querySelector('strong')?.textContent).toBe('Someone');
    expect(started.textContent).toContain('Someone started this thread');
    expect(started.textContent).not.toContain('me started');
    expect(started.textContent).not.toContain(BOT);
  });

  it('a webhook reply is named and badged by the MESSAGE, not the roster row behind it', () => {
    const store = botThreadStore(BOT, { botInRoster: true });
    applyGatewayEvent(store, {
      op: 0,
      t: 'ThreadMessageCreate',
      s: 5,
      d: {
        id: '1000000000000011',
        thread_id: THREAD,
        channel_id: CHANNEL,
        // A webhook posting under an id the roster happens to know.
        author_id: ME,
        author_override: { username: 'CI Hook', kind: 'webhook' },
        content: 'build passed',
        created_at: '2026-10-02T12:00:02Z',
        edited_at: null,
      },
    } as never);
    renderPanel(store);
    const row = screen
      .getByTestId('thread-replies')
      .querySelector('[data-testid="message-item"][data-message-id="1000000000000011"]') as HTMLElement;
    expect(within(row).getByTestId('message-author').textContent).toBe('CI Hook');
    expect(within(row).getByTestId('kind-badge').getAttribute('data-kind')).toBe('webhook');
  });
});
