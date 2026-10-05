/**
 * ConfirmDialog — the app-styled replacement for window.confirm/alert.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { ConfirmDialog } from '../ConfirmDialog.js';

afterEach(cleanup);

function renderDialog(overrides: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
  const onOpenChange = vi.fn();
  const onConfirm = vi.fn();
  const utils = render(
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      title="Delete Message"
      body="This cannot be undone."
      confirmLabel="Delete"
      danger
      testId="confirm-test"
      onConfirm={onConfirm}
      {...overrides}
    />,
  );
  return { ...utils, onOpenChange, onConfirm };
}

describe('ConfirmDialog', () => {
  it('renders the app-styled panel with title, body and both actions', () => {
    renderDialog();
    expect(screen.getByTestId('confirm-test')).toBeTruthy();
    expect(screen.getByText('Delete Message')).toBeTruthy();
    expect(screen.getByTestId('confirm-test-body').textContent).toContain('cannot be undone');
    expect(screen.getByTestId('confirm-test-confirm').textContent).toBe('Delete');
    expect(screen.getByTestId('confirm-test-cancel')).toBeTruthy();
  });

  it('confirm fires onConfirm; cancel closes via onOpenChange', () => {
    const { onConfirm, onOpenChange } = renderDialog();
    fireEvent.click(screen.getByTestId('confirm-test-confirm'));
    expect(onConfirm).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByTestId('confirm-test-cancel'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('alert shape (cancelLabel null) renders a single dismiss action', () => {
    renderDialog({ cancelLabel: null, confirmLabel: 'OK', danger: false });
    expect(screen.queryByTestId('confirm-test-cancel')).toBeNull();
    expect(screen.getByTestId('confirm-test-confirm').textContent).toBe('OK');
  });
});
