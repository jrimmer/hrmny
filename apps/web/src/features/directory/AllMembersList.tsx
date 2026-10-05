/**
 * @cytale/web — AllMembersList, the Home context's Members rail content.
 *
 * The cross-workspace aggregate of the workspace PeopleDirectory: every
 * member of every workspace the account belongs to, deduplicated by user
 * id (one identity, many memberships — the no-Friends doctrine means this
 * list is exactly "people you share a workspace with"), sorted by display
 * name. Rows mirror the directory's people rows (avatar tile, presence,
 * handle) and open the same ProfileCard overlay.
 */
import { Avatar, kindTitle } from '../../app/ui/UserAvatar.js';
import type { PeopleMember } from './types.js';
import { displayNameOf } from '@cytale/domain';

export interface AllMembersListProps {
  members: PeopleMember[];
  presence: Record<string, 'online' | 'idle' | 'dnd' | 'offline'>;
  /** Rail-header search text — client-side filter on name + handle. */
  query?: string;
  onSelectMember?: (member: PeopleMember) => void;
}

const displayName = (m: PeopleMember): string => displayNameOf({ ...m.user, nickname: m.nickname });

export function AllMembersList({ members, presence, query = '', onSelectMember }: AllMembersListProps) {
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? members.filter(
        (m) =>
          displayName(m).toLowerCase().includes(needle) ||
          m.user.username.toLowerCase().includes(needle),
      )
    : members;

  if (visible.length === 0) {
    return (
      <div className="people-directory" data-testid="all-members-empty">
        <p className="home-empty">
          {needle ? `No members match “${query.trim()}”.` : 'No members yet — join or create a workspace.'}
        </p>
      </div>
    );
  }

  // The directory's attribution (PeopleDirectory's parentNameOf): a machine
  // principal's seal names the human it belongs to, resolved from the rows.
  const parentNameOf = (m: PeopleMember): string | undefined => {
    if (!m.parent_user_id) return undefined;
    const row = members.find((r) => r.user.id === m.parent_user_id);
    return row ? displayName(row) : undefined;
  };

  const sorted = [...visible].sort((a, b) =>
    displayName(a).localeCompare(displayName(b)),
  );

  return (
    <div className="people-directory" data-testid="all-members-list">
      <ul className="people-list" role="listbox" aria-label="All members" tabIndex={-1}>
        {sorted.map((m) => {
          const status = presence[m.user.id] ?? 'offline';
          const name = displayName(m);
          return (
            <li
              key={m.user.id}
              role="option"
              tabIndex={0}
              aria-selected={false}
              data-testid={`all-members-row-${m.user.id}`}
              className="flex cursor-pointer items-center gap-3 rounded-md px-4 py-1.5 transition-colors duration-[var(--duration-control)] hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
              onClick={() => onSelectMember?.(m)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelectMember?.(m);
                }
              }}
            >
              <Avatar
                id={m.user.id}
                name={name}
                src={m.user.avatar_url}
                className="people-avatar"
                data-presence={status}
                kind={m.kind}
                parentName={parentNameOf(m)}
              />
              <span className="people-identity">
                <span className="people-name">{name}</span>
                <span className="people-handle">@{m.user.username}</span>
              </span>
              {kindTitle(m.kind, parentNameOf(m)) ? (
                <span className="sr-only">{kindTitle(m.kind, parentNameOf(m))}</span>
              ) : null}
              {/* Presence renders on the avatar (bottom-right dot); the word
                  stays for screen readers. */}
              <span className="sr-only">{status}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
