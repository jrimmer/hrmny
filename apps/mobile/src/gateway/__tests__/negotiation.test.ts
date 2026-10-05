/**
 * Codec negotiation through the app's gateway factory (plan 004 M11, KD4).
 *
 * Hermes ships no `DecompressionStream`, so `detectNativeZstd()` is false on
 * device. These tests emulate that by removing the global — the jest-expo
 * environment runs on Node, whose native zstd would otherwise mask the loader
 * path entirely — and then assert the negotiated wire codec through the real
 * `createTrackedGatewayClient` the SessionProvider hands the session manager.
 */
import type { GatewaySocketLike } from '@cytale/gateway-client';
import { GatewayOp } from '@cytale/protocol';

import { createTrackedGatewayClient } from '../../navigation/session';
import { createZstdWasmLoader } from '../zstd';

// Hermes emulation (see the diagnostics probe: DecompressionStream MISS).
const originalDecompressionStream = (globalThis as Record<string, unknown>)['DecompressionStream'];
beforeAll(() => {
  (globalThis as Record<string, unknown>)['DecompressionStream'] = undefined;
});
afterAll(() => {
  (globalThis as Record<string, unknown>)['DecompressionStream'] = originalDecompressionStream;
});

/** Dispatch-only flush stream (never terminated), same shape as the gateway's. */
const DISPATCH_STREAM_B64 =
  'KLUv/QBYZAIAogUSF5CnLQaWyzZC6hsRRXMzIxPrGRSb/r9ixzHhrFGKkGCq5lKFdMjqQoLvLXKLdLaHUohvRBs3bsOt27kmFyAHRjUD37uVW6WNAKwAAEAyMnNlY29uZAQAXqgLHAcdd3iwAg==';

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

interface Envelope {
  op: number;
  t?: string;
  s?: number;
  d?: unknown;
}

/** Minimal WebSocket stand-in: records outbound frames, drives inbound ones. */
class FakeSocket implements GatewaySocketLike {
  readonly sent: Array<string> = [];
  binaryType = 'blob';
  open = false;

  onopen: (() => void) | null = null;
  onmessage: ((data: unknown) => void) | null = null;
  onclose: ((info: { code: number; reason: string }) => void) | null = null;
  onerror: ((err: { message?: string }) => void) | null = null;

  send(data: string | ArrayBuffer | Uint8Array): void {
    if (!this.open) throw new Error('fake socket send while not open');
    this.sent.push(typeof data === 'string' ? data : '<binary>');
  }

  close(): void {
    this.open = false;
  }

  /** Server → client text frame. */
  deliver(envelope: Envelope): void {
    this.onmessage?.(JSON.stringify(envelope));
  }

  /** Server → client binary frame (compressed-session shape, RN ArrayBuffer). */
  deliverBinary(bytes: Uint8Array): void {
    const copy = new Uint8Array(bytes);
    this.onmessage?.(copy.buffer);
  }

  frames(): Array<Envelope> {
    return this.sent
      .map((raw) => {
        try {
          return JSON.parse(raw) as Envelope;
        } catch {
          return null;
        }
      })
      .filter((frame): frame is Envelope => frame !== null);
  }

  identify(): Envelope | undefined {
    return this.frames().find((frame) => frame.op === GatewayOp.Identify);
  }
}

interface Harness {
  client: ReturnType<typeof createTrackedGatewayClient>;
  socket: FakeSocket;
}

function makeHarness(
  deps?: Parameters<typeof createTrackedGatewayClient>[1],
): Harness {
  const sockets: Array<FakeSocket> = [];
  const client = createTrackedGatewayClient(
    {
      url: 'ws://fake/gateway',
      tokenProvider: () => 'token',
      socketFactory: (): GatewaySocketLike => {
        const socket = new FakeSocket();
        sockets.push(socket);
        // Real sockets open asynchronously; the client awaits onopen.
        queueMicrotask(() => {
          socket.open = true;
          socket.onopen?.();
        });
        return socket;
      },
    },
    deps,
  );
  void client.connect().catch(() => undefined);
  const socket = sockets[0];
  if (!socket) throw new Error('socket factory never ran');
  return { client, socket };
}

