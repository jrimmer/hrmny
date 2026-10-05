/**
 * @cytale/web — reaction emoji picker (reactions UI unit).
 *
 * Two-stage popover (Discord's quick-react shape):
 *   1. FAVORITES — the user's quick reactions (seeded with the default
 *      palette, persisted per browser, most-recently-used first) plus a
 *      trailing ＋ cell.
 *   2. The ＋ drills into the SAME full picker the composer uses
 *      (EmojiPickerPanel: search, frecents, the whole builtin catalog).
 *
 * Positioning: the popover flips above/below the trigger based on available
 * viewport space at open time (a message row near the window top has no
 * room above — the historical overlap/clipping), and right-aligns so it
 * never spills the right edge.
 *
 * Keyboard (house menu contract): arrows walk the cells, Enter picks (＋
 * opens the full panel), Escape closes and returns focus to the trigger,
 * outside click closes. The composer's panel keeps its own grid keyboard
 * while mounted.
 */

import { useEffect, useRef, useState } from 'react';

import { EmojiPickerPanel } from './EmojiPickerPanel.js';

/** The fixed reaction palette (task contract; order is the display order). */
export const REACTION_PALETTE: readonly string[] = [
  '👍',
  '👎',
  '❤️',
  '😂',
  '😮',
  '😢',
  '🎉',
  '👀',
];

// -- favorites (the quick grid) -------------------------------------------
// Personalized quick reactions: seeded with the default palette, persisted
// per browser, most-recently-used first. The USER SETTINGS task owns the
// editing UI; the storage helpers here are its seam.

const FAVORITES_KEY = 'cytale.reaction-favorites';
const FAVORITES_MAX = 8;

/**
 * The last parse, keyed by the RAW stored string (#14). Every picker reads the
 * favorites when it mounts, and pickers mount per row — the JSON.parse ran
 * once per row per mount. Keying on the raw value (not a flag) keeps the cache
 * honest when anything else writes the key: a different string re-parses.
 */
let favoritesCache: { raw: string | null; value: readonly string[] } | null = null;

export function readReactionFavorites(): string[] {
  let raw: string | null = null;
  try {
    raw = globalThis.localStorage?.getItem(FAVORITES_KEY) ?? null;
  } catch {
    raw = null;
  }
  if (favoritesCache !== null && favoritesCache.raw === raw) return [...favoritesCache.value];
  let value: readonly string[] = REACTION_PALETTE;
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')) {
      value = parsed.slice(0, FAVORITES_MAX);
    }
  } catch {
    // fall through to defaults
  }
  favoritesCache = { raw, value };
  return [...value];
}

export function writeReactionFavorites(favorites: string[]): void {
  try {
    globalThis.localStorage?.setItem(
      FAVORITES_KEY,
      JSON.stringify(favorites.slice(0, FAVORITES_MAX)),
    );
  } catch {
    // storage unavailable — favorites are best-effort
  }
}

/** Record a use: dedupe, most-recently-used first, capped. Best-effort. */
function bumpReactionFavorite(emoji: string): void {
  writeReactionFavorites([emoji, ...readReactionFavorites().filter((e) => e !== emoji)]);
}

/** Columns of the quick grid (drives the Up/Down step size). */
const GRID_COLS = 5;

/** Spoken names for aria-labels (emoji alone is not a useful label). */
const EMOJI_NAMES: Record<string, string> = {
  '👍': 'thumbs up',
  '👎': 'thumbs down',
  '❤️': 'heart',
  '😂': 'face with tears of joy',
  '😮': 'face with open mouth',
  '😢': 'crying face',
  '🎉': 'party popper',
  '👀': 'eyes',
};

/** Accessible name for one palette emoji (aria-label per emoji). */
export function reactionAriaLabel(emoji: string): string {
  return `React with ${EMOJI_NAMES[emoji] ?? emoji}`;
}

const cellClass =
  'flex h-10 w-10 items-center justify-center rounded-md text-xl leading-none ' +
  'text-text transition-colors duration-[var(--duration-control)] ' +
  'hover:bg-surface-hover focus-visible:outline-none focus-visible:bg-surface-hover ' +
  'focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]';

