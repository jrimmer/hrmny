/**
 * Composer — the M7 DoD scenarios (plan 004, R9/R10/R15).
 *
 * Every case drives the real component with injected send/upload/picker
 * seams; the store is real (`createStateStore`) so the optimistic send is
 * exercised where production runs it. Keyboard events are dispatched the way
 * RN delivers them: a plain Return fires `keyPress` AND `submitEditing`
 * (submitBehavior="submit"), a shifted Return carries the modifier on the
 * key event — the composer must send exactly once for the former and newline
 * for the latter.
 *
 * RNTL v14 runs React 19's concurrent renderer: a `fireEvent.changeText`
 * whose update is not flushed leaves the next render in the file empty, so
 * every text edit goes through `typeInto`, which awaits the committed value.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { userEvent } from '@testing-library/react-native';

import { createStateStore, type StateStore } from '@cytale/state';

import { resetSurfaceStates } from '../../navigation/shellState';
import type { PickedAttachment } from '../types';
import { UPLOADED, IDS, PICKED, renderComposer } from './support';

beforeEach(() => {
  resetSurfaceStates();
});

/** The composer's host TextInput instance (RNTL's element type). */
function input(): ReturnType<typeof screen.getByTestId> {
  return screen.getByTestId('composer-input');
}

/**
 * Set the composer's text and wait for the controlled value to commit (the
 * concurrent renderer needs the flush; see the file header).
 */
async function typeInto(text: string, expected: string = text): Promise<void> {
  await fireEvent.changeText(input(), text);
  await waitFor(() => expect(input().props.value).toBe(expected));
}

/**
 * Move the caret to the end, the way RN reports it after typing. RNTL v14's
 * `fireEvent` is async (it awaits the act scope), so every dispatch awaits.
 */
async function caretToEnd(value: string): Promise<void> {
  await fireEvent(input(), 'selectionChange', {
    nativeEvent: { selection: { start: value.length, end: value.length } },
  });
}

/** A plain Return as RN reports it on device: keyPress then submitEditing. */
async function pressEnter(): Promise<void> {
  await fireEvent(input(), 'keyPress', { nativeEvent: { key: 'Enter' } });
  await fireEvent(input(), 'submitEditing', { nativeEvent: { text: '' } });
}

/** A shifted Return: the key event carries the modifier. */
async function pressShiftEnter(): Promise<void> {
  await fireEvent(input(), 'keyPress', { nativeEvent: { key: 'Enter', shiftKey: true } });
  await fireEvent(input(), 'submitEditing', { nativeEvent: { text: '' } });
}

/** Wait out the send (the button's busy flag) so no update leaks past the test. */
async function settleSend(): Promise<void> {
  await waitFor(() =>
    expect(screen.getByTestId('composer-send').props.accessibilityState.busy).toBe(false),
  );
}

async function press(testID: string): Promise<void> {
  await userEvent.setup().press(screen.getByTestId(testID));
}

describe('Composer — sending (R9)', () => {
  it('Enter sends the trimmed message exactly once', async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    await renderComposer({ send, upload: jest.fn() });

    await typeInto('  hello there  ');
    await pressEnter();

    await waitFor(() =>
      expect(send).toHaveBeenCalledWith({
        channelId: IDS.channel,
        threadId: null,
        content: 'hello there',
        replyToId: null,
        attachments: [],
      }),
    );
    expect(send).toHaveBeenCalledTimes(1);
    await settleSend();
    // Success clears the input.
    await waitFor(() => expect(input().props.value).toBe(''));
  });

  it('Shift+Enter inserts a newline instead of sending', async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    await renderComposer({ send, upload: jest.fn() });

    await typeInto('first line');
    await caretToEnd('first line'); // RN reports the caret after typing
    await pressShiftEnter();

    expect(send).not.toHaveBeenCalled();
    await waitFor(() => expect(input().props.value).toBe('first line\n'));
  });

  it('the send control sends too', async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    await renderComposer({ send, upload: jest.fn() });

    await typeInto('via button');
    await press('composer-send');

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]![0].content).toBe('via button');
    await settleSend();
  });

  it('does not send an empty composer', async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    await renderComposer({ send, upload: jest.fn() });

    await press('composer-send');
    expect(send).not.toHaveBeenCalled();
  });

  it('a failed send keeps the text for retry (no retyping)', async () => {
    const send = jest.fn().mockRejectedValueOnce(new Error('network down'));
    await renderComposer({ send, upload: jest.fn() });

    await typeInto('keep me');
    await pressEnter();

    await waitFor(() => expect(screen.getByTestId('composer-error')).toBeTruthy());
    expect(screen.getByText('network down')).toBeTruthy();
    expect(input().props.value).toBe('keep me');
    await settleSend();

    // The inline Retry re-sends the same text without any typing.
    send.mockResolvedValueOnce(undefined);
    await press('composer-error-retry');
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1]![0].content).toBe('keep me');
    await settleSend();
  });
});

