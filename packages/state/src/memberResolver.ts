/**
 * @cytale/state — on-demand member resolution (2026-10-02).
 *
 * The roster a client boots with is ONE people page per workspace (50 rows,
 * the highest member ids). Every surface names an author, a thread starter or
 * a reply target through `membersById`, so in a workspace larger than a page
 * anyone beyond it rendered as a raw snowflake — in the timeline, threads,
 * the inbox — until a reload happened to page them in (owner report
 * 2026-10-02: a workspace of 120, member #110 shown as digits).
 *
 * Two ways to make the roster complete enough to name everyone:
 *
 *   1. page through the whole people directory at boot. Cost is O(members)
 *      per client per session — a workspace of 1,000 is 10+ sequential reads
 *      of a partition the server sorts in memory per page (so O(n²) rows read
 *      server-side per boot), multiplied by every client reconnecting after a
 *      deploy. Most of those rows name people this client never renders.
 *   2. name the ids that are actually on screen. Cost is O(distinct authors
 *      rendered), independent of workspace size, and the read is a single
 *      batched lookup (`GET /workspaces/:id/people?ids=…`, up to 100 ids).
 *
 * This module is (2). It watches the message windows and the thread roster;
 * any author id (or thread starter) in a workspace channel that `membersById`
 * cannot name is queued, the queue is flushed after a short debounce as ONE
 * lookup per workspace (chunked at 100 ids), and the rows land through
 * `mergeMembers` — the same row shape the people page and `MemberAdd`
 * produce, so a member named on demand is indistinguishable from one paged in.
 *
 * Caching: an id is asked once. One the server could not name (a former
 * member, a deleted bot) is not asked again for `missRetryMs`; a failed
 * lookup backs off for `errorRetryMs`. Boot is untouched: the first people
 * page still hydrates in parallel with threads, and nothing here blocks READY
 * or first paint — lookups run after the windows they serve have rendered.
 */

import type { WorkspaceMember } from '@cytale/domain';
import type { Snowflake } from '@cytale/protocol';

import { mergeMembers } from './roster.js';
import type { MessageSlice, StateState, StateStore } from './store.js';

/** Rows for `ids` in `workspaceId` — ids the server cannot name are simply absent. */
export type MemberLookup = (workspaceId: Snowflake, ids: Snowflake[]) => Promise<WorkspaceMember[]>;

export interface MemberResolverOptions {
  store: StateStore;
  lookup: MemberLookup;
  /** Coalescing window before a lookup goes out (default 50 ms). */
  debounceMs?: number;
  /** Ids per lookup — the server's cap (default 100). */
  maxBatch?: number;
  /** How long an id the server could not name stays unasked (default 5 min). */
  missRetryMs?: number;
  /** Back-off after a failed lookup (default 15 s). */
  errorRetryMs?: number;
  /** Clock seam for tests. */
  now?: () => number;
}

export interface RequestOptions {
  /**
   * Resolve even when `membersById` already names the id, as long as this
   * workspace does not list it — for a membership check (the viewer's own
   * row in a workspace larger than a page) rather than a name. Since #169
   * every request behaves this way (a nickname is per-workspace, so a row
   * from another workspace does not name someone HERE); kept for callers.
   */
  membership?: boolean;
}

export interface MemberResolver {
  /** Queue ids for `workspaceId` (no-op for ids already known). */
  request(workspaceId: Snowflake, ids: Iterable<Snowflake>, options?: RequestOptions): void;
  /** Send whatever is queued now (tests; the debounce otherwise does it). */
  flush(): Promise<void>;
  stop(): void;
}

const SNOWFLAKE = /^\d{1,20}$/;

