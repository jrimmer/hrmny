/**
 * Desktop-shell token storage: the pair must live in the OS credential store
 * (`secrets_*` commands) rather than the webview's plaintext localStorage.
 * These tests pin the mirror/hydrate/write-through contract against a fake
 * `__TAURI_INTERNALS__.invoke`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  resetTauriTokenStorageForTests,
  tauriTokenStorage,
} from '../tauriTokenStorage.js';

interface Calls {
  command: string;
  args?: Record<string, unknown>;
}

function installBridge(
  handler: (command: string, args?: Record<string, unknown>) => Promise<unknown>,
): Calls[] {
  const calls: Calls[] = [];
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: {
      invoke: (command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        return handler(command, args);
      },
    },
  });
  return calls;
}

afterEach(() => {
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  resetTauriTokenStorageForTests();
  vi.restoreAllMocks();
});

describe('tauriTokenStorage', () => {
  it('hydration fills the synchronous mirror from the credential store', async () => {
    installBridge(async () =>
      JSON.stringify({ accessToken: 'access-1', refreshToken: 'refresh-1' }),
    );
    const storage = tauriTokenStorage();
    expect(storage.read()).toBeNull();

    await storage.hydrate!();

    expect(storage.read()).toEqual({ accessToken: 'access-1', refreshToken: 'refresh-1' });
  });

  it('hydration with no stored entry leaves the mirror empty (signed out)', async () => {
    installBridge(async () => null);
    const storage = tauriTokenStorage();

    await storage.hydrate!();

    expect(storage.read()).toBeNull();
  });

  it('hydration tolerates a denied keychain instead of failing the launch', async () => {
    installBridge(async () => {
      throw new Error('keychain denied');
    });
    const storage = tauriTokenStorage();

    await expect(storage.hydrate!()).resolves.toBeUndefined();
    expect(storage.read()).toBeNull();
  });

  it('write mirrors synchronously and persists to the credential store', () => {
    const calls = installBridge(async () => undefined);
    const storage = tauriTokenStorage();

    storage.write({ accessToken: 'a', refreshToken: 'r' });

    expect(storage.read()).toEqual({ accessToken: 'a', refreshToken: 'r' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('secrets_set');
    expect(JSON.parse(String(calls[0]!.args!.value))).toEqual({
      accessToken: 'a',
      refreshToken: 'r',
    });
  });

  it('clearing deletes the stored entry', () => {
    const calls = installBridge(async () => undefined);
    const storage = tauriTokenStorage();
    storage.write({ accessToken: 'a', refreshToken: 'r' });

    storage.write(null);

    expect(storage.read()).toBeNull();
    expect(calls.map((c) => c.command)).toEqual(['secrets_set', 'secrets_delete']);
  });

  it('falls back to memory-only when the bridge is absent', () => {
    const storage = tauriTokenStorage();

    storage.write({ accessToken: 'a', refreshToken: 'r' });

    expect(storage.read()).toEqual({ accessToken: 'a', refreshToken: 'r' });
  });
});
