/**
 * @cytale/state — entity roster hydration (lane D #1 / #5).
 *
 * Boot used to be a wipe-then-refill: READY cleared every entity slice
 * (workspaces, channels, members, threads, messages) and the web shell then
 * refilled them over REST in ~3 + 2W + C separate store writes — each one a
 * notification, and the first one leaving the shell with an EMPTY roster
 * (the Home flash, the sidebar skeleton, the remounted panes).
 *
 * The rule now: stale data stays on screen until its replacement is complete,
 * and each slice is swapped in ONE commit. A roster is built into local maps
 * first (from READY, or from the REST fallback) and then REPLACES the slice —
 * replace, not merge, so a workspace the member left or a channel that was
 * deleted while this client was away actually disappears.
 *
 * Row identity is preserved where nothing changed: a reconnect that re-reads
 * the same roster hands back the SAME record objects (and, when every row is
 * unchanged, the same map), so identity-keyed consumers (`useStableChannelList`,
 * memoized rows) do not re-render for a roster that did not move.
 */

import { compareSnowflakes, normalizeChannelType } from '@cytale/domain';
import type { Channel, Thread, Workspace, WorkspaceMember } from '@cytale/domain';
import type { Ready, ReadyChannel, ReadyDmChannel, ReadyWorkspace, Snowflake } from '@cytale/protocol';
import { globalRow, withNickname } from './nicknames.js';

import { setStateIfChanged, type StateState, type StateStore } from './store.js';

/** A complete entity roster, as READY or the REST fallback delivers it. */
export interface Roster {
  workspaces: Workspace[];
  /** Workspace channels (categories included). */
  channels: Channel[];
  /**
   * The member's DM channels, or null when this source did not provide them
   * (an older server's READY, or a failed DM read) — the DM rows already in
   * the store are then KEPT rather than cleared.
   */
  dmChannels: Channel[] | null;
}

// ---------------------------------------------------------------------------
// Wire → domain (the REST boundary's own normalization, for READY rows)
// ---------------------------------------------------------------------------

/**
 * A READY channel row → the domain Channel the REST reader produces
 * (`CytaleApiClient#normalizeChannel`: the server's type column becomes the
 * string union, `parent_id` normalizes to `string | null`). Kept field-for-field
 * with that reader so a READY-hydrated row and a REST-hydrated row compare equal.
 */
export function channelFromReady(row: ReadyChannel): Channel {
  return {
    ...(row as unknown as Channel),
    type: normalizeChannelType(row.type),
    parent_id: row.parent_id ?? null,
  };
}

/** A READY DM row → the domain Channel (`CytaleApiClient#normalizeDmChannel`). */
export function dmChannelFromReady(row: ReadyDmChannel): Channel {
  const raw = row as unknown as Channel;
  return {
    ...raw,
    type: 'dm',
    workspace_id: raw.workspace_id ?? null,
    name: raw.name ?? '',
    parent_id: raw.parent_id ?? null,
  };
}

/** A READY workspace row → the domain Workspace (the REST reader passes it through). */
export function workspaceFromReady(row: ReadyWorkspace): Workspace {
  return row as unknown as Workspace;
}

/**
 * The roster a READY carries, or null when it carries none (an older server,
 * or a compat-shaped frame): the caller then hydrates over REST.
 */
export function rosterFromReady(ready: Ready): Roster | null {
  if (!Array.isArray(ready.workspaces) || !Array.isArray(ready.channels)) return null;
  return {
    workspaces: ready.workspaces.map(workspaceFromReady),
    channels: ready.channels.map(channelFromReady),
    dmChannels: Array.isArray(ready.dm_channels) ? ready.dm_channels.map(dmChannelFromReady) : null,
  };
}

// ---------------------------------------------------------------------------
// Identity-preserving replacement
// ---------------------------------------------------------------------------

