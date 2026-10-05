/**
 * Thread list render cost + recycle typing (performance pass, P1/P3).
 *
 * The thread list is the channel list's twin: the same `MessageRow`, the same
 * derived-row contract, the same FlashList cell memoization on `renderItem`
 * identity. This suite pins the thread half of the refactor with the same
 * counters the channel suite uses — every `MessageRow` render body calls
 * `useLongPress`, so a counter in that module's test double counts row renders
 * exactly (a `React.memo` bail-out means the function never runs and the
 * counter does not move).
 *
 * The FlashList stub renders every data item through the SAME `renderItem` the
 * real list gets, which is the worst case a real list reaches whenever its
 * cells are re-mounted or its `renderItem` identity changes.
 */
import { act, render, screen, waitFor } from '@testing-library/react-native';

import type { Message } from '@cytale/domain';

import { mergeThreadMessages } from '../threadWindow';
import { ThreadMessageList } from '../ThreadMessageList';
import type { LoadThreadPage } from '../useThreadWindow';
import { IDS, makeReply, makeStore, replyId } from './support';

/** Hoisted-factory escape hatches: `jest.mock` bodies may close over these. */
var mockRowRenders = 0;
var mockListProps: { current: Record<string, any> | null } = { current: null };

jest.mock('../../messages/useLongPress', () => {
  const actual = jest.requireActual('../../messages/useLongPress');
  return {
    ...actual,
    useLongPress: (options: unknown) => {
      mockRowRenders += 1;
      return actual.useLongPress(options);
    },
  };
});

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

function page(...ns: number[]): Message[] {
  return ns.map((n) => makeReply(n));
}

async function renderThread(replies: Message[]) {
  const store = makeStore();
  const loadPage = jest.fn<ReturnType<LoadThreadPage>, [{ before?: string; limit: number }]>(
    async () => replies,
  );
  await render(
    <ThreadMessageList threadId={IDS.thread} store={store} loadPage={loadPage} onCopy={jest.fn()} />,
  );
  await waitFor(() => expect(screen.getByTestId(`message-row-${replyId(1)}`)).toBeTruthy());
  return { store, loadPage };
}

beforeEach(() => {
  mockRowRenders = 0;
  mockListProps.current = null;
});

describe('thread list render cost', () => {
  it('re-renders only the appended reply, not the whole window', async () => {
    const { store } = await renderThread(page(5, 4, 3, 2, 1));
    expect(mockRowRenders).toBe(5);

    // The cell-memo contract: FlashList v2 keys a cell's memo on `renderItem`
    // identity, so it MUST survive a window change (this is the half the row
    // memo alone cannot cover — the list re-renders either way).
    const before = mockListProps.current!;
    const renderItem = before.renderItem;
    const keyExtractor = before.keyExtractor;
    const getItemType = before.getItemType;

    // A reply lands through the thread window's own merge path.
    await act(async () => {
      mergeThreadMessages(store, IDS.thread, [makeReply(6)]);
    });

    expect(screen.getByTestId(`message-row-${replyId(6)}`)).toBeTruthy();
    expect(mockListProps.current!.renderItem).toBe(renderItem);
    expect(mockListProps.current!.keyExtractor).toBe(keyExtractor);
    expect(mockListProps.current!.getItemType).toBe(getItemType);
    expect(mockRowRenders).toBe(6);
  });

  it('classifies divider-bearing rows apart from plain content rows (getItemType)', async () => {
    await renderThread(page(3, 2, 1));

    const host = mockListProps.current!;
    const getItemType = host.getItemType as (item: unknown, index: number) => string;
    const data = host.data as unknown[];

    expect(typeof getItemType).toBe('function');
    // Chat order 1, 2, 3: row 0 opens the window's first day (a date rule),
    // rows 1-2 are plain content.
    expect(getItemType(data[0], 0)).toBe('divider');
    expect(getItemType(data[1], 1)).toBe('content');
    expect(getItemType(data[2], 2)).toBe('content');
  });
});
