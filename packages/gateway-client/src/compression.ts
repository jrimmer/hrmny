/**
 * Stream-compression support for the Cytale gateway client (U15).
 *
 * Primary codec: zstd_stream — decompressed natively via
 * `DecompressionStream('zstd')` where the runtime supports it, otherwise via a
 * runtime-loaded WASM decompressor injected through `options.zstdWasmLoader`
 * (documented runtime-loaded path), with a final embedder hook
 * (`globalThis.__cytaleZstd`). Fallback codec: zlib_stream via native
 * `DecompressionStream('deflate-raw')` — the PAYLOAD codec is RAW DEFLATE
 * (#27), which is why the decoder below says `deflate-raw` and why the
 * capability probe must test the same string. (The compat TRANSPORT stream,
 * `?compress=zlib-stream`, is a zlib-format stream instead; this client never
 * uses it — see docs/protocol/gateway.md.)
 *
 * Both codecs are *stream* formats over gateway frames: encoded bytes append
 * across wire-message boundaries, so the inflater accumulates the full prefix,
 * re-decodes deterministically per message, and emits only the logical JSON
 * payloads completed by the newest chunk (cursor tracked by character offset,
 * which is stable because decoding the same prefix is deterministic).
 *
 * If NO zstd decode path exists in the environment while zstd_stream was
 * negotiated, the inflater degrades to treating bytes as raw UTF-8 rather
 * than dropping the session; callers can observe `degraded` for telemetry.
 */

import type { CompressionMode } from '@cytale/protocol';
import type { ZstdWasmDecompressor, ZstdWasmLoader } from './types.js';

// ---------------------------------------------------------------------------
// Codec naming / selection policy (pure — unit-tested directly)
// ---------------------------------------------------------------------------

/** Identifiers accepted by `options.compression`. */
export const SUPPORTED_COMPRESSION = ['zstd_stream', 'zlib_stream', 'none'] as const;
export type SupportedCompression = (typeof SUPPORTED_COMPRESSION)[number];

/** True iff `v` names a codec this client knows how to request/speak. */
export function isSupportedCompression(v: unknown): v is SupportedCompression {
  return typeof v === 'string' && (SUPPORTED_COMPRESSION as readonly string[]).includes(v);
}

/**
 * Normalise user options into one protocol-legible preference value:
 * undefined ⇒ default `zstd_stream`; anything unrecognised also falls back to
 * the default instead of poisoning the Identify frame with a bad enum.
 */
export function normalizePreferredCompression(
  requested: CompressionMode | 'none' | undefined,
): SupportedCompression {
  if (!isSupportedCompression(requested)) return 'zstd_stream';
  return requested;
}

/**
 * Resolve requested vs offered vs environment capability into exactly one
 * negotiated wire value. Policy:
 * - `none` short-circuits (plain JSON, no compression);
 * - a preferred mode the server did not offer falls back to zlib_stream when
 *   offered-and-decodable, else none (negotiating a codec the server lacks
 *   would stall the handshake mid-flight);
 * - zstd requires a decode path (native stream or injected WASM loader);
 *   without one degrade to zlib when possible, else none;
 * - zlib itself is only chosen when `hasInflate` holds — a PROVEN streaming
 *   inflate backend (`detectStreamingInflate`), not mere constructibility
 *   (#111): an engine that releases inflate output only at close would
 *   negotiate a codec it can never decode from.
 */
export function selectCompression(
  preferred: SupportedCompression,
  serverOffered: readonly CompressionMode[],
  hasNativeZstd: boolean,
  hasZstdLoader: boolean,
  hasInflate: boolean,
): CompressionMode | 'none' {
  if (preferred === 'none') return 'none';

  const offered = new Set<string>(serverOffered);

  if (!offered.has(preferred)) {
    if (offered.has('zlib_stream') && hasInflate) return 'zlib_stream';
    return 'none';
  }

  if (preferred === 'zlib_stream') {
    return hasInflate ? 'zlib_stream' : 'none';
  }

  // Preferred zstd. The ORDER here is a performance decision, not a capability
  // one (hardening plan 2.4): native zstd decodes INCREMENTALLY, while an
  // injected WASM loader can only decompress the whole accumulated stream per
  // frame — quadratic in session length, because the server's zstd stream is a
  // continuation. So a runtime with a streaming inflate backend gets zlib
  // instead of paying that, and the one-shot loader is the last resort (a server
  // that does not offer zlib at all).
  if (hasNativeZstd) return 'zstd_stream';
  if (offered.has('zlib_stream') && hasInflate) return 'zlib_stream';
  if (hasZstdLoader) return 'zstd_stream';
  return 'none';
}

