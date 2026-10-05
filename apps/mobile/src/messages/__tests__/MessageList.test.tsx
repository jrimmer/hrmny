/**
 * MessageList render tests (plan 004 M6, R8 + R15).
 *
 * The REAL FlashList runs here: these tests prove the rows, the grouping and
 * date cadence, the unread divider's placement, and the props FlashList needs
 * to anchor a prepend (`maintainVisibleContentPosition` + id keying). The
 * paging and divider-retirement interactions are driven through the list's
 * callbacks in `MessageList.paging.test.tsx`; the derivations themselves are
 * covered by `useChannelWindow.test.tsx`.
 *
 * The simulator is not available in this environment: scroll-offset
 * anchoring is asserted at the props/data contract level, not by scrolling.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';

import type { Message } from '@cytale/domain';

import { MessageList } from '../MessageList';
import type { LoadMessagePage } from '../useChannelWindow';
import { IDS, makeMessage, makeStore, messageId, seedUnread } from './support';

type PageParams = { before?: string; limit: number };

function page(...ns: number[]): Message[] {
  return ns.map((n) => makeMessage(n));
}

/**
 * The data index of the cell rendering a message. FlashList tags each cell
 * with its data `index`, which is how the tests read the list's order without
 * depending on the cell tree order (FlashList mounts the bottom cell first).
 */
function cellIndexFor(id: string): number | undefined {
  const cells = screen.root?.queryAll((node) => typeof node.props.index === 'number') ?? [];
  return cells.find((cell) => within(cell).queryByTestId(`message-row-${id}`) !== null)?.props
    .index as number | undefined;
}

describe('rendering', () => {
  it('renders the window in chat order with author names', async () => {
    const store = makeStore();
    const loadPage = jest.fn(async (_params: PageParams) => page(3, 2, 1));

    await render(<MessageList channelId={IDS.channel} store={store} loadPage={loadPage} />);

    await waitFor(() => expect(screen.getByTestId(`message-row-${messageId(1)}`)).toBeTruthy());
    for (const n of [1, 2, 3]) {
      expect(screen.getByTestId(`message-row-${messageId(n)}`)).toBeTruthy();
    }
    // Chat order: the oldest row holds index 0 and the newest the last index,
    // so the list opens on the newest row at the bottom (FlashList's cell
    // tree order is a rendering detail, the data index is the contract).
    expect(cellIndexFor(messageId(1))).toBe(0);
    expect(cellIndexFor(messageId(3))).toBe(2);
    // Same author, same day → one author line (continuation rows are compact).
    expect(screen.getAllByTestId('message-author')).toHaveLength(1);
    expect(screen.getByText('alice')).toBeTruthy();
    expect(screen.getByText('message 1')).toBeTruthy();
  });

  it('separates calendar days with a date rule and starts a new author group', async () => {
    const store = makeStore();
    const loadPage = jest.fn(async (_params: PageParams) => [
      makeMessage(2, { created_at: '2026-09-09T09:00:00.000Z' }),
      makeMessage(1, { created_at: '2026-09-08T09:00:00.000Z' }),
    ]);

    await render(<MessageList channelId={IDS.channel} store={store} loadPage={loadPage} />);
    await waitFor(() => expect(screen.getAllByTestId('date-divider')).toHaveLength(2));

    // The day change also un-groups the row (a new date rule, new author line).
    expect(screen.getAllByTestId('message-author')).toHaveLength(2);
  });

  it('hands FlashList the anchoring contract: id keying and MVCP', async () => {
    const store = makeStore();
    const loadPage = jest.fn(async (_params: PageParams) => page(2, 1));

    await render(<MessageList channelId={IDS.channel} store={store} loadPage={loadPage} />);
    await waitFor(() => expect(screen.getByTestId('message-list')).toBeTruthy());

    const host = screen.getByTestId('message-list');
    // Stable per-message keys are what MVCP anchors on. FlashList itself
    // consumes `data`, so the extractors are asserted against the derived row
    // shape the list hands over (its `data` is the row array).
    expect(host.props.keyExtractor({ message: makeMessage(7) })).toBe(messageId(7));
    expect(host.props.getItemType({ itemType: 'divider' })).toBe('divider');
    expect(host.props.maintainVisibleContentPosition).toMatchObject({
      startRenderingFromBottom: true,
      minIndexForVisible: 0,
    });
  });
});

