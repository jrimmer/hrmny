/**
 * @cytale/web — composer emoji picker (Discord-style popover).
 *
 * Search field over the builtin catalog, a Frequently Used row (localStorage
 * frecents), then the full grid — click inserts into the message line. The
 * footer echoes the hovered/focused emoji's shortcodes (Discord's bottom
 * bar). Keyboard: arrows walk the grid, Enter picks, Escape closes and
 * returns focus to the trigger. GIFs/Stickers tabs are intentionally absent
 * (no such surfaces yet) — the picker is emoji-only.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import {
  bumpFrecentEmoji,
  canonicalShortcode,
  readFavoriteEmoji,
  readFrecentEmoji,
  searchEmojiCatalog,
  shortcodesFor,
} from './emojiCatalog.js';

export interface EmojiPickerPanelProps {
  onPick: (emoji: string) => void;
  /** Close request (Escape — focus returns to the trigger). */
  onClose: () => void;
  testId?: string;
  /** Emojis already applied to the target — dimmed + disabled (reactions
   *  surface: removal rides the chips, not the picker). */
  disabledEmojis?: readonly string[];
  /**
   * The host's own region (the element holding the TRIGGER): a pointer-down
   * inside it is not an outside click. Without it, clicking the trigger to
   * close closed the panel on mousedown and the trigger's click re-opened it.
   */
  insideRef?: React.RefObject<HTMLElement | null>;
  /**
   * False when the host is a Radix Popover, which owns outside-dismiss (and
   * already excludes its trigger) — two dismiss layers would race.
   */
  dismissOnOutsideClick?: boolean;
}

const GRID_COLS = 9;

const searchInputClass =
  'w-full rounded-md border border-line bg-input px-3 py-2 text-sm text-text ' +
  'placeholder-shown:text-text-muted outline-none focus-visible:border-accent ' +
  'focus-visible:ring-1 focus-visible:ring-[var(--color-focus)]';

const cellClass =
  'flex h-9 w-9 items-center justify-center rounded-md text-xl leading-none ' +
  'transition-colors duration-[var(--duration-control)] hover:bg-surface-hover ' +
  'focus-visible:outline-none focus-visible:bg-surface-hover focus-visible:ring-2 ' +
  'focus-visible:ring-[var(--color-focus)]';

