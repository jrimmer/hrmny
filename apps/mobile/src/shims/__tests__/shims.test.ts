/**
 * Shim tests (plan 004 M1). The load-bearing case is the last one: the shims
 * exist because a *shared package* needs the global, so the regression net
 * drives the real caller rather than asserting on the shim in isolation.
 */
import { beginOptimisticSend, defaultStore } from '@cytale/state';

import { installShims } from '..';
import { decodeBase64, encodeBase64 } from '../base64';
import { Utf8TextEncoder } from '../textEncoder';

type MutableGlobals = Record<string, unknown>;
const globals = globalThis as unknown as MutableGlobals;

const original = {
  btoa: globals.btoa,
  atob: globals.atob,
  TextEncoder: globals.TextEncoder,
  crypto: globals.crypto,
};

function setCrypto(value: unknown): void {
  Object.defineProperty(globals, 'crypto', { value, configurable: true, writable: true });
}

afterEach(() => {
  globals.btoa = original.btoa;
  globals.atob = original.atob;
  globals.TextEncoder = original.TextEncoder;
  setCrypto(original.crypto);
});

describe('installShims', () => {
  it('fills the missing globals and reports what it installed', () => {
    globals.btoa = undefined;
    globals.atob = undefined;
    globals.TextEncoder = undefined;
    setCrypto({});

    const installed = installShims({
      randomUUID: () => 'fixed-uuid',
      getRandomValues: (array) => array.fill(7),
    });

    expect(installed).toEqual(
      expect.arrayContaining(['randomUUID', 'getRandomValues', 'btoa', 'atob', 'TextEncoder']),
    );
    expect((globals.btoa as (s: string) => string)('hi')).toBe('aGk=');
    expect((globals.atob as (s: string) => string)('aGk=')).toBe('hi');
    const bytes = new (globals.TextEncoder as typeof Utf8TextEncoder)().encode('é');
    expect(Array.from(bytes)).toEqual([0xc3, 0xa9]);
    expect((globals.crypto as { randomUUID: () => string }).randomUUID()).toBe('fixed-uuid');
  });

  it('leaves existing globals untouched', () => {
    const nativeBtoa = () => 'native';
    globals.btoa = nativeBtoa;
    setCrypto({ getRandomValues: (a: Uint8Array) => a });

    const installed = installShims({ randomUUID: () => 'x' });

    expect(installed).not.toContain('btoa');
    expect(installed).not.toContain('getRandomValues');
    expect(globals.btoa).toBe(nativeBtoa);
  });

  it('is idempotent', () => {
    setCrypto({});
    installShims({ randomUUID: () => 'x', getRandomValues: (a) => a });
    expect(installShims({ randomUUID: () => 'x', getRandomValues: (a) => a })).toEqual([]);
  });

  // The regression net for R2: @cytale/state's optimistic send needs both
  // crypto.getRandomValues and btoa. Remove the shims and this throws.
  it('lets a shared package that needs the globals run', () => {
    globals.btoa = undefined;
    setCrypto({});
    installShims({ randomUUID: () => 'x', getRandomValues: (a) => a.fill(1) });

    const result = beginOptimisticSend(defaultStore, {
      channel_id: '1',
      thread_id: null,
      author_id: '2',
      content: 'shimmed',
    });

    expect(result.messageId).toMatch(/^pending_[A-Za-z0-9_-]{12}$/);
  });
});

describe('base64 helpers', () => {
  it('round-trips Latin-1 strings', () => {
    const input = 'Cytale\u0000\u00ff';
    expect(decodeBase64(encodeBase64(input))).toBe(input);
  });

  it('rejects out-of-range characters like btoa does', () => {
    // 'é' is U+00E9 — inside Latin-1, so it encodes; '€' is U+20AC and throws.
    expect(encodeBase64('é')).toBe('6Q==');
    expect(() => encodeBase64('€')).toThrow(TypeError);
  });

  it('rejects invalid input like atob does', () => {
    expect(() => decodeBase64('!!!!')).toThrow(TypeError);
  });
});

describe('Utf8TextEncoder', () => {
  it('encodes ASCII, 2-byte, 3-byte and surrogate-pair code points', () => {
    expect(Array.from(new Utf8TextEncoder().encode('A'))).toEqual([0x41]);
    expect(Array.from(new Utf8TextEncoder().encode('é'))).toEqual([0xc3, 0xa9]);
    expect(Array.from(new Utf8TextEncoder().encode('€'))).toEqual([0xe2, 0x82, 0xac]);
    expect(Array.from(new Utf8TextEncoder().encode('😀'))).toEqual([0xf0, 0x9f, 0x98, 0x80]);
  });

  it('matches the platform encoder when one exists', () => {
    const sample = 'Cytale — héllo 😀';
    if (typeof TextEncoder === 'function') {
      expect(Array.from(new Utf8TextEncoder().encode(sample))).toEqual(
        Array.from(new TextEncoder().encode(sample)),
      );
    }
  });
});
