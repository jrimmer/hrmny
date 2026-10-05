/**
 * @cytale/tui — the thread pane (U7; R18, R26a).
 *
 * A thread does not get a third column: it takes column two from the channel
 * (R18), draws the seed message the thread hangs off as context, and lists the
 * replies beneath it. Closing it gives the channel back with one binding (`t`
 * or Escape), which is `keys.ts`'s `toggle-thread` / `cancel` — this module
 * only draws what that state means.
 *
 * ---------------------------------------------------------------------------
 * What it draws, and what it deliberately does not
 * ---------------------------------------------------------------------------
 *
 *   * THE SEED IS CONTEXT, NOT A REPLY. It is a message of the CHANNEL's slice,
 *     found by `parent_message_id`, and it is marked as the seed so a reader
 *     never mistakes it for the first reply. It is not a cursor row: the shell's
 *     message cursor walks the reply list. It is drawn with everything
 *     `rowCost` charges it for — its label, its body, and its reaction chip row
 *     (U14), through the same `ReactionChips` element a `MessageList` row uses —
 *     so the line reserved for its chips is a line it draws.
 *   * THE REPLIES COME FROM `messagesByThread`. They are never filtered out of
 *     the channel's rows: the server keeps thread replies out of the channel
 *     timeline (and the store keeps them in their own slice), so a pane that
 *     synthesized them would show messages no other client shows there.
 *   * THE PANE'S OWN STATES ARE THE CHANNEL PANE'S, with the thread's words:
 *     while the replies load, the header already names the thread (step 3) and
 *     the notice says it is loading; a failure is an inline error with the
 *     retry hint, and it never clears the channel's rows, which live in a slice
 *     this pane does not touch.
 *
 * Every server string here is inert before it reaches a cell: the thread name
 * and the seed's author cross `inertText` at projection time (in
 * `ContentColumn.tsx`), and reply bodies cross `renderMarkdownLines` in
 * `format/rows.ts` — the same two doors every other server string in this
 * client goes through (R26a).
 */
import { Box, Text } from 'ink';
import { Fragment, type ReactElement } from 'react';

import { rowCost, type MessageRow } from '../format/rows.js';

import type { ContentView } from './ContentColumn.js';
import { MessageList } from './MessageList.js';
import { ReactionChips } from './Reactions.js';

/** The line that marks the seed: short enough to read in a 24-cell pane. */
export function seedLabel(row: MessageRow): string {
  const time = row.time === '' ? '' : ` ${row.time}`;
  return `  ── seed · ${row.author}${time}`;
}

export interface ThreadViewProps {
  readonly view: ContentView;
  /** The pane's width in cells. */
  readonly width: number;
  /** Lines the pane may draw (already minus the pane's header and composer). */
  readonly height: number;
}

export function ThreadView({ view, width, height }: ThreadViewProps): ReactElement {
  const seed = view.seed;
  // The seed costs its own lines out of the same budget, so a thread with a
  // long parent message does not push its replies off the pane. `rowCost`
  // charges the seed its label line, its body, and one chip row when it has
  // reactions — and every one of those is DRAWN below, the chips through the
  // same `ReactionChips` element `MessageList` draws a row's chips with (U14).
  // A seed whose chips were left out would charge the pane a line nothing drew,
  // and would hide reactions the seed actually carries.
  const seedCost = seed === null ? 0 : rowCost(seed);
  const replyBudget = Math.max(1, height - seedCost);

  return (
    <Box flexDirection="column" width={width}>
      {seed === null ? null : (
        // The seed block: the label and the body in one `Text` (they are the
        // message), then its chip row — the row's own surface, exactly as
        // `MessageList` splits a row (U14; R24).
        <Fragment>
          <Text wrap="truncate" dimColor>
            {[seedLabel(seed), ...seed.lines.map((line) => `  ${line}`)].join('\n')}
          </Text>
          <ReactionChips reactions={seed.reactions} />
        </Fragment>
      )}
      <MessageList view={view} width={width} height={replyBudget} />
    </Box>
  );
}
