/**
 * MessageList touch-action tests (plan 004 M8, R11).
 *
 * The REAL FlashList runs here (as in `MessageList.test.tsx`): these tests
 * prove the list-level half of the long-press contract — rows only report the
 * gesture, the sheet is hosted ABOVE the windowing boundary, and every action
 * leaves through an injected seam (the surface that owns the api client wires
 * REST + the optimistic store patch).
 *
 * Long-press timing runs on fake timers; the initial window load happens
 * before they are installed so `waitFor` never advances the hold timer.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';

import type { MessageWithReactions } from '@cytale/api-client';
import type { Message } from '@cytale/domain';

import { MessageList } from '../MessageList';
import { beginOptimisticReaction } from '../reactions';
import { LONG_PRESS_MS } from '../useLongPress';
import type { LoadMessagePage } from '../useChannelWindow';
import { IDS, makeMessage, makeStore, messageId, seedWindow } from './support';

type PageParams = { before?: string; limit: number };

/** A token spelled like a minted one (30 base62 characters, #118). */
const TOKEN = '3kQm9Xb2Qp7ZtR4vN8wY1cKdQ3uP';

function page(...ns: number[]): Message[] {
  return ns.map((n) => makeMessage(n));
}

async function renderList(
  props: Partial<React.ComponentProps<typeof MessageList>> = {},
  messages: Message[] = page(2, 1),
) {
  const store = makeStore();
  const loadPage = jest.fn(async (_params: PageParams) => messages);
  const result = await render(
    <MessageList channelId={IDS.channel} store={store} loadPage={loadPage} {...props} />,
  );
  await waitFor(() => expect(screen.getByTestId(`message-row-${messageId(1)}`)).toBeTruthy());
  return { store, loadPage, ...result };
}

/** Hold a row long enough to fire the long-press. */
async function holdRow(id: string): Promise<void> {
  await fireEvent(screen.getByTestId(`message-row-${id}`), 'responderGrant', {
    nativeEvent: { pageX: 10, pageY: 100 },
  });
  await act(async () => {
    jest.advanceTimersByTime(LONG_PRESS_MS);
  });
}

describe('long-press opens the sheet', () => {
  afterEach(() => jest.useRealTimers());

  it('opens for the held row and hosts it above the FlashList', async () => {
    await renderList({ onReply: jest.fn() });
    expect(screen.queryByTestId('message-actions-sheet')).toBeNull();

    jest.useFakeTimers();
    await holdRow(messageId(2));

    const sheet = screen.getByTestId('message-actions-sheet');
    expect(within(sheet).getByTestId('sheet-actions')).toBeTruthy();
    // Hosted by the list, not by a cell: a rewindow can never unmount it.
    expect(within(screen.getByTestId('message-list')).queryByTestId('message-actions-sheet')).toBeNull();
  });

  it('closes again when the scrim is tapped', async () => {
    await renderList({ onReply: jest.fn() });
    jest.useFakeTimers();
    await holdRow(messageId(2));

    await fireEvent.press(
      screen.getByTestId('message-actions-scrim', { includeHiddenElements: true }),
    );
    expect(screen.queryByTestId('message-actions-sheet')).toBeNull();
  });
});

describe('sheet gating through the list', () => {
  afterEach(() => jest.useRealTimers());

  it('hides edit/delete on a peer message', async () => {
    await renderList({ onReply: jest.fn(), onEditSubmit: jest.fn(), onDeleteConfirmed: jest.fn() });
    jest.useFakeTimers();
    await holdRow(messageId(1));

    expect(screen.queryByTestId('sheet-action-edit')).toBeNull();
    expect(screen.queryByTestId('sheet-action-delete')).toBeNull();
    expect(screen.getByTestId('sheet-action-reply')).toBeTruthy();
  });

  it('shows edit/delete on the viewer’s own message', async () => {
    await renderList(
      {
        currentUserId: IDS.me,
        onReply: jest.fn(),
        onEditSubmit: jest.fn(),
        onDeleteConfirmed: jest.fn(),
      },
      [makeMessage(1, { author_id: IDS.me })],
    );
    jest.useFakeTimers();
    await holdRow(messageId(1));

    expect(screen.getByTestId('sheet-action-edit')).toBeTruthy();
    expect(screen.getByTestId('sheet-action-delete')).toBeTruthy();
  });
});

