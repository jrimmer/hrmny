/**
 * @cytale/web — ThreadCompose tests (draft threads, 2026-09-12).
 *
 * A thread is only created by its first reply: opening the panel from
 * "Start thread" renders a DRAFT, and closing it posts nothing. The user's
 * report was a thread they started and closed without posting — it existed
 * afterwards with zero replies.
 *
 * jsdom cannot drive Lexical text input (no `beforeinput`), so these tests set
 * editor content via `editor.update()` and dispatch the Enter command through
 * the `onEditorReady` seam — the real Enter→send wiring, same as the U21 suite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import React from 'react';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  KEY_ENTER_COMMAND,
  type LexicalEditor,
} from 'lexical';
import type { Thread } from '@cytale/domain';
import { createStateStore, type StateStore } from '@cytale/state';

import { ThreadCompose } from '../ThreadCompose.js';
import { api, authStore } from '../../auth/session.js';

const CHANNEL = '9007199254740993';
const PARENT = '1000000000000001';
const THREAD = '1000000000000009';
const ME = '7000000000000002';

const CREATED: Thread = {
  id: THREAD,
  channel_id: CHANNEL,
  parent_message_id: PARENT,
  name: 'Deploy talk',
  created_by: ME,
  archived: false,
  created_at: '2026-09-12T12:00:00Z',
};

function setEditorText(editor: LexicalEditor, text: string): void {
  editor.update(() => {
    const root = $getRoot();
    root.clear();
    root.append($createParagraphNode().append($createTextNode(text)));
  });
}

function pressEnter(editor: LexicalEditor): void {
  editor.dispatchCommand(KEY_ENTER_COMMAND, {
    shiftKey: false,
    preventDefault: () => {},
  } as unknown as KeyboardEvent);
}

function makeStore(): StateStore {
  const store = createStateStore();
  store.setState({ currentUser: { id: ME, username: 'me' } });
  return store;
}

async function renderDraft(store: StateStore, onThreadCreated = vi.fn()) {
  let editor: LexicalEditor | null = null;
  render(
    <ThreadCompose
      threadId={null}
      channelId={CHANNEL}
      parentMessageId={PARENT}
      draftName="Deploy talk"
      onThreadCreated={onThreadCreated}
      store={store}
      onEditorReady={(e) => {
        editor = e;
      }}
    />,
  );
  await waitFor(() => expect(editor).not.toBeNull());
  return { editor: editor!, onThreadCreated };
}

beforeEach(() => {
  authStore.getState().reset();
  authStore.getState().setStatus('authenticated');
  authStore.getState().setVerified(true);
  authStore.getState().setUser({
    id: ME,
    username: 'me',
    email: 'me@example.com',
    email_verified_at: '2026-08-30T00:00:00Z',
  });
  globalThis.localStorage?.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ThreadCompose — a draft creates nothing until it is sent', () => {
  it('mounting a draft posts nothing at all', async () => {
    const startThread = vi.spyOn(api, 'startThread');
    await renderDraft(makeStore());
    // The whole point of the draft: opening the pane is not an act of
    // creation.
    expect(startThread).not.toHaveBeenCalled();
    expect(screen.getByTestId('message-compose')).toBeTruthy();
  });

  it('the first reply creates the thread, then lands in it', async () => {
    const store = makeStore();
    const startThread = vi.spyOn(api, 'startThread').mockResolvedValue(CREATED);
    const sendThread = vi.spyOn(api, 'sendThreadMessage').mockResolvedValue({
      id: '1000000000000010',
      channel_id: CHANNEL,
      author_id: ME,
      content: 'first reply',
      created_at: '2026-09-12T12:00:05Z',
      edited_at: null,
    } as never);

    const onThreadCreated = vi.fn((thread: Thread) => {
      // The host's own write (AuthenticatedApp.handleThreadCreated): the
      // created thread lands in the store, as the server returned it — with
      // zero replies, because it had none when it was created.
      store.setState((s) => ({
        threadsById: { ...s.threadsById, [thread.id]: { ...thread, message_count: 0 } },
        threadIdsByChannel: { ...s.threadIdsByChannel, [CHANNEL]: [thread.id] },
      }));
    });
    const { editor } = await renderDraft(store, onThreadCreated);

    setEditorText(editor, 'first reply');
    pressEnter(editor);

    await waitFor(() => expect(sendThread).toHaveBeenCalled());
    // Create carries the draft's own name and its seed message — nothing was
    // created earlier with a placeholder.
    expect(startThread).toHaveBeenCalledWith(CHANNEL, PARENT, 'Deploy talk');
    // The reply goes into the CREATED thread, not a null id (nor the draft's
    // client key), under its send nonce.
    const [target, body] = sendThread.mock.calls[0]!;
    expect(target).toBe(THREAD);
    expect(body).toMatchObject({ content: 'first reply' });
    // The draft's window became the thread's: no draft slice is left behind.
    expect(
      Object.keys(store.getState().messagesByThread).filter((k) => k.startsWith('draft_')),
    ).toEqual([]);
    // The host is told, so it can put the thread in the store and promote the
    // open draft to it.
    expect(onThreadCreated).toHaveBeenCalledWith(CREATED);
    // The reply reconciled into the created thread's slice...
    await waitFor(() =>
      expect(store.getState().messagesByThread[THREAD]?.items.length).toBe(1),
    );
    // ...and the thread now HAS a reply, so the seed message's indicator (which
    // renders only threads with replies) can show it.
    await waitFor(() => {
      const t = store.getState().threadsById[THREAD];
      expect(t?.message_count).toBe(1);
      expect(t?.latest_reply_at).toBe('2026-09-12T12:00:05Z');
    });
  });

  it('a create that fails leaves nothing created and does not post a reply', async () => {
    const store = makeStore();
    vi.spyOn(api, 'startThread').mockRejectedValue(new Error('403'));
    const sendThread = vi.spyOn(api, 'sendThreadMessage');

    const { editor, onThreadCreated } = await renderDraft(store);
    setEditorText(editor, 'first reply');
    pressEnter(editor);

    await waitFor(() => expect(onThreadCreated).not.toHaveBeenCalled());
    expect(sendThread).not.toHaveBeenCalled();
  });
});

describe('ThreadCompose — an existing thread posts straight into it', () => {
  it('sends to the thread id and never calls create', async () => {
    const store = makeStore();
    const startThread = vi.spyOn(api, 'startThread');
    const sendThread = vi.spyOn(api, 'sendThreadMessage').mockResolvedValue({
      id: '1000000000000011',
      channel_id: CHANNEL,
      author_id: ME,
      content: 'a reply',
      created_at: '2026-09-12T12:01:00Z',
      edited_at: null,
    } as never);

    let editor: LexicalEditor | null = null;
    render(
      <ThreadCompose
        threadId={THREAD}
        channelId={CHANNEL}
        store={store}
        onEditorReady={(e) => {
          editor = e;
        }}
      />,
    );
    await waitFor(() => expect(editor).not.toBeNull());

    setEditorText(editor!, 'a reply');
    pressEnter(editor!);

    await waitFor(() => expect(sendThread).toHaveBeenCalled());
    // Optimistic (2026-09-28): the reply presents its nonce as the
    // Idempotency-Key, so a retry of an unanswered send can never land twice.
    const [target, body, key] = sendThread.mock.calls[0]!;
    expect(target).toBe(THREAD);
    expect(body).toMatchObject({ content: 'a reply' });
    expect(typeof key).toBe('string');
    expect(startThread).not.toHaveBeenCalled();
    // Confirmed in place: one row, the server's, keyed by the send's nonce.
    await waitFor(() => {
      const items = store.getState().messagesByThread[THREAD]?.items ?? [];
      expect(items.map((m) => m.id)).toEqual(['1000000000000011']);
      expect(items[0]!.client_key).toBe(key);
    });
  });

  it('clears the box and draws the pending reply BEFORE the thread endpoint answers', async () => {
    const store = makeStore();
    let answer: (m: unknown) => void = () => {};
    vi.spyOn(api, 'sendThreadMessage').mockImplementation(
      () => new Promise((resolve) => (answer = resolve as (m: unknown) => void)) as never,
    );
    let editor: LexicalEditor | null = null;
    render(
      <ThreadCompose
        threadId={THREAD}
        channelId={CHANNEL}
        store={store}
        onEditorReady={(e) => {
          editor = e;
        }}
      />,
    );
    await waitFor(() => expect(editor).not.toBeNull());
    setEditorText(editor!, 'still in flight');
    pressEnter(editor!);

    await waitFor(() =>
      expect(editor!.getEditorState().read(() => $getRoot().getTextContent())).toBe(''),
    );
    const pending = store.getState().messagesByThread[THREAD]?.items ?? [];
    expect(pending).toHaveLength(1);
    expect(pending[0]!.send_state).toBe('pending');
    expect(pending[0]!.content).toBe('still in flight');

    answer({
      id: '1000000000000013',
      channel_id: CHANNEL,
      author_id: ME,
      content: 'still in flight',
      created_at: '2026-09-12T12:03:00Z',
      edited_at: null,
    });
    await waitFor(() =>
      expect(store.getState().messagesByThread[THREAD]?.items.map((m) => m.id)).toEqual([
        '1000000000000013',
      ]),
    );
    expect(store.getState().messagesByThread[THREAD]!.items[0]!.send_state).toBeUndefined();
  });

  it('a failed reply STAYS in the thread, marked failed, and the box stays clear', async () => {
    const store = makeStore();
    vi.spyOn(api, 'sendThreadMessage').mockRejectedValue(
      Object.assign(new Error('server exploded'), { key: 'internal', code: 50000 }),
    );
    let editor: LexicalEditor | null = null;
    render(
      <ThreadCompose
        threadId={THREAD}
        channelId={CHANNEL}
        store={store}
        onEditorReady={(e) => {
          editor = e;
        }}
      />,
    );
    await waitFor(() => expect(editor).not.toBeNull());
    setEditorText(editor!, 'doomed reply');
    pressEnter(editor!);

    await waitFor(() =>
      expect(store.getState().messagesByThread[THREAD]?.items[0]?.send_state).toBe('failed'),
    );
    expect(editor!.getEditorState().read(() => $getRoot().getTextContent())).toBe('');
    expect(Object.values(store.getState().failedByNonce)[0]).toMatchObject({
      thread_id: THREAD,
      content: 'doomed reply',
      held: true,
    });
  });
});

describe('ThreadCompose — a DRAFT\'s first reply is optimistic too (2026-10-01)', () => {
  const DRAFT_KEY = `draft_${CHANNEL}_${PARENT}`;

  it('clears the box and draws the pending reply in the draft BEFORE the create answers', async () => {
    const store = makeStore();
    let answerCreate: (t: Thread) => void = () => {};
    vi.spyOn(api, 'startThread').mockImplementation(
      () => new Promise<Thread>((resolve) => (answerCreate = resolve)),
    );
    const sendThread = vi.spyOn(api, 'sendThreadMessage').mockResolvedValue({
      id: '1000000000000020',
      channel_id: CHANNEL,
      author_id: ME,
      content: 'first reply',
      created_at: '2026-09-12T12:00:05Z',
      edited_at: null,
    } as never);
    const { editor, onThreadCreated } = await renderDraft(store);
    setEditorText(editor, 'first reply');
    pressEnter(editor);

    // At once: the box is clear and the reply is a pending row in the draft.
    await waitFor(() =>
      expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe(''),
    );
    const draft = store.getState().messagesByThread[DRAFT_KEY];
    expect(draft?.hasCompleteHistory).toBe(true);
    expect(draft?.items.map((m) => [m.content, m.send_state])).toEqual([['first reply', 'pending']]);
    const rowKey = draft!.items[0]!.client_key;
    expect(sendThread).not.toHaveBeenCalled();

    answerCreate(CREATED);
    // The created thread took the draft's window over — same row, same key.
    await waitFor(() => expect(onThreadCreated).toHaveBeenCalledWith(CREATED));
    await waitFor(() =>
      expect(store.getState().messagesByThread[THREAD]?.items.map((m) => m.id)).toEqual([
        '1000000000000020',
      ]),
    );
    expect(store.getState().messagesByThread[THREAD]!.items[0]!.client_key).toBe(rowKey);
    expect(store.getState().messagesByThread[DRAFT_KEY]).toBeUndefined();
    expect(store.getState().threadsById[THREAD]?.id).toBe(THREAD);
  });

  it('text typed while the create is in flight stays in the box when the draft becomes the thread', async () => {
    const store = makeStore();
    let answerCreate: (t: Thread) => void = () => {};
    vi.spyOn(api, 'startThread').mockImplementation(
      () => new Promise<Thread>((resolve) => (answerCreate = resolve)),
    );
    vi.spyOn(api, 'sendThreadMessage').mockResolvedValue({
      id: '1000000000000022',
      channel_id: CHANNEL,
      author_id: ME,
      content: 'first',
      created_at: '2026-09-12T12:00:07Z',
      edited_at: null,
    } as never);
    let editor: LexicalEditor | null = null;
    function Host() {
      const [threadId, setThreadId] = React.useState<string | null>(null);
      return (
        <ThreadCompose
          threadId={threadId}
          channelId={CHANNEL}
          parentMessageId={PARENT}
          draftName="Deploy talk"
          onThreadCreated={(t) => setThreadId(t.id)}
          store={store}
          onEditorReady={(e) => {
            editor = e;
          }}
        />
      );
    }
    render(<Host />);
    await waitFor(() => expect(editor).not.toBeNull());
    setEditorText(editor!, 'first');
    pressEnter(editor!);
    await waitFor(() =>
      expect(editor!.getEditorState().read(() => $getRoot().getTextContent())).toBe(''),
    );
    setEditorText(editor!, 'still typing');

    answerCreate(CREATED);
    await waitFor(() =>
      expect(globalThis.localStorage?.getItem(`cytale.draft.${ME}.${CHANNEL}.t.${THREAD}`)).toBe(
        'still typing',
      ),
    );
    expect(editor!.getEditorState().read(() => $getRoot().getTextContent())).toBe('still typing');
    expect(globalThis.localStorage?.getItem(`cytale.draft.${ME}.${CHANNEL}.p.${PARENT}`) ?? '').toBe('');
  });

  it("a failed first reply that a later reply's create carried into the thread retries into it", async () => {
    const store = makeStore();
    const startThread = vi
      .spyOn(api, 'startThread')
      .mockRejectedValueOnce(Object.assign(new Error('blip'), { key: 'internal', code: 50000 }))
      .mockResolvedValueOnce(CREATED);
    let n = 0;
    const sendThread = vi.spyOn(api, 'sendThreadMessage').mockImplementation(
      async (_t, body) =>
        ({
          id: `10000000000000${30 + n++}`,
          channel_id: CHANNEL,
          author_id: ME,
          content: (body as { content: string }).content,
          created_at: `2026-09-12T12:00:1${n}Z`,
          edited_at: null,
        }) as never,
    );
    const { editor } = await renderDraft(store);
    setEditorText(editor, 'one');
    pressEnter(editor);
    await waitFor(() =>
      expect(store.getState().messagesByThread[DRAFT_KEY]?.items[0]?.send_state).toBe('failed'),
    );
    setEditorText(editor, 'two');
    pressEnter(editor);
    // The second reply's create succeeded: the whole draft (the failed row
    // too) is the thread's now.
    await waitFor(() =>
      expect(store.getState().messagesByThread[THREAD]?.items.map((m) => m.content).sort()).toEqual([
        'one',
        'two',
      ]),
    );
    const [nonce, failed] = Object.entries(store.getState().failedByNonce)[0]!;
    expect(failed.thread_id).toBe(THREAD);

    const { retrySend } = await import('../../messages/useMessages.js');
    await retrySend(store, nonce);
    // No second create: the retry posts straight into the thread.
    expect(startThread).toHaveBeenCalledTimes(2);
    expect(sendThread.mock.calls.map((c) => c[0])).toEqual([THREAD, THREAD]);
    expect(store.getState().failedByNonce).toEqual({});
  });

  it('a failed create keeps the text as a failed row in the draft, and Retry creates the thread', async () => {
    const store = makeStore();
    const startThread = vi
      .spyOn(api, 'startThread')
      .mockRejectedValueOnce(Object.assign(new Error('Server error'), { key: 'internal', code: 50000 }))
      .mockResolvedValueOnce(CREATED);
    const sendThread = vi.spyOn(api, 'sendThreadMessage').mockResolvedValue({
      id: '1000000000000021',
      channel_id: CHANNEL,
      author_id: ME,
      content: 'keep me',
      created_at: '2026-09-12T12:00:06Z',
      edited_at: null,
    } as never);
    const { editor, onThreadCreated } = await renderDraft(store);
    setEditorText(editor, 'keep me');
    pressEnter(editor);

    await waitFor(() =>
      expect(store.getState().messagesByThread[DRAFT_KEY]?.items[0]?.send_state).toBe('failed'),
    );
    // Nothing was created, nothing was posted — and the text is not lost.
    expect(onThreadCreated).not.toHaveBeenCalled();
    expect(sendThread).not.toHaveBeenCalled();
    const [nonce, failed] = Object.entries(store.getState().failedByNonce)[0]!;
    expect(failed).toMatchObject({ thread_id: DRAFT_KEY, content: 'keep me', held: true });

    // The row's Retry runs the create again, then the reply.
    const { retrySend } = await import('../../messages/useMessages.js');
    await retrySend(store, nonce);
    expect(startThread).toHaveBeenCalledTimes(2);
    expect(onThreadCreated).toHaveBeenCalledWith(CREATED);
    expect(sendThread.mock.calls[0]![0]).toBe(THREAD);
    expect(store.getState().messagesByThread[THREAD]?.items.map((m) => m.content)).toEqual([
      'keep me',
    ]);
    expect(store.getState().failedByNonce).toEqual({});
  });
});

describe('ThreadCompose — a reply inside the thread', () => {
  it('sends reply_to_id with the reply target, shows the reply bar, and pings by default', async () => {
    const store = makeStore();
    const sendThread = vi.spyOn(api, 'sendThreadMessage').mockResolvedValue({
      id: '1000000000000012',
      channel_id: CHANNEL,
      author_id: ME,
      content: 'agreed',
      created_at: '2026-09-12T12:02:00Z',
      edited_at: null,
    } as never);
    const onCancelReply = vi.fn();

    let editor: LexicalEditor | null = null;
    render(
      <ThreadCompose
        threadId={THREAD}
        channelId={CHANNEL}
        store={store}
        replyTo={{
          messageId: '1000000000000010',
          authorId: '7000000000000003',
          authorName: 'zoe',
          snippet: 'ship it?',
          ping: true,
        }}
        onCancelReply={onCancelReply}
        onTogglePing={() => {}}
        onEditorReady={(e) => {
          editor = e;
        }}
      />,
    );
    await waitFor(() => expect(editor).not.toBeNull());
    expect(screen.getByTestId('reply-bar').textContent).toContain('zoe');

    setEditorText(editor!, 'agreed');
    pressEnter(editor!);

    await waitFor(() => expect(sendThread).toHaveBeenCalled());
    const [target, body] = sendThread.mock.calls[0]!;
    expect(target).toBe(THREAD);
    expect(body).toMatchObject({ reply_to_id: '1000000000000010', content: '<@7000000000000003> agreed' });
  });
});

// ---------------------------------------------------------------------------
// #128 — the thread composer's typing emit carries the THREAD scope
//
// The composer owns both the indicator and the signal. A keystroke here must
// reach the gateway as (parent channel, THREAD) — a channel-only emit keys a
// different bucket on every receiving client, and the thread pane's indicator
// (which looks the pair up) renders nowhere.
// ---------------------------------------------------------------------------
describe('ThreadCompose — typing emit scope (#128)', () => {
  it('emits the thread-scoped pair for a keystroke in the thread composer', async () => {
    const store = makeStore();
    const sendTyping = vi.fn();
    const typists = vi.fn(() => []);
    let editor: LexicalEditor | null = null;
    render(
      <ThreadCompose
        threadId={THREAD}
        channelId={CHANNEL}
        store={store}
        typing={{ typists, sendTyping }}
        onEditorReady={(e) => {
          editor = e;
        }}
      />,
    );
    await waitFor(() => expect(editor).not.toBeNull());

    setEditorText(editor!, 'typing a reply');
    // (channel, thread) — never the bare channel: that pair is what the pane
    // (and every other session's thread pane) keys the indicator on.
    await waitFor(() => expect(sendTyping).toHaveBeenCalledWith(CHANNEL, THREAD));
  });
});

describe('ThreadCompose — the thread keeps its own draft', () => {
  // A reply typed in a thread used to be saved under the CHANNEL's key
  // (`cytale.draft.<channel>`), so it overwrote the channel's unsent message
  // and then reappeared in the channel composer.
  it('saves under the thread key and leaves the channel draft alone', async () => {
    globalThis.localStorage?.setItem(`cytale.draft.${ME}.${CHANNEL}`, 'channel text');
    let editor: LexicalEditor | null = null;
    render(
      <ThreadCompose
        threadId={THREAD}
        channelId={CHANNEL}
        store={makeStore()}
        onEditorReady={(e) => {
          editor = e;
        }}
      />,
    );
    await waitFor(() => expect(editor).not.toBeNull());
    // The channel's draft is not loaded into the thread composer.
    editor!.getEditorState().read(() => {
      expect($getRoot().getTextContent()).toBe('');
    });
    setEditorText(editor!, 'thread reply');
    await waitFor(() =>
      expect(globalThis.localStorage?.getItem(`cytale.draft.${ME}.${CHANNEL}.t.${THREAD}`)).toBe(
        'thread reply',
      ),
    );
    expect(globalThis.localStorage?.getItem(`cytale.draft.${ME}.${CHANNEL}`)).toBe('channel text');
  });

  it('restores a thread draft on reopen, and a draft thread keys by its seed', async () => {
    globalThis.localStorage?.setItem(`cytale.draft.${ME}.${CHANNEL}.t.${THREAD}`, 'kept reply');
    let editor: LexicalEditor | null = null;
    const { unmount } = render(
      <ThreadCompose
        threadId={THREAD}
        channelId={CHANNEL}
        store={makeStore()}
        onEditorReady={(e) => {
          editor = e;
        }}
      />,
    );
    await waitFor(() => expect(editor).not.toBeNull());
    await waitFor(() =>
      editor!.getEditorState().read(() => {
        expect($getRoot().getTextContent()).toBe('kept reply');
      }),
    );
    unmount();

    const { editor: draftEditor } = await renderDraft(makeStore());
    setEditorText(draftEditor, 'seed reply');
    await waitFor(() =>
      expect(globalThis.localStorage?.getItem(`cytale.draft.${ME}.${CHANNEL}.p.${PARENT}`)).toBe(
        'seed reply',
      ),
    );
    expect(globalThis.localStorage?.getItem(`cytale.draft.${ME}.${CHANNEL}.t.${THREAD}`)).toBe('kept reply');
  });
});
