/**
 * @cytale/web — HeaderActionsMenu, the shared column-header actions menu.
 *
 * Owner direction 2026-09-12: the column headers centralise on a **gear**.
 * Two triggers used to compete for the same job — the workspace name carried a
 * dropdown caret and the ⋯ Actions button opened a menu that only repeated
 * what the workspace menu already offered ("Create channel") — so the caret is
 * gone, the ⋯ is gone, and one gear in the header's right slot opens the
 * column's actions. The Home column uses this component for its own menu.
 *
 * The SAME primitive as WorkspaceMenu / ChannelContextMenu (UI consistency,
 * 2026-09-27): Radix DropdownMenu through the house wrapper. The hand-rolled
 * role=menu it replaced had no arrow-key roving, never moved focus into the
 * menu, and Escape did not hand focus back to the gear — every menu in the
 * app now shares one keyboard contract: the trigger toggles, arrows rove,
 * Enter/Space activate, Escape closes and returns focus to the trigger,
 * outside click closes.
 */
import type { ReactNode } from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/shadcn/dropdown-menu.js';

/**
 * The gear glyph shared by every column-header actions trigger, WorkspaceMenu's
 * settings entry, and the identity panel's settings toggle — one path so the
 * gears cannot drift.
 *
 * `size` exists for the identity panel, which sat a bare `⚙` emoji in a row of
 * transport glyphs (owner report 2026-09-14: "please expand the size of the
 * gear there … make it similar in scale to the headphone icon beside it").
 * U+2699 without its emoji variation selector renders in the *text*
 * presentation — a small dingbat that reads a third smaller than the 🎧 next to
 * it — and an emoji glyph ignores `color` outright, so the panel's hover tint
 * was a no-op on that one control. Drawing it instead fixes both.
 */
export function GearIcon({ size = 16 }: { size?: number } = {}) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path
        d="M19.4 13c.04-.32.06-.66.06-1s-.02-.68-.07-1l2.1-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.61-.22l-2.49 1a7.3 7.3 0 0 0-1.73-1l-.38-2.65A.5.5 0 0 0 13.9 2h-4a.5.5 0 0 0-.5.42L9.02 5.07a7.3 7.3 0 0 0-1.73 1l-2.49-1a.5.5 0 0 0-.61.22l-2 3.46a.5.5 0 0 0 .12.64L4.42 11c-.05.32-.07.66-.07 1s.02.68.07 1l-2.1 1.65a.5.5 0 0 0-.12.64l2 3.46c.13.22.4.31.61.22l2.49-1c.54.4 1.11.74 1.73 1l.38 2.65c.04.24.25.42.5.42h4c.25 0 .46-.18.5-.42l.38-2.65c.62-.26 1.2-.6 1.73-1l2.49 1c.22.09.48 0 .61-.22l2-3.46a.5.5 0 0 0-.12-.64L19.4 13zM11.9 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"
        fill="currentColor"
      />
    </svg>
  );
}

export interface HeaderActionItem {
  label: string;
  testId: string;
  onSelect: () => void;
  icon?: ReactNode;
}

export interface HeaderActionsMenuProps {
  /** Accessible name + tooltip for the gear trigger. */
  triggerLabel: string;
  triggerTestId: string;
  menuTestId: string;
  items: HeaderActionItem[];
  /** Trigger glyph; defaults to the gear. */
  triggerIcon?: ReactNode;
}

export function HeaderActionsMenu({
  triggerLabel,
  triggerTestId,
  menuTestId,
  items,
  triggerIcon,
}: HeaderActionsMenuProps) {
  return (
    <div className="header-actions">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="home-add"
            aria-label={triggerLabel}
            title={triggerLabel}
            data-testid={triggerTestId}
          >
            {triggerIcon ?? <GearIcon />}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className="header-actions-menu"
          align="end"
          sideOffset={6}
          aria-label={triggerLabel}
          data-testid={menuTestId}
        >
          {items.map((item) => (
            <DropdownMenuItem
              key={item.testId}
              className="header-actions-item"
              data-testid={item.testId}
              onSelect={() => item.onSelect()}
            >
              {item.icon ? (
                <span aria-hidden="true" className="header-actions-item-icon">
                  {item.icon}
                </span>
              ) : null}
              {item.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
