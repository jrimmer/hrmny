/**
 * @cytale/tui — the composer (U8; R20, R21).
 *
 * What this module owns, and what it deliberately does not:
 *
 *   * **The buffer is multiline.** Shift+Enter inserts a newline, Enter sends
 *     the whole thing — the binding `apps/web`'s composer settled
 *     (`MessageCompose.tsx`'s `EnterSendPlugin`: Enter sends, Shift+Enter
 *     inserts a newline). The newline is real: the buffer holds `\n`, and the
 *     body the request carries is the member's text with those newlines in it
 *     (this client sends what was typed; U16's markdown rendering is the
 *     INCOMING direction).
 *   * **The FIRST line is drawn by column two's composer line**, which
 *     `ContentColumn` (U7) already renders in the right place — at the bottom
 *     of the content column, inside its line budget, with the focus marker.
 *     So this module draws the buffer's CONTINUATION lines and the composer's
 *     STATUS lines, and `App` refunds their height to the content budget.
 *     Drawing a second prompt line here would put two markers on the screen
 *     for one composer.
 *   * **The status lines**: a send in flight, the reason a send did not go,
 *     and the new-message affordance. Each is rendered from a model the shell
 *     computes, so this component holds no state and the shell's behavior is
 *     testable without a terminal.
 *
 * ---------------------------------------------------------------------------
 * The arrival policy (step 4), stated once, for both clients
 * ---------------------------------------------------------------------------
 *
 * A message that lands while the reader is looking at the pane must not move
 * them. The rule `apps/web` settled in `MessageList.tsx` — re-pin only while
 * the reader is ALREADY at the newest, otherwise leave the position alone — is
 * a rule about the READER'S position, not about the message, and this client
 * states it in the only terms the shell has: the cursor's row.
 *
 *   * The reader is AT THE NEWEST when the cursor is on the last row
 *     (`atNewestRow`). A new row then moves the anchor with it
 *     (`decisionOf` → `'pin'`): the pane follows the conversation, which is
 *     what "already at the newest" means.
 *   * The reader is SCROLLED BACK when the cursor is on an older row. The
 *     anchor stays exactly where it was, however many rows land below it
 *     (`'hold'`), and `newerRowCount` counts what is below — which is the
 *     affordance the member can act on. The key that acts on it is `Ctrl+D`
 *     (`Ctrl+D` is already bound to "scroll the view down"; while something is
 *     newer than the reader's anchor, its meaning is "all the way down", and
 *     the affordance says so). A dedicated `jump-to-newest` binding belongs in
 *     `keys.ts`'s `KEY_MAP` — see this unit's report: `keys.ts` is another
 *     unit's file, so the affordance names the key that exists today.
 *   * A FRESH IDENTIFY is not an arrival. The store resets and the boot load
 *     re-fills it, so every row is "newer" than the empty baseline; treating
 *     that as a backlog would announce messages the member has already read.
 *     `arrivalBaseline` keys on the session epoch as well as the pane, so a
 *     reset starts a new baseline and says nothing (`'baseline'`).
 */
import { Box, Text } from 'ink';
import type { ReactElement } from 'react';

import { clampToWidth } from '../format/rows.js';
import { displayWidth, sanitizeTerminalText } from '../format/markdown.js';
import { FOCUS_MARKER } from '../columns/layout.js';

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * The prompt column two draws the composer's first line with. Derived from the
 * same constants `ContentColumn` uses rather than hard-coded, so the
 * continuation lines line up under the first line's text.
 */
export const COMPOSER_PROMPT = `${FOCUS_MARKER} > `;

/** Cells the continuation lines are indented by (the prompt's own width). */
const CONTINUATION_INDENT = ' '.repeat(displayWidth(COMPOSER_PROMPT));

/** Cells a status line is indented by (the pane's own notices use two). */
const STATUS_INDENT = '  ';

