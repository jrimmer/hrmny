/**
 * Boot cover dismissal — the contract the entry relies on.
 *
 * The cover itself lives in `index.html` (it has to: it must paint before any
 * module runs), so these cases drive the DOM the way the browser presents it:
 * the node exists, the node is absent, and the node is called for twice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BOOT_COVER_ID, dismissBootCover } from '../splash.js';

function mountCover(): HTMLElement {
  const el = document.createElement('div');
  el.id = BOOT_COVER_ID;
  el.setAttribute('data-state', 'booting');
  el.setAttribute('aria-busy', 'true');
  document.body.appendChild(el);
  return el;
}

describe('dismissBootCover', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.getElementById(BOOT_COVER_ID)?.remove();
    vi.unstubAllGlobals();
  });

  it('marks the cover ready, then removes it after the fade', () => {
    const el = mountCover();

    dismissBootCover();

    // Still in the DOM — it is fading, not gone, so the transition has a node
    // to run on.
    expect(el.getAttribute('data-state')).toBe('ready');
    expect(el.getAttribute('aria-busy')).toBe('false');
    expect(document.getElementById(BOOT_COVER_ID)).toBe(el);

    vi.advanceTimersByTime(200);
    expect(document.getElementById(BOOT_COVER_ID)).toBeNull();
  });

  it('is idempotent: a second call does not schedule a second removal', () => {
    const el = mountCover();
    const remove = vi.spyOn(el, 'remove');

    dismissBootCover();
    dismissBootCover();

    vi.advanceTimersByTime(1000);
    // One removal, not two: the `ready` marker short-circuits the second call.
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('does nothing when there is no cover (tests, entry served without index.html)', () => {
    expect(() => dismissBootCover()).not.toThrow();
    vi.advanceTimersByTime(1000);
    expect(document.getElementById(BOOT_COVER_ID)).toBeNull();
  });

  it('removes immediately under prefers-reduced-motion', () => {
    mountCover();
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));

    dismissBootCover();

    expect(document.getElementById(BOOT_COVER_ID)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The CSP contract (live incident 2026-09-19): the endpoint serves
// script-src 'self' — NO inline scripts. Two inline blocks in index.html
// were silently blocked by the browser (pre-paint theme, boot-cover
// fail-safe), and the fail-safe's death left a broken bundle's cover up
// forever. Every <script> in index.html must carry a src; this pin keeps
// any future inline block from shipping.
// ---------------------------------------------------------------------------
describe('index.html — the CSP contract', () => {
  const html = readFileSync(join(__dirname, '..', '..', '..', '..', 'index.html'), 'utf8');

  it('every <script> is a file (script-src self has no unsafe-inline)', () => {
    const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1] ?? '');
    expect(scripts.length).toBeGreaterThan(0);
    for (const attrs of scripts) {
      expect(attrs, `an inline <script${attrs}> would be CSP-blocked`).toMatch(/\ssrc=/);
    }
  });

  it('the boot cover carries the owner\'s black app icon — never the placeholder arcs', () => {
    expect(html).toContain('/icons/hrmny-favicon.png');
    expect(html).toContain('/icons/hrmny-app-icon.png');
    expect(html).not.toContain('M62 22a30 30');
    // The desktop flip rides the shell flag boot-theme.js sets.
    const theme = readFileSync(join(__dirname, '..', '..', '..', '..', 'public', 'boot-theme.js'), 'utf8');
    expect(theme).toContain("data-shell', 'desktop'");
    expect(theme).toContain('__TAURI_INTERNALS__');
  });
});
