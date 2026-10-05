/**
 * @cytale/web — sidebar call slot (calls plan U7).
 *
 * The indented row rendered under its owning channel while a call is live
 * there (R3): participant avatar stack (an overlapping, ringed strip), a
 * count instead of an avatar wall for large rosters, and a speaking-ring
 * highlight fed by U8's analyser store (static roster
 * otherwise). Clicking joins the call — or, when the viewer already holds a
 * leg, returns to the call surface (AM18); both route through the `useCall`
 * seam. Nothing renders when no call is live (the SIDEBAR decides that; an
 * empty roster here means CALL_SYNC is still in flight and renders
 * placeholder avatars rather than nothing).
 *
 * Keyboard: a real button — natively focusable, Enter/Space activatable,
 * focus ring per the house channel-row pattern.
 */

import { useCallback } from 'react';

import type { CallParticipantState } from '@cytale/state';

import { PhoneIcon } from '../../app/ui/icons.js';
import { Avatar } from '../../app/ui/UserAvatar.js';

import { useCall, useCallSpeakingFor } from './useCall.js';
import { MEDIA_DISABLED_TITLE, useMediaEnabled } from './useMediaEnabled.js';
import { displayNameOf } from '@cytale/domain';

/** Avatars beyond this render as a count instead (plan: count, not 30 avatars). */
const MAX_AVATARS = 5;

export interface CallSlotProps {
  /** The channel whose row this slot hangs under. */
  channelId: string;
  /** Roster sorted by user id (the sidebar projection's shape). */
  roster: readonly CallParticipantState[];
  /**
   * User ids with an active speaking highlight right now (U8's throttled
   * analyser map; optional — a static roster renders no rings).
   */
  speakingUserIds?: ReadonlySet<string>;
  /** True when the VIEWER holds a voice leg (click = return, AM18). */
  joined?: boolean;
  /**
   * True while this channel's call is ringing the viewer (U11): the slot
   * carries the same transient accent emphasis as the channel row — the
   * ring's visual equivalent in the sidebar, alive exactly while the ring
   * slice holds the entry.
   */
  ringing?: boolean;
  /** Join/return intent; defaults to the `useCall` seam. */
  onJoin?: (channelId: string) => void;
  /** Roster rows by user id: the avatars' names (initials) and images. */
  members?: Record<
    string,
    | { username: string; nickname?: string | null; display_name?: string | null; avatar_url?: string | null }
    | undefined
  >;
  /** The channel's workspace nicknames (#169); absent in a DM. */
  nicknames?: Readonly<Record<string, string>>;
}

export function CallSlot({
  channelId,
  nicknames,
  roster,
  speakingUserIds,
  joined = false,
  ringing = false,
  onJoin,
  members,
}: CallSlotProps) {
  const call = useCall();
  // The live speaking seam (U8's analyser set): rings render when this
  // client's active call is on this channel; a static roster otherwise.
  // An explicit speakingUserIds prop (tests / overrides) takes precedence.
  const engineSpeaking = useCallSpeakingFor(channelId);
  const speaking = speakingUserIds ?? engineSpeaking;
  // Ticket #124: the media master switch (READY → store). With media off the
  // slot STILL renders — the live call runs out naturally, never torn down —
  // but the join affordance is honest-visible-disabled: NEW joins refuse
  // server-side. (A viewer already holding a leg keeps their join/return:
  // re-binds of in-progress legs are the run-out-naturally edge.)
  const mediaEnabled = useMediaEnabled();
  const joinDisabled = !mediaEnabled && !joined;
  const count = roster.length;
  const handleClick = useCallback(() => {
    if (onJoin) onJoin(channelId);
    else call.joinCall(channelId);
  }, [onJoin, call, channelId]);

  const participantWord = count === 1 ? 'participant' : 'participants';
  const ariaLabel =
    joinDisabled
      ? MEDIA_DISABLED_TITLE
      : count === 0
        ? joined
          ? 'Return to call'
          : 'Call'
        : joined
          ? `Return to call — ${count} ${participantWord}`
          : `Call — ${count} ${participantWord}`;

  const showCount = count > MAX_AVATARS;
  const visibleRoster = roster.slice(0, MAX_AVATARS);

  return (
    <li>
      <button
        type="button"
        className={
          'channel-row call-slot' + (joinDisabled ? ' cursor-not-allowed opacity-50' : '')
        }
        data-testid={`call-slot-${channelId}`}
        data-joined={joined || undefined}
        data-syncing={count === 0 || undefined}
        data-ringing={ringing || undefined}
        data-media-disabled={joinDisabled || undefined}
        aria-label={ringing && !joinDisabled ? `${ariaLabel} — ringing` : ariaLabel}
        title={joinDisabled ? MEDIA_DISABLED_TITLE : undefined}
        aria-disabled={joinDisabled || undefined}
        disabled={joinDisabled}
        onClick={handleClick}
      >
        <PhoneIcon size={14} className="call-slot-icon" />
        {/* Overlapping avatar stack: ringed
            identity tiles, cap at MAX_AVATARS, count beyond. An empty
            roster (SYNC in flight) renders muted placeholders so the live
            row is visible before the roster lands. */}
        {count === 0 ? (
          <span className="flex -space-x-1.5" aria-hidden data-testid="call-slot-placeholders">
            {[0, 1].map((i) => (
              <span
                key={i}
                className="flex h-5 w-5 items-center justify-center rounded-full bg-surface-strong text-[9px] font-semibold text-text-muted ring-2 ring-[var(--color-background)]"
                data-testid="call-slot-placeholder"
              >
                …
              </span>
            ))}
          </span>
        ) : (
          <span className="flex -space-x-1.5" aria-hidden data-testid="call-slot-avatars">
            {visibleRoster.map((participant) => {
              const isSpeaking = speaking?.has(participant.user_id) === true;
              const member = members?.[participant.user_id];
              // The shared Avatar (initials + image), not the snowflake's last
              // two DIGITS the stack used to print where initials belong.
              return (
                <Avatar
                  key={participant.user_id}
                  id={participant.user_id}
                  name={displayNameOf(
                    member && { ...member, nickname: nicknames?.[participant.user_id] ?? null },
                    '?',
                  )}
                  src={member?.avatar_url ?? null}
                  size={20}
                  data-testid="call-slot-avatar"
                  data-speaking={isSpeaking || undefined}
                  className={
                    'ring-2 ' +
                    (isSpeaking
                      ? 'ring-[var(--color-presence-online)]'
                      : 'ring-[var(--color-background)]')
                  }
                />
              );
            })}
          </span>
        )}
        {showCount ? (
          <span className="call-slot-count" data-testid={`call-slot-count-${channelId}`}>
            {count}
          </span>
        ) : null}
      </button>
    </li>
  );
}
