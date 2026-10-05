/**
 * MessageRow tests (plan 004 M6, R8 + R18).
 *
 * The row is where the shared parse tree becomes React Native text runs:
 * bold/italic/code/link/mention styling, the link's press target, and the
 * two list decorations (date rule, unread rule) plus the grouping cadence.
 * The parse itself is pinned by `@cytale/markdown`'s suite and the parity
 * test; here the mapping to `<Text>` runs is what is asserted.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { Linking } from 'react-native';

import type { MessageWithReactions } from '@cytale/api-client';

import { MessageRow } from '../MessageRow';
import { LONG_PRESS_MS, LONG_PRESS_SLOP } from '../useLongPress';
import { IDS, makeMessage, messageId } from './support';

/** Flatten a (possibly array) RN style prop into a plain object. */
function styleOf(element: { props: { style?: unknown } }): Record<string, unknown> {
  return Object.assign(
    {},
    ...([] as unknown[])
      .concat(element.props.style ?? [])
      .filter(
        (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
      ),
  );
}

describe('MessageRow', () => {
  it('renders the author, the time, and the body', async () => {
    await render(<MessageRow message={makeMessage(1)} authorName="alice" />);

    expect(screen.getByTestId('message-author')).toHaveTextContent('alice');
    expect(screen.getByTestId('message-content')).toHaveTextContent('message 1');
    // Locale/TZ-dependent: assert the shape, not an exact string.
    expect(screen.getByTestId('message-time').props.children).toMatch(/\d{1,2}:\d{2}/);
  });

  it('maps the shared parse tree to styled runs', async () => {
    const message = makeMessage(1, {
      content: '**bold** *italic* `code` [link](https://example.com) <@700000000000000001>',
    });
    await render(
      <MessageRow
        message={message}
        authorName="alice"
        resolveMention={(id) => (id === '700000000000000001' ? 'bob' : undefined)}
      />,
    );

    const content = screen.getByTestId('message-content');
    expect(within(content).getByText('bold')).toBeTruthy();
    expect(within(content).getByText('italic')).toBeTruthy();
    expect(within(content).getByText('code')).toBeTruthy();
    expect(within(content).getByText('link')).toBeTruthy();
    expect(within(content).getByTestId('mention-700000000000000001')).toHaveTextContent('@bob');
  });

  it('opens link runs through the host handler (and never leaves the row bare)', async () => {
    const onOpenLink = jest.fn();
    await render(
      <MessageRow
        message={makeMessage(1, { content: 'see [docs](https://example.com/docs)' })}
        authorName="alice"
        onOpenLink={onOpenLink}
      />,
    );

    fireEvent.press(screen.getByText('docs'));
    expect(onOpenLink).toHaveBeenCalledWith('https://example.com/docs');
  });

  describe('link scheme allowlist (security)', () => {
    /** The shapes the finding names, plus the classic script scheme. */
    const REJECTED = [
      'intent://scan/#Intent;scheme=zxing;end',
      'tel:+15551234567',
      'sms:+15551234567',
      'javascript:alert(1)',
    ];

    afterEach(() => jest.restoreAllMocks());

    it.each(REJECTED)('refuses %s at BOTH seams (host handler and the OS opener)', async (href) => {
      const onOpenLink = jest.fn();
      const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);

      await render(
        <MessageRow
          message={makeMessage(1, { content: `[tap me](${href})` })}
          authorName="alice"
          onOpenLink={onOpenLink}
        />,
      );

      // The label survives, the control does not: no link role to announce
      // and a press that reaches neither seam.
      const run = screen.getByText('tap me');
      expect(run.props.accessibilityRole).toBeUndefined();
      fireEvent.press(run);

      expect(onOpenLink).not.toHaveBeenCalled();
      expect(openURL).not.toHaveBeenCalled();
    });

    it('opens an allowlisted target through the OS opener when no host seam is wired', async () => {
      const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);

      await render(
        <MessageRow
          message={makeMessage(1, { content: 'see [docs](https://example.com/docs)' })}
          authorName="alice"
        />,
      );

      fireEvent.press(screen.getByText('docs'));
      expect(openURL).toHaveBeenCalledWith('https://example.com/docs');
    });
  });

  it('falls back to the raw snowflake when the mention is unresolved', async () => {
    await render(
      <MessageRow message={makeMessage(1, { content: 'ping <@700000000000000001>' })} />,
    );

    expect(screen.getByTestId('mention-700000000000000001')).toHaveTextContent(
      '@700000000000000001',
    );
  });
  it('renders continuation rows without the author line', async () => {
    await render(<MessageRow message={makeMessage(2)} authorName="alice" grouped />);

    expect(screen.queryByTestId('message-author')).toBeNull();
    expect(screen.queryByTestId('message-time')).toBeNull();
    expect(screen.getByTestId('message-content')).toHaveTextContent('message 2');
  });

  it('hosts the date and unread decorations, both announced as separators', async () => {
    await render(
      <MessageRow
        message={makeMessage(1)}
        authorName="alice"
        dateLabel="September 8, 2026"
        unreadDivider
      />,
    );

    const date = screen.getByTestId('date-divider');
    expect(date).toHaveTextContent('September 8, 2026');
    expect(date.props.role).toBe('separator');
    expect(date.props.accessibilityLabel).toBe('September 8, 2026');

    const unread = screen.getByTestId('unread-divider');
    expect(unread.props.role).toBe('separator');
    expect(unread.props.accessibilityLabel).toBe('New messages');
    expect(within(unread).getByText('NEW')).toBeTruthy();
  });

  it('renders neither decoration by default', async () => {
    await render(<MessageRow message={makeMessage(1)} authorName="alice" />);

    expect(screen.queryByTestId('date-divider')).toBeNull();
    expect(screen.queryByTestId('unread-divider')).toBeNull();
  });

  it('renders an empty timestamp for an unparseable date instead of crashing', async () => {
    await render(
      <MessageRow message={makeMessage(1, { created_at: 'not-a-date' })} authorName="alice" />,
    );

    expect(screen.getByTestId('message-time').props.children).toBe('');
  });

  it('falls back to the author id when no name is known', async () => {
    await render(<MessageRow message={makeMessage(1, { author_id: IDS.bob })} />);

    expect(screen.getByTestId('message-author')).toHaveTextContent(IDS.bob);
  });
});

