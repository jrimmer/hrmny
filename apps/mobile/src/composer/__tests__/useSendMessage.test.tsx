/**
 * The composer's default send seam (plan 004 M7) — thread-scoped sends.
 *
 * The optimistic row has always carried `thread_id` (`beginOptimisticSend`),
 * but the POST body did not: a thread reply sent through this seam landed in
 * the CHANNEL timeline while its placeholder sat in the thread slice, and the
 * two never converged. The server's channel endpoint accepts `thread_id`
 * (`message_controller.ex` create/2), so the seam must forward it.
 */
import { act, renderHook } from '@testing-library/react-native';

import type { Message } from '@cytale/domain';

import { useSendMessage, type SendApi } from '../useSendMessage';
import { IDS, makeStore } from './support';

const THREAD = '700000000000000009';

function makeApi(message: Message = { ...makeServerMessage() }) {
  const sendMessage = jest.fn(
    async (_channelId: string, _body: unknown, _idempotencyKey?: string) => message,
  );
  return { sendMessage } as unknown as SendApi & { sendMessage: jest.Mock };
}

function makeServerMessage(): Message {
  return {
    id: '500000000000000001',
    channel_id: IDS.channel,
    thread_id: null,
    author_id: IDS.me,
    content: 'hello',
    created_at: '2026-09-08T00:00:00.000Z',
    edited_at: null,
  };
}

describe('useSendMessage — thread seam', () => {
  it('carries thread_id in the POST body for a thread send', async () => {
    const store = makeStore();
    const api = makeApi();

    const { result } = await renderHook(() => useSendMessage({ api, store }));

    await act(async () => {
      await result.current({
        channelId: IDS.channel,
        threadId: THREAD,
        content: 'hello',
      });
    });

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    const [channelId, body, idempotencyKey] = api.sendMessage.mock.calls[0]!;
    expect(channelId).toBe(IDS.channel);
    expect(body).toMatchObject({ content: 'hello', thread_id: THREAD });
    expect(typeof idempotencyKey).toBe('string');
  });

  it('omits thread_id for a channel send', async () => {
    const store = makeStore();
    const api = makeApi();

    const { result } = await renderHook(() => useSendMessage({ api, store }));

    await act(async () => {
      await result.current({
        channelId: IDS.channel,
        threadId: null,
        content: 'hello',
      });
    });

    const body = api.sendMessage.mock.calls[0]![1] as Record<string, unknown>;
    expect(body).toMatchObject({ content: 'hello' });
    expect(typeof body.nonce).toBe('string');
    expect(body).not.toHaveProperty('thread_id');
  });
});
