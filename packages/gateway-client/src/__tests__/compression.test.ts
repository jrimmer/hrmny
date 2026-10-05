/**
 * Hardening plan 2.4 — the client's compressed-frame path must cost what the
 * FRAME costs, not what the whole session costs.
 *
 * The defect: `zstd_stream` — the default preferred codec — decompressed the
 * entire accumulated stream on every wire message and then re-walked and
 * re-`JSON.parse`d every span it had already emitted (`processedChars` stopped
 * the re-EMISSION, not the re-parse). Quadratic in session length, and the
 * compressed history was retained forever.
 *
 * These tests drive the two decode paths directly:
 *   * the STREAMING pipe (what a native-zstd runtime now uses, and what the
 *     injected factory hook exercises here) — each frame decoded once, nothing
 *     retained, output unchanged;
 *   * the one-shot WASM fallback — still correct, but scanning only the new
 *     suffix instead of the whole history.
 *
 * Plus the negotiation rule: a runtime whose only zstd backend is one-shot
 * prefers a codec that CAN stream.
 */
import { describe, it, expect } from 'vitest';
import { makeGatewayInflater, selectCompression } from '../compression.js';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** An identity "decompressor": whatever is written is what the reader yields. */
function identityPipe(): {
  writer: { write(u: Uint8Array): Promise<void> };
  reader: ReadableStreamDefaultReader<Uint8Array>;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });

  return {
    writer: {
      write: (u: Uint8Array) => {
        controller.enqueue(u);
        return Promise.resolve();
      },
    },
    reader: stream.getReader(),
  };
}

/** Let the collector's read loop run: delivery is asynchronous by design. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 5));
}

describe('2.4 the zstd streaming pipe decodes each frame once', () => {
  it('delivers every frame, retains no bytes, and returns nothing from push', async () => {
    const inflater = await makeGatewayInflater('zstd_stream', { zstdStreamFactory: identityPipe });
    const seen: string[] = [];
    inflater.setSink?.((text) => seen.push(text));

    const frames = Array.from({ length: 200 }, (_, i) => `{"op":0,"s":${i + 1},"t":"E${i}"}`);

    for (const frame of frames) {
      // Sink mode: the frame's text is delivered by the collector, never as a
      // push return — that is what makes the call O(frame).
      expect(await inflater.push(utf8(frame))).toEqual([]);
    }

    await settle();
    expect(seen).toEqual(frames);

    // THE GATE: nothing accumulates. The old path retained every compressed
    // byte of the session and re-decoded them per frame.
    const internal = inflater as unknown as { acc: { length: number }; streamPendingText: string };
    expect(internal.acc.length).toBe(0);
    expect(internal.streamPendingText).toBe('');
  });

  it('carries a multi-byte character split across engine chunk boundaries', async () => {
    const inflater = await makeGatewayInflater('zstd_stream', { zstdStreamFactory: identityPipe });
    const seen: string[] = [];
    inflater.setSink?.((text) => seen.push(text));

    const bytes = utf8('{"c":"斜📸é"}');
    // Split INSIDE the multi-byte sequence, exactly as an engine's output
    // chunking does.
    await inflater.push(bytes.slice(0, 9));
    await inflater.push(bytes.slice(9));
    await settle();

    expect(seen).toEqual(['{"c":"斜📸é"}']);
  });

  it('emits only the spans a frame completed, in order, across fragmented tails', async () => {
    const inflater = await makeGatewayInflater('zstd_stream', { zstdStreamFactory: identityPipe });
    const seen: string[] = [];
    inflater.setSink?.((text) => seen.push(text));

    // One frame split across two wire messages, then two whole ones.
    await inflater.push(utf8('{"t":"A"}{"t":'));
    await inflater.push(utf8('"B"}{"t":"C"}'));
    await settle();

    expect(seen).toEqual(['{"t":"A"}', '{"t":"B"}', '{"t":"C"}']);
  });
});

describe('2.4 the one-shot zstd fallback still emits each frame once', () => {
  it('scans only the new suffix, so an old span is never re-emitted', async () => {
    // The fallback decodes the accumulated stream (a continuation cannot be
    // decoded piecewise) but must not re-walk what it already emitted.
    // Identity bytes: the fallback hands this the WHOLE accumulated stream, so
    // returning it unchanged models a decompressor that decodes the
    // concatenation (which is what the real one-shot path does).
    const loader = async () => ({ decompress: async (input: Uint8Array) => input });

    const inflater = await makeGatewayInflater('zstd_stream', { zstdWasmLoader: loader });

    expect(await inflater.push(utf8('{"t":"A"}'))).toEqual(['{"t":"A"}']);
    expect(await inflater.push(utf8('{"t":"B"}'))).toEqual(['{"t":"B"}']);
    expect(await inflater.push(utf8('{"t":"C"}'))).toEqual(['{"t":"C"}']);
    // A fragmented tail yields nothing until it completes.
    expect(await inflater.push(utf8('{"t":"D'))).toEqual([]);
    expect(await inflater.push(utf8('"}'))).toEqual(['{"t":"D"}']);
  });
});

describe('2.4 the uncompressed codec decodes only the frame it was given', () => {
  it('returns each frame once and accumulates nothing', async () => {
    const inflater = await makeGatewayInflater('none');

    expect(await inflater.push(utf8('{"t":"A"}'))).toEqual(['{"t":"A"}']);
    expect(await inflater.push(utf8('{"t":"B"}'))).toEqual(['{"t":"B"}']);

    const internal = inflater as unknown as { acc: { length: number } };
    expect(internal.acc.length).toBe(0);
  });
});

describe('2.4 negotiation prefers a codec that can stream', () => {
  it('a one-shot zstd loader yields to streaming zlib when both are offered', () => {
    // Native zstd streams; a WASM loader can only re-decode the whole history.
    expect(selectCompression('zstd_stream', ['zstd_stream', 'zlib_stream'], true, true, true)).toBe(
      'zstd_stream',
    );
    expect(selectCompression('zstd_stream', ['zstd_stream', 'zlib_stream'], false, true, true)).toBe(
      'zlib_stream',
    );
    // …and the loader is still the last resort when zlib is not on the table.
    expect(selectCompression('zstd_stream', ['zstd_stream'], false, true, false)).toBe('zstd_stream');
  });
});
