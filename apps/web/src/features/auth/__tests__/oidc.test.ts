/**
 * oidc.ts — the browser choreography unit (#12): the provider-redirect PATH →
 * hash normalization (so the SPA fallback landing becomes a routable hash and
 * a reload cannot replay the single-use code) and the signed-out-route →
 * return_to candidate rule. The api client is injected; the location is the
 * real jsdom one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  OIDC_CALLBACK_PATH,
  OIDC_STATE_KEY,
  consumeOidcState,
  currentReturnTo,
  normalizeOidcProviderRedirect,
} from '../oidc.js';

afterEach(() => {
  window.location.hash = '';
  // Back to the plain app root for the next test.
  window.history.replaceState(null, '', '/');
  vi.restoreAllMocks();
});

describe('currentReturnTo — the signed-out route as a return_to candidate', () => {
  it('carries app routes (the #114 pending route rides along)', () => {
    window.location.hash = '#/workspace/9/message/3';
    expect(currentReturnTo()).toBe('/workspace/9/message/3');
  });

  it('refuses non-routes and the auth pages themselves', () => {
    window.location.hash = '';
    expect(currentReturnTo()).toBeNull();

    window.location.hash = '#/login';
    expect(currentReturnTo()).toBeNull();

    window.location.hash = '#/register';
    expect(currentReturnTo()).toBeNull();

    window.location.hash = '#/reset-password?token=x';
    expect(currentReturnTo()).toBeNull();
  });

  it('never proposes the callback route itself', () => {
    window.location.hash = '#/auth/oidc/callback?code=c&state=s';
    expect(currentReturnTo()).toBeNull();
  });
});

describe('normalizeOidcProviderRedirect — provider PATH landing → hash route', () => {
  it('rewrites /auth/oidc/callback?… into the hash router shape and clears the path', () => {
    window.history.replaceState(null, '', `${OIDC_CALLBACK_PATH}?code=c1&state=s1`);
    expect(window.location.pathname).toBe(OIDC_CALLBACK_PATH);

    normalizeOidcProviderRedirect();

    expect(window.location.pathname).toBe('/');
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('#/auth/oidc/callback?code=c1&state=s1');
  });

  it('is a no-op on every other path', () => {
    window.history.replaceState(null, '', '/some/deep/link?x=1');
    window.location.hash = '#/keep/me';

    normalizeOidcProviderRedirect();

    expect(window.location.pathname).toBe('/some/deep/link');
    expect(window.location.hash).toBe('#/keep/me');
  });
});

describe('startOidcSignIn — the browser handoff', () => {
  it('mints the ceremony (with return_to) and assigns the browser to the authorize URL', async () => {
    // jsdom (unlike a real browser) allows replacing the unforgeable
    // window.location; we only need to observe the assign call.
    const assign = vi.fn();
    const setWindowLocation = (value: unknown): void => {
      (window as unknown as Record<string, unknown>).location = value;
    };
    const original = window.location;
    setWindowLocation({ ...original, assign });

    const { startOidcSignIn } = await import('../oidc.js');
    const api = {
      oidcStart: vi.fn().mockResolvedValue({ authorize_url: 'https://idp.example/authorize?a=1' }),
      oidcCallback: vi.fn(),
    };
    window.location.hash = '#/workspace/2';

    try {
      await startOidcSignIn(api, currentReturnTo());
      expect(api.oidcStart).toHaveBeenCalledWith({ return_to: '/workspace/2' });
      expect(assign).toHaveBeenCalledWith('https://idp.example/authorize?a=1');
    } finally {
      setWindowLocation(original);
    }
  });
});

describe('state binding (login CSRF, Tier 3 #1c)', () => {
  afterEach(() => sessionStorage.clear());

  it('startOidcSignIn remembers the authorize URL\'s state tab-locally', async () => {
    const assign = vi.fn();
    const setWindowLocation = (value: unknown): void => {
      (window as unknown as Record<string, unknown>).location = value;
    };
    const original = window.location;
    setWindowLocation({ ...original, assign });

    const { startOidcSignIn } = await import('../oidc.js');
    const api = {
      oidcStart: vi
        .fn()
        .mockResolvedValue({ authorize_url: 'https://idp.example/authorize?client_id=c&state=s-123&nonce=n' }),
      oidcCallback: vi.fn(),
    };

    try {
      await startOidcSignIn(api, null);
      expect(sessionStorage.getItem(OIDC_STATE_KEY)).toBe('s-123');
    } finally {
      setWindowLocation(original);
    }
  });

  it('consumeOidcState matches once, then never again', () => {
    sessionStorage.setItem(OIDC_STATE_KEY, 's-123');
    expect(consumeOidcState('s-123')).toBe(true);
    expect(consumeOidcState('s-123')).toBe(false);
  });

  it('consumeOidcState refuses a foreign state and a missing one', () => {
    sessionStorage.setItem(OIDC_STATE_KEY, 'mine');
    expect(consumeOidcState('theirs')).toBe(false);
    expect(consumeOidcState('')).toBe(false);
  });
});
