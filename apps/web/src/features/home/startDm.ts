/**
 * @cytale/web — the start-a-DM handler (#94): open or return-existing.
 *
 * The dedup contract lives here, one seam both the picker and any future
 * entry point (a member's profile card) share: selecting a member the
 * viewer already has a 1:1 thread with navigates to the EXISTING channel
 * without touching the network; a new member calls the open-dm API exactly
 * once. The server dedupes too (same pair → same row, `DmController`'s
 * 200-vs-201) — this client-side pass is what keeps the "selecting the
 * same member twice" story to one API call.
 *
 * The channel snapshot is read through a function, not a captured map, so
 * a handler kept across renders never dedupes against stale rows.
 */
import type { Channel } from '@cytale/domain';

/**
 * The viewer's existing 1:1 DM with `memberId`, if hydrated. DM recipient
 * lists carry the OTHER participants only (the viewer is never included),
 * so a 1:1 peer row is a single-recipient list.
 */
export function findExistingDm(
  channels: Record<string, Channel>,
  memberId: string,
): Channel | null {
  for (const channel of Object.values(channels)) {
    if (channel.type !== 'dm') continue;
    const recipients = channel.recipients ?? [];
    if (recipients.length === 1 && recipients[0]!.id === memberId) return channel;
  }
  return null;
}

export interface StartDmHandlerDeps {
  /** Live store read — invoked per call, never captured. */
  channelsSnapshot: () => Record<string, Channel>;
  /** The api-client's open-dm call (`createDM`). */
  openDm: (memberId: string) => Promise<Channel>;
  /**
   * Both outcomes land here: the parent stores the channel (if new) and
   * navigates into the conversation — the same selection path an existing
   * DM row uses.
   */
  onDmReady: (channel: Channel) => void;
}

export function makeStartDm({
  channelsSnapshot,
  openDm,
  onDmReady,
}: StartDmHandlerDeps): (memberId: string) => Promise<Channel> {
  return async (memberId: string) => {
    const existing = findExistingDm(channelsSnapshot(), memberId);
    if (existing) {
      onDmReady(existing);
      return existing;
    }
    const channel = await openDm(memberId);
    onDmReady(channel);
    return channel;
  };
}
