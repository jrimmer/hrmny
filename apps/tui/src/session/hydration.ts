/**
 * @cytale/tui — U12's REST hydration: the ONE owned load path that gives column
 * one its data (R15, R16, R17).
 *
 * The gateway's `Ready` dispatch carries only the user, so the workspace,
 * channel, member, and DM graph has always come from a REST fan-out in every
 * client (web's `AuthenticatedApp`, mobile's `navigation/hydrate.ts`). This
 * module is the terminal client's copy of that load, and it follows the mobile
 * client's shape deliberately (U12's "Patterns to follow") because that file
 * is where the failure modes of this fan-out are written down.
 *
 * ---------------------------------------------------------------------------
 * What the load does, and what it deliberately does not
 * ---------------------------------------------------------------------------
 *
 * 1. The workspace list first — one read, and the only leg that is not
 *    partial (see the contract below).
 * 2. Then, in one bounded pool: every workspace's channels, every workspace's
 *    member roster, and the member's DMs. Channels and the roster are
 *    independent reads, so they are separate tasks; `HYDRATION_CONCURRENCY`
 *    caps how many are in flight, so a 20-workspace account does not open 40
 *    requests at a boot.
 * 3. NO THREAD LEG, for the reason the mobile file gives: nothing on column
 *    one reads `threadIdsByChannel` at launch (U7 opens a thread from a
 *    message on demand), and a serial `listThreads` walk would cost
 *    `1 + Σ(2 + C)` round trips for data no surface had asked for.
 *
 * ---------------------------------------------------------------------------
 * The partial-failure contract, stated explicitly
 * ---------------------------------------------------------------------------
 *
 *   * THE WORKSPACE LIST IS FATAL for the channel view: with no list, no
 *     channel pane can be built, so nothing is written and `phase` is
 *     `'failed'` with the client's own copy in `error` (never a raw transport
 *     message). A failure here also issues no sub-fetch: there is nothing to
 *     fan out over.
 *   * AN EMPTY WORKSPACE LIST IS NOT A FAILURE. Zero workspaces is the
 *     correct state for a member whose invite is still pending, and it looks
 *     identical to a fatal error if both render as "something went wrong".
 *     It gets `phase: 'empty'` and `notice`, a message naming the browser URL
 *     where they can create a workspace or accept an invite — and the DMs are
 *     still loaded, because R17's DM list is account-wide.
 *   * THE SUB-FETCHES DEGRADE. A channels or roster read that fails leaves
 *     every other leg's data in place, resolves `'ready'`, and names the
 *     workspace in `channelsFailed` / `membersFailed` so column one renders an
 *     error state for THAT workspace instead of an empty one it cannot tell
 *     apart from "there are no channels here". The same rule covers an empty
 *     workspace: an empty result is `[]`, never an entry in those lists.
 *   * A REFRESH THAT FAILS OVER A RENDERED GRAPH IS NOT FATAL EITHER. The
 *     shell already holds rows; blanking it because a *refresh* failed would
 *     destroy working state. That case keeps `phase: 'ready'` with `error`
 *     set, so the shell can note the failed refresh without losing column one.
 *
 * ---------------------------------------------------------------------------
 * The session binding (a reconnect refreshes, it does not go stale)
 * ---------------------------------------------------------------------------
 *
 * `start()` subscribes to the shared store's `sessionEpoch` — the same signal
 * web and mobile re-hydrate on. A fresh `READY` bumps it AND wipes the graph
 * in the same write (`resetForFreshSession`), so without this the member would
 * sit in front of an empty column one after every reconnect. A bump that lands
 * while a load is in flight queues exactly one more pass rather than racing a
 * second fan-out against the first.
 *
 * `offline` has no state of its own here: that is the connection banner's
 * (U5's) and the shell's state. Hydration's contribution to R21 is that the
 * epoch re-run is what makes the graph converge after a dropped link.
 *
 * ---------------------------------------------------------------------------
 * The payload shapes the api-client's types do not match, normalized here
 * ---------------------------------------------------------------------------
 *
 * `listDMChannels` is declared `ListResponse<Channel>` and `listAllPeople`
 * `PeoplePage` of `WorkspaceMember`, but the controllers serve neither, in
 * three ways that each break column one on their own:
 *
 *   * THE DM ENVELOPE. `DmController.index` answers `{"channels": [...]}` and
 *     `listDMChannels` goes through the raw list helper, not the envelope
 *     unwrapper `listWorkspaces`/`listChannels` use — so its `items` is
 *     `undefined` and a caller that destructures it throws before reading a
 *     row. `readDmRows` accepts either spelling.
 *   * THE DM ROW. That same endpoint answers `{id, user_ids, recipients,
 *     created_at, last_message_id}` — no `type`, no `workspace_id`, no `name`.
 *     Written through verbatim, every DM row fails the DM column's
 *     `type === 'dm'` filter and the column renders empty against a live
 *     session. `toDmChannel` completes the row (the endpoint's rows are DMs by
 *     definition, so the type is not a guess).
 *   * THE PEOPLE ROW. `UserController.people` NESTS the user
 *     (`{user: {id, username, …}, nickname, joined_at, roles}`), the shape
 *     apps/web's directory API reads. Read as flat rows, every member id is
 *     `undefined` and the roster map is keyed by one junk entry. `toMember`
 *     unwraps it.
 *
 * All three normalizers accept the flattened spelling too, so the module stays
 * correct whichever way that boundary is fixed (the fix belongs to
 * `@cytale/api-client`, not here).
 *
 * Nothing here writes to the terminal: the Ink tree owns stdout, and a stray
 * `console.warn` prints through the frame it is drawing (the mobile client's
 * warn for the same condition has no honest equivalent here). The roster page
 * cap therefore surfaces as `rostersTruncated` — a fact the shell can render —
 * rather than as a warning nobody sees.
 */
