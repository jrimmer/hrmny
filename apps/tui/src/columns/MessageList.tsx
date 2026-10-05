/**
 * @cytale/tui — the message list in column two (U7; R19, R26a).
 *
 * The list draws what `format/rows.ts` projects and nothing else: the header,
 * the pending/start/error status at the pane's top edge, and the rows the
 * budget has room for. No fetch, no cache, no second copy of the store — the
 * page that arrives lands in the shared slices and reappears here on the next
 * store notification.
 *
 * ---------------------------------------------------------------------------
 * The row's shape on screen, and why every row keeps a gutter line
 * ---------------------------------------------------------------------------
 *
 * A row is ONE `Text` with `(linesPerRow + 1)` physical lines: its gutter line
 * and its body. The gutter carries the cursor marker (`FOCUS_MARKER`, or a
 * blank), the author, and the right-aligned time — or, for a row that continues
 * the author above it, the continuation glyph and the time only when the minute
 * changed. The gutter line is never dropped, not even for a continuation: the
 * shell's cursor is a ROW, so a row without a line of its own would have
 * nowhere to be highlighted, and the pane's budget (one line per row, plus its
 * body) stays the same number for every message.
 *
 * A message with replies carries the thread indicator beneath its body —
 * `↩ n replies`, from the LOADED reply set (`replyCountFor`). Zero renders
 * nothing at all: a count this client has not fetched is not stated.
 *
 * A message with reactions carries its chip row beneath that (U14; R24) — the
 * same "one line, or none" shape the thread indicator has, and part of the same
 * budget (`rowCost` counts it). The chips themselves are
 * `columns/Reactions.tsx`'s: what they say and how the member's own is marked
 * is stated there, and this module only decides WHERE they sit — under the
 * message they belong to, replies first, because a reaction is about the
 * message rather than about its thread.
 *
 * The status line is drawn only at the pane's TOP EDGE — the first row the
 * window holds, not wherever the member has scrolled to — because that is where
 * it belongs: a pending page sits above the oldest row on screen, and an error
 * about that row is not usefully repeated over a scrolled-back view. Every
 * string here is inert before it is drawn (R26a).
 */
import { Box, Text } from 'ink';
import { Fragment, type ReactElement } from 'react';

import {
  CONTINUATION_MARKER,
  ROW_GUTTER_WIDTH,
  TIME_WIDTH,
  authorBudgetFor,
  clampToWidth,
  historyStatusLine,
  padToWidth,
  replyIndicatorLine,
  rowCost,
  type MessageRow,
} from '../format/rows.js';

import type { ContentView } from './ContentColumn.js';
import { FOCUS_MARKER } from './layout.js';
import { ReactionChips } from './Reactions.js';

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** The body's indent: the gutter, so a body line never starts under a marker. */
const INDENT = ' '.repeat(ROW_GUTTER_WIDTH);

/**
 * How many rows fit in `budget` lines, starting at `viewport`. A row costs its
 * gutter line, its wrapped body, and its thread indicator; the FIRST row is
 * always drawn whatever it costs, so a pane too short for one message still
 * shows a message instead of an empty box.
 */
function visibleCount(rows: readonly MessageRow[], viewport: number, budget: number): number {
  let used = 0;
  let count = 0;
  for (let index = viewport; index < rows.length; index += 1) {
    const row = rows[index];
    if (row === undefined) break;
    const cost = rowCost(row);
    if (count > 0 && used + cost > budget) break;
    count += 1;
    used += cost;
  }
  return count;
}

/** The rows the pane draws: where the window starts, and how many of them. */
export interface VisibleWindow {
  readonly start: number;
  readonly count: number;
}

/**
 * The pane's window onto its rows.
 *
 * It starts at the shell's scroll position and draws as many rows as the line
 * budget fits — and it ALWAYS includes the cursor's row. That last part is
 * U7's pagination rule made visible: a page that lands ABOVE the member's
 * message shifts every index under them, so a window that kept its old start
 * would leave the very message they were reading off the pane. The window
 * follows it instead, and the shell's scroll position is repaired separately
 * (with the same delta) so the next movement key starts from the right place.
 */
