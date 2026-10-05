/**
 * The desktop shell loads the SPA from `tauri://localhost`, so the API,
 * gateway and server-relative asset paths cannot resolve against
 * `location.origin` there. `VITE_CYTALE_ORIGIN` (baked at build time) wins;
 * with nothing baked in, a PACKAGED shell falls back to the hosted
 * deployment while `tauri dev` keeps talking to the local server. This pins
 * that contract.
 */
import { describe, expect, it } from 'vitest';

import { HOSTED_ORIGIN, apiUrl, assetUrl, attachmentTarget, configuredOrigin, isPackagedShell, mediaProxyUrl, normalizeOrigin, permalinkOrigin, retryUrl } from '../origin.js';

// A deployment's hosted origin, as its release build would bake it in
// (VITE_CYTALE_HOSTED_ORIGIN). The plain build this suite runs bakes none.
const HOSTED = 'https://hosted.example.com';

const DEV = { protocol: 'http:', hostname: 'localhost' };
const MAC_PACKAGED = { protocol: 'tauri:', hostname: 'localhost' };
const WIN_PACKAGED = { protocol: 'http:', hostname: 'tauri.localhost' };
const BROWSER = { protocol: 'https:', hostname: 'chat.example.com' };

describe('normalizeOrigin', () => {
  it('is undefined for unset or empty values (web/PWA build)', () => {
    expect(normalizeOrigin(undefined)).toBeUndefined();
    expect(normalizeOrigin('')).toBeUndefined();
    expect(normalizeOrigin(null)).toBeUndefined();
    expect(normalizeOrigin(42)).toBeUndefined();
  });

  it('returns the origin with trailing slashes stripped', () => {
    expect(normalizeOrigin('https://chat.example.com')).toBe('https://chat.example.com');
    expect(normalizeOrigin('https://chat.example.com//')).toBe('https://chat.example.com');
    expect(normalizeOrigin('http://localhost:4000/')).toBe('http://localhost:4000');
  });
});

describe('isPackagedShell', () => {
  it('is true for the packaged Tauri origins on both platforms', () => {
    expect(isPackagedShell(MAC_PACKAGED)).toBe(true);
    expect(isPackagedShell(WIN_PACKAGED)).toBe(true);
  });

  it('is false for the browser and for tauri dev', () => {
    expect(isPackagedShell(BROWSER)).toBe(false);
    expect(isPackagedShell(DEV)).toBe(false);
    expect(isPackagedShell(undefined)).toBe(false);
  });
});

describe('configuredOrigin', () => {
  it('is undefined when nothing is baked in and we are not a packaged shell', () => {
    expect(configuredOrigin(undefined, DEV)).toBeUndefined();
    expect(configuredOrigin(undefined, BROWSER)).toBeUndefined();
    expect(configuredOrigin()).toBeUndefined();
  });

  it('has no hosted fallback in a build that names none (VITE_CYTALE_HOSTED_ORIGIN unset)', () => {
    expect(HOSTED_ORIGIN).toBeUndefined();
    expect(configuredOrigin(undefined, MAC_PACKAGED)).toBeUndefined();
    expect(configuredOrigin(undefined, MAC_PACKAGED, undefined)).toBeUndefined();
  });

  it('falls back to the hosted deployment in a packaged shell (tauri dev excluded)', () => {
    expect(configuredOrigin(undefined, MAC_PACKAGED, HOSTED)).toBe(HOSTED);
    expect(configuredOrigin(undefined, WIN_PACKAGED, HOSTED)).toBe(HOSTED);
  });

  it('a baked origin always wins (self-hosted or local packaged builds)', () => {
    expect(configuredOrigin('https://self.example', MAC_PACKAGED)).toBe('https://self.example');
    expect(configuredOrigin('http://127.0.0.1:4000/', MAC_PACKAGED)).toBe('http://127.0.0.1:4000');
    expect(configuredOrigin('https://self.example', BROWSER)).toBe('https://self.example');
  });
});

