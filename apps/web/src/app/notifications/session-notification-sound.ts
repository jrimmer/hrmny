/**
 * @cytale/web — the gateway seam that makes a message audible.
 *
 * Attached as a session preprocessor, which is the same place the reaction and
 * call-signal seams live: it runs on every dispatch before the store, so the
 * ding cannot drift from the badge that the same frame produces.
 *
 * ## The preferences
 *
 * Deciding whether a channel is muted needs the member's stored overrides, and
 * a read per message would put a round trip on the message path. They live in
 * the store's `notificationPrefs` slice (2026-09-27: the ONE copy every
 * surface reads — see `features/notifications/notificationPrefs.ts`), loaded
 * once per session and moved optimistically by every control, so the ding
 * hears a mute the moment the header shows it. This seam used to keep its own
 * module-level cache that nothing ever filled: every channel dinged as the
 * default level, whatever the settings screen said.
 */

import type { GatewayEvent } from '@cytale/protocol';
import type { StateStore } from '@cytale/state';

import { maybeDing } from './coordinator.js';

/**
 * A gateway frame, narrowed just enough. MessageCreate and ThreadMessageCreate
 * carry the same message body; everything else is ignored.
 */
type MessageFrame = GatewayEvent & {
  t: 'MessageCreate' | 'ThreadMessageCreate';
  d: {
    channel_id: string;
    thread_id?: string | null;
    author_id: string;
    content: string;
  };
};

// The predicate is written against the LOOSE shape on purpose: GatewayEvent is
// a discriminated union over `t`, so narrowing by name alone is assignable and
// the message body is read below with the fields this seam actually uses.
function isMessageFrame(frame: GatewayEvent): boolean {
  return frame.t === 'MessageCreate' || frame.t === 'ThreadMessageCreate';
}

export function applyNotificationSoundEvent(frame: unknown, store: StateStore): void {
  const event = frame as GatewayEvent;
  if (event?.op !== 0 || !isMessageFrame(event)) return;
  const message = event as MessageFrame;

  const state = store.getState();
  const me = state.currentUser;
  if (!me) return;

  const channel = state.channels[message.d.channel_id];

  const notice = {
    channel_id: message.d.channel_id,
    thread_id: message.d.thread_id ?? null,
    author_id: message.d.author_id,
    content: message.d.content ?? '',
    // A DM has no workspace; the resolver treats its absence as "no workspace
    // layer", which is exactly right.
    workspace_id: channel?.workspace_id ?? null,
  };

  // Fire-and-forget: the preprocessor is SYNCHRONOUS by contract, and a ding
  // must never delay the dispatch that produced it. A rejection here would be
  // an unhandled promise, so it is caught and dropped — a sound that fails is
  // a lesser problem than a message that does not arrive.
  void maybeDing(notice, {
    selfId: me.id,
    overrides: state.notificationPrefs.overrides,
    broadcastSuppressed:
      channel?.workspace_id != null && state.notificationPrefs.suppressBroadcasts[channel.workspace_id] === true,
    // `channel.type === 'dm'` is the same discriminator the call surfaces use.
    isDm: channel?.type === 'dm',
  }).catch(() => false);
}
