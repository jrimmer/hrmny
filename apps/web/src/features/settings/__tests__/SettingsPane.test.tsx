/**
 * SettingsPane — the column-3 frame: title, close button, and the
 * Escape-to-close contract (disabled while an overlay owns Escape).
 */
import { axe } from 'vitest-axe';
import type { AxeMatchers } from 'vitest-axe/matchers';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

declare module 'vitest' {
  interface Assertion<T> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}

import { SettingsPane } from '../SettingsPane.js';

afterEach(() => cleanup());

describe('SettingsPane', () => {
  it('renders the section title and content', () => {
    render(
      <SettingsPane title="My Account" onClose={() => undefined}>
        <p data-testid="section-body">body</p>
      </SettingsPane>,
    );
    expect(screen.getByTestId('settings-pane-title').textContent).toBe('My Account');
    expect(screen.getByTestId('section-body')).toBeTruthy();
  });

  it('close button reports back', async () => {
    const onClose = vi.fn();
    render(
      <SettingsPane title="Appearance" onClose={onClose}>
        <p />
      </SettingsPane>,
    );
    await userEvent.setup().click(screen.getByTestId('settings-close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('Escape closes when enabled', () => {
    const onClose = vi.fn();
    render(
      <SettingsPane title="Integrations" onClose={onClose}>
        <p />
      </SettingsPane>,
    );
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('Escape is inert while an overlay owns it (escapeEnabled=false)', () => {
    const onClose = vi.fn();
    render(
      <SettingsPane title="Integrations" onClose={onClose} escapeEnabled={false}>
        <p />
      </SettingsPane>,
    );
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('has no accessibility violations', async () => {
    render(
      <SettingsPane title="My Account" onClose={() => undefined}>
        <p>content</p>
      </SettingsPane>,
    );
    expect(await axe(document.body)).toHaveNoViolations();
  });
});

describe('SettingsPane — the ← back affordance (U5 mobile section view)', () => {
  it('onBack swaps the ✕ for the ← back control (affordances split)', () => {
    render(
      <SettingsPane title="My Account" onClose={() => undefined} onBack={() => undefined}>
        <p>content</p>
      </SettingsPane>,
    );
    // The section view carries ← back to the list; the ✕ belongs to the
    // list header at mobile.
    expect(screen.queryByTestId('settings-close')).toBeNull();
    const back = screen.getByTestId('settings-back');
    expect(back.getAttribute('aria-label')).toMatch(/back/i);
    expect(back.textContent).toBe('←');
    expect(screen.getByTestId('settings-pane-title').textContent).toBe('My Account');
  });

  it('← reports back without closing (onBack fires, onClose does not)', async () => {
    const onBack = vi.fn();
    const onClose = vi.fn();
    render(
      <SettingsPane title="Appearance" onClose={onClose} onBack={onBack}>
        <p />
      </SettingsPane>,
    );
    await userEvent.setup().click(screen.getByTestId('settings-back'));
    expect(onBack).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Escape in a section routes to the list (onBack), not the close', () => {
    const onBack = vi.fn();
    const onClose = vi.fn();
    render(
      <SettingsPane title="Appearance" onClose={onClose} onBack={onBack}>
        <p />
      </SettingsPane>,
    );
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onBack).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('escapeEnabled=false keeps Escape inert even with a back target (overlay doctrine)', () => {
    const onBack = vi.fn();
    render(
      <SettingsPane
        title="Integrations"
        onClose={() => undefined}
        onBack={onBack}
        escapeEnabled={false}
      >
        <p />
      </SettingsPane>,
    );
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onBack).not.toHaveBeenCalled();
  });

  it('without onBack (desktop) neither the back control nor any DOM change appears', () => {
    render(
      <SettingsPane title="My Account" onClose={() => undefined}>
        <p>content</p>
      </SettingsPane>,
    );
    expect(screen.queryByTestId('settings-back')).toBeNull();
    expect(screen.getByTestId('settings-close')).toBeTruthy();
  });

  it('has no accessibility violations with the back control', async () => {
    render(
      <SettingsPane title="My Account" onClose={() => undefined} onBack={() => undefined}>
        <p>content</p>
      </SettingsPane>,
    );
    expect(await axe(document.body)).toHaveNoViolations();
  });
});
