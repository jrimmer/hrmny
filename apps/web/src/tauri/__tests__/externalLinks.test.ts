/**
 * The desktop-shell link interceptor: every http(s) anchor click is
 * prevented and handed to the opener plugin; in-app hash routes and
 * non-http schemes stay native; a browser runtime wires nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { wireExternalLinksToDefaultBrowser } from '../externalLinks.js';

type Internals = { invoke: ReturnType<typeof vi.fn> };

function asDoc(d: Document): Document & { __hrmnyExternalLinksWired?: boolean } {
  return d as Document & { __hrmnyExternalLinksWired?: boolean };
}

function clickAnchor(href: string, attrs: Record<string, string> = {}): { prevented: boolean } {
  const a = document.createElement('a');
  a.href = href;
  a.textContent = 'link';
  for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v);
  document.body.appendChild(a);
  const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  a.dispatchEvent(ev);
  const prevented = ev.defaultPrevented;
  a.remove();
  return { prevented };
}

describe('wireExternalLinksToDefaultBrowser', () => {
  let internals: Internals;
  let hadInternals: boolean;

  beforeEach(() => {
    delete asDoc(document).__hrmnyExternalLinksWired;
    internals = { invoke: vi.fn(async () => undefined) };
    hadInternals = '__TAURI_INTERNALS__' in window;
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = internals;
  });

  afterEach(() => {
    if (!hadInternals) delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    delete asDoc(document).__hrmnyExternalLinksWired;
  });

  it('an http link click is prevented and handed to the opener plugin', () => {
    wireExternalLinksToDefaultBrowser();
    const { prevented } = clickAnchor('http://example.com/page');
    expect(prevented).toBe(true);
    expect(internals.invoke).toHaveBeenCalledWith('plugin:opener|open_url', {
      url: 'http://example.com/page',
    });
  });

  it('an https link click is prevented and handed to the opener plugin', () => {
    wireExternalLinksToDefaultBrowser();
    const { prevented } = clickAnchor('https://example.com/page');
    expect(prevented).toBe(true);
    expect(internals.invoke).toHaveBeenCalledWith('plugin:opener|open_url', {
      url: 'https://example.com/page',
    });
  });

  it('an in-app hash route never matches (the router keeps it)', () => {
    wireExternalLinksToDefaultBrowser();
    const { prevented } = clickAnchor('#/workspace/1/message/2');
    expect(prevented).toBe(false);
    expect(internals.invoke).not.toHaveBeenCalled();
  });

  it("non-http schemes are not the opener's business", () => {
    wireExternalLinksToDefaultBrowser();
    expect(clickAnchor('mailto:x@y.z').prevented).toBe(false);
    expect(clickAnchor('ftp://files.example.com/x').prevented).toBe(false);
    expect(internals.invoke).not.toHaveBeenCalled();
  });

  it('a refused open falls back to window.open rather than dying silently', async () => {
    internals.invoke = vi.fn(async () => {
      throw new Error('plugin refused');
    });
    const open = vi.fn();
    vi.stubGlobal('open', open);
    wireExternalLinksToDefaultBrowser();
    const { prevented } = clickAnchor('https://example.com/');
    expect(prevented).toBe(true);
    // The rejection resolves on a microtask — flush before asserting.
    await Promise.resolve();
    await Promise.resolve();
    expect(open).toHaveBeenCalledWith('https://example.com/', '_blank', 'noopener,noreferrer');
    vi.unstubAllGlobals();
  });

  it('in a BROWSER runtime nothing is intercepted at all', () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    // Fresh document state so the no-op branch actually re-evaluates.
    delete asDoc(document).__hrmnyExternalLinksWired;
    wireExternalLinksToDefaultBrowser();
    expect(clickAnchor('https://example.com/').prevented).toBe(false);
  });

  it('wiring is idempotent (a second call adds no second listener)', () => {
    wireExternalLinksToDefaultBrowser();
    wireExternalLinksToDefaultBrowser();
    clickAnchor('https://example.com/');
    expect(internals.invoke).toHaveBeenCalledTimes(1);
  });
});
