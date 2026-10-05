/**
 * #111 — the zlib_stream path under REAL browser stream semantics.
 *
 * The jsdom/node unit suite cannot exercise this: jsdom has no
 * DecompressionStream at all, and Node's (undici) implementation has
 * different release semantics from a real engine. This suite drives the
 * ACTUAL shipped compression module inside Playwright's Chromium — the
 * zstd-less population the zlib fallback serves — and feeds it frames
 * produced by Node zlib with Z_SYNC_FLUSH, byte-for-byte the shape the
 * server's `:zlib.deflate(json, :sync)` encoder emits (one sync-flushed
 * member per frame, a stream that never finishes).
 *
 * Covered here, in a real engine:
 *   * the streaming-inflate capability probe (negotiation's zlib gate);
 *   * sink delivery across burst / cadence / split-compressed-bytes /
 *     idle-then-dispatch / coalesced shapes with the source never closing;
 *   * a large frame whose decompressed text straddles the engine's output
 *     chunk boundaries mid-character (the UTF-8 streaming-decoder fix).
 *
 * Skips cleanly where no chromium browser is installed, so the suite never
 * blocks environments that only run the pure unit tier.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { createDeflateRaw, constants as zlibConstants } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';

// The real production module — imported here for the pure matrix assertions
// and bundled below for the browser.
import { selectCompression } from '../compression.js';

/**
 * Server-mirror encoder: one binary wire message per frame, the frame's
 * bytes ending at a Z_SYNC_FLUSH boundary (never a final block).
 */
async function serverFrames(jsons: string[]): Promise<Uint8Array[]> {
  const def = createDeflateRaw();
  const chunks: Buffer[] = [];
  for (const j of jsons) {
    const chunk = await new Promise<Buffer>((resolve, reject) => {
      def.once('data', (b: Buffer) => resolve(b));
      def.write(j, () => def.flush(zlibConstants.Z_SYNC_FLUSH));
      def.once('error', reject);
    });
    chunks.push(chunk);
  }
  def.close();
  return chunks.map((b) => new Uint8Array(b));
}

// --- browser bootstrap (top-level so skipIf sees the outcome) -------------

let browser: Browser | null = null;
try {
  browser = await chromium.launch();
} catch {
  browser = null; // no browsers installed — the unit tier still covers logic
}

const tempDir = browser ? mkdtempSync(join(tmpdir(), 'cytale-gwc-')) : '';
const bundlePath = join(tempDir, 'bundle.js');

if (browser) {
  await build({
    stdin: {
      contents: `
        import {
          makeGatewayInflater,
          detectNativeZstd,
          detectNativeInflate,
          detectStreamingInflate,
        } from '../compression.ts';
        (window).__cytaleProbe = {
          makeGatewayInflater,
          detectNativeZstd,
          detectNativeInflate,
          detectStreamingInflate,
        };
      `,
      resolveDir: dirname(fileURLToPath(import.meta.url)),
      loader: 'ts',
    },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    outfile: bundlePath,
    logLevel: 'silent',
  });
}

const hex = (u: Uint8Array): string => Buffer.from(u).toString('hex');
const concat = (chunks: Uint8Array[]): Uint8Array => {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
};
const frame = (i: number, pad = 0) =>
  JSON.stringify({ op: 0, t: 'MessageCreate', s: i + 1, d: { id: 'm' + i, content: 'stress ' + i + ' ' + 'x'.repeat(pad) } });

