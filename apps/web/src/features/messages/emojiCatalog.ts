/**
 * @cytale/web — composer emoji catalog, re-exported from `@cytale/emoji`
 * (plan 004 KTD6: the catalog is shared with the native client).
 *
 * This module stays the web app's import surface so no call site churns: the
 * catalog + search helpers are a straight re-export, and the frecents /
 * favorites helpers are the shared preferences factory bound to
 * `localStorage` with web's historical key names — behaviour and keys are
 * unchanged from the pre-move module.
 */

import { createEmojiPreferences, type EmojiStorage } from '@cytale/emoji';

export {
  EMOJI_CATALOG,
  canonicalShortcode,
  emojiByShortcode,
  searchEmojiCatalog,
  shortcodesFor,
  EMOJI_FAVORITES_MAX,
  type CatalogEmoji,
  type EmojiSearchRow,
} from '@cytale/emoji';

/** localStorage behind the shared best-effort contract (may be absent). */
const webStorage: EmojiStorage = {
  getItem(key) {
    try {
      return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  },
  setItem(key, value) {
    try {
      globalThis.localStorage?.setItem(key, value);
    } catch {
      // storage unavailable — preferences are best-effort
    }
  },
};

const preferences = createEmojiPreferences(webStorage);

/** Recently-picked emoji (composer picker), most-recent first. Best-effort. */
export function readFrecentEmoji(): string[] {
  return preferences.readFrecents();
}

/** Record a pick (dedupe, most-recent-first, capped). Best-effort. */
export function bumpFrecentEmoji(emojiChar: string): void {
  preferences.bumpFrecents(emojiChar);
}

/** The user's composer-emoji favorites (settings-curated). Empty by default. */
export function readFavoriteEmoji(): string[] {
  return preferences.readFavorites();
}

/** Persist the favorites set (deduped, capped). Best-effort. */
export function writeFavoriteEmoji(favorites: string[]): void {
  preferences.writeFavorites(favorites);
}
