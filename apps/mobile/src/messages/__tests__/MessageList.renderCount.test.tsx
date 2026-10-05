/**
 * MessageList render-cost regression (performance pass, P1).
 *
 * Before the fix, `MessageList`'s `renderItem` depended on `ordered` and built
 * fresh per-row closures (`onLongPress={() => openSheet(item.id)}`), so its
 * identity changed on every window change. FlashList v2 memoizes a cell on
 * `renderItem` identity (`recyclerview/ViewHolder.js`: `useMemo(..., [item,
 * extraData, target, renderItem])` plus a comparator requiring
 * `prevProps.renderItem === nextProps.renderItem`), which defeats that memo
 * for EVERY engaged cell — and `MessageRow` was a plain function that re-ran
 * `inlineRuns` in its render body, so each re-render re-parsed the markdown.
 *
 * This suite pins the fix at the two boundaries the row owns, with counters
 * that survive a memo bail-out:
 *
 *   * ROW RENDERS — every `MessageRow` render body calls `useLongPress`
 *     (unconditionally), so a counter in that module's test double counts row
 *     renders exactly: a `React.memo` bail-out means the function never runs
 *     and the counter does not move.
 *   * PARSES — a counter in the markdown renderer's test double. `useMemo`
 *     means a re-render would not re-parse, so this half is only satisfied by
 *     not re-rendering at all (the two assertions together pin both the memo
 *     boundary and the memoized parse).
 *
 * The FlashList stub renders every data item through the SAME `renderItem` the
 * real list gets — the worst case a real list reaches whenever its cells are
 * re-mounted or its `renderItem` identity changes. `MessageList.test.tsx`
 * covers the real-list render contract; `MessageList.actions.test.tsx` covers
 * the seams this refactor re-plumbed.
 */
import { act, render, screen, waitFor } from '@testing-library/react-native';

import type { Message } from '@cytale/domain';
import { mergeChannelMessages } from '@cytale/state';

import { MessageList } from '../MessageList';
import { IDS, makeMessage, makeStore, messageId, seedUnread } from './support';

/**
 * Counters the mocked modules bump. `jest.mock` factories are hoisted above
 * the imports and may only close over `mock`-prefixed bindings, which is why
 * these are `var`s with that prefix.
 */
var mockRowRenders = 0;
var mockParses = 0;
/** Props the FlashList stub captured on its last render (its prop contract). */
var mockListProps: { current: Record<string, any> | null } = { current: null };

jest.mock('../useLongPress', () => {
  const actual = jest.requireActual('../useLongPress');
  return {
    ...actual,
    // `MessageRow` calls this on every render, bail-out included.
    useLongPress: (options: unknown) => {
      mockRowRenders += 1;
      return actual.useLongPress(options);
    },
  };
});

jest.mock('../markdown', () => {
  const actual = jest.requireActual('../markdown');
  return {
    ...actual,
    inlineRuns: (text: string, resolveMention?: (id: string) => string | undefined) => {
      mockParses += 1;
      return actual.inlineRuns(text, resolveMention);
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
  return ns.map((n) => makeMessage(n));
}

beforeEach(() => {
  mockRowRenders = 0;
  mockParses = 0;
});

describe('inbound-message render cost', () => {
  it('re-renders (and re-parses) only the appended row, not the whole window', async () => {
    const store = makeStore();
    const loadPage = jest.fn(async (_params: { before?: string; limit: number }) =>
      page(5, 4, 3, 2, 1),
    );
    const onToggleReaction = jest.fn();

    await render(
      <MessageList
        channelId={IDS.channel}
        store={store}
        loadPage={loadPage}
        onToggleReaction={onToggleReaction}
        onReply={jest.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByTestId(`message-row-${messageId(5)}`)).toBeTruthy());

    // Five rows, five parses: one render + one parse per row on mount.
    expect(mockRowRenders).toBe(5);
    expect(mockParses).toBe(5);

    // The cell-memo contract: FlashList v2 keys a cell's memo on `renderItem`
    // identity, so it MUST survive a window change — that is what makes the
    // per-cell memo hold for every engaged cell.
    const before = mockListProps.current!;
    const renderItem = before.renderItem;
    const keyExtractor = before.keyExtractor;
    const getItemType = before.getItemType;

    // One inbound message lands (the gateway lane's path: the store merge).
    await act(async () => {
      mergeChannelMessages(store, IDS.channel, [makeMessage(6)], { isLastPage: false });
    });

    // The list DID take the new window (otherwise the assertions below could
    // pass because nothing re-rendered at all).
    expect(screen.getByTestId(`message-row-${messageId(6)}`)).toBeTruthy();
    expect(mockListProps.current!.renderItem).toBe(renderItem);
    expect(mockListProps.current!.keyExtractor).toBe(keyExtractor);
    expect(mockListProps.current!.getItemType).toBe(getItemType);

    // One new row render, one new parse — the five existing rows are untouched
    // (they were re-rendered before this fix: `renderItem`'s identity changed
    // with `ordered`, so FlashList's per-cell memo never held).
    expect({ renders: mockRowRenders, parses: mockParses }).toEqual({ renders: 6, parses: 6 });
  });

  it('classifies divider-bearing rows apart from plain content rows (getItemType)', async () => {
    const store = makeStore();
    seedUnread(store, IDS.channel, { last_read_id: messageId(1), unread_count: 2 });
    const loadPage = jest.fn(async (_params: { before?: string; limit: number }) =>
      page(3, 2, 1),
    );

    await render(<MessageList channelId={IDS.channel} store={store} loadPage={loadPage} />);
    await waitFor(() => expect(screen.getByTestId('message-list')).toBeTruthy());

    const host = mockListProps.current!;
    const getItemType = host.getItemType as (item: unknown, index: number) => string;
    const data = host.data as unknown[];

    expect(typeof getItemType).toBe('function');
    // Chat order 1, 2, 3: row 0 carries the date rule, row 1 opens the unread
    // run, row 2 is plain content — three pools, not one.
    expect(getItemType(data[0], 0)).toBe('divider');
    expect(getItemType(data[1], 1)).toBe('divider');
    expect(getItemType(data[2], 2)).toBe('content');
  });
});
