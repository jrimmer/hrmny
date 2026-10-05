/**
 * AccountSection — honest substrate mapping: identity rows read-only,
 * two-field profile save, verification resend, password-reset flow, and
 * the inline two-step confirms for sign-out-everywhere and delete.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CurrentUser } from '@cytale/api-client';

import { AccountSection } from '../AccountSection.js';

afterEach(() => cleanup());

const verifiedUser: CurrentUser = {
  id: '9001',
  username: 'jordan',
  display_name: 'Jordan',
  email: 'j@example.com',
  email_verified: true,
  email_verified_at: '2026-01-01T00:00:00Z',
  avatar_url: null,
  created_at: '2026-01-01T00:00:00Z',
};

function renderSection(overrides: Partial<Parameters<typeof AccountSection>[0]> = {}) {
  const props = {
    user: verifiedUser,
    onSaveProfile: vi.fn().mockResolvedValue(undefined),
    onUploadAvatar: vi.fn().mockResolvedValue(undefined),
    onResendVerification: vi.fn().mockResolvedValue(undefined),
    onSendPasswordReset: vi.fn().mockResolvedValue(undefined),
    onSignOutEverywhere: vi.fn().mockResolvedValue(undefined),
    onDeleteAccount: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  render(<AccountSection {...props} />);
  return props;
}

describe('AccountSection — identity', () => {
  it('renders username, email, verified badge, and member-since', () => {
    renderSection();
    expect(screen.getByTestId('account-username').textContent).toBe('jordan');
    expect(screen.getByTestId('account-email').textContent).toBe('j@example.com');
    expect(screen.getByTestId('account-verified')).toBeTruthy();
    expect(screen.queryByTestId('account-resend-verification')).toBeNull();
    expect(screen.getByTestId('account-created').textContent).not.toBe('…');
  });

  it('unverified accounts offer the resend affordance', async () => {
    const onResend = vi.fn().mockResolvedValue(undefined);
    renderSection({
      user: { ...verifiedUser, email_verified: false, email_verified_at: null },
      onResendVerification: onResend,
    });
    await userEvent.setup().click(screen.getByTestId('account-resend-verification'));
    expect(onResend).toHaveBeenCalled();
    expect(screen.queryByTestId('account-verified')).toBeNull();
    expect(screen.getByText(/Email sent — check your inbox/i)).toBeTruthy();
  });
});

describe('AccountSection — profile form', () => {
  it('save disabled until dirty; save sends the patch; saved flash appears', async () => {
    const onSaveProfile = vi.fn().mockResolvedValue(undefined);
    renderSection({ onSaveProfile });

    expect(screen.getByTestId('account-save').hasAttribute('disabled')).toBe(true);

    await userEvent.setup().type(screen.getByTestId('account-display-name'), ' X');
    expect(screen.getByTestId('account-save').hasAttribute('disabled')).toBe(false);

    await userEvent.setup().click(screen.getByTestId('account-save'));
    await waitFor(() => expect(onSaveProfile).toHaveBeenCalled());
    expect(onSaveProfile.mock.calls[0]![0]).toMatchObject({ display_name: 'Jordan X' });
    expect(await screen.findByTestId('account-saved')).toBeTruthy();
  });

  it('save errors surface as an alert and clear the saved flash', async () => {
    const onSaveProfile = vi.fn().mockRejectedValue(new Error('boom'));
    renderSection({ onSaveProfile });

    await userEvent.setup().type(screen.getByTestId('account-display-name'), ' X');
    await userEvent.setup().click(screen.getByTestId('account-save'));
    expect(await screen.findByTestId('account-save-error')).toBeTruthy();
    expect(screen.queryByTestId('account-saved')).toBeNull();
  });
});

describe('AccountSection — password + sessions + danger zone', () => {
  it('password reset sends to the account email', async () => {
    const onSendPasswordReset = vi.fn().mockResolvedValue(undefined);
    renderSection({ onSendPasswordReset });
    await userEvent.setup().click(screen.getByTestId('account-send-reset'));
    expect(onSendPasswordReset).toHaveBeenCalledWith('j@example.com');
    expect(screen.getByTestId('account-reset-sent')).toBeTruthy();
  });

  it('sign out everywhere requires the inline confirm', async () => {
    const onSignOutEverywhere = vi.fn().mockResolvedValue(undefined);
    renderSection({ onSignOutEverywhere });

    await userEvent.setup().click(screen.getByTestId('account-signout-everywhere'));
    expect(onSignOutEverywhere).not.toHaveBeenCalled();

    await userEvent.setup().click(screen.getByTestId('account-signout-confirm-yes'));
    await waitFor(() => expect(onSignOutEverywhere).toHaveBeenCalled());
    expect(screen.queryByTestId('account-signout-confirm')).toBeNull();
  });

  it('cancel steps the confirm back down', async () => {
    const onSignOutEverywhere = vi.fn();
    renderSection({ onSignOutEverywhere });
    await userEvent.setup().click(screen.getByTestId('account-signout-everywhere'));
    await userEvent.setup().click(screen.getByTestId('account-signout-cancel'));
    expect(screen.queryByTestId('account-signout-confirm')).toBeNull();
    expect(onSignOutEverywhere).not.toHaveBeenCalled();
  });

  it('delete account requires the inline confirm', async () => {
    const onDeleteAccount = vi.fn().mockResolvedValue(undefined);
    renderSection({ onDeleteAccount });

    await userEvent.setup().click(screen.getByTestId('account-delete'));
    expect(onDeleteAccount).not.toHaveBeenCalled();

    await userEvent.setup().click(screen.getByTestId('account-delete-confirm-yes'));
    await waitFor(() => expect(onDeleteAccount).toHaveBeenCalled());
  });
});

describe('AccountSection — avatar uploader', () => {
  const AVATAR_URL = '/api/v1/attachments/' + 'a'.repeat(64);

  it('uploads a picked image through onUploadAvatar and surfaces failure', async () => {
    const onUploadAvatar = vi.fn().mockResolvedValue(undefined);
    renderSection({ onUploadAvatar });

    const file = new File([new Uint8Array([0x89, 0x50])], 'me.png', { type: 'image/png' });
    const input = screen.getByTestId('account-avatar-input') as HTMLInputElement;
    await userEvent.setup().upload(input, file);

    // #48: picking stages into the crop dialog first.
    expect(screen.getByTestId('crop-dialog')).toBeTruthy();
    // The dialog's <img> loads the object URL — jsdom never fetches blob:,
    // so prime natural dims + fire load like the dialog suite does.
    const cropImg = screen.getByTestId('crop-image') as HTMLImageElement;
    Object.defineProperty(cropImg, 'naturalWidth', { value: 800 });
    Object.defineProperty(cropImg, 'naturalHeight', { value: 400 });
    fireEvent.load(cropImg);
    await userEvent.setup().click(screen.getByTestId('crop-confirm'));

    // jsdom has no canvas: confirm degrades to the original file bytes.
    await waitFor(() => expect(onUploadAvatar).toHaveBeenCalledTimes(1));
    expect((onUploadAvatar.mock.calls[0]![0] as File).name).toBe('me.png');
    // No error alert on success.
    expect(screen.queryByTestId('account-avatar-error')).toBeNull();
  });

  it('a failed upload shows the error alert and stays retryable', async () => {
    const onUploadAvatar = vi.fn().mockRejectedValue(new Error('too large'));
    renderSection({ onUploadAvatar });

    const file = new File([new Uint8Array([0x89, 0x50])], 'me.png', { type: 'image/png' });
    const input = screen.getByTestId('account-avatar-input') as HTMLInputElement;
    await userEvent.setup().upload(input, file);

    // Stage through the crop dialog, then let the upload fail.
    const cropImg = screen.getByTestId('crop-image') as HTMLImageElement;
    Object.defineProperty(cropImg, 'naturalWidth', { value: 800 });
    Object.defineProperty(cropImg, 'naturalHeight', { value: 400 });
    fireEvent.load(cropImg);
    await userEvent.setup().click(screen.getByTestId('crop-confirm'));

    await waitFor(() =>
      expect(screen.getByTestId('account-avatar-error').textContent).toContain('too large'),
    );

    // Retry: the picker fires again.
    onUploadAvatar.mockResolvedValue(undefined);
    const file2 = new File([new Uint8Array([0x89, 0x50])], 'me2.png', { type: 'image/png' });
    await userEvent.setup().upload(input, file2);
    const cropImg2 = screen.getByTestId('crop-image') as HTMLImageElement;
    Object.defineProperty(cropImg2, 'naturalWidth', { value: 800 });
    Object.defineProperty(cropImg2, 'naturalHeight', { value: 400 });
    fireEvent.load(cropImg2);
    await userEvent.setup().click(screen.getByTestId('crop-confirm'));
    await waitFor(() => expect(onUploadAvatar).toHaveBeenCalledTimes(2));
  });

  it('Remove appears only when an avatar is set and clears via the PATCH seam', async () => {
    const onSaveProfile = vi.fn().mockResolvedValue(undefined);
    // No avatar yet → no Remove.
    renderSection({ onSaveProfile });
    expect(screen.queryByTestId('account-avatar-remove')).toBeNull();

    cleanup();
    // Avatar set → Remove clears through onSaveProfile ("" = explicit clear).
    renderSection({ onSaveProfile, user: { ...verifiedUser, avatar_url: AVATAR_URL } });
    await userEvent.setup().click(screen.getByTestId('account-avatar-remove'));
    await waitFor(() => expect(onSaveProfile).toHaveBeenCalledWith({ avatar_url: '' }));
  });

  it('the preview renders the uploaded image', () => {
    renderSection({ user: { ...verifiedUser, avatar_url: AVATAR_URL } });
    const preview = screen.getByTestId('account-avatar-preview');
    const img = preview.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe(AVATAR_URL);
  });
});
