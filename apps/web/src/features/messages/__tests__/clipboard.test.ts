/**
 * #114 — the clipboard write behind Copy Link.
 *
 * The interesting case is not the Clipboard API (a one-line call); it is the
 * deployment where it does not exist. `navigator.clipboard` requires a secure
 * context, and this app is self-hostable and routinely served over plain
 * http:// on a LAN — where a Copy Link that silently does nothing is the bug
 * the ticket names. The fallback and the honest failure are pinned here.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { writeClipboardText } from '../clipboard.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('writeClipboardText', () => {
  it('prefers the Clipboard API when the context provides one', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...globalThis.navigator, clipboard: { writeText } });

    await writeClipboardText('https://example.test/#/channel/2/message/3');

    expect(writeText).toHaveBeenCalledWith('https://example.test/#/channel/2/message/3');
  });

  it('propagates a refused write so the caller can say it failed', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('not allowed');
    });
    vi.stubGlobal('navigator', { ...globalThis.navigator, clipboard: { writeText } });

    await expect(writeClipboardText('x')).rejects.toThrow('not allowed');
  });

  it('falls back to the legacy copy on a non-secure origin (no Clipboard API)', async () => {
    // No navigator.clipboard at all — the http:// deployment.
    vi.stubGlobal('navigator', { ...globalThis.navigator, clipboard: undefined });
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });

    await expect(writeClipboardText('https://example.test/#/channel/2/message/3')).resolves.toBeUndefined();

    expect(execCommand).toHaveBeenCalledWith('copy');
    // The scratch textarea must not be left in the document.
    expect(document.querySelectorAll('textarea').length).toBe(0);
  });

  it('rejects when neither route exists, rather than claiming a copy', async () => {
    vi.stubGlobal('navigator', { ...globalThis.navigator, clipboard: undefined });
    Object.defineProperty(document, 'execCommand', { configurable: true, value: undefined });

    await expect(writeClipboardText('x')).rejects.toThrow(/unavailable/i);
  });

  it('accepts an injected writer (the seam the UI tests use)', async () => {
    const write = vi.fn(async () => undefined);
    await writeClipboardText('anything', write);
    expect(write).toHaveBeenCalledWith('anything');
  });
});
