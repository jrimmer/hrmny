/**
 * SettingsNav — the column-2 menu: curated sections, the visible-but-dead
 * Voice & Video row, logout footer, and a11y structure.
 *
 * U5 — the mobile variant: below 768px the nav renders as the pane's
 * full-width LIST (rows at ≥44px, Log out as the final row) with the ✕
 * close + Escape contract in its header (the section views carry the ←
 * back instead — see SettingsPane.test.tsx).
 */
import { axe } from 'vitest-axe';
import type { AxeMatchers } from 'vitest-axe/matchers';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

declare module 'vitest' {
  interface Assertion<T> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}

import { SettingsNav } from '../SettingsNav.js';

const WEB_ROOT = join(__dirname, '..', '..', '..', '..');

afterEach(() => cleanup());

function renderNav(active: 'account' | 'appearance' | 'integrations' = 'account') {
  const onSelect = vi.fn();
  const onLogout = vi.fn();
  render(<SettingsNav active={active} onSelect={onSelect} onLogout={onLogout} />);
  return { onSelect, onLogout };
}

describe('SettingsNav', () => {
  it('renders the curated sections with the active one marked', () => {
    renderNav('appearance');
    expect(screen.getByTestId('settings-nav-account')).toBeTruthy();
    expect(screen.getByTestId('settings-nav-appearance').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('settings-nav-account').getAttribute('aria-current')).toBeNull();
    expect(screen.getByTestId('settings-nav-integrations')).toBeTruthy();
  });

  it('selection reports the section id', async () => {
    const { onSelect } = renderNav('account');
    await userEvent.setup().click(screen.getByTestId('settings-nav-integrations'));
    expect(onSelect).toHaveBeenCalledWith('integrations');
  });

  it('Voice & Video is visible but dead, with the reason in its title', () => {
    renderNav();
    const row = screen.getByTestId('settings-nav-voice');
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(row.getAttribute('title')).toMatch(/video and screenshare/i);
  });

  it('logout footer reports back', async () => {
    const { onLogout } = renderNav();
    await userEvent.setup().click(screen.getByTestId('settings-nav-logout'));
    expect(onLogout).toHaveBeenCalled();
  });

  it('has no accessibility violations', async () => {
    renderNav();
    // Scoped to the nav landmark — the header/footer bands ride inside the
    // shell's sidebar region in the composed app.
    expect(await axe(screen.getByRole('navigation', { name: 'User settings' }))).toHaveNoViolations();
  });
});

describe('SettingsNav — mobile full-width list (U5)', () => {
  function renderMobileList(active: 'account' | 'appearance' | 'integrations' = 'account') {
    const onSelect = vi.fn();
    const onLogout = vi.fn();
    const onClose = vi.fn();
    render(
      <SettingsNav
        active={active}
        onSelect={onSelect}
        onLogout={onLogout}
        mobile
        onClose={onClose}
      />,
    );
    return { onSelect, onLogout, onClose };
  }

  it('renders every section + the dead voice row + Log out as rows of one list', () => {
    renderMobileList();
    // All sections, the honest-dead Voice & Video row, and Log out — the
    // desktop footer's flow, now the list's FINAL row.
    for (const id of [
      'settings-nav-account',
      'settings-nav-appearance',
      'settings-nav-emoji',
      'settings-nav-integrations',
      'settings-nav-voice',
      'settings-nav-logout',
    ]) {
      expect(screen.getByTestId(id), id).toBeTruthy();
    }
    const rows = screen.getByRole('list').querySelectorAll('li');
    const lastRow = rows[rows.length - 1]!;
    expect(lastRow.querySelector('[data-testid="settings-nav-logout"]')).toBeTruthy();
    // The mobile variant is flagged for the shell/composed contract.
    expect(screen.getByTestId('settings-nav').getAttribute('data-mobile')).toBe('true');
  });

  it('rows carry the list-row class; the ≥44px hit area is pinned at the stylesheet (mobile block)', () => {
    renderMobileList();
    for (const id of [
      'settings-nav-account',
      'settings-nav-appearance',
      'settings-nav-emoji',
      'settings-nav-integrations',
      'settings-nav-logout',
    ]) {
      expect(screen.getByTestId(id).className).toContain('settings-list-row');
    }
    // jsdom has no layout engine — pin the geometry in shell.css, inside the
    // ≤767px block so the desktop col-2 menu is untouched.
    const css = readFileSync(join(WEB_ROOT, 'src', 'app', 'theme', 'shell.css'), 'utf8');
    const mobileBlock = css.slice(css.indexOf('@media (max-width: 767px)'));
    const rowRule = mobileBlock.slice(mobileBlock.indexOf('.settings-list-row'));
    expect(rowRule).toContain('min-height: 44px');
  });

  it('selection reports the section id', async () => {
    const { onSelect } = renderMobileList();
    await userEvent.setup().click(screen.getByTestId('settings-nav-appearance'));
    expect(onSelect).toHaveBeenCalledWith('appearance');
  });

  it('the list header keeps the explicit ✕ that closes settings entirely', async () => {
    const { onClose } = renderMobileList();
    await userEvent.setup().click(screen.getByTestId('settings-nav-close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('Escape on the list closes settings (the existing close contract)', () => {
    const { onClose } = renderMobileList();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('logout from the list reports back through the same prop the desktop footer uses', async () => {
    const { onLogout } = renderMobileList();
    await userEvent.setup().click(screen.getByTestId('settings-nav-logout'));
    expect(onLogout).toHaveBeenCalled();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <SettingsNav
        active="account"
        onSelect={() => undefined}
        onLogout={() => undefined}
        mobile
        onClose={() => undefined}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
