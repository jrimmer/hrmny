/**
 * MessageList interaction tests (plan 004 M6, R8).
 *
 * FlashList is replaced by a faithful stub so the list's callbacks can be
 * driven the way the native list drives them — `onStartReached` (the top of
 * this order = older history) and `onViewableItemsChanged` (the unread
 * divider's retirement). The stub renders every item through the SAME
 * `renderItem` the real list gets, so rows and the divider are still asserted
 * against real components. `MessageList.test.tsx` runs the real FlashList for
 * the render and prop contracts.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { View } from 'react-native';

import type { Message } from '@cytale/domain';

import { MessageList } from '../MessageList';
import { MESSAGE_PAGE_SIZE, type LoadMessagePage } from '../useChannelWindow';
import { IDS, makeMessage, makeStore, messageId, seedUnread, windowIds } from './support';

type PageParams = { before?: string; limit: number };

/** Props the stub captured on its last render (the real list's contract). */
const mockListProps: { current: Record<string, any> | null } = { current: null };

jest.mock('@shopify/flash-list', () => {
  const { View: RNView } = require('react-native');
  const React = require('react');
  return {
    FlashList: (props: Record<string, any>) => {
      mockListProps.current = props;
      const keyExtractor: (item: unknown, index: number) => string =
        props.keyExtractor ?? ((_item: unknown, index: number) => String(index));
      return (
        <RNView testID={props.testID}>
          {(props.data as unknown[]).map((item, index) =>
            React.cloneElement(props.renderItem({ item, index, target: 'Cell' }), {
              key: keyExtractor(item, index),
            }),
          )}
        </RNView>
      );
    },
  };
});

function fullPage(end: number, count = MESSAGE_PAGE_SIZE): Message[] {
  return Array.from({ length: count }, (_, index) => makeMessage(end - index));
}

beforeEach(() => {
  mockListProps.current = null;
});

describe('older history', () => {
  it('wires onStartReached to the before-cursor page and prepends it in place', async () => {
    const store = makeStore();
    const loadPage = jest.fn(async ({ before }: PageParams) =>
      before === undefined ? fullPage(100) : fullPage(50),
    );

    await render(<MessageList channelId={IDS.channel} store={store} loadPage={loadPage} />);
    await waitFor(() => expect(mockListProps.current).not.toBeNull());

    expect(mockListProps.current!.data).toHaveLength(50);
    const anchor = (mockListProps.current!.data as { message: Message }[])[0]!.message.id;
    expect(anchor).toBe(messageId(51));

    await act(async () => {
      (mockListProps.current!.onStartReached as () => void)();
    });

    await waitFor(() => expect(windowIds(store, IDS.channel)).toHaveLength(100));
    expect(loadPage).toHaveBeenLastCalledWith({ before: anchor, limit: MESSAGE_PAGE_SIZE });

    const data = (mockListProps.current!.data as { message: Message }[]).map((row) => row.message);
    expect(data.map((m) => m.id)).toEqual(
      Array.from({ length: 100 }, (_, index) => messageId(index + 1)),
    );
    // The anchor is still the same node, one page further down: the prepend
    // inserted above it and nothing was reordered or duplicated.
    expect(data.findIndex((m) => m.id === anchor)).toBe(50);
    expect(new Set(data.map((m) => m.id)).size).toBe(100);
  });

  it('shows progress while the older page is in flight and a retryable failure after', async () => {
    const store = makeStore();
    let rejectOlder: (error: Error) => void = () => undefined;
    const loadPage = jest.fn(async ({ before }: PageParams) => {
      if (before === undefined) return fullPage(50);
      return new Promise<Message[]>((_resolve, reject) => {
        rejectOlder = reject;
      });
    });

    await render(<MessageList channelId={IDS.channel} store={store} loadPage={loadPage} />);
    await waitFor(() => expect(mockListProps.current).not.toBeNull());

    await act(async () => {
      (mockListProps.current!.onStartReached as () => void)();
    });
    expect(screen.getByTestId('message-list-loading-older')).toBeTruthy();

    await act(async () => {
      rejectOlder(new Error('offline'));
    });

    await waitFor(() => expect(screen.getByTestId('message-list-older-error')).toBeTruthy());
    expect(screen.getByText('Could not load older messages. Try again.')).toBeTruthy();
    // The window is untouched by the failure.
    expect(mockListProps.current!.data).toHaveLength(50);

    // Retry re-issues the same cursor.
    await act(async () => {
      fireEvent.press(screen.getByTestId('message-list-older-retry'));
    });
    expect(loadPage).toHaveBeenCalledTimes(3);
    expect(loadPage).toHaveBeenLastCalledWith({ before: messageId(1), limit: MESSAGE_PAGE_SIZE });
  });
});

describe('unread divider retirement', () => {
  it('clears the rule and advances the watermark once the reader scrolls past', async () => {
    const store = makeStore();
    seedUnread(store, IDS.channel, { last_read_id: messageId(1), unread_count: 2 });
    const loadPage = jest.fn(async (_params: PageParams) => [
      makeMessage(3),
      makeMessage(2),
      makeMessage(1),
    ]);

    await render(<MessageList channelId={IDS.channel} store={store} loadPage={loadPage} />);
    await waitFor(() => expect(screen.getByTestId('unread-divider')).toBeTruthy());

    const viewable = (indexes: number[]) =>
      act(async () => {
        (
          mockListProps.current!.onViewableItemsChanged as (info: {
            viewableItems: { index: number | null }[];
          }) => void
        )({ viewableItems: indexes.map((index) => ({ index })) });
      });

    // Opens at the newest row: the divider is above the viewport but unseen.
    await viewable([2]);
    expect(screen.getByTestId('unread-divider')).toBeTruthy();

    // Scrolled up to the line.
    await viewable([1, 2]);
    expect(screen.getByTestId('unread-divider')).toBeTruthy();

    // Scrolled back down past it.
    await viewable([2]);
    expect(screen.queryByTestId('unread-divider')).toBeNull();
    expect(store.getState().unreadByChannel[IDS.channel]).toEqual({
      last_read_id: messageId(3),
      unread_count: 0,
      mention_count: 0,
    });
  });
});
