/**
 * @cytale/mobile — thread surface (plan 004 M9, R12).
 *
 * Threads open as a FULL-SURFACE view pushed over the conversation with a
 * back path — plan-003's sub-768px behaviour, which is the native
 * presentation: the thread never docks beside the channel on a phone. The
 * root stack's push is what makes "back restores the channel's position"
 * true: the channel screen stays mounted underneath (same FlashList
 * instance, same window), so returning to it cannot re-land at the newest
 * message. `goBack` falls back to the parent channel when there is no stack
 * to pop (a cold deep link), so the back path is never a dead end.
 *
 * The route owns the states-first frame and every REST seam, exactly like the
 * channel route: the scaffold renders loading / error / permission-denied /
 * offline / view-only from the shared shell vocabulary, the body renders the
 * reply window and the thread-scoped composer. Thread metadata is resolved
 * through `useThreadMeta` (store first, then `GET /threads/{id}`) because a
 * deep link may arrive with an empty store.
 */
import '../../src/navigation/bootstrap';

import { useCallback } from 'react';
import { useLocalSearchParams, router } from 'expo-router';

import type { StateStore } from '@cytale/state';

import { useAuthStatus, useSession, useSessionRestored } from '../../src/navigation/session';
import { useShell } from '../../src/navigation/ShellContext';
import { useSurfaceStates } from '../../src/navigation/shellState';
import { useChannel } from '../../src/navigation/store';
import { SurfaceScaffold } from '../../src/navigation/SurfaceScaffold';
import { ThreadBody, useThreadMeta, useThreadSend } from '../../src/threads';
import type { LoadThreadPage } from '../../src/threads';

export default function ThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const threadId = typeof id === 'string' ? id : null;
  const { store } = useShell();
  const restored = useSessionRestored();
  const authStatus = useAuthStatus();
  const { api } = useSession();
  const shared = useSurfaceStates();

  const authenticated = authStatus === 'authenticated';
  const meta = useThreadMeta({
    threadId,
    store: store as StateStore,
    api,
    enabled: authenticated,
  });
  const thread = meta.thread;
  const channel = useChannel(store, thread?.channel_id ?? null);

  const loading = shared.loading ?? (!restored || meta.status === 'loading');
  const error =
    shared.error ??
    meta.error ??
    (thread === undefined && meta.status === 'ready'
      ? `Thread ${threadId ?? 'unknown'} is unavailable.`
      : null);

  // Stable identity is a contract of `useThreadWindow`: a new loader re-runs
  // the newest-page load.
  const loadPage = useCallback<LoadThreadPage>(
    async ({ before, limit }) => {
      if (threadId === null) return [];
      return await api.getThreadMessages(threadId, {
        ...(before === undefined ? {} : { before }),
        limit,
      });
    },
    [api, threadId],
  );

  // The composer's own send seam posts to the channel endpoint; a thread
  // reply must go through the thread endpoint instead (see `useThreadSend`).
  const send = useThreadSend({ api, store: store as StateStore, threadId: threadId ?? '' });

  const upload = useCallback(
    async (channelId: string, file: { uri: string; name: string; type: string }) =>
      await api.uploadChannelAttachment(channelId, {
        uri: file.uri,
        name: file.name,
        type: file.type,
      }),
    [api],
  );

  const submitEdit = useCallback(
    async (messageId: string, content: string) => {
      if (thread === undefined) return;
      await api.editMessage(thread.channel_id, messageId, { content });
    },
    [api, thread],
  );

  const confirmDelete = useCallback(
    async (messageId: string) => {
      if (thread === undefined) return;
      await api.deleteMessage(thread.channel_id, messageId);
    },
    [api, thread],
  );

  const goBack = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    // A cold deep link has no stack to pop — land on the conversation the
    // thread hangs off rather than trapping the reader (R12).
    if (thread !== undefined) router.replace(`/channel/${thread.channel_id}`);
    else router.back();
  }, [thread]);

  return (
    <SurfaceScaffold
      testID="surface-thread"
      title={thread?.name ?? 'Thread'}
      subtitle={channel === undefined ? undefined : `#${channel.name}`}
      onBack={goBack}
      states={{ ...shared, loading, error }}
    >
      {threadId === null || thread === undefined ? null : (
        <ThreadBody
          thread={thread}
          loadPage={loadPage}
          send={send}
          upload={upload}
          store={store as StateStore}
          enabled={authenticated}
          onEditSubmit={submitEdit}
          onDeleteConfirmed={confirmDelete}
        />
      )}
    </SurfaceScaffold>
  );
}
