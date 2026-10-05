/**
 * @cytale/web — test helper: build the rows' hover toolbars.
 *
 * The toolbar mounts lazily, on the row's first pointer entry or focus (#14),
 * exactly as a reader's hover builds it in the browser. A unit test that
 * reaches for a toolbar action hovers the rows first — this does that for
 * every message row under `root`.
 */
import { act, fireEvent } from '@testing-library/react';

export function revealMessageActions(root: ParentNode = document): void {
  const rows = Array.from(root.querySelectorAll<HTMLElement>('[data-testid="message-item"]'));
  // A row handed in directly is a row too.
  if (root instanceof HTMLElement && root.dataset.testid === 'message-item') rows.push(root);
  act(() => {
    for (const row of rows) fireEvent.mouseEnter(row);
  });
}
