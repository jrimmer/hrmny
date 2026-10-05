/**
 * @cytale/mobile — the thread-scoped send seam (plan 004 M9, R12).
 *
 * `Composer`'s default send is `useSendMessage`, which POSTs to the CHANNEL
 * endpoint (`/channels/{id}/messages`) with no `thread_id` in the body — a
 * thread reply sent through it would land in the channel timeline while its
 * optimistic row sat in `messagesByThread`, and the two would never converge.
 * The thread surface therefore injects this seam (web's `ThreadCompose`
 * adapter, ported to the shared optimistic primitives):
 *
 *   * the placeholder row is inserted into `messagesByThread` before the
 *     request, so a reply renders the instant the send control is pressed;
 *   * the POST goes to `/threads/{id}/messages` (the route that emits the
 *     thread-scoped `ThreadMessageCreate`), with the nonce as the
 *     Idempotency-Key — a retry cannot double-post;
 *   * confirmation swaps the placeholder for the server row; failure removes
 *     it and records the failure for the composer's retry path.
 *
 * The parent channel id comes from the store's thread record at send time
 * (never a captured prop), so a thread whose metadata hydrates after mount
 * still stamps its optimistic row correctly.
 */
import { useCallback } from 'react';

import { ApiError, type SendMessageBody } from '@cytale/api-client';
import type { Message } from '@cytale/domain';
import {
  beginOptimisticSend,
  confirmOptimisticSend,
  failOptimisticSend,
  type StateStore,
} from '@cytale/state';

import type { SendMessage } from '../composer/types';

/** The narrow slice of `CytaleApiClient` the thread send path needs. */
export interface ThreadSendApi {
  sendThreadMessage(
    threadId: string,
    body: SendMessageBody,
    idempotencyKey?: string,
  ): Promise<Message>;
}

function toErrorShape(err: unknown): { key: string; code: number; message: string } {
  if (err instanceof ApiError) {
    return { key: err.key, code: err.code, message: err.message };
  }
  if (err instanceof Error) {
    return { key: 'UNKNOWN', code: 0, message: err.message };
  }
  return { key: 'UNKNOWN', code: 0, message: String(err) };
}

/** Build the thread send function for one api client + store + thread. */
export function useThreadSend({
  api,
  store,
  threadId,
}: {
  api: ThreadSendApi;
  store: StateStore;
  threadId: string;
}): SendMessage {
  return useCallback(
    async (input) => {
      const me = store.getState().currentUser;
      if (!me) {
        throw new ApiError({ key: 'UNAUTHENTICATED', code: 40101, message: 'Not signed in' });
      }
      const channelId = store.getState().threadsById[threadId]?.channel_id ?? input.channelId;
      const { nonce } = beginOptimisticSend(store, {
        channel_id: channelId,
        thread_id: threadId,
        author_id: me.id,
        content: input.content,
      });
      const attachments = input.attachments ?? [];
      try {
        const serverMessage = await api.sendThreadMessage(
          threadId,
          {
            content: input.content,
            ...(input.replyToId ? { reply_to_id: input.replyToId } : {}),
            ...(attachments.length > 0 ? { attachments } : {}),
          },
          nonce,
        );
        confirmOptimisticSend(store, nonce, serverMessage);
      } catch (err) {
        failOptimisticSend(store, nonce, toErrorShape(err));
        throw err;
      }
    },
    [api, store, threadId],
  );
}