// ---------------------------------------------------------------------------
// Capability detection
// ---------------------------------------------------------------------------

let nativeZstdProbe: boolean | null = null;

/** True iff the runtime's DecompressionStream natively understands 'zstd'. */
export function detectNativeZstd(): boolean {
  if (nativeZstdProbe !== null) return nativeZstdProbe;
  try {
    // Spec behaviour: unsupported format strings make the constructor throw
    // eagerly, so a probe attempt is safe. Cast needed because the DOM type
    // union still omits 'zstd'.
    const Ctor = DecompressionStream as unknown as new (format: string) => DecompressionStream;
    new Ctor('zstd');
    nativeZstdProbe = true;
  } catch {
    nativeZstdProbe = false;
  }
  return nativeZstdProbe;
}

/** True iff a native raw-DEFLATE inflate backend exists (the payload codec). */
export function detectNativeInflate(): boolean {
  if (typeof DecompressionStream === 'undefined') return false;
  try {
    // Probe the format the decoder actually uses ('deflate-raw' — the native
    // payload codec is RAW DEFLATE, #27). Probing 'deflate' tested a
    // different format than the one negotiated from this answer.
    new DecompressionStream('deflate-raw');
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Streaming-inflate capability probe (#111)
// ---------------------------------------------------------------------------

/** Real timers only: probe timeouts must survive fake-timer test suites. */
const probeSetTimeout = globalThis.setTimeout.bind(globalThis) as (
  fn: () => void,
  ms: number,
) => unknown;

/**
 * A hand-crafted RAW-DEFLATE stream whose only member is a stored block
 * carrying "hi", closed by the `00 00 ff ff` Z_SYNC_FLUSH marker — the exact
 * shape the server's sync-flushed encoder puts on the wire (a stream that
 * NEVER finishes, so one-shot inflates reject it with unexpected-EOF).
 * Decoded equivalently by Node's `createInflateRaw` and the browser's
 * DecompressionStream('deflate-raw') — verified in both.
 */
const STREAM_PROBE_SAMPLE = new Uint8Array([
  0x00, 0x02, 0x00, 0xfd, 0xff, 0x68, 0x69, 0x00, 0x00, 0xff, 0xff,
]);

let streamingInflateProbe: Promise<boolean> | null = null;

/**
 * True iff the runtime's DecompressionStream('deflate-raw') RELEASES output
 * while the source stays open — the property the persistent inflater pipe
 * depends on, probed once with a real sync-flushed sample (#111).
 *
 * Constructibility (`detectNativeInflate`) does not imply it: an engine may
 * buffer inflate output until the stream CLOSES, and a gateway stream never
 * closes — every negotiated zlib session on such an engine decodes nothing,
 * silently, with a perfectly healthy socket. Engines proven unable to stream
 * must not be offered zlib_stream; they negotiate 'none' instead.
 *
 * The probe starts on first call and caches its PROMISE (module load, in
 * practice, via the client's negotiation path), so it is settled long before
 * Hello arrives and costs one 11-byte transform.
 */
export function detectStreamingInflate(): Promise<boolean> {
  if (streamingInflateProbe) return streamingInflateProbe;
  streamingInflateProbe = (async () => {
    if (typeof DecompressionStream === 'undefined') return false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      let feed: ((u: Uint8Array) => void) | null = null;
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          feed = (u: Uint8Array) => controller.enqueue(u);
        },
      });
      const ds = new DecompressionStream('deflate-raw');
      reader = source
        .pipeThrough(ds as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)
        .getReader();
      feed!(STREAM_PROBE_SAMPLE);
      // A streaming engine resolves this read from the sample's sync-flush
      // boundary in a few microtasks. An engine that holds output until
      // close never resolves it — the timeout decides against zlib.
      const first = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => probeSetTimeout(() => resolve(null), 250)),
      ]);
      if (first === null || first.done || !first.value) return false;
      return new TextDecoder().decode(first.value).includes('hi');
    } catch {
      return false;
    } finally {
      try {
        reader?.cancel().catch(() => undefined);
      } catch {
        /* probe-only stream */
      }
    }
  })();
  return streamingInflateProbe;
}

// ---------------------------------------------------------------------------
// Byte accumulation across wire messages
// ---------------------------------------------------------------------------

/** Growable byte sink shared by the stream codecs' cursors. */
export class ByteAccumulator {
  private chunks: Array<Uint8Array> = [];
  private _length = 0;

