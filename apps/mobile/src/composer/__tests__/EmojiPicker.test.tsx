/**
 * EmojiPicker — the native panel over the shared catalog (plan 004 M7/KTD6).
 *
 * The catalog itself is tested in `@cytale/emoji`; here the panel's own
 * contract: search filters, Favorites/Frequently-Used rows come from the
 * per-account preferences, unknown stored emoji never render, and a pick
 * reports the character upward.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { userEvent } from '@testing-library/react-native';

import { EMOJI_CATALOG, canonicalShortcode, shortcodesFor } from '@cytale/emoji';

import { EmojiPicker } from '../EmojiPicker';
import { makePreferences } from './support';

/**
 * `shortcodesFor` is the LINEAR catalog scan. The panel used to call it once
 * per cell (`shortcodesFor(emoji)[0]`), so the grid's own render was quadratic
 * in the catalog; the fix routes every cell through the indexed
 * `canonicalShortcode` instead. Keeping the real implementation behind a spy
 * lets the assertion below pin that (performance pass, P2).
 */
jest.mock('@cytale/emoji', () => {
  const actual = jest.requireActual('@cytale/emoji');
  return { ...actual, shortcodesFor: jest.fn(actual.shortcodesFor) };
});

const shortcodesForSpy = shortcodesFor as unknown as jest.Mock;

describe('EmojiPicker', () => {
  it('renders the whole catalog by default', async () => {
    await render(<EmojiPicker onPick={jest.fn()} onClose={jest.fn()} preferences={makePreferences()} />);

    expect(screen.getByTestId('emoji-grid')).toBeTruthy();
    expect(screen.getAllByTestId('emoji-cell').length).toBeGreaterThan(100);
  });

  it('filters by shortcode and reports the pick', async () => {
    const onPick = jest.fn();
    await render(<EmojiPicker onPick={onPick} onClose={jest.fn()} preferences={makePreferences()} />);

    await fireEvent.changeText(screen.getByTestId('emoji-search'), 'rocket');
    await waitFor(() => expect(screen.getByTestId('emoji-search').props.value).toBe('rocket'));

    const cells = screen.getAllByTestId('emoji-cell');
    expect(cells).toHaveLength(1);
    await userEvent.setup().press(cells[0]!);
    expect(onPick).toHaveBeenCalledWith('🚀');
  });

  it('renders Favorites and Frequently Used from the preferences', async () => {
    const preferences = makePreferences();
    preferences.writeFavorites(['🎉']);
    preferences.bumpFrecents('🔥');
    await render(<EmojiPicker onPick={jest.fn()} onClose={jest.fn()} preferences={preferences} />);

    expect(screen.getByText('Favorites')).toBeTruthy();
    expect(screen.getByText('Frequently Used')).toBeTruthy();
    expect(screen.getByText('All')).toBeTruthy();
  });

  it('never renders a stored emoji outside the catalog', async () => {
    const preferences = makePreferences();
    preferences.writeFavorites(['🫠']); // not in the builtin catalog
    await render(<EmojiPicker onPick={jest.fn()} onClose={jest.fn()} preferences={preferences} />);

    expect(screen.queryByText('Favorites')).toBeNull();
    expect(screen.queryByText('🫠')).toBeNull();
  });

  it('shows the empty state for an unmatched search', async () => {
    await render(<EmojiPicker onPick={jest.fn()} onClose={jest.fn()} preferences={makePreferences()} />);

    await fireEvent.changeText(screen.getByTestId('emoji-search'), 'nope-not-here');
    await waitFor(() => expect(screen.getByTestId('emoji-search').props.value).toBe('nope-not-here'));
    expect(screen.getByTestId('emoji-empty')).toBeTruthy();
  });

  it('closes on request', async () => {
    const onClose = jest.fn();
    await render(<EmojiPicker onPick={jest.fn()} onClose={onClose} preferences={makePreferences()} />);

    await userEvent.setup().press(screen.getByTestId('emoji-picker-close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('resolves every cell hint through the indexed lookup, never a catalog scan', async () => {
    shortcodesForSpy.mockClear();
    await render(<EmojiPicker onPick={jest.fn()} onClose={jest.fn()} preferences={makePreferences()} />);

    // The whole catalog renders, one cell per entry, each carrying its
    // canonical shortcode as the pick target's hint.
    const cells = screen.getAllByTestId('emoji-cell');
    expect(cells).toHaveLength(EMOJI_CATALOG.length);
    expect(cells[0]!.props.accessibilityHint).toBe(canonicalShortcode(EMOJI_CATALOG[0]!.e));

    // A search keystroke re-renders the grid; the O(1) index means the
    // per-cell lookup stays O(1) (this spy would fire ~133× per render).
    await fireEvent.changeText(screen.getByTestId('emoji-search'), 'rocket');
    await waitFor(() => expect(screen.getAllByTestId('emoji-cell')).toHaveLength(1));

    expect(shortcodesForSpy).not.toHaveBeenCalled();
  });
});