/**
 * Wrap `text` to at most `cells` terminal cells per line, cutting on display
 * width so a wide glyph is never half-printed. Ink is given
 * `wrap="truncate"` for every line this module draws: the count of lines it
 * draws is what the shell refunds to the content budget, and a wrap Ink
 * decided on would make that count a lie.
 */
export function wrapToCells(text: string, cells: number): string[] {
  const budget = Math.max(1, Math.floor(cells));
  const out: string[] = [];
  let rest = text;
  while (displayWidth(rest) > budget) {
    const chunk = clampToWidth(rest, budget);
    if (chunk === '') {
      // A single cluster wider than the whole budget: cut one code point so
      // the loop always makes progress.
      const first = Array.from(rest)[0] ?? '';
      out.push(first);
      rest = rest.slice(first.length);
      continue;
    }
    out.push(chunk);
    rest = rest.slice(chunk.length);
  }
  out.push(rest);
  return out;
}

/** The buffer's lines after the first, which column two's composer line draws. */
export function bufferLines(buffer: string): string[] {
  // Sanitized with newlines kept: the buffer is the member's own text, and the
  // terminal is the one surface where an echoed control sequence is a hazard
  // even to its author (R26a — the same rule `ContentColumn` applies to the
  // first line of the same buffer). Tabs are the one control an `allowNewlines`
  // pass leaves alone, and a tab in the frame misaligns the columns Ink just
  // measured, so they are expanded here.
  const safe = sanitizeTerminalText(buffer, { allowNewlines: true }).replace(/\t/g, '  ');
  return safe.split('\n');
}

/** The continuation lines of the buffer, wrapped to the pane width. */
export function continuationLines(buffer: string, width: number): string[] {
  const lines = bufferLines(buffer).slice(1);
  const budget = Math.max(1, width - displayWidth(CONTINUATION_INDENT));
  return lines.flatMap((line) => wrapToCells(line, budget).map((chunk) => `${CONTINUATION_INDENT}${chunk}`));
}

/**
 * The buffer's FIRST line — the one column two's composer line draws. It is
 * handed over on its own because that line renders through
 * `sanitizeTerminalText` without `allowNewlines`, which would flatten a
 * multiline draft onto the prompt line and print every continuation twice.
 */
export function firstBufferLine(buffer: string): string {
  return bufferLines(buffer)[0] ?? '';
}

// ---------------------------------------------------------------------------
// The arrival policy
// ---------------------------------------------------------------------------

/** The marker the affordance leads with (a non-colour channel, like the banner). */
export const ARRIVAL_MARKER = '▼';

/**
 * The key the affordance names. `Ctrl+D` is bound in `KEY_MAP` to "scroll the
 * view down"; with rows newer than the reader's anchor it is the whole way
 * down, which is what the affordance says out loud.
 */
export const ARRIVAL_JUMP_KEY = 'Ctrl+D';

/** Rows BELOW the reader's anchor — what the affordance counts. */
export function newerRowCount(rows: readonly { readonly id: string }[], cursor: number): number {
  if (rows.length === 0) return 0;
  const at = Math.min(Math.max(0, cursor), rows.length - 1);
  return rows.length - 1 - at;
}

/** True when the reader's anchor IS the newest row. */
export function atNewestRow(rows: readonly { readonly id: string }[], cursor: number): boolean {
  return newerRowCount(rows, cursor) === 0;
}

/** The affordance line, or null when there is nothing newer to go to. */
export function arrivalLine(count: number): string | null {
  if (count <= 0) return null;
  return `${ARRIVAL_MARKER} ${count} newer ${count === 1 ? 'message' : 'messages'} · ${ARRIVAL_JUMP_KEY} jumps to the newest`;
}

/**
 * Where the reader was, for one pane of one session. The pane key pins the
 * baseline to a conversation (a switch is not an arrival), and the epoch pins
 * it to a gateway session (a fresh Identify's re-hydration is not one either).
 */
