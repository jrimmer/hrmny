/**
 * @cytale/mobile — emoji preferences binding (plan 004 M7/KTD6).
 *
 * The shared `@cytale/emoji` factory, bound to an in-memory store keyed per
 * ACCOUNT: two users signing in on one device never see each other's
 * favorites or frecents. v1 has no durable native store for this (web uses
 * localStorage; the settings surface that curates favorites is web-only), so
 * picks survive a sign-out/sign-in within the process and reset on cold
 * launch — the seam (`EmojiStorage`) is where a durable adapter drops in.
 */
import {
  createEmojiPreferences,
  createMemoryEmojiStorage,
  type EmojiPreferences,
  type EmojiStorage,
} from '@cytale/emoji';

let storage: EmojiStorage = createMemoryEmojiStorage();
const byAccount = new Map<string, EmojiPreferences>();

/** The signed-in user's preferences (anonymous bucket when signed out). */
export function emojiPreferencesFor(accountId: string | null | undefined): EmojiPreferences {
  const key = accountId ?? 'anonymous';
  let preferences = byAccount.get(key);
  if (preferences === undefined) {
    preferences = createEmojiPreferences(storage, { accountKey: key });
    byAccount.set(key, preferences);
  }
  return preferences;
}

/** Test hygiene: drop every binding and its data. */
export function resetEmojiPreferences(): void {
  storage = createMemoryEmojiStorage();
  byAccount.clear();
}
