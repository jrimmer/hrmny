/**
 * @cytale/web — composer draft storage (localStorage).
 *
 * A draft is keyed by the SIGNED-IN MEMBER and the conversation scope:
 * `cytale.draft.<userId>.<scope>` (the scope is the channel id, or a thread's
 * `<channel>.t.<thread>` / `<channel>.p.<seed>` — see `threadDraftScope`).
 * Keying by channel alone let a shared browser show one member's unsent text
 * in the next member's composer for the same channel. With nobody signed in
 * there is no key: nothing is read and nothing is written.
 *
 * Sign-out removes EVERY `cytale.draft.*` key (`clearAllDrafts`, run beside
 * the device-snapshot purge), including pre-per-user keys from older builds.
 */

export const DRAFT_KEY_PREFIX = 'cytale.draft.';

/** The storage key for `scope` as `userId`, or null when nobody is signed in. */
export function draftKey(userId: string | null | undefined, scope: string): string | null {
  if (typeof userId !== 'string' || userId === '') return null;
  return `${DRAFT_KEY_PREFIX}${userId}.${scope}`;
}

export function readDraft(userId: string | null | undefined, scope: string): string {
  const key = draftKey(userId, scope);
  if (key === null) return '';
  try {
    return globalThis.localStorage?.getItem(key) ?? '';
  } catch {
    return '';
  }
}

export function writeDraft(userId: string | null | undefined, scope: string, content: string): void {
  const key = draftKey(userId, scope);
  if (key === null) return;
  try {
    if (content) globalThis.localStorage?.setItem(key, content);
    else globalThis.localStorage?.removeItem(key);
  } catch {
    // storage unavailable — drafts are best-effort
  }
}

/** Remove every composer draft on this device (sign-out). */
export function clearAllDrafts(): void {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return;
    const doomed: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key !== null && key.startsWith(DRAFT_KEY_PREFIX)) doomed.push(key);
    }
    for (const key of doomed) storage.removeItem(key);
  } catch {
    // storage unavailable — nothing to clear
  }
}
