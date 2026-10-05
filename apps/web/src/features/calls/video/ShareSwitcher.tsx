/**
 * @cytale/web — the screen-share switcher (calls V2 plan U5, VM4/VM21/VM22).
 *
 * VM4: multiple simultaneous shares are allowed and the switcher lists all
 * of them. It renders ONLY when more than one share is live — with a single
 * share there is nothing to switch (the presenter bar alone names it), and
 * with none the stage itself is collapsed (VM22).
 *
 * Keyboard: the house menu contract (ReactionPicker/PresenceMenu lineage) —
 * ArrowUp/Down move, Enter/Space select, Escape closes and returns focus to
 * the trigger, outside click closes, Tab escaping the menu dismisses it.
 * The current selection reads as aria-checked AND a "Showing" glyph (never
 * color alone). VM21: a switch announces through a persistent polite live
 * region ("Showing <name>'s screen").
 *
 * VM22: `mode` is display-only honesty (the machine lives in the parent via
 * stageSelection.ts) — the menu footer states whether the stage follows the
 * latest share, holds the viewer's choice, or is pinned.
 */

import { useEffect, useRef, useState } from 'react';

import type { StageSelectionMode } from './stageSelection.js';

/** One live share as the switcher needs it (the composition maps rosters). */
export interface SwitcherShare {
  shareId: string;
  presenterName: string;
  /** What is shared ("Entire screen", "Window — Reports"); default "screen". */
  sourceLabel?: string;
}

export interface ShareSwitcherProps {
  /** All live shares (render gate: length > 1). */
  shares: SwitcherShare[];
  /** The share currently staged (aria-checked + "Showing" glyph). */
  activeShareId: string | null;
  /** VM22 mode surfaced in the menu footer. */
  mode: StageSelectionMode;
  /** VM22: selection → the parent transitions to viewer-selected. */
  onSelect: (shareId: string) => void;
}

const MODE_FOOTER: Record<StageSelectionMode, string> = {
  'follow-recent': 'Stage follows the most recent share',
  'viewer-selected': 'Showing your choice — new shares will not take the stage',
  pinned: 'Pinned — stays on stage until unpinned',
};

const TRIGGER_CLASS =
  'flex h-10 min-w-10 items-center justify-center gap-1.5 rounded-md px-2 text-sm font-medium ' +
  'transition-colors duration-[var(--duration-control)] hover:bg-surface-hover ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] ' +
  'text-text-muted';

export function ShareSwitcher({ shares, activeShareId, mode, onSelect }: ShareSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // Outside click closes (pointer dismissal) — the house popover rule.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  if (shares.length <= 1) return null;

  const close = (): void => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const choose = (shareId: string): void => {
    onSelect(shareId);
    close();
  };

  const step = (delta: number): void => {
    const n = shares.length;
    setFocusIndex((i) => (i + delta + n * Math.ceil(Math.abs(delta) / n)) % n);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        step(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        step(-1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        choose(shares[focusIndex]?.shareId ?? shares[0]!.shareId);
        break;
      case 'Escape':
        e.preventDefault();
        close();
        break;
      case 'Tab':
        // Focus escaping the menu dismisses it (focus-safe popover).
        setOpen(false);
        break;
      default:
        break;
    }
  };

  const active = shares.find((s) => s.shareId === activeShareId) ?? null;

  return (
    <div
      className="relative inline-flex"
      ref={rootRef}
      onKeyDown={open ? onKeyDown : undefined}
      data-testid="share-switcher-root"
      data-mode={mode}
    >
      <button
        type="button"
        ref={triggerRef}
        className={TRIGGER_CLASS}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Switch screen share (${shares.length} live)`}
        data-testid="share-switcher-trigger"
        onClick={() => {
          const current = shares.findIndex((s) => s.shareId === activeShareId);
          setFocusIndex(current >= 0 ? current : 0);
          setOpen((o) => !o);
        }}
      >
        <span aria-hidden>🖥⇄</span>
        <span aria-hidden className="text-xs">
          {shares.length}
        </span>
      </button>

      {open ? (
        <div
          className="absolute top-full right-0 z-30 mt-1 flex w-64 flex-col gap-0.5 popover p-1.5"
          role="menu"
          aria-label="Screen shares"
          data-testid="share-switcher-menu"
        >
          {shares.map((share, i) => {
            const isActive = share.shareId === activeShareId;
            return (
              <button
                key={share.shareId}
                type="button"
                role="menuitemradio"
                className={
                  'flex min-h-10 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ' +
                  'text-text-primary transition-colors duration-[var(--duration-control)] ' +
                  'hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none ' +
                  'focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]'
                }
                aria-checked={isActive}
                aria-label={`${share.presenterName}'s ${share.sourceLabel ?? 'screen'}`}
                data-testid="share-switcher-option"
                data-share-id={share.shareId}
                tabIndex={-1}
                ref={i === focusIndex ? (el) => el?.focus() : undefined}
                onClick={() => choose(share.shareId)}
              >
                <span aria-hidden className="w-4 shrink-0 text-center text-xs">
                  {isActive ? '●' : ''}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {share.presenterName}
                  <span className="text-text-muted"> · {share.sourceLabel ?? 'screen'}</span>
                </span>
                {isActive ? (
                  <span
                    className="shrink-0 rounded-full bg-surface-hover px-1.5 py-0.5 text-[11px] text-text-primary"
                    data-testid="share-switcher-showing"
                  >
                    Showing
                  </span>
                ) : null}
              </button>
            );
          })}
          {/* VM22 mode honesty (plain text — never color alone). */}
          <p
            className="mt-1 border-t border-line px-2 pb-0.5 pt-1.5 text-[11px] text-text-muted"
            data-testid="share-switcher-mode"
          >
            {MODE_FOOTER[mode]}
          </p>
        </div>
      ) : null}

      {/* VM21: the switch announces politely. */}
      <div
        role="status"
        aria-live="polite"
        className="sr-only"
        data-testid="share-switcher-announce"
      >
        {active
          ? `Showing ${active.presenterName}'s ${active.sourceLabel ?? 'screen'}`
          : ''}
      </div>
    </div>
  );
}
