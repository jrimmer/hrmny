/**
 * @cytale/web — where the member was, remembered per user (lane D #3).
 *
 * Every reload used to start from nothing: the active workspace and channel
 * were `useState(null)`, and with an empty store at mount the shell's
 * "no workspaces → Home" rule put Home on the first frame for EVERY member —
 * then jumped to the first workspace once the roster arrived, forgetting the
 * channel they had open. The shell now starts where the member left off, and
 * the location is written as they move.
 *
 * Per user (the key carries the id) so a shared browser never opens one
 * member's channel for another; localStorage because this is a per-device
 * convenience. Every access is guarded: private mode or blocked storage
 * simply means "start fresh".
 */

export interface LastLocation {
  /** True when the member was on Home (DMs / dashboard). */
  home: boolean;
  workspaceId: string | null;
  channelId: string | null;
}

const PREFIX = 'cytale.last-location.';

function keyFor(userId: string): string {
  return `${PREFIX}${userId}`;
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,24}$/.test(value);
}

/** The member's last location, or null when none (or unreadable). */
export function readLastLocation(userId: string | null | undefined): LastLocation | null {
  if (!userId) return null;
  try {
    const raw = localStorage.getItem(keyFor(userId));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<LastLocation> | null;
    if (parsed === null || typeof parsed !== 'object') return null;
    return {
      home: parsed.home === true,
      workspaceId: isId(parsed.workspaceId) ? parsed.workspaceId : null,
      channelId: isId(parsed.channelId) ? parsed.channelId : null,
    };
  } catch {
    return null;
  }
}

/** Remember the member's location (no-op when storage is unavailable). */
export function writeLastLocation(userId: string | null | undefined, location: LastLocation): void {
  if (!userId) return;
  try {
    localStorage.setItem(keyFor(userId), JSON.stringify(location));
  } catch {
    // storage unavailable — the next boot simply starts fresh
  }
}

/**
 * The user id the last signed-in session on this device belonged to — read
 * at boot, BEFORE the session has restored, so per-user device state (the
 * snapshot cache, lane D #8) can start loading in parallel with the refresh.
 * Never an authorization input: the restored session's own id decides.
 */
const LAST_USER_KEY = 'cytale.last-user-id';

export function readLastUserId(): string | null {
  try {
    const raw = localStorage.getItem(LAST_USER_KEY);
    return isId(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function writeLastUserId(userId: string | null): void {
  try {
    if (userId === null) localStorage.removeItem(LAST_USER_KEY);
    else localStorage.setItem(LAST_USER_KEY, userId);
  } catch {
    // storage unavailable
  }
}