describe('long-press (M8)', () => {
  afterEach(() => jest.useRealTimers());

  const row = () => screen.getByTestId(`message-row-${messageId(1)}`);
  const grant = (pageY = 100) =>
    fireEvent(row(), 'responderGrant', { nativeEvent: { pageX: 10, pageY } });

  it('reports a hold once the delay elapses', async () => {
    jest.useFakeTimers();
    const onLongPress = jest.fn();
    await render(
      <MessageRow message={makeMessage(1)} authorName="alice" onLongPress={onLongPress} />,
    );

    await grant();
    expect(onLongPress).not.toHaveBeenCalled();
    await act(async () => {
      jest.advanceTimersByTime(LONG_PRESS_MS);
    });
    // The hold reports the row's message id (the list's stable seam).
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onLongPress).toHaveBeenCalledWith(messageId(1));
  });

  it('never reports a tap shorter than the delay', async () => {
    jest.useFakeTimers();
    const onLongPress = jest.fn();
    await render(
      <MessageRow message={makeMessage(1)} authorName="alice" onLongPress={onLongPress} />,
    );

    await grant();
    await fireEvent(row(), 'responderRelease', { nativeEvent: { pageX: 10, pageY: 100 } });
    await act(async () => {
      jest.advanceTimersByTime(LONG_PRESS_MS * 2);
    });
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('cancels the hold when the finger drags past the slop (scroll)', async () => {
    jest.useFakeTimers();
    const onLongPress = jest.fn();
    await render(
      <MessageRow message={makeMessage(1)} authorName="alice" onLongPress={onLongPress} />,
    );

    await grant(100);
    await fireEvent(row(), 'responderMove', { nativeEvent: { pageX: 10, pageY: 100 + LONG_PRESS_SLOP + 1 } });
    await act(async () => {
      jest.advanceTimersByTime(LONG_PRESS_MS);
    });
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('cancels the hold when the list claims the responder to scroll', async () => {
    jest.useFakeTimers();
    const onLongPress = jest.fn();
    await render(
      <MessageRow message={makeMessage(1)} authorName="alice" onLongPress={onLongPress} />,
    );

    await grant();
    // The list asks (and is allowed) to take over; the row is terminated.
    expect(row().props.onResponderTerminationRequest()).toBe(true);
    await fireEvent(row(), 'responderTerminate', { nativeEvent: { pageX: 10, pageY: 100 } });
    await act(async () => {
      jest.advanceTimersByTime(LONG_PRESS_MS);
    });
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('does not claim touches when no sheet is wired', async () => {
    await render(<MessageRow message={makeMessage(1)} authorName="alice" />);

    expect(row().props.onStartShouldSetResponder()).toBe(false);
  });
});

describe('reaction chips (M8)', () => {
  it('renders chips with counts and the viewer’s own state', async () => {
    await render(
      <MessageRow
        message={
          {
            ...makeMessage(1),
            reactions: [
              { emoji: '👍', count: 2, me: true },
              { emoji: '🎉', count: 1, me: false },
            ],
          } as MessageWithReactions
        }
        authorName="alice"
        onToggleReaction={jest.fn()}
      />,
    );

    const row = screen.getByTestId('reaction-row');
    expect(within(row).getByTestId('reaction-chip-👍')).toHaveTextContent('👍2');
    expect(within(row).getByTestId('reaction-chip-🎉')).toHaveTextContent('🎉1');
    expect(screen.getByLabelText('👍 2 reactions, including you')).toBeTruthy();
    expect(screen.getByLabelText('🎉 1 reaction')).toBeTruthy();
  });

  it('toggles the pressed emoji', async () => {
    const onToggleReaction = jest.fn();
    await render(
      <MessageRow
        message={
          { ...makeMessage(1), reactions: [{ emoji: '👍', count: 1, me: false }] } as MessageWithReactions
        }
        authorName="alice"
        onToggleReaction={onToggleReaction}
      />,
    );

    await fireEvent.press(screen.getByTestId('reaction-chip-👍'));
    // The chip's seam carries the row's id (no per-row closure in the list).
    expect(onToggleReaction).toHaveBeenCalledWith(messageId(1), '👍');
  });

  it('renders no chip row without reactions, and none on optimistic placeholders', async () => {
    const { rerender } = await render(<MessageRow message={makeMessage(1)} authorName="alice" />);
    expect(screen.queryByTestId('reaction-row')).toBeNull();

    await rerender(
      <MessageRow
        message={
          {
            ...makeMessage(2),
            id: 'pending_abc',
            reactions: [{ emoji: '👍', count: 1, me: true }],
          } as MessageWithReactions
        }
        authorName="alice"
      />,
    );
    expect(screen.queryByTestId('reaction-row')).toBeNull();
  });

  it('renders chips read-only when the host has no toggle seam', async () => {
    await render(
      <MessageRow
        message={
          { ...makeMessage(1), reactions: [{ emoji: '👍', count: 1, me: false }] } as MessageWithReactions
        }
        authorName="alice"
      />,
    );

    expect(screen.getByTestId('reaction-chip-👍')).toBeDisabled();
  });

  it('meets the 44pt touch floor with the 32pt pill centered inside (R18)', async () => {
    await render(
      <MessageRow
        message={
          { ...makeMessage(1), reactions: [{ emoji: '👍', count: 2, me: false }] } as MessageWithReactions
        }
        authorName="alice"
        onToggleReaction={jest.fn()}
      />,
    );

    // The pressable box IS the target: hitSlop cannot grow past the parent's
    // bounds, and the reaction row is only as tall as this box.
    const target = styleOf(screen.getByTestId('reaction-chip-👍'));
    expect(target.minHeight).toBeGreaterThanOrEqual(44);
    expect(target.justifyContent).toBe('center');

    // The pill itself stays visually 32pt — the target grew, not the density.
    expect(styleOf(screen.getByTestId('reaction-pill-👍')).minHeight).toBe(32);
  });
});
