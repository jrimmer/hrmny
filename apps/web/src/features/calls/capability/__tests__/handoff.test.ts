/**
 * @cytale/web — desktop handoff tests (calls V2 plan U6; R12 + KDV3).
 *
 * Under test:
 *   - webAppOrigin(): runtime override (setWebAppOrigin — same priority as
 *     the VITE_WEB_ORIGIN build-time path, exercised through the setter
 *     because vite-node does not share import.meta.env across modules)
 *     → location.origin fallback, trailing slash normalized.
 *   - openWebApp(): in the shell, the Tauri opener command
 *     (`plugin:opener|open_url`) with the BARE origin — KDV3's no-deep-link
 *     rule is an asserted invariant; on invoke failure it falls back to
 *     window.open; outside the shell it opens window.open directly.
 *   - the handoff-initiated flag (the displaced-notice variant selector).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isHandoffInitiated,
  openWebApp,
  resetHandoffForTests,
  setWebAppOrigin,
  webAppOrigin,
} from '../handoff.js';

type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function setTauriShell(invoke?: InvokeFn): void {
  if (invoke === undefined) {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    return;
  }
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: { invoke },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  setTauriShell();
  resetHandoffForTests();
});

describe('webAppOrigin', () => {
  it('defaults to the current origin (browser / PWA / tauri dev)', () => {
    setTauriShell();
    expect(webAppOrigin()).toBe(window.location.origin);
  });

  it('prefers a configured origin (setWebAppOrigin — runtime seam; VITE_WEB_ORIGIN is the same-priority build-time path)', () => {
    setWebAppOrigin('https://chat.cytale.example');
    expect(webAppOrigin()).toBe('https://chat.cytale.example');
  });

  it('normalizes a trailing slash off the configured origin', () => {
    setWebAppOrigin('https://chat.cytale.example/');
    expect(webAppOrigin()).toBe('https://chat.cytale.example');
  });

  it('ignores an empty override and falls back to the origin', () => {
    setWebAppOrigin('');
    expect(webAppOrigin()).toBe(window.location.origin);
  });

  it('clearing the override restores the fallback', () => {
    setWebAppOrigin('https://chat.cytale.example');
    setWebAppOrigin(null);
    expect(webAppOrigin()).toBe(window.location.origin);
  });
});

describe('openWebApp — in the desktop shell', () => {
  it('invokes the Tauri opener command with the bare configured origin', async () => {
    setWebAppOrigin('https://chat.cytale.example');
    const invoke = vi.fn(() => Promise.resolve());
    setTauriShell(invoke);
    const open = vi.spyOn(window, 'open').mockReturnValue(null);

    await openWebApp();

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('plugin:opener|open_url', {
      url: 'https://chat.cytale.example',
    });
    expect(open).not.toHaveBeenCalled(); // no double open
  });

  it('never carries a path, query, or hash (KDV3: no deep links, no auto-join)', async () => {
    const invoke = vi.fn((_cmd: string, _args?: Record<string, unknown>) => Promise.resolve());
    setTauriShell(invoke);

    await openWebApp();

    const args = invoke.mock.calls[0]?.[1] as { url: string } | undefined;
    const parsed = new URL(args?.url ?? '');
    expect(parsed.pathname).toBe('/');
    expect(parsed.search).toBe('');
    expect(parsed.hash).toBe('');
  });

  it('falls back to window.open when the shell has not wired the opener plugin', async () => {
    const invoke = vi.fn(() => Promise.reject(new Error('plugin opener not found')));
    setTauriShell(invoke);
    const open = vi.spyOn(window, 'open').mockReturnValue(null);

    await openWebApp();

    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(
      window.location.origin,
      '_blank',
      'noopener,noreferrer',
    );
  });
});

describe('openWebApp — in a browser', () => {
  it('opens the bare origin via window.open directly', async () => {
    setTauriShell(); // no __TAURI_INTERNALS__ — browser / PWA
    const open = vi.spyOn(window, 'open').mockReturnValue(null);

    await openWebApp();

    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(
      window.location.origin,
      '_blank',
      'noopener,noreferrer',
    );
  });
});

describe('handoff-initiated flag', () => {
  it('flips when the handoff runs — the displaced-notice variant selector', async () => {
    expect(isHandoffInitiated()).toBe(false);
    vi.spyOn(window, 'open').mockReturnValue(null);
    await openWebApp();
    expect(isHandoffInitiated()).toBe(true);
  });
});
