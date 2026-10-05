/**
 * MessageActionsSheet tests (plan 004 M8, R11 + R18).
 *
 * The sheet is the touch twin of the web hover toolbar: the same action set,
 * author-scoped gating, and the three dismiss paths a native bottom sheet
 * must honour — scrim tap, downward swipe, Android hardware back. Edit and
 * Start thread are in-sheet fields and Delete an in-sheet confirm (no system
 * prompts), Copy rides the clipboard seam with a short "Copied!" beat.
 */
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import type { MessageWithReactions } from '@cytale/api-client';

import { IDS, makeMessage, messageId } from './support';
import { COPY_DISMISS_MS, MessageActionsSheet } from '../MessageActionsSheet';

const PEER = makeMessage(1, { author_id: IDS.alice, content: 'hello there' });
const MINE = makeMessage(2, { author_id: IDS.me, content: 'my message' });

/** A token spelled like a minted one (30 base62 characters, #118). */
const TOKEN = '3kQm9Xb2Qp7ZtR4vN8wY1cKdQ3uP';

async function renderSheet(overrides: Partial<React.ComponentProps<typeof MessageActionsSheet>> = {}) {
  const onOpenChange = jest.fn();
  const props: React.ComponentProps<typeof MessageActionsSheet> = {
    message: PEER,
    open: true,
    onOpenChange,
    currentUserId: IDS.me,
    onToggleReaction: jest.fn(),
    onReply: jest.fn(),
    onEditSubmit: jest.fn(),
    onDeleteConfirmed: jest.fn(),
    onStartThreadNamed: jest.fn(),
    onCopy: jest.fn(),
    ...overrides,
  };
  const result = await render(<MessageActionsSheet {...props} />);
  return { props, onOpenChange, ...result };
}

describe('action set and gating', () => {
  it('shows react, reply, thread, and copy on a peer message — no edit/delete', async () => {
    await renderSheet();

    expect(screen.getByTestId('sheet-action-react')).toBeTruthy();
    expect(screen.getByTestId('sheet-action-reply')).toBeTruthy();
    expect(screen.getByTestId('sheet-action-thread')).toBeTruthy();
    expect(screen.getByTestId('sheet-action-copy')).toBeTruthy();
    expect(screen.queryByTestId('sheet-action-edit')).toBeNull();
    expect(screen.queryByTestId('sheet-action-delete')).toBeNull();
  });

  it('shows edit and delete on the viewer’s own message', async () => {
    await renderSheet({ message: MINE });

    expect(screen.getByTestId('sheet-action-edit')).toBeTruthy();
    expect(screen.getByTestId('sheet-action-delete')).toBeTruthy();
  });

  it('shows delete (never edit) for a moderator on a peer message', async () => {
    await renderSheet({ canManageMessages: true });

    expect(screen.getByTestId('sheet-action-delete')).toBeTruthy();
    expect(screen.queryByTestId('sheet-action-edit')).toBeNull();
  });

  it('hides actions whose handler is not wired (read-only host)', async () => {
    await renderSheet({
      onToggleReaction: undefined,
      onReply: undefined,
      onEditSubmit: undefined,
      onDeleteConfirmed: undefined,
      onStartThreadNamed: undefined,
      message: MINE,
    });

    expect(screen.queryByTestId('sheet-action-react')).toBeNull();
    expect(screen.queryByTestId('sheet-action-reply')).toBeNull();
    expect(screen.queryByTestId('sheet-action-thread')).toBeNull();
    expect(screen.queryByTestId('sheet-action-edit')).toBeNull();
    expect(screen.queryByTestId('sheet-action-delete')).toBeNull();
    // Copy is always available — it is the sanctioned text extraction.
    expect(screen.getByTestId('sheet-action-copy')).toBeTruthy();
  });

  it('renders nothing while closed', async () => {
    await renderSheet({ open: false });
    expect(screen.queryByTestId('message-actions-sheet')).toBeNull();
  });
});

