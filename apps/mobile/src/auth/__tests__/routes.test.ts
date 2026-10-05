/**
 * Auth route helpers (plan 004 M12). The gate's two pure decisions: which
 * pathnames are auth screens (never captured as a deep-link intent) and how a
 * captured deep link is rebuilt for replay.
 */
import { AUTH_ROUTES, isAuthRoute, isVerificationRoute, pendingHref } from '../routes';

describe('isAuthRoute', () => {
  it.each([AUTH_ROUTES.signIn, AUTH_ROUTES.signUp, AUTH_ROUTES.verifyEmail])(
    'recognizes %s',
    (path) => {
      expect(isAuthRoute(path)).toBe(true);
    },
  );

  it('ignores a query string', () => {
    expect(isAuthRoute(`${AUTH_ROUTES.verifyEmail}?token=abc`)).toBe(true);
  });

  it.each(['/', '/channel/1', '/settings', '/thread/1', '/sign-in-extra'])(
    'leaves %s alone',
    (path) => {
      expect(isAuthRoute(path)).toBe(false);
    },
  );

  it('separates the verification screen from the other auth screens', () => {
    expect(isVerificationRoute(AUTH_ROUTES.verifyEmail)).toBe(true);
    expect(isVerificationRoute(AUTH_ROUTES.signIn)).toBe(false);
  });
});

describe('pendingHref', () => {
  it('keeps a path deep link as-is (its id is a path segment, not a query)', () => {
    expect(pendingHref('/channel/700000000000000001', { id: '700000000000000001' })).toBe(
      '/channel/700000000000000001',
    );
  });

  it('carries query parameters that are not path segments', () => {
    expect(pendingHref('/channel/7', { id: '7', thread: '9' })).toBe('/channel/7?thread=9');
  });

  it('repeats array-valued parameters', () => {
    expect(pendingHref('/search', { q: ['one', 'two'] })).toBe('/search?q=one&q=two');
  });

  it('drops empty values and leaves a bare pathname alone', () => {
    expect(pendingHref('/settings', { section: '' })).toBe('/settings');
  });
});
