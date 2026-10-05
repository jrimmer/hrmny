/**
 * @cytale/mobile — channel surface: shell frame + history + composer
 * (plan 004 M5 shell, M6 history, M7 composer).
 *
 * One title bar (channel name + the disabled voice entry point), the members
 * drawer as an edge-aligned sheet, and the states-first body. M6 fills the
 * body with `MessageList`, which owns the three states the shell cannot know:
 * the newest-page load, an older-page failure, and the empty channel. M7 sits
 * the composer under it and owns the inline-reply target: the action sheet
 * (M8) hands one up through `MessageList.onReply`, the composer renders the
 * reply bar and sends the reference. The surface keeps its own gates —
 * session restore, unknown channel, offline, view-only, permission-denied —
 * so the shell vocabulary stays one (R15). The permission gate is the real
 * on-device resolution (`useChannelPermissions`): it publishes
 * `permissionDenied` when the member lacks VIEW_CHANNEL and hands the list
 * MANAGE_MESSAGES so a moderator can delete a message they do not own.
 *
 * The list is keyed by channel id: a channel switch remounts it, which is
 * what re-captures the unread divider and resets the scroll position (the
 * same per-visit semantics web's `MessagePane` gets from keying its list).
 *
 * `KeyboardAvoidingView` wraps list + composer so the composer rides above
 * the keyboard instead of being covered by it (R9); the list absorbs the
 * shrink because it is the flexible element.
 *
 * History loading is gated on an authenticated session: with no session there
 * is no history to fetch, and the list reports ready + empty instead of
 * spinning on a request that cannot succeed.
 */
import '../../../src/navigation/bootstrap';

import { useCallback, useEffect, useState } from 'react';

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useKeyboardInset } from '../../../src/navigation/useKeyboardInset';
import { KeyboardAvoidingView, Platform, StyleSheet } from 'react-native';

import { hydrateNotificationPreferences, type NotificationPrefsApi, type StateStore } from '@cytale/state';

import { NotificationLevelButton } from '../../../src/notifications/NotificationLevelButton';

import { Composer } from '../../../src/composer/Composer';
import type { ReplyTarget } from '../../../src/composer/types';
import { MessageList } from '../../../src/messages/MessageList';
import { beginOptimisticReaction } from '../../../src/messages/reactions';
import type { LoadMessagePage } from '../../../src/messages/useChannelWindow';
import { useChannelPermissions } from '../../../src/navigation/permissions';
import { useAuthStatus, useSession, useSessionRestored } from '../../../src/navigation/session';
import { useShell } from '../../../src/navigation/ShellContext';
import { useSurfaceStates } from '../../../src/navigation/shellState';
import { useChannel, useStoreSelector } from '../../../src/navigation/store';
import { SurfaceScaffold } from '../../../src/navigation/SurfaceScaffold';

