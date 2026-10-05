/**
 * fzstd loader tests (plan 004 M11, KD4).
 *
 * The fixtures are real zstd bytes generated locally (no network) with Node's
 * zstd codec, then committed here as base64 so the suite does not depend on
 * the host's zstd support:
 *
 *   ONE_FRAME_B64 — `zlib.zstdCompressSync(utf8(ONE_TEXT))`: a complete,
 *   terminated frame (what a one-shot encoder produces).
 *
 *   STREAM_B64 — a *never-terminated* flush stream: three JSON frames written
 *   through `zlib.createZstdCompress()` with `ZSTD_e_flush` after each and no
 *   `end()` call. That is the shape the gateway actually sends —
 *   `:ezstd.compress_streaming/2` holds one persistent context and flushes per
 *   frame (`apps/server/lib/cytale/gateway/compression.ex`), so the stream
 *   ends mid-frame from the client's point of view, forever.
 */
import { ZstdErrorCode, decompress } from 'fzstd';

import { createZstdWasmLoader, mobileZstdWasmLoader, zstdDecodeAvailable } from '../zstd';

const ONE_TEXT = '{"op":11,"d":{"heartbeat_ack":true,"note":"complete frame fixture"}}';
const ONE_FRAME_B64 =
  'KLUv/SBEBQIAQgQPFqC1OaieUt6WXyZaUDaRVMUtIybrb2Ct+bo2UCDyhIrI94dKeXz+JsDlS/dsHAwWL6ziCbPz4GLMWaVZAA==';

const STREAM_FRAMES = [
  '{"op":10,"d":{"heartbeat_interval":30000}}',
  `{"op":0,"t":"MessageCreate","s":1,"d":{"id":"1","content":"hello ${'world '.repeat(20)}"}}`,
  `{"op":0,"t":"MessageCreate","s":2,"d":{"id":"2","content":"second ${'frame '.repeat(20)}"}}`,
];
const STREAM_TEXT = STREAM_FRAMES.join('');
const STREAM_B64 =
  'KLUv/QBYUAEAeyJvcCI6MTAsImQiOnsiaGVhcnRiZWF0X2ludGVydmFsIjozMDAwMH19TAIAxAMwLCJ0IjoiTWVzc2FnZUNyZWF0ZSIsInMiOjFpZCI6IjEiLCJjb250ZW50IjoiaGVsbG8gd29ybGQifX0DAMJUchvBTcOUFfQAAIgyMnNlY29uZCBmcmFtZSJ9fQQAMCVNcBxw/MONFQ==';

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

const ONE_FRAME = fromBase64(ONE_FRAME_B64);
const STREAM = fromBase64(STREAM_B64);