  get length(): number {
    return this._length;
  }

  append(data: Uint8Array): void {
    if (data.length === 0) return;
    this.chunks.push(data);
    this._length += data.length;
  }

  /** Concatenated snapshot of everything appended so far. */
  bytes(): Uint8Array {
    const out = new Uint8Array(this._length);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  /** Drop the first `n` bytes (consumed after successful extraction). */
  dropFront(n: number): void {
    if (n <= 0 || this._length === 0) return;
    let remaining = Math.min(n, this._length);
    this._length -= remaining;
    const kept: Array<Uint8Array> = [];
    for (const c of this.chunks) {
      if (remaining >= c.length) {
        remaining -= c.length;
        continue;
      }
      if (remaining > 0) {
        kept.push(c.slice(remaining));
        remaining = 0;
      } else {
        kept.push(c);
      }
    }
    this.chunks = kept;
  }

  reset(): void {
    this.chunks = [];
    this._length = 0;
  }
}

// ---------------------------------------------------------------------------
// Raw / text helpers
// ---------------------------------------------------------------------------

/** Decode UTF-8 bytes to text, tolerating a leading BOM. */
export function rawBytesToText(data: Uint8Array): string {
  const text = new TextDecoder().decode(data);
  if (text.length > 0 && text.charCodeAt(0) === 0xfeff) return text.slice(1);
  return text;
}

/**
 * A streaming UTF-8 decoder for byte streams whose chunk boundaries are
 * engine-chosen (#111): a multi-byte character split across two output
 * chunks must survive intact. A fresh TextDecoder per chunk (the old
 * collector's shape) turned every split tail into U+FFFD corruption;
 * `{ stream: true }` carries the partial tail into the next chunk instead.
 * Chromium releases DecompressionStream output in ≤64 KiB chunks, so a
 * frame of non-trivial size WILL straddle a boundary mid-character.
 */
export function makeStreamTextDecoder(): { push: (bytes: Uint8Array) => string } {
  const decoder = new TextDecoder();
  return {
    push: (bytes: Uint8Array) => decoder.decode(bytes, { stream: true }),
  };
}

// ---------------------------------------------------------------------------
// Loose zstd module discovery (embedder/test hook: globalThis.__cytaleZstd)
// ---------------------------------------------------------------------------

type LooseRecord = Record<string, unknown>;

const asDecompressor = (fn: unknown): ZstdWasmDecompressor | null =>
  typeof fn === 'function'
    ? { decompress: (input: Uint8Array) => Promise.resolve((fn as (b: Uint8Array) => Uint8Array)(input)) }
    : null;

/**
 * Discover a usable zstd decompressor from `globalThis.__cytaleZstd`,
 * tolerating the usual bundler module shapes (`{decompress}`,
 * `{default:{decompress}}`, CJS interop where exports IS the function).
 * Returns null when nothing usable is present.
 */
export function resolveLooseZstd(): ZstdWasmDecompressor | null {
  const holder = (globalThis as unknown as LooseRecord)['__cytaleZstd'] as unknown;

  if (holder && typeof holder === 'object') {
    const rec = holder as LooseRecord;
    const direct = asDecompressor(rec['decompress']);
    if (direct) return direct;

    const mod = rec['default'];
    if (mod && typeof mod === 'object') {
      const inner = asDecompressor((mod as LooseRecord)['decompress']);
      if (inner) return inner;
    }
  }

  // CJS interop: the hook itself is the decompress function.
  return asDecompressor(holder);
}

// ---------------------------------------------------------------------------
// Native DecompressionStream plumbing
// ---------------------------------------------------------------------------

async function pumpIntoChunks(
  stream: ReadableStream<Uint8Array>,
  sink: Array<Uint8Array>,
): Promise<void> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      sink.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
}

function joinChunks(chunks: Array<Uint8Array>): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const joined = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    joined.set(c, off);
    off += c.length;
  }
  return joined;
}

/**
 * Inflate the FULL supplied byte sequence with a fresh native decompressor.
 * Re-processing the accumulated prefix per wire message keeps the cursor
 * deterministic (see module docs); cost is acceptable for replay/lifecycle
 * traffic and stays swappable behind the inflater interface.
 */