export function EmojiPickerPanel({
  onPick,
  onClose,
  testId = 'emoji-picker-panel',
  disabledEmojis = [],
  insideRef,
  dismissOnOutsideClick = true,
}: EmojiPickerPanelProps) {
  const isDisabled = (emoji: string): boolean => disabledEmojis.includes(emoji);
  const [query, setQuery] = useState('');
  const [hovered, setHovered] = useState<string | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Outside click closes — "outside" excludes the host's trigger region.
  useEffect(() => {
    if (!dismissOnOutsideClick) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (insideRef?.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [onClose, insideRef, dismissOnOutsideClick]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const rows = useMemo(() => searchEmojiCatalog(query), [query]);
  // Catalog membership filter (shared by favorites + frecents rows): storage
  // may hold emoji a catalog update since dropped — never render unknowns.
  const known = useMemo(() => new Set(searchEmojiCatalog('').map((r) => r.e)), []);
  const favorites = useMemo(() => {
    if (query.trim()) return [];
    return readFavoriteEmoji().filter((e) => known.has(e));
  }, [query, known]);
  const frecents = useMemo(() => {
    if (query.trim()) return [];
    const set = new Set(readFrecentEmoji());
    return [...set].filter((e) => known.has(e)).slice(0, 8);
  }, [query, known]);

  const gridRows = rows;
  const totalCells = gridRows.length;
  const clamped = totalCells > 0 ? Math.min(focusIndex, totalCells - 1) : 0;
  const focusedEmoji = gridRows[clamped]?.e ?? null;
  const footerEmoji = hovered ?? focusedEmoji;
  const footerShortcodes = footerEmoji ? shortcodesFor(footerEmoji) : [];

  const pick = (emoji: string): void => {
    if (isDisabled(emoji)) return;
    bumpFrecentEmoji(emoji);
    onPick(emoji);
    // Composer pick closes the panel (focus returns via the host toggle).
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    const n = totalCells;
    if (n === 0) return;
    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault();
        setFocusIndex((i) => (Math.min(i, n - 1) + 1) % n);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        setFocusIndex((i) => (Math.min(i, n - 1) - 1 + n) % n);
        break;
      case 'ArrowDown':
        e.preventDefault();
        setFocusIndex((i) => (Math.min(i, n - 1) + GRID_COLS) % n);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setFocusIndex((i) => (Math.min(i, n - 1) - GRID_COLS + n * GRID_COLS) % n);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (gridRows[clamped]) pick(gridRows[clamped].e);
        break;
      default:
        break;
    }
  };

  return (
    <div
      ref={rootRef}
      className="emoji-panel"
      role="dialog"
      aria-label="Emoji picker"
      data-testid={testId}
      onKeyDown={onKeyDown}
    >
      <input
        ref={inputRef}
        type="text"
        className={searchInputClass}
        placeholder="Find the perfect emoji"
        aria-label="Search emoji"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setFocusIndex(0);
        }}
        data-testid="emoji-search"
      />

      <div className="emoji-panel-grid" role="listbox" aria-label="Emoji" data-testid="emoji-grid">
        {favorites.length > 0 && !query.trim() ? (
          <>
            <div className="emoji-panel-section" aria-hidden="true">
              Favorites
            </div>
            {favorites.map((emoji) => (
              <button
                key={`fav-${emoji}`}
                type="button"
                role="option"
                aria-selected={false}
                className={cellClass}
                title={`:${canonicalShortcode(emoji) ?? emoji}:`}
                aria-label={`Insert ${emoji}`}
                data-testid="emoji-cell"
                data-emoji={emoji}
                data-favorite="true"
                onMouseEnter={() => setHovered(emoji)}
                onMouseLeave={() => setHovered(null)}
                onClick={() => pick(emoji)}
              >
                {emoji}
              </button>
            ))}
            <div className="emoji-panel-section" aria-hidden="true">
              Frequently Used
            </div>
          </>
        ) : null}
        {frecents.length > 0 && !query.trim() ? (
          <>
            {favorites.length === 0 ? (
              <div className="emoji-panel-section" aria-hidden="true">
                Frequently Used
              </div>
            ) : null}
            {frecents.map((emoji) => (
              <button
                key={`freq-${emoji}`}
                type="button"
                role="option"
                aria-selected={false}
                className={cellClass + (isDisabled(emoji) ? ' emoji-cell-applied' : '')}
                title={`:${canonicalShortcode(emoji) ?? emoji}:`}
                aria-label={`Insert ${emoji}`}
                data-testid="emoji-cell"
                data-emoji={emoji}
                data-applied={isDisabled(emoji) || undefined}
                disabled={isDisabled(emoji)}
                onMouseEnter={() => setHovered(emoji)}
                onMouseLeave={() => setHovered(null)}
                onClick={() => pick(emoji)}
              >
                {emoji}
              </button>
            ))}
            <div className="emoji-panel-section" aria-hidden="true">
              All
            </div>
          </>
        ) : null}
        {gridRows.map((row, i) => (
          <button
            key={`${row.n}-${i}`}
            type="button"
            role="option"
            aria-selected={i === clamped}
            className={cellClass + (isDisabled(row.e) ? ' emoji-cell-applied' : '')}
            title={`:${row.n}:`}
            aria-label={`Insert ${row.e} :${row.n}:`}
            data-testid="emoji-cell"
            data-emoji={row.e}
            data-applied={isDisabled(row.e) || undefined}
            tabIndex={i === clamped ? 0 : -1}
            disabled={isDisabled(row.e)}
            ref={i === clamped ? (el) => el?.focus() : undefined}
            onMouseEnter={() => setHovered(row.e)}
            onMouseLeave={() => setHovered(null)}
            onClick={() => pick(row.e)}
          >
            {row.e}
          </button>
        ))}
        {gridRows.length === 0 ? (
          <p className="emoji-panel-empty" data-testid="emoji-empty">
            No emoji match “{query.trim()}”.
          </p>
        ) : null}
      </div>

      <div className="emoji-panel-footer" data-testid="emoji-footer">
        {footerEmoji ? (
          <>
            <span aria-hidden className="emoji-panel-footer-emoji">
              {footerEmoji}
            </span>
            <span className="emoji-panel-footer-codes">
              {footerShortcodes.map((code) => (
                <span key={code}>{`:${code}:`}</span>
              ))}
            </span>
          </>
        ) : (
          <span className="emoji-panel-footer-codes">Pick an emoji to insert</span>
        )}
      </div>
    </div>
  );
}
