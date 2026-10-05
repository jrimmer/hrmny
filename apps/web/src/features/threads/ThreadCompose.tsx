/**
 * @cytale/web — thread composer (U22).
 *
 * Reuses the U21 Lexical MessageCompose verbatim (doctrine: the thread
 * surface is the same message-panel component, narrower). The only
 * difference is the send path: thread replies POST to `/threads/{id}/messages`
 * (api.sendThreadMessage) and reconcile the store's `messagesByThread` slice
 * via a ThreadMessageCreate event — the channel composer posts to the
 * channel endpoint.
 *
 * DRAFT threads (`threadId === null`) are created BY that first send:
 * POST /channels/{c}/messages/{m}/threads, then the reply. A panel opened and
 * closed without a reply leaves no thread behind (user direction 2026-09-12).
 *
 * That first send is optimistic too (2026-10-01, owner: "no blanking, no
 * flashing"): the reply is drawn at once as a pending row in the draft's own
 * window (`draftThreadKey`), the create and the reply then ride the send
 * queue as one `thread-create` send, and the created thread takes the
 * draft's window over in place (`promoteDraftThread`). A create that fails
 * leaves the row in the draft, marked failed — Retry runs the create again,
 * Edit puts the text back in the box, Delete drops it — so the text is never
 * lost and no thread exists until one reply really lands in it.
 */

import { useMemo, useRef, useState } from 'react';
import type { LexicalEditor } from 'lexical';

import type { Thread, UploadedAttachment } from '@cytale/api-client';
import { defaultStore, draftThreadKey, seedDraftThread, type StateStore } from '@cytale/state';

import type { UseTyping } from '../presence/useTyping.js';
import { MessageCompose, threadDraftScope } from '../messages/MessageCompose.js';
import {
  createdThreadFor,
  registerDraftThread,
  useMessageSender,
  type UseMessages,
} from '../messages/useMessages.js';

export interface ThreadComposeProps {
  /** The thread this composer posts into; `null` = a draft (creates on send). */
  threadId: string | null;
  /** The parent channel id (placeholder, uploads, and the draft key's prefix —
   *  the draft itself is keyed by the THREAD, see `threadDraftScope`). */
  channelId: string;
  /** Draft only: the seed message the created thread hangs off. */
  parentMessageId?: string | null;
  /** Draft only: the name the created thread carries (seed-derived). */
  draftName?: string;
  /** Draft only: called with the created thread so the host can reconcile. */
  onThreadCreated?: (thread: Thread) => void;
  /** Display name for the placeholder; falls back to the channel id. */
  channelName?: string;
  /** U17 store (injectable for tests; app uses the module default). */
  store?: StateStore;
  /** Override the typing hook (tests). Live sessions use the default — the
      composer owns both the indicator and the emit; this carries the seam. */
  typing?: UseTyping;
  /** Test seam passthrough (MessageCompose's onEditorReady — jsdom cannot
   * drive Lexical input; the calls-plan log tests exercise the real
   * Enter→send wiring through it). */
  onEditorReady?: (editor: LexicalEditor) => void;
  /** Imperative upload seam forwarded to MessageCompose — the drop zones
   *  on the thread panel / call log ride it (React 19 ref-as-prop). */
  ref?: React.Ref<import('../messages/MessageCompose.js').ComposerHandle>;
  /** Inline reply inside the thread (the panel's `useReplyTarget`), the same
   *  reply bar and ping toggle the channel composer shows. */
  replyTo?: import('../messages/MessageCompose.js').ReplyTarget | null;
  onCancelReply?: () => void;
  onTogglePing?: () => void;
}

