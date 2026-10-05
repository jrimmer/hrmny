/**
 * @cytale/web — when a message earns a ding.
 *
 * The sound itself lives in `NotificationSound`; this decides WHETHER to play
 * it, which is the part that matters. A ding on every message is the
 * notification-fatigue failure this whole system exists to avoid, in audio
 * form — so the gates below are the feature, and the tone is incidental.
 *
 * ## The gates, in order
 *
 *  1. **The member's own preference.** Client-local and per-device, like
 *     reduce-motion: muting your phone must not silence your desktop. Stored
 *     under `cytale.notification-sound`, defaulting ON.
 *  2. **Not my own message.** Never.
 *  3. **The client-visible notifying set**: a direct mention, or a direct
 *     message. Both are decidable from the frame alone.
 *  4. **The channel is not muted.** A member who silenced a channel does not
 *     want to hear it. This reuses the SAME resolver the settings readout
 *     renders, so the sound cannot disagree with what the settings screen says
 *     will reach them — a ding from a channel the UI reports as muted is the
 *     readout lying.
 *
 * ## What it deliberately cannot do yet
 *
 * Replies-to-my-message are NOT dingable from here, and that is a real gap
 * rather than a decision: it needs the message graph, which the frame does not
 * carry. `@everyone`/`@here` now are (2026-09-27): the preference slice holds
 * the per-workspace "Suppress @everyone and @here" switch, so the client can
 * apply the server policy's rule — broadcasts count at "mentions only" unless
 * suppressed.
 */

import { mentionsEveryone, mentionsHere, mentionsUser } from '@cytale/domain';
import type { Snowflake } from '@cytale/protocol';

import { createNotificationSound, type NotificationSoundController } from './NotificationSound.js';
import {
  overrideKey,
  resolveFromOverrides,
  type NotificationLevel,
} from '../../features/settings/notificationLevels.js';

/** Where the per-device sound preference is remembered. */
export const NOTIFICATION_SOUND_KEY = 'cytale.notification-sound';

/** True unless the member turned it off. Default ON — a notification you cannot hear is half a notification. */
export function readNotificationSoundEnabled(): boolean {
  try {
    // Absent means never chosen, which means on: the stored value is only ever
    // an explicit "off".
    return localStorage.getItem(NOTIFICATION_SOUND_KEY) !== '0';
  } catch {
    return true;
  }
}

export function writeNotificationSoundEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(NOTIFICATION_SOUND_KEY, enabled ? '1' : '0');
  } catch {
    // Storage unavailable — the choice just does not persist.
  }
}

/** The message facts the decision needs, as the gateway frame carries them. */
export interface MessageNotice {
  channel_id: Snowflake;
  thread_id?: Snowflake | null;
  author_id: Snowflake;
  content: string;
  /** The channel's workspace, when the caller knows it. */
  workspace_id?: Snowflake | null;
}

export interface NoticeDeps {
  /** The viewer. Null before hydration — nothing dings for an unknown identity. */
  selfId: string | null;
  /** Stored channel/workspace overrides, keyed `scope:entityId`. */
  overrides: Record<string, NotificationLevel>;
  /** Whether this frame is a direct message (no workspace, two participants). */
  isDm: boolean;
  /** True when the member switched on "Suppress @everyone and @here" for the channel's workspace. */
  broadcastSuppressed?: boolean;
  /** True when the member has muted the channel's call ringing (the shipped per-channel control). */
  channelMuted?: boolean;
  /**
   * Whether the member has posted in this channel. The server's participation
   * sweep raises a broad MUTE back to all-activity for someone who took part
   * (R11), so the sound must follow or the settings readout would promise
   * replies the member never hears. Undefined before that fact is known —
   * treated as no participation, which UNDER-dings rather than over-dings.
   */
  participated?: boolean;
}

/**
 * Whether this message should be heard. Pure — the caller supplies every fact.
 */
export function shouldDing(notice: MessageNotice, deps: NoticeDeps): boolean {
  if (deps.selfId === null) return false;
  if (notice.author_id === deps.selfId) return false;

  const resolved = resolveFromOverrides({
    overrides: deps.overrides,
    workspaceId: notice.workspace_id ?? undefined,
    channelId: notice.channel_id,
    threadId: notice.thread_id ?? undefined,
    participated: deps.participated,
  });

  // The member's own instruction outranks every event class — the same
  // precedence the server's policy applies.
  if (resolved.level === 'mute') return false;

  // A per-channel ring mute is also a statement about this channel. Sound is
  // what that control is FOR, so it silences the ding too.
  if (deps.channelMuted) return false;

  if (deps.isDm) return true;
  if (resolved.level === 'all') return true;

  if (mentionsUser(notice.content, deps.selfId)) return true;

  // 2026-09-27: "Mentions only" INCLUDES @everyone/@here in a workspace
  // channel, unless the member suppressed broadcasts there — the server
  // policy's rule, so the ding agrees with the push.
  return (
    notice.workspace_id != null &&
    !deps.broadcastSuppressed &&
    (mentionsEveryone(notice.content) || mentionsHere(notice.content))
  );
}

/**
 * The WebAudio controller, one per page. Created lazily so a member with sound
 * off never opens an AudioContext at all.
 */
let sound: NotificationSoundController | null = null;

function controller(): NotificationSoundController {
  sound ??= createNotificationSound();
  return sound;
}

/**
 * Ding if the message has earned it. Returns whether a sound actually played,
 * which is what a test asserts on.
 */
export async function maybeDing(notice: MessageNotice, deps: NoticeDeps): Promise<boolean> {
  if (!readNotificationSoundEnabled()) return false;
  if (!shouldDing(notice, deps)) return false;

  const result = await controller().play();
  return result.played;
}

/** Test seam: drop the singleton between cases. */
export function resetNotificationSound(): void {
  sound = null;
}

export { overrideKey };