import type { CytaleApiClient } from '@cytale/api-client';
import type { Channel, PrincipalKind, UserRef, Workspace, WorkspaceMember } from '@cytale/domain';
import type { Snowflake } from '@cytale/protocol';
import { replaceMembers, type StateStore } from '@cytale/state';

/**
 * Legs in flight at once. Four is the mobile client's launch-latency sweet
 * spot: the first workspace paints after one round trip, and a many-workspace
 * account stays bounded (its `hydrate.ts`).
 */
export const HYDRATION_CONCURRENCY = 4;

/**
 * What the shell can honestly say about the load.
 *
 *   * `idle`    — nothing has run yet (the snapshot before `start()`).
 *   * `loading` — a pass is in flight; nothing is known yet.
 *   * `ready`   — the workspace list arrived and the fan-out settled. Column
 *                 one has rows, or an honest reason it does not (the
 *                 `*Failed` lists).
 *   * `empty`   — the account has no workspaces. `notice` says where to fix
 *                 that; the DMs are loaded and reachable (R17).
 *   * `failed`  — the workspace list could not be read and the store is still
 *                 empty, so no channel pane can be built.
 */
export type HydrationPhase = 'idle' | 'loading' | 'ready' | 'empty' | 'failed';

/** The snapshot the shell renders its states from. */
export interface HydrationSnapshot {
  readonly phase: HydrationPhase;
  /** `'empty'`: the message naming the browser URL. Null otherwise. */
  readonly notice: string | null;
  /** Set when the workspace list could not be read. The client's own copy. */
  readonly error: string | null;
  /**
   * The transport cause behind `error`, for a member who needs it (`ApiError`
   * keys and Node's `errno` codes are actionable; they are never the headline).
   */
  readonly errorDetail: string | null;
  /** Workspaces whose channel read failed — column one's error state. */
  readonly channelsFailed: readonly Snowflake[];
  /** Workspaces whose roster read failed — presence degrades, chats do not. */
  readonly membersFailed: readonly Snowflake[];
  /** Workspaces whose roster hit the people page cap, so it is partial by force. */
  readonly rostersTruncated: readonly Snowflake[];
  /** The account-wide DM read failed: DMs mode has an error, chats do not. */
  readonly dmsFailed: boolean;
}