/** Monochrome outline-smiley glyph (the message toolbar's react affordance). */
const SMILEY_ICON_PATH =
  'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zM9 9.5a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0zm8.5 0a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0zM12 17.5c2.03 0 3.8-1.11 4.75-2.75h-9.5A5.47 5.47 0 0 0 12 17.5z';

const toolbarIconBtn =
  'flex h-10 w-10 items-center justify-center rounded-md text-text-muted ' +
  'transition-colors duration-[var(--duration-control)] ' +
  'hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]';

export interface ReactionPickerProps {
  /** Called with the picked emoji (the parent owns the toggle semantics). */
  onPick: (emoji: string) => void;
  /** Offline gate — the trigger disables with an explanatory title. */
  disabled?: boolean;
  /**
   * Trigger presentation: "chip" (default — the bordered ＋ in the reaction
   * chip row) or "icon" (a monochrome smiley matching the message hover
   * toolbar's SVG set). Popover behavior is identical.
   */
  variant?: 'chip' | 'icon';
  /** Emojis already applied to this message — dimmed + disabled in BOTH
   *  the quick grid and the full panel (removal rides the chips). */
  appliedEmojis?: readonly string[];
  /**
   * Mount with the favorites grid already open (U3: the message actions
   * sheet embeds the picker pre-opened — the "Add Reaction" sheet action
   * must not require a second tap on the trigger). Identical popover
   * behavior otherwise.
   */
  defaultOpen?: boolean;
}

