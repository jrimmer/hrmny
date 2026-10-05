/**
 * @cytale/tui — unread badges and read acknowledgement (U10; R22, R22a).
 *
 * The unit exists because of one measured bug: a badge derived from the
 * client's own loaded messages is ZERO for every channel the client has never
 * opened — and that is exactly the channel a column-one badge exists to
 * surface. So the assertions here are shaped around the two facts that fix it:
 *
 *   * the count comes from the server (`server_unread_count`, R22a), and a
 *     channel with NO message slice at all must still render it;
 *   * the watermark is persisted by the REST ack only (`POST
 *     /channels/{id}/ack`), which is what makes a mark-read in the terminal
 *     clear the badge in the browser client.
 *
 * The boundary is captured in the SELECTION HANDLER, one level up from the
 * message pane (`readState.markRead` reads the store at call time) — never in
 * the pane, whose own ack shape is recorded as measured-and-blocked upstream
 * because the ack effect clears the session-local slice before rows exist. The
 * landing-position test asserts the anchor and the row model, not merely that
 * rows still exist.
 *
 * The column is rendered directly (Ink's own frames, like `navigation.test.ts`)
 * because the badge is a rendered fact: a count that never reaches a cell is
 * not a badge. The store is the only data path, exactly as in the client.
 */
import { cleanup, render } from 'ink-testing-library';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import type { Channel, Message } from '@cytale/domain';
import type { GatewayEvent } from '@cytale/protocol';
import {
  applyGatewayEvent,
  createStateStore,
  type StateStore,
  type StateState,
  type UnreadState,
} from '@cytale/state';

import {
  NAVIGATION_READY,
  NavigationColumn,
  buildNavigationList,
  type NavigationList,
} from '../columns/NavigationColumn.js';
import { badgeText } from '../columns/UnreadBadge.js';
import { displayWidth } from '../format/markdown.js';
import {
  createReadState,
  readBadge,
  readBoundary,
  type ReadState,
  type ReadStateTransport,
} from '../session/readState.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORIGIN = 'https://chat.example.com';
const WORKSPACE = '100000000000000001';
const ME = '900000000000000001';
const OTHER = '900000000000000002';
/** A channel whose messages this client has LOADED. */
const CHANNEL = '300000000000000001';
/** A channel this client has never loaded a single message for (R22a). */
const NEVER_LOADED = '300000000000000002';
const DM = '400000000000000001';

// Equal-length decimal strings, so the store's length-then-lexicographic
// snowflake ordering is numeric here.
const M1 = '800000000000000001';
const M2 = '800000000000000002';
const M3 = '800000000000000003';
const M4 = '800000000000000004';

