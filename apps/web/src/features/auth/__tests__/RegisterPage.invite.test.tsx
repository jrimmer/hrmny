/**
 * Security Tier 2 #5 — invite-only sign-up. The parked invite code rides the
 * register call and is cleared once spent; a closed server's refusal and a
 * dead invite each render their own explanation instead of the generic copy.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { ApiError } from '@cytale/api-client';

const registerMock = vi.fn();

vi.mock('../useAuth.js', () => ({
  useAuth: () => ({ register: registerMock }),
}));

import { PENDING_INVITE_KEY, RegisterPage } from '../RegisterPage.js';

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  sessionStorage.clear();
});

function fillAndSubmit(): void {
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'newbie' } });
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'newbie@example.com' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'super-secret-9' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
}

describe('RegisterPage — invite-only sign-up', () => {
  it('sends the parked invite code, then clears it once the account is made', async () => {
    sessionStorage.setItem(PENDING_INVITE_KEY, 'abc123');
    registerMock.mockResolvedValue(undefined);
    const onNavigate = vi.fn();

    render(<RegisterPage onNavigate={onNavigate} />);
    expect(screen.getByTestId('register-invite-note')).toBeTruthy();
    fillAndSubmit();

    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('/verify-email'));
    expect(registerMock).toHaveBeenCalledWith('newbie', 'newbie@example.com', 'super-secret-9', 'abc123');
    expect(sessionStorage.getItem(PENDING_INVITE_KEY)).toBeNull();
  });

  it('without an invite, a closed server reads as invite-only, not a generic failure', async () => {
    registerMock.mockRejectedValue(
      new ApiError({ key: 'registration_closed', code: 40301, message: 'closed', status: 403 }),
    );

    render(<RegisterPage />);
    expect(screen.queryByTestId('register-invite-note')).toBeNull();
    fillAndSubmit();

    await waitFor(() =>
      expect(screen.getByTestId('register-error').textContent).toContain('by invitation only'),
    );
    expect(registerMock).toHaveBeenCalledWith('newbie', 'newbie@example.com', 'super-secret-9', undefined);
  });

  it('a dead invite says so and keeps the parked code for the landing page', async () => {
    sessionStorage.setItem(PENDING_INVITE_KEY, 'stale');
    registerMock.mockRejectedValue(
      new ApiError({ key: 'invite_invalid', code: 40301, message: 'dead', status: 403 }),
    );

    render(<RegisterPage />);
    fillAndSubmit();

    await waitFor(() =>
      expect(screen.getByTestId('register-error').textContent).toContain('no longer valid'),
    );
    expect(sessionStorage.getItem(PENDING_INVITE_KEY)).toBe('stale');
  });
});
