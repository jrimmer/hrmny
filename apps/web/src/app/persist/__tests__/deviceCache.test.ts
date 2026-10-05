/**
 * Lane D #8 — the persisted device cache: what is kept, that it never
 * overwrites server data or persists before the server roster, the version
 * gate, the boot-time timeout, and the opt-out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Message } from '@cytale/domain';
import { applyGatewayEvent, channelUnreadCount, createStateStore, type StateStore } from '@cytale/state';
import type { GatewayEvent } from '@cytale/protocol';

import {
  DEVICE_CACHE_ROWS_PER_CHANNEL,
  DEVICE_CACHE_SETTING_KEY,
  DEVICE_CACHE_VERSION,
  applyDeviceSnapshot,
  buildDeviceSnapshot,
  clearDeviceSnapshotFor,
  clearDeviceSnapshots,
  isDeviceCacheEnabled,
  loadDeviceSnapshot,
  setDeviceCacheEnabled,
  setSnapshotStorageForTests,
  snapshotKey,
  startDeviceSnapshotWriter,
  type SnapshotStorage,
} from '../deviceCache.js';

const ORIGIN = 'https://chat.example';
const USER = '7000000000000001';

function memoryStorage(): SnapshotStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (k) => data.get(k),
    put: async (k, v) => {
      data.set(k, JSON.parse(JSON.stringify(v)));
    },
    delete: async (k) => {
      data.delete(k);
    },
    clear: async () => {
      data.clear();
    },
  };
}

function msg(id: string): Message {
  return {
    id,
    channel_id: 'C1',
    thread_id: null,
    author_id: '9',
    content: `m${id}`,
    created_at: '2026-09-27T00:00:00Z',
    edited_at: null,
  };
}

function serverStore(): StateStore {
  const store = createStateStore();
  const rows = Array.from({ length: DEVICE_CACHE_ROWS_PER_CHANNEL + 10 }, (_, i) =>
    msg(String(1000000000002000 - i)),
  );
  store.setState({
    currentUser: { id: USER, username: 'me' },
    rosterSource: 'server',
    workspaces: { W1: { id: 'W1', name: 'one', owner_id: USER, role_version: 0, created_at: 'x' } },
    channels: {
      C1: {
        id: 'C1',
        workspace_id: 'W1',
        name: 'general',
        type: 'text',
        topic: null,
        position: 0,
        last_message_id: null,
        created_at: 'x',
      },
    },
    recentChannelIds: ['C1', 'C2'],
    messagesByChannel: {
      C1: {
        items: [{ ...msg('pending_abc'), id: 'pending_abc' }, ...rows],
        oldestId: rows[rows.length - 1]!.id,
        hasCompleteHistory: true,
      },
      // Live-only slice (no REST window): not worth restoring.
      C2: { items: [msg('1000000000000005')], oldestId: null, hasCompleteHistory: false },
    },
  });
  return store;
}

let mem: ReturnType<typeof memoryStorage>;
let restore: SnapshotStorage;

beforeEach(() => {
  mem = memoryStorage();
  restore = setSnapshotStorageForTests(mem);
  localStorage.removeItem(DEVICE_CACHE_SETTING_KEY);
});

afterEach(() => {
  setSnapshotStorageForTests(restore);
  vi.useRealTimers();
});

describe('building a snapshot', () => {
  it('keeps the newest page of REST-read recent channels, without placeholders', () => {
    const snap = buildDeviceSnapshot(serverStore().getState());
    const c1 = snap.messagesByChannel['C1']!;
    expect(c1.items).toHaveLength(DEVICE_CACHE_ROWS_PER_CHANNEL);
    expect(c1.items.some((m) => m.id.startsWith('pending_'))).toBe(false);
    expect(c1.oldestId).toBe(c1.items[c1.items.length - 1]!.id);
    // Rows were cut, so the history is no longer complete.
    expect(c1.hasCompleteHistory).toBe(false);
    expect(snap.messagesByChannel['C2']).toBeUndefined();
    expect(snap.version).toBe(DEVICE_CACHE_VERSION);
  });
});

describe('load + apply', () => {
  it('round-trips through storage and paints an empty store in one write', async () => {
    await mem.put(snapshotKey(ORIGIN, USER), buildDeviceSnapshot(serverStore().getState()));
    const snap = await loadDeviceSnapshot({ userId: USER, origin: ORIGIN });
    expect(snap).not.toBeNull();

    const store = createStateStore();
    let writes = 0;
    store.subscribe(() => {
      writes += 1;
    });
    expect(applyDeviceSnapshot(store, snap!)).toBe(true);
    expect(writes).toBe(1);
    expect(store.getState().rosterSource).toBe('cache');
    expect(store.getState().channels['C1']?.name).toBe('general');
    expect(store.getState().messagesByChannel['C1']!.items).toHaveLength(DEVICE_CACHE_ROWS_PER_CHANNEL);
  });

  it('a restored unread count yields to the session sync at the same watermark', async () => {
    // The phantom badge (#logs, 2026-09-29): three messages accrued while the
    // member was elsewhere, were deleted, and the snapshot kept counting them.
    // The sync reports the SAME watermark (the member acked before they came)
    // and a count of 0 — it must win.
    const source = serverStore();
    source.setState({
      unreadByChannel: { C1: { last_read_id: '1000000000002000', unread_count: 3, mention_count: 0 } },
    });
    await mem.put(snapshotKey(ORIGIN, USER), buildDeviceSnapshot(source.getState()));
    const snap = await loadDeviceSnapshot({ userId: USER, origin: ORIGIN });

    const store = createStateStore();
    expect(applyDeviceSnapshot(store, snap!)).toBe(true);
    expect(channelUnreadCount(store.getState().unreadByChannel['C1'])).toBe(3);

    applyGatewayEvent(store, {
      op: 0,
      t: 'ReadStateSync',
      s: 1,
      d: {
        channels: [
          { channel_id: 'C1', last_read_id: '1000000000002000', unread_floor: null, unread_count: 0, mention_count: 0 },
        ],
      },
    } as unknown as GatewayEvent);
    expect(channelUnreadCount(store.getState().unreadByChannel['C1'])).toBe(0);
  });

  it('never overwrites a store the server already filled', async () => {
    const snap = buildDeviceSnapshot(serverStore().getState());
    const store = createStateStore();
    store.setState({ rosterSource: 'server' });
    expect(applyDeviceSnapshot(store, snap)).toBe(false);
    expect(store.getState().channels).toEqual({});
  });

  it('ignores and clears a record from another schema version', async () => {
    const key = snapshotKey(ORIGIN, USER);
    await mem.put(key, { ...buildDeviceSnapshot(serverStore().getState()), version: DEVICE_CACHE_VERSION + 1 });
    expect(await loadDeviceSnapshot({ userId: USER, origin: ORIGIN })).toBeNull();
    await Promise.resolve();
    expect(mem.data.has(key)).toBe(false);
  });

  it('ignores a corrupt record', async () => {
    await mem.put(snapshotKey(ORIGIN, USER), { version: DEVICE_CACHE_VERSION, channels: 'nope' });
    expect(await loadDeviceSnapshot({ userId: USER, origin: ORIGIN })).toBeNull();
  });

  it('never waits past its timeout', async () => {
    setSnapshotStorageForTests({
      ...mem,
      get: () => new Promise(() => undefined), // IndexedDB that never answers
    });
    const started = Date.now();
    expect(await loadDeviceSnapshot({ userId: USER, origin: ORIGIN, timeoutMs: 20 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('a failing storage reads as no snapshot', async () => {
    setSnapshotStorageForTests({
      ...mem,
      get: async () => {
        throw new Error('broken');
      },
    });
    expect(await loadDeviceSnapshot({ userId: USER, origin: ORIGIN })).toBeNull();
  });
});

describe('the writer', () => {
  it('writes after the quiet period, only once the server roster landed', async () => {
    vi.useFakeTimers();
    const store = createStateStore();
    store.setState({ currentUser: { id: USER, username: 'me' } });
    const stop = startDeviceSnapshotWriter(store, {
      userId: USER,
      origin: ORIGIN,
      enabled: () => true,
      debounceMs: 100,
      idle: (cb) => cb(),
    });

    store.setState({ rosterSource: 'cache' });
    await vi.advanceTimersByTimeAsync(150);
    expect(mem.data.size).toBe(0); // a cache never re-persists itself

    store.setState(serverStore().getState());
    await vi.advanceTimersByTimeAsync(150);
    expect(mem.data.has(snapshotKey(ORIGIN, USER))).toBe(true);
    stop();
  });

  it('writes nothing while the setting is off, and nothing after stop', async () => {
    vi.useFakeTimers();
    const store = serverStore();
    let on = false;
    const stop = startDeviceSnapshotWriter(store, {
      userId: USER,
      origin: ORIGIN,
      enabled: () => on,
      debounceMs: 100,
      idle: (cb) => cb(),
    });
    store.setState({ recentChannelIds: ['C1'] });
    await vi.advanceTimersByTimeAsync(150);
    expect(mem.data.size).toBe(0);

    on = true;
    stop();
    store.setState({ recentChannelIds: ['C1', 'C2'] });
    await vi.advanceTimersByTimeAsync(150);
    expect(mem.data.size).toBe(0);
  });
});

describe('clearing and the opt-out', () => {
  it('clears one member or everyone', async () => {
    await mem.put(snapshotKey(ORIGIN, USER), 1);
    await mem.put(snapshotKey(ORIGIN, 'other'), 1);
    await clearDeviceSnapshotFor({ userId: USER, origin: ORIGIN });
    expect([...mem.data.keys()]).toEqual([snapshotKey(ORIGIN, 'other')]);
    await clearDeviceSnapshots();
    expect(mem.data.size).toBe(0);
  });

  it('turning the cache off persists the choice and clears what was kept', async () => {
    await mem.put(snapshotKey(ORIGIN, USER), buildDeviceSnapshot(serverStore().getState()));
    expect(isDeviceCacheEnabled()).toBe(true);
    setDeviceCacheEnabled(false);
    expect(isDeviceCacheEnabled()).toBe(false);
    await Promise.resolve();
    expect(mem.data.size).toBe(0);
    expect(await loadDeviceSnapshot({ userId: USER, origin: ORIGIN })).toBeNull();
    setDeviceCacheEnabled(true);
    expect(isDeviceCacheEnabled()).toBe(true);
  });
});