export function ThreadCompose({
  threadId,
  channelId,
  parentMessageId,
  draftName,
  onThreadCreated,
  store,
  channelName,
  onEditorReady,
  typing,
  ref,
  replyTo,
  onCancelReply,
  onTogglePing,
}: ThreadComposeProps) {
  // An EXISTING thread sends optimistically (2026-09-28), exactly as the
  // channel composer does: the pending row lands in the thread's slice at
  // once, the POST rides the thread endpoint in the thread's send queue, and a
  // failure stays in the thread as a failed row (Retry/Delete/Edit).
  const effectiveStore = store ?? defaultStore;
  const { send: optimisticSend } = useMessageSender(effectiveStore);
  // The latest host callback, read when the create answers (the send may
  // outlive the render that started it).
  const onCreatedRef = useRef(onThreadCreated);
  onCreatedRef.current = onThreadCreated;
  /** The thread this composer's draft became (its text slot follows it). */
  const [promotedTo, setPromotedTo] = useState<string | null>(null);
  const setPromotedRef = useRef(setPromotedTo);
  // A thread-aware messages adapter: send routes to the thread endpoint and
  // reconciles messagesByThread. Reads/writes the same store the panel uses.
  const threadMessages: UseMessages = useMemo(() => {
    const currentUserId = () => store?.getState().currentUser?.id ?? null;
    const messages = () =>
      threadId === null ? [] : (store?.getState().messagesByThread[threadId]?.items ?? []);
    const send = async (
      _ch: string,
      content: string,
      _threadId?: string | null,
      replyToId?: string | null,
      attachments?: UploadedAttachment[],
    ) => {
      if (threadId !== null) {
        return optimisticSend(channelId, content, threadId, replyToId ?? null, attachments ?? [], {
          route: 'thread',
        });
      }
      // DRAFT: the thread does not exist yet. Its first reply is what creates
      // it — opening the panel and closing it posts nothing (user direction
      // 2026-09-12: "the thread shouldn't be created if there aren't any
      // replies in it"). The reply is drawn NOW, in the draft's window, and
      // the create + reply go out as one queued `thread-create` send.
      if (parentMessageId == null) throw new Error('Thread seed message missing.');
      const key = draftThreadKey(channelId, parentMessageId);
      registerDraftThread(key, {
        channelId,
        parentMessageId,
        name: draftName ?? 'New thread',
        onCreated: (created) => {
          setPromotedRef.current(created.id);
          onCreatedRef.current?.(created);
        },
      });
      // A second reply typed before the host switched to the created thread
      // goes straight into it.
      const created = createdThreadFor(key);
      if (created !== null) {
        return optimisticSend(channelId, content, created, replyToId ?? null, attachments ?? [], {
          route: 'thread',
        });
      }
      seedDraftThread(effectiveStore, key);
      return optimisticSend(channelId, content, key, replyToId ?? null, attachments ?? [], {
        route: 'thread-create',
      });
    };
    // The composer only SENDS. Edit, delete and reactions on a reply are the
    // row's actions, run by the panel's list through the shared useMessages
    // effects (#15) — never through this adapter, which carries inert members
    // only to satisfy the seam's shape.
    const edit = async () => {};
    const remove = async () => {};
    const toggleReaction = async () => {};
    const reactionError = () => null;
    const clearReactionError = () => {};
    return {
      messages,
      send,
      edit,
      remove,
      toggleReaction,
      reactionError,
      clearReactionError,
      currentUserId,
    };
  }, [threadId, channelId, parentMessageId, draftName, store, effectiveStore, optimisticSend]);

  // The draft's text slot follows the draft into its thread: anything typed
  // while the create was in flight stays in the box (and is saved under the
  // thread's key) instead of being cleared by the key change.
  const carryDraftFrom =
    threadId !== null && threadId === promotedTo && parentMessageId != null
      ? threadDraftScope(channelId, null, parentMessageId)
      : undefined;

  return (
    <MessageCompose
      ref={ref}
      channelId={channelId}
      threadId={threadId}
      /* The thread's OWN draft slot: keyed by the parent channel alone, a reply
         typed here overwrote — and then reappeared in — the channel composer. */
      draftScope={threadDraftScope(channelId, threadId, parentMessageId)}
      messages={threadMessages}
      channelName={channelName}
      isThread
      /* The panel's store, not the module default: the typing label and the
         mention context resolve names through it, and an injected store (the
         tests') must not diverge from the pane's projection. */
      store={store}
      typing={typing}
      onEditorReady={onEditorReady}
      replyTo={replyTo ?? null}
      onCancelReply={onCancelReply}
      onTogglePing={onTogglePing}
      carryDraftFrom={carryDraftFrom}
    />
  );
}