describe('zstd loader', () => {
  it('reports the pure-JS backend present and caches one decompressor instance', async () => {
    expect(zstdDecodeAvailable()).toBe(true);
    // The app default is OFF on device: the loader is correct on Node but the
    // session stalls on Hermes (4001), so it is opt-in via
    // EXPO_PUBLIC_CYTALE_ZSTD until that is diagnosed.
    expect(mobileZstdWasmLoader).toBeUndefined();

    const loader = createZstdWasmLoader();
    const first = await loader();
    const second = await loader();
    expect(second).toBe(first);
  });

  it('does not evaluate the backend until something asks for it (lazy require)', () => {
    // The default build negotiates `none`, so importing the decode path must
    // not pay for the ~24 KB pure-JS backend at startup: the module-scope gate
    // checks the opt-in flag BEFORE probing (performance pass, LAZY BUNDLE).
    let evaluated = false;

    jest.isolateModules(() => {
      jest.doMock('fzstd', () => {
        evaluated = true;
        return jest.requireActual('fzstd');
      });

      const fresh = require('../zstd') as typeof import('../zstd');
      expect(fresh.mobileZstdWasmLoader).toBeUndefined();
      expect(evaluated).toBe(false);

      // The probe is what loads it, on first use.
      expect(fresh.zstdDecodeAvailable()).toBe(true);
      expect(evaluated).toBe(true);
    });

    jest.dontMock('fzstd');
  });

  it('still negotiates zstd when the opt-in flag is set', () => {
    const previous = process.env.EXPO_PUBLIC_CYTALE_ZSTD;
    process.env.EXPO_PUBLIC_CYTALE_ZSTD = '1';
    try {
      jest.isolateModules(() => {
        const fresh = require('../zstd') as typeof import('../zstd');
        expect(typeof fresh.mobileZstdWasmLoader).toBe('function');
      });
    } finally {
      process.env.EXPO_PUBLIC_CYTALE_ZSTD = previous;
    }
  });

  it('decodes a complete zstd frame', async () => {
    const decompressor = await createZstdWasmLoader()();
    expect(decode(await decompressor.decompress(ONE_FRAME))).toBe(ONE_TEXT);
  });

  it('decodes the gateway’s never-terminated flush stream, which one-shot decode rejects', async () => {
    // Red observation (kept as a regression guard on the decoder choice): the
    // one-shot API sees a frame with no epilogue and gives up with EOF.
    let oneShotError: unknown;
    try {
      decompress(STREAM);
    } catch (err) {
      oneShotError = err;
    }
    expect(oneShotError).toMatchObject({ code: ZstdErrorCode.UnexpectedEOF });

    const decompressor = await createZstdWasmLoader()();
    expect(decode(await decompressor.decompress(STREAM))).toBe(STREAM_TEXT);
  });

  it('takes the accumulated prefix incrementally and returns the full decoded text', async () => {
    const decompressor = await createZstdWasmLoader()();
    const sizes = [1, 7, 13, 5, 31, 64, 3];
    let offset = 0;
    let step = 0;
    let lastLength = 0;

    while (offset < STREAM.length) {
      const size = Math.min(sizes[step++ % sizes.length], STREAM.length - offset);
      offset += size;
      // The inflater always hands the WHOLE accumulated prefix.
      const text = decode(await decompressor.decompress(STREAM.subarray(0, offset)));
      expect(STREAM_TEXT.startsWith(text)).toBe(true);
      expect(text.length).toBeGreaterThanOrEqual(lastLength);
      lastLength = text.length;
    }

    expect(lastLength).toBe(STREAM_TEXT.length);
  });

  it('is idempotent when the same prefix is pushed twice', async () => {
    const decompressor = await createZstdWasmLoader()();
    const first = decode(await decompressor.decompress(STREAM));
    const second = decode(await decompressor.decompress(STREAM));
    expect(second).toBe(first);
    expect(second).toBe(STREAM_TEXT);
  });

  it('re-bases on a new stream instead of carrying the old frame state', async () => {
    const decompressor = await createZstdWasmLoader()();
    expect(decode(await decompressor.decompress(STREAM))).toBe(STREAM_TEXT);

    // A reconnect opens a fresh zstd stream; the cached app-wide decoder must
    // not treat it as a continuation of the previous one.
    expect(decode(await decompressor.decompress(ONE_FRAME))).toBe(ONE_TEXT);
    // …and the old stream still decodes if it comes back.
    expect(decode(await decompressor.decompress(STREAM))).toBe(STREAM_TEXT);
  });

  it('rejects a malformed frame instead of hanging, and recovers for the next stream', async () => {
    const decompressor = await createZstdWasmLoader()();
    const garbage = new Uint8Array(64).fill(0xff);

    const outcome = await Promise.race([
      decompressor.decompress(garbage).then(
        () => 'resolved',
        (err: unknown) => (err instanceof Error ? 'rejected' : 'rejected-non-error'),
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 100)),
    ]);
    expect(outcome).toBe('rejected');

    // The failed stream is dropped, not poisoned: the next valid stream decodes.
    expect(decode(await decompressor.decompress(STREAM))).toBe(STREAM_TEXT);
  });
});