describe('Composer — `:shortcode:` autocomplete (R9)', () => {
  it('`:sho` suggests, Enter accepts, the token is replaced', async () => {
    await renderComposer({ send: jest.fn(), upload: jest.fn() });

    await typeInto('hello :sho');
    expect(screen.getByTestId('emoji-autocomplete')).toBeTruthy();
    const options = screen.getAllByTestId('emoji-option');
    expect(options.length).toBeGreaterThan(0);
    // Keyword match — `:sho` hits `exploding_head`'s "shock" keyword.
    expect(screen.getByText(':exploding_head:')).toBeTruthy();

    await pressEnter();

    await waitFor(() => expect(input().props.value).toBe('hello 🤯'));
  });

  it('tapping a suggestion replaces the token', async () => {
    await renderComposer({ send: jest.fn(), upload: jest.fn() });

    await typeInto('rock on :rock');
    await userEvent.setup().press(screen.getAllByTestId('emoji-option')[0]!);

    await waitFor(() => expect(input().props.value).toBe('rock on 🚀'));
  });

  it('a closed `:name:` token converts on the closing colon', async () => {
    await renderComposer({ send: jest.fn(), upload: jest.fn() });

    await typeInto('nice :thumbs_up:', 'nice 👍');

    expect(screen.queryByTestId('emoji-autocomplete')).toBeNull();
  });

  it('shows the empty state for an unmatched token', async () => {
    await renderComposer({ send: jest.fn(), upload: jest.fn() });

    await typeInto('hmm :zzzz');
    expect(screen.getByTestId('emoji-autocomplete-empty')).toBeTruthy();
  });

  it('the emoji panel inserts at the caret', async () => {
    await renderComposer({ send: jest.fn(), upload: jest.fn() });

    await typeInto('ship it');
    await caretToEnd('ship it');
    await press('composer-emoji');
    expect(screen.getByTestId('emoji-picker-panel')).toBeTruthy();

    await fireEvent.changeText(screen.getByTestId('emoji-search'), 'rocket');
    await waitFor(() => expect(screen.getByTestId('emoji-search').props.value).toBe('rocket'));
    await press('emoji-cell');

    await waitFor(() => expect(input().props.value).toBe('ship it🚀'));
  });
});

