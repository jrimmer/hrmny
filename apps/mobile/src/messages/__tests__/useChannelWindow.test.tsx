/**
 * Channel-window hook tests (plan 004 M6, R8).
 *
 * The real store and the real `mergeChannelMessages` run here; only the REST
 * page loader is a jest mock (the seam the route fills with the session's
 * api client). Covers the plan's scenarios at the data layer: newest page on
 * open, older pages on the start-reached signal without reordering or
 * duplicating, the unread divider at the watermark and its clearing, plus
 * the empty / failed-load / signed-out paths.
 */
import { act, renderHook, waitFor } from '@testing-library/react-native';

import type { GatewayClient } from '@cytale/gateway-client';
import { createMemoryTokenStorage, createSessionManager } from '@cytale/session';
import type { Message } from '@cytale/domain';

import { SessionProvider } from '../../navigation/session';
import {
  MESSAGE_PAGE_SIZE,
  useChannelWindow,
  type LoadMessagePage,
  type SendMessageAck,
} from '../useChannelWindow';
import { IDS, makeMessage, makeStore, messageId, seedUnread, seedWindow, windowIds } from './support';

/**
 * Counts the window's linear divider-index scan. The hook must derive the
 * index once per window/divider change, not once per viewability callback —
 * the list calls that sink on every scroll frame (performance pass, P3).
 */
var mockIndexOfCalls = 0;

jest.mock('../window', () => {
  const actual = jest.requireActual('../window');
  return {
    ...actual,
    indexOfMessage: (ordered: readonly Message[], id: string | null) => {
      mockIndexOfCalls += 1;
      return actual.indexOfMessage(ordered, id);
    },
  };
});

type PageParams = { before?: string; limit: number };

/** Newest-first page from the API for message numbers `ns` (descending). */
function page(...ns: number[]): Message[] {
  return ns.map((n) => makeMessage(n));
}

function renderWindow(options: {
  store: ReturnType<typeof makeStore>;
  loadPage: LoadMessagePage;
  channelId?: string;
  enabled?: boolean;
  sendAck?: SendMessageAck;
}) {
  return renderHook(() =>
    useChannelWindow({
      channelId: options.channelId ?? IDS.channel,
      store: options.store,
      loadPage: options.loadPage,
      ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
      ...(options.sendAck === undefined ? {} : { sendAck: options.sendAck }),
    }),
  );
}

describe('newest page', () => {
  it('loads once on mount, merges in chat order, and reports ready', async () => {
    const store = makeStore();
    const loadPage = jest.fn(async (_params: PageParams) => page(3, 2, 1));

    const { result } = await renderWindow({ store, loadPage });

    await waitFor(() => expect(result.current.loadState).toEqual({ status: 'ready' }));
    expect(loadPage).toHaveBeenCalledTimes(1);
    expect(loadPage).toHaveBeenCalledWith({ limit: MESSAGE_PAGE_SIZE });
    expect(result.current.ordered.map((m) => m.id)).toEqual(
      [1, 2, 3].map(messageId), // oldest first, newest last
    );
  });

  it('does not fetch and reports ready when the session is not authenticated', async () => {
    const store = makeStore();
    const loadPage = jest.fn(async (_params: PageParams) => page(1));

    const { result } = await renderWindow({ store, loadPage, enabled: false });

    await waitFor(() => expect(result.current.loadState).toEqual({ status: 'ready' }));
    expect(loadPage).not.toHaveBeenCalled();
    expect(result.current.ordered).toEqual([]);
  });

  it('surfaces a failed load and recovers through retry', async () => {
    const store = makeStore();
    const loadPage = jest
      .fn<ReturnType<LoadMessagePage>, [PageParams]>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(page(1));

    const { result } = await renderWindow({ store, loadPage });

    await waitFor(() =>
      expect(result.current.loadState).toEqual({
        status: 'error',
        error: 'Could not load messages.',
      }),
    );

    await act(async () => {
      result.current.retry();
    });

    await waitFor(() => expect(result.current.loadState).toEqual({ status: 'ready' }));
    expect(loadPage).toHaveBeenCalledTimes(2);
    expect(result.current.ordered.map((m) => m.id)).toEqual([messageId(1)]);
  });
});

