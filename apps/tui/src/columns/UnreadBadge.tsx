/**
 * @cytale/tui — the unread badge in column one (U10; R22, R22a).
 *
 * A badge is one fact — a count — and it has two chances to be lost on the way
 * to a cell, so both are handled here rather than left to the call site.
 *
 * ---------------------------------------------------------------------------
 * 1. The count must be readable without colour
 * ---------------------------------------------------------------------------
 *
 * The count is drawn in parentheses (`(3)`) rather than as a bare number: the
 * parens are a non-colour channel, the rule this client's focus markers, phase
 * markers, and presence glyphs all follow. Brackets also keep a count
 * distinguishable from any text a channel name could end with, and from the
 * `#`-prefixed labels beside it.
 *
 * ---------------------------------------------------------------------------
 * 2. The count must survive the column's width budget
 * ---------------------------------------------------------------------------
 *
 * The column is as narrow as `MIN_NAVIGATION_WIDTH` (20 cells, `layout.ts`),
 * and Ink clips a row that overflows with `wrap="truncate"` — which cuts from
 * the RIGHT, so a suffix badge on a long channel name would be the first thing
 * to disappear, silently defeating the whole unit. `labelForRow` therefore
 * reserves the badge's cells before the label is drawn and truncates the NAME
 * instead, with an ellipsis, so the count is on the row whatever the name is.
 * (A row with no badge is handed back untouched, so this unit does not change
 * how names were drawn before it.)
 *
 * The measurement is `format/markdown.ts`'s `displayWidth`, the one cell
 * counter this package has, so a name in a wide script is truncated by cells
 * rather than by code points.
 *
 * ---------------------------------------------------------------------------
 * What a badge is NOT
 * ---------------------------------------------------------------------------
 *
 * `0` renders nothing at all: "no unread" is absence, not a zero, so a read
 * channel and a channel with no messages look the same (both `0`), and neither
 * gains a row. Mentions are not drawn: R22 covers unread badges only, and the
 * plan leaves a mention indicator an open question.
 */
import { Text } from 'ink';
import type { ReactElement } from 'react';

import { displayWidth } from '../format/markdown.js';

/** No unread: the count that draws nothing. */
export const NO_BADGE = 0;

/**
 * The badge's text, WITH its leading space, or `''` when there is nothing to
 * draw. Anything that is not a positive, finite count is no badge — a wire
 * value the client cannot trust must not invent cells.
 */
export function badgeText(count: number): string {
  if (!Number.isFinite(count) || count <= NO_BADGE) return '';
  return ` (${Math.floor(count)})`;
}

/** How many cells a badge for `count` occupies (`0` when there is none). */
function badgeCells(count: number): number {
  return displayWidth(badgeText(count));
}

/**
 * `label`, cut to at most `cells` terminal cells, with `…` marking the cut.
 * A label that fits is returned unchanged.
 */
function fitLabel(label: string, cells: number): string {
  if (cells <= 0) return '';
  if (displayWidth(label) <= cells) return label;

  const budget = cells - 1; // one cell for the ellipsis
  if (budget <= 0) return '…';

  let used = 0;
  let kept = '';
  // Code points, not code units: a surrogate pair is one cluster, and the cell
  // counter below is the only measure used to decide the cut.
  for (const point of Array.from(label)) {
    const width = displayWidth(point);
    if (used + width > budget) break;
    kept += point;
    used += width;
  }
  return `${kept}…`;
}

/**
 * The label as drawn on a row of `cells` whose badge needs `count` cells: the
 * badge's cells are reserved, so the NAME is what gives way (see the header).
 */
export function labelForRow(label: string, count: number, cells: number): string {
  const reserved = badgeCells(count);
  if (reserved === 0) return label;
  return fitLabel(label, cells - reserved);
}

export interface UnreadBadgeProps {
  /** The server's unread count for the row (`readBadge`). Non-positive = none. */
  readonly count: number;
}

/**
 * The badge itself: the parenthetical count, or nothing at all.
 *
 * Renders `<Text>` so it can sit inside the row's own `<Text>` — the badge is a
 * suffix of one row, never a row of its own, because a row that appeared and
 * disappeared as unread changed would shift the selection index under the
 * member (column one's selection is index-based).
 */
export function UnreadBadge({ count }: UnreadBadgeProps): ReactElement | null {
  const text = badgeText(count);
  if (text === '') return null;
  // Not dimmed: the badge is a state the member needs, unlike a header.
  return <Text>{text}</Text>;
}
