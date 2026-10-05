/**
 * @cytale/web — desktop-shell token storage backed by the OS credential store.
 *
 * The web adapter persists both tokens in localStorage: a plaintext SQLite
 * file, readable by anything running at `tauri://localhost` and by anyone with
 * read access to the machine. That tradeoff is defensible in a browser (CSP-
 * constrained, and the PWA's storage is its own origin) but not in the shell,
 * where a stolen refresh token is a 30-day account takeover with no other
 * credential binding. The shell therefore keeps the pair in the platform
 * credential store (macOS Keychain, Windows Credential Manager, Linux Secret
 * Service) via the `secrets_*` commands in apps/desktop/src-tauri/src/secrets.rs.
 *
 * Shape follows the native client (KD3): reads are synchronous from an
 * in-memory mirror that `hydrate()` fills, writes write through asynchronously
 * and are best-effort — a denied keychain leaves the in-memory session working
 * and the persisted copy stale, exactly as localStorage failures do on web.
 *
 * `apps/web` deliberately does not depend on `@tauri-apps/api` for one call:
 * `isTauri()` already probes the same `__TAURI_INTERNALS__` global, and
 * `invoke` is the documented entry point on it.
 */
import type { StoredTokenPair, TokenStorage } from '@cytale/session';

interface TauriInternals {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
}

function bridge(): TauriInternals | null {
  if (typeof window === 'undefined') return null;
  const internals = (window as { __TAURI_INTERNALS__?: Partial<TauriInternals> })
    .__TAURI_INTERNALS__;
  return typeof internals?.invoke === 'function' ? (internals as TauriInternals) : null;
}

/** Synchronous read mirror; filled by `hydrate()`, updated by `write()`. */
let mirror: StoredTokenPair | null = null;

/** Test seam: drop the mirror between cases. */
export function resetTauriTokenStorageForTests(): void {
  mirror = null;
}

export function tauriTokenStorage(): TokenStorage {
  return {
    read() {
      return mirror;
    },

    async hydrate(): Promise<void> {
      const ipc = bridge();
      if (!ipc) return;
      try {
        const raw = await ipc.invoke('secrets_get');
        if (typeof raw !== 'string' || raw === '') return;
        const parsed = JSON.parse(raw) as Partial<StoredTokenPair>;
        mirror = {
          accessToken: parsed.accessToken ?? null,
          refreshToken: parsed.refreshToken ?? null,
        };
      } catch {
        // No entry yet, a denied keychain, or a corrupt payload: start signed
        // out rather than failing the launch.
        mirror = null;
      }
    },

    write(pair: StoredTokenPair | null): void {
      mirror = pair === null ? null : { ...pair };
      const ipc = bridge();
      if (!ipc) return;
      const call =
        pair === null
          ? ipc.invoke('secrets_delete')
          : ipc.invoke('secrets_set', { value: JSON.stringify(pair) });
      void call.catch(() => undefined);
    },

    flush(): Promise<void> {
      // Writes are fire-and-forget against the keychain; nothing to settle.
      return Promise.resolve();
    },
  };
}
