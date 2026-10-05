/**
 * @cytale/emoji — builtin emoji catalog for the composers (picker +
 * `:shortcode:` autocomplete), shared by web and native (plan 004 KTD6).
 *
 * A curated, dependency-free set of common Unicode emoji with Discord-style
 * shortcodes and search keywords. This is the COMPOSER catalog — broader than
 * the fixed 8-emoji reaction palette (reactions UI contract, unchanged).
 * No custom emoji, no remote packs (v1): the catalog is static so the picker
 * renders and searches offline.
 *
 * Moved here from `apps/web/src/features/messages/emojiCatalog.ts` so both
 * clients pick from the same set; the web module is now a thin re-export.
 */

export interface CatalogEmoji {
  /** The emoji character itself (inserted into the message). */
  e: string;
  /** Discord-style shortcode (without colons), e.g. `thumbs_up`. */
  n: string;
  /** Extra search keywords beyond the shortcode. */
  kw?: string[];
}

export const EMOJI_CATALOG: readonly CatalogEmoji[] = [
  // — frequently used / gestures —
  { e: '👍', n: 'thumbs_up', kw: ['yes', 'ok', 'approve', '+1'] },
  { e: '👎', n: 'thumbs_down', kw: ['no', 'disapprove', '-1'] },
  { e: '👋', n: 'wave', kw: ['hello', 'hi', 'bye'] },
  { e: '🖐️', n: 'hand_splayed', kw: ['hand', 'stop', 'five'] },
  { e: '✋', n: 'raised_hand', kw: ['hand', 'stop', 'high five'] },
  { e: '🖖', n: 'vulcan_salute', kw: ['spock', 'hand'] },
  { e: '👌', n: 'ok_hand', kw: ['ok', 'perfect', 'hand'] },
  { e: '🤌', n: 'pinched_fingers', kw: ['hand', 'italian'] },
  { e: '🤞', n: 'crossed_fingers', kw: ['luck', 'hope', 'hand'] },
  { e: '🤙', n: 'call_me_hand', kw: ['shaka', 'hand', 'phone'] },
  { e: '👈', n: 'point_left', kw: ['hand', 'point'] },
  { e: '👉', n: 'point_right', kw: ['hand', 'point', 'this'] },
  { e: '👆', n: 'point_up', kw: ['hand', 'point', 'above'] },
  { e: '👇', n: 'point_down', kw: ['hand', 'point', 'below'] },
  { e: '☝️', n: 'index_pointing_up', kw: ['hand', 'point'] },
  { e: '✊', n: 'fist', kw: ['hand', 'bump'] },
  { e: '👊', n: 'punch', kw: ['hand', 'fist bump'] },
  { e: '🤛', n: 'left_facing_fist', kw: ['hand', 'fist'] },
  { e: '🤜', n: 'right_facing_fist', kw: ['hand', 'fist'] },
  { e: '👏', n: 'clap', kw: ['applause', 'hands', 'bravo'] },
  { e: '🙌', n: 'raised_hands', kw: ['celebrate', 'hands', 'hooray'] },
  { e: '👐', n: 'open_hands', kw: ['hands'] },
  { e: '🤝', n: 'handshake', kw: ['deal', 'agree', 'hands'] },
  { e: '🙏', n: 'pray', kw: ['thanks', 'please', 'hands'] },
  { e: '💪', n: 'muscle', kw: ['strong', 'arm', 'flex'] },
  { e: '🫡', n: 'saluting_face', kw: ['salute', 'respect'] },
  { e: '🫶', n: 'heart_hands', kw: ['love', 'hands'] },

  // — faces —
  { e: '😀', n: 'grinning', kw: ['smile', 'happy'] },
  { e: '😃', n: 'smiley', kw: ['smile', 'happy'] },
  { e: '😄', n: 'smile', kw: ['happy', 'grin'] },
  { e: '😁', n: 'grin', kw: ['beaming', 'happy'] },
  { e: '😆', n: 'laughing', kw: ['lol', 'happy'] },
  { e: '😂', n: 'joy', kw: ['lol', 'tears', 'laugh'] },
  { e: '🤣', n: 'rofl', kw: ['lol', 'laugh', 'floor'] },
  { e: '😅', n: 'sweat_smile', kw: ['laugh', 'relief'] },
  { e: '🙂', n: 'slightly_smiling_face', kw: ['smile'] },
  { e: '😉', n: 'wink', kw: ['winking'] },
  { e: '😍', n: 'heart_eyes', kw: ['love', 'smile'] },
  { e: '😘', n: 'kissing_heart', kw: ['kiss', 'love'] },
  { e: '😋', n: 'yum', kw: ['tasty', 'delicious'] },
  { e: '😎', n: 'sunglasses', kw: ['cool', 'deal with it'] },
  { e: '🤩', n: 'star_struck', kw: ['excited', 'wow'] },
  { e: '🤔', n: 'thinking', kw: ['hmm', 'consider'] },
  { e: '🤨', n: 'raised_eyebrow', kw: ['suspicious'] },
  { e: '😐', n: 'neutral_face', kw: ['meh'] },
  { e: '🙄', n: 'roll_eyes', kw: ['annoyed'] },
  { e: '😴', n: 'sleeping', kw: ['sleep', 'zzz'] },
  { e: '😵', n: 'dizzy_face', kw: ['dead', 'knocked out'] },
  { e: '🤯', n: 'exploding_head', kw: ['mind blown', 'shock'] },
  { e: '🥳', n: 'partying_face', kw: ['party', 'celebrate'] },
  { e: '😱', n: 'scream', kw: ['fear', 'shock'] },
  { e: '🥵', n: 'hot_face', kw: ['heat', 'sweat'] },
  { e: '🥶', n: 'cold_face', kw: ['cold', 'freezing'] },
  { e: '😤', n: 'triumph', kw: ['determined', 'steam'] },
  { e: '😡', n: 'rage', kw: ['angry', 'mad'] },
  { e: '😭', n: 'sob', kw: ['crying', 'tears', 'sad'] },
  { e: '😢', n: 'crying_face', kw: ['tears', 'sad'] },
  { e: '😱', n: 'fearful', kw: ['shock', 'scared'] },
  { e: '😬', n: 'grimacing', kw: ['awkward', 'yikes'] },
  { e: '🤗', n: 'hugging_face', kw: ['hug'] },
  { e: '🤭', n: 'hand_over_mouth', kw: ['giggle', 'oops'] },
  { e: '🤫', n: 'shushing_face', kw: ['quiet', 'shh'] },
  { e: '🤥', n: 'lying_face', kw: ['lie', 'pinocchio'] },
  { e: '🤮', n: 'vomiting', kw: ['sick', 'gross'] },
  { e: '🤧', n: 'sneezing', kw: ['sick', 'achoo'] },
  { e: '🥺', n: 'pleading_face', kw: ['puppy eyes', 'please'] },
  { e: '😮', n: 'open_mouth', kw: ['wow', 'surprise'] },
  { e: '😲', n: 'astonished', kw: ['shock', 'surprise'] },
  { e: '😳', n: 'flushed', kw: ['embarrassed', 'blush'] },
  { e: '🥱', n: 'yawning_face', kw: ['tired', 'bored'] },
  { e: '😈', n: 'smiling_imp', kw: ['devil', 'evil'] },

  // — hearts & symbols —
  { e: '❤️', n: 'heart', kw: ['love', 'red'] },
  { e: '🧡', n: 'orange_heart', kw: ['love'] },
  { e: '💛', n: 'yellow_heart', kw: ['love'] },
  { e: '💚', n: 'green_heart', kw: ['love'] },
  { e: '💙', n: 'blue_heart', kw: ['love'] },
  { e: '💜', n: 'purple_heart', kw: ['love'] },
  { e: '🖤', n: 'black_heart', kw: ['love', 'dark'] },
  { e: '💔', n: 'broken_heart', kw: ['heartbreak', 'sad'] },
  { e: '💯', n: 'hundred', kw: ['100', 'perfect', 'keep it real'] },
  { e: '💥', n: 'boom', kw: ['explosion', 'collision'] },
  { e: '💫', n: 'dizzy', kw: ['stars', 'sparkle'] },
  { e: '✨', n: 'sparkles', kw: ['shiny', 'new'] },
  { e: '🔥', n: 'fire', kw: ['lit', 'hot', 'flame'] },
  { e: '⭐', n: 'star', kw: ['favorite'] },
  { e: '🌟', n: 'glowing_star', kw: ['shining'] },
  { e: '⚡', n: 'zap', kw: ['lightning', 'fast', 'power'] },
  { e: '✅', n: 'white_check_mark', kw: ['done', 'yes', 'complete'] },
  { e: '❌', n: 'cross_mark', kw: ['no', 'wrong', 'x'] },
  { e: '⚠️', n: 'warning', kw: ['caution', 'attention'] },
  { e: '🚫', n: 'prohibited', kw: ['no', 'banned', 'forbidden'] },
  { e: '❓', n: 'question', kw: ['help', 'unknown'] },
  { e: '❗', n: 'exclamation', kw: ['important', 'attention'] },
  { e: '🎉', n: 'tada', kw: ['party', 'celebrate', 'confetti'] },
  { e: '🎊', n: 'confetti_ball', kw: ['party', 'celebrate'] },
  { e: '🏆', n: 'trophy', kw: ['win', 'award'] },
  { e: '🥇', n: 'first_place_medal', kw: ['gold', 'win'] },
  { e: '🎯', n: 'dart', kw: ['target', 'bullseye', 'goal'] },
  { e: '👀', n: 'eyes', kw: ['look', 'watch', 'interested'] },
  { e: '🧠', n: 'brain', kw: ['smart', 'mind'] },
  { e: '🙏', n: 'folded_hands', kw: ['thanks', 'please'] },
  { e: '⏰', n: 'alarm_clock', kw: ['time', 'reminder'] },
  { e: '📌', n: 'pushpin', kw: ['pin', 'note'] },
  { e: '🔗', n: 'link', kw: ['url', 'chain'] },
  { e: '💡', n: 'bulb', kw: ['idea', 'light'] },
  { e: '🔒', n: 'locked', kw: ['lock', 'secure'] },
  { e: '🔓', n: 'unlocked', kw: ['lock', 'open'] },
  { e: '🚀', n: 'rocket', kw: ['ship it', 'launch', 'fast'] },
  { e: '🧪', n: 'test_tube', kw: ['experiment', 'lab'] },
  { e: '🐛', n: 'bug', kw: ['insect', 'defect'] },
  { e: '🛠️', n: 'hammer_and_wrench', kw: ['tools', 'fix'] },
  { e: '⚙️', n: 'gear', kw: ['settings', 'config'] },
  { e: '📦', n: 'package', kw: ['box', 'shipping'] },
  { e: '📁', n: 'file_folder', kw: ['folder', 'files'] },
  { e: '💾', n: 'floppy_disk', kw: ['save'] },
  { e: '💻', n: 'laptop', kw: ['computer', 'work'] },
  { e: '📱', n: 'mobile_phone', kw: ['phone'] },
  { e: '🖥️', n: 'desktop_computer', kw: ['computer', 'monitor'] },
  { e: '☕', n: 'coffee', kw: ['cafe', 'drink'] },
  { e: '🍕', n: 'pizza', kw: ['food'] },
  { e: '🍰', n: 'cake', kw: ['dessert', 'birthday'] },
  { e: '🍺', n: 'beer', kw: ['drink'] },
  { e: '🍻', n: 'clinking_beer_mugs', kw: ['cheers', 'drinks'] },
  { e: '🐍', n: 'snake', kw: ['python'] },
  { e: '🦆', n: 'duck', kw: ['bird'] },
  { e: '🐱', n: 'cat', kw: ['kitten'] },
  { e: '🐶', n: 'dog', kw: ['puppy'] },
  { e: '🦊', n: 'fox', kw: ['animal'] },
  { e: '🐻', n: 'bear', kw: ['animal'] },
  { e: '🦄', n: 'unicorn', kw: ['magic'] },
  { e: '🇺🇸', n: 'flag_us', kw: ['usa', 'america', 'flag'] },
  { e: '🌈', n: 'rainbow', kw: ['pride'] },
  { e: '☑️', n: 'check_box_with_check', kw: ['done', 'checked'] },
];

