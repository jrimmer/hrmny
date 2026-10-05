/**
 * #150's first migrated component — the seam contract, not cmdk's internals:
 * the shadcn Command parts render with the house classes, the dialog variant
 * composes our Dialog (focus trapping + sr-only titles), and everything
 * resolves through OUR cn seam. jsdom-safe: cmdk renders inert markup.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../command.js';

afterEach(() => cleanup());

describe('shadcn Command — the house seam', () => {
  it('renders the parts with the shadcn-convention classes', () => {
    render(
      <Command>
        <CommandInput placeholder="Search…" aria-label="Search" />
        <CommandList>
          <CommandEmpty>No results.</CommandEmpty>
          <CommandGroup heading="Messages">
            <CommandItem value="one">the deploy finished</CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>,
    );
    // cmdk's own slots carry our data-slot markers.
    expect(document.querySelector('[data-slot="command"]')).toBeTruthy();
    expect(document.querySelector('[data-slot="command-input"]')).toBeTruthy();
    expect(document.querySelector('[data-slot="command-item"]')).toBeTruthy();
    // The house classes are present on the root (popover surface + foreground
    // utilities — resolved through the tokens bridge, not shadcn's palette).
    const root = document.querySelector('[data-slot="command"]') as HTMLElement;
    expect(root.className).toContain('bg-popover');
    expect(root.className).toContain('text-popover-foreground');
  });

  it('the dialog variant composes OUR Dialog with sr-only titles (a11y)', () => {
    render(
      <CommandDialog open onOpenChange={vi.fn()}>
        <CommandInput placeholder="Search…" aria-label="Search" />
      </CommandDialog>,
    );
    const content = document.querySelector('[data-testid="shadcn-command-dialog"]');
    expect(content).toBeTruthy();
    // Both accessible names exist for screen readers — shadcn's own contract.
    expect(screen.getByText('Command palette').getAttribute('class')).toContain('sr-only');
    expect(document.querySelector('[data-slot="dialog-content"]')).toBeTruthy();
  });

  it('cmdk preselects the first item — its own native selection, not ours', () => {
    // #150 migration note: cmdk preselects the FIRST item on mount. The
    // hand-rolled palettes preselected nothing (2026-09-19) — the owner
    // reviewed that on 2026-09-23 and RELAXED it: first-item highlight /
    // ready-for-selection is wanted everywhere. cmdk's default IS the
    // contract now; no palette migration needs to disable it.
    render(
      <Command>
        <CommandList>
          <CommandItem value="one">first</CommandItem>
        </CommandList>
      </Command>,
    );
    const item = document.querySelector('[data-slot="command-item"]') as HTMLElement;
    expect(item.getAttribute('data-selected')).toBe('true');
  });
});
