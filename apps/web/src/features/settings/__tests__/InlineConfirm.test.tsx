/**
 * @cytale/web — inline confirm tests (U13).
 *
 * The no-native-dialogs pattern: arming announces the consequence
 * (role=alert) and focuses Cancel; Cancel/Esc leave state unchanged;
 * Confirm executes exactly once; disabled (offline) never arms.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InlineConfirm } from '../InlineConfirm.js';

afterEach(() => {
  cleanup();
});

function renderConfirm(props: Partial<Parameters<typeof InlineConfirm>[0]> = {}) {
  const onConfirm = vi.fn();
  render(
    <InlineConfirm
      label="Revoke"
      consequence="This disconnects the bot immediately."
      onConfirm={onConfirm}
      testId="ic"
      {...props}
    />,
  );
  return { onConfirm };
}

describe('InlineConfirm', () => {
  it('arming shows the consequence as an alert and focuses Cancel', async () => {
    renderConfirm();
    await userEvent.setup().click(screen.getByTestId('ic-trigger'));

    expect(screen.getByRole('alert').textContent).toMatch(/disconnects the bot immediately/i);
    await (await import('@testing-library/react')).waitFor(() =>
      expect((document.activeElement as HTMLElement).getAttribute('data-testid')).toBe('ic-cancel'),
    );
  });

  it('Cancel disarms without executing', async () => {
    const { onConfirm } = renderConfirm();
    await userEvent.setup().click(screen.getByTestId('ic-trigger'));
    await userEvent.setup().click(screen.getByTestId('ic-cancel'));

    expect(screen.queryByTestId('ic-armed')).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('Esc disarms without executing', async () => {
    const { onConfirm } = renderConfirm();
    await userEvent.setup().click(screen.getByTestId('ic-trigger'));
    fireEvent.keyDown(screen.getByTestId('ic-armed'), { key: 'Escape' });

    expect(screen.queryByTestId('ic-armed')).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('Confirm executes the action and disarms', async () => {
    const { onConfirm } = renderConfirm();
    await userEvent.setup().click(screen.getByTestId('ic-trigger'));
    await userEvent.setup().click(screen.getByTestId('ic-confirm'));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('ic-armed')).toBeNull();
  });

  it('armed confirm buttons read through the onaccent token, never raw text-white', async () => {
    renderConfirm({ tone: 'danger', testId: 'ic-danger' });
    await userEvent.setup().click(screen.getByTestId('ic-danger-trigger'));

    const confirm = screen.getByTestId('ic-danger-confirm');
    expect(confirm.className).toContain('bg-danger');
    expect(confirm.className).toContain('text-text-onaccent');
    expect(confirm.className).not.toContain('text-white');
  });

  it('disabled trigger cannot arm', async () => {
    const { onConfirm } = renderConfirm({ disabled: true });
    expect(screen.getByTestId('ic-trigger').hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByTestId('ic-trigger'));
    expect(screen.queryByTestId('ic-armed')).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