export interface EmojiSearchRow {
  e: string;
  n: string;
}

/**
 * Glyph → entry index, built ONCE at module scope.
 *
 * The picker resolves one shortcode per grid cell, and the previous linear
 * `find` made that O(catalog) per cell — ~17,700 string comparisons to render
 * the 133-cell grid, repeated on every keystroke in the panel's own search
 * field (performance pass, P2). The index makes it O(1) per cell and the
 * search field's re-render linear.
 *
 * FIRST entry wins, which is exactly what the previous `find` did: the
 * catalog carries two duplicated glyphs (🙏 `pray`/`folded_hands`, 😱
 * `scream`/`fearful`) and the first shortcode is the one the UI has always
 * shown (`shortcodesFor`'s canonical entry).
 */
const EMOJI_BY_GLYPH: ReadonlyMap<string, CatalogEmoji> = (() => {
  const index = new Map<string, CatalogEmoji>();
  for (const emoji of EMOJI_CATALOG) if (!index.has(emoji.e)) index.set(emoji.e, emoji);
  return index;
})();

/** Shortcode → entry index (shortcodes are unique; first wins regardless). */
const EMOJI_BY_SHORTCODE: ReadonlyMap<string, CatalogEmoji> = (() => {
  const index = new Map<string, CatalogEmoji>();
  for (const emoji of EMOJI_CATALOG) if (!index.has(emoji.n)) index.set(emoji.n, emoji);
  return index;
})();

