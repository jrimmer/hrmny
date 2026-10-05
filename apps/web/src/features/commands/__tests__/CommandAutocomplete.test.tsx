/**
 * @cytale/web — CommandAutocomplete tests (bots plan U9).
 *
 * States-first per UX_SPEC §9 against the presentational popover: loading,
 * empty (no commands registered — distinct from no-match), error + retry,
 * forbidden (permission-denied copy), offline note, and the listbox render
 * with aria-selected walking + click selection. axe zero violations.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { axe } from 'vitest-axe';
import type { AxeMatchers } from 'vitest-axe/matchers';
import React from 'react';

declare module 'vitest' {
  interface Assertion<T> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}

import type { ApplicationCommand } from '@cytale/api-client';

import { CommandAutocomplete } from '../CommandAutocomplete.js';
import type { CommandsState } from '../useCommands.js';

const READY: CommandsState = {
  status: 'ready',
  commands: [
    {
      id: '9100000000000001',
      application_id: '8000000000000001',
      name: 'shrug',
      description: 'Appends a shrug',
      options: null,
    },
    {
      id: '9100000000000002',
      application_id: '8000000000000001',
      name: 'echo',
      description: 'Echoes text',
      options: [{ name: 'text', description: 'What to echo', required: true }],
    },
  ],
};

function renderPalette(overrides: Partial<Parameters<typeof CommandAutocomplete>[0]> = {}) {
  const props = {
    state: READY,
    matches: READY.status === 'ready' ? READY.commands : [],
    query: '',
    activeIndex: 0,
    listboxId: 'commands-listbox',
    optionId: (i: number) => `command-opt-${i}`,
    onActiveIndexChange: vi.fn(),
    onSelect: vi.fn(),
    onRetry: vi.fn(),
    online: true,
    ...overrides,
  };
  render(React.createElement(CommandAutocomplete, props));
  return props;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('CommandAutocomplete — states', () => {
  it('renders a loading affordance while idle/loading', () => {
    renderPalette({ state: { status: 'loading' } });
    expect(screen.getByTestId('command-loading')).toBeTruthy();
    expect(screen.getByTestId('command-loading').getAttribute('role')).toBe('progressbar');
  });

  it('renders the named empty state when the workspace has no commands', () => {
    renderPalette({ state: { status: 'ready', commands: [] }, matches: [] });
    expect(screen.getByTestId('command-empty')).toBeTruthy();
    expect(screen.queryByTestId('command-error-load')).toBeNull();
  });

  it('renders a distinct no-match state for a filtered-out query', () => {
    renderPalette({ state: READY, matches: [], query: 'zzz' });
    expect(screen.getByTestId('command-no-matches').textContent).toContain('/zzz');
  });

  it('renders an error alert with retry', () => {
    const props = renderPalette({
      state: { status: 'error', error: 'network down', forbidden: false },
      matches: [],
    });
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByTestId('command-retry-load'));
    expect(props.onRetry).toHaveBeenCalled();
  });

  it('uses permission-denied copy for 403 without a retry affordance', () => {
    renderPalette({
      state: { status: 'error', error: 'nope', forbidden: true },
      matches: [],
    });
    expect(screen.getByRole('alert').textContent).toContain("don't have access");
    expect(screen.queryByTestId('command-retry-load')).toBeNull();
  });

  it('renders the offline state note', () => {
    renderPalette({ online: false });
    expect(screen.getByTestId('command-offline').getAttribute('role')).toBe('status');
  });
});

describe('CommandAutocomplete — listbox', () => {
  it('renders matches as aria-selected options and selects on click', () => {
    const props = renderPalette();
    const options = screen.getAllByTestId('command-option');
    expect(options).toHaveLength(2);
    expect(options[0]!.getAttribute('aria-selected')).toBe('true');
    expect(options[1]!.getAttribute('aria-selected')).toBe('false');

    fireEvent.mouseDown(options[1]!);
    expect(props.onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'echo' }),
    );
  });

  it('marks the active option when the index moves', () => {
    renderPalette({ activeIndex: 1 });
    const options = screen.getAllByTestId('command-option');
    expect(options[1]!.getAttribute('aria-selected')).toBe('true');
  });

  it('exposes the listbox role; the composer-named id and pointer id survive (#150)', () => {
    renderPalette();
    const listbox = screen.getByRole('listbox', { name: 'Slash commands' });
    // cmdk's Command carries the role; the WRAPPER div keeps the id the
    // composer's aria-controls names (cmdk generates its own element ids,
    // so the row-content span owns the activedescendant pointer).
    expect(document.getElementById('commands-listbox')).toBeTruthy();
    expect(listbox.id).not.toBe('commands-listbox');
    expect(
      screen.getAllByTestId('command-option')[0]!.querySelector('#command-opt-0'),
    ).toBeTruthy();
  });

  it('has no axe violations (ready state)', async () => {
    const { container } = render(React.createElement(CommandAutocomplete, {
      state: READY,
      matches: READY.status === 'ready' ? READY.commands : [],
      query: '',
      activeIndex: 0,
      listboxId: 'commands-listbox',
      optionId: (i: number) => `command-opt-${i}`,
      onActiveIndexChange: () => undefined,
      onSelect: () => undefined,
      onRetry: () => undefined,
      online: true,
    }));
    expect(await axe(container)).toHaveNoViolations();
  });
});