describe('reply seam', () => {
  afterEach(() => jest.useRealTimers());

  it('hands the host the ReplyTarget for the held message', async () => {
    const onReply = jest.fn();
    await renderList({ onReply });
    jest.useFakeTimers();
    await holdRow(messageId(2));

    await fireEvent.press(screen.getByTestId('sheet-action-reply'));

    expect(onReply).toHaveBeenCalledWith({
      messageId: messageId(2),
      authorId: IDS.alice,
      preview: 'message 2',
      ping: true,
    });
    expect(screen.queryByTestId('message-actions-sheet')).toBeNull();
  });
});

describe('reactions through the list', () => {
  afterEach(() => jest.useRealTimers());

  it('toggles an existing chip through the same seam the sheet uses', async () => {
    const onToggleReaction = jest.fn();
    const store = makeStore();
    const loadPage = jest.fn(async (_params: PageParams) => page(2, 1));
    // Seed the window (not just the row) so the initial page merge keeps the
    // reaction-carrying row: upsert drops the duplicate id.
    seedWindow(store, IDS.channel, [
      { ...makeMessage(1), reactions: [{ emoji: '👍', count: 1, me: false }] } as MessageWithReactions,
    ]);
    await render(
      <MessageList
        channelId={IDS.channel}
        store={store}
        loadPage={loadPage}
        onToggleReaction={onToggleReaction}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('reaction-chip-👍')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('reaction-chip-👍'));
    expect(onToggleReaction).toHaveBeenCalledWith(messageId(1), '👍');
  });

  it('picks a new emoji from the sheet and re-renders the live chip state', async () => {
    const onToggleReaction = jest.fn();
    const { store } = await renderList({ onToggleReaction });
    jest.useFakeTimers();
    await holdRow(messageId(2));

    await fireEvent.press(screen.getByTestId('sheet-action-react'));
    await fireEvent.press(screen.getByTestId('reaction-favorite-🎉'));
    expect(onToggleReaction).toHaveBeenCalledWith(messageId(2), '🎉');

    // The host's optimistic patch (the seam the surface wires) lands on the
    // same window the sheet resolves its message from: re-open and the chip
    // is already applied, so the picker disables it.
    await act(async () => {
      beginOptimisticReaction(store, {
        channel_id: IDS.channel,
        message_id: messageId(2),
        user_id: IDS.me,
        emoji: '🎉',
      });
    });
    await act(async () => {
      jest.advanceTimersByTime(LONG_PRESS_MS);
    });
    await holdRow(messageId(2));

    expect(screen.getByTestId('reaction-chip-🎉')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('sheet-action-react'));
    expect(screen.getByTestId('reaction-favorite-🎉')).toBeDisabled();
  });
});

/**
 * #118 — Copy link through the CHANNEL list.
 *
 * The list owns the builder (the sheet stays presentational), so this is where
 * the wiring is asserted: the sheet's row mints through the injected seam with
 * `(channel, message)`, and the clipboard receives the minted
 * `<origin>/m/<token>` — never the legacy fragment spelling.
 */
describe('copy link through the list (#118)', () => {
  afterEach(() => jest.useRealTimers());

  it('mints the held message and copies the token URL', async () => {
    const { Clipboard } = jest.requireActual('react-native') as {
      Clipboard: { setString: jest.Mock };
    };
    Clipboard.setString.mockClear();
    const mintPermalink = jest.fn(async () => ({ token: TOKEN }));
    await renderList({ onReply: jest.fn(), mintPermalink });
    jest.useFakeTimers();
    await holdRow(messageId(2));

    await fireEvent.press(screen.getByTestId('sheet-action-copy-link'));

    // ONE round trip, carrying the two ids (the POST body's fields).
    expect(mintPermalink).toHaveBeenCalledTimes(1);
    expect(mintPermalink).toHaveBeenCalledWith(IDS.channel, messageId(2));
    // The clipboard got the token address: no hash, no ids.
    const copied = `http://127.0.0.1:4001/m/${TOKEN}`;
    expect(Clipboard.setString).toHaveBeenCalledWith(copied);
    expect(copied).not.toContain('#');
    expect(copied).not.toContain(IDS.channel);
    expect(copied).not.toContain(messageId(2));
    expect(screen.getByTestId('sheet-copy-status')).toHaveTextContent('Link copied to clipboard');
  });
});