export function visibleWindow(
  rows: readonly MessageRow[],
  viewport: number,
  cursor: number,
  budget: number,
): VisibleWindow {
  if (rows.length === 0) return { start: 0, count: 0 };
  const target = Math.min(Math.max(0, cursor), rows.length - 1);
  let start = Math.min(Math.max(0, viewport), rows.length - 1);
  if (target < start) start = target;
  let count = visibleCount(rows, start, budget);
  while (target >= start + count && start < target) {
    start += 1;
    count = visibleCount(rows, start, budget);
  }
  return { start, count };
}

/** The time cell, padded into the fixed column (or left off when unusable). */
function timeCell(time: string): string {
  if (time === '') return '';
  return padToWidth(clampToWidth(time, TIME_WIDTH), TIME_WIDTH);
}

/** The gutter of a row that opens an author group: marker, author, time. */
function groupGutter(row: MessageRow, current: boolean, authorBudget: number): string {
  const marker = current ? FOCUS_MARKER : ' ';
  const author = padToWidth(clampToWidth(row.author, authorBudget), authorBudget);
  return `${marker} ${author} ${timeCell(row.time)}`.trimEnd();
}

/**
 * The gutter of a continuation row. The glyph says the message belongs to the
 * author above it; the time is re-stated only when the minute changed, so a run
 * that spans a few minutes still reads in order.
 */
function continuationGutter(
  row: MessageRow,
  previous: MessageRow | undefined,
  current: boolean,
  authorBudget: number,
): string {
  const marker = current ? FOCUS_MARKER : ' ';
  const note = previous !== undefined && row.time !== '' && previous.time !== row.time ? row.time : '';
  if (note === '') return `${marker} ${clampToWidth(CONTINUATION_MARKER, authorBudget)}`;
  // The note time lands in the same column the group header's time sits in.
  return `${marker} ${padToWidth(CONTINUATION_MARKER, authorBudget)} ${note}`.trimEnd();
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export interface MessageListProps {
  readonly view: ContentView;
  /** The pane's width in cells. */
  readonly width: number;
  /** Lines this pane may draw (the shell's budget for column two). */
  readonly height: number;
}

export function MessageList({ view, width, height }: MessageListProps): ReactElement {
  const hasRows = view.rows.length > 0;
  const status = historyStatusLine(view.history, hasRows);
  // The status line costs a line of the budget when it is drawn.
  const windowed = visibleWindow(
    view.rows,
    view.viewport,
    view.cursor,
    Math.max(1, height - (status === null ? 0 : 1)),
  );
  const line = windowed.start === 0 ? status : null;
  const authorBudget = authorBudgetFor(width);

  return (
    <Box flexDirection="column" width={width}>
      {line === null ? null : (
        <Text dimColor wrap="wrap">{`${INDENT}${line}`}</Text>
      )}
      {view.rows.slice(windowed.start, windowed.start + windowed.count).map((row, offset) => {
        const index = windowed.start + offset;
        const current = index === view.cursor;
        const previous = view.rows[index - 1];
        const gutter = row.groupStart
          ? groupGutter(row, current, authorBudget)
          : continuationGutter(row, previous, current, authorBudget);
        const replies = replyIndicatorLine(row);
        const body = row.lines.map((bodyLine) => `${INDENT}${bodyLine}`);
        return (
          // One row, then its chip row: the gutter line, the body, and the
          // thread indicator are ONE `Text` (they are the message), while the
          // chips are the reaction surface's own element — and the row's cost
          // (`rowCost`) is exactly what the two of them draw.
          <Fragment key={row.id}>
            <Text wrap="truncate" bold={current} {...(current ? { color: 'cyan' } : {})}>
              {[gutter, ...body, ...(replies === null ? [] : [replies])].join('\n')}
            </Text>
            <ReactionChips reactions={row.reactions} />
          </Fragment>
        );
      })}
    </Box>
  );
}
