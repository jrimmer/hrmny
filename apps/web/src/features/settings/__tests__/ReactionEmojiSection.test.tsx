/**
 * ReactionEmojiSection (#43) — favorites management for both pickers:
 * seeded reads, remove/reorder writes, add-from-catalog with the cap, and
 * the two families staying in their own storage keys.
 */
import { axe } from 'vitest-axe';
import type { AxeMatchers } from 'vitest-axe/matchers';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

declare module 'vitest' {
  interface Assertion<T> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}

import { ReactionEmojiSection } from '../ReactionEmojiSection.js';
import { readReactionFavorites } from '../../messages/ReactionPicker.js';
import { readFavoriteEmoji } from '../../messages/emojiCatalog.js';

afterEach(() => cleanup());

function clearStorage(): void {
  localStorage.removeItem('cytale.reaction-favorites');
  localStorage.removeItem('cytale.emoji-favorites');
  localStorage.removeItem('cytale.emoji-frecents');
}

function chips(prefix: string): string[] {
  return screen
    .getAllByTestId(`${prefix}-chip`)
    .map((el) => el.getAttribute('data-emoji') ?? '');
}

describe('ReactionEmojiSection — reaction favorites', () => {
  it('renders the palette seed when no favorites are stored', () => {
    clearStorage();
    render(<ReactionEmojiSection />);
    expect(chips('reaction-favorites').slice(0, 2)).toEqual(['👍', '👎']);
    expect(screen.getByTestId('reaction-favorites-count').textContent).toMatch(/8 \/ 8/);
  });

  it('remove writes through to the picker storage', async () => {
    clearStorage();
    render(<ReactionEmojiSection />);
    const chip = screen.getAllByTestId('reaction-favorites-chip')[0]!;
    await userEvent.setup().click(within(chip).getByTestId('reaction-favorites-remove'));
    expect(chips('reaction-favorites')[0]).not.toBe('👍');
    expect(readReactionFavorites()).not.toContain('👍');
  });

  it('move right reorders and persists; edge controls disable', async () => {
    clearStorage();
    render(<ReactionEmojiSection />);
    const first = screen.getAllByTestId('reaction-favorites-chip')[0]!;
    expect(within(first).getByTestId('reaction-favorites-move-left').hasAttribute('disabled')).toBe(
      true,
    );

    await userEvent.setup().click(within(first).getByTestId('reaction-favorites-move-right'));
    expect(chips('reaction-favorites')[0]).toBe('👎');
    expect(readReactionFavorites()[0]).toBe('👎');
  });
});

describe('ReactionEmojiSection — composer emoji favorites (skeleton)', () => {
  it('starts empty with the honest empty state', () => {
    clearStorage();
    render(<ReactionEmojiSection />);
    expect(screen.getByTestId('emoji-favorites-empty')).toBeTruthy();
    expect(screen.getByTestId('emoji-favorites-count').textContent).toMatch(/0 \/ 8/);
  });

  it('add from search appends and persists to its own key', async () => {
    clearStorage();
    render(<ReactionEmojiSection />);

    await userEvent
      .setup()
      .type(screen.getByTestId('emoji-favorites-search'), 'rocket');
    const add = screen
      .getAllByTestId('emoji-favorites-add')
      .find((b) => b.getAttribute('data-emoji') === '🚀');
    expect(add).toBeTruthy();
    await userEvent.setup().click(add!);

    expect(chips('emoji-favorites')).toContain('🚀');
    expect(readFavoriteEmoji()).toContain('🚀');
    // The reaction set is untouched — separate families, separate keys.
    expect(readReactionFavorites()).not.toContain('🚀');
  });

  it('cap: at 8 favorites the add buttons disable with the full note', async () => {
    clearStorage();
    localStorage.setItem(
      'cytale.emoji-favorites',
      JSON.stringify(['🚀', '🐛', '🧪', '💡', '📌', '🔥', '✅', '⭐']),
    );
    render(<ReactionEmojiSection />);

    expect(screen.getByTestId('emoji-favorites-full')).toBeTruthy();
    const anyAdd = screen.getAllByTestId('emoji-favorites-add')[0]!;
    expect(anyAdd.hasAttribute('disabled')).toBe(true);
  });

  it('current favorites are excluded from add candidates', async () => {
    clearStorage();
    localStorage.setItem('cytale.emoji-favorites', JSON.stringify(['🚀']));
    render(<ReactionEmojiSection />);
    await userEvent.setup().type(screen.getByTestId('emoji-favorites-search'), 'rocket');
    expect(screen.getByTestId('emoji-favorites-no-matches')).toBeTruthy();
  });
});

describe('ReactionEmojiSection — a11y', () => {
  it('has no accessibility violations', async () => {
    clearStorage();
    render(<ReactionEmojiSection />);
    expect(await axe(screen.getByTestId('settings-reaction-emoji'))).toHaveNoViolations();
  });
});
