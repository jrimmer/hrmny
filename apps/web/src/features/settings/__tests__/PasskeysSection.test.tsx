/**
 * PasskeysSection (#36) — the Account section's passkeys block: loads the
 * account's list, enrolls a NAMED passkey, and revokes behind the same inline
 * two-step confirm the other destructive actions use. Errors are visible.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PasskeysSection } from '../PasskeysSection.js';

afterEach(() => cleanup());

const row = (id: string, name: string, lastUsed: string | null = null) => ({
  id,
  name,
  created_at: '2026-09-15T00:00:00Z',
  last_used_at: lastUsed,
});

function renderSection(overrides: { onEnroll?: never; onRemove?: never; onList?: never } = {}) {
  const props = {
    onEnroll: vi.fn().mockResolvedValue(row('new-1', 'New')),
    onRemove: vi.fn().mockResolvedValue(undefined),
    onList: vi.fn().mockResolvedValue([row('c-1', 'MacBook Touch ID', '2026-09-15T01:00:00Z')]),
    ...overrides,
  };
  render(<PasskeysSection {...props} />);
  return props;
}

describe('PasskeysSection — list', () => {
  it('renders enrolled credentials with name, added date, and last use', async () => {
    renderSection();
    await waitFor(() => expect(screen.getAllByTestId('settings-passkeys-row')).toHaveLength(1));
    expect(screen.getByTestId('settings-passkeys-name').textContent).toBe('MacBook Touch ID');
    expect(screen.getByTestId('settings-passkeys-meta').textContent).toMatch(/last used/);
  });

  it('an empty list says so instead of rendering nothing', async () => {
    renderSection({ onList: vi.fn().mockResolvedValue([]) } as never);
    await waitFor(() => expect(screen.getByTestId('settings-passkeys-empty')).toBeTruthy());
  });

  it('a failed list read is a visible alert, not a blank block', async () => {
    renderSection({ onList: vi.fn().mockRejectedValue(new Error('server down')) } as never);
    await waitFor(() => expect(screen.getByTestId('settings-passkeys-load-error')).toBeTruthy());
    expect(screen.getByTestId('settings-passkeys-load-error').textContent).toBe('server down');
  });
});

describe('PasskeysSection — add', () => {
  it('enrolls with the typed name, then refreshes the list', async () => {
    const props = renderSection();
    await waitFor(() => expect(screen.getByTestId('settings-passkeys-add')).toBeTruthy());

    await userEvent.setup().type(screen.getByTestId('settings-passkeys-name-input'), 'Yubikey 5');
    await userEvent.setup().click(screen.getByTestId('settings-passkeys-add'));

    await waitFor(() => expect(props.onEnroll).toHaveBeenCalledWith('Yubikey 5'));
    await waitFor(() => expect(props.onList).toHaveBeenCalledTimes(2));
    // The name input cleared.
    expect((screen.getByTestId('settings-passkeys-name-input') as HTMLInputElement).value).toBe('');
  });

  it('an empty name falls back to a default label instead of sending whitespace', async () => {
    const props = renderSection();
    await waitFor(() => expect(screen.getByTestId('settings-passkeys-add')).toBeTruthy());
    await userEvent.setup().click(screen.getByTestId('settings-passkeys-add'));
    await waitFor(() => expect(props.onEnroll).toHaveBeenCalledWith('Passkey'));
  });

  it('an enrollment failure is visible (e.g. cancelled prompt)', async () => {
    renderSection({ onEnroll: vi.fn().mockRejectedValue(new Error('Passkey prompt was cancelled.')) } as never);
    await waitFor(() => expect(screen.getByTestId('settings-passkeys-add')).toBeTruthy());
    await userEvent.setup().click(screen.getByTestId('settings-passkeys-add'));
    await waitFor(() => expect(screen.getByTestId('settings-passkeys-error')).toBeTruthy());
    expect(screen.getByTestId('settings-passkeys-error').textContent).toMatch(/cancelled/);
  });
});

describe('PasskeysSection — remove', () => {
  it('revokes behind the two-step confirm, then refreshes', async () => {
    const props = renderSection();
    await waitFor(() => expect(screen.getByTestId('settings-passkeys-remove-trigger')).toBeTruthy());

    await userEvent.setup().click(screen.getByTestId('settings-passkeys-remove-trigger'));
    expect(screen.getByTestId('settings-passkeys-remove-armed')).toBeTruthy();

    await userEvent.setup().click(screen.getByTestId('settings-passkeys-remove-confirm'));
    await waitFor(() => expect(props.onRemove).toHaveBeenCalledWith('c-1'));
    await waitFor(() => expect(props.onList).toHaveBeenCalledTimes(2));
  });

  it('cancel backs out without removing', async () => {
    const props = renderSection();
    await waitFor(() => expect(screen.getByTestId('settings-passkeys-remove-trigger')).toBeTruthy());

    await userEvent.setup().click(screen.getByTestId('settings-passkeys-remove-trigger'));
    await userEvent.setup().click(screen.getByTestId('settings-passkeys-remove-cancel'));

    expect(props.onRemove).not.toHaveBeenCalled();
    expect(screen.queryByTestId('settings-passkeys-remove-armed')).toBeNull();
  });

  it('a removal failure is visible', async () => {
    renderSection({ onRemove: vi.fn().mockRejectedValue(new Error('No such passkey on this account.')) } as never);
    await waitFor(() => expect(screen.getByTestId('settings-passkeys-remove-trigger')).toBeTruthy());

    await userEvent.setup().click(screen.getByTestId('settings-passkeys-remove-trigger'));
    await userEvent.setup().click(screen.getByTestId('settings-passkeys-remove-confirm'));

    await waitFor(() => expect(screen.getByTestId('settings-passkeys-remove-error')).toBeTruthy());
    expect(screen.getByTestId('settings-passkeys-remove-error').textContent).toMatch(/No such passkey/);
  });
});