export function startMemberResolver(options: MemberResolverOptions): MemberResolver {
  const {
    store,
    lookup,
    debounceMs = 50,
    maxBatch = 100,
    missRetryMs = 5 * 60_000,
    errorRetryMs = 15_000,
    now = Date.now,
  } = options;

  const pending = new Map<Snowflake, Set<Snowflake>>();
  const inFlight = new Set<string>();
  const quietUntil = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let running: Promise<void> = Promise.resolve();

  const key = (ws: Snowflake, id: Snowflake) => `${ws}:${id}`;

  function request(workspaceId: Snowflake, ids: Iterable<Snowflake>, _opts: RequestOptions = {}): void {
    if (stopped) return;
    const s = store.getState();
    let listed: Set<Snowflake> | null = null;
    const t = now();
    for (const id of ids) {
      if (!SNOWFLAKE.test(id)) continue;
      // Known means listed in THIS workspace (#169): a row another workspace
      // loaded names the person but not their nickname here, which only this
      // workspace's lookup carries. `membership` asks the same question.
      listed ??= new Set(s.memberIdsByWorkspace[workspaceId] ?? []);
      if (listed.has(id)) continue;
      const k = key(workspaceId, id);
      if (inFlight.has(k)) continue;
      const quiet = quietUntil.get(k);
      if (quiet !== undefined && quiet > t) continue;
      let set = pending.get(workspaceId);
      if (set === undefined) pending.set(workspaceId, (set = new Set()));
      set.add(id);
    }
    if (pending.size > 0 && timer === null) {
      timer = setTimeout(() => {
        timer = null;
        void flush();
      }, debounceMs);
    }
  }

  async function lookupChunk(workspaceId: Snowflake, ids: Snowflake[]): Promise<void> {
    for (const id of ids) inFlight.add(key(workspaceId, id));
    try {
      const rows = await lookup(workspaceId, ids);
      if (stopped) return;
      // Only the rows asked for, so a stray row can never widen a roster.
      const asked = new Set(ids);
      const named = rows.filter((r) => asked.has(r.id));
      mergeMembers(store, workspaceId, named);
      const got = new Set(named.map((r) => r.id));
      const until = now() + missRetryMs;
      for (const id of ids) if (!got.has(id)) quietUntil.set(key(workspaceId, id), until);
    } catch {
      const until = now() + errorRetryMs;
      for (const id of ids) quietUntil.set(key(workspaceId, id), until);
    } finally {
      for (const id of ids) inFlight.delete(key(workspaceId, id));
    }
  }

  function flush(): Promise<void> {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const batches: Promise<void>[] = [];
    for (const [workspaceId, set] of pending) {
      const ids = [...set];
      for (let i = 0; i < ids.length; i += maxBatch) {
        batches.push(lookupChunk(workspaceId, ids.slice(i, i + maxBatch)));
      }
    }
    pending.clear();
    running = Promise.all([running, ...batches]).then(() => undefined);
    return running;
  }

  // -- what to resolve: authors in the message windows, thread starters ------

  function workspaceOfChannel(s: StateState, channelId: Snowflake | undefined): Snowflake | null {
    if (!channelId) return null;
    const ch = s.channels[channelId];
    if (ch) return ch.workspace_id ?? null;
    const thread = s.threadsById[channelId];
    return thread ? (s.channels[thread.channel_id]?.workspace_id ?? null) : null;
  }

  function scanSlice(s: StateState, workspaceId: Snowflake | null, slice: MessageSlice | undefined): void {
    if (!workspaceId || !slice) return;
    const ids = new Set<Snowflake>();
    // Listed in this workspace, not merely known from another (#169).
    const listed = new Set(s.memberIdsByWorkspace[workspaceId] ?? []);
    for (const m of slice.items) {
      if (m.author_id && !listed.has(m.author_id)) ids.add(m.author_id);
    }
    if (ids.size > 0) request(workspaceId, ids);
  }

  function scan(s: StateState, prev: StateState | null): void {
    if (prev === null || s.messagesByChannel !== prev.messagesByChannel) {
      for (const [channelId, slice] of Object.entries(s.messagesByChannel)) {
        if (prev !== null && prev.messagesByChannel[channelId] === slice) continue;
        scanSlice(s, workspaceOfChannel(s, channelId), slice);
      }
    }
    if (prev === null || s.messagesByThread !== prev.messagesByThread) {
      for (const [threadId, slice] of Object.entries(s.messagesByThread)) {
        if (prev !== null && prev.messagesByThread[threadId] === slice) continue;
        scanSlice(s, workspaceOfChannel(s, threadId), slice);
      }
    }
    if (prev === null || s.threadsById !== prev.threadsById) {
      const byWorkspace = new Map<Snowflake, Set<Snowflake>>();
      for (const [threadId, thread] of Object.entries(s.threadsById)) {
        if (prev !== null && prev.threadsById[threadId] === thread) continue;
        const starter = thread.created_by;
        if (!starter) continue;
        const ws = workspaceOfChannel(s, thread.channel_id);
        if (!ws) continue;
        if ((s.memberIdsByWorkspace[ws] ?? []).includes(starter)) continue;
        let set = byWorkspace.get(ws);
        if (set === undefined) byWorkspace.set(ws, (set = new Set()));
        set.add(starter);
      }
      for (const [ws, ids] of byWorkspace) request(ws, ids);
    }
  }

  scan(store.getState(), null);
  const unsubscribe = store.subscribe((s, prev) => scan(s, prev));

  return {
    request,
    flush,
    stop() {
      stopped = true;
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending.clear();
    },
  };
}