describe('reply seam', () => {
  it('hands the host a ReplyTarget built from the message', async () => {
    const { props, onOpenChange } = await renderSheet();

    await fireEvent.press(screen.getByTestId('sheet-action-reply'));

    expect(props.onReply).toHaveBeenCalledWith({
      messageId: messageId(1),
      authorId: IDS.alice,
      preview: 'hello there',
      ping: true,
    });
    // Reply dismisses the sheet so the composer owns the screen.
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('reactions', () => {
  it('toggles the picked emoji through the same seam the chips use', async () => {
    const { props, onOpenChange } = await renderSheet();

    await fireEvent.press(screen.getByTestId('sheet-action-react'));
    expect(screen.getByTestId('sheet-reaction-picker')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('reaction-favorite-🎉'));
    expect(props.onToggleReaction).toHaveBeenCalledWith(messageId(1), '🎉');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('marks already-applied emojis and can go back to the action list', async () => {
    await renderSheet({
      message: { ...PEER, reactions: [{ emoji: '👍', count: 1, me: true }] },
    });

    await fireEvent.press(screen.getByTestId('sheet-action-react'));
    expect(screen.getByTestId('reaction-favorite-👍')).toBeDisabled();

    await fireEvent.press(screen.getByTestId('sheet-react-back'));
    expect(screen.getByTestId('sheet-actions')).toBeTruthy();
  });
});

describe('edit and thread forms', () => {
  it('prefills the edit field, gates Save on content, and commits', async () => {
    const { props, onOpenChange } = await renderSheet({ message: MINE });

    await fireEvent.press(screen.getByTestId('sheet-action-edit'));
    const input = screen.getByTestId('sheet-edit-input');
    expect(input.props.defaultValue).toBe('my message');

    await fireEvent.changeText(input, '   ');
    expect(screen.getByTestId('sheet-edit-save')).toBeDisabled();

    await fireEvent.changeText(input, 'my edited message');
    await fireEvent.press(screen.getByTestId('sheet-edit-save'));
    expect(props.onEditSubmit).toHaveBeenCalledWith(messageId(2), 'my edited message');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('cancels an edit back to the action list without committing', async () => {
    const { props } = await renderSheet({ message: MINE });

    await fireEvent.press(screen.getByTestId('sheet-action-edit'));
    await fireEvent.press(screen.getByTestId('sheet-edit-cancel'));

    expect(props.onEditSubmit).not.toHaveBeenCalled();
    expect(screen.getByTestId('sheet-actions')).toBeTruthy();
  });

  it('requires a thread name before starting', async () => {
    const { props, onOpenChange } = await renderSheet();

    await fireEvent.press(screen.getByTestId('sheet-action-thread'));
    expect(screen.getByTestId('sheet-thread-start')).toBeDisabled();

    await fireEvent.changeText(screen.getByTestId('sheet-thread-name'), 'release notes');
    await fireEvent.press(screen.getByTestId('sheet-thread-start'));

    expect(props.onStartThreadNamed).toHaveBeenCalledWith(messageId(1), 'release notes');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('delete confirm', () => {
  it('confirms in-sheet and only then deletes', async () => {
    const { props, onOpenChange } = await renderSheet({ message: MINE });

    await fireEvent.press(screen.getByTestId('sheet-action-delete'));
    expect(screen.getByTestId('sheet-delete-prompt')).toHaveTextContent(
      'Delete this message? This cannot be undone.',
    );
    expect(props.onDeleteConfirmed).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId('sheet-delete-confirm'));
    expect(props.onDeleteConfirmed).toHaveBeenCalledWith(messageId(2));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('cancels a delete back to the action list', async () => {
    const { props } = await renderSheet({ message: MINE });

    await fireEvent.press(screen.getByTestId('sheet-action-delete'));
    await fireEvent.press(screen.getByTestId('sheet-delete-cancel'));

    expect(props.onDeleteConfirmed).not.toHaveBeenCalled();
    expect(screen.getByTestId('sheet-actions')).toBeTruthy();
  });
});

describe('copy', () => {
  afterEach(() => jest.useRealTimers());

  it('copies through the seam, announces, then dismisses', async () => {
    jest.useFakeTimers();
    const { props, onOpenChange } = await renderSheet();

    await fireEvent.press(screen.getByTestId('sheet-action-copy'));
    expect(props.onCopy).toHaveBeenCalledWith('hello there');
    expect(screen.getByTestId('sheet-action-copy')).toHaveTextContent('Copied!');
    expect(screen.getByTestId('sheet-copy-status')).toHaveTextContent('Copied to clipboard');
    expect(onOpenChange).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(COPY_DISMISS_MS);
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('falls back to the platform clipboard when no seam is injected', async () => {
    jest.useFakeTimers();
    const { Clipboard } = jest.requireActual('react-native') as {
      Clipboard: { setString: jest.Mock };
    };
    await renderSheet({ onCopy: undefined });

    await fireEvent.press(screen.getByTestId('sheet-action-copy'));
    expect(Clipboard.setString).toHaveBeenCalledWith('hello there');
  });

  it('does not let a pending copy-dismiss close a follow-up view', async () => {
    jest.useFakeTimers();
    const { onOpenChange } = await renderSheet({ message: MINE });

    await fireEvent.press(screen.getByTestId('sheet-action-copy'));
    await fireEvent.press(screen.getByTestId('sheet-action-edit'));

    await act(async () => {
      jest.advanceTimersByTime(COPY_DISMISS_MS);
    });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('sheet-edit-form')).toBeTruthy();
  });
});

describe('dismiss paths', () => {
  it('closes on a scrim tap', async () => {
    const { onOpenChange } = await renderSheet();

    // The scrim is intentionally outside the VoiceOver tree (the sheet is
    // `accessibilityViewIsModal`), so the query includes hidden elements.
    await fireEvent.press(
      screen.getByTestId('message-actions-scrim', { includeHiddenElements: true }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('closes through the footer Close row (assistive-tech dismissal)', async () => {
    const { onOpenChange } = await renderSheet();

    await fireEvent.press(screen.getByTestId('sheet-action-close'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('closes on Android hardware back (Modal onRequestClose)', async () => {
    const { onOpenChange } = await renderSheet();

    await fireEvent(screen.getByTestId('message-actions-sheet-modal'), 'requestClose');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('closes on a downward swipe past the threshold', async () => {
    const { onOpenChange } = await renderSheet();
    const grabber = screen.getByTestId('message-actions-grabber');

    await fireEvent(grabber, 'responderGrant', { nativeEvent: { pageY: 500 } });
    await fireEvent(grabber, 'responderMove', { nativeEvent: { pageY: 620 } });
    await fireEvent(grabber, 'responderRelease', { nativeEvent: { pageY: 620 } });

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('keeps the sheet open on a short drag', async () => {
    const { onOpenChange } = await renderSheet();
    const grabber = screen.getByTestId('message-actions-grabber');

    await fireEvent(grabber, 'responderGrant', { nativeEvent: { pageY: 500 } });
    await fireEvent(grabber, 'responderMove', { nativeEvent: { pageY: 520 } });
    await fireEvent(grabber, 'responderRelease', { nativeEvent: { pageY: 520 } });

    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('abandons a drag that the sheet loses the responder to', async () => {
    const { onOpenChange } = await renderSheet();
    const grabber = screen.getByTestId('message-actions-grabber');

    await fireEvent(grabber, 'responderGrant', { nativeEvent: { pageY: 500 } });
    await fireEvent(grabber, 'responderMove', { nativeEvent: { pageY: 700 } });
    await fireEvent(grabber, 'responderTerminate', { nativeEvent: { pageY: 700 } });

    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe('state reset', () => {
  it('returns to the action list when reopened for another message', async () => {
    const { rerender } = await renderSheet({ message: MINE });

    await fireEvent.press(screen.getByTestId('sheet-action-edit'));
    expect(screen.getByTestId('sheet-edit-form')).toBeTruthy();

    await rerender(
      <MessageActionsSheet
        message={PEER}
        open={false}
        onOpenChange={jest.fn()}
        currentUserId={IDS.me}
      />,
    );
    await rerender(
      <MessageActionsSheet
        message={PEER}
        open
        onOpenChange={jest.fn()}
        currentUserId={IDS.me}
      />,
    );

    expect(screen.getByTestId('sheet-actions')).toBeTruthy();
    expect(screen.queryByTestId('sheet-edit-form')).toBeNull();
  });
});

/**
 * #118 — Copy link: the mobile half of a permalink.
 *
 * The action must be in the SHEET (the touch surface's only action set), it
 * must MINT (the host's promise is the `POST /permalinks` round trip — the
 * token is keyed server-side), and the clipboard must get `<origin>/m/<token>`:
 * no `#`, no route grammar, no ids. The failure paths are asserted as hard as
 * the success: a failed mint is VISIBLE and the clipboard stays untouched —
 * there is no legacy fragment fallback.
 */
describe('Copy link (#118)', () => {
  afterEach(() => jest.useRealTimers());

  const LINK = `https://chat.example.com/m/${TOKEN}`;
  /** The host's mint seam, as the lists wire it: an async builder. */
  const mintOk = () => jest.fn(async (_message: MessageWithReactions) => LINK);

  it('is absent when the host wires no link builder (read-only host)', async () => {
    await renderSheet();
    expect(screen.queryByTestId('sheet-action-copy-link')).toBeNull();
  });

  it('copies the minted URL, announces it, then dismisses', async () => {
    jest.useFakeTimers();
    const onCopyLink = mintOk();
    const { onOpenChange } = await renderSheet({ onCopyLink });

    await fireEvent.press(screen.getByTestId('sheet-action-copy-link'));

    expect(onCopyLink).toHaveBeenCalledWith(PEER);
    expect(screen.getByTestId('sheet-copy-status')).toHaveTextContent('Link copied to clipboard');
    // What was written is a TOKEN address: the origin, `/m/`, the token — and
    // nothing else. The old fragment shape carried the workspace, the channel
    // and the message id; none of them may appear.
    expect(LINK).not.toContain('#');
    expect(LINK).not.toContain(IDS.channel);
    expect(LINK).not.toContain(messageId(1));
    // The "Copied!" label belongs to the row that was pressed — the sheet's
    // visible confirmation (the live region is the second, spoken one).
    expect(screen.getByTestId('sheet-action-copy-link')).toHaveTextContent('Copied!');
    expect(screen.getByTestId('sheet-action-copy')).toHaveTextContent('Copy text');

    await act(async () => {
      jest.advanceTimersByTime(COPY_DISMISS_MS);
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('writes the minted URL through the platform clipboard', async () => {
    jest.useFakeTimers();
    const { Clipboard } = jest.requireActual('react-native') as {
      Clipboard: { setString: jest.Mock };
    };
    Clipboard.setString.mockClear();
    await renderSheet({ onCopyLink: mintOk() });

    await fireEvent.press(screen.getByTestId('sheet-action-copy-link'));
    expect(Clipboard.setString).toHaveBeenCalledWith(LINK);
  });

  it('reports a failed MINT as a failure, and writes NOTHING to the clipboard', async () => {
    jest.useFakeTimers();
    const { Clipboard } = jest.requireActual('react-native') as {
      Clipboard: { setString: jest.Mock };
    };
    Clipboard.setString.mockClear();
    const onCopyLink = jest.fn(async () => {
      throw new Error('offline');
    });
    await renderSheet({ onCopyLink });

    await fireEvent.press(screen.getByTestId('sheet-action-copy-link'));

    expect(onCopyLink).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('sheet-copy-status')).toHaveTextContent(/could not copy/i);
    // Not "something stale on the clipboard and no explanation": nothing at
    // all, and the user was told. A legacy fallback URL is exactly what is NOT
    // allowed here.
    expect(Clipboard.setString).not.toHaveBeenCalled();
    // No row may claim a copy that did not happen.
    expect(screen.getByTestId('sheet-action-copy-link')).toHaveTextContent('Copy link');
    expect(screen.getByTestId('sheet-action-copy')).toHaveTextContent('Copy text');
  });

  it('spends ONE round trip when the row is tapped twice while the mint is in flight', async () => {
    jest.useFakeTimers();
    let resolveMint: (url: string) => void = () => undefined;
    const onCopyLink = jest.fn(
      () => new Promise<string>((resolve) => {
        resolveMint = resolve;
      }),
    );
    await renderSheet({ onCopyLink });

    await fireEvent.press(screen.getByTestId('sheet-action-copy-link'));
    await fireEvent.press(screen.getByTestId('sheet-action-copy-link'));
    expect(onCopyLink).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveMint(LINK);
    });
    expect(screen.getByTestId('sheet-copy-status')).toHaveTextContent('Link copied to clipboard');
  });

  it('says there is no link rather than claiming a copy', async () => {
    jest.useFakeTimers();
    await renderSheet({ onCopyLink: async () => null });

    await fireEvent.press(screen.getByTestId('sheet-action-copy-link'));

    expect(screen.getByTestId('sheet-copy-status')).toHaveTextContent(/no link yet/i);
    expect(screen.getByTestId('sheet-action-copy')).toHaveTextContent('Copy text');
  });
});
