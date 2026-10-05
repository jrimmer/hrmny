/**
 * @cytale/web — the persisted device cache (lane D #8).
 *
 * A reload used to start from an EMPTY store: the shell had nothing to paint
 * until READY (and, before it carried the roster, a REST waterfall) came back,
 * so every reload showed a cover or a skeleton for the length of a round trip.
 * The owner decided the member's recent state is worth keeping on the device:
 * an IndexedDB snapshot of the roster, read state, and the newest page of the
 * channels they had open, loaded BEFORE the first render so the shell paints
 * real data at once and the server replaces it moments later.
 *
 * The rules that make that safe:
 *
 *   * KEYED by origin + user id — a snapshot is never shown to anyone but the
 *     member it was written for, and a different server's data never mixes in.
 *     Logout and a user switch clear every record (`clearDeviceSnapshots`).
 *   * NEVER BLOCKS BOOT: `loadDeviceSnapshot` races a ~50 ms timer and hands
 *     back null when IndexedDB is slow, missing (private mode, jsdom) or
 *     broken — a cold boot is the worst case, never a stall.
 *   * NEVER OVERWRITES THE SERVER: the snapshot fills a store whose roster has
 *     not landed yet (`rosterSource === 'none'`) and nothing else; and it is
 *     only WRITTEN once the server roster has landed, so a cache can never
 *     re-persist its own stale content as if it were fresh.
 *   * VERSIONED: a record from another schema version (or one that does not
 *     parse as this one) is ignored and cleared rather than half-trusted.
 *   * OPT-OUT: "Don't keep messages on this device" (shared computers) — a
 *     per-device flag; turning it off stops the writer and clears the store.
 *   * Everything is try/catch'd: a cache is an optimisation, and no failure of
 *     it may reach a caller.
 */

import type { Channel, Message, Thread, Workspace, WorkspaceMember } from '@cytale/domain';
import type { MessageSlice, StateState, StateStore, UnreadState } from '@cytale/state';

/** Bump when the snapshot's shape changes; older records are then cleared. */
export const DEVICE_CACHE_VERSION = 1;

/** Newest rows kept per persisted channel — one REST page. */
export const DEVICE_CACHE_ROWS_PER_CHANNEL = 50;

/** How many of the most recently opened channels keep their messages. */
export const DEVICE_CACHE_CHANNELS = 10;

/** Quiet period after the last store write before a snapshot is written. */
export const DEVICE_CACHE_WRITE_DEBOUNCE_MS = 2_000;

/** The per-device opt-out flag ('off' = don't keep anything on this device). */
export const DEVICE_CACHE_SETTING_KEY = 'cytale.device-cache';

const DB_NAME = 'cytale-device-cache';
const STORE_NAME = 'snapshots';

/** What one member's device snapshot holds (JSON-serializable only). */
export interface DeviceSnapshot {
  version: number;
  /** Epoch ms the snapshot was taken (diagnostics; never trusted for freshness). */
  savedAt: number;
  workspaces: Record<string, Workspace>;
  channels: Record<string, Channel>;
  membersById: Record<string, WorkspaceMember>;
  memberIdsByWorkspace: Record<string, string[]>;
  /** Per-workspace nicknames (#169). Optional: snapshots from before it load without it. */
  nicknamesByWorkspace?: Record<string, Record<string, string>>;
  threadsById: Record<string, Thread>;
  threadIdsByChannel: Record<string, string[]>;
  unreadByChannel: Record<string, UnreadState>;
  lastMessageIdByChannel: Record<string, string>;
  recentChannelIds: string[];
  messagesByChannel: Record<string, MessageSlice>;
}

// ---------------------------------------------------------------------------
// Storage seam
// ---------------------------------------------------------------------------

/**
 * The key/value surface this module needs from IndexedDB. The real adapter
 * (`indexedDbAdapter`) is deliberately thin; tests inject an in-memory one.
 */
export interface SnapshotStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise !== null) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    if (idb === undefined) {
      reject(new Error('indexedDB unavailable'));
      return;
    }
    const req = idb.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    // Another tab holding an older version open: give up rather than wait.
    req.onblocked = () => reject(new Error('indexedDB open blocked'));
  });
  // A failed open is not cached forever — the next call may succeed.
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  return promisify(run(db.transaction(STORE_NAME, mode).objectStore(STORE_NAME)));
}

/** The real IndexedDB adapter (one object store, string keys). */
export const indexedDbAdapter: SnapshotStorage = {
  get: (key) => withStore('readonly', (s) => s.get(key)),
  put: async (key, value) => {
    await withStore('readwrite', (s) => s.put(value, key));
  },
  delete: async (key) => {
    await withStore('readwrite', (s) => s.delete(key));
  },
  clear: async () => {
    await withStore('readwrite', (s) => s.clear());
  },
};