describe('Composer — attachments (R10)', () => {
  it('pick → upload progress → chip → send carries the attachment', async () => {
    let resolveUpload: (value: typeof UPLOADED) => void = () => undefined;
    const upload = jest.fn(
      () =>
        new Promise<typeof UPLOADED>((resolve) => {
          resolveUpload = resolve;
        }),
    );
    const send = jest.fn().mockResolvedValue(undefined);
    await renderComposer({
      send,
      upload,
      pickImageLibrary: async () => [PICKED],
    });

    await press('composer-attach');
    await press('composer-attach-library');

    // Chip appears immediately in the uploading state.
    await waitFor(() => expect(screen.getByTestId('attachment-chip')).toBeTruthy());
    expect(screen.getByTestId('attachment-upload-pending')).toBeTruthy();
    expect(upload).toHaveBeenCalledWith(IDS.channel, PICKED);

    resolveUpload(UPLOADED);
    await waitFor(() => expect(screen.queryByTestId('attachment-upload-pending')).toBeNull());

    await typeInto('look at this');
    await pressEnter();

    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'look at this', attachments: [UPLOADED] }),
      ),
    );
    await settleSend();
  });

  it('sends an image-only message (empty text + a finished chip)', async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    await renderComposer({
      send,
      upload: jest.fn().mockResolvedValue(UPLOADED),
      pickImageLibrary: async () => [PICKED],
    });

    await press('composer-attach');
    await press('composer-attach-library');
    await waitFor(() => expect(screen.queryByTestId('attachment-upload-pending')).toBeNull());

    await press('composer-send');
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ content: '', attachments: [UPLOADED] }),
      ),
    );
    await settleSend();
  });

  it('rejects an oversize file before uploading, with a readable message', async () => {
    const upload = jest.fn();
    const big: PickedAttachment = { ...PICKED, name: 'huge.png', size: 26 * 1024 * 1024 };
    await renderComposer({ send: jest.fn(), upload, pickImageLibrary: async () => [big] });

    await press('composer-attach');
    await press('composer-attach-library');

    await waitFor(() => expect(screen.getByTestId('attachment-upload-error')).toBeTruthy());
    expect(screen.getByText('File is too large — 25.0 MB max.')).toBeTruthy();
    expect(upload).not.toHaveBeenCalled();
    // Nothing to retry — the bytes would be refused again.
    expect(screen.queryByTestId('attachment-chip-retry')).toBeNull();
  });

  it('rejects a blocked mime before uploading, with a readable message', async () => {
    const upload = jest.fn();
    const svg: PickedAttachment = {
      uri: 'file:///tmp/evil.svg',
      name: 'evil.svg',
      type: 'image/svg+xml',
      size: 12,
    };
    await renderComposer({ send: jest.fn(), upload, pickImageLibrary: async () => [svg] });

    await press('composer-attach');
    await press('composer-attach-library');

    await waitFor(() => expect(screen.getByTestId('attachment-upload-error')).toBeTruthy());
    expect(screen.getByText('File type not allowed.')).toBeTruthy();
    expect(upload).not.toHaveBeenCalled();
  });

  it('a failed upload is retryable without retyping the message', async () => {
    const upload = jest
      .fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce(UPLOADED);
    await renderComposer({
      send: jest.fn(),
      upload,
      pickImageLibrary: async () => [PICKED],
    });

    await typeInto('this text must survive');
    await press('composer-attach');
    await press('composer-attach-library');

    await waitFor(() => expect(screen.getByText('disk full')).toBeTruthy());
    expect(input().props.value).toBe('this text must survive');

    await press('attachment-chip-retry');

    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId('attachment-upload-error')).toBeNull());
    expect(input().props.value).toBe('this text must survive');
  });

  it('removes a staged chip', async () => {
    await renderComposer({
      send: jest.fn(),
      upload: jest.fn().mockResolvedValue(UPLOADED),
      pickFiles: async () => [PICKED],
    });

    await press('composer-attach');
    await press('composer-attach-file');
    await waitFor(() => expect(screen.getByTestId('attachment-chip')).toBeTruthy());

    await press('attachment-chip-remove');
    expect(screen.queryByTestId('attachment-chip')).toBeNull();
  });
});

describe('Composer — reply bar (M8 seam)', () => {
  const replyTo = {
    messageId: '500000000000000001',
    authorId: IDS.alice,
    preview: 'the original message',
    ping: true,
  };

  it('renders the reply bar with the resolved author name and preview', async () => {
    await renderComposer({ send: jest.fn(), upload: jest.fn(), replyTo });

    expect(screen.getByTestId('reply-bar')).toBeTruthy();
    expect(screen.getByText('Replying to alice')).toBeTruthy();
    expect(screen.getByTestId('reply-bar-preview').props.children).toBe('the original message');
  });

  it('sends the reply reference and pings the author', async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    const onCancelReply = jest.fn();
    await renderComposer({ send, upload: jest.fn(), replyTo, onCancelReply });

    await typeInto('answering');
    await pressEnter();

    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          content: `<@${IDS.alice}> answering`,
          replyToId: replyTo.messageId,
        }),
      ),
    );
    await settleSend();
    // A successful send retires the reply target.
    expect(onCancelReply).toHaveBeenCalled();
  });

  it('a silent reply (ping false) sends without the mention prefix', async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    await renderComposer({
      send,
      upload: jest.fn(),
      replyTo: { ...replyTo, ping: false },
    });

    await typeInto('quietly');
    await pressEnter();

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]![0].content).toBe('quietly');
    await settleSend();
  });

  it('cancel clears the reply target', async () => {
    const onCancelReply = jest.fn();
    await renderComposer({ send: jest.fn(), upload: jest.fn(), replyTo, onCancelReply });

    await press('reply-bar-cancel');
    expect(onCancelReply).toHaveBeenCalled();
  });
});