export interface HydrationOptions {
  /** The session's REST client (`session.manager.api`). */
  readonly api: CytaleApiClient;
  /** The shared store this load populates; column one renders from it. */
  readonly store: StateStore;
  /** The resolved origin — the browser URL the empty state names. */
  readonly origin: string;
}

export interface Hydrator {
  /** The current snapshot (the shell's first read is `'idle'`). */
  snapshot(): HydrationSnapshot;
  /** Observe every publish (loading → ready/empty/failed). */
  subscribe(listener: (snapshot: HydrationSnapshot) => void): () => void;
  /** Subscribe to the session and run the first load; resolves when it settles. */
  start(): Promise<HydrationSnapshot>;
  /** Run one pass (the failed state's retry); coalesces with a pass in flight. */
  run(): Promise<HydrationSnapshot>;
  /** Stop following the session. The store keeps whatever has landed. */
  stop(): void;
}

const IDLE: HydrationSnapshot = {
  phase: 'idle',
  notice: null,
  error: null,
  errorDetail: null,
  channelsFailed: [],
  membersFailed: [],
  rostersTruncated: [],
  dmsFailed: false,
};

/**
 * Web's and mobile's fallback copy for the one fatal read. A transport string
 * ("fetch failed") is not something a member can act on; `errorDetail` carries
 * it for the case where they can.
 */
const WORKSPACES_FAILED = 'Could not load your workspaces.';

/**
 * The zero-workspace message. It names the browser URL because that is the
 * only place a workspace can be created or an invite accepted, and it says the
 * DMs are still here because R17 makes them account-wide: a member with no
 * workspace is not locked out of their conversations.
 */
export function noWorkspacesNotice(origin: string): string {
  return (
    `No workspaces yet. Open ${origin} in a browser to create a workspace or accept an invite ` +
    '— your DMs are still available here.'
  );
}

/** One unit of work in the pool. It owns its failures (partial by contract). */
type Leg = () => Promise<void>;

/**
 * Fetch the membership graph into the store.
 *
 * The load turns every fetch failure into a value on the returned snapshot —
 * the fatal one, the empty one, or a per-leg list — so there is no failure
 * mode a caller has to catch to render.
 */