let storage: SnapshotStorage = indexedDbAdapter;

/** Test seam: swap the storage adapter (returns the previous one). */
export function setSnapshotStorageForTests(next: SnapshotStorage): SnapshotStorage {
  const prev = storage;
  storage = next;
  return prev;
}

/** One record per member per server. */
export function snapshotKey(origin: string, userId: string): string {
  return `${origin}|${userId}`;
}

// ---------------------------------------------------------------------------
// The opt-out setting
// ---------------------------------------------------------------------------

/** True unless the member said "don't keep messages on this device". */
export function isDeviceCacheEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(DEVICE_CACHE_SETTING_KEY) !== 'off';
  } catch {
    // Storage unreadable (sandboxed/private): treat as on — the cache itself
    // will then fail quietly too, which is the same outcome.
    return true;
  }
}

/**
 * Record the choice. Turning the cache OFF clears every stored snapshot at
 * once — "don't keep" has to mean the data already kept goes too.
 */
export function setDeviceCacheEnabled(on: boolean): void {
  try {
    if (on) globalThis.localStorage?.removeItem(DEVICE_CACHE_SETTING_KEY);
    else globalThis.localStorage?.setItem(DEVICE_CACHE_SETTING_KEY, 'off');
  } catch {
    // The preference just doesn't persist; the clear below still runs.
  }
  if (!on) void clearDeviceSnapshots();
}

// ---------------------------------------------------------------------------
// Build / validate
// ---------------------------------------------------------------------------

function isPlaceholder(m: Message): boolean {
  return m.id.startsWith('pending_');
}

/**
 * The newest page of one slice, placeholders dropped. `hasCompleteHistory`
 * survives only when every row fit — a trimmed slice has older history again
 * as far as the restored store knows, and the pager resumes from `oldestId`.
 */
function persistableSlice(slice: MessageSlice): MessageSlice | null {
  const real = slice.items.filter((m) => !isPlaceholder(m));
  if (real.length === 0) return null;
  const items = real.slice(0, DEVICE_CACHE_ROWS_PER_CHANNEL);
  return {
    items,
    oldestId: items[items.length - 1]!.id,
    hasCompleteHistory: slice.hasCompleteHistory && items.length === real.length,
  };
}