function shallowEqualRecord(a: object, b: object): boolean {
  if (a === b) return true;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const ka = Object.keys(ra);
  if (ka.length !== Object.keys(rb).length) return false;
  for (const k of ka) {
    const va = ra[k];
    const vb = rb[k];
    if (Object.is(va, vb)) continue;
    // One level of structure (DM `recipients`, member `roles`): compare the
    // arrays' elements shallowly rather than by reference.
    if (Array.isArray(va) && Array.isArray(vb)) {
      if (va.length !== vb.length) return false;
      for (let i = 0; i < va.length; i++) {
        const x = va[i];
        const y = vb[i];
        if (Object.is(x, y)) continue;
        if (typeof x !== 'object' || typeof y !== 'object' || x === null || y === null) return false;
        if (!shallowEqualRecord(x, y)) return false;
      }
      continue;
    }
    return false;
  }
  return true;
}

/**
 * Build `next` as a record map, reusing `prev`'s row objects that did not
 * change and `prev` itself when nothing did (same keys, same rows).
 */
export function replaceRecordMap<T extends object>(
  prev: Record<string, T>,
  entries: Iterable<readonly [string, T]>,
): Record<string, T> {
  const next: Record<string, T> = {};
  let changed = false;
  let count = 0;
  for (const [id, row] of entries) {
    const old = prev[id];
    if (old !== undefined && shallowEqualRecord(old, row)) {
      next[id] = old;
    } else {
      next[id] = row;
      changed = true;
    }
    count += 1;
  }
  if (!changed && count === Object.keys(prev).length) return prev;
  return next;
}

