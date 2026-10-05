/**
 * The thread-scoped send seam (plan 004 M9, R12).
 *
 * `Composer`'s default send posts to the CHANNEL endpoint (`useSendMessage`),
 * which carries no `thread_id` — a thread reply sent through it would land in
 * the channel timeline while the optimistic row sat in `messagesByThread`.
 * The thread surface therefore injects this seam (web's `ThreadCompose`
 * adapter, ported): optimistic row in the thread slice, POST to
 * `/threads/{id}/messages`, confirm or roll back.
 */
import { act, renderHook } from '@testing-library/react-native';

import type { Message } from '@cytale/domain';

import { useThreadSend, type ThreadSendApi } from '../useThreadSend';
import { IDS, makeReply, makeStore, replyId, windowIds } from './support';

function makeApi(message: Message = makeReply(5, { author_id: IDS.me, content: 'hello thread' })) {
  const sendThreadMessage = jest.fn(
    async (_threadId: string, _body: unknown, _idempotencyKey?: string) => message,
  );
  return { sendThreadMessage } as unknown as ThreadSendApi & {
    sendThreadMessage: jest.Mock;
  };
}

describe('useThreadSend', () => {
  it('inserts the optimistic reply, posts to the thread endpoint, and confirms it', async () => {
    const store = makeStore();
    const api = makeApi();

    const { result } = await renderHook(() =>
      useThreadSend({ api, store, threadId: IDS.thread }),
    );

    await act(async () => {
      await result.current({
        channelId: IDS.channel,
        threadId: IDS.thread,
        content: 'hello thread',
      });
    });

    // The REST body is thread-scoped by ROUTE (never a channel post), and the
    // nonce doubles as the idempotency key (retry-safe, web's contract).
    expect(api.sendThreadMessage).toHaveBeenCalledTimes(1);
    const [threadId, body, idempotencyKey] = api.sendThreadMessage.mock.calls[0]!;
    expect(threadId).toBe(IDS.thread);
    expect(body).toEqual({ content: 'hello thread' });
    expect(typeof idempotencyKey).toBe('string');
    expect(idempotencyKey).toHaveLength(12);

    // The placeholder is gone; the confirmed row carries the server id.
    expect(windowIds(store)).toEqual([replyId(5)]);
    expect(store.getState().messagesByThread[IDS.thread]!.items[0]!.thread_id).toBe(IDS.thread);
  });

  it('shows the reply in the thread before the POST resolves', async () => {
    const store = makeStore();
    let settle: (message: Message) => void = () => undefined;
    const api = {
      sendThreadMessage: jest.fn(
        async (_threadId: string, _body: unknown, _key?: string) =>
          new Promise<Message>((resolve) => {
            settle = resolve;
          }),
      ),
    } as unknown as ThreadSendApi & { sendThreadMessage: jest.Mock };

    const { result } = await renderHook(() =>
      useThreadSend({ api, store, threadId: IDS.thread }),
    );

    // Optimistic: one pending row in the thread slice, no server round-trip
    // needed for the row to render.
    const pending = result.current({
      channelId: IDS.channel,
      threadId: IDS.thread,
      content: 'hello thread',
    });
    expect(windowIds(store)).toHaveLength(1);
    expect(windowIds(store)[0]).toMatch(/^pending_/);

    await act(async () => {
      settle(makeReply(5, { author_id: IDS.me, content: 'hello thread' }));
      await pending;
    });
    expect(windowIds(store)).toEqual([replyId(5)]);
  });

  it('rolls the optimistic row back and records the failure when the POST fails', async () => {
    const store = makeStore();
    const api = {
      sendThreadMessage: jest.fn(async () => {
        throw new Error('thread is read-only');
      }),
    } as unknown as ThreadSendApi & { sendThreadMessage: jest.Mock };

    const { result } = await renderHook(() =>
      useThreadSend({ api, store, threadId: IDS.thread }),
    );

    await expect(
      result.current({
        channelId: IDS.channel,
        threadId: IDS.thread,
        content: 'hello thread',
      }),
    ).rejects.toThrow('thread is read-only');

    expect(windowIds(store)).toEqual([]);
    expect(store.getState().messagesByThread[IDS.thread]).toBeUndefined();
    const failed = Object.values(store.getState().failedByNonce);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      channel_id: IDS.channel,
      thread_id: IDS.thread,
      content: 'hello thread',
    });
  });

  it('forwards an inline-reply reference when the composer has one', async () => {
    const store = makeStore();
    const api = makeApi();

    const { result } = await renderHook(() =>
      useThreadSend({ api, store, threadId: IDS.thread }),
    );

    await act(async () => {
      await result.current({
        channelId: IDS.channel,
        threadId: IDS.thread,
        content: 'hello thread',
        replyToId: replyId(2),
      });
    });

    expect(api.sendThreadMessage.mock.calls[0]![1]).toEqual({
      content: 'hello thread',
      reply_to_id: replyId(2),
    });
  });
});