/** The snapshot for a store state (pure; exported for tests). */
export function buildDeviceSnapshot(state: StateState, now: number = Date.now()): DeviceSnapshot {
  const messagesByChannel: Record<string, MessageSlice> = {};
  for (const id of state.recentChannelIds.slice(0, DEVICE_CACHE_CHANNELS)) {
    const slice = state.messagesByChannel[id];
    // Only a REST-read window is worth restoring (lane D #24): a slice live
    // traffic created holds just the messages that arrived since.
    if (slice === undefined || slice.oldestId === null) continue;
    const kept = persistableSlice(slice);
    if (kept !== null) messagesByChannel[id] = kept;
  }
  return {
    version: DEVICE_CACHE_VERSION,
    savedAt: now,
    workspaces: state.workspaces,
    channels: state.channels,
    membersById: state.membersById,
    memberIdsByWorkspace: state.memberIdsByWorkspace,
    nicknamesByWorkspace: state.nicknamesByWorkspace,
    threadsById: state.threadsById,
    threadIdsByChannel: state.threadIdsByChannel,
    unreadByChannel: state.unreadByChannel,
    lastMessageIdByChannel: state.lastMessageIdByChannel,
    recentChannelIds: state.recentChannelIds.slice(0, DEVICE_CACHE_CHANNELS),
    messagesByChannel,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Structural check of a stored value; anything else is corruption. */
function asSnapshot(value: unknown): DeviceSnapshot | null {
  if (!isRecord(value) || value['version'] !== DEVICE_CACHE_VERSION) return null;
  const maps = [
    'workspaces',
    'channels',
    'membersById',
    'memberIdsByWorkspace',
    'threadsById',
    'threadIdsByChannel',
    'unreadByChannel',
    'lastMessageIdByChannel',
    'messagesByChannel',
  ];
  for (const k of maps) if (!isRecord(value[k])) return null;
  if (!Array.isArray(value['recentChannelIds'])) return null;
  for (const slice of Object.values(value['messagesByChannel'] as Record<string, unknown>)) {
    if (!isRecord(slice) || !Array.isArray(slice['items'])) return null;
  }
  return value as unknown as DeviceSnapshot;
}

// ---------------------------------------------------------------------------
// Load / apply
// ---------------------------------------------------------------------------

/**
 * The member's snapshot, or null — never later than `timeoutMs`. A record of
 * another version (or corrupt) is cleared in the background.
 */
export function loadDeviceSnapshot(opts: {
  userId: string;
  origin: string;
  timeoutMs?: number;
}): Promise<DeviceSnapshot | null> {
  if (!isDeviceCacheEnabled()) return Promise.resolve(null);
  const key = snapshotKey(opts.origin, opts.userId);
  const read = (async (): Promise<DeviceSnapshot | null> => {
    try {
      const raw = await storage.get(key);
      if (raw === undefined || raw === null) return null;
      const snap = asSnapshot(raw);
      if (snap === null) void storage.delete(key).catch(() => undefined);
      return snap;
    } catch {
      return null;
    }
  })();
  const timeoutMs = opts.timeoutMs ?? 50;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    read.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/**
 * Paint the snapshot into a store that has no roster yet — ONE write. A store
 * the server already filled (`rosterSource !== 'none'`) is left alone: the
 * cache must never overwrite fresher data. Message slices are seeded only for
 * channels with none, so a page already read this session is never replaced.
 * Returns true when the snapshot was applied.
 */
export function applyDeviceSnapshot(store: StateStore, snapshot: DeviceSnapshot): boolean {
  try {
    const s = store.getState();
    if (s.rosterSource !== 'none') return false;
    const messagesByChannel = { ...s.messagesByChannel };
    for (const [id, slice] of Object.entries(snapshot.messagesByChannel)) {
      if (messagesByChannel[id] === undefined) messagesByChannel[id] = slice;
    }
    store.setState({
      workspaces: { ...snapshot.workspaces, ...s.workspaces },
      channels: { ...snapshot.channels, ...s.channels },
      membersById: { ...snapshot.membersById, ...s.membersById },
      memberIdsByWorkspace: { ...snapshot.memberIdsByWorkspace, ...s.memberIdsByWorkspace },
      nicknamesByWorkspace: isRecord(snapshot.nicknamesByWorkspace)
        ? { ...(snapshot.nicknamesByWorkspace as Record<string, Record<string, string>>), ...s.nicknamesByWorkspace }
        : s.nicknamesByWorkspace,
      threadsById: { ...snapshot.threadsById, ...s.threadsById },
      threadIdsByChannel: { ...snapshot.threadIdsByChannel, ...s.threadIdsByChannel },
      unreadByChannel: { ...snapshot.unreadByChannel, ...s.unreadByChannel },
      lastMessageIdByChannel: { ...snapshot.lastMessageIdByChannel, ...s.lastMessageIdByChannel },
      recentChannelIds: s.recentChannelIds.length > 0 ? s.recentChannelIds : snapshot.recentChannelIds,
      messagesByChannel,
      rosterSource: 'cache',
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Write / clear
// ---------------------------------------------------------------------------

type IdleScheduler = (cb: () => void) => void;

function scheduleIdle(cb: () => void): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => unknown })
    .requestIdleCallback;
  if (typeof ric === 'function') ric(cb, { timeout: 5_000 });
  else setTimeout(cb, 0);
}

/**
 * Keep the member's snapshot current: after a quiet period following a store
 * write, and when the browser is idle, write the snapshot — only once the
 * SERVER roster has landed, and only while the setting allows it. Returns the
 * stop function (call it on logout; it drops a pending write).
 */
export function startDeviceSnapshotWriter(
  store: StateStore,
  opts: {
    userId: string;
    origin: string;
    enabled: () => boolean;
    debounceMs?: number;
    idle?: IdleScheduler;
  },
): () => void {
  const key = snapshotKey(opts.origin, opts.userId);
  const debounceMs = opts.debounceMs ?? DEVICE_CACHE_WRITE_DEBOUNCE_MS;
  const idle = opts.idle ?? scheduleIdle;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const write = () => {
    if (stopped) return;
    try {
      if (!opts.enabled()) return;
      const state = store.getState();
      if (state.rosterSource !== 'server') return;
      // The store may have moved to another member (a user switch without a
      // reload): never file one member's data under another's key.
      if (state.currentUser !== null && state.currentUser.id !== opts.userId) return;
      void storage.put(key, buildDeviceSnapshot(state)).catch(() => undefined);
    } catch {
      // A cache write failure is never the caller's problem.
    }
  };

  const unsubscribe = store.subscribe(() => {
    if (stopped) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      idle(write);
    }, debounceMs);
  });

  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    unsubscribe();
  };
}

/** Drop every member's snapshot (logout, user switch, the opt-out). */
export async function clearDeviceSnapshots(): Promise<void> {
  try {
    await storage.clear();
  } catch {
    // Nothing stored, or storage unavailable: nothing to clear.
  }
}

/** Drop one member's snapshot for one server. */
export async function clearDeviceSnapshotFor(opts: { userId: string; origin: string }): Promise<void> {
  try {
    await storage.delete(snapshotKey(opts.origin, opts.userId));
  } catch {
    // As above.
  }
}
