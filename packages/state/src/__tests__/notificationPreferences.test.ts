/**
 * @cytale/state — the shared notification preference slice (2026-09-27).
 *
 * The properties that make it ONE source of truth: the walk agrees with the
 * server's, a write moves the slice before the server answers, a refusal rolls
 * back only its own write, a hydrate never clobbers a write that started
 * after it, and the live mention accrual honours the broadcast switch.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { applyGatewayEvent, resetForFreshSession } from '../reconcile.js';
import { createStateStore } from '../store.js';
import {
  clearNotificationLevel,
  hydrateNotificationPreferences,
  messageAddressesMe,
  nextNotificationLevel,
  NOTIFICATION_LEVEL_CYCLE,
  resolveNotificationLevel,
  resolveNotificationTarget,
  setBroadcastSuppressed,
  setNotificationLevel,
  type NotificationPrefsApi,
} from '../notificationPreferences.js';

const ME = '7000000000000002';
const OTHER = '7000000000000001';
const WS = '5000000000000001';
const CH = '6000000000000001';
const DM = '6000000000000009';
const THREAD = '6100000000000001';

function api(overrides: Partial<NotificationPrefsApi> = {}): NotificationPrefsApi {
  return {
    getNotificationPreferences: vi.fn(async () => ({ preferences: [], suppress_broadcasts: [] })),
    setNotificationPreference: vi.fn(async () => undefined),
    clearNotificationPreference: vi.fn(async () => undefined),
    setBroadcastSuppression: vi.fn(async () => undefined),
    ...overrides,
  };
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function seededStore() {
  const store = createStateStore();
  store.setState({
    currentUser: { id: ME, username: 'me' },
    channels: {
      [CH]: { id: CH, workspace_id: WS, name: 'general', type: 'text' } as never,
      [DM]: { id: DM, workspace_id: null, name: 'dm', type: 'dm' } as never,
    },
  });
  return store;
}

let seq = 0;
beforeEach(() => {
  seq = 0;
});

function send(store: ReturnType<typeof createStateStore>, id: string, content: string, channel = CH) {
  applyGatewayEvent(store, {
    op: 0,
    t: 'MessageCreate',
    s: ++seq,
    d: {
      id,
      channel_id: channel,
      thread_id: null,
      author_id: OTHER,
      content,
      created_at: '2026-09-27T00:00:00Z',
      edited_at: null,
    },
  } as never);
}

describe('the cycle', () => {
  it('runs all → mentions → mute → all', () => {
    expect(NOTIFICATION_LEVEL_CYCLE).toEqual(['all', 'mentions', 'mute']);
    expect(nextNotificationLevel('all')).toBe('mentions');
    expect(nextNotificationLevel('mentions')).toBe('mute');
    expect(nextNotificationLevel('mute')).toBe('all');
  });
});

describe('the walk (the server resolver, client copy)', () => {
  it('defaults to mentions, decided by the account, not overridden', () => {
    expect(resolveNotificationLevel({ overrides: {}, channelId: CH, workspaceId: WS })).toEqual({
      level: 'mentions',
      decidedBy: 'account',
      overridden: false,
    });
  });

  it('most specific wins, and an absent layer is skipped', () => {
    const overrides = { [`workspace:${WS}`]: 'mute' as const, [`thread:${THREAD}`]: 'all' as const };
    expect(resolveNotificationLevel({ overrides, workspaceId: WS, channelId: CH }).decidedBy).toBe('workspace');
    expect(resolveNotificationLevel({ overrides, workspaceId: WS, channelId: CH, threadId: THREAD })).toMatchObject({
      level: 'all',
      decidedBy: 'thread',
    });
  });

  it('a target reports whether it holds its own row and what clearing it lands on', () => {
    const prefs = {
      overrides: { [`workspace:${WS}`]: 'all' as const, [`channel:${CH}`]: 'mute' as const },
      suppressBroadcasts: {},
      status: 'ready' as const,
    };
    const channel = resolveNotificationTarget(prefs, { scope: 'channel', entityId: CH, workspaceId: WS, channelId: CH });
    expect(channel).toMatchObject({ level: 'mute', explicit: true, inheritedLevel: 'all', inheritedFrom: 'workspace' });

    const thread = resolveNotificationTarget(prefs, {
      scope: 'thread',
      entityId: THREAD,
      workspaceId: WS,
      channelId: CH,
      threadId: THREAD,
    });
    // A thread with no row inherits its channel.
    expect(thread).toMatchObject({ level: 'mute', explicit: false, decidedBy: 'channel' });

    // A DM has no workspace: its default is the account layer.
    const dm = resolveNotificationTarget(prefs, { scope: 'channel', entityId: DM, channelId: DM });
    expect(dm).toMatchObject({ level: 'mentions', explicit: false, inheritedFrom: 'account' });
  });
});

describe('optimistic writes', () => {
  it('a set moves the slice before the server answers', async () => {
    const store = seededStore();
    const gate = deferred();
    const io = api({ setNotificationPreference: vi.fn(() => gate.promise) });

    const pending = setNotificationLevel(store, io, 'channel', CH, 'mute');
    expect(store.getState().notificationPrefs.overrides[`channel:${CH}`]).toBe('mute');
    gate.resolve();
    await pending;
    expect(io.setNotificationPreference).toHaveBeenCalledWith('channel', 'mute', CH);
  });

  it('a refused set rolls back and rejects', async () => {
    const store = seededStore();
    const io = api({ setNotificationPreference: vi.fn(async () => Promise.reject(new Error('503'))) });

    await expect(setNotificationLevel(store, io, 'channel', CH, 'mute')).rejects.toThrow('503');
    expect(store.getState().notificationPrefs.overrides[`channel:${CH}`]).toBeUndefined();
  });

  it('a stale failure never rolls back over a newer write', async () => {
    const store = seededStore();
    const first = deferred();
    const calls: Array<ReturnType<typeof deferred<void>>> = [first, deferred()];
    let n = 0;
    const io = api({ setNotificationPreference: vi.fn(() => calls[n++]!.promise) });

    const a = setNotificationLevel(store, io, 'channel', CH, 'mentions');
    const b = setNotificationLevel(store, io, 'channel', CH, 'mute');
    first.reject(new Error('lost'));
    await expect(a).rejects.toThrow('lost');
    expect(store.getState().notificationPrefs.overrides[`channel:${CH}`]).toBe('mute');
    calls[1]!.resolve();
    await b;
  });

  it('the account layer writes with no entity id', async () => {
    const store = seededStore();
    const io = api();
    await setNotificationLevel(store, io, 'account', '0', 'all');
    expect(io.setNotificationPreference).toHaveBeenCalledWith('account', 'all');
  });

  it('clear returns the target to inherit, and rolls back on failure', async () => {
    const store = seededStore();
    await setNotificationLevel(store, api(), 'channel', CH, 'mute');

    const failing = api({ clearNotificationPreference: vi.fn(async () => Promise.reject(new Error('x'))) });
    await expect(clearNotificationLevel(store, failing, 'channel', CH)).rejects.toThrow();
    expect(store.getState().notificationPrefs.overrides[`channel:${CH}`]).toBe('mute');

    const ok = api();
    await clearNotificationLevel(store, ok, 'channel', CH);
    expect(ok.clearNotificationPreference).toHaveBeenCalledWith('channel', CH);
    expect(store.getState().notificationPrefs.overrides[`channel:${CH}`]).toBeUndefined();
  });

  it('clearing a target that already inherits says nothing to the server', async () => {
    const store = seededStore();
    const io = api();
    await clearNotificationLevel(store, io, 'channel', CH);
    expect(io.clearNotificationPreference).not.toHaveBeenCalled();
  });

  it('the broadcast switch is optimistic with rollback', async () => {
    const store = seededStore();
    const io = api({ setBroadcastSuppression: vi.fn(async () => Promise.reject(new Error('x'))) });
    await expect(setBroadcastSuppressed(store, io, WS, true)).rejects.toThrow();
    expect(store.getState().notificationPrefs.suppressBroadcasts[WS]).toBeUndefined();

    await setBroadcastSuppressed(store, api(), WS, true);
    expect(store.getState().notificationPrefs.suppressBroadcasts[WS]).toBe(true);
  });
});

describe('hydrate', () => {
  it('loads levels and switches, and marks the slice ready', async () => {
    const store = seededStore();
    await hydrateNotificationPreferences(
      store,
      api({
        getNotificationPreferences: vi.fn(async () => ({
          preferences: [{ scope: 'channel', entity_id: CH, level: 'mute' as const }],
          suppress_broadcasts: [WS],
        })),
      }),
    );
    const prefs = store.getState().notificationPrefs;
    expect(prefs.status).toBe('ready');
    expect(prefs.overrides).toEqual({ [`channel:${CH}`]: 'mute' });
    expect(prefs.suppressBroadcasts).toEqual({ [WS]: true });
  });

  it('a write that starts during the read wins over the read', async () => {
    const store = seededStore();
    const read = deferred<{ preferences: never[]; suppress_broadcasts: string[] }>();
    const hydrating = hydrateNotificationPreferences(store, api({ getNotificationPreferences: vi.fn(() => read.promise) }));

    await setNotificationLevel(store, api(), 'channel', CH, 'all');
    read.resolve({ preferences: [], suppress_broadcasts: [] });
    await hydrating;

    expect(store.getState().notificationPrefs.overrides[`channel:${CH}`]).toBe('all');
  });

  it('a failed read keeps what is shown and reports error', async () => {
    const store = seededStore();
    await hydrateNotificationPreferences(
      store,
      api({ getNotificationPreferences: vi.fn(async () => Promise.reject(new Error('down'))) }),
    );
    expect(store.getState().notificationPrefs.status).toBe('error');
  });

  it('logout clears the slice', async () => {
    const store = seededStore();
    await setNotificationLevel(store, api(), 'channel', CH, 'mute');
    resetForFreshSession(store);
    expect(store.getState().notificationPrefs.overrides).toEqual({});
  });
});

describe('the live mention badge honours broadcasts', () => {
  it('@everyone and @here count as mentions in a workspace channel', () => {
    const store = seededStore();
    send(store, '1000000000000301', '@everyone standup');
    send(store, '1000000000000302', '@here quick q');
    send(store, '1000000000000303', 'plain');
    expect(store.getState().unreadByChannel[CH]!.mention_count).toBe(2);
  });

  it('a suppressed workspace counts only direct mentions', async () => {
    const store = seededStore();
    await setBroadcastSuppressed(store, api(), WS, true);
    send(store, '1000000000000311', '@everyone standup');
    send(store, '1000000000000312', `@everyone and <@${ME}>`);
    expect(store.getState().unreadByChannel[CH]!.mention_count).toBe(1);
  });

  it('a bounded token only: @heretical is prose', () => {
    const store = seededStore();
    send(store, '1000000000000321', '@heretical idea');
    expect(store.getState().unreadByChannel[CH]!.mention_count).toBe(0);
  });

  it('a DM broadcast is not counted (the server records none)', () => {
    const state = seededStore().getState();
    expect(messageAddressesMe(state, { channel_id: DM, author_id: OTHER, content: '@everyone hi' })).toBe(false);
    expect(messageAddressesMe(state, { channel_id: DM, author_id: OTHER, content: `<@${ME}> hi` })).toBe(true);
  });

  it('never my own broadcast', () => {
    const state = seededStore().getState();
    expect(messageAddressesMe(state, { channel_id: CH, author_id: ME, content: '@everyone hi' })).toBe(false);
  });
});