const ANSI = /\u001b\[[0-9;]*m/g;

function channel(overrides: Partial<Channel> & Pick<Channel, 'id' | 'name'>): Channel {
  return {
    workspace_id: WORKSPACE,
    type: 'text',
    topic: null,
    position: 0,
    last_message_id: null,
    created_at: '2026-09-13T10:00:00.000Z',
    ...overrides,
  };
}

function message(id: string, channelId: string, authorId = OTHER): Message {
  return {
    id,
    channel_id: channelId,
    thread_id: null,
    author_id: authorId,
    content: `line ${id}`,
    created_at: '2026-09-13T12:00:00.000Z',
    edited_at: null,
  };
}

/**
 * The membership graph U12's load writes: the workspace, both channels, the DM,
 * and the roster. A fresh READY wipes it (the store's transient reset), so the
 * reconnect test re-applies it the way the epoch re-run does.
 */
function graphFixture(): Partial<StateState> {
  return {
    workspaces: {
      [WORKSPACE]: {
        id: WORKSPACE,
        name: 'Acme',
        owner_id: ME,
        role_version: 1,
        created_at: '2026-09-13T09:00:00.000Z',
      },
    },
    channels: {
      [CHANNEL]: channel({ id: CHANNEL, name: 'general' }),
      [NEVER_LOADED]: channel({
        id: NEVER_LOADED,
        name: 'quiet',
        position: 1,
        last_message_id: M3,
      }),
      [DM]: channel({
        id: DM,
        name: 'dana',
        workspace_id: null,
        type: 'dm',
        recipients: [{ id: OTHER, username: 'dana' }],
      }),
    },
    memberIdsByWorkspace: { [WORKSPACE]: [ME, OTHER] },
    membersById: {
      [ME]: { id: ME, username: 'tester', nickname: null, joined_at: '', roles: [] },
      [OTHER]: { id: OTHER, username: 'dana', nickname: null, joined_at: '', roles: [] },
    },
  };
}

/**
 * A store holding everything the terminal would have hydrated: the graph, and a
 * loaded slice for `CHANNEL` only — `NEVER_LOADED` has no `messagesByChannel`
 * entry at all, which is the case R22a is about.
 */
function seedStore(overrides: Partial<StateState> = {}): StateStore {
  const store = createStateStore();
  store.setState({
    currentUser: { id: ME, username: 'tester' },
    ...graphFixture(),
    messagesByChannel: {
      // Newest first, the store's own order.
      [CHANNEL]: { items: [M3, M2, M1].map((id) => message(id, CHANNEL)), oldestId: M1, hasCompleteHistory: true },
    },
    unreadByChannel: {},
    ...overrides,
  });
  return store;
}

/** Write one channel's unread entry (what READ_STATE_SYNC folds in). */
function seedUnread(store: StateStore, channelId: string, entry: Partial<UnreadState>): void {
  store.setState((s) => ({
    unreadByChannel: {
      ...s.unreadByChannel,
      [channelId]: { last_read_id: null, unread_count: 0, mention_count: 0, ...entry },
    },
  }));
}

let seq = 0;
function dispatch(t: string, d: unknown): GatewayEvent {
  seq += 1;
  return { op: 0, t, s: seq, d } as unknown as GatewayEvent;
}

/** The read-state sync the server emits on every session establishment. */
function syncReadState(
  store: StateStore,
  channelId: string,
  entry: { last_read_id: string | null; unread_floor?: string | null; unread_count?: number },
): void {
  applyGatewayEvent(store, dispatch('ReadStateSync', { channels: [{ channel_id: channelId, ...entry }] }));
}

/** The two intents the terminal's transport must be able to carry. */
function fakeTransport(
  options: { failAck?: boolean; failFloor?: boolean; noFloor?: boolean } = {},
): {
  transport: ReadStateTransport;
  acks: { channelId: string; messageId: string }[];
  floors: { channelId: string; message_ids: readonly string[]; unread_floor: string }[];
} {
  const acks: { channelId: string; messageId: string }[] = [];
  const floors: { channelId: string; message_ids: readonly string[]; unread_floor: string }[] = [];
  const transport: ReadStateTransport = {
    async ack(channelId, messageId) {
      if (options.failAck === true) throw new Error('offline');
      acks.push({ channelId, messageId });
    },
    ...(options.noFloor === true
      ? {}
      : {
          async setUnreadFloor(channelId, body) {
            if (options.failFloor === true) throw new Error('offline');
            floors.push({ channelId, ...body });
          },
        }),
  };
  return { transport, acks, floors };
}

function readStateFor(
  store: StateStore,
  options: Parameters<typeof fakeTransport>[0] = {},
): { readState: ReadState; acks: { channelId: string; messageId: string }[]; floors: { channelId: string; message_ids: readonly string[]; unread_floor: string }[] } {
  const fake = fakeTransport(options);
  return { readState: createReadState({ store, transport: fake.transport }), acks: fake.acks, floors: fake.floors };
}

// ---------------------------------------------------------------------------
// Rendering column one
// ---------------------------------------------------------------------------

const COLUMN_WIDTH = 42;

/** Column one's list for the store, with the badge source the shell wires. */
function listFor(store: StateStore, mode: 'channels' | 'dms' = 'channels'): NavigationList {
  const state = store.getState();
  const workspaces = Object.values(state.workspaces);
  return buildNavigationList({
    mode,
    source: state,
    activeWorkspaceId: workspaces[0]?.id ?? null,
    viewerId: state.currentUser?.id ?? null,
    origin: ORIGIN,
    unreadCount: (channelId) => readBadge(store, channelId),
  });
}

function draw(list: NavigationList, width = COLUMN_WIDTH): string[] {
  const instance = render(
    createElement(NavigationColumn, {
      mode: 'channels',
      workspaceName: 'Acme',
      focused: true,
      list,
      selectedIndex: 0,
      status: NAVIGATION_READY,
      width,
      height: 14,
      presenceLink: 'live',
    }),
  );
  return (instance.lastFrame() ?? '')
    .split('\n')
    .map((line) => line.replace(ANSI, '').trimEnd());
}

const rowFor = (lines: readonly string[], label: string): string =>
  lines.find((line) => line.includes(label)) ?? '';

/** The rows as ids, so a badge cannot additive-shift what the selection indexes. */
const shape = (list: NavigationList): string[] =>
  list.rows.map((row) => (row.kind === 'header' ? `header:${row.label}` : `${row.kind}:${row.id}`));

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// R22a: the count comes from the server
// ---------------------------------------------------------------------------

describe('the unread count comes from the server', () => {
  it('renders the server-supplied count for a channel the client has never loaded', () => {
    const store = seedStore();
    // No slice for this channel — and the local accrual is zero, because no
    // gateway traffic has been seen on it either. The server's count is the
    // only thing that can produce a badge here.
    syncReadState(store, NEVER_LOADED, { last_read_id: null, unread_floor: null, unread_count: 9 });

    expect(store.getState().messagesByChannel[NEVER_LOADED]).toBeUndefined();
    expect(store.getState().unreadByChannel[NEVER_LOADED]!.unread_count).toBe(0);
    expect(readBadge(store, NEVER_LOADED)).toBe(9);

    const row = rowFor(draw(listFor(store)), '#quiet');
    expect(row).toContain('(9)');
  });

  it('prefers the server count over a locally accrued one for an unloaded channel', () => {
    const store = seedStore();
    seedUnread(store, NEVER_LOADED, { last_read_id: null, unread_count: 2 });

    syncReadState(store, NEVER_LOADED, { last_read_id: null, unread_floor: null, unread_count: 9 });

    expect(readBadge(store, NEVER_LOADED)).toBe(9);
  });

  it('falls back to the local accrual — never to zero — when the server reported no count', () => {
    const store = seedStore();
    seedUnread(store, NEVER_LOADED, { last_read_id: null, unread_count: 2 });

    // An older server: the entry carries a watermark and no count at all.
    syncReadState(store, NEVER_LOADED, { last_read_id: null, unread_floor: null });

    expect(readBadge(store, NEVER_LOADED)).toBe(2);
  });

  it('renders no badge for a channel that is already read', () => {
    const store = seedStore();
    syncReadState(store, CHANNEL, { last_read_id: M3, unread_floor: null, unread_count: 0 });

    expect(readBadge(store, CHANNEL)).toBe(0);
    expect(rowFor(draw(listFor(store)), '#general')).not.toContain('(');
  });

  it('renders no badge for a channel with zero messages', () => {
    const store = seedStore({
      messagesByChannel: {
        [CHANNEL]: { items: [], oldestId: null, hasCompleteHistory: true },
      },
    });
    // The server's own answer for a channel with nothing in the counted window.
    syncReadState(store, CHANNEL, { last_read_id: null, unread_floor: null, unread_count: 0 });

    expect(readBadge(store, CHANNEL)).toBe(0);
    expect(rowFor(draw(listFor(store)), '#general')).not.toContain('(');
  });

  it('renders the badge on a DM row too — a DM is a channel in the store', () => {
    const store = seedStore();
    syncReadState(store, DM, { last_read_id: null, unread_floor: null, unread_count: 3 });

    const row = rowFor(draw(listFor(store, 'dms')), 'dana');
    expect(row).toContain('(3)');
  });

  it('renders no badge before the server’s read state arrives, then the server’s count', () => {
    const store = seedStore();
    // The client is connected but the establishment sync has not landed: no
    // unread entry exists, so there is no badge — the client does not yet know
    // about unread work rather than knowing there is none.
    expect(store.getState().unreadByChannel[NEVER_LOADED]).toBeUndefined();
    expect(readBadge(store, NEVER_LOADED)).toBe(0);
    expect(rowFor(draw(listFor(store)), '#quiet')).not.toContain('(');

    syncReadState(store, NEVER_LOADED, { last_read_id: null, unread_floor: null, unread_count: 4 });

    // The badge arrives on the dispatch itself — no fetch for this module to own.
    expect(rowFor(draw(listFor(store)), '#quiet')).toContain('(4)');
  });

  it('derives a loaded channel from its live slice, not from a stale server count', () => {
    const store = seedStore();
    // The watermark says M1: M2 and M3 are unread in the loaded slice, which is
    // authoritative for a channel the client holds rows for.
    syncReadState(store, CHANNEL, { last_read_id: M1, unread_floor: null, unread_count: 99 });

    expect(readBadge(store, CHANNEL)).toBe(2);
    expect(rowFor(draw(listFor(store)), '#general')).toContain('(2)');
  });
});

// ---------------------------------------------------------------------------
// R22: acknowledgement — the REST path, driven from the selection handler
// ---------------------------------------------------------------------------

describe('acknowledging a focused channel', () => {
  it('persists the watermark through the REST ack and clears the badge', async () => {
    const store = seedStore();
    syncReadState(store, CHANNEL, { last_read_id: M1, unread_floor: null, unread_count: 2 });
    const { readState, acks } = readStateFor(store);

    const outcome = await readState.markRead(CHANNEL);

    // The boundary the handler captured is the newest SERVER row it can see.
    expect(outcome).toEqual({ status: 'read', channelId: CHANNEL, boundary: M3 });
    expect(acks).toEqual([{ channelId: CHANNEL, messageId: M3 }]);
    expect(readBadge(store, CHANNEL)).toBe(0);
    expect(rowFor(draw(listFor(store)), '#general')).not.toContain('(');
  });

  it('acknowledges an unloaded channel at the boundary its own record supplies', async () => {
    const store = seedStore();
    syncReadState(store, NEVER_LOADED, { last_read_id: null, unread_floor: null, unread_count: 9 });
    const { readState, acks } = readStateFor(store);

    // No slice: the channel record's server-supplied `last_message_id` is the
    // only boundary there is, and it is what makes opening the channel clear
    // the badge the server reported for it.
    expect(readBoundary(store, NEVER_LOADED)).toBe(M3);
    const outcome = await readState.markRead(NEVER_LOADED);

    expect(outcome).toEqual({ status: 'read', channelId: NEVER_LOADED, boundary: M3 });
    expect(acks).toEqual([{ channelId: NEVER_LOADED, messageId: M3 }]);
    expect(readBadge(store, NEVER_LOADED)).toBe(0);
    expect(rowFor(draw(listFor(store)), '#quiet')).not.toContain('(');
  });

  it('makes no request for a channel with no messages to acknowledge', async () => {
    const store = seedStore({
      channels: { [CHANNEL]: channel({ id: CHANNEL, name: 'general' }) },
      messagesByChannel: { [CHANNEL]: { items: [], oldestId: null, hasCompleteHistory: true } },
    });
    const { readState, acks } = readStateFor(store);

    expect(await readState.markRead(CHANNEL)).toEqual({ status: 'no-boundary', channelId: CHANNEL });
    // A body with an empty `message_ids` would 400 at the server's own guard;
    // nothing is sent instead.
    expect(acks).toEqual([]);
  });

  it('makes no request for a channel the store already shows as read', async () => {
    const store = seedStore();
    syncReadState(store, CHANNEL, { last_read_id: M3, unread_floor: null, unread_count: 0 });
    const { readState, acks } = readStateFor(store);

    expect(await readState.markRead(CHANNEL)).toEqual({
      status: 'already-read',
      channelId: CHANNEL,
      boundary: M3,
    });
    expect(acks).toEqual([]);
  });

  it('skips the optimistic placeholder a send leaves in the slice', async () => {
    const store = seedStore({
      messagesByChannel: {
        [CHANNEL]: {
          items: [message('pending_abc', CHANNEL, ME), message(M3, CHANNEL), message(M2, CHANNEL)],
          oldestId: M2,
          hasCompleteHistory: false,
        },
      },
    });
    const { readState, acks } = readStateFor(store);

    const outcome = await readState.markRead(CHANNEL);

    // The placeholder is not a message id on the wire; the newest REAL row is.
    expect(outcome).toEqual({ status: 'read', channelId: CHANNEL, boundary: M3 });
    expect(acks).toEqual([{ channelId: CHANNEL, messageId: M3 }]);
  });

  it('captures the boundary at call time, not when a later page lands', async () => {
    const store = seedStore();
    syncReadState(store, CHANNEL, { last_read_id: M1, unread_floor: null, unread_count: 2 });
    const { readState, acks } = readStateFor(store);

    const pending = readState.markRead(CHANNEL);
    // A newer message lands while the ack is in flight. The request already
    // carries the boundary captured in the handler, so it cannot acknowledge a
    // message the member was never shown.
    applyGatewayEvent(
      store,
      dispatch('MessageCreate', {
        id: M4,
        channel_id: CHANNEL,
        thread_id: null,
        author_id: OTHER,
        content: 'after the ack',
        created_at: '2026-09-13T12:05:00.000Z',
        edited_at: null,
      }),
    );
    await pending;

    expect(acks).toEqual([{ channelId: CHANNEL, messageId: M3 }]);
    // And the newer message is unread, honestly: the member has not read it.
    expect(readBadge(store, CHANNEL)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Error and offline paths: nothing is cleared that the server did not take
// ---------------------------------------------------------------------------

describe('a failed acknowledgement', () => {
  it('leaves the badge in place rather than optimistically clearing it', async () => {
    const store = seedStore();
    syncReadState(store, CHANNEL, { last_read_id: M1, unread_floor: null, unread_count: 2 });
    const before = store.getState().unreadByChannel[CHANNEL];
    const { readState } = readStateFor(store, { failAck: true });

    const outcome = await readState.markRead(CHANNEL);

    expect(outcome.status).toBe('failed');
    // The badge is UNCHANGED — the same count, and the same watermark behind it.
    expect(readBadge(store, CHANNEL)).toBe(2);
    expect(store.getState().unreadByChannel[CHANNEL]).toBe(before);
    expect(rowFor(draw(listFor(store)), '#general')).toContain('(2)');
  });

  it('leaves an unloaded channel’s server count in place when the ack fails', async () => {
    const store = seedStore();
    syncReadState(store, NEVER_LOADED, { last_read_id: null, unread_floor: null, unread_count: 9 });
    const { readState } = readStateFor(store, { failAck: true });

    await readState.markRead(NEVER_LOADED);

    expect(readBadge(store, NEVER_LOADED)).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// R22: marking an individual message unread — the exclusive floor
// ---------------------------------------------------------------------------

describe('marking a message unread', () => {
  it('sets the floor at that message, and the badge counts it and everything newer', async () => {
    const store = seedStore();
    syncReadState(store, CHANNEL, { last_read_id: M3, unread_floor: null, unread_count: 0 });
    expect(readBadge(store, CHANNEL)).toBe(0);
    const { readState, floors } = readStateFor(store);

    const outcome = await readState.markUnread(CHANNEL, M2);

    expect(outcome).toEqual({ status: 'unread', channelId: CHANNEL, floor: M2 });
    // The floor travels with a watermark that is NOT moved backwards: M3 is
    // still read, and the floor is what makes M2 and M3 unread again.
    expect(floors).toEqual([{ channelId: CHANNEL, message_ids: [M3], unread_floor: M2 }]);
    expect(store.getState().unreadByChannel[CHANNEL]!.unread_floor).toBe(M2);
    expect(readBadge(store, CHANNEL)).toBe(2);
    expect(rowFor(draw(listFor(store)), '#general')).toContain('(2)');
  });

  it('leaves the floor out of the ack path: a later focus does not clear it', async () => {
    const store = seedStore();
    syncReadState(store, CHANNEL, { last_read_id: M3, unread_floor: M2, unread_count: 2 });
    const { readState } = readStateFor(store);

    // The server's own ack path skips the floor column for exactly this reason
    // (`Cytale.Messages.ReadState`'s partial-write rule), and the client's local
    // clear has to agree with it: the member said "this is unread".
    await readState.markRead(CHANNEL);

    expect(store.getState().unreadByChannel[CHANNEL]!.last_read_id).toBe(M3);
    expect(store.getState().unreadByChannel[CHANNEL]!.unread_floor).toBe(M2);
    expect(readBadge(store, CHANNEL)).toBe(2);
    expect(rowFor(draw(listFor(store)), '#general')).toContain('(2)');
  });

  it('leaves the previous state when the floor write fails', async () => {
    const store = seedStore();
    syncReadState(store, CHANNEL, { last_read_id: M3, unread_floor: null, unread_count: 0 });
    const before = store.getState().unreadByChannel[CHANNEL];
    const { readState } = readStateFor(store, { failFloor: true });

    const outcome = await readState.markUnread(CHANNEL, M2);

    expect(outcome.status).toBe('failed');
    // No floor the server does not have, and no badge it would imply.
    expect(store.getState().unreadByChannel[CHANNEL]).toBe(before);
    expect(store.getState().unreadByChannel[CHANNEL]!.unread_floor).toBeNull();
    expect(readBadge(store, CHANNEL)).toBe(0);
  });

  it('writes nothing when the transport cannot carry a floor at all', async () => {
    const store = seedStore();
    syncReadState(store, CHANNEL, { last_read_id: M3, unread_floor: null, unread_count: 0 });
    const { readState } = readStateFor(store, { noFloor: true });

    const outcome = await readState.markUnread(CHANNEL, M2);

    // The honest degradation: the api-client has no method that sends the
    // floor body yet, so the state is left as the server last reported it.
    expect(outcome).toEqual({ status: 'unsupported', channelId: CHANNEL, floor: M2 });
    expect(store.getState().unreadByChannel[CHANNEL]!.unread_floor).toBeNull();
    expect(readBadge(store, CHANNEL)).toBe(0);
  });

  it('refuses an optimistic placeholder, which is not a message id', async () => {
    const store = seedStore();
    const { readState, floors } = readStateFor(store);

    const outcome = await readState.markUnread(CHANNEL, 'pending_abc');

    expect(outcome).toEqual({ status: 'not-a-message', channelId: CHANNEL, floor: 'pending_abc' });
    expect(floors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Reconnect: the badge is re-hydrated from the server, not from local slices
// ---------------------------------------------------------------------------

describe('a reconnect', () => {
  it('keeps both badges through a fresh READY, and re-hydrates them from the server', () => {
    const store = seedStore();
    syncReadState(store, CHANNEL, { last_read_id: M1, unread_floor: null, unread_count: 2 });
    syncReadState(store, NEVER_LOADED, { last_read_id: null, unread_floor: null, unread_count: 9 });
    expect(readBadge(store, CHANNEL)).toBe(2);
    expect(readBadge(store, NEVER_LOADED)).toBe(9);

    // A fresh session resets SESSION state only (lane D #1): the badges and
    // the graph stay as they were — wiping them made every reconnect blank
    // the column — until the server's sync replaces them.
    applyGatewayEvent(store, dispatch('Ready', { user: { id: ME, username: 'tester' }, session_id: 's1' }));
    expect(readBadge(store, CHANNEL)).toBe(2);
    expect(readBadge(store, NEVER_LOADED)).toBe(9);

    // …and the graph the epoch re-run writes comes back with it (U12), so the
    // rows the badges are drawn on exist again.
    store.setState(graphFixture());

    // The read-state sync the server sends on establishment refills the badges
    // from ITS OWN rows — a channel the client has loaded nothing for included.
    syncReadState(store, CHANNEL, { last_read_id: M1, unread_floor: null, unread_count: 2 });
    syncReadState(store, NEVER_LOADED, { last_read_id: null, unread_floor: null, unread_count: 9 });

    expect(readBadge(store, CHANNEL)).toBe(2);
    expect(readBadge(store, NEVER_LOADED)).toBe(9);
    expect(rowFor(draw(listFor(store)), '#quiet')).toContain('(9)');
  });
});

// ---------------------------------------------------------------------------
// The landing position (step 3's measured hazard) and the row model
// ---------------------------------------------------------------------------

describe('the landing position survives the focus ack', () => {
  it('does not touch the message slice, the anchor, or the row model', async () => {
    const store = seedStore();
    syncReadState(store, CHANNEL, { last_read_id: M1, unread_floor: null, unread_count: 2 });
    const slice = store.getState().messagesByChannel[CHANNEL];
    const anchor = slice!.items[0]!.id;
    const before = listFor(store);
    const beforeSelection = before.selectableIds[0];
    const { readState } = readStateFor(store);

    await readState.markRead(CHANNEL);

    // The landing is the pane's anchored row — the newest loaded message — and
    // it is still exactly where it was, at the same index, in the same slice.
    expect(store.getState().messagesByChannel[CHANNEL]).toBe(slice);
    expect(store.getState().messagesByChannel[CHANNEL]!.items[0]!.id).toBe(anchor);

    // The selection is index-based, so the badge must not add or remove a row:
    // the same ids in the same order, and the same row still selected.
    const after = listFor(store);
    expect(shape(after)).toEqual(shape(before));
    expect(after.selectableIds).toEqual(before.selectableIds);
    expect(after.selectableIds[0]).toBe(beforeSelection);
    expect(after.selectableIds[0]).toBe(CHANNEL);
    // And it is the same row that is drawn as selected, just without the badge.
    const lines = draw(after);
    expect(rowFor(lines, '#general')).toContain('▸');
    expect(rowFor(lines, '#general')).not.toContain('(');
  });

  it('renders the same rows with and without badges, so clearing one cannot shift the cursor', () => {
    const unread = seedStore();
    syncReadState(unread, CHANNEL, { last_read_id: M1, unread_floor: null, unread_count: 2 });
    const read = seedStore();
    syncReadState(read, CHANNEL, { last_read_id: M3, unread_floor: null, unread_count: 0 });

    expect(shape(listFor(unread))).toEqual(shape(listFor(read)));
    expect(listFor(unread).selectableIds).toEqual(listFor(read).selectableIds);
  });
});

// ---------------------------------------------------------------------------
// The width budget: a badge consumes cells, so it is reserved inside them
// ---------------------------------------------------------------------------

describe('the badge and column one’s width budget', () => {
  it('keeps the badge on the row when the channel name is longer than the column', () => {
    const width = 24;
    const store = seedStore({
      channels: {
        [CHANNEL]: channel({ id: CHANNEL, name: 'a-very-long-channel-name-that-overflows' }),
      },
    });
    syncReadState(store, CHANNEL, { last_read_id: M1, unread_floor: null, unread_count: 2 });

    const lines = draw(listFor(store), width);
    const row = lines.find((line) => line.includes('(2)')) ?? '';

    // The count is the point of the unit, so it is reserved and the name is
    // what gives way.
    expect(row).toContain('(2)');
    expect(row).toContain('a-very-long');
    expect(displayWidth(row)).toBeLessThanOrEqual(width);
  });

  it('renders nothing for a zero count', () => {
    expect(badgeText(0)).toBe('');
    expect(badgeText(3)).toBe(' (3)');
  });
});

// ---------------------------------------------------------------------------
// Integration: the ack is what the OTHER client reads
// ---------------------------------------------------------------------------

describe('marking a channel read in the terminal clears the badge in the browser', () => {
  it('persists a watermark the browser’s read-state sync reports as read', async () => {
    // Two clients over one server. Both hold the same loaded slice and the same
    // stale watermark: the browser still shows 2 unread.
    const terminal = seedStore();
    const browser = seedStore();
    for (const store of [terminal, browser]) {
      syncReadState(store, CHANNEL, { last_read_id: M1, unread_floor: null, unread_count: 2 });
    }
    expect(readBadge(browser, CHANNEL)).toBe(2);

    const { readState, acks } = readStateFor(terminal);
    await readState.markRead(CHANNEL);
    expect(acks).toEqual([{ channelId: CHANNEL, messageId: M3 }]);

    // The read-state sync the server builds FROM ITS OWN read_state row — the
    // row the REST ack above persisted — is what the browser receives. (The
    // round trip itself is the server suite's and U28's; what this unit owns is
    // that the persisted watermark is the shared source, not a local badge.)
    syncReadState(browser, CHANNEL, { last_read_id: M3, unread_floor: null, unread_count: 0 });

    expect(readBadge(browser, CHANNEL)).toBe(0);
  });
});
