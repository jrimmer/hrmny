/**
 * Fake duplex WebSocket harness for gateway-client tests.
 *
 * A single `FakeGatewayServer` instance plays the server: it records frames
 * the "client" sends, can be armed to respond on connect/Identify/Resume/
 * Heartbeat, and lets tests push dispatches/close/error at any moment. The
 * sockets are plain objects (no timers, no network); time is controlled via
 * vi.useFakeTimers().
 */

import {
  GatewayOp,
  type EventName,
  type GatewayEnvelope,
} from '@cytale/protocol';
import type { GatewaySocketLike } from '../types.js';

export interface SentFrameRecord {
  op: number;
  d: unknown;
}

/** Minimal info shape for close notifications. */
export function closeInfo(code = 1006, reason = ''): { code: number; reason: string } {
  return { code, reason };
}

/**
 * A controllable fake socket handed to the client by the factory. The test
 * drives its inbound side (`serverReceive`), tests read outbound traffic via
 * the owning server's `sent` log.
 */
export class FakeSocket implements GatewaySocketLike {
  sent: string[] = [];
  closedCodes: Array<number> = [];
  open = false;

  onopen: (() => void) | null = null;
  onmessage: ((data: unknown) => void) | null = null;
  onclose: ((info: { code: number; reason: string }) => void) | null = null;
  onerror: ((err: { message?: string }) => void) | null = null;

  constructor(
    public readonly url: string,
    private readonly server: FakeGatewayServer,
  ) {}

  send(data: string): void {
    if (!this.open) throw new Error('fake socket send while not open');
    this.sent.push(data);
    this.server.record(this, data);
  }

  close(code?: number, reason?: string): void {
    if (!this.open) return;
    this.open = false;
    this.closedCodes.push(code ?? 1005);
    // Local closes detach handlers before calling close(), so notifying here
    // models a remote party observing the close. Guard against reentry:
    const handler = this.onclose;
    this.onclose = null;
    if (handler) handler({ code: code ?? 1005, reason: reason ?? '' });
  }

  // -- test-side controls ---------------------------------------------------

  /** Client-side opener: marks open and fires onopen. */
  simulateOpen(): void {
    this.open = true;
    this.onopen?.();
  }

  /** Deliver one raw text frame as if received from the network. */
  serverSend(textOrEnvelope: string | GatewayEnvelope): void {
    this.onmessage?.(typeof textOrEnvelope === 'string' ? textOrEnvelope : JSON.stringify(textOrEnvelope));
  }

  /** Server → client BINARY frame (compressed-session shape). */
  emitBinary(bytes: Uint8Array): void {
    const copy = new Uint8Array(bytes);
    this.onmessage?.(copy.buffer);
  }

  /** Remote reset without polite close semantics. */
  simulateError(message = 'boom'): void {
    this.onerror?.({ message });
  }

  /** Simulate the remote (network) side dropping the connection. */
  simulateRemoteClose(info: { code: number; reason: string }): void {
    if (!this.open) return;
    this.open = false;
    this.onclose?.(info);
  }
}

/**
 * Scriptable fake gateway. Construct with an object of optional hooks; each
 * hook receives (socket, frame) and may push frames back synchronously.
 */
export interface FakeGatewayHooks {
  onConnect?(socket: FakeSocket): void;
  onHelloAck?(socket: FakeSocket): void;
  onIdentify?(socket: FakeSocket, frame: SentFrameRecord): void;
  onResume?(socket: FakeSocket, frame: SentFrameRecord): void;
  onHeartbeat?(socket: FakeSocket, frame: unknown): void;
  /** Default behaviour: reply HeartbeatACK for every heartbeat. */
  autoAckHeartbeats?: boolean;
}

export class FakeGatewayServer {
  readonly sockets: Array<FakeSocket> = [];
  readonly sent: Array<{ socket: FakeSocket; op: number; d: unknown }> = [];
  hooks: FakeGatewayHooks = {};

