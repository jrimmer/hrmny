/**
 * REST bootstrap for the native client (plan 004 M5/M6 follow-up).
 *
 * The gateway's `Ready` dispatch carries only the user — `reconcile.ts` sets
 * `currentUser`/`sessionStatus` and nothing else — so the workspace, channel,
 * and member graph has always come from a REST fan-out. The web app does it
 * in `AuthenticatedApp.tsx`; the mobile shell had no equivalent, which is why
 * the drawer rendered "No channels yet" against a live gateway session.
 *
 * Runs after every fresh gateway session (the store's `sessionEpoch` bumps on
 * Ready) and is idempotent: partial failures leave what they fetched and are
 * retried on the next session.
 *
 * Three launch-cost properties this file owns (paired-depth-review pass):
 *
 *   1. THREAD METADATA IS NOT FETCHED HERE. The launch path used to walk
 *      every channel of every workspace with `listThreads` in a serial `for`
 *      loop — `(1 + C)` round trips per workspace before the roster request
 *      even started, and roughly `1 + Σ(2 + C)` requests overall (6 workspaces
 *      × 30 channels ≈ 193). Nothing on mobile reads `threadIdsByChannel`;
 *      thread metadata arrives on demand via `useThreadMeta`'s
 *      `GET /threads/{id}` when a thread surface opens. The leg is deleted,
 *      not pooled: it was buying nothing at launch.
 *   2. EVERY WORKSPACE LEG RUNS THROUGH A BOUNDED POOL (`HYDRATION_CONCURRENCY`).
 *      Channels and roster are independent reads, so they are separate tasks;
 *      the pool caps how many are in flight at once, so a 20-workspace
 *      account does not open 40 sockets and 40 requests at a tap.
 *   3. A STORE THAT ALREADY HOLDS THE GRAPH IS NOT RE-FETCHED. The caller
 *      re-runs this after a session restart; if the graph is already
 *      rendered there is nothing to gain from re-reading it. The retry path
 *      after a genuine failure starts from an empty store, so it still
 *      fetches (see `StoreHydrator` in session.tsx).
 *
 * Contract (code-review residual 4): the workspace list is the ONE leg that is
 * not partial. With no workspaces the shell has nothing to render, so a
 * failure there REJECTS and the caller surfaces it (the shell's error state
 * with a retry). Channels and people are per-workspace sub-fetches: a failure
 * there leaves what already arrived and RESOLVES, so a caller that gets a
 * resolution can always render the workspaces that answered.
 */
import type { CytaleApiClient } from '@cytale/api-client';
import { replaceMembers, type StateStore } from '@cytale/state';

/**
 * Per-workspace legs in flight at once. Four is the launch-latency sweet
 * spot: the first workspace paints after one round trip while a
 * many-workspace account stays bounded.
 */
export const HYDRATION_CONCURRENCY = 4;

/** One unit of work in the pool — it owns its failures (partial contract). */
type Leg = () => Promise<void>;

/**
 * Fetch the membership graph into `store`.
 *
 * Returns immediately when the store already holds workspaces: the graph is
 * rendered, and re-reading it is pure launch cost. Rejects only when the
 * workspace list itself cannot be fetched (nothing is usable); resolves on
 * partial failure, keeping the sub-fetch data that did arrive.
 */
export async function hydrateStore(api: CytaleApiClient, store: StateStore): Promise<void> {
  // Reconnect guard: a fresh gateway session bumps `sessionEpoch` and the
  // caller re-runs the bootstrap. If the graph survived (or another attempt
  // already landed it), there is nothing to fetch.
  if (Object.keys(store.getState().workspaces).length > 0) return;

  const { items: workspaces } = await api.listWorkspaces();
  store.setState((s) => ({
    workspaces: Object.fromEntries(workspaces.map((w) => [w.id, w])),
  }));

  const legs: Leg[] = [];
  for (const workspace of workspaces) {
    legs.push(async () => {
      try {
        const { items: channels } = await api.listChannels(workspace.id);
        store.setState((s) => ({
          channels: {
            ...s.channels,
            ...Object.fromEntries(channels.map((c) => [c.id, c])),
          },
        }));
      } catch {
        // Channels are a sub-fetch: partial by contract, retried next
        // session. The workspace still renders (its roster is below).
      }
    });

    legs.push(async () => {
      try {
        // Paged to the end (people paging review finding): the server's
        // default page is 50, so a single read silently truncates a
        // >50-member workspace.
        const { items: people, truncated } = await api.listAllPeople(workspace.id);
        // The shared writer: rows upserted, this workspace's ids replaced,
        // and its nicknames kept per workspace, off the shared rows (#169).
        replaceMembers(store, { [workspace.id]: people });
        if (truncated) {
          // Honest note, not a silent partial roster: the cap stopped the
          // walk with pages outstanding.
          console.warn(
            `[hydrate] roster for workspace ${workspace.id} is partial — ` +
              'the people page cap was reached.',
          );
        }
      } catch {
        // The roster is additive too: message authors fall back to raw ids.
      }
    });
  }

  await runBounded(legs, HYDRATION_CONCURRENCY);
}

/**
 * Run `tasks` with at most `limit` in flight. Each task settles its own
 * failures, so the returned promise settles when the last one has — the same
 * "partial by contract" resolution `Promise.all` gave the fan-out, without
 * issuing every request at once.
 */
async function runBounded(tasks: readonly Leg[], limit: number): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const task = tasks[next++];
      if (task === undefined) return;
      await task();
    }
  };
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
}
