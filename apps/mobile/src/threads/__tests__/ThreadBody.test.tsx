/**
 * The thread surface body (plan 004 M9, R12 + R15).
 *
 * The plan's scenarios live here at the component level: opening a thread
 * shows its replies, sending appends to the window, a thread with no replies
 * renders its empty state — plus the states-first set the repo holds every
 * surface to. The REAL FlashList and the REAL composer run; only the REST
 * seams are injected (the same seams the route fills from the session).
 */
import type { ReactElement } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';

import type { UploadedAttachment } from '@cytale/api-client';
import type { Message, Thread } from '@cytale/domain';
import type { StateStore } from '@cytale/state';

import { resetEmojiPreferences } from '../../composer/emojiPreferences';
import type { SendInput } from '../../composer/types';
import type { PermalinkMinter } from '../../messages/messagePermalink';
import { LONG_PRESS_MS } from '../../messages/useLongPress';
import { resetSurfaceStates, setSurfaceStates } from '../../navigation/shellState';
import { ThreadBody } from '../ThreadBody';
import type { LoadThreadPage } from '../useThreadWindow';
import { useThreadSend, type ThreadSendApi } from '../useThreadSend';
import { IDS, makeReply, makeStore, replyId, threadRecord } from './support';

type PageParams = { before?: string; limit: number };

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const UPLOADED: UploadedAttachment = {
  filename: 'cat.png',
  content_type: 'image/png',
  size: 3,
  url: '/attachments/6000000000000001/cat.png',
};

/** A token spelled like a minted one (30 base62 characters, #118). */
const TOKEN = '3kQm9Xb2Qp7ZtR4vN8wY1cKdQ3uP';

function makeSendApi(): ThreadSendApi & { sendThreadMessage: jest.Mock } {
  return {
    sendThreadMessage: jest.fn(
      async (_threadId: string, body: { content: string }) =>
        makeReply(9, { author_id: IDS.me, content: body.content }),
    ),
  } as unknown as ThreadSendApi & { sendThreadMessage: jest.Mock };
}

interface HarnessProps {
  store: StateStore;
  loadPage: LoadThreadPage;
  send?: jest.Mock;
  onEditSubmit?: (messageId: string, content: string) => void;
  onDeleteConfirmed?: (messageId: string) => void;
  enabled?: boolean;
  /** #118: the Copy link minter (production derives it from the session). */
  mintPermalink?: PermalinkMinter;
}

/**
 * Wraps the body in the safe-area root the composer needs and builds the send
 * seam with the REAL `useThreadSend` (a hook cannot be called from the test
 * body) so the optimistic path is exercised, not stubbed.
 */
function Harness({ store, loadPage, send, ...rest }: HarnessProps): ReactElement {
  const api = makeSendApi();
  if (send !== undefined) api.sendThreadMessage.mockImplementation(send);
  const sendSeam = useThreadSend({ api, store, threadId: IDS.thread });
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThreadBody
        thread={threadRecord() as Thread}
        store={store}
        loadPage={loadPage}
        send={sendSeam}
        upload={jest.fn(async () => UPLOADED)}
        {...rest}
      />
    </SafeAreaProvider>
  );
}

async function renderBody(props: HarnessProps) {
  const result = await render(<Harness {...props} />);
  return result;
}

beforeEach(() => {
  resetSurfaceStates();
  resetEmojiPreferences();
});

afterEach(() => {
  resetSurfaceStates();
  resetEmojiPreferences();
  jest.useRealTimers();
});

