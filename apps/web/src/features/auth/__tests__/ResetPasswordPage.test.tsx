/**
 * U19 + hardening 6.4 — the reset link's expiry copy. The key rename makes the
 * server emit `token_invalid`/`token_consumed` (lower_snake); the page accepts
 * BOTH spellings during the rename window, so each is exercised here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { ApiError } from '@cytale/api-client';

const completePasswordResetMock = vi.fn();

vi.mock('../useAuth.js', () => ({
  useAuth: () => ({ completePasswordReset: completePasswordResetMock }),
}));

import { ResetPasswordPage } from '../ResetPasswordPage.js';

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function submit(): void {
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'correct-horse' } });
  fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));
}

describe('ResetPasswordPage — dead-link copy across the 6.4 rename window', () => {
  it.each(['token_invalid', 'TOKEN_INVALID', 'token_consumed', 'TOKEN_CONSUMED'])(
    '%s renders the invalid-or-expired copy',
    async (key) => {
      completePasswordResetMock.mockRejectedValue(
        new ApiError({ key, code: 41001, message: 'nope', status: 410 }),
      );

      render(<ResetPasswordPage token="tok" />);
      submit();

      await waitFor(() =>
        expect(screen.getByTestId('reset-error').textContent).toContain(
          'This reset link is invalid or expired. Request a fresh one.',
        ),
      );
    },
  );

  it('an unrelated failure keeps the generic copy', async () => {
    completePasswordResetMock.mockRejectedValue(
      new ApiError({ key: 'server_error', code: 50001, message: 'boom', status: 500 }),
    );

    render(<ResetPasswordPage token="tok" />);
    submit();

    await waitFor(() =>
      expect(screen.getByTestId('reset-error').textContent).toContain(
        'Could not reset the password. Try again.',
      ),
    );
  });
});