/** True when the emoji's shortcode/keywords contain the (lowercased) needle. */
function matches(emoji: CatalogEmoji, needle: string): boolean {
  if (emoji.n.includes(needle)) return true;
  return (emoji.kw ?? []).some((k) => k.toLowerCase().includes(needle));
}

/** Search the catalog by shortcode fragment or keyword (empty → everything). */
export function searchEmojiCatalog(query: string): EmojiSearchRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return EMOJI_CATALOG.map(({ e, n }) => ({ e, n }));
  return EMOJI_CATALOG.filter((emoji) => matches(emoji, needle)).map(({ e, n }) => ({ e, n }));
}

/** Look up one emoji by exact shortcode (autocomplete pick path). */
export function emojiByShortcode(shortcode: string): CatalogEmoji | null {
  return EMOJI_BY_SHORTCODE.get(shortcode.trim().toLowerCase()) ?? null;
}

/**
 * The canonical shortcode for an emoji character, or undefined when the glyph
 * is not in the catalog. O(1) — this is the per-cell lookup the picker grid
 * and the `:shortcode:` autocomplete hints use.
 */
export function canonicalShortcode(emojiChar: string): string | undefined {
  return EMOJI_BY_GLYPH.get(emojiChar)?.n;
}

/** Shortcode candidates shown for an emoji (Discord's hover footer shows
 * several; ours is the canonical one plus keyword-derived aliases). */
export function shortcodesFor(emojiChar: string): string[] {
  const entry = EMOJI_BY_GLYPH.get(emojiChar);
  if (!entry) return [];
  return [entry.n, ...(entry.kw ?? []).map((k) => k.replaceAll(' ', '_'))].slice(0, 4);
}
