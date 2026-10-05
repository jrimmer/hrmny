/**
 * Link-target policy tests (security pass).
 *
 * `parseInlineMarkdown` will emit whatever target the author wrote; this is
 * the gate both renderers put in front of their opener (web's `<a href>`,
 * native's `Linking.openURL`). The tables below are the accept/reject contract
 * they share.
 */
import { describe, expect, it } from 'vitest';

import { isOpenableLinkHref } from '../links.js';

describe('isOpenableLinkHref', () => {
  it('accepts browser schemes', () => {
    expect(isOpenableLinkHref('https://example.com/docs')).toBe(true);
    expect(isOpenableLinkHref('http://example.com')).toBe(true);
    expect(isOpenableLinkHref('HTTPS://EXAMPLE.COM')).toBe(true);
  });

  it('rejects schemes that hand the target to another app', () => {
    expect(isOpenableLinkHref('javascript:alert(1)')).toBe(false);
    expect(isOpenableLinkHref('data:text/html,<h1>x</h1>')).toBe(false);
    expect(isOpenableLinkHref('vbscript:msgbox(1)')).toBe(false);
    expect(isOpenableLinkHref('file:///etc/passwd')).toBe(false);
    expect(isOpenableLinkHref('intent://scan/#Intent;scheme=zxing;end')).toBe(false);
    expect(isOpenableLinkHref('market://details?id=x')).toBe(false);
    expect(isOpenableLinkHref('tel:+15551234567')).toBe(false);
    expect(isOpenableLinkHref('sms:+15551234567')).toBe(false);
    expect(isOpenableLinkHref('mailto:someone@example.com')).toBe(false);
  });

  it('rejects targets that are not a scheme-prefixed URL at all', () => {
    expect(isOpenableLinkHref('example.com/docs')).toBe(false);
    expect(isOpenableLinkHref('/relative/path')).toBe(false);
    expect(isOpenableLinkHref('')).toBe(false);
    expect(isOpenableLinkHref('#fragment')).toBe(false);
    // Not normalised into a scheme: the grammar forbids whitespace in a
    // target, so anything that only looks like one after trimming is refused.
    expect(isOpenableLinkHref(' https://example.com')).toBe(false);
    expect(isOpenableLinkHref('java\nscript:alert(1)')).toBe(false);
    expect(isOpenableLinkHref('java\u0000script:alert(1)')).toBe(false);
  });
});