async function nativeInflate(format: string, input: Uint8Array): Promise<Uint8Array> {
  const Ctor = DecompressionStream as unknown as new (format: string) => DecompressionStream;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(input);
      controller.close();
    },
  });
  const chunks: Array<Uint8Array> = [];
  const ds = new Ctor(format);
  await pumpIntoChunks(
    source.pipeThrough(ds as unknown as ReadableWritablePair<Uint8Array, Uint8Array>),
    chunks,
  );
  return joinChunks(chunks);
}

// ---------------------------------------------------------------------------
// Logical-frame scanning (codec-agnostic)
// ---------------------------------------------------------------------------

/** Character-index span `[start,end)` of one top-level JSON object. */
interface JsonSpan {
  start: number;
  end: number;
}

/**
 * Scan text for balanced top-level `{...}` objects, honouring JSON strings and
 * escapes, validating each candidate with JSON.parse. Junk between frames
 * outside braces is ignored; unterminated trailing content (partial tail
 * bytes mirrored back) must be absent by the time callers extract payloads —
 * here it simply yields fewer spans.
 */
export function scanJsonObjectSpans(text: string): Array<JsonSpan> {
  const spans: Array<JsonSpan> = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          JSON.parse(text.slice(start, i + 1)); // validate before recording
          spans.push({ start, end: i + 1 });
          start = -1;
        }
      }
    }
  }
  return spans;
}

// ---------------------------------------------------------------------------
// Gateway inflater (per-connection object)
// ---------------------------------------------------------------------------

/** A negotiated-codec payload inflater over concatenated wire messages. */
export interface GatewayInflater {
  readonly codec: CompressionMode | 'none';
  /**
   * True when zstd_stream was negotiated but no decode path exists and the
   * inflater fell back to treating bytes as raw UTF-8 (telemetry signal).
   */
  readonly degraded: boolean;
  /**
   * Feed one wire message's bytes; returns the logical JSON texts completed
   * by THIS message (previously completed payloads are never re-emitted).
   */
  push(data: Uint8Array): Promise<Array<string>>;
  /**
   * Sink-mode delivery (zlib): when installed, decoded spans are delivered
   * HERE the moment the standing collector releases them, and push()
   * resolves on write, returning nothing — delivery must never depend on
   * read/write pairing (#26). Codecs without a collector ignore this.
   */
  setSink?(sink: (text: string) => void): void;
  /**
   * Collector failure hook (#26): the standing reader rejected — a deflate
   * stream cannot be resumed mid-way, so the pipe is dead. The client uses
   * this to tear down and reconnect rather than draining into silence.
   */
  setOnError?(onError: (reason: unknown) => void): void;
  /** Release pipe resources (idempotent). */
  dispose?(): void;
}

class StreamInflater implements GatewayInflater {
  readonly degraded: boolean;
  private readonly acc = new ByteAccumulator();
  private processedChars = 0;
  private zstd: ZstdWasmDecompressor | null | undefined;
  /**
   * Persistent streaming pipe, shared by both stream codecs. The server
   * compresses with a STREAMING encoder (sync-flushed per frame — never a
   * finished stream), so one-shot inflate calls fail with unexpected-EOF;
   * decoded text emerges at flush boundaries instead.
   *
   * The pipe is what keeps the cost per wire message proportional to THAT
   * message (hardening plan 2.4): `zlib_stream` always had it, and
   * `zstd_stream` — the DEFAULT preferred codec — used to decompress the whole
   * accumulated stream and re-scan the whole decoded text on every frame, which
   * is quadratic in session length. Native `DecompressionStream('zstd')` is
   * exactly the streaming backend that closes that gap; without one (an
   * injected one-shot WASM loader) the fallback below still accumulates, and
   * `selectCompression` prefers a codec that CAN stream.
   */
  private streamPipe: DecompressPipe | null = null;
  /** Sink-mode delivery: spans pushed here the instant they decode. */
  private streamSink: ((text: string) => void) | null = null;
  /** Collector failure hook (see setOnError). */
  private streamOnError: ((reason: unknown) => void) | null = null;
  /** Set when dispose() ran — a following read rejection is expected. */
  private disposed = false;
  /** Trailing partial-JSON text not yet completed (trimmed after each emit). */
  private streamPendingText = '';
  /**
   * Streaming UTF-8 decoder for the collector (#111): DecompressionStream
   * output chunk boundaries are engine-chosen and split multi-byte
   * characters; `{ stream: true }` carries the partial tail across chunks.
   */
  private readonly streamDecoder = makeStreamTextDecoder();

