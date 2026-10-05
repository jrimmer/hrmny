/**
 * Navigation contract (plan 004 M5, R7) — route builders and deep-link
 * normalization. Pure module: no renderer needed.
 */
import {
  channelHref,
  normalizeDeepLink,
  parseRoute,
  settingsHref,
  threadHref,
} from '../routes';

describe('route builders', () => {
  it('builds channel hrefs', () => {
    expect(channelHref('1756920000000000001')).toBe('/channel/1756920000000000001');
  });

  it('builds thread hrefs', () => {
    expect(threadHref('1756920000000000002')).toBe('/thread/1756920000000000002');
  });

  it('builds settings hrefs', () => {
    expect(settingsHref()).toBe('/settings');
    expect(settingsHref('account')).toBe('/settings/account');
  });
});

describe('normalizeDeepLink', () => {
  it('maps cytale://channel/<id> to the channel route', () => {
    expect(normalizeDeepLink('cytale://channel/1756920000000000001')).toBe(
      '/channel/1756920000000000001',
    );
  });

  it('maps cytale:///channel/<id> (empty host) to the channel route', () => {
    expect(normalizeDeepLink('cytale:///channel/1756920000000000001')).toBe(
      '/channel/1756920000000000001',
    );
  });

  it('maps other surfaces', () => {
    expect(normalizeDeepLink('cytale://thread/9')).toBe('/thread/9');
    expect(normalizeDeepLink('cytale://settings/account')).toBe('/settings/account');
    expect(normalizeDeepLink('cytale://integrations')).toBe('/integrations');
  });

  it('preserves query strings', () => {
    expect(normalizeDeepLink('cytale://channel/7?message=9')).toBe('/channel/7?message=9');
  });

  it('passes through in-app paths unchanged', () => {
    expect(normalizeDeepLink('/channel/7')).toBe('/channel/7');
  });

  it('promotes a bare path to an absolute one', () => {
    expect(normalizeDeepLink('channel/7')).toBe('/channel/7');
  });

  it('trims a trailing slash', () => {
    expect(normalizeDeepLink('cytale://channel/7/')).toBe('/channel/7');
  });
});

describe('parseRoute', () => {
  it('identifies the channel surface and its id', () => {
    expect(parseRoute('/channel/123')).toEqual({ surface: 'channel', channelId: '123' });
  });

  it('identifies home, integrations, thread, and settings surfaces', () => {
    expect(parseRoute('/')).toEqual({ surface: 'home' });
    expect(parseRoute('/integrations')).toEqual({ surface: 'integrations' });
    expect(parseRoute('/thread/55')).toEqual({ surface: 'thread', threadId: '55' });
    expect(parseRoute('/settings')).toEqual({ surface: 'settings' });
    expect(parseRoute('/settings/account')).toEqual({ surface: 'settings', section: 'account' });
  });

  it('falls back to unknown for unmatched paths', () => {
    expect(parseRoute('/nope')).toEqual({ surface: 'unknown' });
  });
});
