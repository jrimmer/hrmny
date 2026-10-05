/**
 * The thread message window (plan 004 M9, R12).
 *
 * The hook is the thread twin of `useChannelWindow`: one newest page on open,
 * older pages on the list's start-reached signal, the three load states, and
 * the thread's unread tier cleared once the replies are on screen. FlashList
 * is absent here on purpose — the data-level contract (cursors, order,
 * completion, failure) is what these tests pin.
 */
import { act, renderHook, waitFor } from '@testing-library/react-native';

import type { GatewayClient } from '@cytale/gateway-client';
import { createMemoryTokenStorage, createSessionManager } from '@cytale/session';
import type { Message } from '@cytale/domain';

import { MESSAGE_PAGE_SIZE, type SendMessageAck } from '../../messages/useChannelWindow';
import { SessionProvider } from '../../navigation/session';
import { useThreadWindow } from '../useThreadWindow';
import { IDS, makeReply, makeStore, replyId, seedThreadUnread, seedThreadWindow, windowIds } from './support';

type PageParams = { before?: string; limit: number };

function fullPage(end: number, count = MESSAGE_PAGE_SIZE): Message[] {
  return Array.from({ length: count }, (_, index) => makeReply(end - index));
}

describe('newest page', () => {
  it('loads once on open, orders the replies, and clears the thread unread tier', async () => {
    const store = makeStore();
    seedThreadUnread(store, { last_read_id: null, unread_count: 2, mention_count: 1 });
    const loadPage = jest.fn(async (_params: PageParams) => [
      makeReply(3),
      makeReply(2),
      makeReply(1),
    ]);

    const { result } = await renderHook(() =>
      useThreadWindow({
        threadId: IDS.thread,
        store,
        loadPage,
      }),
    );

    await waitFor(() => expect(result.current.loadState.status).toBe('ready'));
    expect(loadPage).toHaveBeenCalledTimes(1);
    expect(loadPage).toHaveBeenCalledWith({ limit: MESSAGE_PAGE_SIZE });
    expect(result.current.ordered.map((m) => m.id)).toEqual([
      replyId(1),
      replyId(2),
      replyId(3),
    ]);
    // Reading the thread clears its badge without touching the channel tier.
    expect(store.getState().unreadByThread[IDS.thread]).toEqual({
      last_read_id: replyId(3),
      unread_count: 0,
      mention_count: 0,
    });
  });

  it('renders the store window without a fetch while the session is not authenticated', async () => {
    const store = makeStore();
    store.setState({
      messagesByThread: {
        [IDS.thread]: {
          items: [makeReply(2), makeReply(1)],
          oldestId: replyId(1),
          hasCompleteHistory: false,
        },
      },
    });
    const loadPage = jest.fn(async (_params: PageParams) => []);

    const { result } = await renderHook(() =>
      useThreadWindow({
        threadId: IDS.thread,
        store,
        loadPage,
        enabled: false,
      }),
    );

    expect(result.current.loadState.status).toBe('ready');
    expect(result.current.ordered.map((m) => m.id)).toEqual([replyId(1), replyId(2)]);
    expect(loadPage).not.toHaveBeenCalled();
  });

  it('surfaces a newest-page failure and retries it on demand', async () => {
    const store = makeStore();
    let fail = true;
    const loadPage = jest.fn(async (_params: PageParams) => {
      if (fail) {
        fail = false;
        throw new Error('offline');
      }
      return [makeReply(1)];
    });

    const { result } = await renderHook(() =>
      useThreadWindow({ threadId: IDS.thread, store, loadPage }),
    );

    await waitFor(() => expect(result.current.loadState.status).toBe('error'));
    expect(result.current.loadState).toEqual({
      status: 'error',
      error: 'Could not load replies.',
    });

    await act(async () => {
      result.current.retry();
    });

    await waitFor(() => expect(result.current.loadState.status).toBe('ready'));
    expect(windowIds(store)).toEqual([replyId(1)]);
  });
});

describe('older replies', () => {
  it('pages back from the oldest loaded reply and stops once the window is complete', async () => {
    const store = makeStore();
    const loadPage = jest.fn(async ({ before }: PageParams) => {
      if (before === undefined) return fullPage(100);
      if (before === replyId(51)) return fullPage(50);
      return [makeReply(0)];
    });

    const { result } = await renderHook(() =>
      useThreadWindow({ threadId: IDS.thread, store, loadPage }),
    );
    await waitFor(() => expect(result.current.loadState.status).toBe('ready'));
    expect(result.current.ordered).toHaveLength(50);

    await act(async () => {
      await result.current.loadOlder();
    });

    expect(loadPage).toHaveBeenLastCalledWith({ before: replyId(51), limit: MESSAGE_PAGE_SIZE });
    expect(result.current.ordered).toHaveLength(100);
    expect(result.current.ordered[0]!.id).toBe(replyId(1));
    expect(new Set(result.current.ordered.map((m) => m.id)).size).toBe(100);

    // A full page means there may be more; the next request walks below 1.
    await act(async () => {
      await result.current.loadOlder();
    });
    expect(loadPage).toHaveBeenLastCalledWith({ before: replyId(1), limit: MESSAGE_PAGE_SIZE });

    // The partial page completed the window — no further history requests.
    const calls = loadPage.mock.calls.length;
    await act(async () => {
      await result.current.loadOlder();
    });
    expect(loadPage).toHaveBeenCalledTimes(calls);
  });

  it('keeps the window intact when an older page fails, and retries the same cursor', async () => {
    const store = makeStore();
    let fail = true;
    const loadPage = jest.fn(async ({ before }: PageParams) => {
      if (before === undefined) return fullPage(150);
      if (fail) {
        fail = false;
        throw new Error('offline');
      }
      return fullPage(100, 10);
    });

    const { result } = await renderHook(() =>
      useThreadWindow({ threadId: IDS.thread, store, loadPage }),
    );
    await waitFor(() => expect(result.current.loadState.status).toBe('ready'));

    await act(async () => {
      await result.current.loadOlder();
    });

    expect(result.current.olderError).toBe('Could not load older replies. Try again.');
    expect(result.current.loadingOlder).toBe(false);
    expect(result.current.ordered).toHaveLength(50);

    await act(async () => {
      await result.current.loadOlder();
    });
    expect(loadPage).toHaveBeenLastCalledWith({ before: replyId(101), limit: MESSAGE_PAGE_SIZE });
    expect(result.current.olderError).toBeNull();
    expect(result.current.ordered).toHaveLength(60);
  });
});

