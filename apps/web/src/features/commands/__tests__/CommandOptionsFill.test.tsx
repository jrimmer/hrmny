/**
 * @cytale/web — CommandOptionsFill tests (bots plan U9).
 *
 * The options-fill phase: per-option inputs from the registered options JSON
 * (name, description, required flag), the required gate disabling Run,
 * value plumbing, Enter submit / Escape cancel, and the offline/pending
 * disable. axe zero violations.
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

import { CommandOptionsFill, requiredMissing } from '../CommandOptionsFill.js';

const ECHO: ApplicationCommand = {
  id: '9100000000000002',
  application_id: '8000000000000001',
  name: 'echo',
  description: 'Echoes text',
  options: [
    { name: 'text', description: 'What to echo', required: true },
    { name: 'decoration', description: 'Optional flair' },
  ],
};

const ZERO: ApplicationCommand = {
  id: '9100000000000001',
  application_id: '8000000000000001',
  name: 'shrug',
  description: 'Appends a shrug',
  options: null,
};

function renderFill(overrides: Partial<Parameters<typeof CommandOptionsFill>[0]> = {}) {
  const props = {
    command: ECHO,
    values: {},
    onChange: vi.fn(),
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  render(React.createElement(CommandOptionsFill, props));
  return props;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('CommandOptionsFill', () => {
  it('renders one labelled input per registered option with required markers', () => {
    renderFill();
    const required = screen.getByTestId('command-option-input-text');
    const optional = screen.getByTestId('command-option-input-decoration');
    expect(required.getAttribute('aria-required')).toBe('true');
    expect(optional.getAttribute('aria-required')).toBeNull();
    expect(screen.getByTestId('command-option-required').textContent).toBe(' (required)');
    // Labels are wired to the inputs.
    expect(screen.getByLabelText('text (required)')).toBe(required);
  });

  it('disables Run while a required option is empty; filling it re-arms', () => {
    const props = renderFill();
    const run = screen.getByTestId('command-invoke') as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    expect(screen.getByTestId('command-options-fill').getAttribute('role')).toBe('group');

    fireEvent.change(screen.getByTestId('command-option-input-text'), {
      target: { value: 'hello' },
    });
    expect(props.onChange).toHaveBeenCalledWith('text', 'hello');
  });

  it('submits on Run click when armed and plumbs filled values', () => {
    const props = renderFill({ values: { text: 'hi', decoration: '!' } });
    const run = screen.getByTestId('command-invoke') as HTMLButtonElement;
    expect(run.disabled).toBe(false);
    // The accent Run reads through the onaccent token, never raw text-white.
    expect(run.className).toContain('bg-accent');
    expect(run.className).toContain('text-text-onaccent');
    expect(run.className).not.toContain('text-white');
    fireEvent.click(run);
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
  });

  it('Enter in an input submits when armed and is inert while blocked', () => {
    const props = renderFill({ values: {} });
    fireEvent.keyDown(screen.getByTestId('command-option-input-text'), {
      key: 'Enter',
    });
    expect(props.onSubmit).not.toHaveBeenCalled();

    cleanup();
    const armed = renderFill({ values: { text: 'hi' } });
    fireEvent.keyDown(screen.getByTestId('command-option-input-text'), {
      key: 'Enter',
    });
    expect(armed.onSubmit).toHaveBeenCalledTimes(1);
  });

  it('Escape cancels back to compose', () => {
    const props = renderFill({ values: { text: 'hi' } });
    fireEvent.keyDown(screen.getByTestId('command-options-fill'), { key: 'Escape' });
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it('stays disabled while pending or offline even with values filled', () => {
    renderFill({ values: { text: 'hi' }, disabled: true });
    expect((screen.getByTestId('command-invoke') as HTMLButtonElement).disabled).toBe(true);
  });

  it('requiredMissing reflects the gate for zero-option and empty arrays', () => {
    expect(requiredMissing(ECHO, {})).toBe(true);
    expect(requiredMissing(ECHO, { text: 'hi' })).toBe(false);
    expect(requiredMissing(ZERO, {})).toBe(false);
  });

  it('has no axe violations', async () => {
    const { container } = render(React.createElement(CommandOptionsFill, {
      command: ECHO,
      values: { text: 'partly' },
      onChange: () => undefined,
      onSubmit: () => undefined,
      onCancel: () => undefined,
    }));
    expect(await axe(container)).toHaveNoViolations();
  });
});
