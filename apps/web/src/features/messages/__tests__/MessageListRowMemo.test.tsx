/**
 * @cytale/web — MessageList row re-render economy (plan 1.1, #137).
 *
 * `MessageItem` and `MessageList` are both `React.memo`'d, but a shallow memo
 * is only as good as the identity of the props it is handed. This file pins the
 * remaining fresh-object prop in `MessageList`'s row mapping: the active
 * `reactionError` used to be a new `{ emoji, message }` literal per
 * `itemContent` call, so the failing row re-rendered on every list render even
 * when nothing about the error changed.
 *
 * The counter is `renderMarkdownBlocks`, which runs inside the `MessageItem`
 * body on every render (the parse tree is memoized on content; the render is
 * not). Only `MessageItem` calls it in the production tree, so the count *is*
 * "how many row bodies ran".
 *
 * react-virtuoso needs real layout (jsdom has zero dimensions), so it is mocked
 * to render every item in order — the same idiom the main list suite uses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

import type { Message } from '@cytale/domain';
import { createStateStore, mergeChannelMessages, type StateStore } from '@cytale/state';

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

vi.mock('react-virtuoso', async () => {
  const React = await import('react');
  const Virtuoso = React.forwardRef(function Virtuoso(
    props: {
      data?: readonly unknown[];
      itemContent: (index: number, data: unknown) => React.ReactNode;
      computeItemKey?: (index: number, data: unknown) => string;
    },
    ref: React.Ref<unknown>,
  ) {
    React.useImperativeHandle(ref, () => ({
      scrollToIndex: () => {},
      scrollTo: () => {},
      scrollBy: () => {},
    }));
    const items = props.data ?? [];
    return (
      <div data-testid="virtuoso-mock">
        {items.map((item, i) => (
          <div key={props.computeItemKey?.(i, item) ?? i}>{props.itemContent(i, item)}</div>
        ))}
      </div>
    );
  });
  return { Virtuoso };
});

import { MessageList } from '../MessageList.js';

const CHANNEL = '9007199254740993';
const ME = '7000000000000002';
const OTHER = '7000000000000003';

function message(id: string, authorId: string, content: string): Message {
  return {
    id,
    channel_id: CHANNEL,
    thread_id: null,
    author_id: authorId,
    content,
    created_at: '2026-08-30T12:00:00Z',
    edited_at: null,
  };
}

const M1 = message('1000000000000101', ME, 'one');
const M2 = message('1000000000000102', OTHER, 'two');
const M3 = message('1000000000000103', ME, 'three');
const M4 = message('1000000000000104', OTHER, 'four');

/** A cached channel (so the open renders at once) whose refresh fails — the
 *  store writes are then only the ones this test makes. */
function makeStore(): StateStore {
  const store = createStateStore();
  store.setState({ currentUser: { id: ME, username: 'me' } });
  mergeChannelMessages(store, CHANNEL, [M3, M2, M1], { isLastPage: true });
  return store;
}

beforeEach(() => {
  counters.markdownRenders = 0;
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('MessageList — row memo identity', () => {
  it('an append re-runs only the new row, not the row carrying the reaction error', async () => {
    const store = makeStore();
    const onToggleReaction = vi.fn();
    // The SAME error object reference across the whole test: the list's prop
    // did not change, so the failing row's props must not either.
    const reactionError = { messageId: M2.id, emoji: '👍', message: 'nope' };

    render(
      <MessageList
        channelId={CHANNEL}
        store={store}
        currentUserId={ME}
        onToggleReaction={onToggleReaction}
        reactionError={reactionError}
      />,
    );

    await waitFor(() => {
      expect(screen.getAllByTestId('message-item').length).toBe(3);
    });
    // The failing row really is the one under test.
    expect(screen.getByTestId('reaction-error-message').textContent).toBe('nope');
    // Let the (failing) newest-page refresh settle before counting.
    await waitFor(() => {
      expect(screen.queryByTestId('list-error')).not.toBeNull();
    });
    const base = counters.markdownRenders;

    act(() => {
      mergeChannelMessages(store, CHANNEL, [M4], { isLastPage: true });
    });

    expect(await screen.findByText('four')).toBeTruthy();
    // EXACTLY the new row's body ran. Before the error object was memoized the
    // error row ran too (delta 2): its `{ emoji, message }` literal was new on
    // every `itemContent` call.
    expect(counters.markdownRenders).toBe(base + 1);
  });

  it('a change to the reaction error still reaches its row', async () => {
    const store = makeStore();
    const view = render(
      <MessageList
        channelId={CHANNEL}
        store={store}
        currentUserId={ME}
        onToggleReaction={vi.fn()}
        reactionError={{ messageId: M2.id, emoji: '👍', message: 'first failure' }}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('reaction-error-message').textContent).toBe('first failure');
    });

    // A NEW error object with a different message: the row must re-render and
    // show it — the memo must not freeze the error on screen.
    act(() => {
      view.rerender(
        <MessageList
          channelId={CHANNEL}
          store={store}
          currentUserId={ME}
          onToggleReaction={vi.fn()}
          reactionError={{ messageId: M2.id, emoji: '👍', message: 'second failure' }}
        />,
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId('reaction-error-message').textContent).toBe('second failure');
    });
  });
});