describe('Composer — states (R15)', () => {
  it('view-only replaces the composer with the shell note', async () => {
    await renderComposer({ send: jest.fn(), upload: jest.fn(), viewOnly: true });

    expect(screen.getByTestId('view-only-note')).toBeTruthy();
    expect(screen.queryByTestId('composer-input')).toBeNull();
    expect(screen.queryByTestId('composer-send')).toBeNull();
  });

  it('offline disables send and the attachment entry points', async () => {
    await renderComposer({ send: jest.fn(), upload: jest.fn(), offline: true });

    expect(screen.getByTestId('composer-send').props.accessibilityState.disabled).toBe(true);
    expect(screen.getByTestId('composer-attach').props.accessibilityState.disabled).toBe(true);
  });

  it('exposes accessible names on every control (R18)', async () => {
    await renderComposer({ send: jest.fn(), upload: jest.fn() });

    expect(screen.getByLabelText('Message')).toBeTruthy();
    expect(screen.getByLabelText('Send message')).toBeTruthy();
    expect(screen.getByLabelText('Add to message')).toBeTruthy();
    expect(screen.getByLabelText('Emoji')).toBeTruthy();
  });
});

describe('Composer — @-mention typeahead (device feedback 2442)', () => {
  /** A roster wide enough to exercise the prefix/substring ranking bands. */
  function rosterStore(): StateStore {
    const store = createStateStore();
    store.setState({
      currentUser: { id: IDS.me, username: 'rowan' },
      membersById: {
        [IDS.alice]: {
          id: IDS.alice,
          username: 'alice',
          nickname: null,
          joined_at: '2026-09-08T00:00:00.000Z',
          roles: [],
        },
        '900000000000000004': {
          id: '900000000000000004',
          username: 'alicia',
          nickname: null,
          joined_at: '2026-09-08T00:00:00.000Z',
          roles: [],
        },
        '900000000000000005': {
          id: '900000000000000005',
          username: 'bob',
          nickname: null,
          joined_at: '2026-09-08T00:00:00.000Z',
          roles: [],
        },
      },
    });
    return store;
  }

  it('a bare @ opens the palette with the roster (web parity: empty query)', async () => {
    await renderComposer({ send: jest.fn(), upload: jest.fn(), store: rosterStore() });

    await typeInto('hey ');
    await caretToEnd('hey ');
    await typeInto('hey @');
    await caretToEnd('hey @');

    expect(screen.getByTestId('composer-mention-panel')).toBeTruthy();
    // The whole roster, name order.
    expect(
      screen
        .getAllByTestId(/^composer-mention-\d/)
        .map((row) => String(row.props.testID)),
    ).toEqual([
      `composer-mention-${IDS.alice}`, // alice
      'composer-mention-900000000000000004', // alicia
      'composer-mention-900000000000000005', // bob
    ]);
  });

  it('picking splices the WIRE token <@id> and closes the palette', async () => {
    await renderComposer({ send: jest.fn(), upload: jest.fn(), store: rosterStore() });

    await typeInto('hey @al');
    await caretToEnd('hey @al');

    // Username-prefix band first: alice before alicia; bob (no match) absent.
    expect(
      screen
        .getAllByTestId(/^composer-mention-\d/)
        .map((row) => String(row.props.testID)),
    ).toEqual([`composer-mention-${IDS.alice}`, 'composer-mention-900000000000000004']);

    await press(`composer-mention-${IDS.alice}`);
    await waitFor(() => expect(input().props.value).toBe(`hey <@${IDS.alice}> `));
    // The trailing space closed it: no token at the caret, no palette.
    expect(screen.queryByTestId('composer-mention-panel')).toBeNull();
  });

  it('the picked mention pings on the wire', async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    await renderComposer({ send, upload: jest.fn(), store: rosterStore() });

    await typeInto('hey @al');
    await caretToEnd('hey @al');
    await press(`composer-mention-${IDS.alice}`);
    await pressEnter();

    await waitFor(() =>
      // The send path trims — the wire token arrives without its closing
      // space; the space's job (closing the palette) is already done.
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ content: `hey <@${IDS.alice}>` }),
      ),
    );
    await settleSend();
  });

  it('an @ inside a word (email) never opens the palette', async () => {
    await renderComposer({ send: jest.fn(), upload: jest.fn(), store: rosterStore() });

    await typeInto('me@example.com');
    await caretToEnd('me@example.com');

    expect(screen.queryByTestId('composer-mention-panel')).toBeNull();
  });
});