export function createHydrator(options: HydrationOptions): Hydrator {
  const { api, store, origin } = options;

  const listeners = new Set<(snapshot: HydrationSnapshot) => void>();
  let current: HydrationSnapshot = IDLE;
  let inFlight: Promise<HydrationSnapshot> | null = null;
  let rerunQueued = false;
  let unsubscribe: (() => void) | null = null;
  let lastEpoch: number | null = null;

  const publish = (next: Partial<HydrationSnapshot>): HydrationSnapshot => {
    current = { ...current, ...next };
    for (const listener of [...listeners]) listener(current);
    return current;
  };

  const load = async (): Promise<HydrationSnapshot> => {
    publish({
      phase: 'loading',
      notice: null,
      error: null,
      errorDetail: null,
      channelsFailed: [],
      membersFailed: [],
      rostersTruncated: [],
      dmsFailed: false,
    });

    // Read before the fetch: a refresh over a graph that is already rendered
    // must not blank it (see the header).
    const graphHeld = Object.keys(store.getState().workspaces).length > 0;

    let workspaces: readonly Workspace[];
    try {
      ({ items: workspaces } = await api.listWorkspaces());
    } catch (err) {
      return publish({
        phase: graphHeld ? 'ready' : 'failed',
        error: WORKSPACES_FAILED,
        errorDetail: describe(err),
      });
    }

    store.setState({ workspaces: Object.fromEntries(workspaces.map((w) => [w.id, w])) });

    const channelsFailed: Snowflake[] = [];
    const membersFailed: Snowflake[] = [];
    const rostersTruncated: Snowflake[] = [];
    let dmsFailed = false;

    // The DM list is account-wide (R17), so it is one leg for the account and
    // not one per workspace — and it runs for a member with no workspace too.
    const dmLeg: Leg = async () => {
      try {
        const dms = (await readDmRows(api)).map(toDmChannel).filter(isPresent);
        store.setState((s) => ({
          channels: { ...s.channels, ...Object.fromEntries(dms.map((c) => [c.id, c])) },
        }));
      } catch {
        dmsFailed = true;
      }
    };

    const legs: Leg[] = [dmLeg];
    for (const workspace of workspaces) {
      legs.push(async () => {
        try {
          const { items } = await api.listChannels(workspace.id);
          store.setState((s) => ({
            channels: { ...s.channels, ...Object.fromEntries(items.map((c) => [c.id, c])) },
          }));
        } catch {
          channelsFailed.push(workspace.id);
        }
      });

      legs.push(async () => {
        try {
          const { items, truncated } = await api.listAllPeople(workspace.id);
          const people = items.map(toMember).filter(isPresent);
          // Merged into the live state, not replaced: the legs of two
          // workspaces run concurrently (and a re-run must not drop the other
          // workspace's roster), so the updater has to read the latest state.
          // The shared writer (`replaceMembers` reads the latest state, so the
          // concurrent legs merge): rows upserted, this workspace's ids
          // replaced, its nicknames kept per workspace (#169).
          replaceMembers(store, { [workspace.id]: people });
          if (truncated) rostersTruncated.push(workspace.id);
        } catch {
          membersFailed.push(workspace.id);
        }
      });
    }

    await runBounded(legs, HYDRATION_CONCURRENCY);

    return publish({
      phase: workspaces.length === 0 ? 'empty' : 'ready',
      ...(workspaces.length === 0 ? { notice: noWorkspacesNotice(origin) } : {}),
      channelsFailed,
      membersFailed,
      rostersTruncated,
      dmsFailed,
    });
  };

  /**
   * Run one pass, coalescing. A pass already in flight is returned as-is and
   * a single extra pass is queued for after it — a session bump landing
   * mid-load must re-run (the store was just reset) without launching a
   * second fan-out alongside the first, and one queued pass is enough however
   * many bumps arrive in that window.
   */
  const run = (): Promise<HydrationSnapshot> => {
    if (inFlight !== null) {
      rerunQueued = true;
      return inFlight;
    }
    const started = load();
    inFlight = started;
    const settle = (): void => {
      inFlight = null;
      if (rerunQueued) {
        rerunQueued = false;
        void run().catch(() => undefined);
      }
    };
    // Settles on either outcome: the queued pass must not be stranded by a
    // throw the caller of `run()` is already handling.
    void started.then(settle, settle);
    return started;
  };

  return {
    snapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async start() {
      if (unsubscribe === null) {
        lastEpoch = store.getState().sessionEpoch;
        unsubscribe = store.subscribe((state) => {
          if (state.sessionEpoch === lastEpoch) return;
          lastEpoch = state.sessionEpoch;
          // Fire-and-forget: the snapshot is the report, and nothing awaits
          // this leg of the load.
          void run().catch(() => undefined);
        });
      }
      return await run();
    },

    run,

    stop() {
      unsubscribe?.();
      unsubscribe = null;
      lastEpoch = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Row normalization (see the header: neither read is what the api-client
// declares, and both are what the server actually serves)
// ---------------------------------------------------------------------------

/** The server row `GET /users/@me/channels` answers with. */
interface DmRow {
  id?: unknown;
  workspace_id?: unknown;
  name?: unknown;
  recipients?: unknown;
  last_message_id?: unknown;
  created_at?: unknown;
}

/**
 * The member's DM rows.
 *
 * `listDMChannels` is declared `ListResponse<Channel>` but hands back whatever
 * the endpoint said, and the endpoint says `{"channels": [...]}` — so `items`
 * is `undefined` and a caller that destructures it throws before it can read a
 * single row. Both spellings are accepted here for the same reason
 * `listWorkspaces` accepts `workspaces` and `items`: that boundary is not this
 * unit's to fix, and a client that cannot read the envelope has no DM column.
 */
async function readDmRows(api: CytaleApiClient): Promise<DmRow[]> {
  const response = (await api.listDMChannels()) as unknown as { items?: unknown; channels?: unknown };
  const rows = Array.isArray(response.items)
    ? response.items
    : Array.isArray(response.channels)
      ? response.channels
      : [];
  return rows.filter((row): row is DmRow => typeof row === 'object' && row !== null);
}

/**
 * A DM list row → a `Channel` column one can render.
 *
 * The endpoint's rows are DMs by definition and carry no `type` at all, so the
 * type is completed rather than derived; `recipients` is the peer summary the
 * DM column names its rows from (`HomeSidebar`'s `dmPeer`, U6's row label).
 * `name` is empty — DMs have no server-side name — and the peer, not the name,
 * is what renders.
 */
function toDmChannel(row: DmRow): Channel | null {
  if (typeof row.id !== 'string' || row.id === '') return null;
  return {
    id: row.id,
    workspace_id: typeof row.workspace_id === 'string' ? row.workspace_id : null,
    name: typeof row.name === 'string' ? row.name : '',
    type: 'dm',
    parent_id: null,
    topic: null,
    position: 0,
    last_message_id: typeof row.last_message_id === 'string' ? row.last_message_id : null,
    created_at: typeof row.created_at === 'string' ? row.created_at : '',
    recipients: Array.isArray(row.recipients) ? (row.recipients as UserRef[]) : null,
  };
}

/** A people row: the server nests the user, the flattened shape may not. */
interface PeopleRow {
  user?: unknown;
  id?: unknown;
  username?: unknown;
  avatar_url?: unknown;
  nickname?: unknown;
  joined_at?: unknown;
  roles?: unknown;
  kind?: unknown;
}

/** `UserController.people` row → the flat `WorkspaceMember` the store holds. */
function toMember(row: PeopleRow): WorkspaceMember | null {
  const nested = typeof row.user === 'object' && row.user !== null;
  const user = (nested ? row.user : row) as Record<string, unknown>;
  const id = user.id;
  if (typeof id !== 'string' || id === '') return null;
  return {
    id,
    username: typeof user.username === 'string' ? user.username : '',
    display_name: typeof user.display_name === 'string' ? user.display_name : null,
    avatar_url: typeof user.avatar_url === 'string' ? user.avatar_url : null,
    nickname: typeof row.nickname === 'string' ? row.nickname : null,
    joined_at: typeof row.joined_at === 'string' ? row.joined_at : '',
    roles: Array.isArray(row.roles) ? row.roles.filter((r): r is string => typeof r === 'string') : [],
    ...(isPrincipalKind(row.kind) ? { kind: row.kind } : {}),
  };
}

const PRINCIPAL_KINDS = new Set<PrincipalKind>(['human', 'bot', 'agent', 'webhook']);

function isPrincipalKind(value: unknown): value is PrincipalKind {
  return typeof value === 'string' && PRINCIPAL_KINDS.has(value as PrincipalKind);
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

// ---------------------------------------------------------------------------
// The pool
// ---------------------------------------------------------------------------

/**
 * Run `legs` with at most `limit` in flight (the mobile client's `runBounded`).
 * Each leg settles its own failures, so this resolves when the last one has —
 * the same "partial by contract" resolution an unbounded `Promise.all` gave,
 * without issuing every request at once.
 */
async function runBounded(legs: readonly Leg[], limit: number): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < legs.length) {
      const leg = legs[next++];
      if (leg === undefined) return;
      await leg();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, legs.length) }, () => worker()));
}

/** The transport cause of a failure, as one line. */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