export default function ChannelScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const keyboardInset = useKeyboardInset();
  const insets = useSafeAreaInsets();
  const channelId = typeof id === 'string' ? id : null;
  const { store, openDrawer, openMembers } = useShell();
  const restored = useSessionRestored();
  const authStatus = useAuthStatus();
  const { api } = useSession();
  const shared = useSurfaceStates();
  /** Inline-reply target set by the message action sheet (M8). */
  const [replyTo, setReplyTo] = useState<ReplyTarget | null>(null);

  const channel = useChannel(store, channelId);
  const channels = useStoreSelector(store, (state) => state.channels);
  // On-device permission gate (R15): publishes `permissionDenied` for this
  // channel and reports the bits the list needs (MANAGE_MESSAGES). Resolves
  // to nothing while the roles read is in flight — it never claims denial
  // on an unresolved state.
  const { canManageMessages } = useChannelPermissions(api, store, channelId);

  const channelsLoaded = Object.keys(channels).length > 0;
  const missing = channel === undefined;
  const loading = shared.loading ?? (!restored || (missing && !channelsLoaded));
  const error =
    shared.error ?? (missing && channelsLoaded ? `#${channelId ?? 'unknown'} is unavailable.` : null);

  // Stable identity is a contract of `useChannelWindow`: a new loader re-runs
  // the newest-page load.
  const loadPage = useCallback<LoadMessagePage>(
    async ({ before, limit }) => {
      if (channelId === null) return [];
      const page = await api.getMessagePage(channelId, {
        ...(before === undefined ? {} : { before }),
        limit,
      });
      return page.items;
    },
    [api, channelId],
  );

  // The mention picker and the member rows read the workspace roster from
  // the store. The hydrator fills it per workspace, but a channel opened
  // before that leg (or a workspace whose roster page was truncated) needs
  // the fetch here — bounded pages, merged into the same slices.
  const wsId = channel === undefined ? null : channel.workspace_id;
  useEffect(() => {
    if (wsId === null || wsId === undefined) return;
    if ((store.getState().memberIdsByWorkspace[wsId] ?? []).length > 0) return;
    let cancelled = false;
    void api
      .listAllPeople(wsId)
      .then((page) => {
        if (cancelled || page.items.length === 0) return;
        (store as StateStore).setState((s) => ({
          membersById: {
            ...s.membersById,
            ...Object.fromEntries(page.items.map((m) => [m.id, m])),
          },
          memberIdsByWorkspace: {
            ...s.memberIdsByWorkspace,
            [wsId]: page.items.map((m) => m.id),
          },
        }));
      })
      .catch(() => {
        // Roster failures are non-fatal: the picker degrades to no candidates
        // and the next session retries.
      });
    return () => {
      cancelled = true;
    };
  }, [wsId, restored]);

  // Notification controls (2026-09-27): the shared preference slice hydrates
  // once per signed-in session (the first channel opened loads it); the
  // title-bar button then reads and writes it like every web surface does.
  useEffect(() => {
    if (authStatus !== 'authenticated') return;
    const prefs = store.getState().notificationPrefs;
    if (prefs && prefs.status === 'idle') {
      void hydrateNotificationPreferences(store as StateStore, api as unknown as NotificationPrefsApi);
    }
  }, [authStatus, api, store]);

  const cancelReply = useCallback(() => setReplyTo(null), []);

  // The action sheet's seams (M8). Each owns its REST call here — the sheet
  // and chips stay presentation — and reactions patch optimistically through
  // the same seam web uses, rolling back on failure.
  const router = useRouter();

  const toggleReaction = useCallback(
    async (messageId: string, emoji: string) => {
      if (channelId === null) return;
      // The shell exposes a structural subset of the store (StoreLike); the
      // reaction seam patches rows and so needs the full store surface.
      const optimistic = beginOptimisticReaction(store as StateStore, {
        channel_id: channelId,
        message_id: messageId,
        user_id: store.getState().currentUser?.id ?? '',
        emoji,
      });
      if (optimistic === null) return;
      try {
        if (optimistic.op === 'add') await api.addReaction(channelId, messageId, emoji);
        else await api.removeReaction(channelId, messageId, emoji);
      } catch {
        optimistic.rollback();
      }
    },
    [api, channelId, store],
  );

  const submitEdit = useCallback(
    async (messageId: string, content: string) => {
      if (channelId === null) return;
      await api.editMessage(channelId, messageId, { content });
    },
    [api, channelId],
  );

  const confirmDelete = useCallback(
    async (messageId: string) => {
      if (channelId === null) return;
      await api.deleteMessage(channelId, messageId);
    },
    [api, channelId],
  );

  const startThreadNamed = useCallback(
    async (messageId: string, name: string) => {
      if (channelId === null) return;
      const thread = await api.startThread(channelId, messageId, name);
      router.push(`/thread/${thread.id}`);
    },
    [api, channelId, router],
  );

  return (
    <SurfaceScaffold
      testID="surface-channel"
      title={channel === undefined ? `#${channelId ?? ''}` : `#${channel.name}`}
      subtitle={channel?.topic ?? undefined}
      onOpenDrawer={openDrawer}
      onOpenMembers={openMembers}
      headerAction={
        channelId === null || channel === undefined ? undefined : (
          <NotificationLevelButton
            target={{
              scope: 'channel',
              entityId: channelId,
              channelId,
              workspaceId: channel.workspace_id ?? null,
            }}
            store={store}
            api={api as unknown as NotificationPrefsApi}
            targetName={`#${channel.name}`}
          />
        )
      }
      states={{ ...shared, loading, error }}
    >
      <KeyboardAvoidingView
        style={[styles.body, keyboardInset > 0 ? { paddingBottom: Math.max(0, keyboardInset - insets.bottom + 12) } : null]}
        testID="channel-body"
        behavior={undefined}
      >
        {channelId === null ? null : (
          <>
            <MessageList
              key={channelId}
              keyboardInset={keyboardInset}
              channelId={channelId}
              loadPage={loadPage}
              enabled={authStatus === 'authenticated'}
              canManageMessages={canManageMessages}
              onReply={setReplyTo}
              onToggleReaction={toggleReaction}
              onEditSubmit={submitEdit}
              onDeleteConfirmed={confirmDelete}
              onStartThreadNamed={startThreadNamed}
            />
            <Composer channelId={channelId} replyTo={replyTo} onCancelReply={cancelReply} />
          </>
        )}
      </KeyboardAvoidingView>
    </SurfaceScaffold>
  );
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
  },
});
