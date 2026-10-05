/**
 * @cytale/web — once-only token reveal modal tests (U13).
 *
 * Contracts: focus lands on the copy action when the moment starts; Tab is
 * trapped inside the modal; copy feedback flips to "Copied!"; dismissal
 * fires exactly once and the recovery copy names Regenerate.
 */
import { axe } from 'vitest-axe';
import type { AxeMatchers } from 'vitest-axe/matchers';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

declare module 'vitest' {
  interface Assertion<T> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}

import { TokenReveal } from '../TokenReveal.js';
import { stubClipboard } from './helpers.js';

beforeEach(() => {
  stubClipboard();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderModal(open = true) {
  const onDismiss = vi.fn();
  render(<TokenReveal open={open} title="Bot token" token="cytbot_xyz" onDismiss={onDismiss} />);
  return { onDismiss };
}

describe('TokenReveal — the once-only moment', () => {
  it('shows the token with shown-once copy naming the regenerate recovery', () => {
    renderModal();
    expect(screen.getByTestId('token-reveal-value').getAttribute('value')).toBe('cytbot_xyz');
    // The scrim dims through the semantic overlay token, never raw black.
    expect(screen.getByTestId('token-reveal-overlay').className).toContain('bg-scrim');
    const note = screen.getByTestId('token-reveal-once-note').textContent ?? '';
    expect(note).toMatch(/shown only once/i);
    expect(note).toMatch(/regenerate/i);
  });

  it('focus lands on the credential (selected) when the reveal opens', async () => {
    renderModal();
    await waitFor(() => {
      const focused = document.activeElement as HTMLElement | null;
      expect(focused?.getAttribute('data-testid')).toBe('token-reveal-value');
      // The value selects itself on focus — Ctrl+C works immediately.
      expect((focused as HTMLInputElement).value).toBe('cytbot_xyz');
    });
  });

  it('copy writes the token and flips to Copied!', async () => {
    const { writeText } = stubClipboard();
    renderModal();
    fireEvent.click(screen.getByTestId('token-reveal-copy'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('cytbot_xyz'));
    await waitFor(() => expect(screen.getByTestId('token-reveal-copy').textContent).toBe('Copied!'));
  });

  it('Done dismisses (focus-trapped Esc dismisses too)', async () => {
    const { onDismiss } = renderModal();
    await userEvent.setup().click(screen.getByTestId('token-reveal-done'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('Esc inside the modal dismisses via the dialog layer', async () => {
    const { onDismiss } = renderModal();
    fireEvent.keyDown(screen.getByTestId('token-reveal'), { key: 'Escape' });
    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
  });

  it('Tab is trapped inside the modal (keyboard walkthrough)', async () => {
    renderModal();
    const modal = screen.getByTestId('token-reveal');
    const user = userEvent.setup();
    for (let i = 0; i < 6; i += 1) {
      await user.tab();
      expect(modal.contains(document.activeElement)).toBe(true);
    }
  });

  it('axe: zero violations', async () => {
    renderModal();
    expect(await axe(screen.getByTestId('token-reveal'))).toHaveNoViolations();
  });
});
