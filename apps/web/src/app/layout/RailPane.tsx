/**
 * @cytale/web — the 4th column's content, rendered in the PANE at tablet.
 *
 * Below 1280px the shell has no fourth grid track (`shell.css`), so the
 * selected mode cannot dock as a column and REPLACES the message pane instead.
 * That is the same trade the band contract already makes for members, now
 * generalised to whichever of the three modes is selected.
 *
 * The three icons render inside this header too, in the same corner as on a
 * channel — so opening and closing the column never moves the control, and the
 * pressed state is visible in both. (This was `MembersPane` with a single
 * members toggle; the owner's 2026-09-12 direction made the column serve three
 * modes, so the name and the toggle both had to widen.)
 */
import type { ReactNode } from 'react';

import { RAIL_TITLES, RailIcons, type RailMode } from './RailIcons.js';

export interface RailPaneProps {
  /** The open mode — this pane only exists while one is selected. */
  mode: RailMode;
  /**
   * The host's toggle: it decides whether a selection closes the column (same
   * icon) or replaces the mode (a different one), so that rule lives in exactly
   * one place rather than being re-implemented per host.
   */
  onSelectMode: (mode: RailMode) => void;
  /** The modes the surface offers (RailIcons' `modes`); all three when omitted. */
  modes?: readonly RailMode[];
  /** The rail's content for the current mode (the host composes it). */
  children: ReactNode;
}

export function RailPane({ mode, onSelectMode, modes, children }: RailPaneProps) {
  return (
    <div className="members-pane" data-testid="rail-pane" data-mode={mode}>
      {/* The header carries the controls — the three mode icons, and the
          search toggle riding up from the rail's own body (user direction
          2026-09-13) — while the mode's NAME labels the contents below it. */}
      <header className="pane-header">
        <RailIcons mode={mode} onSelect={onSelectMode} modes={modes} />
      </header>
      <div className="members-pane-band">
        <h2 className="members-pane-title">{RAIL_TITLES[mode]}</h2>
      </div>
      <div className="members-pane-body">{children}</div>
    </div>
  );
}