describe('unread divider', () => {
  it('renders above the first message newer than the watermark', async () => {
    const store = makeStore();
    seedUnread(store, IDS.channel, { last_read_id: messageId(1), unread_count: 2 });
    const loadPage = jest.fn(async (_params: PageParams) => page(3, 2, 1));

    await render(<MessageList channelId={IDS.channel} store={store} loadPage={loadPage} />);

    await waitFor(() => expect(screen.getByTestId('unread-divider')).toBeTruthy());
    // It lives inside the row it precedes, so the line sits directly above
    // the first unread message — and nowhere else.
    const row = screen.getByTestId(`message-row-${messageId(2)}`);
    expect(within(row).getByTestId('unread-divider')).toBeTruthy();
    expect(
      within(screen.getByTestId(`message-row-${messageId(1)}`)).queryByTestId('unread-divider'),
    ).toBeNull();
  });

  it('renders no divider when the channel is caught up', async () => {
    const store = makeStore();
    seedUnread(store, IDS.channel, { last_read_id: messageId(3), unread_count: 0 });
    const loadPage = jest.fn(async (_params: PageParams) => page(3, 2, 1));

    await render(<MessageList channelId={IDS.channel} store={store} loadPage={loadPage} />);

    await waitFor(() => expect(screen.getByTestId(`message-row-${messageId(3)}`)).toBeTruthy());
    expect(screen.queryByTestId('unread-divider')).toBeNull();
  });
});

describe('states', () => {
  it('renders the loading state while the newest page is in flight', async () => {
    const store = makeStore();
    let release: (items: Message[]) => void = () => undefined;
    const loadPage: LoadMessagePage = () =>
      new Promise<Message[]>((resolve) => {
        release = resolve;
      });

    await render(<MessageList channelId={IDS.channel} store={store} loadPage={loadPage} />);

    expect(screen.getByTestId('surface-loading')).toBeTruthy();
    expect(screen.getByLabelText('Loading messages…')).toBeTruthy();

    release(page(1));
    await waitFor(() => expect(screen.getByTestId(`message-row-${messageId(1)}`)).toBeTruthy());
  });

  it('renders the empty state for a channel with no messages', async () => {
    const store = makeStore();
    const loadPage = jest.fn(async (_params: PageParams) => []);

    await render(
      <MessageList channelId={IDS.channel} store={store} loadPage={loadPage} />,
    );

    await waitFor(() => expect(screen.getByTestId('surface-empty')).toBeTruthy());
    expect(screen.getByText('No messages yet')).toBeTruthy();
    expect(screen.getByText('Be the first to say something in this channel.')).toBeTruthy();
  });

  it('renders an announced failure and retries through the control', async () => {
    const store = makeStore();
    const loadPage = jest
      .fn<ReturnType<LoadMessagePage>, [PageParams]>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(page(1));

    await render(<MessageList channelId={IDS.channel} store={store} loadPage={loadPage} />);

    await waitFor(() => expect(screen.getByTestId('message-list-error')).toBeTruthy());
    // Announced as an alert (the shell's ErrorState convention: role +
    // accessibilityRole; the container itself is not an accessibility element
    // so the Retry control inside stays reachable).
    expect(screen.getByTestId('message-list-error').props.accessibilityRole).toBe('alert');
    expect(screen.getByText('Could not load messages.')).toBeTruthy();

    fireEvent.press(screen.getByTestId('message-list-retry'));

    await waitFor(() => expect(screen.getByTestId(`message-row-${messageId(1)}`)).toBeTruthy());
    expect(loadPage).toHaveBeenCalledTimes(2);
  });

  it('does not fetch when the session is not authenticated', async () => {
    const store = makeStore();
    const loadPage = jest.fn(async (_params: PageParams) => page(1));

    await render(
      <MessageList channelId={IDS.channel} store={store} loadPage={loadPage} enabled={false} />,
    );

    await waitFor(() => expect(screen.getByTestId('surface-empty')).toBeTruthy());
    expect(loadPage).not.toHaveBeenCalled();
  });
});