describe.skipIf(!browser)('#111 zlib_stream in a real browser (Playwright chromium)', () => {
  let page: Page | null = null;

  afterAll(async () => {
    await page?.context().close();
    await browser?.close();
  });

  const thePage = async (): Promise<Page> => {
    if (page) return page;
    page = await browser!.newPage();
    await page.setContent('<html><body>probe</body></html>');
    await page.addScriptTag({ path: bundlePath });
    return page;
  };

  it('boots a page with the real module and probes streaming inflate', async () => {
    const caps = await (await thePage()).evaluate(async () => {
      const probe = (window as unknown as {
        __cytaleProbe: {
          detectNativeZstd: () => boolean;
          detectNativeInflate: () => boolean;
          detectStreamingInflate: () => Promise<boolean>;
        };
      }).__cytaleProbe;
      return {
        nativeZstd: probe.detectNativeZstd(),
        nativeInflate: probe.detectNativeInflate(),
        streams: await probe.detectStreamingInflate(),
      };
    });
    // This browser class has no native zstd (the whole reason zlib is its
    // path) and its deflate stream DOES release output without close — so
    // zlib is negotiable here.
    expect(caps.nativeInflate).toBe(true);
    expect(caps.streams).toBe(true);
    // And the negotiation matrix honors exactly that answer:
    expect(
      selectCompression('zstd_stream', ['zstd_stream', 'zlib_stream'], caps.nativeZstd, false, caps.streams),
    ).toBe(caps.nativeZstd ? 'zstd_stream' : 'zlib_stream');
  });

  it('delivers live-shaped frames through the sink: burst, cadence, split, idle, coalesced', { timeout: 30_000 }, async () => {
    const coalesced = await serverFrames([frame(300), frame(301)]);
    const shapes: Array<{ name: string; hexes: string[]; mode: string; want: number }> = [
      { name: 'burst-120', mode: 'burst', want: 120,
        hexes: (await serverFrames(Array.from({ length: 120 }, (_, i) => frame(i)))).map(hex) },
      { name: 'cadence-20@20ms', mode: 'cadence', want: 20,
        hexes: (await serverFrames(Array.from({ length: 20 }, (_, i) => frame(100 + i)))).map(hex) },
      { name: 'split-compressed-3ways', mode: 'split', want: 1,
        hexes: (await serverFrames([frame(200, 400)])).map(hex) },
      { name: 'idle-then-dispatch', mode: 'idle', want: 1,
        hexes: (await serverFrames([frame(201)])).map(hex) },
      // The #26 jam shape: TWO sync-flushed frames arriving as ONE wire
      // message (the socket coalesced them).
      { name: 'coalesced-two-frames-one-write', mode: 'burst', want: 2,
        hexes: [hex(concat(coalesced))] },
    ];

    const results = await (await thePage()).evaluate(
      async (shapes) => {
        const bytes = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
        const { makeGatewayInflater } = (window as unknown as {
          __cytaleProbe: { makeGatewayInflater: (c: string) => Promise<{
            setSink: (f: (t: string) => void) => void;
            setOnError: (f: (e: unknown) => void) => void;
            push: (u: Uint8Array) => Promise<string[]>;
            dispose?: () => void;
          }> };
        }).__cytaleProbe;
        const out: Record<string, { delivered: number; errored: string | null; texts: string[] }> = {};
        for (const shape of shapes) {
          const inflater = await makeGatewayInflater('zlib_stream');
          const delivered: string[] = [];
          let errored: string | null = null;
          inflater.setSink((t) => delivered.push(t));
          inflater.setOnError((e) => { errored = String(e); });
          if (shape.mode === 'burst') {
            for (const h of shape.hexes) void inflater.push(bytes(h));
            await new Promise((r) => setTimeout(r, 1200));
          } else if (shape.mode === 'cadence') {
            for (const h of shape.hexes) { await inflater.push(bytes(h)); await new Promise((r) => setTimeout(r, 20)); }
            await new Promise((r) => setTimeout(r, 400));
          } else if (shape.mode === 'split') {
            const [only] = shape.hexes;
            if (only === undefined) throw new Error(`${shape.name}: no frame to split`);
            const b = bytes(only);
            const cut = Math.floor(b.length / 3);
            await inflater.push(b.subarray(0, cut));
            await inflater.push(b.subarray(cut, 2 * cut));
            await inflater.push(b.subarray(2 * cut));
            await new Promise((r) => setTimeout(r, 700));
          } else if (shape.mode === 'idle') {
            const [only] = shape.hexes;
            if (only === undefined) throw new Error(`${shape.name}: no frame to deliver`);
            await new Promise((r) => setTimeout(r, 1500));
            await inflater.push(bytes(only));
            await new Promise((r) => setTimeout(r, 700));
          }
          out[shape.name] = { delivered: delivered.length, errored, texts: delivered.slice(0, 2) };
          inflater.dispose?.();
        }
        return out;
      },
      shapes,
    );

    for (const shape of shapes) {
      const r = results[shape.name]!;
      expect(r.errored, shape.name).toBeNull();
      expect(r.delivered, `${shape.name}: every frame delivers`).toBe(shape.want);
    }
    // Sequence integrity end to end (first frames, in order).
    expect(JSON.parse(results['burst-120']!.texts[0]!).s).toBe(1);
    expect(JSON.parse(results['cadence-20@20ms']!.texts[0]!).s).toBe(101);
    expect(JSON.parse(results['coalesced-two-frames-one-write']!.texts[0]!).s).toBe(301);
    expect(JSON.parse(results['idle-then-dispatch']!.texts[0]!).t).toBe('MessageCreate');
  });

  it('large frame straddling engine output chunks keeps every multi-byte character intact', { timeout: 20_000 }, async () => {
    // Content whose CJK characters straddle each 64 KiB boundary of the
    // decompressed text: the engine releases output in ≤64 KiB chunks, so
    // these characters are split mid-UTF-8-sequence across collector reads.
    const prefix = '{"op":0,"t":"MessageCreate","s":1,"d":{"id":"big","content":"';
    const cjk = '斜'; // 3 UTF-8 bytes
    let content = '';
    let pos = prefix.length; // byte position in the decompressed text
    while (pos < 200_000) {
      const nextBoundary = Math.floor(pos / 65_536) * 65_536 + 65_536;
      const pad = nextBoundary - pos - 1; // CJK's LAST byte lands on the boundary
      content += 'x'.repeat(pad) + cjk;
      pos += pad + 3;
    }
    const text = prefix + content + '"}}';
    // The frame's own wire bytes come from the real encoder shape.
    const wire = await serverFrames([text]);

    const delivered = await (await thePage()).evaluate(async (hexFrame) => {
      const bytes = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
      const { makeGatewayInflater } = (window as unknown as {
        __cytaleProbe: { makeGatewayInflater: (c: string) => Promise<{
          setSink: (f: (t: string) => void) => void;
          setOnError: (f: (e: unknown) => void) => void;
          push: (u: Uint8Array) => Promise<string[]>;
          dispose?: () => void;
        }> };
      }).__cytaleProbe;
      const inflater = await makeGatewayInflater('zlib_stream');
      const out: string[] = [];
      let errored: string | null = null;
      inflater.setSink((t) => out.push(t));
      inflater.setOnError((e) => { errored = String(e); });
      await inflater.push(bytes(hexFrame));
      await new Promise((r) => setTimeout(r, 1200));
      inflater.dispose?.();
      return { out, errored };
    }, hex(wire[0]!));

    expect(delivered.errored).toBeNull();
    expect(delivered.out).toHaveLength(1);
    const parsed = JSON.parse(delivered.out[0]!) as { d: { content: string } };
    expect(parsed.d.content).toBe(content); // every CJK char intact, none U+FFFD
    expect(parsed.d.content).not.toContain('\uFFFD');
  });
});