function sameIds(a: readonly string[] | undefined, b: readonly string[]): boolean {
  if (a === undefined || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------------------------------------------------------------------------
// The patches
// ---------------------------------------------------------------------------

/**
 * The partial a roster replacement writes: `workspaces` and `channels`
 * REPLACED (DM rows kept when the roster has none), plus the per-channel and
 * per-workspace slices of anything that disappeared dropped with it — a
 * deleted channel's messages and threads, a left workspace's member index.
 */
export function rosterPatch(state: StateState, roster: Roster): Partial<StateState> {
  const workspaces = replaceRecordMap(
    state.workspaces,
    roster.workspaces.map((w) => [w.id, w] as const),
  );

  const channelEntries: (readonly [string, Channel])[] = roster.channels.map((c) => [c.id, c] as const);
  if (roster.dmChannels !== null) {
    for (const dm of roster.dmChannels) channelEntries.push([dm.id, dm] as const);
  } else {
    for (const ch of Object.values(state.channels)) {
      if (ch.type === 'dm') channelEntries.push([ch.id, ch] as const);
    }
  }
  const channels = replaceRecordMap(state.channels, channelEntries);

  const patch: Partial<StateState> = { workspaces, channels, rosterSource: 'server' };

  // Drop what the roster no longer contains. Every map is copied only when
  // something actually goes, so an unchanged reconnect writes nothing extra.
  if (channels !== state.channels) {
    const gone = Object.keys(state.channels).filter((id) => channels[id] === undefined);
    if (gone.length > 0) {
      const messagesByChannel = { ...state.messagesByChannel };
      const threadIdsByChannel = { ...state.threadIdsByChannel };
      const unreadByChannel = { ...state.unreadByChannel };
      const lastMessageIdByChannel = { ...state.lastMessageIdByChannel };
      for (const id of gone) {
        delete messagesByChannel[id];
        delete threadIdsByChannel[id];
        delete unreadByChannel[id];
        delete lastMessageIdByChannel[id];
      }
      patch.messagesByChannel = messagesByChannel;
      patch.threadIdsByChannel = threadIdsByChannel;
      patch.unreadByChannel = unreadByChannel;
      patch.lastMessageIdByChannel = lastMessageIdByChannel;
      patch.recentChannelIds = state.recentChannelIds.filter((id) => channels[id] !== undefined);
    }
  }
  if (workspaces !== state.workspaces) {
    const goneWs = Object.keys(state.memberIdsByWorkspace).filter((id) => workspaces[id] === undefined);
    if (goneWs.length > 0) {
      const memberIdsByWorkspace = { ...state.memberIdsByWorkspace };
      for (const id of goneWs) delete memberIdsByWorkspace[id];
      patch.memberIdsByWorkspace = memberIdsByWorkspace;
    }
  }
  return patch;
}

/** Replace the entity roster in ONE store write (the REST fallback's path). */
export function replaceRoster(store: StateStore, roster: Roster): void {
  setStateIfChanged(store, (s) => rosterPatch(s, roster));
}

/**
 * Replace the thread rosters of the given channels in ONE write. Channels
 * absent from `byChannel` keep what they had (a failed per-channel read must
 * not clear its rows); a channel present with `[]` has none.
 */
export function replaceThreads(store: StateStore, byChannel: Record<Snowflake, Thread[]>): void {
  setStateIfChanged(store, (s) => {
    let threadsById = s.threadsById;
    let threadIdsByChannel = s.threadIdsByChannel;
    for (const [channelId, threads] of Object.entries(byChannel)) {
      const ids = threads.map((t) => t.id);
      // Threads that left this channel's roster (deleted/archived away).
      const previous = s.threadIdsByChannel[channelId] ?? [];
      for (const oldId of previous) {
        if (ids.includes(oldId)) continue;
        if (threadsById === s.threadsById) threadsById = { ...s.threadsById };
        delete threadsById[oldId];
      }
      for (const t of threads) {
        const old = threadsById[t.id];
        // A live reply may have bumped the activity fields past the REST
        // reading; the fresher of the two wins so a boot read never rewinds it.
        const merged =
          old !== undefined && (old.latest_reply_at ?? '') > (t.latest_reply_at ?? '')
            ? { ...t, message_count: old.message_count, latest_reply_at: old.latest_reply_at }
            : t;
        if (old !== undefined && shallowEqualRecord(old, merged)) continue;
        if (threadsById === s.threadsById) threadsById = { ...s.threadsById };
        threadsById[t.id] = merged;
      }
      if (!sameIds(s.threadIdsByChannel[channelId], ids)) {
        if (threadIdsByChannel === s.threadIdsByChannel) threadIdsByChannel = { ...s.threadIdsByChannel };
        threadIdsByChannel[channelId] = ids;
      }
    }
    return { threadsById, threadIdsByChannel };
  });
}

/**
 * Replace the member rosters of the given workspaces in ONE write. A member
 * row is shared across workspaces (`membersById` is global), so rows are
 * upserted and only the per-workspace index is replaced.
 *
 * `partial` names the workspaces whose list is ONE PAGE of a longer roster
 * (the people read answered with a `next_before` cursor). A page cannot say
 * that someone beyond it left, so for those workspaces the ids this client
 * already knew BEYOND the page — members named on demand (`mergeMembers`,
 * the member resolver) — are kept after the page's ids. What the page CAN
 * prove gone still goes: a person inside the page's id range that the page
 * no longer lists, and a machine whose owner the page lists without it.
 */
export function replaceMembers(
  store: StateStore,
  byWorkspace: Record<Snowflake, WorkspaceMember[]>,
  partial: ReadonlySet<Snowflake> = new Set(),
): void {
  setStateIfChanged(store, (s) => {
    let membersById = s.membersById;
    let memberIdsByWorkspace = s.memberIdsByWorkspace;
    let nicknamesByWorkspace = s.nicknamesByWorkspace;
    for (const [workspaceId, members] of Object.entries(byWorkspace)) {
      for (const m of members) {
        // The row is shared across workspaces; its nickname is this one's (#169).
        nicknamesByWorkspace = withNickname(nicknamesByWorkspace, workspaceId, m.id, m.nickname);
        const row = globalRow(m);
        const old = membersById[m.id];
        if (old !== undefined && shallowEqualRecord(old, row)) continue;
        if (membersById === s.membersById) membersById = { ...s.membersById };
        membersById[m.id] = row;
      }
      let ids = members.map((m) => m.id);
      if (partial.has(workspaceId)) {
        ids = ids.concat(beyondPage(s.memberIdsByWorkspace[workspaceId], members, membersById));
      }
      // A full roster speaks for every nickname in the workspace: drop the
      // ones for members it no longer lists.
      const kept = new Set(ids);
      for (const id of Object.keys(nicknamesByWorkspace[workspaceId] ?? {})) {
        if (!kept.has(id)) nicknamesByWorkspace = withNickname(nicknamesByWorkspace, workspaceId, id, null);
      }
      if (!sameIds(s.memberIdsByWorkspace[workspaceId], ids)) {
        if (memberIdsByWorkspace === s.memberIdsByWorkspace) {
          memberIdsByWorkspace = { ...s.memberIdsByWorkspace };
        }
        memberIdsByWorkspace[workspaceId] = ids;
      }
    }
    return { membersById, memberIdsByWorkspace, nicknamesByWorkspace };
  });
}

/**
 * The previously listed ids a partial page does not speak for. The page is
 * the HIGHEST person ids (user_id descending) plus their machines, so a
 * person with an id at or above the page's lowest one is inside its range —
 * absent means gone — and a machine whose owner is on the page would have
 * been listed with them if it still belonged.
 */
function beyondPage(
  previous: readonly Snowflake[] | undefined,
  page: readonly WorkspaceMember[],
  membersById: Readonly<Record<Snowflake, WorkspaceMember>>,
): Snowflake[] {
  if (previous === undefined || previous.length === 0) return [];
  const onPage = new Set(page.map((m) => m.id));
  let floor: Snowflake | null = null;
  for (const m of page) {
    if (m.parent_user_id) continue;
    if (floor === null || compareSnowflakes(m.id, floor) < 0) floor = m.id;
  }
  return previous.filter((id) => {
    if (onPage.has(id)) return false;
    const row = membersById[id];
    if (row === undefined) return false;
    if (row.parent_user_id) return !onPage.has(row.parent_user_id);
    return floor === null || compareSnowflakes(id, floor) < 0;
  });
}

/**
 * Add members named on demand (the member resolver's lookups) to a
 * workspace's roster in ONE write: rows upserted into `membersById`, ids
 * appended to the workspace's list when absent. Never removes anything —
 * departures arrive as `MemberRemove`, and a reconnect's page read
 * (`replaceMembers`, partial) keeps these rows.
 */
export function mergeMembers(
  store: StateStore,
  workspaceId: Snowflake,
  members: readonly WorkspaceMember[],
): void {
  if (members.length === 0) return;
  setStateIfChanged(store, (s) => {
    let membersById = s.membersById;
    let nicknamesByWorkspace = s.nicknamesByWorkspace;
    for (const m of members) {
      nicknamesByWorkspace = withNickname(nicknamesByWorkspace, workspaceId, m.id, m.nickname);
      const row = globalRow(m);
      const old = membersById[m.id];
      if (old !== undefined && shallowEqualRecord(old, row)) continue;
      if (membersById === s.membersById) membersById = { ...s.membersById };
      membersById[m.id] = row;
    }
    const listed = s.memberIdsByWorkspace[workspaceId] ?? [];
    const have = new Set(listed);
    const added = members.map((m) => m.id).filter((id) => !have.has(id));
    const memberIdsByWorkspace =
      added.length === 0
        ? s.memberIdsByWorkspace
        : { ...s.memberIdsByWorkspace, [workspaceId]: [...listed, ...added] };
    return { membersById, memberIdsByWorkspace, nicknamesByWorkspace };
  });
}