describe('read acknowledgement (MESSAGE_ACK)', () => {
  /** The thread window with an injected ack sender (the gateway seam). */
  function renderThreadWindow(options: {
    store: ReturnType<typeof makeStore>;
    loadPage: (params: PageParams) => Promise<Message[]>;
    enabled?: boolean;
    sendAck?: SendMessageAck;
  }) {
    return renderHook(() =>
      useThreadWindow({
        threadId: IDS.thread,
        store: options.store,
        loadPage: options.loadPage,
        ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
        ...(options.sendAck === undefined ? {} : { sendAck: options.sendAck }),
      }),
    );
  }

  it('acks the newest confirmed reply once the window is ready', async () => {
    const store = makeStore();
    const loadPage = jest.fn(async (_params: PageParams) => [makeReply(3), makeReply(2), makeReply(1)]);
    const sendAck = jest.fn();

    const { result } = await renderThreadWindow({ store, loadPage, sendAck });
    await waitFor(() => expect(result.current.loadState.status).toBe('ready'));

    // The ack is the server-visible half of the read: the local tier patch
    // alone never clears the badge across a relaunch. A thread ack rides the
    // thread id as its `channel_id` (web's `useUnread.markThreadRead`).
    await waitFor(() =>
      expect(sendAck).toHaveBeenCalledWith({
        channel_id: IDS.thread,
        message_ids: [replyId(3)],
      }),
    );
    expect(sendAck).toHaveBeenCalledTimes(1); // one ack per newest id, not per render
  });

  it('acks a newer reply that lands while the thread is open', async () => {
    const store = makeStore();
    const loadPage = jest.fn(async (_params: PageParams) => [makeReply(2), makeReply(1)]);
    const sendAck = jest.fn();

    const { result } = await renderThreadWindow({ store, loadPage, sendAck });
    await waitFor(() => expect(result.current.loadState.status).toBe('ready'));
    await waitFor(() => expect(sendAck).toHaveBeenCalledTimes(1));

    await act(async () => {
      seedThreadWindow(store, [
        makeReply(3),
        ...(store.getState().messagesByThread[IDS.thread]?.items ?? []),
      ]);
    });

    await waitFor(() =>
      expect(sendAck).toHaveBeenLastCalledWith({
        channel_id: IDS.thread,
        message_ids: [replyId(3)],
      }),
    );
    expect(sendAck).toHaveBeenCalledTimes(2);
  });

  it('never acks an optimistic placeholder row', async () => {
    const store = makeStore();
    const loadPage = jest.fn(async (_params: PageParams) => [makeReply(2), makeReply(1)]);
    const sendAck = jest.fn();

    const { result } = await renderThreadWindow({ store, loadPage, sendAck });
    await waitFor(() => expect(result.current.loadState.status).toBe('ready'));
    await waitFor(() => expect(sendAck).toHaveBeenCalledTimes(1));

    // An optimistic send lands a `pending_…` placeholder as the newest row;
    // the gateway rejects a non-snowflake ack, and the confirmed id that
    // replaces it is what gets acked (web's MessagePane guard).
    await act(async () => {
      seedThreadWindow(store, [
        makeReply(3, { id: 'pending_abc123' }),
        ...(store.getState().messagesByThread[IDS.thread]?.items ?? []),
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
    const loadPage = jest.fn(async (_params: PageParams) => [makeReply(1)]);
    const sendAck = jest.fn();

    const { result } = await renderThreadWindow({ store, loadPage, sendAck, enabled: false });
    await waitFor(() => expect(result.current.loadState.status).toBe('ready'));

    expect(sendAck).not.toHaveBeenCalled();
  });

  it('sends through the live session gateway when no sender is injected', async () => {
    const manager = createSessionManager({ storage: createMemoryTokenStorage() });
    const sendMessageAck = jest.fn();
    jest
      .spyOn(manager, 'getGateway')
      .mockReturnValue({ sendMessageAck } as unknown as GatewayClient);
    const store = makeStore();
    const loadPage = jest.fn(async (_params: PageParams) => [makeReply(2), makeReply(1)]);

    const { result } = await renderHook(
      () => useThreadWindow({ threadId: IDS.thread, store, loadPage }),
      {
        wrapper: ({ children }) => <SessionProvider manager={manager}>{children}</SessionProvider>,
      },
    );
    await waitFor(() => expect(result.current.loadState.status).toBe('ready'));

    // The production default: `getSessionManager().getGateway()` — the same
    // seam the channel window and web's `useUnread` send through.
    await waitFor(() =>
      expect(sendMessageAck).toHaveBeenCalledWith({
        channel_id: IDS.thread,
        message_ids: [replyId(2)],
      }),
    );
  });
});
