/**
 * @cytale/web — MemberList (U18).
 *
 * Right rail (360px, collapsible per measured Discord geometry). U18 ships
 * the container; U26 fills the people directory. Collapse is a consumer
 * concern (AppShell responsive contract); the rail itself renders its
 * heading + content.
 */
import type { ReactNode } from 'react';

export interface MemberListProps {
  heading?: string;
  children: ReactNode;
}

export function MemberList({ heading = 'Members', children }: MemberListProps) {
  return (
    <div className="members-inner" role="presentation">
      <h2 className="members-heading">{heading}</h2>
      {children}
    </div>
  );
}
