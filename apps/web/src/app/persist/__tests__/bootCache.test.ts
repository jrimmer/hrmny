/**
 * Lane D #8 — the device snapshot against the session: applied only for the
 * member it belongs to, discarded (and deleted) for anyone else, cleared on
 * sign-out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createStateStore, type StateStore } from '@cytale/state';
import { createAuthStore } from '@cytale/session';

import { initDeviceCache } from '../bootCache.js';
import {
  buildDeviceSnapshot,
  setSnapshotStorageForTests,
  snapshotKey,
  type SnapshotStorage,
} from '../deviceCache.js';
import { readLastUserId, writeLastUserId } from '../../lastLocation.js';

const ORIGIN = 'https://chat.example';
const ME = '7000000000000001';
const OTHER = '7000000000000002';

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

function snapshotFor(userId: string) {
  const source = createStateStore();
  source.setState({
    currentUser: { id: userId, username: 'x' },
    rosterSource: 'server',
    workspaces: { W1: { id: 'W1', name: 'cached', owner_id: userId, role_version: 0, created_at: 'x' } },
  });
  return buildDeviceSnapshot(source.getState());
}

function memoryTokenStorage() {
  let pair: { accessToken: string | null; refreshToken: string | null } | null = null;
  return { read: () => pair, write: (p: typeof pair) => void (pair = p) };
}

let storage: ReturnType<typeof memoryStorage>;
let previous: SnapshotStorage;

beforeEach(() => {
  storage = memoryStorage();
  previous = setSnapshotStorageForTests(storage);
});

afterEach(() => {
  setSnapshotStorageForTests(previous);
  localStorage.clear();
});

function signIn(auth: ReturnType<typeof createAuthStore>, id: string): void {
  auth.getState().setUser({ id, username: 'u', email: null, email_verified_at: null } as never);
  auth.getState().setStatus('authenticated');
}

describe('initDeviceCache', () => {
  it('paints the last member\'s snapshot once the session says it is them', async () => {
    await storage.put(snapshotKey(ORIGIN, ME), snapshotFor(ME));
    writeLastUserId(ME);
    const store: StateStore = createStateStore();
    const auth = createAuthStore(memoryTokenStorage() as never);
    const stop = initDeviceCache({ authStore: auth as never, store, origin: ORIGIN });

    await vi.waitFor(() => expect(storage.data.size).toBe(1));
    // Not before the session resolves.
    expect(store.getState().rosterSource).toBe('none');
    signIn(auth, ME);
    await vi.waitFor(() => expect(store.getState().rosterSource).toBe('cache'));
    expect(store.getState().workspaces['W1']?.name).toBe('cached');
    stop();
  });

  it('never shows another member\'s snapshot, and deletes it', async () => {
    await storage.put(snapshotKey(ORIGIN, ME), snapshotFor(ME));
    writeLastUserId(ME);
    const store = createStateStore();
    const auth = createAuthStore(memoryTokenStorage() as never);
    const stop = initDeviceCache({ authStore: auth as never, store, origin: ORIGIN });

    signIn(auth, OTHER);
    await vi.waitFor(() => expect(storage.data.size).toBe(0));
    expect(store.getState().rosterSource).toBe('none');
    stop();
  });

  it('clears every snapshot on sign-out', async () => {
    const store = createStateStore();
    const auth = createAuthStore(memoryTokenStorage() as never);
    const stop = initDeviceCache({ authStore: auth as never, store, origin: ORIGIN });
    signIn(auth, ME);
    await storage.put(snapshotKey(ORIGIN, ME), snapshotFor(ME));

    auth.getState().setStatus('unauthenticated');
    await vi.waitFor(() => expect(storage.data.size).toBe(0));
    stop();
  });

  // Tier 3 #6: composer drafts go with the sign-out, every member's.
  it('removes every composer draft on sign-out (and nothing else)', async () => {
    const store = createStateStore();
    const auth = createAuthStore(memoryTokenStorage() as never);
    const stop = initDeviceCache({ authStore: auth as never, store, origin: ORIGIN });
    signIn(auth, ME);
    localStorage.setItem(`cytale.draft.${ME}.C1`, 'mine');
    localStorage.setItem(`cytale.draft.${OTHER}.C1`, 'theirs');
    localStorage.setItem('cytale.draft.C1', 'legacy unscoped');
    localStorage.setItem('cytale.theme', 'dark');

    auth.getState().setStatus('unauthenticated');

    await vi.waitFor(() => expect(localStorage.getItem(`cytale.draft.${ME}.C1`)).toBeNull());
    expect(localStorage.getItem(`cytale.draft.${OTHER}.C1`)).toBeNull();
    expect(localStorage.getItem('cytale.draft.C1')).toBeNull();
    expect(localStorage.getItem('cytale.theme')).toBe('dark');
    stop();
  });

  // Tier 3 #7: the session died while no tab was open (expired / revoked
  // refresh token). The boot settles SIGNED OUT with the member's snapshot
  // still on the device — it must go, like a sign-out.
  it('a boot that settles signed-out purges the stored snapshot, marker and drafts', async () => {
    await storage.put(snapshotKey(ORIGIN, ME), snapshotFor(ME));
    writeLastUserId(ME);
    localStorage.setItem(`cytale.draft.${ME}.C1`, 'left behind');
    const store = createStateStore();
    const auth = createAuthStore(memoryTokenStorage() as never);
    const stop = initDeviceCache({ authStore: auth as never, store, origin: ORIGIN });

    // Still restoring: nothing is touched yet.
    expect(auth.getState().status).toBe('loading');
    await vi.waitFor(() => expect(storage.data.size).toBe(1));
    expect(readLastUserId()).toBe(ME);

    auth.getState().setStatus('unauthenticated');

    await vi.waitFor(() => expect(storage.data.size).toBe(0));
    expect(readLastUserId()).toBeNull();
    expect(localStorage.getItem(`cytale.draft.${ME}.C1`)).toBeNull();
    expect(store.getState().rosterSource).toBe('none');

    // The next member to sign in never sees the purged snapshot.
    signIn(auth, ME);
    await new Promise((r) => setTimeout(r, 0));
    expect(store.getState().rosterSource).toBe('none');
    stop();
  });

  it('a signed-out boot that lands BEFORE the snapshot read still never applies it later', async () => {
    await storage.put(snapshotKey(ORIGIN, ME), snapshotFor(ME));
    writeLastUserId(ME);
    const store = createStateStore();
    const auth = createAuthStore(memoryTokenStorage() as never);
    auth.getState().setStatus('unauthenticated');
    const stop = initDeviceCache({ authStore: auth as never, store, origin: ORIGIN });

    await vi.waitFor(() => expect(storage.data.size).toBe(0));
    signIn(auth, ME);
    await new Promise((r) => setTimeout(r, 10));
    expect(store.getState().rosterSource).toBe('none');
    stop();
  });
});
