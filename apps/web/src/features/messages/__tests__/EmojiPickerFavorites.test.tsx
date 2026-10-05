/**
 * EmojiPickerPanel — the #43 favorites row: renders above Frequently Used
 * from the settings-curated storage, picks bump frecents like any cell,
 * and unknown-in-catalog entries never render.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EmojiPickerPanel } from '../EmojiPickerPanel.js';

afterEach(() => cleanup());

function setStorage(favorites: string[] | null, frecents: string[] | null): void {
  favorites === null
    ? localStorage.removeItem('cytale.emoji-favorites')
    : localStorage.setItem('cytale.emoji-favorites', JSON.stringify(favorites));
  frecents === null
    ? localStorage.removeItem('cytale.emoji-frecents')
    : localStorage.setItem('cytale.emoji-frecents', JSON.stringify(frecents));
}

function favoriteCell(emoji: string) {
  return screen
    .getAllByTestId('emoji-cell')
    .find((el) => el.getAttribute('data-emoji') === emoji && el.hasAttribute('data-favorite'));
}

describe('EmojiPickerPanel — favorites row (#43)', () => {
  it('no favorites → no Favorites section (existing behavior preserved)', () => {
    setStorage(null, null);
    render(<EmojiPickerPanel onPick={() => undefined} onClose={() => undefined} />);
    expect(document.body.textContent).not.toContain('Favorites');
  });

  it('favorites render above Frequently Used and pick normally', async () => {
    setStorage(['🚀', '🔥'], ['👍']);
    const onPick = vi.fn();
    render(<EmojiPickerPanel onPick={onPick} onClose={() => undefined} />);

    const fav = favoriteCell('🚀');
    expect(fav).toBeTruthy();
    expect(screen.getByText('Favorites')).toBeTruthy();
    expect(screen.getByText('Frequently Used')).toBeTruthy();

    // Favorites row comes before frecents in the grid.
    const grid = screen.getByTestId('emoji-grid');
    expect(grid.textContent!.indexOf('🚀')).toBeLessThan(grid.textContent!.indexOf('👍'));

    await userEvent.setup().click(fav!);
    expect(onPick).toHaveBeenCalledWith('🚀');
  });

  it('favorites outside the catalog never render', () => {
    setStorage(['🚀', '🫠'], null); // 🫠 not in the builtin catalog
    render(<EmojiPickerPanel onPick={() => undefined} onClose={() => undefined} />);
    expect(favoriteCell('🚀')).toBeTruthy();
    expect(favoriteCell('🫠')).toBeUndefined();
  });

  it('search hides the favorites row (results-only view)', async () => {
    setStorage(['🚀'], null);
    render(<EmojiPickerPanel onPick={() => undefined} onClose={() => undefined} />);
    await userEvent.setup().type(screen.getByTestId('emoji-search'), 'rocket');
    expect(favoriteCell('🚀')).toBeUndefined();
    expect(screen.queryByText('Favorites')).toBeNull();
  });
});
