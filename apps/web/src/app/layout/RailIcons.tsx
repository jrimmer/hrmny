/**
 * @cytale/web — the 4th column's three-mode toggle (owner direction
 * 2026-09-12).
 *
 * The column is HIDDEN until one of these is selected. Selecting an icon opens
 * the column in that mode; selecting the SAME icon again closes it; selecting a
 * different icon replaces the mode. The owner's words: *"A second tap on the
 * same icon would close the 4th column or the selection of another icon would
 * open that version (replacing the current). Then clicking on that icon again
 * would close it entirely."*
 *
 * Why this replaced a tab row inside the rail: a tab row answers "which surface
 * is in the column" and says nothing about whether the column should exist, so
 * those two questions ended up sharing one flag (`membersHidden`) — which is how
 * Home could only opt out of the member list by losing Call log and Threads
 * with it (#105). Splitting visibility from mode makes Home an ordinary case.
 *
 * Always visible, deliberately: the house hover-only rule (opacity-0 AND
 * pointer-inert at rest, zone reserved) was written for message actions, not
 * for the only way to open a whole region — and hover does not exist on touch.
 */
import { useEffect, useRef, type ReactNode } from 'react';

import { headerIconButtonClass } from '../ui/button.js';

export type RailMode = 'members' | 'calls' | 'threads';

/** The mode's heading, shared by every host so they cannot disagree. */
export const RAIL_TITLES: Record<RailMode, string> = {
  members: 'Members',
  calls: 'Call log',
  threads: 'Threads',
};

export interface RailIconsProps {
  /** The open mode, or null when the column is hidden. */
  mode: RailMode | null;
  /** Select a mode, or pass the open one to close it. */
  onSelect: (mode: RailMode) => void;
  /**
   * The modes this surface offers, in the usual order; all three when
   * omitted. Home offers Call log and Threads only — a member list outside a
   * room is the thing the owner removed from it (2026-09-14).
   */
  modes?: readonly RailMode[];
}

/** The shared header icon control (the phone topbar's call controls wear it too). */
const ICON_CLASS = headerIconButtonClass;

/** Toggled on: the selected pill (the channel-row idiom), not a colour. */
const ICON_ON = ' bg-surface-selected text-text-primary';

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      {children}
    </svg>
  );
}

const MODES: Array<{ mode: RailMode; label: string; glyph: ReactNode }> = [
  {
    mode: 'members',
    label: 'Members',
    glyph: (
      <Icon>
        <path
          d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h7v-2.5c0-.86.35-1.66.94-2.29C7.44 14.08 6.76 14 6 14zm10 0c-.29 0-.62.02-.97.05.69.63 1.12 1.47 1.12 2.45V19h6v-1.5c0-2.33-4.67-3.5-7-3.5zm-5 0c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"
          fill="currentColor"
        />
      </Icon>
    ),
  },
  {
    mode: 'calls',
    label: 'Call log',
    glyph: (
      <Icon>
        <path
          d="M6.6 10.8a15.6 15.6 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.24 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 11.4 11.4 0 0 0 .57 3.6 1 1 0 0 1-.25 1z"
          fill="currentColor"
        />
      </Icon>
    ),
  },
  {
    mode: 'threads',
    label: 'Threads',
    glyph: (
      <Icon>
        <path
          d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zm-3 10H7v-2h10v2zm0-4H7V6h10v2z"
          fill="currentColor"
        />
      </Icon>
    ),
  },
];

export function RailIcons({ mode, onSelect, modes }: RailIconsProps) {
  const buttons = useRef(new Map<RailMode, HTMLButtonElement | null>());

  /*
   * Escape closes the column and returns focus to the icon that opened it —
   * the plan named this and the first pass shipped without it, leaving a
   * keyboard user no quick way out of a region they can only leave by
   * re-pressing the same icon.
   *
   * Two deliberate details: it fires only while a mode is OPEN (so it never
   * competes with Escape while the column is closed), and it stands aside for
   * a dialog — the member profile, a call sheet or a settings takeover own
   * Escape while they are up, and closing the column underneath one would be
   * a surprise rather than a shortcut. No preventDefault: this is an
   * additional exit, not a claim on the key.
   *
   * It listens on WINDOW, after every document listener, and steps aside when
   * one of them already claimed the key (defaultPrevented): a surface INSIDE
   * the column — the member profile overlay — closes first, so one Escape
   * steps back to the list and a second closes the column.
   */
  useEffect(() => {
    if (mode === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const target = e.target;
      if (target instanceof Element && target.closest('[role="dialog"]')) return;
      const pressed = mode;
      onSelect(pressed);
      // Focus AFTER React commits the close: focusing synchronously loses the
      // focus when the column's subtree unmounts and the browser falls back to
      // <body>, which is exactly what the first attempt did.
      //
      // And at desktop that unmount now takes THIS instance's buttons with it:
      // while the column is open its three icons live in the COLUMN's header
      // (owner direction 2026-09-13), so closing it unmounts the very set whose
      // refs we hold — and `.focus()` on a detached node is a silent no-op that
      // leaves focus on <body> (the band gate caught exactly that). So the ref
      // map is trusted only while its node is still in the document, and the
      // fallback finds whichever set now renders the control (the pane
      // header's, at desktop).
      window.requestAnimationFrame(() => {
        const own = buttons.current.get(pressed);
        const target =
          own?.isConnected === true
            ? own
            : document.querySelector<HTMLButtonElement>(`[data-testid="rail-icon-${pressed}"]`);
        target?.focus();
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, onSelect]);

  return (
    <div className="rail-icons" role="group" aria-label="Side panels" data-testid="rail-icons">
      {MODES.filter(({ mode: m }) => modes === undefined || modes.includes(m)).map(({ mode: m, label, glyph }) => {
        const open = mode === m;
        return (
          <button
            key={m}
            type="button"
            ref={(el) => {
              buttons.current.set(m, el);
            }}
            className={ICON_CLASS + (open ? ICON_ON : '')}
            aria-pressed={open}
            aria-label={open ? `Hide ${label}` : `Show ${label}`}
            title={open ? `Hide ${label}` : `Show ${label}`}
            data-testid={`rail-icon-${m}`}
            data-open={open || undefined}
            onClick={() => onSelect(m)}
          >
            {glyph}
          </button>
        );
      })}
    </div>
  );
}
