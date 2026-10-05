/**
 * PasskeyEnrollmentPrompt — the post-PASSWORD-login "set up a passkey?" ask
 * (owner direction 2026-09-15). No module mocks: the prompt's api seams are
 * injected props and the flag/dismissal state is the real passkeyPrompt
 * module against real (jsdom) localStorage. Its contract:
 *
 *   (a) armed ONLY by a password login — no flag, no render, not even a list
 *       read; a passkey/SSO login (no flag) never sees it;
 *   (b) an account WITH a passkey never sees it;
 *   (c) Set up runs the enroll ceremony once and resolves to a confirmation;
 *   (d) Not now persists `cytale.passkey-prompt-dismissed` and survives a
 *       re-login;
 *   (e) a failed ceremony is visible, stays retryable, and is NOT recorded
 *       as a dismissal.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { WebauthnCredential } from '@cytale/api-client';

import {
  PASSKEY_PROMPT_DISMISSED_KEY,
  consumePasswordLoginForPasskeyPrompt,
  markPasswordLoginForPasskeyPrompt,
} from '../passkeyPrompt.js';
import { PasskeyEnrollmentPrompt } from '../PasskeyEnrollmentPrompt.js';

const cred: WebauthnCredential = { id: 'c1', name: 'Passkey', created_at: 't', last_used_at: null };

const onListCredentials = vi.fn<() => Promise<WebauthnCredential[]>>();
const onEnroll = vi.fn<(name: string) => Promise<WebauthnCredential>>();

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  localStorage.clear();
  consumePasswordLoginForPasskeyPrompt(); // reset the module flag between tests
});

describe('PasskeyEnrollmentPrompt — gating', () => {
  it('password login + zero passkeys → the prompt shows', async () => {
    onListCredentials.mockResolvedValue([]);
    render(<PasskeyEnrollmentPrompt onListCredentials={onListCredentials} onEnroll={onEnroll} pendingPasswordLogin />);
    expect(await screen.findByTestId('passkey-prompt')).toBeTruthy();
    expect(screen.getByTestId('passkey-prompt').textContent).toMatch(/set up a passkey/i);
    expect(onListCredentials).toHaveBeenCalledTimes(1);
  });

  it('no pending password login (passkey/SSO path) → nothing, not even a list read', async () => {
    render(<PasskeyEnrollmentPrompt onListCredentials={onListCredentials} onEnroll={onEnroll} />);
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByTestId('passkey-prompt')).toBeNull();
    expect(onListCredentials).not.toHaveBeenCalled();
  });

  it('an account WITH a passkey never sees it', async () => {
    onListCredentials.mockResolvedValue([cred]);
    render(<PasskeyEnrollmentPrompt onListCredentials={onListCredentials} onEnroll={onEnroll} pendingPasswordLogin />);
    await waitFor(() => expect(onListCredentials).toHaveBeenCalled());
    expect(screen.queryByTestId('passkey-prompt')).toBeNull();
  });

  it('the module flag arms it — and is consumed at most ONCE per login', async () => {
    onListCredentials.mockResolvedValue([]);
    markPasswordLoginForPasskeyPrompt();

    const first = render(<PasskeyEnrollmentPrompt onListCredentials={onListCredentials} onEnroll={onEnroll} />);
    expect(await screen.findByTestId('passkey-prompt')).toBeTruthy();
    first.unmount();

    // The SAME login, re-rendered (a settings surface reopen): no flag left,
    // so no second ask.
    render(<PasskeyEnrollmentPrompt onListCredentials={onListCredentials} onEnroll={onEnroll} />);
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByTestId('passkey-prompt')).toBeNull();
    expect(onListCredentials).toHaveBeenCalledTimes(1);
  });

  it('a failed credential-list read stays silent (an invitation never blocks the shell)', async () => {
    onListCredentials.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<PasskeyEnrollmentPrompt onListCredentials={onListCredentials} onEnroll={onEnroll} pendingPasswordLogin />);
    await waitFor(() => expect(onListCredentials).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByTestId('passkey-prompt')).toBeNull();
  });
});

describe('PasskeyEnrollmentPrompt — the two answers', () => {
  it('Set up runs the enrollment ceremony and resolves to a confirmation', async () => {
    onListCredentials.mockResolvedValue([]);
    onEnroll.mockResolvedValue(cred);
    render(<PasskeyEnrollmentPrompt onListCredentials={onListCredentials} onEnroll={onEnroll} pendingPasswordLogin />);

    fireEvent.click(await screen.findByTestId('passkey-prompt-setup'));
    await waitFor(() => expect(onEnroll).toHaveBeenCalledWith('Passkey'));
    expect(await screen.findByTestId('passkey-prompt-done')).toBeTruthy();
    expect(screen.queryByTestId('passkey-prompt-setup')).toBeNull();
  });

  it('a failed ceremony is VISIBLE, stays retryable, and is NOT recorded as a dismissal', async () => {
    onListCredentials.mockResolvedValue([]);
    onEnroll.mockRejectedValue(new Error('This browser or context does not support passkeys.'));
    render(<PasskeyEnrollmentPrompt onListCredentials={onListCredentials} onEnroll={onEnroll} pendingPasswordLogin />);

    fireEvent.click(await screen.findByTestId('passkey-prompt-setup'));
    expect(await screen.findByTestId('passkey-prompt-error')).toBeTruthy();
    expect(localStorage.getItem(PASSKEY_PROMPT_DISMISSED_KEY)).toBeNull();
    // The offer itself is still on screen to retry or decline.
    expect(screen.getByTestId('passkey-prompt-setup')).toBeTruthy();
    expect(screen.getByTestId('passkey-prompt-notnow')).toBeTruthy();
  });

  it('Not now persists the dismissal and a RE-LOGIN does not ask again', async () => {
    onListCredentials.mockResolvedValue([]);
    const first = render(
      <PasskeyEnrollmentPrompt onListCredentials={onListCredentials} onEnroll={onEnroll} pendingPasswordLogin />,
    );
    fireEvent.click(await screen.findByTestId('passkey-prompt-notnow'));

    expect(screen.queryByTestId('passkey-prompt')).toBeNull();
    expect(localStorage.getItem(PASSKEY_PROMPT_DISMISSED_KEY)).toBe('1');
    first.unmount();

    // A later password login re-arms the flag — the recorded dismissal wins.
    markPasswordLoginForPasskeyPrompt();
    render(<PasskeyEnrollmentPrompt onListCredentials={onListCredentials} onEnroll={onEnroll} />);
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByTestId('passkey-prompt')).toBeNull();
    expect(onListCredentials).toHaveBeenCalledTimes(1); // only the first mount read
    consumePasswordLoginForPasskeyPrompt();
  });
});