describe('older pages', () => {
  /** A full newest-first page of `count` messages ending at `end`. */
  function fullPage(end: number, count = MESSAGE_PAGE_SIZE): Message[] {
    return Array.from({ length: count }, (_, index) => makeMessage(end - index));
  }

  it('prepends the next page at the before-cursor without jumping or duplicating', async () => {
    const store = makeStore();
    const newest = fullPage(100); // 100..51, a FULL page → more history exists
    const older = fullPage(50); // 50..1
    const loadPage = jest.fn(async ({ before }: PageParams) =>
      before === undefined ? newest : older,
    );

    const { result } = await renderWindow({ store, loadPage });
    await waitFor(() => expect(result.current.loadState).toEqual({ status: 'ready' }));

    // The anchor the reader is looking at when the older page lands.
    const anchor = result.current.ordered[0]!.id;
    expect(anchor).toBe(messageId(51));

    await act(async () => {
      result.current.loadOlder();
    });
    await waitFor(() => expect(windowIds(store, IDS.channel)).toHaveLength(100));

    expect(loadPage).toHaveBeenLastCalledWith({
      before: messageId(51),
      limit: MESSAGE_PAGE_SIZE,
    });
    // One node per message, in one monotonic order: the prepend is an insert
    // above the anchor, never a reorder (which is what "no jump" means at the
    // data layer — FlashList's MVCP does the pixel anchoring).
    expect(windowIds(store, IDS.channel)).toEqual(
      Array.from({ length: 100 }, (_, index) => messageId(index + 1)),
    );
    expect(new Set(windowIds(store, IDS.channel)).size).toBe(100);
    // The anchor keeps its identity and shifts down by exactly the prepend.
    expect(result.current.ordered.findIndex((m) => m.id === anchor)).toBe(50);
  });

  it('stops paging once a short page proves the history complete', async () => {
    const store = makeStore();
    const loadPage = jest.fn(async ({ before }: PageParams) =>
      before === undefined ? fullPage(50) : [],
    );

    const { result } = await renderWindow({ store, loadPage });
    await waitFor(() => expect(result.current.loadState).toEqual({ status: 'ready' }));

    await act(async () => {
      result.current.loadOlder();
    });
    await waitFor(() =>
      expect(store.getState().messagesByChannel[IDS.channel]?.hasCompleteHistory).toBe(true),
    );

    await act(async () => {
      result.current.loadOlder();
    });
    expect(loadPage).toHaveBeenCalledTimes(2); // newest + one older, then stopped
  });

  it('records an older-page failure without disturbing the window', async () => {
    const store = makeStore();
    const loadPage = jest
      .fn<ReturnType<LoadMessagePage>, [PageParams]>()
      .mockResolvedValueOnce(fullPage(50))
      .mockRejectedValueOnce(new Error('offline'));

    const { result } = await renderWindow({ store, loadPage });
    await waitFor(() => expect(result.current.loadState).toEqual({ status: 'ready' }));

    await act(async () => {
      result.current.loadOlder();
    });

    await waitFor(() =>
      expect(result.current.olderError).toBe('Could not load older messages. Try again.'),
    );
    expect(result.current.loadingOlder).toBe(false);
    expect(result.current.ordered).toHaveLength(MESSAGE_PAGE_SIZE);
  });
});

