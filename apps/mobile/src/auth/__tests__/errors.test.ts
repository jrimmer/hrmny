/**
 * Auth failure copy (plan 004 M12, R4). Web's `LoginPage`/`RegisterPage`
 * branches, pinned here so the screens stay JSX-only.
 */
import { ApiError } from '@cytale/api-client';

import { describeAuthFailure, OFFLINE_MESSAGE } from '../errors';

function apiError(key: string, status = 400): ApiError {
  return new ApiError({ key, code: status * 100, message: key, status });
}

describe('sign-in failures', () => {
  it('maps the credential rejection to web\u2019s copy, in BOTH spellings', () => {
    const expected = {
      kind: 'invalid-credentials',
      message: 'Wrong username/email or password.',
    };

    // 6.4 rename window: the server emits `invalid_credentials` now and a
    // pre-rename server emitted the shouty form, so both must land. This is
    // the case the first cut of the rename missed on mobile (review P1 #1).
    expect(describeAuthFailure(apiError('invalid_credentials', 401), 'sign-in')).toEqual(expected);
    expect(describeAuthFailure(apiError('INVALID_CREDENTIALS', 401), 'sign-in')).toEqual(expected);
  });

  it('falls back to the generic server copy for any other envelope', () => {
    expect(describeAuthFailure(apiError('rate_limited', 429), 'sign-in')).toEqual({
      kind: 'server',
      message: 'Could not sign in. Please try again.',
    });
  });

  it('treats a rejected transport as offline, not as bad credentials', () => {
    expect(describeAuthFailure(new TypeError('Network request failed'), 'sign-in')).toEqual({
      kind: 'offline',
      message: OFFLINE_MESSAGE,
    });
  });

  it('treats the api-client\u2019s wrapped transport failure as offline too (#88 shape)', () => {
    // http.ts funnels a rejected fetch into ApiError{key:'network_error',
    // status:0} — an offline state, never a credential error.
    expect(describeAuthFailure(apiError('network_error', 0), 'sign-in')).toEqual({
      kind: 'offline',
      message: OFFLINE_MESSAGE,
    });
  });
});

describe('sign-up failures', () => {
  it('maps the single anti-enumeration `taken` code to its inline copy (S5)', () => {
    expect(describeAuthFailure(apiError('taken', 409), 'sign-up')).toEqual({
      kind: 'taken',
      message: 'That username or email is already registered.',
    });
  });

  it('falls back to the generic server copy', () => {
    expect(describeAuthFailure(apiError('validation_failed'), 'sign-up')).toEqual({
      kind: 'server',
      message: 'Could not create the account. Please try again.',
    });
  });

  it('treats a rejected transport as offline', () => {
    expect(describeAuthFailure(new Error('socket closed'), 'sign-up').kind).toBe('offline');
  });
});
