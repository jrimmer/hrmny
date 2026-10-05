/**
 * @cytale/web — ProfileCard (U26, U12 attribution).
 *
 * Member profile card: name, handle, avatar placeholder, presence, role
 * badge, join date. Rendered when a directory row is selected. The "send DM"
 * action is a seam — DMs land with U9's DM surface; the card exposes the
 * callback and renders the affordance only when provided.
 *
 * U12: machine principals wear the avatar's robot seal (not a name-line tag). The
 * parent's display name arrives via the optional `parentName` seam (the
 * owning surface knows the roster; the card only gets one member) — without
 * it the badge degrades to the bare label, never crashes.
 */

import { ghostButtonSmClass } from '../../app/ui/button.js';
import { formatShortDate } from '../../app/ui/time.js';
import { Avatar, kindTitle } from '../../app/ui/UserAvatar.js';

import { PresenceIndicator } from '../presence/PresenceIndicator.js';

import type { PeopleMember, PresenceStatus } from './types.js';
import { displayNameOf } from '@cytale/domain';

export interface ProfileCardProps {
  member: PeopleMember;
  /** Presence status (U23 seam); defaults to offline. */
  presence?: PresenceStatus;
  /** Role badge labels keyed by role id (U7 seam); empty → no badge. */
  roleLabels?: Record<string, string>;
  /** Owning human's display name (U12 seam) for the kind badge's "via". */
  parentName?: string;
  /** Called when the "Send DM" action is invoked (U9 DM surface seam). */
  onSendDm?: (member: PeopleMember) => void;
  /** "Change nickname" (#169): offered when the host may rename this member. */
  onChangeNickname?: (member: PeopleMember) => void;
}

export function ProfileCard({
  member,
  presence = 'offline',
  roleLabels = {},
  parentName,
  onSendDm,
  onChangeNickname,
}: ProfileCardProps) {
  const displayName = displayNameOf({ ...member.user, nickname: member.nickname });
  const roleBadge = member.roles.map((r) => roleLabels[r]).find(Boolean);

  return (
    <div className="profile-card" data-testid="profile-card" role="region" aria-label={`${displayName} profile`}>
      <Avatar
        id={member.user.id}
        name={displayName}
        src={member.user.avatar_url}
        className="profile-avatar"
        kind={member.kind}
        parentName={parentName}
      />
      <div className="flex items-center gap-2">
        <h3 className="profile-name">{displayName}</h3>
        {kindTitle(member.kind, parentName) ? (
          <span className="sr-only">{kindTitle(member.kind, parentName)}</span>
        ) : null}
      </div>
      <p className="profile-handle">@{member.user.username}</p>
      <p className="profile-presence" data-presence={presence}>
        <PresenceIndicator status={presence} label={`${displayName} is ${presence}`} />
        <span className="profile-presence-text">{presence}</span>
      </p>
      {roleBadge ? <span className="profile-role">{roleBadge}</span> : null}
      {member.joined_at ? (
        <p className="profile-joined">Joined {formatShortDate(member.joined_at)}</p>
      ) : null}
      {onSendDm ? (
        <button
          type="button"
          onClick={() => onSendDm(member)}
          data-testid="profile-send-dm"
          className={ghostButtonSmClass}
        >
          Send DM
        </button>
      ) : null}
      {onChangeNickname ? (
        <button
          type="button"
          onClick={() => onChangeNickname(member)}
          data-testid="profile-change-nickname"
          className={ghostButtonSmClass}
        >
          Change nickname
        </button>
      ) : null}
    </div>
  );
}