export function ReactionPicker({
  onPick,
  disabled = false,
  variant = 'chip',
  appliedEmojis = [],
  defaultOpen = false,
}: ReactionPickerProps) {
  const [open, setOpen] = useState(defaultOpen);
  /** false = quick favorites grid; true = the full composer picker. */
  const [fullOpen, setFullOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const [favorites, setFavorites] = useState<string[]>(() => readReactionFavorites());
  /** 'above' | 'below' — decided against viewport space at open time. */
  const [placement, setPlacement] = useState<'above' | 'below'>('above');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  /** Hover-intent timer: pointer leaving the row/popover closes the picker
   *  after a short grace (crossing the anchor gap must NOT close it). */
  const leaveTimer = useRef<number | null>(null);

  const cells = [...favorites, '__more__'] as const;
  const total = cells.length;

  // Outside click closes.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setFullOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const openPicker = (): void => {
    setFocusIndex(0);
    setFullOpen(false);
    // Flip below when there is no room above the trigger (top-of-viewport
    // message rows clipped the popover historically).
    const r = triggerRef.current?.getBoundingClientRect();
    if (r) setPlacement(r.top < 300 ? 'below' : 'above');
    setOpen(true);
  };

  const close = (): void => {
    setOpen(false);
    setFullOpen(false);
    triggerRef.current?.focus();
  };

  /** Pointer-away close: same teardown, but BLUR the trigger — its retained
   *  focus pins the hover toolbar open via group-focus-within, which is the
   *  "mousing away doesn't clear the hover" bug. Keyboard closes (Escape)
   *  keep the focus-return contract. */
  const closeByPointer = (): void => {
    setOpen(false);
    setFullOpen(false);
    triggerRef.current?.blur();
  };

  const schedulePointerClose = (): void => {
    if (leaveTimer.current !== null) window.clearTimeout(leaveTimer.current);
    leaveTimer.current = window.setTimeout(() => {
      leaveTimer.current = null;
      closeByPointer();
    }, 160);
  };

  const cancelPointerClose = (): void => {
    if (leaveTimer.current !== null) {
      window.clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
  };

  // Never leak the timer.
  useEffect(
    () => () => {
      if (leaveTimer.current !== null) window.clearTimeout(leaveTimer.current);
    },
    [],
  );

  const choose = (emoji: string): void => {
    if (appliedEmojis.includes(emoji)) return; // already on the message
    bumpReactionFavorite(emoji);
    setFavorites(readReactionFavorites());
    onPick(emoji);
    close();
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'Tab') {
      // Focus escaping the menu dismisses it (focus-safe popover).
      setOpen(false);
      setFullOpen(false);
      return;
    }
    if (fullOpen) return; // the composer panel owns its keyboard there
    const n = total;
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
        if (focusIndex === cells.indexOf('__more__')) {
          setFullOpen(true);
        } else {
          const emoji = cells[focusIndex];
          if (typeof emoji === 'string' && !appliedEmojis.includes(emoji)) choose(emoji);
        }
        break;
      default:
        break;
    }
  };

  return (
    <div
      className="relative inline-flex"
      ref={rootRef}
      onKeyDown={open ? onKeyDown : undefined}
      onMouseEnter={open ? cancelPointerClose : undefined}
      onMouseLeave={open ? schedulePointerClose : undefined}
      data-testid="reaction-picker-root"
    >
      {variant === 'icon' ? (
        <button
          type="button"
          ref={triggerRef}
          className={toolbarIconBtn}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Add reaction"
          title={
            disabled
              ? 'You are offline — reactions are unavailable until reconnection'
              : 'Add reaction'
          }
          data-testid="reaction-add"
          disabled={disabled}
          onClick={() => {
            if (disabled) return;
            if (open) close();
            else openPicker();
          }}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path d={SMILEY_ICON_PATH} fill="currentColor" />
          </svg>
        </button>
      ) : (
        <button
          type="button"
          ref={triggerRef}
          className="flex h-6 items-center gap-0.5 rounded-full border border-line bg-surface px-2 text-xs text-text-muted transition-colors duration-[var(--duration-control)] hover:border-border-strong hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-line disabled:hover:text-text-muted"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Add reaction"
          title={
            disabled
              ? 'You are offline — reactions are unavailable until reconnection'
              : 'Add reaction'
          }
          data-testid="reaction-add"
          disabled={disabled}
          onClick={() => {
            if (disabled) return;
            if (open) close();
            else openPicker();
          }}
        >
          <span aria-hidden>＋</span>
        </button>
      )}

      {open ? (
        fullOpen ? (
          <div
            className={
              'absolute right-0 z-30 ' +
              (placement === 'above' ? 'bottom-full mb-1' : 'top-full mt-1')
            }
            data-testid="reaction-full-panel"
          >
            {/* The SAME full picker the composer hosts (search + frecents +
                catalog + shortcode footer) — one component, two hosts. */}
            <EmojiPickerPanel
              onPick={choose}
              onClose={close}
              disabledEmojis={appliedEmojis}
              insideRef={rootRef}
            />
          </div>
        ) : (
          <div
            className={
              // Track sizes are FIXED px (below): `1fr` in a shrink-to-fit
              // absolute popover collapses to the trigger's 40px containing
              // block (overlapping cells — the "emojis not spaced" bug), and
              // even with an explicit width, sub-pixel 1fr tracks shave the
              // gap. Fixed tracks + auto width = exact 40/4 geometry.
              'absolute right-0 z-30 grid gap-1 popover p-2 ' +
              (placement === 'above' ? 'bottom-full mb-1' : 'top-full mt-1')
            }
            style={{ gridTemplateColumns: `repeat(${GRID_COLS}, 40px)` }}
            role="menu"
            aria-label="Quick reactions"
            data-testid="reaction-picker"
          >
            {favorites.map((emoji, i) => {
              const applied = appliedEmojis.includes(emoji);
              return (
                <button
                  key={emoji}
                  type="button"
                  role="menuitem"
                  className={cellClass + (applied ? ' emoji-cell-applied' : '')}
                  aria-label={
                    applied
                      ? `${reactionAriaLabel(emoji)} — already applied`
                      : reactionAriaLabel(emoji)
                  }
                  title={applied ? 'Already applied — click the chip to remove' : undefined}
                  data-testid="reaction-favorite"
                  data-emoji={emoji}
                  data-applied={applied || undefined}
                  tabIndex={-1}
                  disabled={applied}
                  ref={i === focusIndex ? (el) => el?.focus() : undefined}
                  onClick={() => choose(emoji)}
                >
                  <span aria-hidden>{emoji}</span>
                </button>
              );
            })}
            <button
              type="button"
              role="menuitem"
              aria-label="More emoji"
              title="More emoji"
              className={cellClass}
              data-testid="reaction-more"
              tabIndex={-1}
              ref={
                focusIndex === favorites.length ? (el) => el?.focus() : undefined
              }
              onClick={() => setFullOpen(true)}
            >
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                <path
                  d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5z"
                  fill="currentColor"
                />
              </svg>
            </button>
          </div>
        )
      ) : null}
    </div>
  );
}
