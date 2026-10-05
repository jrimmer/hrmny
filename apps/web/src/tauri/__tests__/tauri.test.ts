/**
 * @cytale/web — Tauri desktop-shell integration tests (U27, vitest + jsdom).
 *
 * Contract under test:
 *   1. isTauri() is false in a browser (jsdom has no __TAURI_INTERNALS__)
 *      and true when the Tauri 2 global is present.
 *   2. tauriPlatform() maps the shell's navigator.platform to the OS.
 *   3. parseDeepLink() parses cytale://workspace/{id}/channel/{id}/message/{id}
 *      into a structured target (search jump-to-message U24, thread deep
 *      links U22), and rejects malformed URLs.
 *   4. The desktop shell config (tauri.conf.json) is valid JSON with the
 *      pinned fields (devUrl → web dev server, frontendDist → web build,
 *      window ~1280x800, sane CSP) — read as text invariants, no build.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { isTauri, tauriPlatform, parseDeepLink } from '../index.js';

const WEB_ROOT = join(__dirname, '..', '..', '..');
const DESKTOP_ROOT = join(WEB_ROOT, '..', 'desktop');

// ---------------------------------------------------------------------------
// 1. Runtime detection
// ---------------------------------------------------------------------------

describe('isTauri', () => {
  const originalWindow = globalThis.window;

  afterEach(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    });
  });

  it('is false in a plain browser (jsdom has no Tauri global)', () => {
    expect(isTauri()).toBe(false);
  });

  it('is true when window.__TAURI_INTERNALS__ is present (Tauri 2 shell)', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { __TAURI_INTERNALS__: {} },
    });
    expect(isTauri()).toBe(true);
  });

  it('is false when window is undefined (SSR)', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: undefined,
    });
    expect(isTauri()).toBe(false);
  });
});

describe('tauriPlatform', () => {
  const originalNavigator = globalThis.navigator;
  const originalWindow = globalThis.window;

  afterEach(() => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator,
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    });
  });

  function stubTauri(platform: string): void {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { __TAURI_INTERNALS__: {} },
    });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { platform },
    });
  }

  it('returns null outside the shell', () => {
    expect(tauriPlatform()).toBeNull();
  });

  it('maps Windows', () => {
    stubTauri('Win32');
    expect(tauriPlatform()).toBe('windows');
  });

  it('maps macOS', () => {
    stubTauri('MacIntel');
    expect(tauriPlatform()).toBe('macos');
  });

  it('maps Linux', () => {
    stubTauri('Linux x86_64');
    expect(tauriPlatform()).toBe('linux');
  });
});

// ---------------------------------------------------------------------------
// 2. Deep-link parsing
// ---------------------------------------------------------------------------

describe('parseDeepLink', () => {
  it('parses a full message deep link', () => {
    expect(
      parseDeepLink('cytale://workspace/1001/channel/2002/message/3003'),
    ).toEqual({
      kind: 'message',
      workspaceId: '1001',
      channelId: '2002',
      messageId: '3003',
    });
  });

  // A thread reply's notification has to land INSIDE the thread, and before
  // this segment existed there was no link shape that could express it.
  it('parses a thread deep link', () => {
    expect(parseDeepLink('cytale://workspace/1001/channel/2002/thread/4004')).toEqual({
      kind: 'thread',
      workspaceId: '1001',
      channelId: '2002',
      threadId: '4004',
    });
  });

  it('parses a thread message deep link (the notification-click shape)', () => {
    expect(
      parseDeepLink('cytale://workspace/1001/channel/2002/thread/4004/message/3003'),
    ).toEqual({
      kind: 'message',
      workspaceId: '1001',
      channelId: '2002',
      threadId: '4004',
      messageId: '3003',
    });
  });

  it('a thread id without its channel does not parse', () => {
    expect(parseDeepLink('cytale://workspace/1001/thread/4004')).toBeNull();
  });

  // Ids are base62 as of #118, so `abc` is a legitimate id (it is 64) rather
  // than a rejection. A segment outside the alphabet is still refused.
  it('a base62 thread id decodes to its decimal snowflake', () => {
    expect(parseDeepLink('cytale://workspace/1001/channel/2002/thread/abc')).toEqual({
      kind: 'thread',
      workspaceId: '1001',
      channelId: '2002',
      threadId: '64',
    });
  });

  it('a thread id outside the id alphabet does not parse', () => {
    expect(parseDeepLink('cytale://workspace/1001/channel/2002/thread/!!')).toBeNull();
  });

  it('parses a channel deep link', () => {
    expect(parseDeepLink('cytale://workspace/1001/channel/2002')).toEqual({
      kind: 'channel',
      workspaceId: '1001',
      channelId: '2002',
    });
  });

  it('parses a workspace deep link', () => {
    expect(parseDeepLink('cytale://workspace/1001')).toEqual({
      kind: 'workspace',
      workspaceId: '1001',
    });
  });

  it('rejects non-cytale schemes', () => {
    expect(parseDeepLink('https://example.com/workspace/1001')).toBeNull();
  });

  it('rejects malformed paths', () => {
    expect(parseDeepLink('cytale://workspace')).toBeNull();
    expect(parseDeepLink('cytale://')).toBeNull();
    expect(parseDeepLink('')).toBeNull();
  });

  it('rejects non-string input', () => {
    expect(parseDeepLink(null as unknown as string)).toBeNull();
    expect(parseDeepLink(undefined as unknown as string)).toBeNull();
  });

  // The parse is the boundary between whatever the OS hands the shell and
  // route state, so these are the cases that must not slip through.
  describe('hardened input (OS-supplied, untrusted)', () => {
    it('accepts a percent-encoded id and normalizes it', () => {
      expect(parseDeepLink('cytale://workspace/10%30%31')).toEqual({
        kind: 'workspace',
        workspaceId: '1001',
      });
    });

    it('rejects an encoded separator instead of decoding it into the path', () => {
      expect(parseDeepLink('cytale://workspace/1001%2Fchannel%2F2002')).toBeNull();
    });

    it('rejects malformed percent sequences without throwing', () => {
      expect(parseDeepLink('cytale://workspace/100%')).toBeNull();
      expect(parseDeepLink('cytale://workspace/1001/channel/%zz')).toBeNull();
    });

    // Ids are base62 as of #118 (decimal remains readable for links copied
    // before it), so the rule is "inside the alphabet, within u64" rather
    // than "all digits".
    it('rejects ids outside the id alphabet', () => {
      expect(parseDeepLink('cytale://workspace/1001/channel/20 02')).toBeNull();
      expect(parseDeepLink('cytale://workspace/-1')).toBeNull();
      expect(parseDeepLink('cytale://workspace/!!')).toBeNull();
      // 21 digits: past u64, so not an id this app can address.
      expect(parseDeepLink(`cytale://workspace/${'9'.repeat(21)}`)).toBeNull();
    });

    it('reads the base62 spelling and the legacy decimal one alike', () => {
      // `abc` is base62 for 64; `64` is itself.
      expect(parseDeepLink('cytale://workspace/abc')).toEqual({
        kind: 'workspace',
        workspaceId: '64',
      });
      expect(parseDeepLink('cytale://workspace/64')).toEqual({
        kind: 'workspace',
        workspaceId: '64',
      });
    });

    it('rejects an over-long URL before parsing it', () => {
      expect(parseDeepLink(`cytale://workspace/${'9'.repeat(3_000)}`)).toBeNull();
    });

    it('rejects query/fragment noise and trailing slashes', () => {
      expect(parseDeepLink('cytale://workspace/1001?x=1')).toBeNull();
      expect(parseDeepLink('cytale://workspace/1001/')).toBeNull();
      expect(parseDeepLink('cytale://workspace/1001/channel/2002/message/3003#top')).toBeNull();
    });

    it('does not accept a message id without its channel', () => {
      expect(parseDeepLink('cytale://workspace/1001/message/3003')).toBeNull();
    });

    it('accepts a case-insensitive scheme', () => {
      expect(parseDeepLink('CYTALE://workspace/1001')).toEqual({
        kind: 'workspace',
        workspaceId: '1001',
      });
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Desktop shell config contract (text invariants — no build)
// ---------------------------------------------------------------------------

describe('apps/desktop/src-tauri/tauri.conf.json', () => {
  const conf = JSON.parse(
    readFileSync(join(DESKTOP_ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'),
  ) as {
    productName: string;
    identifier: string;
    build: { devUrl: string; frontendDist: string };
    app: {
      windows: { title: string; width: number; height: number; minWidth?: number; minHeight?: number }[];
      security: { csp: string | null };
    };
  };

  it('is the Hrmny desktop shell', () => {
    expect(conf.productName).toBe('Hrmny');
    expect(conf.identifier).toBe('chat.hrmny.desktop');
  });

  it('devUrl points at the web dev server (U25 vite)', () => {
    expect(conf.build.devUrl).toMatch(/^http:\/\/localhost:\d+$/);
  });

  it('frontendDist points at the web build output', () => {
    expect(conf.build.frontendDist).toContain('web');
    expect(conf.build.frontendDist).toContain('dist');
  });

  it('window is ~1280x800 with a sensible minimum', () => {
    const win = conf.app.windows[0]!;
    expect(win.width).toBeGreaterThanOrEqual(1024);
    expect(win.height).toBeGreaterThanOrEqual(700);
    expect(win.minWidth).toBeGreaterThanOrEqual(320);
    expect(win.minHeight).toBeGreaterThanOrEqual(480);
  });

  it('declares a sane CSP (no unsafe-inline for scripts)', () => {
    const csp = conf.app.security.csp;
    expect(csp).toBeTruthy();
    // The security-critical directive is script-src: inline scripts must be
    // disallowed. style-src 'unsafe-inline' is required by Tailwind v4's
    // runtime style injection and is not a script-execution risk.
    const scriptSrc = csp?.split(';').find((d) => d.trim().startsWith('script-src'));
    expect(scriptSrc).toBeTruthy();
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });
});
