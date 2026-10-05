/**
 * @cytale/web — ChannelSidebar (U18).
 *
 * Category + channel list (second region). U18 ships the structural shell:
 * named groups (categories) with channel rows; U20 fills live data. Selection
 * language per corpus §6.4: neutral pill (`bg-surface-selected`) for the
 * active channel — color stays reserved for meaning (unread bars, mention
 * counts).
 */
import type { ReactNode } from 'react';

export interface ChannelSidebarProps {
  children: ReactNode;
}

export function ChannelSidebar({ children }: ChannelSidebarProps) {
  return <div className="sidebar-inner">{children}</div>;
}

export interface ChannelCategoryProps {
  /** Category label — rendered as a section heading. */
  label: string;
  children: ReactNode;
}

export function ChannelCategory({ label, children }: ChannelCategoryProps) {
  return (
    <section aria-label={label} className="category">
      <h3 className="category-label">{label}</h3>
      {children}
    </section>
  );
}
