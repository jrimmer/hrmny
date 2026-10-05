/**
 * Preferences contract tests (plan 004 M7/KTD6).
 *
 * The web client's historical keys and set semantics are pinned here so the
 * move out of `apps/web` cannot change them, and the per-account keying the
 * native client uses is asserted at the same seam.
 */
import { describe, expect, it } from 'vitest';

import {
  createEmojiPreferences,
  createMemoryEmojiStorage,
  emojiPreferenceKeys,
  EMOJI_FAVORITES_MAX,
  EMOJI_FRECENTS_MAX,
} from '../preferences.js';

describe('emojiPreferenceKeys', () => {
  it('defaults to web’s historical keys', () => {
    expect(emojiPreferenceKeys()).toEqual({
      frecents: 'cytale.emoji-frecents',
      favorites: 'cytale.emoji-favorites',
    });
  });

  it('suffixes per account when an account key is given', () => {
    expect(emojiPreferenceKeys({ accountKey: '900000000000000001' })).toEqual({
      frecents: 'cytale.emoji-frecents.900000000000000001',
      favorites: 'cytale.emoji-favorites.900000000000000001',
    });
  });
});

describe('createEmojiPreferences', () => {
  it('starts empty and round-trips favorites, deduped and capped', () => {
    const prefs = createEmojiPreferences(createMemoryEmojiStorage());
    expect(prefs.readFavorites()).toEqual([]);

    prefs.writeFavorites(['🚀', '🚀', '🔥', '🎉']);
    expect(prefs.readFavorites()).toEqual(['🚀', '🔥', '🎉']);

    prefs.writeFavorites(Array.from({ length: 20 }, (_, i) => String(i)));
    expect(prefs.readFavorites()).toHaveLength(EMOJI_FAVORITES_MAX);
  });

  it('bumps frecents most-recent-first, deduped and capped', () => {
    const prefs = createEmojiPreferences(createMemoryEmojiStorage());
    prefs.bumpFrecents('👍');
    prefs.bumpFrecents('🔥');
    prefs.bumpFrecents('👍');
    expect(prefs.readFrecents()).toEqual(['👍', '🔥']);

    for (let i = 0; i < 12; i += 1) prefs.bumpFrecents(`e${i}`);
    expect(prefs.readFrecents()).toHaveLength(EMOJI_FRECENTS_MAX);
    expect(prefs.readFrecents()[0]).toBe('e11');
  });

  it('keys per account so one user’s picks never leak to another', () => {
    const storage = createMemoryEmojiStorage();
    const alice = createEmojiPreferences(storage, { accountKey: 'alice' });
    const bob = createEmojiPreferences(storage, { accountKey: 'bob' });

    alice.writeFavorites(['🚀']);
    bob.bumpFrecents('🔥');

    expect(alice.readFavorites()).toEqual(['🚀']);
    expect(bob.readFavorites()).toEqual([]);
    expect(alice.readFrecents()).toEqual([]);
    expect(bob.readFrecents()).toEqual(['🔥']);
  });

  it('degrades to empty when storage throws (never breaks the composer)', () => {
    const hostile = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    const prefs = createEmojiPreferences(hostile);
    expect(prefs.readFavorites()).toEqual([]);
    expect(() => prefs.bumpFrecents('👍')).not.toThrow();
  });

  it('ignores malformed stored payloads', () => {
    const prefs = createEmojiPreferences(
      createMemoryEmojiStorage({
        'cytale.emoji-favorites': '{not json',
        'cytale.emoji-frecents': '["👍", 42]',
      }),
    );
    expect(prefs.readFavorites()).toEqual([]);
    expect(prefs.readFrecents()).toEqual([]);
  });
});
