/**
 * ReactionPicker tests (plan 004 M8, R11 + R18).
 *
 * The picker is the sheet's react view: the same eight-emoji palette web
 * starts from, one named 44pt cell each, already-applied emojis disabled
 * (removal rides the chips). The palette is injectable so M7's shared emoji
 * package can supply per-account favorites without touching this component.
 */
import { fireEvent, render, screen } from '@testing-library/react-native';

import {
  REACTION_PALETTE,
  ReactionPicker,
  reactionAriaLabel,
  reactionChipLabel,
} from '../ReactionPicker';

describe('ReactionPicker', () => {
  it('renders the quick palette with a spoken name per cell', async () => {
    await render(<ReactionPicker onPick={jest.fn()} />);

    for (const emoji of REACTION_PALETTE) {
      expect(screen.getByTestId(`reaction-favorite-${emoji}`)).toBeTruthy();
    }
    expect(screen.getByLabelText('React with thumbs up')).toBeTruthy();
    expect(screen.getByLabelText('React with party popper')).toBeTruthy();
  });

  it('reports the picked emoji', async () => {
    const onPick = jest.fn();
    await render(<ReactionPicker onPick={onPick} />);

    await fireEvent.press(screen.getByTestId('reaction-favorite-👍'));
    expect(onPick).toHaveBeenCalledWith('👍');
  });

  it('disables emojis already on the message (removal rides the chips)', async () => {
    const onPick = jest.fn();
    await render(<ReactionPicker onPick={onPick} appliedEmojis={['👍']} />);

    const applied = screen.getByTestId('reaction-favorite-👍');
    expect(applied).toBeDisabled();
    expect(screen.getByLabelText('React with thumbs up — already applied')).toBeTruthy();

    await fireEvent.press(applied);
    expect(onPick).not.toHaveBeenCalled();

    // A sibling emoji is still live.
    await fireEvent.press(screen.getByTestId('reaction-favorite-🎉'));
    expect(onPick).toHaveBeenCalledWith('🎉');
  });

  it('disables every cell when the host gates reactions (offline)', async () => {
    const onPick = jest.fn();
    await render(<ReactionPicker onPick={onPick} disabled />);

    await fireEvent.press(screen.getByTestId('reaction-favorite-👀'));
    expect(onPick).not.toHaveBeenCalled();
  });

  it('honours a palette override (shared favorites seam)', async () => {
    const onPick = jest.fn();
    await render(<ReactionPicker onPick={onPick} palette={['🚀', '🧪']} />);

    expect(screen.getByTestId('reaction-favorite-🚀')).toBeTruthy();
    expect(screen.queryByTestId('reaction-favorite-👍')).toBeNull();
    await fireEvent.press(screen.getByTestId('reaction-favorite-🧪'));
    expect(onPick).toHaveBeenCalledWith('🧪');
  });

  it('renders the drill-in cell only when the host provides it', async () => {
    const onMore = jest.fn();
    const { rerender } = await render(<ReactionPicker onPick={jest.fn()} onMore={onMore} />);

    await fireEvent.press(screen.getByTestId('reaction-more'));
    expect(onMore).toHaveBeenCalledTimes(1);

    await rerender(<ReactionPicker onPick={jest.fn()} />);
    expect(screen.queryByTestId('reaction-more')).toBeNull();
  });
});

describe('labels', () => {
  it('names palette emojis for screen readers', () => {
    expect(reactionAriaLabel('👍')).toBe('React with thumbs up');
    expect(reactionAriaLabel('🛸')).toBe('React with 🛸');
  });

  it('names chips with their count and the viewer’s own reaction', () => {
    expect(reactionChipLabel('👍', 1, false)).toBe('👍 1 reaction');
    expect(reactionChipLabel('👍', 3, true)).toBe('👍 3 reactions, including you');
  });
});