/** Let queued microtasks (open → Identify → inflater setup) settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function hello(socket: FakeSocket, heartbeatIntervalMs = 30_000): void {
  socket.deliver({
    op: GatewayOp.Hello,
    d: {
      heartbeat_interval: heartbeatIntervalMs,
      compression_modes: ['zstd_stream', 'zlib_stream'],
    },
  });
}

function ready(socket: FakeSocket): void {
  socket.deliver({
    op: GatewayOp.Dispatch,
    t: 'Ready',
    s: 0,
    d: { v: 1, session_id: 'sess-1', resume_token: 'rt-1', user: { id: '111', username: 'tester' } },
  });
}

describe('gateway codec negotiation (KD4)', () => {
  it('negotiates zstd_stream with the app’s fzstd loader and advertises it in Identify', async () => {
    // The app default is OFF on device until the Hermes decode issue is fixed
    // (see zstd.ts), so the loader is injected explicitly here.
    const { client, socket } = makeHarness({ zstdLoader: createZstdWasmLoader() });
    await settle();

    hello(socket);
    await settle();

    expect(client.compressionCodec).toBe('zstd_stream');
    expect(socket.identify()?.d).toMatchObject({ compress: 'zstd_stream' });
    client.destroy();
  });

  it('negotiates none without a decode path, keeping the socket usable', async () => {
    // Hermes emulation must actually be in force, or the assertion is vacuous.
    expect(typeof DecompressionStream).toBe('undefined');

    const { client, socket } = makeHarness({ zstdLoader: undefined });
    await settle();

    const dispatches: Array<string> = [];
    client.on('MessageCreate', (payload) => dispatches.push(payload.id));

    hello(socket);
    await settle();
    ready(socket);
    await settle();

    expect(client.compressionCodec).toBe('none');
    expect(socket.identify()?.d).toMatchObject({ compress: null });
    expect(client.connectionState).toBe('ready');

    // Plain-text frames still land — the fallback session is fully functional.
    socket.deliver({
      op: GatewayOp.Dispatch,
      t: 'MessageCreate',
      s: 1,
      d: { id: '1', channel_id: '2', content: 'uncompressed' },
    });
    await settle();
    expect(dispatches).toEqual(['1']);
    client.destroy();
  });

  it('decodes a fragmented zstd stream end to end through the real factory', async () => {
    const { client, socket } = makeHarness({ zstdLoader: createZstdWasmLoader() });
    await settle();

    const dispatches: Array<string> = [];
    client.on('MessageCreate', (payload) => dispatches.push(payload.id));

    hello(socket);
    await settle();
    ready(socket);
    await settle();
    expect(client.compressionCodec).toBe('zstd_stream');

    const stream = fromBase64(DISPATCH_STREAM_B64);
    // Split mid-block: the decoder must buffer the partial tail, not error.
    const cuts = [17, 61, stream.length];
    let offset = 0;
    for (const cut of cuts) {
      socket.deliverBinary(stream.subarray(offset, cut));
      offset = cut;
      await settle();
    }

    expect(dispatches).toEqual(['9001', '9002']);
    expect(client.getTelemetry().malformed_frames_total).toBe(0);
    client.destroy();
  });

  it('contains a failing loader: frames are counted malformed, the socket stays live', async () => {
    const { client, socket } = makeHarness({
      zstdLoader: () => Promise.reject(new Error('backend gone')),
    });
    await settle();

    hello(socket, 100);
    await settle();
    ready(socket);
    await settle();
    expect(client.connectionState).toBe('ready');

    // Negotiation already happened on the loader's presence; the failure must
    // not take the connection down — the client keeps heartbeating and can
    // still be torn down cleanly.
    socket.deliverBinary(fromBase64(DISPATCH_STREAM_B64));
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(client.connectionState).toBe('ready');
    expect(client.getTelemetry().malformed_frames_total).toBeGreaterThan(0);
    expect(socket.frames().some((frame) => frame.op === GatewayOp.Heartbeat)).toBe(true);
    client.destroy();
  });
});