describe('replies', () => {
  it('shows the thread\'s replies in chat order once they load', async () => {
    const store = makeStore();
    const loadPage = jest.fn(async (_params: PageParams) => [
      makeReply(3),
      makeReply(2),
      makeReply(1),
    ]);

    await renderBody({ store, loadPage });

    await waitFor(() => expect(screen.getByTestId(`message-row-${replyId(1)}`)).toBeTruthy());
    for (const n of [1, 2, 3]) {
      expect(screen.getByTestId(`message-row-${replyId(n)}`)).toBeTruthy();
    }
    expect(screen.getByText('reply 1')).toBeTruthy();
    expect(screen.getAllByTestId('message-author').length).toBeGreaterThan(0);
    // The composer is thread-scoped and present under the list.
    expect(screen.getByTestId('message-compose')).toBeTruthy();
    expect(screen.getByTestId('composer-input')).toBeTruthy();
  });

  it('appends the reply to the window when the composer sends', async () => {
    const store = makeStore();
    const loadPage = jest.fn(async (_params: PageParams) => [makeReply(1)]);
    const send = jest.fn(async (_threadId: string, body: { content: string }) =>
      makeReply(9, { author_id: IDS.me, content: body.content }),
    );

    await renderBody({ store, loadPage, send });
    await waitFor(() => expect(screen.getByTestId(`message-row-${replyId(1)}`)).toBeTruthy());

    await fireEvent.changeText(screen.getByTestId('composer-input'), 'a fresh reply');
    await waitFor(() =>
      expect(screen.getByTestId('composer-input').props.value).toBe('a fresh reply'),
    );
    await act(async () => {
      fireEvent.press(screen.getByTestId('composer-send'));
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe(IDS.thread);
    expect(send.mock.calls[0]![1]).toEqual({ content: 'a fresh reply' });
    // The confirmed row renders in the thread window (and the input cleared).
    await waitFor(() => expect(screen.getByText('a fresh reply')).toBeTruthy());
    expect(screen.getByTestId('composer-input').props.value).toBe('');
  });

  it('shows a loading state while the newest page is in flight', async () => {
    const store = makeStore();
    let resolvePage: (messages: Message[]) => void = () => undefined;
    const loadPage = jest.fn(
      async (_params: PageParams) =>
        new Promise<Message[]>((resolve) => {
          resolvePage = resolve;
        }),
    );

    await renderBody({ store, loadPage });

    expect(screen.getByTestId('thread-list-loading')).toBeTruthy();
    expect(screen.queryByTestId('thread-message-list')).toBeNull();

    await act(async () => {
      resolvePage([makeReply(1)]);
    });

    await waitFor(() => expect(screen.getByTestId(`message-row-${replyId(1)}`)).toBeTruthy());
    expect(screen.queryByTestId('thread-list-loading')).toBeNull();
  });

  it('renders the empty state for a thread with no replies', async () => {
    const store = makeStore();
    const loadPage = jest.fn(async (_params: PageParams) => []);

    await renderBody({ store, loadPage });

    await waitFor(() => expect(screen.getByTestId('thread-list-empty')).toBeTruthy());
    expect(screen.getByText('No replies yet')).toBeTruthy();
    expect(screen.getByText('Start the conversation.')).toBeTruthy();
    expect(screen.queryByTestId('thread-message-list')).toBeNull();
  });

  it('surfaces a load failure and retries from the list', async () => {
    const store = makeStore();
    let fail = true;
    const loadPage = jest.fn(async (_params: PageParams) => {
      if (fail) {
        fail = false;
        throw new Error('offline');
      }
      return [makeReply(1)];
    });

    await renderBody({ store, loadPage });

    await waitFor(() => expect(screen.getByTestId('thread-list-error')).toBeTruthy());
    expect(screen.getByText('Could not load replies.')).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByTestId('thread-list-retry'));
    });

    await waitFor(() => expect(screen.getByTestId(`message-row-${replyId(1)}`)).toBeTruthy());
  });

  it('replaces the composer with the view-only note when the member may not send', async () => {
    const store = makeStore();
    const loadPage = jest.fn(async (_params: PageParams) => [makeReply(1)]);

    await renderBody({ store, loadPage });
    await waitFor(() => expect(screen.getByTestId('composer-input')).toBeTruthy());

    await act(async () => setSurfaceStates({ viewOnly: true }));

    expect(screen.getByTestId('view-only-note')).toBeTruthy();
    expect(screen.queryByTestId('composer-input')).toBeNull();
    expect(screen.queryByTestId('composer-send')).toBeNull();
  });
});

