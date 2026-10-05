/**
 * @cytale/mobile — the composer's send path (plan 004 M7, R9/R10).
 *
 * The same contract the web client implements (U17 optimistic send): insert
 * the placeholder row through `@cytale/state`, POST with the nonce as the
 * idempotency key, then confirm or fail. The store owns the truth; this hook
 * is only the REST half, so a retry after a failure re-uses the composer's
 * text (the placeholder row was rolled back by `failOptimisticSend`).
 */
import { useCallback } from 'react';

import {
  ApiError,
  type SendMessageBody,
  type UploadedAttachment,
} from '@cytale/api-client';
import type { Message } from '@cytale/domain';
import {
  beginOptimisticSend,
  confirmOptimisticSend,
  defaultStore,
  failOptimisticSend,
  type StateStore,
} from '@cytale/state';

import type { SendInput, SendMessage } from './types';

/** The narrow slice of `CytaleApiClient` the send path needs (test seam). */
export interface SendApi {
  sendMessage(
    channelId: string,
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

/** Build the send function for one api client + store. */
export function useSendMessage({
  api,
  store = defaultStore,
}: {
  api: SendApi;
  store?: StateStore;
}): SendMessage {
  return useCallback(
    async (input: SendInput) => {
      const me = store.getState().currentUser;
      if (!me) {
        throw new ApiError({ key: 'UNAUTHENTICATED', code: 40101, message: 'Not signed in' });
      }
      const attachments: UploadedAttachment[] = input.attachments ?? [];
      const { nonce } = beginOptimisticSend(store, {
        channel_id: input.channelId,
        thread_id: input.threadId,
        author_id: me.id,
        content: input.content,
      });
      try {
        const serverMessage = await api.sendMessage(
          input.channelId,
          {
            content: input.content,
            nonce,
            // A thread send must say so on the wire: the optimistic row went
            // into the thread slice, so the POST has to land there too.
            ...(input.threadId ? { thread_id: input.threadId } : {}),
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
    [api, store],
  );
}
