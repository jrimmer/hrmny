/**
 * U28 slice 1 — harness test.
 *
 * Runs a small fan-out round (25 virtual clients) against an in-process fake
 * gateway that reuses the fake-gateway pattern from
 * packages/gateway-client/src/__tests__/fake-gateway.ts: plain-object sockets,
 * no network, no timers. The REST seam is a fake that, on sendMessage,
 * triggers the fake gateway to broadcast MESSAGE_CREATE to every connected
 * socket — so the harness's arm-before-broadcast round is exercised end to
 * end with the real @cytale/gateway-client.
 */

import { describe, expect, it } from 'vitest';
import { GatewayOp, type GatewayEnvelope, type MessageCreate } from '@cytale/protocol';
import type { GatewaySocketLike } from '@cytale/gateway-client';
import { LoadTestHarness } from '../src/harness.js';
import type { RestSeam } from '../src/virtual_client.js';

// ---------------------------------------------------------------------------
// In-process fake gateway (reuses the fake-gateway pattern)
// ---------------------------------------------------------------------------

class FakeSocket implements GatewaySocketLike {
  open = false;
  onopen: (() => void) | null = null;
  onmessage: ((data: unknown) => void) | null = null;
  onclose: ((info: { code: number; reason: string }) => void) | null = null;
  onerror: ((err: { message?: string }) => void) | null = null;

  constructor(
    public readonly url: string,
    private readonly server: FakeGateway,
  ) {}

  send(data: string): void {
    if (!this.open) throw new Error('fake socket send while not open');
    this.server.record(this, data);
  }

  close(code?: number, reason?: string): void {
    if (!this.open) return;
    this.open = false;
    this.onclose?.({ code: code ?? 1005, reason: reason ?? '' });
  }

  simulateOpen(): void {
    this.open = true;
    this.onopen?.();
  }

  serverSend(envelope: GatewayEnvelope): void {
    this.onmessage?.(JSON.stringify(envelope));
  }
}

class FakeGateway {
  readonly sockets: FakeSocket[] = [];
  private nextSeq = 1;

  readonly socketFactory = (url: string): FakeSocket => {
    const socket = new FakeSocket(url, this);
    this.sockets.push(socket);
    queueMicrotask(() => {
      if (!socket.open) socket.simulateOpen();
      // Hello → client Identifies → Ready.
      socket.serverSend({ op: GatewayOp.Hello, d: { heartbeat_interval: 60_000 } } as GatewayEnvelope);
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
    const frame = parsed as { op: number; d: unknown };
    if (frame.op === GatewayOp.Identify) {
      socket.serverSend({
        op: GatewayOp.Dispatch,
        t: 'Ready',
        s: this.nextSeq++,
        d: {
          v: 1,
          session_id: 'sess-' + this.sockets.indexOf(socket),
          resume_token: 'rt',
          heartbeat_interval: 60_000,
          user: { id: '111', username: 'tester' },
        },
      } as unknown as GatewayEnvelope);
    }
  }

  /** Broadcast a MESSAGE_CREATE to every connected socket. */
  broadcast(channelId: string, messageId: string, content: string): void {
    const payload: MessageCreate = {
      id: messageId,
      channel_id: channelId,
      thread_id: null,
      author_id: '222',
      content,
      created_at: new Date().toISOString(),
      edited_at: null,
    };
    for (const socket of this.sockets) {
      if (socket.open) {
        socket.serverSend({
          op: GatewayOp.Dispatch,
          t: 'MessageCreate',
          s: this.nextSeq++,
          d: payload,
        } as unknown as GatewayEnvelope);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('LoadTestHarness (U28 slice 1)', () => {
  it('spins up N clients, runs a fan-out round, and produces a report', async () => {
    const gateway = new FakeGateway();
    const channelId = '9007199254740993';
    let messageIdCounter = 0;

    // REST seam: on send, broadcast to all connected sockets.
    const rest: RestSeam = {
      async sendMessage(_channelId: string, content: string): Promise<string> {
        const messageId = `1000000000000${++messageIdCounter}`;
        gateway.broadcast(channelId, messageId, content);
        return messageId;
      },
    };

    const harness = new LoadTestHarness({
      clientCount: 25,
      url: 'ws://fake/gateway',
      token: 'tok',
      socketFactory: gateway.socketFactory,
      rest,
      channelId,
      receiveTimeoutMs: 2_000,
    });

    try {
      await harness.connectAll();
      expect(harness.connectedCount).toBe(25);

      const round = await harness.runFanOutRound();
      expect(round.receivedCount).toBe(25);
      expect(round.fanOutLatencies).toHaveLength(25);
      // All latencies are non-negative.
      for (const lat of round.fanOutLatencies) expect(lat).toBeGreaterThanOrEqual(0);

      const report = harness.buildReport(round, 100);
      expect(report.connectionsSustained).toBe(25);
      expect(report.latency.p50).toBeGreaterThanOrEqual(0);
      expect(report.latency.p99).toBeGreaterThanOrEqual(report.latency.p50);
      expect(report.fanOutMs.p50).toBeGreaterThanOrEqual(0);
      expect(report.isolationAssertion).toBe('pending');
      expect(report.resumeSuccessRate).toBe(0);
    } finally {
      harness.destroy();
    }
  });

  it('reports fewer received when a client is not connected', async () => {
    const gateway = new FakeGateway();
    const channelId = '9007199254740994';
    let messageIdCounter = 0;

    const rest: RestSeam = {
      async sendMessage(_channelId: string, content: string): Promise<string> {
        const messageId = `2000000000000${++messageIdCounter}`;
        gateway.broadcast(channelId, messageId, content);
        return messageId;
      },
    };

    const harness = new LoadTestHarness({
      clientCount: 3,
      url: 'ws://fake/gateway',
      token: 'tok',
      socketFactory: gateway.socketFactory,
      rest,
      channelId,
      receiveTimeoutMs: 200,
    });

    try {
      await harness.connectAll();
      // Disconnect one client before the round; it should not receive.
      harness.disconnectClient(1);

      const round = await harness.runFanOutRound();
      expect(round.receivedCount).toBe(2);
    } finally {
      harness.destroy();
    }
  });
});
