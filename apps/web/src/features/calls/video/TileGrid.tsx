/**
 * @cytale/web — the video tile grid (calls V2 plan U5).
 *
 * Renders N participants as Tiles: live video within the receiver's budget,
 * avatar tiles beyond it (the parent computes which — VM18's honesty is the
 * Tile's chip, the budget decision is U5b's). Layout is a responsive CSS
 * grid (`.video-grid`) or, while the stage dominates on mobile, the
 * collapsed thumbnail strip (`.video-grid[data-variant='strip']` — VM19).
 *
 * Keyboard: every tile is a real button (native Tab), plus Arrow-key focus
 * movement across the grid (wrapping) for the house grid pattern.
 *
 * States-first mapping (UX_SPEC §9, per the plan's U5 enumeration):
 *   empty        → no publishers: named empty state + next-step hint
 *   loading      → per-tile skeletons (Tile's own surface)
 *   error        → per-tile track-failure alerts (Tile's own surface)
 *   offline      → all tiles frozen (parent passes frozen on each)
 *   view-only    → budget floor: participants render connection-paused
 *                  avatars (VM18) — the grid adds the explicit note
 *   perm-denied  → lives on the CONTROLS (SEND_VIDEO off pre-disabled —
 *                  CapabilityDisabledButton/QualityPicker), not the grid
 *
 * VM18's polite live region: budget step-downs announce through
 * `announcement` (the parent composes "showing N live tiles" on change).
 */

import { useRef, type KeyboardEvent } from 'react';

import { Tile, type TileVideoState } from './Tile.js';

export interface GridParticipant {
  userId: string;
  name: string;
  /** Parent-computed tile state (budget-aware). */
  state: TileVideoState;
  stream?: unknown;
  speaking?: boolean;
  frozen?: boolean;
  isSelf?: boolean;
}

export interface TileGridProps {
  participants: GridParticipant[];
  /**
   * Polite-region text (VM18). Rendered into a persistent sr-only
   * role=status node so live updates fire — pass '' between announcements.
   */
  announcement?: string;
  /** Grid (default) or VM19's collapsed thumbnail strip. */
  variant?: 'grid' | 'strip';
  /** VM21: tile activation → enlarge. */
  onEnlarge?: (userId: string) => void;
  /** Empty-state hint override (defaults to the camera copy). */
  emptyHint?: string;
}

const ARROWS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

export function TileGrid({
  participants,
  announcement = '',
  variant = 'grid',
  onEnlarge,
  emptyHint,
}: TileGridProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Arrow-key focus movement across the tile buttons (wrapping).
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!ARROWS.has(e.key)) return;
    const tiles = Array.from(
      rootRef.current?.querySelectorAll<HTMLButtonElement>('button[data-testid="video-tile"]') ??
        [],
    );
    if (tiles.length === 0) return;
    e.preventDefault();
    const current = tiles.indexOf(document.activeElement as HTMLButtonElement);
    const columns = variant === 'strip' ? 1 : Math.max(1, estimateColumns(rootRef.current));
    const delta =
      e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' ? columns : -columns;
    const next = current < 0 ? 0 : (current + delta + tiles.length) % tiles.length;
    tiles[next]?.focus();
  };

  if (participants.length === 0) {
    return (
      <div
        className="rounded-md border border-line bg-surface-hover px-3 py-4 text-center"
        data-testid="video-grid-empty"
      >
        <p className="text-sm font-semibold text-text-primary">No one is on camera</p>
        <p className="mt-1 text-sm text-text-muted">
          {emptyHint ?? 'Turn your camera on — or wait for someone else to.'}
        </p>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className="video-grid"
      data-variant={variant}
      role="group"
      aria-label="Video tiles"
      data-testid="video-grid"
      onKeyDown={onKeyDown}
    >
      {participants.map((p) => (
        <Tile
          key={p.userId}
          userId={p.userId}
          name={p.name}
          state={p.state}
          stream={p.stream}
          speaking={p.speaking}
          frozen={p.frozen}
          mirrored={p.isSelf === true}
          compact={variant === 'strip'}
          onEnlarge={onEnlarge}
        />
      ))}
      {/* VM18: budget step-down announcements (persistent node). */}
      <div
        role="status"
        aria-live="polite"
        className="sr-only"
        data-testid="video-grid-announce"
      >
        {announcement}
      </div>
    </div>
  );
}

/**
 * Column estimate for vertical arrows (the CSS grid auto-fills from a
 * minmax track, so an exact count needs layout jsdom lacks — the common
 * narrow-panel case is one column, which the minmax floor approximates).
 */
function estimateColumns(root: HTMLDivElement | null): number {
  if (!root) return 1;
  const width = root.clientWidth;
  if (width <= 0) return 1;
  return Math.max(1, Math.floor(width / 196));
}
