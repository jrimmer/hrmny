/**
 * Runtime shims for globals the shared `@cytale/*` packages rely on that
 * Hermes + Expo's WinterCG layer do not provide (plan 004 M1).
 *
 * Each shim installs ONLY when the native global is missing, so a future
 * Hermes/Expo that ships them wins automatically and the shims quietly retire.
 * The list is empirical: `docs/research/2026-09-08-cytale-mobile-rn-spike.md`.
 *
 * - `crypto.getRandomValues` — `@cytale/state`'s optimistic-send nonce.
 * - `crypto.randomUUID` — `@cytale/api-client`'s `Idempotency-Key`.
 * - `btoa`/`atob` — `@cytale/state` base64url-encodes the nonce.
 * - `TextEncoder` — `@cytale/gateway-client` measures UTF-8 frame sizes.
 *
 * The crypto shims are backed by `expo-crypto` (platform CSPRNG), never
 * `Math.random`.
 */
import { getRandomValues, randomUUID } from 'expo-crypto';

import { decodeBase64, encodeBase64 } from './base64';
import { Utf8TextEncoder } from './textEncoder';

/** Injected for tests; production callers omit it. */
export interface ShimDeps {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
}

type MutableGlobals = Record<string, unknown>;

interface CryptoGlobal {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
}

let lastInstalled: string[] = [];

/**
 * Names the last `installShims()` call had to provide — the difference between
 * the native runtime and what the app had to add. Empty means the runtime
 * supplies everything the shared packages need.
 */
export function getInstalledShims(): string[] {
  return lastInstalled;
}

function install(
  target: Record<string, unknown>,
  name: string,
  isMissing: boolean,
  value: unknown,
  installed: string[],
): void {
  if (!isMissing) return;
  target[name] = value;
  installed.push(name);
}

/**
 * Install every missing shim and return the names installed (empty on a
 * runtime that needs none). Idempotent.
 */
export function installShims(deps: ShimDeps = {}): string[] {
  const globals = globalThis as unknown as MutableGlobals;
  const installed: string[] = [];
  const uuid = deps.randomUUID ?? randomUUID;
  const fill = deps.getRandomValues ?? ((array: Uint8Array) => getRandomValues(array));

  const cryptoObject = (globals.crypto ?? {}) as CryptoGlobal;
  install(
    cryptoObject as unknown as Record<string, unknown>,
    'randomUUID',
    typeof cryptoObject.randomUUID !== 'function',
    () => uuid(),
    installed,
  );
  install(
    cryptoObject as unknown as Record<string, unknown>,
    'getRandomValues',
    typeof cryptoObject.getRandomValues !== 'function',
    (array: Uint8Array) => fill(array),
    installed,
  );
  globals.crypto = cryptoObject;

  install(globals, 'btoa', typeof globals.btoa !== 'function', encodeBase64, installed);
  install(globals, 'atob', typeof globals.atob !== 'function', decodeBase64, installed);
  install(
    globals,
    'TextEncoder',
    typeof globals.TextEncoder !== 'function',
    Utf8TextEncoder,
    installed,
  );

  lastInstalled = installed;
  return installed;
}