  constructor(
    readonly codec: CompressionMode | 'none',
    private readonly loader?: ZstdWasmLoader,
    /**
     * Test/host hook: the streaming decoder factory the zstd pipe is built
     * with. Defaults to the runtime's `DecompressionStream`. Present so the
     * pipe can be exercised deterministically without a native zstd engine.
     */
    private readonly zstdStreamFactory?: () => DecompressPipe,
  ) {
    this.degraded =
      codec === 'zstd_stream' && !this.streamsZstd() && !loader && !resolveLooseZstd();
  }

  /** Can this codec decode INCREMENTALLY (one pass per wire message)? */
  private streamsZstd(): boolean {
    return this.zstdStreamFactory !== undefined || detectNativeZstd();
  }

  /** `streamsZstd/0` for the factory (the constructor's decision, not re-probed). */
  streamsZstdForTest(): boolean {
    return this.streamsZstd();
  }

  setSink(sink: (text: string) => void): void {
    this.streamSink = sink;
  }

  setOnError(onError: (reason: unknown) => void): void {
    this.streamOnError = onError;
  }

  dispose(): void {
    this.disposed = true;
    this.streamPipe?.reader.cancel().catch(() => undefined);
    this.streamPipe = null;
    this.streamSink = null;
  }

  async push(data: Uint8Array): Promise<Array<string>> {
    // Stream codecs with a streaming backend: feed the standing pipe and return
    // nothing — the collector delivers via the sink the moment the decoder
    // releases bytes, never on this call's timing (pairing a read with this
    // write jams on coalesced or split chunk boundaries and strands every later
    // dispatch, #26). `data` is never retained.
    if (this.codec === 'zlib_stream' || (this.codec === 'zstd_stream' && this.streamsZstd())) {
      await this.streamWrite(data);
      return [];
    }

    switch (this.codec) {
      case 'zstd_stream': {
        // One-shot fallback: the only backend is an injected WASM decompressor,
        // and the server's zstd stream is a CONTINUATION — a later frame can
        // reference earlier bytes — so the whole compressed history is retained
        // and decoded again per frame. `selectCompression` prefers streaming
        // codecs; this path exists for a forced zstd preference.
        this.acc.append(data);
        const impl = await this.resolveZstd();
        // No decode path: treat bytes as raw UTF-8 (documented degrade).
        const plainText = impl
          ? rawBytesToText(await impl.decompress(this.acc.bytes()))
          : rawBytesToText(this.acc.bytes());
        return this.finishSpans(plainText);
      }
      case 'none': {
        // Uncompressed frames are self-contained: decode THIS message only, and
        // scan it whole (the shared cursor belongs to the accumulated-text
        // path, where offsets grow monotonically).
        const text = rawBytesToText(data);
        return scanJsonObjectSpans(text).map((span) => text.slice(span.start, span.end));
      }
      default:
        // `zlib_stream` was handled by the streaming branch above.
        return [];
    }
  }

  /**
   * Extract the spans this frame ADDED from `plainText`, scanning only the
   * suffix past the last emitted character. The old shape re-walked and
   * re-`JSON.parse`d every span ever seen on every frame (quadratic in session
   * length); a fresh scan starts at the previous boundary, so a span that
   * straddles frames cannot be re-validated from scratch — it is re-scanned
   * whole, which is what keeps a fragmented tail correct.
   */
  private finishSpans(plainText: string): Array<string> {
    const from = this.processedChars;
    const out: Array<string> = [];
    if (plainText.length <= from) return out;

    for (const span of scanJsonObjectSpans(plainText.slice(from))) {
      const start = span.start + from;
      const end = span.end + from;
      if (end > this.processedChars) {
        out.push(plainText.slice(start, end));
        this.processedChars = end;
      }
    }
    return out;
  }

