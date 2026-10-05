/**
 * @cytale/web — CategoryGroup (U20).
 *
 * A category header plus its child channels. The header is a section label
 * (aria-labelledby) so screen readers can navigate the grouped list; the
 * children are the channel rows.
 */

import type { ReactNode } from 'react';

export interface CategoryGroupProps {
  /** Category label — rendered as a section heading. */
  label: string;
  children: ReactNode;
}

export function CategoryGroup({ label, children }: CategoryGroupProps) {
  // An empty label is the UNGROUPED section: parentless channels render
  // first with no header (Discord's layout), still inside a labelled region
  // for assistive tech.
  const labelled = label !== '';
  return (
    <section aria-label={labelled ? label : 'Channels'} className="category">
      {labelled ? <h3 className="category-label">{label}</h3> : null}
      <ul className="category-channels">{children}</ul>
    </section>
  );
}
