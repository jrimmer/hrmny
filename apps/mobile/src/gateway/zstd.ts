/**
 * Pure-JS zstd decode path for the native client (plan 004 M11, KD4).
 *
 * Hermes ships no `DecompressionStream`, so `detectNativeZstd()` is false on
 * device and `selectCompression` would negotiate `none` — uncompressed
 * gateway frames. `fzstd` (pure JS, no native module, no WASM fetch) is handed
 * to the client through the existing `zstdWasmLoader` seam so the handshake
 * can negotiate `zstd_stream`; without it the client keeps `none` as its
 * documented fallback.
 *
 * Why the streaming decoder, not `fzstd`'s one-shot `decompress()`: the
 * gateway compresses with a PERSISTENT streaming context that sync-flushes
 * per frame and never ends the stream (`:ezstd.compress_streaming/2` →
 * `ZSTD_e_flush`; see `apps/server/lib/cytale/gateway/compression.ex`). Such
 * bytes are a valid block sequence with no frame epilogue, so the one-shot API
 * rejects them with `UnexpectedEOF` while `Decompress` decodes every flushed
 * block incrementally. That is the difference between a working session and
 * every frame counting as malformed.
 *
 * The inflater re-hands the WHOLE accumulated stream prefix on every wire
 * message (its cursor is character-offset based, see compression.ts). This
 * decoder therefore keeps its position: a push that extends the previous input
 * feeds only the new suffix and returns the full decoded prefix from cache;
 * anything else starts a fresh stream (a reconnect opens a new zstd stream, so
 * the app-wide cached instance must not carry the old frame's state into it).
 *
 * No Node APIs, no globals: `Uint8Array` + `Promise` only, both present on
 * Hermes.
 *
 * Bundle cost (performance pass, LAZY BUNDLE): `fzstd` is ~24 KB and the app
 * negotiates `none` unless `EXPO_PUBLIC_CYTALE_ZSTD=1`, so it is NOT imported
 * at module scope any more. It is required lazily by `fzstd()` below, and the
 * exported loader's gate checks the opt-in flag FIRST, so a default build
 * never evaluates the backend at startup.
 *
 * Honest scope of that win: Metro resolves the dependency statically, so the
 * bytes stay in the bundle (removing them would need RAM bundles / real bundle
 * chunking, which this Metro config does not do); what is removed is the
 * module's eager EVALUATION at cold start. The require is synchronous by
 * necessity — `decompress`'s state machine must not yield (see
 * `FzstdDecompressor.decompress`) — so `await import()` is not an option here.
 */

import type { Decompress } from 'fzstd';

import type { ZstdWasmDecompressor, ZstdWasmLoader } from '@cytale/gateway-client';

const EMPTY = new Uint8Array(0);

/** The backend module's shape, for the lazy require below. */
type FzstdModule = typeof import('fzstd');

/** Metro's synchronous require; typed locally (no Node globals in this app). */
declare const require: (moduleName: string) => unknown;

/** `undefined` = not probed yet, `null` = the backend is absent. */
let backend: FzstdModule | null | undefined;

/** The pure-JS backend, loaded on first use and memoized. */
function fzstd(): FzstdModule | null {
  if (backend === undefined) {
    try {
      backend = require('fzstd') as FzstdModule;
    } catch {
      backend = null;
    }
  }
  return backend;
}

/** True iff the bundled pure-JS zstd backend is present and usable. */
export function zstdDecodeAvailable(): boolean {
  return typeof fzstd()?.Decompress === 'function';
}

/**
 * Incremental decoder over one zstd stream, re-fed the accumulated prefix by
 * the gateway inflater. Not exported: obtain one through a loader so the
 * instance (and its position) is cached app-wide.
 */
class FzstdDecompressor implements ZstdWasmDecompressor {
  /** fzstd stream decoder for the current stream, null before the first byte. */
  private stream: Decompress | null = null;
  /** Decoded chunks of the current stream, in order. */
  private chunks: Array<Uint8Array> = [];
  /** Joined view of `chunks`; invalidated when new chunks land. */
  private joined: Uint8Array | null = null;
  /** The exact input accepted so far (by reference — callers treat it as immutable). */
  private source: Uint8Array = EMPTY;
  /** How many bytes of `source` have been fed to the decoder. */
  private fed = 0;