  /**
   * Persistent streaming pipe for the negotiated codec. The server compresses
   * with a streaming encoder (sync-flushed per frame — never a finished
   * stream), so one-shot inflate calls fail with unexpected-EOF; decoded text
   * emerges at flush boundaries. The standing collector below turns each
   * release into immediate sink delivery, carrying trailing partial JSON across
   * chunks, and NOTHING it decodes is retained.
   */
  private streamWrite(chunk: Uint8Array): Promise<void> {
    // A disposed inflater must never resurrect a pipe: late pending-flush
    // pushes after detach would enqueue onto a cancelled controller (bare
    // TypeError) or strand bytes in a zombie collector (#26).
    if (this.disposed) return Promise.resolve();

    if (!this.streamPipe) {
      this.streamPipe =
        this.codec === 'zstd_stream'
          ? (this.zstdStreamFactory ?? nativeZstdPipe)()
          : nativeDeflatePipe();

      void (async () => {
        try {
          for (;;) {
            const { done, value } = await this.streamPipe!.reader.read();
            if (done) return;
            if (!value) continue;
            this.streamPendingText += this.streamDecoder.push(value);
            const spans = scanJsonObjectSpans(this.streamPendingText);
            let emittedTo = 0;
            for (const span of spans) {
              if (this.streamSink) this.streamSink(this.streamPendingText.slice(span.start, span.end));
              emittedTo = span.end;
            }
            if (emittedTo > 0) {
              this.streamPendingText = this.streamPendingText.slice(emittedTo);
            }
            // Guard: a pathological no-newline partial cannot grow unbounded
            // past a sane frame budget.
            if (this.streamPendingText.length > 1 << 20) this.streamPendingText = '';
          }
        } catch (err) {
          // Expected on dispose(); anything else is a dead pipe — a compressed
          // stream cannot resume mid-way. Surface it so the client can
          // reconnect instead of draining into silence (#26).
          if (!this.disposed) this.streamOnError?.(err);
        }
      })();
    }

    const view = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    return this.streamPipe!.writer.write(view).then(() => undefined);
  }

  /** Resolve (and memoise) whichever zstd backend this environment offers. */
  private async resolveZstd(): Promise<ZstdWasmDecompressor | null> {
    if (this.zstd !== undefined) return this.zstd;

    if (this.loader) {
      const instance = await this.loader(); // caches on repeat calls
      this.zstd = instance;
      return instance;
    }
    if (detectNativeZstd()) {
      this.zstd = {
        decompress: (input) => nativeInflate('zstd', input),
      };
      return this.zstd;
    }
    const loose = resolveLooseZstd();
    if (loose) {
      this.zstd = loose;
      return loose;
    }
    this.zstd = null;
    return null;
  }
}

/**
 * A `DecompressionStream` fed by a hand-held writer, with its reader taken — the
 * shape both streaming codecs' pipes need. Raw DEFLATE for the zlib codec, zstd
 * for the preferred one; both release output at the encoder's flush boundaries.
 */
type DecompressPipe = {
  writer: { write(u: Uint8Array): Promise<void> };
  reader: ReadableStreamDefaultReader<Uint8Array>;
};

function pipeThroughDecompressor(
  ds: DecompressionStream,
): DecompressPipe {
  let feed: ((u: Uint8Array) => void) | null = null;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      feed = (u: Uint8Array) => controller.enqueue(u);
    },
  });
  const reader = source
    .pipeThrough(ds as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)
    .getReader();

  return {
    writer: {
      write: (u: Uint8Array) => {
        feed!(u);
        return Promise.resolve();
      },
    },
    reader,
  };
}

/** The native raw-DEFLATE pipe (the `zlib_stream` codec). */
function nativeDeflatePipe(): DecompressPipe {
  return pipeThroughDecompressor(new DecompressionStream('deflate-raw' as CompressionFormat));
}

/** The native zstd pipe (hardening plan 2.4: `zstd_stream` without the quadratic re-decode). */
function nativeZstdPipe(): DecompressPipe {
  const Ctor = DecompressionStream as unknown as new (format: string) => DecompressionStream;
  return pipeThroughDecompressor(new Ctor('zstd'));
}

/**
 * Build the inflater for a negotiated codec. Async because first zstd use may
 * require loading the WASM decompressor; construction-time failures (loader
 * rejecting) surface here, loudly, rather than corrupting the session later.
 */
export async function makeGatewayInflater(
  codec: CompressionMode | 'none',
  options: {
    zstdWasmLoader?: ZstdWasmLoader;
    /** Test/host hook: see `StreamInflater`'s constructor. */
    zstdStreamFactory?: () => DecompressPipe;
  } = {},
): Promise<GatewayInflater> {
  const inflater = new StreamInflater(codec, options.zstdWasmLoader, options.zstdStreamFactory);
  if (codec === 'zstd_stream' && !inflater.streamsZstdForTest()) {
    // Force backend resolution now (loader errors throw from connect()).
    await (inflater as StreamInflater)['push'].call(inflater, new Uint8Array(0)).catch(() => {
      /* empty-input resolution failures surface on first real push */
    });
  }
  return inflater;
}

// Warm the capability probe at import so it is settled long before the
// negotiation reads it (Hello always arrives at least one network round-trip
// after import; the first call also lazily starts it, so this is purely an
// optimization — no stream is kept alive beyond the probe's own cancel).
void detectStreamingInflate();
