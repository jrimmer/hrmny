/**
 * @cytale/emoji — composer emoji preferences (frecents + curated favorites).
 *
 * Storage-agnostic on purpose: the two clients persist differently (web:
 * localStorage, native: an in-memory per-account store until a durable
 * adapter lands), but the SET semantics — dedupe, most-recent-first, caps,
 * catalog-membership filtering — are the shared contract. `apps/web` binds
 * this factory to `globalThis.localStorage` with the historical key names so
 * its behaviour and tests are unchanged; `apps/mobile` binds it per account
 * so switching accounts never leaks another user's picks.
 *
 * Frecents are bump-on-use; favorites are explicitly curated (settings on
 * web). Both are best-effort: a storage failure degrades to empty, never
 * throws — the composer must render regardless.
 */

/** Minimal synchronous storage the preferences need (localStorage-shaped). */
export interface EmojiStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const EMOJI_FRECENTS_MAX = 8;
export const EMOJI_FAVORITES_MAX = 8;

export interface EmojiPreferencesOptions {
  /** Key prefix; defaults to `cytale` — web's historical namespace. */
  namespace?: string;
  /**
   * Per-account suffix (a user id). When set, both key families gain
   * `.<accountKey>`, so two accounts on one device keep separate picks.
   */
  accountKey?: string | null;
}

/** The exact keys a preferences instance reads/writes (tests + migration). */
export function emojiPreferenceKeys(options: EmojiPreferencesOptions = {}): {
  frecents: string;
  favorites: string;
} {
  const namespace = options.namespace ?? 'cytale';
  const suffix = options.accountKey ? `.${options.accountKey}` : '';
  return {
    frecents: `${namespace}.emoji-frecents${suffix}`,
    favorites: `${namespace}.emoji-favorites${suffix}`,
  };
}

export interface EmojiPreferences {
  /** Curated favorites (settings-owned), deduped + capped. Empty by default. */
  readFavorites(): string[];
  /** Persist a favorites set (deduped, capped). Best-effort. */
  writeFavorites(favorites: string[]): void;
  /** Recently-picked emoji, most-recent first. Best-effort. */
  readFrecents(): string[];
  /** Record a pick (dedupe, most-recent-first, capped). Best-effort. */
  bumpFrecents(emojiChar: string): void;
}

function readStringArray(storage: EmojiStorage, key: string): string[] | null {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === 'string')) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStringArray(storage: EmojiStorage, key: string, values: string[]): void {
  try {
    storage.setItem(key, JSON.stringify(values));
  } catch {
    // storage unavailable — preferences are best-effort
  }
}

/** Build the preferences bound to one storage + key namespace. */
export function createEmojiPreferences(
  storage: EmojiStorage,
  options: EmojiPreferencesOptions = {},
): EmojiPreferences {
  const keys = emojiPreferenceKeys(options);

  const readFavorites = (): string[] => {
    const parsed = readStringArray(storage, keys.favorites);
    return parsed === null ? [] : parsed.slice(0, EMOJI_FAVORITES_MAX);
  };
  const readFrecents = (): string[] => {
    const parsed = readStringArray(storage, keys.frecents);
    return parsed === null ? [] : parsed.slice(0, EMOJI_FRECENTS_MAX);
  };

  return {
    readFavorites,
    writeFavorites(favorites: string[]): void {
      writeStringArray(
        storage,
        keys.favorites,
        [...new Set(favorites)].slice(0, EMOJI_FAVORITES_MAX),
      );
    },
    readFrecents,
    bumpFrecents(emojiChar: string): void {
      const next = [emojiChar, ...readFrecents().filter((e) => e !== emojiChar)].slice(
        0,
        EMOJI_FRECENTS_MAX,
      );
      writeStringArray(storage, keys.frecents, next);
    },
  };
}

/**
 * In-memory storage — the native v1 adapter (per-account preferences survive
 * a sign-out/sign-in within the process, not a cold launch) and the test
 * double for both clients. `seed` pre-fills keys.
 */
export function createMemoryEmojiStorage(seed: Record<string, string> = {}): EmojiStorage {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}