describe('assetUrl', () => {
  it('is undefined for empty/absent paths so callers keep the no-image branch', () => {
    expect(assetUrl(undefined, HOSTED)).toBeUndefined();
    expect(assetUrl(null, HOSTED)).toBeUndefined();
    expect(assetUrl('', HOSTED)).toBeUndefined();
  });

  it('leaves relative paths alone in the browser build (no configured origin)', () => {
    expect(assetUrl('/api/v1/attachments/abc')).toBe('/api/v1/attachments/abc');
    expect(assetUrl('/api/v1/attachments/abc', undefined)).toBe('/api/v1/attachments/abc');
  });

  it('resolves server-relative paths against the configured origin (desktop build)', () => {
    // Expected value DERIVED from HOSTED, not a second copy of the domain:
    // the assertion is about the resolution, not about any one deployment.
    expect(assetUrl('/api/v1/attachments/abc', HOSTED)).toBe(
      `${HOSTED}/api/v1/attachments/abc`,
    );
  });

  it('passes absolute and inline URLs through untouched', () => {
    expect(assetUrl('https://example.com/a.png', HOSTED)).toBe('https://example.com/a.png');
    expect(assetUrl('data:image/png;base64,AAAA', HOSTED)).toBe('data:image/png;base64,AAAA');
    expect(assetUrl('blob:http://localhost/abc', HOSTED)).toBe('blob:http://localhost/abc');
  });
});

describe('apiUrl', () => {
  it('leaves the path alone in the browser build (same-origin fetch)', () => {
    expect(apiUrl('/api/v1/workspaces/w/people', undefined)).toBe('/api/v1/workspaces/w/people');
    expect(apiUrl('/api/v1/invites/abc')).toBe('/api/v1/invites/abc');
  });

  it('prefixes the configured origin for the packaged shell', () => {
    // Derived, for the same reason as the assetUrl case above.
    expect(apiUrl('/api/v1/workspaces/w/people', HOSTED)).toBe(
      `${HOSTED}/api/v1/workspaces/w/people`,
    );
    expect(apiUrl('/api/v1/invites/abc', 'http://127.0.0.1:4102')).toBe(
      'http://127.0.0.1:4102/api/v1/invites/abc',
    );
  });
});

describe('retryUrl', () => {
  it('passes the URL through for attempt 0', () => {
    expect(retryUrl('/api/v1/attachments/abc', 0)).toBe('/api/v1/attachments/abc');
  });

  it('adds a cache-busting param so a content-addressed URL can be re-requested', () => {
    expect(retryUrl('/api/v1/attachments/abc', 1)).toBe('/api/v1/attachments/abc?retry=1');
    expect(retryUrl('/api/v1/attachments/abc?x=1', 2)).toBe('/api/v1/attachments/abc?x=1&retry=2');
  });
});

describe('permalinkOrigin (#114 — what a SHAREABLE link points at)', () => {
  it('uses the browser origin when the SPA is served same-origin with the API', () => {
    expect(permalinkOrigin(undefined, { origin: 'https://chat.example.com' })).toBe(
      'https://chat.example.com',
    );
  });

  it('uses the SERVER origin inside the packaged shell, never tauri://localhost', () => {
    // Otherwise a copied link would be an address only this machine's webview
    // can open. (A packaged shell ALWAYS resolves a configured origin —
    // `configuredOrigin` falls back to the hosted deployment — so the
    // webview's own scheme never reaches a permalink.)
    expect(permalinkOrigin(HOSTED, { origin: 'tauri://localhost' })).toBe(HOSTED);
    expect(configuredOrigin(undefined, MAC_PACKAGED, HOSTED)).toBe(HOSTED);
  });

  it('strips a trailing slash so the hash separator is never doubled', () => {
    expect(permalinkOrigin('https://chat.example.com/', { origin: 'x' })).toBe(
      'https://chat.example.com',
    );
  });

  it('reads as empty — not the string "null" — when the origin is opaque', () => {
    // `location.origin` is the literal string "null" for a file:// document.
    expect(permalinkOrigin(undefined, { origin: 'null' })).toBe('');
  });
});

