/**
 * @cytale/web — People Directory types (U26, U12 attribution fields).
 *
 * Mirrors the U9 people REST contract
 * (`GET /api/v1/workspaces/:id/people?query=&before=&after=&limit=`), whose
 * shipped shape lives in `apps/server/lib/cytale_web/controllers/user_controller.ex`:
 *
 *   { "people": [{ "user": { "id", "username" }, "nickname", "joined_at", "roles" }],
 *     "next_before": <snowflake cursor | null> }
 *
 * Local row/page shapes kept in lockstep with the server controller; the
 * bots-plan projection keys (`kind`, `parent_user_id` — see
 * @cytale/domain's WorkspaceMember) ride the same rows and are optional so
 * older reads without them still typecheck.
 */

import type { PrincipalKind } from '@cytale/domain';

/** A member row as served by the people endpoint. */
export interface PeopleMember {
  user: {
    id: string;
    username: string;
    /** The account's display name (#168); absent/null → the username. */
    display_name?: string | null;
    /** Uploaded avatar (roster row); absent → the hue tile. */
    avatar_url?: string | null;
    /** The agent's DM-support policy (machine principals; absent = humans). */
  dm_support?: 'humans' | 'everyone' | 'none';
};
  nickname: string | null;
  joined_at: string | null;
  roles: string[];
  /** Principal kind (bots plan U5): humans read "human"; machine entries
   * carry bot/agent/webhook and render the avatar's robot seal. */
  kind?: PrincipalKind;
  /** Owning human's id — machine entries only (R1: membership derives from
   * the parent). Resolves the badge's "via <parent display name>". */
  parent_user_id?: string;
  /** The agent's DM-support policy (machine principals; absent = humans). */
  dm_support?: 'humans' | 'everyone' | 'none';
}

/** The people endpoint response envelope. */
export interface PeoplePage {
  people: PeopleMember[];
  next_before: string | null;
}

/** Presence statuses (U23 owns the live source; U26 renders the indicator). */
export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline';

/** Per-member presence map keyed by member user id (U23 seam). */
export type PresenceByUser = Record<string, PresenceStatus>;
