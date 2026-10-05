/**
 * @cytale/mobile — the thread surface body (plan 004 M9, R12).
 *
 * The full-surface thread view's content: the reply list over the composer,
 * the same arrangement the channel surface uses, wrapped in
 * `KeyboardAvoidingView` so the composer rides above the keyboard (R9). The
 * route owns the states-first frame (`SurfaceScaffold`) and the REST seams;
 * this component arranges them.
 *
 * `send` and `upload` are REQUIRED, not optional, on purpose: `Composer`'s
 * default send posts to the channel endpoint without a `thread_id`, so a
 * thread reply must go through the injected thread seam (`useThreadSend`) or
 * it silently lands in the wrong timeline. Requiring the seam makes the
 * correct wiring the only wiring.
 */
import { KeyboardAvoidingView, Platform, StyleSheet } from 'react-native';

import { useKeyboardInset } from '../navigation/useKeyboardInset';

import type { Thread } from '@cytale/domain';
import type { StateStore } from '@cytale/state';

import { Composer } from '../composer/Composer';
import type { SendMessage, UploadAttachment } from '../composer/types';
import { defaultStore } from '../navigation/store';
import type { PermalinkMinter } from '../messages/messagePermalink';
import { ThreadMessageList } from './ThreadMessageList';
import type { LoadThreadPage } from './useThreadWindow';

export interface ThreadBodyProps {
  /** The thread this surface shows (metadata resolved by the route). */
  thread: Thread;
  /** Stable thread page loader (see `useThreadWindow`). */
  loadPage: LoadThreadPage;
  /** Thread-scoped send seam (`useThreadSend`); never the channel default. */
  send: SendMessage;
  /** Upload seam (channel-scoped uploads back both surfaces). */
  upload: UploadAttachment;
  /** Store holding the window; `defaultStore` in production. */
  store?: StateStore;
  /** Session gate — false while unauthenticated (no fetch). */
  enabled?: boolean;
  /** Current user id; defaults to the store's. */
  currentUserId?: string | null;
  /** Sheet edit commit (host owns the REST call). */
  onEditSubmit?: (messageId: string, content: string) => void;
  /** Sheet delete confirm (host owns the REST call). */
  onDeleteConfirmed?: (messageId: string) => void;
  /** True when the viewer holds MANAGE_MESSAGES (sheet delete gate). */
  canManageMessages?: boolean;
  /** The permalink minter (#118); production omits it (the session's api client). */
  mintPermalink?: PermalinkMinter;
  /** Opens link runs; default is the platform browser. */
  onOpenLink?: (href: string) => void;
  testID?: string;
}

export function ThreadBody({
  thread,
  loadPage,
  send,
  upload,
  store = defaultStore,
  enabled,
  currentUserId,
  onEditSubmit,
  onDeleteConfirmed,
  canManageMessages,
  mintPermalink,
  onOpenLink,
  testID = 'thread-body',
}: ThreadBodyProps) {
  const keyboardInset = useKeyboardInset();
  return (
    <KeyboardAvoidingView
      style={[styles.body, keyboardInset > 0 ? { paddingBottom: keyboardInset } : null]}
      testID={testID}
      behavior={undefined}
    >
      <ThreadMessageList
        threadId={thread.id}
        loadPage={loadPage}
        store={store}
        {...(enabled === undefined ? {} : { enabled })}
        {...(currentUserId === undefined ? {} : { currentUserId })}
        {...(onEditSubmit === undefined ? {} : { onEditSubmit })}
        {...(onDeleteConfirmed === undefined ? {} : { onDeleteConfirmed })}
        {...(canManageMessages === undefined ? {} : { canManageMessages })}
        {...(mintPermalink === undefined ? {} : { mintPermalink })}
        {...(onOpenLink === undefined ? {} : { onOpenLink })}
      />
      <Composer
        channelId={thread.channel_id}
        threadId={thread.id}
        store={store}
        send={send}
        upload={upload}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
  },
});
