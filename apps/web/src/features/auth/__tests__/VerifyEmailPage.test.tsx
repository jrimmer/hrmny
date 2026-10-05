/**
 * U19 — VerifyEmailPage tests: token from the URL flips the account to
 * verified; resend issues a fresh token (old one invalidated server-side).
 * Render is asserted through roles + testids, no routing needed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

import { VerifyEmailPage } from '../VerifyEmailPage.js';
import { authStore } from '../session.js';
import { ComposerBanner } from '../ComposerBanner.js';

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json' }, json: async () => body } as unknown as Response;
}

let verifyCalls = 0;
let resendCalls = 0;

beforeEach(() => {
  verifyCalls = 0;
  resendCalls = 0;
  authStore.getState().reset();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith('/auth/verify-email')) {
      verifyCalls++;
      const body = JSON.parse(String(init.body ?? '{}')) as { token?: string };
      if (body.token === 'good-token') return jsonResponse(200, {});
      return jsonResponse(410, { error: { key: 'TOKEN_CONSUMED', code: 41001, message: 'used' } });
    }
    if (url.endsWith('/auth/resend-verification')) {
      resendCalls++;
      return jsonResponse(200, {});
    }
    return jsonResponse(404, {});
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('VerifyEmailPage', () => {
  it('token from the URL verifies the account (done state renders)', async () => {
    render(React.createElement(VerifyEmailPage, { token: 'good-token' }));

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toMatch(/Email verified/);
    });

    expect(verifyCalls).toBe(1);
  });

  it('a consumed token is stripped from the address bar (WEB-5)', async () => {
    window.location.hash = '/verify-email?token=good-token';
    render(React.createElement(VerifyEmailPage, { token: 'good-token' }));

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toMatch(/Email verified/);
    });

    // The single-use token is gone from the URL; the app stayed on the same
    // view (replaceState, no navigation, no hashchange).
    expect(window.location.hash).toBe('#/verify-email');
    expect(window.location.search).not.toContain('token');
    expect(screen.getByRole('status').textContent).toMatch(/Email verified/);
  });

  it('bad token shows an error and offers resend', async () => {
    render(React.createElement(VerifyEmailPage, { token: 'bad-token' }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/invalid or was already used/);
    });

    // The view-only banner is visible pre-verification.
    expect(screen.getByTestId('view-only-banner')).toBeTruthy();

    // Resend reads the email from the store user (real usage: a logged-in
    // unverified account has a user in the store).
    authStore.getState().setUser({
      id: '1',
      username: 'tester',
      email: 'tester@example.com',
      email_verified_at: null,
    });

    await userEvent.click(screen.getByRole('button', { name: /resend/i }));
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toMatch(/Fresh verification email sent/);
    });
    expect(resendCalls).toBe(1);
  });

  it('missing token renders the error immediately without a network call', () => {
    render(React.createElement(VerifyEmailPage, { token: null }));
    expect(screen.getByRole('alert').textContent).toMatch(/No verification token/);
    expect(verifyCalls).toBe(0);
  });
});

describe('ComposerBanner (view-only affordance)', () => {
  it('renders the banner with a resend prompt when unverified', () => {
    authStore.getState().setStatus('authenticated');
    authStore.getState().setVerified(false);

    render(React.createElement(ComposerBanner));

    expect(screen.getByTestId('composer-banner')).toBeTruthy();
    expect(screen.getByTestId('composer-resend')).toBeTruthy();
  });

  it('hidden when the account is verified', () => {
    authStore.getState().setStatus('authenticated');
    authStore.getState().setVerified(true);

    render(React.createElement(ComposerBanner));

    expect(screen.queryByTestId('composer-banner')).toBeNull();
  });

  it('resend click issues a fresh verification email', async () => {
    authStore.getState().setStatus('authenticated');
    authStore.getState().setVerified(false);
    // The resend path reads the email from the store user.
    authStore.getState().setUser({
      id: '1',
      username: 'tester',
      email: 'tester@example.com',
      email_verified_at: null,
    });

    render(React.createElement(ComposerBanner));

    await userEvent.click(screen.getByTestId('composer-resend'));

    await waitFor(() => {
      expect(resendCalls).toBe(1);
    });
  });
});
