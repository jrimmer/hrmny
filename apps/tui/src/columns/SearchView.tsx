/**
 * @cytale/tui — the search pane in column two (U13; R23, R26a).
 *
 * The pane draws what `compose/search.ts` projects and nothing else: the
 * subject line, the query the member is typing, the results the budget has room
 * for, and the one line every other state is. No fetch, no debounce, no second
 * copy of the rows — the shell owns the request and hands this surface a pane
 * (`SearchPane`), which is what keeps the `loading`/`empty`/`error`/
 * `unavailable`/`offline` states in one place instead of two.
 *
 * ---------------------------------------------------------------------------
 * Why the query line looks like the composer's
 * ---------------------------------------------------------------------------
 *
 * The query input is a TEXT surface, and this client already has one shape for
 * those: the composer's `▸ > text` line, with the focus marker and the prompt
 * derived from the same constant (`compose/Composer.tsx`'s `COMPOSER_PROMPT`).
 * A member who has typed in one has typed in the other, and the marker is the
 * non-colour channel the rest of the shell uses (U6's rule).
 *
 * The pane has the SAME two states the composer has, and it says which one it
 * is in: focused, the line is `▸ > <query>`; unfocused, it is
 * `  i writes a query` — the composer's own `  i writes in #general` wording.
 * `i` focuses the query (`app.tsx`), so `/` can put the pane on screen without
 * swallowing the member's next keystroke.
 *
 * What is typed is drawn through `sanitizeTerminalText` rather than
 * `inertText`: it is the member's OWN text, so it keeps its spaces (the same
 * reason the composer sanitizes without trimming), and a control sequence that
 * reached the buffer from a paste still cannot move the cursor.
 *
 * ---------------------------------------------------------------------------
 * The row shape
 * ---------------------------------------------------------------------------
 *
 * One result is ONE line — `where · who · what` (`searchRowText`) — cut to the
 * pane's cells with `clampToWidth`, the width function every terminal surface
 * here uses. The cursor's row carries the same `▸` marker the message list
 * uses, so the highlighted result is readable without colour, and the row text
 * comes from the projection (where the conversation is named, and the snippet is
 * made inert) rather than from the wire.
 *
 * The status lines — `… Searching`, `No messages match "x".`, the failure and
 * the offline reasons — are drawn in the row area when the pane has no rows,
 * so a state and a result list never compete for the same cells.
 */
import { Box, Text } from 'ink';
import type { ReactElement } from 'react';

import { clampToWidth } from '../format/rows.js';
import { displayWidth, sanitizeTerminalText } from '../format/markdown.js';

import {
  SEARCH_CHROME_ROWS,
  searchRowText,
  searchWindow,
  type SearchPane,
} from '../compose/search.js';
import { FOCUS_MARKER, UNFOCUSED_MARKER, inertText } from './layout.js';

/** What the pane needs: the projected state, the typed query, and the geometry. */
export interface SearchViewProps {
  readonly pane: SearchPane;
  /** What the member has typed — a prefix of what is being searched. */
  readonly query: string;
  /** Whether the query line holds the keyboard (`i` focuses it). */
  readonly focused: boolean;
  /** What is being searched (`this workspace`, `your direct messages`). */
  readonly subject: string;
  readonly width: number;
  /** Lines the pane may draw, its own chrome included. */
  readonly height: number;
}

/** Cells a result row's text gets, after its marker and the space after it. */
const ROW_PREFIX = `${FOCUS_MARKER} `;
const ROW_INDENT = '  ';

export function SearchView({
  pane,
  query,
  focused,
  subject,
  width,
  height,
}: SearchViewProps): ReactElement {
  const rows = Math.max(1, height - SEARCH_CHROME_ROWS);
  const windowed = searchWindow(pane.rows.length, pane.cursor, rows);
  const shown = pane.rows.slice(windowed.start, windowed.start + windowed.count);
  const cells = Math.max(1, width - displayWidth(ROW_PREFIX));
  const typed = sanitizeTerminalText(query);
  // The pane's own line, EXCEPT while the query line is unfocused and idle:
  // there the query line above already says what to press, and "type to search"
  // would be asking for keystrokes the columns still own.
  const notice = pane.status === 'idle' && !focused ? null : pane.notice;

  return (
    <Box flexDirection="column" width={width}>
      <Text bold wrap="truncate">
        {`${FOCUS_MARKER} Search · ${inertText(subject, 'this workspace')}`}
      </Text>
      {focused ? (
        // The member's own keystrokes: sanitized, never trimmed — a query keeps
        // the spaces it was typed with.
        <Text wrap="truncate">
          {`${FOCUS_MARKER} > ${typed}${pane.status === 'loading' ? '…' : ''}`}
        </Text>
      ) : (
        // Unfocused reads like the composer's own unfocused line, because it
        // IS the same idea: press `i` to write here.
        <Text dimColor wrap="truncate">
          {`${ROW_INDENT}i writes a query · ${inertText(subject, 'this workspace')}`}
        </Text>
      )}

      {pane.rows.length === 0 ? (
        // No rows: the state IS the pane. `dimColor` is the only colour it
        // carries — the markers in the text are what states it (U6's rule).
        notice === null ? null : (
          <Text dimColor wrap="wrap">
            {`${ROW_INDENT}${inertText(notice, 'Type to search.')}`}
          </Text>
        )
      ) : (
        shown.map((row, offset) => {
          const current = windowed.start + offset === pane.cursor;
          const marker = current ? FOCUS_MARKER : UNFOCUSED_MARKER;
          return (
            <Text key={`${row.scope}:${row.messageId}`} wrap="truncate" bold={current}>
              {`${marker} ${clampToWidth(searchRowText(row), cells)}`}
            </Text>
          );
        })
      )}

      <Text dimColor wrap="truncate">
        {`${ROW_INDENT}↑/↓ choose · Enter opens · ${focused ? 'Esc closes' : 'i writes · Esc closes'}`}
      </Text>
    </Box>
  );
}
