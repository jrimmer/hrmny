/**
 * TwoFactorSection (#127) — the Account section's TOTP block: absent while
 * the server's switch is off, the enroll walk (QR + secret + confirm code)
 * while unenrolled, and the enrolled state with removal behind the inline
 * two-step confirm. The server's own copy is shown on its refusals.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@cytale/api-client';

import { TwoFactorSection, type TwoFactorSectionProps } from '../TwoFactorSection.js';

afterEach(() => cleanup());

const START = {
  secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
  otpauth_uri: 'otpauth://totp/Hrmny:jordan?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Hrmny',
  algorithm: 'SHA1',
  digits: 6,
  period: 30,
};

type StatusRow = TwoFactorSectionProps['onStatus'] extends () => Promise<infer T> ? T : never;

function renderSection(overrides: {
  status?: StatusRow;
  onStatus?: TwoFactorSectionProps['onStatus'];
  onEnrollStart?: TwoFactorSectionProps['onEnrollStart'];
  onEnrollConfirm?: TwoFactorSectionProps['onEnrollConfirm'];
  onRemove?: TwoFactorSectionProps['onRemove'];
} = {}) {
  const props: TwoFactorSectionProps = {
    onStatus: vi.fn().mockResolvedValue(overrides.status ?? { mode_enabled: true, enrolled: false }),
    onEnrollStart: vi.fn().mockResolvedValue(START),
    onEnrollConfirm: vi.fn().mockResolvedValue({ enrolled: true }),
    onRemove: vi.fn().mockResolvedValue(undefined),
  };
  if (overrides.onStatus) props.onStatus = overrides.onStatus;
  if (overrides.onEnrollStart) props.onEnrollStart = overrides.onEnrollStart;
  if (overrides.onEnrollConfirm) props.onEnrollConfirm = overrides.onEnrollConfirm;
  if (overrides.onRemove) props.onRemove = overrides.onRemove;
  render(<TwoFactorSection {...props} />);
  return props;
}

async function openSetup(): Promise<void> {
  await userEvent.setup().click(screen.getByTestId('settings-twofactor-start'));
  await waitFor(() => expect(screen.getByTestId('settings-twofactor-qr')).toBeTruthy());
}

describe('TwoFactorSection — visibility', () => {
  it('mode off: the section is ABSENT (the feature does not exist client-side)', async () => {
    const { container } = render(
      <TwoFactorSection
        onStatus={vi.fn().mockResolvedValue({ mode_enabled: false, enrolled: false })}
        onEnrollStart={vi.fn()}
        onEnrollConfirm={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId('settings-twofactor')).toBeNull());
    expect(container.querySelector('section')).toBeNull();
  });

  it('a failed status read is a visible alert, not a silent blank', async () => {
    const onStatus = vi.fn().mockRejectedValue(new Error('server down'));
    renderSection({ onStatus });
    await waitFor(() => expect(screen.getByTestId('settings-twofactor-load-error')).toBeTruthy());
    expect(screen.getByTestId('settings-twofactor-load-error').textContent).toBe('server down');
  });

  it('AccountSection renders the block only when the twoFactor callbacks are wired', async () => {
    const { AccountSection } = await import('../AccountSection.js');
    const user = {
      id: '9001',
      username: 'jordan',
      display_name: 'Jordan',
      email: 'j@example.com',
      email_verified: true,
      email_verified_at: '2026-01-01T00:00:00Z',
      avatar_url: null,
      created_at: '2026-01-01T00:00:00Z',
    };
    const base = {
      user,
      onSaveProfile: vi.fn().mockResolvedValue(undefined),
      onUploadAvatar: vi.fn().mockResolvedValue(undefined),
      onResendVerification: vi.fn().mockResolvedValue(undefined),
      onSendPasswordReset: vi.fn().mockResolvedValue(undefined),
      onSignOutEverywhere: vi.fn().mockResolvedValue(undefined),
      onDeleteAccount: vi.fn().mockResolvedValue(undefined),
    };
    const twoFactor = {
      onStatus: vi.fn().mockResolvedValue({ mode_enabled: true, enrolled: false }),
      onEnrollStart: vi.fn().mockResolvedValue(START),
      onEnrollConfirm: vi.fn().mockResolvedValue({ enrolled: true }),
      onRemove: vi.fn().mockResolvedValue(undefined),
    };
    const { rerender } = render(<AccountSection {...base} twoFactor={twoFactor} />);
    await waitFor(() => expect(screen.getByTestId('settings-twofactor')).toBeTruthy());

    rerender(<AccountSection {...base} twoFactor={null} />);
    await waitFor(() => expect(screen.queryByTestId('settings-twofactor')).toBeNull());
  });
});

describe('TwoFactorSection — enroll', () => {
  it('unenrolled: offers the setup, shows QR + secret, confirm flips to enrolled', async () => {
    // The status read is the truth: enrolled:false at mount, enrolled:true
    // after the confirm's refresh.
    const props = renderSection({
      onStatus: vi
        .fn()
        .mockResolvedValueOnce({ mode_enabled: true, enrolled: false })
        .mockResolvedValue({
          mode_enabled: true,
          enrolled: true,
          confirmed_at: '2026-09-15T00:00:00Z',
          last_used_at: null,
        }),
    });
    await waitFor(() => expect(screen.getByTestId('settings-twofactor-start')).toBeTruthy());
    expect(screen.getByTestId('settings-twofactor-state').textContent).toMatch(/is off/);

    await openSetup();
    expect(props.onEnrollStart).toHaveBeenCalledTimes(1);
    // The QR renders client-side from the otpauth URI; the base32 secret is
    // right below it for manual entry.
    expect(screen.getByTestId('settings-twofactor-qr').querySelectorAll('path').length).toBeGreaterThan(0);
    expect(screen.getByTestId('settings-twofactor-secret').textContent).toBe(START.secret);

    await userEvent.setup().type(screen.getByTestId('settings-twofactor-code-input'), '123456');
    await userEvent.setup().click(screen.getByTestId('settings-twofactor-confirm'));

    await waitFor(() => expect(props.onEnrollConfirm).toHaveBeenCalledWith('123456'));
    await waitFor(() =>
      expect(screen.getByTestId('settings-twofactor-state').textContent).toMatch(/is on/),
    );
    expect(props.onStatus).toHaveBeenCalledTimes(2); // mount + post-confirm refresh
  });

  it("a wrong code shows the server's message and keeps the setup on screen", async () => {
    const props = renderSection({
      onEnrollConfirm: vi.fn().mockRejectedValue(
        new ApiError({
          key: 'INVALID_CODE',
          code: 40001,
          message: "That code didn't match. Check your authenticator app and try again.",
          status: 400,
        }),
      ),
    });
    await waitFor(() => expect(screen.getByTestId('settings-twofactor-start')).toBeTruthy());
    await openSetup();

    await userEvent.setup().type(screen.getByTestId('settings-twofactor-code-input'), '000000');
    await userEvent.setup().click(screen.getByTestId('settings-twofactor-confirm'));

    await waitFor(() =>
      expect(screen.getByTestId('settings-twofactor-error').textContent).toMatch(/didn't match/),
    );
    // The walk (QR + secret) stays — a typo must not lose the setup.
    expect(screen.getByTestId('settings-twofactor-qr')).toBeTruthy();
    expect(screen.getByTestId('settings-twofactor-secret')).toBeTruthy();
  });

  it('cancel backs out of the setup walk', async () => {
    renderSection();
    await waitFor(() => expect(screen.getByTestId('settings-twofactor-start')).toBeTruthy());
    await openSetup();

    await userEvent.setup().click(screen.getByTestId('settings-twofactor-cancel'));
    await waitFor(() => expect(screen.getByTestId('settings-twofactor-start')).toBeTruthy());
    expect(screen.queryByTestId('settings-twofactor-qr')).toBeNull();
  });

  it('a failed enroll start shows the server message and stays retryable', async () => {
    renderSection({
      onEnrollStart: vi.fn().mockRejectedValue(
        new ApiError({
          key: 'ALREADY_ENROLLED',
          code: 40901,
          message: 'This account already has two-factor authentication. Remove it first to re-enroll.',
          status: 409,
        }),
      ),
    });
    await waitFor(() => expect(screen.getByTestId('settings-twofactor-start')).toBeTruthy());

    await userEvent.setup().click(screen.getByTestId('settings-twofactor-start'));
    await waitFor(() =>
      expect(screen.getByTestId('settings-twofactor-error').textContent).toMatch(/already has two-factor/),
    );
    expect(screen.getByTestId('settings-twofactor-start')).toBeTruthy();
  });
});

describe('TwoFactorSection — enrolled state + remove', () => {
  it('shows the enrolled state with dates, and removes behind the two-step confirm', async () => {
    const props = renderSection({
      status: {
        mode_enabled: true,
        enrolled: true,
        confirmed_at: '2026-09-01T00:00:00Z',
        last_used_at: '2026-09-14T00:00:00Z',
      },
    });
    await waitFor(() => expect(screen.getByTestId('settings-twofactor-state').textContent).toMatch(/is on/));

    await userEvent.setup().click(screen.getByTestId('settings-twofactor-remove-trigger'));
    expect(props.onRemove).not.toHaveBeenCalled();
    expect(screen.getByTestId('settings-twofactor-remove-armed')).toBeTruthy();

    await userEvent.setup().click(screen.getByTestId('settings-twofactor-remove-confirm'));
    await waitFor(() => expect(props.onRemove).toHaveBeenCalledTimes(1));
    // Removal completes and the block flips to the (re-)enroll affordance —
    // allowed while the switch is on: the next password login re-prompts.
    await waitFor(() => expect(screen.getByTestId('settings-twofactor-start')).toBeTruthy());
  });

  it('cancel steps the removal confirm back down', async () => {
    const props = renderSection({ status: { mode_enabled: true, enrolled: true } });
    await waitFor(() => expect(screen.getByTestId('settings-twofactor-remove-trigger')).toBeTruthy());

    await userEvent.setup().click(screen.getByTestId('settings-twofactor-remove-trigger'));
    await userEvent.setup().click(screen.getByTestId('settings-twofactor-remove-cancel'));

    expect(props.onRemove).not.toHaveBeenCalled();
    expect(screen.queryByTestId('settings-twofactor-remove-armed')).toBeNull();
  });

  it('a removal failure is visible and the enrolled state stands', async () => {
    const props = renderSection({
      onRemove: vi.fn().mockRejectedValue(new Error('No enrollment on this account.')),
      status: { mode_enabled: true, enrolled: true },
    });
    await waitFor(() => expect(screen.getByTestId('settings-twofactor-remove-trigger')).toBeTruthy());

    await userEvent.setup().click(screen.getByTestId('settings-twofactor-remove-trigger'));
    await userEvent.setup().click(screen.getByTestId('settings-twofactor-remove-confirm'));

    await waitFor(() =>
      expect(screen.getByTestId('settings-twofactor-remove-error').textContent).toMatch(/No enrollment/),
    );
    expect(screen.getByTestId('settings-twofactor-state').textContent).toMatch(/is on/);
  });
});