describe('long-press actions in a thread', () => {
  /** Hold a row long enough to fire the long-press. */
  async function holdRow(id: string): Promise<void> {
    await fireEvent(screen.getByTestId(`message-row-${id}`), 'responderGrant', {
      nativeEvent: { pageX: 10, pageY: 100 },
    });
    await act(async () => {
      jest.advanceTimersByTime(LONG_PRESS_MS);
    });
  }

  it('offers edit, delete and copy on an own reply — and no reaction or reply row', async () => {
    const store = makeStore();
    const loadPage = jest.fn(async (_params: PageParams) => [
      makeReply(2, { author_id: IDS.me, content: 'mine' }),
      makeReply(1),
    ]);
    const onEditSubmit = jest.fn();
    const onDeleteConfirmed = jest.fn();

    await renderBody({ store, loadPage, onEditSubmit, onDeleteConfirmed });
    await waitFor(() => expect(screen.getByTestId(`message-row-${replyId(2)}`)).toBeTruthy());

    jest.useFakeTimers();
    await holdRow(replyId(2));

    const sheet = screen.getByTestId('message-actions-sheet');
    expect(within(sheet).getByTestId('sheet-action-edit')).toBeTruthy();
    expect(within(sheet).getByTestId('sheet-action-delete')).toBeTruthy();
    expect(within(sheet).getByTestId('sheet-action-copy')).toBeTruthy();
    // The thread surface wires no reaction toggle and no reply target.
    expect(within(sheet).queryByTestId('sheet-action-react')).toBeNull();
    expect(within(sheet).queryByTestId('sheet-action-reply')).toBeNull();
    expect(within(sheet).queryByTestId('sheet-action-thread')).toBeNull();

    await fireEvent.press(within(sheet).getByTestId('sheet-action-edit'));
    // The sheet's edit field is uncontrolled (defaultValue prefill) — drive it
    // the way the sheet's own tests do.
    const editInput = screen.getByTestId('sheet-edit-input');
    expect(editInput.props.defaultValue).toBe('mine');
    await fireEvent.changeText(editInput, 'mine, edited');
    await fireEvent.press(screen.getByTestId('sheet-edit-save'));

    expect(onEditSubmit).toHaveBeenCalledWith(replyId(2), 'mine, edited');
  });

  it('hides the author-only actions on a peer reply', async () => {
    const store = makeStore();
    const loadPage = jest.fn(async (_params: PageParams) => [makeReply(1)]);

    await renderBody({ store, loadPage, onEditSubmit: jest.fn() });
    await waitFor(() => expect(screen.getByTestId(`message-row-${replyId(1)}`)).toBeTruthy());

    jest.useFakeTimers();
    await holdRow(replyId(1));

    const sheet = screen.getByTestId('message-actions-sheet');
    expect(within(sheet).queryByTestId('sheet-action-edit')).toBeNull();
    expect(within(sheet).queryByTestId('sheet-action-delete')).toBeNull();
    expect(within(sheet).getByTestId('sheet-action-copy')).toBeTruthy();
  });

  /**
   * #118 Copy link on a REPLY: the token is keyed `(parent channel, message)`,
   * so the mint must carry the reply's parent channel — the channel the thread
   * lives in, which the store stamps on every reply row — and never the THREAD
   * id. That is what makes the landing resolve the reply inside its thread.
   */
  it('copying a reply mints with the PARENT channel id, not the thread id', async () => {
    const store = makeStore();
    const loadPage = jest.fn(async (_params: PageParams) => [makeReply(1)]);
    const mintPermalink = jest.fn(async () => ({ token: TOKEN }));
    const { Clipboard } = jest.requireActual('react-native') as {
      Clipboard: { setString: jest.Mock };
    };
    Clipboard.setString.mockClear();

    await renderBody({ store, loadPage, mintPermalink });
    await waitFor(() => expect(screen.getByTestId(`message-row-${replyId(1)}`)).toBeTruthy());

    jest.useFakeTimers();
    await holdRow(replyId(1));
    await fireEvent.press(screen.getByTestId('sheet-action-copy-link'));

    // ONE round trip, and its ids are the parent channel + the reply.
    expect(mintPermalink).toHaveBeenCalledTimes(1);
    expect(mintPermalink).toHaveBeenCalledWith(IDS.channel, replyId(1));
    expect(mintPermalink).not.toHaveBeenCalledWith(IDS.thread, replyId(1));

    // The clipboard got a token address — no hash, no ids, no thread segment.
    const copied = `http://127.0.0.1:4001/m/${TOKEN}`;
    expect(Clipboard.setString).toHaveBeenCalledWith(copied);
    expect(copied).not.toContain('#');
    expect(copied).not.toContain(IDS.channel);
    expect(copied).not.toContain(IDS.thread);
    expect(copied).not.toContain(replyId(1));
    expect(screen.getByTestId('sheet-copy-status')).toHaveTextContent('Link copied to clipboard');
  });

  it('a failed mint is reported and writes nothing to the clipboard', async () => {
    const store = makeStore();
    const loadPage = jest.fn(async (_params: PageParams) => [makeReply(1)]);
    const mintPermalink = jest.fn(async () => {
      throw new Error('offline');
    });
    const { Clipboard } = jest.requireActual('react-native') as {
      Clipboard: { setString: jest.Mock };
    };
    Clipboard.setString.mockClear();

    await renderBody({ store, loadPage, mintPermalink });
    await waitFor(() => expect(screen.getByTestId(`message-row-${replyId(1)}`)).toBeTruthy());

    jest.useFakeTimers();
    await holdRow(replyId(1));
    await fireEvent.press(screen.getByTestId('sheet-action-copy-link'));

    expect(screen.getByTestId('sheet-copy-status')).toHaveTextContent(/could not copy/i);
    expect(Clipboard.setString).not.toHaveBeenCalled();
  });
});

describe('window seeding', () => {
  it('renders replies already in the store without refetching them', async () => {
    const store = makeStore();
    // Complete window: FlashList's start-reached signal (which fires on mount
    // when the content fits the viewport) has nothing older to ask for.
    store.setState({
      messagesByThread: {
        [IDS.thread]: {
          items: [makeReply(2), makeReply(1)],
          oldestId: replyId(1),
          hasCompleteHistory: true,
        },
      },
    });
    const loadPage = jest.fn(async (_params: PageParams) => []);

    await renderBody({ store, loadPage, enabled: false });

    // FlashList mounts progressively: the first pass lands the scroll anchor
    // (the newest row), the divider-bearing row follows on the next one.
    await waitFor(() => expect(screen.getByTestId(`message-row-${replyId(1)}`)).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId(`message-row-${replyId(2)}`)).toBeTruthy());
    expect(loadPage).not.toHaveBeenCalled();
    // `enabled: false` gates the history fetch only — the composer still
    // renders (sending is the surface's job to gate, the M7 contract).
    expect(screen.getByTestId('composer-input')).toBeTruthy();
  });
});