describe('unread divider', () => {
  /** A window of 1..3 with 2 and 3 unread (watermark on 1). */
  async function renderUnread() {
    const store = makeStore();
    seedUnread(store, IDS.channel, { last_read_id: messageId(1), unread_count: 2 });
    const loadPage = jest.fn(async (_params: PageParams) => page(3, 2, 1));
    const rendered = await renderWindow({ store, loadPage });
    await waitFor(() => expect(rendered.result.current.loadState).toEqual({ status: 'ready' }));
    return { store, ...rendered };
  }

  it('captures the watermark position once the window lands', async () => {
    const { result } = await renderUnread();
    expect(result.current.dividerId).toBe(messageId(2));
  });

  it('holds the captured position when newer messages arrive while open', async () => {
    const { store, result } = await renderUnread();

    await act(async () => {
      store.setState((state) => {
        const slice = state.messagesByChannel[IDS.channel]!;
        return {
          messagesByChannel: {
            ...state.messagesByChannel,
            [IDS.channel]: { ...slice, items: [makeMessage(4), ...slice.items] },
          },
        };
      });
    });

    expect(result.current.ordered).toHaveLength(4);
    expect(result.current.dividerId).toBe(messageId(2));
  });

  it('stays until the reader has seen it, then clears and advances the watermark', async () => {
    const { store, result } = await renderUnread();

    // Opening at the newest row puts the divider above the viewport; the
    // viewport being "past" it is not the same as having scrolled past it.
    await act(async () => {
      result.current.handleViewableItemsChanged({ viewableItems: [{ index: 2 }] });
    });
    expect(result.current.dividerId).toBe(messageId(2));

    // Scroll up to the line — now it counts as seen.
    await act(async () => {
      result.current.handleViewableItemsChanged({
        viewableItems: [{ index: 1 }, { index: 2 }],
      });
    });
    expect(result.current.dividerId).toBe(messageId(2));

    // Scroll back down past it → the rule retires and the channel reads.
    await act(async () => {
      result.current.handleViewableItemsChanged({ viewableItems: [{ index: 2 }] });
    });
    expect(result.current.dividerId).toBeNull();
    expect(store.getState().unreadByChannel[IDS.channel]).toEqual({
      last_read_id: messageId(3),
      unread_count: 0,
      mention_count: 0,
    });
  });

  it('resolves the divider index once per window, not once per scroll frame', async () => {
    const { store, result } = await renderUnread();
    mockIndexOfCalls = 0;

    // Five viewability callbacks (what the list reports while scrolling) must
    // not re-scan the window for a position that cannot have moved.
    await act(async () => {
      for (let frame = 0; frame < 5; frame += 1) {
        result.current.handleViewableItemsChanged({ viewableItems: [{ index: 2 }] });
      }
    });
    expect(mockIndexOfCalls).toBe(0);

    // A window change DOES re-derive it — exactly once.
    await act(async () => {
      store.setState((state) => {
        const slice = state.messagesByChannel[IDS.channel]!;
        return {
          messagesByChannel: {
            ...state.messagesByChannel,
            [IDS.channel]: { ...slice, items: [makeMessage(4), ...slice.items] },
          },
        };
      });
    });
    expect(mockIndexOfCalls).toBe(1);
  });

  it('does not re-capture after the store watermark moves', async () => {
    const { store, result } = await renderUnread();
    expect(result.current.dividerId).toBe(messageId(2));

    await act(async () => {
      seedUnread(store, IDS.channel, { last_read_id: messageId(3), unread_count: 0 });
    });

    expect(result.current.dividerId).toBe(messageId(2));
  });

  it('renders no divider when the channel has no unread', async () => {
    const store = makeStore();
    seedUnread(store, IDS.channel, { last_read_id: null, unread_count: 0 });
    const loadPage = jest.fn(async (_params: PageParams) => page(2, 1));

    const { result } = await renderWindow({ store, loadPage });
    await waitFor(() => expect(result.current.loadState).toEqual({ status: 'ready' }));

    expect(result.current.dividerId).toBeNull();
  });
});