  /** Factory conforming to GatewayClientOptions.socketFactory. */
  readonly socketFactory = (url: string): FakeSocket => {
    const socket = new FakeSocket(url, this);
    this.sockets.push(socket);
    // Auto-open after a microtask (real sockets open asynchronously).
    queueMicrotask(() => {
      if (!socket.open) socket.simulateOpen();
      this.hooks.onConnect?.(socket);
    });
    return socket;
  };

  record(socket: FakeSocket, raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).op !== 'number'
    ) {
      return;
    }
    const frame = parsed as SentFrameRecord;
    this.sent.push({ socket, op: frame.op, d: frame.d });

    switch (frame.op) {
      case GatewayOp.Identify:
        this.hooks.onIdentify?.(socket, frame);
        break;
      case GatewayOp.Resume:
        this.hooks.onResume?.(socket, frame);
        break;
      case GatewayOp.Heartbeat:
        this.hooks.onHeartbeat?.(socket, frame.d);
        break;
      default:
        break;
    }
  }

  /**
   * Server → client Hello with an explicit heartbeat cadence. Compression
   * offer is opt-in (the real server always sends `compression_modes`;
   * legacy tests hand-shake without one, exercising the text path).
   */
  sendHello(socket: FakeSocket, heartbeatIntervalMs: number, compressionModes?: string[]): void {
    const d: Record<string, unknown> = { heartbeat_interval: heartbeatIntervalMs };
    if (compressionModes) d.compression_modes = compressionModes;
    socket.serverSend({ op: GatewayOp.Hello, d } as GatewayEnvelope);
  }

  helloThenReady(
    socket: FakeSocket,
    opts: { heartbeatIntervalMs?: number; sessionId?: string; resumeToken?: string } = {},
  ): void {
    this.sendHello(socket, opts.heartbeatIntervalMs ?? 4000);
    const identifyIndex = this.sent.findIndex((f) => f.op === GatewayOp.Identify);
    if (identifyIndex === -1) return;
    this.sendReady(socket, {
      sessionId: opts.sessionId,
      resumeToken: opts.resumeToken,
    });
  }

  sendReady(
    socket: FakeSocket,
    opts: { sessionId?: string; resumeToken?: string; seq?: number } = {},
  ): void {
    socket.serverSend({
      op: GatewayOp.Dispatch,
      t: 'Ready',
      s: opts.seq ?? 1,
      d: {
        v: 1,
        session_id: opts.sessionId ?? 'sess-1',
        resume_token: opts.resumeToken ?? 'rt-1',
        heartbeat_interval: 4000,
        user: { id: '111', username: 'tester' },
      },
    } as unknown as GatewayEnvelope);
  }

  sendDispatch(socket: FakeSocket, eventName: EventName, seq: number, payload: unknown): void {
    socket.serverSend({
      op: GatewayOp.Dispatch,
      t: eventName,
      s: seq,
      d: payload,
    } as unknown as GatewayEnvelope);
  }

  /** All Identify payloads observed so far (last one is current). */
  lastIdentify(): SentFrameRecord['d'] | null {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const f = this.sent[i]!;
      if (f.op === GatewayOp.Identify) return f.d;
    }
    return null;
  }

  lastResume(): SentFrameRecord['d'] | null {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const f = this.sent[i]!;
      if (f.op === GatewayOp.Resume) return f.d;
    }
    return null;
  }

  opsSentTo(socket: FakeSocket): number[] {
    return this.sent.filter((f) => f.socket === socket).map((f) => f.op);
  }

  /** Count heartbeats sent over a given socket. */
  heartbeatCount(socket: FakeSocket): number {
    return this.sent.filter((f) => f.socket === socket && f.op === GatewayOp.Heartbeat).length;
  }

  reset(): void {
    this.sockets.length = 0;
    this.sent.length = 0;
    this.hooks = {};
  }
}
