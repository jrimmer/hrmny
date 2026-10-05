/**
 * @cytale/emoji — public API (plan 004 M7/KTD6).
 *
 * One composer emoji catalog for both clients: the static catalog + search
 * helpers, and a storage-agnostic preferences factory (frecents + curated
 * favorites). `apps/web/src/features/messages/emojiCatalog.ts` re-exports
 * this module bound to localStorage; `apps/mobile/src/composer` binds it per
 * account.
 */

export {
  EMOJI_CATALOG,
  canonicalShortcode,
  emojiByShortcode,
  searchEmojiCatalog,
  shortcodesFor,
  type CatalogEmoji,
  type EmojiSearchRow,
} from './catalog.js';

export {
  createEmojiPreferences,
  createMemoryEmojiStorage,
  emojiPreferenceKeys,
  EMOJI_FAVORITES_MAX,
  EMOJI_FRECENTS_MAX,
  type EmojiPreferences,
  type EmojiPreferencesOptions,
  type EmojiStorage,
} from './preferences.js';