// Tier 3 #5: an attachment's url is message content; only the server's own
// attachment path may render as a trusted file link / preview.
describe('attachmentTarget', () => {
  const ORIGIN = 'https://chat.example';
  const LOC = { origin: 'https://chat.example' };

  it('accepts the server attachment path, with or without a (signed) query', () => {
    expect(attachmentTarget('/api/v1/attachments/abc123', undefined, LOC)).toEqual({
      kind: 'attachment',
      href: '/api/v1/attachments/abc123',
    });
    expect(attachmentTarget('/api/v1/attachments/abc/cat.png?e=1700000000&s=deadbeef', undefined, LOC)).toEqual({
      kind: 'attachment',
      href: '/api/v1/attachments/abc/cat.png?e=1700000000&s=deadbeef',
    });
  });

  it("accepts the server's real signed shape (Cytale.Attachments.SignedUrl: 64-hex hash, e=expiry, s=base64url HMAC)", () => {
    const hash = 'a'.repeat(32) + '0123456789abcdef'.repeat(2);
    const signed = `/api/v1/attachments/${hash}?e=1790000000&s=Zm9vYmFy-_Q2x5dGFsZQ`;
    expect(attachmentTarget(signed, undefined, LOC)).toEqual({ kind: 'attachment', href: signed });
    expect(attachmentTarget(`https://chat.example${signed}`, undefined, LOC)?.kind).toBe('attachment');
    expect(attachmentTarget(signed, ORIGIN, undefined)).toEqual({ kind: 'attachment', href: `${ORIGIN}${signed}` });
  });

  it('resolves the path against the configured origin (packaged shell)', () => {
    expect(attachmentTarget('/api/v1/attachments/abc', ORIGIN, undefined)).toEqual({
      kind: 'attachment',
      href: 'https://chat.example/api/v1/attachments/abc',
    });
  });

  it('accepts an absolute URL only when it is our own origin AND the attachment path', () => {
    expect(attachmentTarget('https://chat.example/api/v1/attachments/abc?e=1&s=2', undefined, LOC)?.kind).toBe(
      'attachment',
    );
    expect(attachmentTarget('https://chat.example/api/v1/users/@me', undefined, LOC)?.kind).toBe('external');
    expect(attachmentTarget('https://evil.example/api/v1/attachments/abc', undefined, LOC)).toEqual({
      kind: 'external',
      href: 'https://evil.example/api/v1/attachments/abc',
    });
  });

  it('refuses scripts, other schemes, protocol-relative, traversal and other relative paths', () => {
    for (const url of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:x',
      '//evil.example/api/v1/attachments/abc',
      '/api/v1/attachments/../users/@me',
      '/api/v1/attachments/%2e%2e/users/@me',
      '/api/v1/attachments/abc#frag',
      '/api/v1/attachments/',
      '/api/v1/attachmentsX/abc',
      '/attachments/abc',
      '/login',
      'attachments/abc',
      '',
      null,
      42,
    ]) {
      expect(attachmentTarget(url, undefined, LOC), String(url)).toBeNull();
    }
  });
});

describe('mediaProxyUrl (the only way an external image is loaded)', () => {
  const minted = '/api/v1/media/proxy?u=aHR0cHM6Ly94L2EucG5n&e=1900000000&s=Ab-_9';

  it('passes a server-minted proxy path, absolutized in the desktop shell', () => {
    expect(mediaProxyUrl(minted, undefined)).toBe(minted);
    expect(mediaProxyUrl(minted, 'https://chat.example')).toBe(`https://chat.example${minted}`);
  });

  it('refuses every other shape', () => {
    for (const value of [
      'https://img.example/a.png',
      '//evil.example/api/v1/media/proxy?u=a',
      '/api/v1/media/proxy',
      '/api/v1/media/proxy?u=a#frag',
      '/api/v1/media/proxy?u=a&x=<script>',
      '/api/v1/attachments/abc',
      'javascript:alert(1)',
      '',
      null,
      42,
    ]) {
      expect(mediaProxyUrl(value, undefined), String(value)).toBeUndefined();
    }
  });
});
