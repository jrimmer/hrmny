/**
 * @cytale/web — where a reader was in a conversation, as a CONTENT anchor (#13).
 *
 * Leaving a channel and coming back must put the reader on the same line they
 * were reading. The list used to save Virtuoso's pixel offset plus its
 * measured size ranges and hand both back through `restoreStateFrom`. The
 * offset came back exactly, but the list above the viewport did not: Virtuoso
 * replays saved sizes as RANGES of equal-height rows, and a timeline's rows
 * are anything but equal (author-group gaps, date dividers, image boxes,
 * wrapped text). On return the rows above measured ~250px taller than when the
 * offset was taken, and the same scrollTop showed a line four rows up.
 *
 * So the position is saved as WHAT the reader was looking at, not where the
 * scrollbar was: the top visible row's key plus how far that row sat above
 * (or below) the viewport's top edge. A return renders around that row, puts
 * it at the same offset, and then re-measures the row itself and corrects
 * the difference until the layout settles. Nothing above the row enters
 * the sum, so no estimate or replayed size for those rows can move it.
 *
 * The logic here is pure (plus one DOM read). The list wires it to its scroll
 * events, its unmount, and Virtuoso's `initialTopMostItemIndex` /
 * `totalListHeightChanged`.
 */

/** The row a reader was looking at, and where it sat in the viewport. */
export interface ReadingAnchor {
  /** The row's stable key (`client_key ?? id`, see the list's `rowKey`). */
  key: string;
  /** The row's server id, used to fetch its neighbourhood if it left the window. */
  id: string;
  /**
   * Pixels of the row ABOVE the viewport's top edge (`viewportTop - rowTop`).
   * Positive: the row is partly scrolled out; negative: it starts below the
   * edge (e.g. under the history band at the top of the list).
   */
  offset: number;
}

/**
 * A saved position: at the live edge (the return lands on the newest message
 * and follows), or anchored to a row.
 */
export type ReadingPosition = { atBottom: true } | { atBottom: false; anchor: ReadingAnchor };

/** Per-conversation saved positions (keyed by the list's `visitKey`). */
const positions = new Map<string, ReadingPosition>();

export function rememberReadingPosition(visitKey: string, position: ReadingPosition): void {
  positions.set(visitKey, position);
}

export function recallReadingPosition(visitKey: string): ReadingPosition | undefined {
  return positions.get(visitKey);
}

/** Test seam: forget every saved position. */
export function forgetReadingPositions(): void {
  positions.clear();
}

/** One rendered row's vertical extent, in viewport coordinates. */
export interface RowBox {
  /** The row's index in the list's data (chat order). */
  index: number;
  top: number;
  bottom: number;
}

/**
 * The row at the top of the view: the first whose bottom edge is below the
 * viewport's top (a sub-pixel sliver does not count; it is not being read).
 * `offset` is how far the row's top sits above the viewport's top.
 */
export function topVisibleRow(
  viewportTop: number,
  rows: readonly RowBox[],
): { index: number; offset: number } | null {
  let best: RowBox | null = null;
  for (const row of rows) {
    if (row.bottom <= viewportTop + 1) continue;
    if (best === null || row.top < best.top) best = row;
  }
  return best === null ? null : { index: best.index, offset: viewportTop - best.top };
}

/**
 * How far the anchor has drifted from where it belongs: positive when it sits
 * too HIGH (more of it hidden above the edge than was saved). The scroller
 * corrects by `scrollTop -= drift`.
 */
export function anchorDrift(viewportTop: number, rowTop: number, savedOffset: number): number {
  return viewportTop - rowTop - savedOffset;
}

/** Virtuoso's rendered item wrappers: `data-index` is the 0-based data index. */
const ITEM_SELECTOR = '[data-testid="virtuoso-item-list"] > [data-index]';

/** The rendered rows of a Virtuoso scroller, as boxes. */
export function renderedRowBoxes(scroller: HTMLElement): RowBox[] {
  const out: RowBox[] = [];
  for (const el of Array.from(scroller.querySelectorAll<HTMLElement>(ITEM_SELECTOR))) {
    const index = Number(el.dataset.index);
    if (!Number.isInteger(index)) continue;
    const rect = el.getBoundingClientRect();
    out.push({ index, top: rect.top, bottom: rect.bottom });
  }
  return out;
}

/** The top visible row of a Virtuoso scroller (see `topVisibleRow`). */
export function readTopVisibleRow(scroller: HTMLElement): { index: number; offset: number } | null {
  return topVisibleRow(scroller.getBoundingClientRect().top, renderedRowBoxes(scroller));
}

/** One rendered row's element, by data index, or null while it is not rendered. */
export function renderedRow(scroller: HTMLElement, index: number): HTMLElement | null {
  return scroller.querySelector<HTMLElement>(
    `[data-testid="virtuoso-item-list"] > [data-index="${index}"]`,
  );
}

/** The minimal row shape the plan matches against. */
export interface AnchorRow {
  id: string;
  client_key?: string | null;
}

/** True when `row` is the anchored row (its key, or its server id). */
export function isAnchorRow(row: AnchorRow, anchor: Pick<ReadingAnchor, 'key' | 'id'>): boolean {
  return (row.client_key ?? row.id) === anchor.key || row.id === anchor.id;
}

/**
 * How a visit opens, decided once when the list mounts:
 *
 *   * `null`: no saved position, the reader was at the live edge, or a
 *     permalink names where to land. The list opens at the newest message
 *     and follows, as a first visit does.
 *   * `anchor` with an `index`: the row is in the loaded window; render
 *     around it.
 *   * `anchor` with `index: null`: the row left the window while the reader was
 *     away (live traffic evicted it, or the window was replaced). Its
 *     neighbourhood must be read before it can be shown.
 */
export interface RestorePlan {
  anchor: ReadingAnchor;
  index: number | null;
}

export function planRestore(
  position: ReadingPosition | undefined,
  focusMessageId: string | null,
  rows: readonly AnchorRow[],
): RestorePlan | null {
  if (position === undefined || position.atBottom || focusMessageId !== null) return null;
  const { anchor } = position;
  const index = rows.findIndex((row) => isAnchorRow(row, anchor));
  return { anchor, index: index >= 0 ? index : null };
}

/**
 * The exclusive `after=` cursor whose page STARTS at `id`: the snowflake one
 * below it. Null for an id that is not a snowflake (a placeholder never
 * confirmed has no server neighbourhood to read).
 */
export function cursorJustBefore(id: string): string | null {
  if (!/^\d+$/.test(id)) return null;
  const n = BigInt(id);
  return n > 0n ? (n - 1n).toString() : null;
}
