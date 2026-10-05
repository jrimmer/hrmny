/**
 * Auth-error classification (diagnosability hardening, 2026-09-10).
 *
 * The incident: a client-side failure after a SUCCESSFUL server login showed
 * the generic "Could not sign in" with the real cause swallowed. These tests
 * pin the three behaviors that fix it — always log, classify network
 * failures into an actionable message, and surface a machine-identifiable
 * detail line.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@cytale/api-client';

import { describeAuthError, isNetworkError, isRateLimitError } from '../authErrors.js';

afterEach(() => vi.restoreAllMocks());

describe('isNetworkError', () => {
  it('treats fetch rejections (TypeError) as network failures', () => {
    expect(isNetworkError(new TypeError('Failed to fetch'))).toBe(true);
  });

  it('treats status 0 / network_error keys as network failures', () => {
    expect(isNetworkError(new ApiError({ key: 'network_error', code: 0, message: 'x' }))).toBe(true);
    expect(isNetworkError({ key: 'other', status: 0 })).toBe(true);
  });

  it('does not classify real API errors as network failures', () => {
    expect(
      isNetworkError(new ApiError({ key: 'INVALID_CREDENTIALS', code: 40101, message: 'x', status: 401 })),
    ).toBe(false);
    expect(isNetworkError(new Error('boom'))).toBe(false);
  });
});

describe('isRateLimitError (#90)', () => {
  it('recognizes HTTP 429 whatever the error key', () => {
    expect(isRateLimitError({ status: 429 })).toBe(true);
    expect(
      isRateLimitError(new ApiError({ key: 'unknown_error', code: 42900, message: 'x', status: 429 })),
    ).toBe(true);
  });

  it('recognizes the server rate_limited key in either spelling', () => {
    expect(isRateLimitError(new ApiError({ key: 'rate_limited', code: 42901, message: 'x', status: 429 }))).toBe(
      true,
    );
    expect(isRateLimitError({ key: 'RATE_LIMITED' })).toBe(true);
  });

  it('does not claim credential or network failures', () => {
    expect(
      isRateLimitError(new ApiError({ key: 'INVALID_CREDENTIALS', code: 40101, message: 'x', status: 401 })),
    ).toBe(false);
    expect(isRateLimitError(new TypeError('Failed to fetch'))).toBe(false);
  });
});

describe('describeAuthError', () => {
  it('always logs the real error with the page context', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    describeAuthError(new Error('underlying cause'), { fallback: 'generic', context: 'login' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]![0])).toContain('[auth] login failed');
    expect(spy.mock.calls[0]![1]).toBeInstanceOf(Error);
  });

  it('network failures get the actionable connection message, no detail', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const info = describeAuthError(new TypeError('Failed to fetch'), {
      fallback: 'Could not sign in. Please try again.',
      context: 'login',
    });
    expect(info.message).toMatch(/reach the server/i);
    expect(info.detail).toBeNull();
  });

  it('a 429 shows the server retry hint instead of the page fallback (#90)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const info = describeAuthError(
      new ApiError({
        key: 'rate_limited',
        code: 42901,
        message:
          'Too many requests from this network — the per-IP limit is 30 per 10s and is shared by everyone behind this IP. Try again in 12 seconds.',
        status: 429,
      }),
      { fallback: 'Could not sign in. Please try again.', context: 'login' },
    );
    expect(info.message).toMatch(/try again in 12 seconds/i);
    expect(info.message).not.toBe('Could not sign in. Please try again.');
    expect(info.detail).toBe('rate_limited · 42901 · HTTP 429');
  });

  it('legacy RATE_LIMITED fixtures are classified too', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const info = describeAuthError(
      new ApiError({ key: 'RATE_LIMITED', code: 42901, message: 'slow down', status: 429 }),
      { fallback: 'Could not sign in. Please try again.', context: 'login' },
    );
    expect(info.message).toBe('slow down');
    expect(info.detail).toBe('RATE_LIMITED · 42901 · HTTP 429');
  });

  it('a 429 with no server message keeps a slow-down fallback, never the credential copy', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const info = describeAuthError(
      new ApiError({ key: 'rate_limited', code: 42901, message: '', status: 429 }),
      { fallback: 'Could not sign in. Please try again.', context: 'login' },
    );
    expect(info.message).toMatch(/too many attempts/i);
    expect(info.message).not.toBe('Could not sign in. Please try again.');
    expect(info.detail).toBe('rate_limited · 42901 · HTTP 429');
  });

  it('other API errors keep the page fallback and carry key · code · status', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const info = describeAuthError(
      new ApiError({ key: 'INVALID_CREDENTIALS', code: 40101, message: 'nope', status: 401 }),
      { fallback: 'Could not sign in. Please try again.', context: 'login' },
    );
    expect(info.message).toBe('Could not sign in. Please try again.');
    expect(info.detail).toBe('INVALID_CREDENTIALS · 40101 · HTTP 401');
  });

  it('unknown errors degrade to the fallback with no detail', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const info = describeAuthError('something odd', { fallback: 'generic', context: 'login' });
    expect(info).toEqual({ message: 'generic', detail: null });
  });
});