  decompress(input: Uint8Array): Promise<Uint8Array> {
    // Deliberately synchronous end to end: the inflater may have several
    // pushes in flight at once, and an await inside this state machine would
    // let them interleave a stream position that is only valid in order.
    try {
      if (this.extendsPrevious(input)) {
        if (input.length > this.fed) this.feed(input.subarray(this.fed));
      } else {
        this.reset();
        this.feed(input);
      }
      this.source = input;
      this.fed = input.length;
      return Promise.resolve(this.result());
    } catch (err) {
      // A zstd stream cannot be resumed past corruption: drop the position so
      // the next push starts a fresh stream instead of failing forever.
      this.reset();
      return Promise.reject(err);
    }
  }

  /** True when `input` is byte-identical to the accepted prefix, or extends it. */
  private extendsPrevious(input: Uint8Array): boolean {
    if (input.length < this.fed) return false;
    const prev = this.source;
    for (let i = 0; i < this.fed; i++) {
      if (prev[i] !== input[i]) return false;
    }
    return true;
  }

  private feed(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    if (this.stream === null) {
      const Backend = fzstd()?.Decompress;
      // Unreachable through `mobileZstdWasmLoader` (its gate probes the
      // backend first); a direct `createZstdWasmLoader()` caller with the
      // module missing gets an error rather than a silent no-op.
      if (Backend === undefined) throw new Error('fzstd backend unavailable');
      this.stream = new Backend((data: Uint8Array) => {
        // `final` is always false: the gateway never ends the stream, and a
        // truncated block boundary must stay buffered, not error.
        if (data.length === 0) return;
        this.chunks.push(data);
        this.joined = null;
      });
    }
    this.stream.push(chunk, false);
  }

  /** Full decoded prefix of the current stream. */
  private result(): Uint8Array {
    if (this.joined !== null) return this.joined;
    let total = 0;
    for (const chunk of this.chunks) total += chunk.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    this.joined = out;
    return out;
  }

  private reset(): void {
    this.stream = null;
    this.chunks = [];
    this.joined = null;
    this.source = EMPTY;
    this.fed = 0;
  }
}

/**
 * Build a `ZstdWasmLoader` for `GatewayClientOptions.zstdWasmLoader`. The
 * decompressor instance is created once and reused: the inflater calls the
 * loader on every reconnect, and the decoder re-bases itself on the stream it
 * is handed (see the class docs), so reuse is safe and avoids re-allocating
 * window state per connection.
 */
export function createZstdWasmLoader(): ZstdWasmLoader {
  let cached: ZstdWasmDecompressor | null = null;
  return () => {
    cached ??= new FzstdDecompressor();
    return Promise.resolve(cached);
  };
}

/**
 * The app's decode path. `undefined` when the backend is missing, which keeps
 * `zstdWasmLoader` unset and lets `selectCompression` fall back to `none` (or
 * a native codec) rather than negotiating a codec nothing can decode.
 *
 * OFF BY DEFAULT ON DEVICE (2026-09-09). The loader is correct on Node — a
 * probe against the local gateway negotiates `zstd_stream` and reaches `ready`
 * — but on Hermes the session stalls: the client never dispatches `Ready` and
 * the server closes the connection with 4001. Until that is diagnosed, the app
 * negotiates `none` (KD4: zstd is a bandwidth optimization, not correctness).
 * Set `EXPO_PUBLIC_CYTALE_ZSTD=1` to opt back in for testing.
 *
 * The flag is checked BEFORE the availability probe on purpose (LAZY BUNDLE):
 * short-circuit evaluation means the default build never touches `fzstd` — the
 * probe itself is what loads the module.
 */
export const mobileZstdWasmLoader: ZstdWasmLoader | undefined =
  process.env.EXPO_PUBLIC_CYTALE_ZSTD === '1' && zstdDecodeAvailable()
    ? createZstdWasmLoader()
    : undefined;