export interface ArrivalBaseline {
  readonly key: string;
  readonly epoch: number;
  readonly newestId: string | null;
  readonly atNewest: boolean;
}

export function arrivalBaseline(
  key: string,
  epoch: number,
  rows: readonly { readonly id: string }[],
  cursor: number,
): ArrivalBaseline {
  const newest = rows.length === 0 ? null : (rows[rows.length - 1]?.id ?? null);
  return { key, epoch, newestId: newest, atNewest: atNewestRow(rows, cursor) };
}

export type ArrivalDecision =
  /** No baseline to compare against (a new pane, or a new session): adopt it. */
  | 'baseline'
  /** Nothing arrived. */
  | 'idle'
  /** Rows arrived while the reader was anchored above them: hold, and say so. */
  | 'hold'
  /** Rows arrived while the reader was at the newest: follow them down. */
  | 'pin';

export function decisionOf(
  previous: ArrivalBaseline | null,
  next: ArrivalBaseline,
): ArrivalDecision {
  if (previous === null || previous.key !== next.key || previous.epoch !== next.epoch) {
    return 'baseline';
  }
  if (next.newestId === null || next.newestId === previous.newestId) return 'idle';
  return previous.atNewest ? 'pin' : 'hold';
}

// ---------------------------------------------------------------------------
// The model and the lines
// ---------------------------------------------------------------------------

/** Everything the composer's own lines are drawn from. */
export interface ComposerModel {
  /** The buffer as typed, newlines included. Its FIRST line is column two's. */
  readonly buffer: string;
  /** A send is in flight. */
  readonly pending: boolean;
  /** The last refusal or failure line the shell built, or null. */
  readonly problem: string | null;
  /** Rows newer than the reader's anchor; 0 renders no affordance. */
  readonly newerCount: number;
  /** What a send addresses, for the in-flight line. */
  readonly target: string;
}

/**
 * Every line the composer draws, in order, already wrapped to `width` and made
 * INERT (R26a): the buffer holds the member's own keystrokes, and a failure
 * cause can carry a server string.
 */
export function composerLines(model: ComposerModel, width: number): string[] {
  const lines = continuationLines(model.buffer, width);
  const statuses: (string | null)[] = [
    model.pending ? `… sending${model.target === '' ? '' : ` to ${model.target}`}` : null,
    model.problem,
    arrivalLine(model.newerCount),
  ];
  const budget = Math.max(1, width - displayWidth(STATUS_INDENT));
  for (const status of statuses) {
    if (status === null) continue;
    const safe = sanitizeTerminalText(status);
    for (const chunk of wrapToCells(safe, budget)) lines.push(`${STATUS_INDENT}${chunk}`);
  }
  return lines;
}

/** Lines the composer draws — what the shell refunds to the content budget. */
export function composerHeight(model: ComposerModel, width: number): number {
  return composerLines(model, width).length;
}

// ---------------------------------------------------------------------------
// The component
// ---------------------------------------------------------------------------

export interface ComposerProps extends ComposerModel {
  /** Cells the composer may draw in (the content column's width). */
  readonly width: number;
}

/**
 * The composer's own lines. The strings come back from `composerLines` inert
 * and pre-wrapped (Ink is told `truncate` so the line count this module
 * reports for the shell's budget is exactly what is drawn).
 */
export function Composer(model: ComposerProps): ReactElement | null {
  const lines = composerLines(model, model.width);
  if (lines.length === 0) return null;
  // The status lines are dimmed; the buffer's own continuation lines are the
  // member's text and read like the first line.
  const continuation = continuationLines(model.buffer, model.width).length;
  return (
    <Box flexDirection="column" width={model.width}>
      {lines.map((line, index) => (
        <Text key={`composer-${index}`} wrap="truncate" dimColor={index >= continuation}>
          {line}
        </Text>
      ))}
    </Box>
  );
}