describe('read acknowledgement (MESSAGE_ACK)', () => {
  it('acks the newest confirmed id once the window is ready', async () => {
    const store = makeStore();
    const loadPage = jest.fn(async (_params: PageParams) => page(3, 2, 1));
    const sendAck = jest.fn();

    const { result } = await renderWindow({ store, loadPage, sendAck });
    await waitFor(() => expect(result.current.loadState).toEqual({ status: 'ready' }));

    // The ack is the server-visible half of the read: the local watermark
    // alone never clears the badge across a relaunch.
    await waitFor(() =>
      expect(sendAck).toHaveBeenCalledWith({
        channel_id: IDS.channel,
        message_ids: [messageId(3)],
      }),
    );
    expect(sendAck).toHaveBeenCalledTimes(1); // one ack per newest id, not per render
  });

  it('acks the newest confirmed id when the divider retires', async () => {
    const store = makeStore();
    seedUnread(store, IDS.channel, { last_read_id: messageId(1), unread_count: 2 });
    const loadPage = jest.fn(async (_params: PageParams) => page(3, 2, 1));
    const sendAck = jest.fn();

    const { result } = await renderWindow({ store, loadPage, sendAck });
    await waitFor(() => expect(result.current.loadState).toEqual({ status: 'ready' }));
    sendAck.mockClear();

    // Scroll up to the line (seen), then back down past it (retired).
    await act(async () => {
      result.current.handleViewableItemsChanged({ viewableItems: [{ index: 1 }, { index: 2 }] });
    });
    await act(async () => {
      result.current.handleViewableItemsChanged({ viewableItems: [{ index: 2 }] });
    });

    expect(result.current.dividerId).toBeNull();
    expect(sendAck).toHaveBeenCalledWith({
      channel_id: IDS.channel,
      message_ids: [messageId(3)],
    });
  });

  it('never acks an optimistic placeholder row', async () => {
    const store = makeStore();
    const loadPage = jest.fn(async (_params: PageParams) => page(2, 1));
    const sendAck = jest.fn();

    const { result } = await renderWindow({ store, loadPage, sendAck });
    await waitFor(() => expect(result.current.loadState).toEqual({ status: 'ready' }));
    await waitFor(() => expect(sendAck).toHaveBeenCalledTimes(1));

    // An optimistic send lands a `pending_…` placeholder as the newest row;
    // the gateway rejects a non-snowflake ack, and the confirmed id that
    // replaces it is what gets acked (web's MessagePane guard).
    await act(async () => {
      seedWindow(store, IDS.channel, [
        makeMessage(3, { id: 'pending_abc123' }),
        ...(store.getState().messagesByChannel[IDS.channel]?.items ?? []),
      ]);
    });

    expect(result.current.ordered[result.current.ordered.length - 1]?.id).toBe('pending_abc123');
    expect(sendAck).toHaveBeenCalledTimes(1);
    expect(sendAck).not.toHaveBeenCalledWith(
      expect.objectContaining({ message_ids: ['pending_abc123'] }),
    );
  });

  it('does not ack while the session gate is closed', async () => {
    const store = makeStore();
    const loadPage = jest.fn(async (_params: PageParams) => page(1));
    const sendAck = jest.fn();

    const { result } = await renderWindow({ store, loadPage, sendAck, enabled: false });
    await waitFor(() => expect(result.current.loadState).toEqual({ status: 'ready' }));

    expect(sendAck).not.toHaveBeenCalled();
  });

  it('sends through the live session gateway when no sender is injected', async () => {
    const manager = createSessionManager({ storage: createMemoryTokenStorage() });
    const sendMessageAck = jest.fn();
    jest
      .spyOn(manager, 'getGateway')
      .mockReturnValue({ sendMessageAck } as unknown as GatewayClient);
    const store = makeStore();
    const loadPage = jest.fn(async (_params: PageParams) => page(2, 1));

    const { result } = await renderHook(
      () => useChannelWindow({ channelId: IDS.channel, store, loadPage }),
      {
        wrapper: ({ children }) => <SessionProvider manager={manager}>{children}</SessionProvider>,
      },
    );
    await waitFor(() => expect(result.current.loadState).toEqual({ status: 'ready' }));

    // The production default: `getSessionManager().getGateway()` — the same
    // seam web's `useUnread` sends through.
    await waitFor(() =>
      expect(sendMessageAck).toHaveBeenCalledWith({
        channel_id: IDS.channel,
        message_ids: [messageId(2)],
      }),
    );
  });
});
