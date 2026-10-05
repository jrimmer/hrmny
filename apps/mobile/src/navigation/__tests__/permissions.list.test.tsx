/**
 * `canManageMessages` forwarding through the message list (ce-code-review gap
 * B, list half): the channel route resolves the viewer's permissions and
 * `MessageList` must hand the flag to the action sheet. The REAL FlashList and
 * the REAL sheet run here; the route's derivation is covered in
 * `permissions.route.test.tsx` and the sheet's own gate in
 * `messages/__tests__/MessageActionsSheet.test.tsx`.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';

import type { Message } from '@cytale/domain';

import { MessageList } from '../../messages/MessageList';
import { LONG_PRESS_MS } from '../../messages/useLongPress';
import type { LoadMessagePage } from '../../messages/useChannelWindow';
import { IDS, makeMessage, makeStore, messageId } from '../../messages/__tests__/support';

type PageParams = { before?: string; limit: number };

async function renderList(
  props: Partial<React.ComponentProps<typeof MessageList>> = {},
  messages: Message[] = [makeMessage(1)],
) {
  const store = makeStore();
  const loadPage = jest.fn(async (_params: PageParams) => messages);
  const result = await render(
    <MessageList channelId={IDS.channel} store={store} loadPage={loadPage} {...props} />,
  );
  await waitFor(() => expect(screen.getByTestId(`message-row-${messageId(1)}`)).toBeTruthy());
  return { store, loadPage, ...result };
}

/** Hold a row long enough to fire the long-press (the list's M8 gesture). */
async function holdRow(id: string): Promise<void> {
  await fireEvent(screen.getByTestId(`message-row-${id}`), 'responderGrant', {
    nativeEvent: { pageX: 10, pageY: 100 },
  });
  await act(async () => {
    jest.advanceTimersByTime(LONG_PRESS_MS);
  });
}

/** The seams the sheet needs to render its rows (delete confirm + reply). */
const SEAMS = {
  onReply: () => undefined,
  onEditSubmit: () => undefined,
  onDeleteConfirmed: () => undefined,
} as const;

describe('canManageMessages reaches the sheet', () => {
  afterEach(() => jest.useRealTimers());

  it('shows delete (never edit) to a moderator on a peer message', async () => {
    await renderList({ ...SEAMS, canManageMessages: true });

    jest.useFakeTimers();
    await holdRow(messageId(1));

    const sheet = screen.getByTestId('message-actions-sheet');
    expect(within(sheet).getByTestId('sheet-action-delete')).toBeTruthy();
    expect(within(sheet).queryByTestId('sheet-action-edit')).toBeNull();
  });

  it('hides delete and edit from a member without the flag', async () => {
    await renderList({ ...SEAMS, canManageMessages: false });

    jest.useFakeTimers();
    await holdRow(messageId(1));

    const sheet = screen.getByTestId('message-actions-sheet');
    expect(within(sheet).queryByTestId('sheet-action-delete')).toBeNull();
    expect(within(sheet).queryByTestId('sheet-action-edit')).toBeNull();
    expect(within(sheet).getByTestId('sheet-action-reply')).toBeTruthy();
  });

  it('shows edit and delete to the author regardless of the flag', async () => {
    await renderList({ ...SEAMS, canManageMessages: false }, [
      makeMessage(1, { author_id: IDS.me }),
    ]);

    jest.useFakeTimers();
    await holdRow(messageId(1));

    const sheet = screen.getByTestId('message-actions-sheet');
    expect(within(sheet).getByTestId('sheet-action-edit')).toBeTruthy();
    expect(within(sheet).getByTestId('sheet-action-delete')).toBeTruthy();
  });
});
