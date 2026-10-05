/**
 * U28 slice 2 — scenario tests.
 *
 * 1. A scenario whose subject is not shipped throws the canonical
 *    "subject not shipped yet (<subject>)" error (the gate).
 * 2. The fan_out_latency scenario's measurement logic runs against the fake
 *    gateway (arm-before-broadcast → p50/p99 computed) and passes when the
 *    p99 is within bound.
 * 3. The resume scenario's contiguity check is a pure function: it flags gaps
 *    and duplicates, and passes on a contiguous sequence.
 */

import { describe, expect, it } from 'vitest';
import { GatewayOp, type GatewayEnvelope, type MessageCreate } from '@cytale/protocol';
import type { GatewaySocketLike } from '@cytale/gateway-client';
import { LoadTestHarness } from '../src/harness.js';
import type { RestSeam } from '../src/virtual_client.js';
import { fanOutLatencyScenario } from '../src/scenarios/fan_out_latency.js';
import { firstSequenceGap } from '../src/scenarios/resume.js';
import type { ScenarioContext } from '../src/scenarios/types.js';

// ---------------------------------------------------------------------------
// In-process fake gateway (reuses the slice-1 pattern)
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

function makeHarness(clientCount: number): { harness: LoadTestHarness; gateway: FakeGateway } {
  const gateway = new FakeGateway();
  const channelId = '9007199254740993';
  let messageIdCounter = 0;

  const rest: RestSeam = {
    async sendMessage(_channelId: string, content: string): Promise<string> {
      const messageId = `1000000000000${++messageIdCounter}`;
      gateway.broadcast(channelId, messageId, content);
      return messageId;
    },
  };

  const harness = new LoadTestHarness({
    clientCount,
    url: 'ws://fake/gateway',
    token: 'tok',
    socketFactory: gateway.socketFactory,
    rest,
    channelId,
    receiveTimeoutMs: 2_000,
  });

  return { harness, gateway };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('U28 slice 2 — scenario gate', () => {
  it('throws the canonical "subject not shipped yet" error when the subject is absent', async () => {
    const { harness } = makeHarness(3);
    try {
      await harness.connectAll();
      const ctx: Omit<ScenarioContext, 'harness'> = {
        isShipped: false,
        channelIds: ['9007199254740993'],
        bounds: {},
      };
      await expect(harness.runScenario('fan_out_latency', ctx)).rejects.toThrow(
        'subject not shipped yet (U11 workspace fan-out)',
      );
    } finally {
      harness.destroy();
    }
  });

  it('lists the scenarios by stable name', () => {
    const { harness } = makeHarness(1);
    expect(harness.scenarioNames.sort()).toEqual(
      ['crash_stampede', 'fan_out_latency', 'isolation', 'resume', 'search_freshness', 'voice_load', 'voice_resume', 'voice_video'].sort(),
    );
  });
});

describe('U28 slice 2 — fan_out_latency measurement', () => {
  it('computes p50/p99 from the fake-gateway fan-out round and passes within bound', async () => {
    const { harness } = makeHarness(25);
    try {
      await harness.connectAll();
      const ctx: Omit<ScenarioContext, 'harness'> = {
        isShipped: true,
        channelIds: ['9007199254740993'],
        bounds: { fanOutP99Ms: 1_000 },
      };
      const result = await harness.runScenario('fan_out_latency', ctx);
      expect(result.passed).toBe(true);
      expect(result.metrics.connected).toBe(25);
      expect(result.metrics.received).toBe(25);
      expect(result.metrics.fanOutP50Ms).toBeGreaterThanOrEqual(0);
      expect(result.metrics.fanOutP99Ms).toBeGreaterThanOrEqual(result.metrics.fanOutP50Ms as number);
      expect(result.metrics.fanOutP99Ms).toBeLessThanOrEqual(1_000);
    } finally {
      harness.destroy();
    }
  });

  it('fails when the p99 exceeds the bound', async () => {
    const { harness } = makeHarness(3);
    try {
      await harness.connectAll();
      const ctx: Omit<ScenarioContext, 'harness'> = {
        isShipped: true,
        channelIds: ['9007199254740993'],
        bounds: { fanOutP99Ms: -1 }, // impossible bound → p99 (0) exceeds it → must fail
      };
      const result = await harness.runScenario('fan_out_latency', ctx);
      expect(result.passed).toBe(false);
    } finally {
      harness.destroy();
    }
  });
});

describe('U28 slice 2 — resume contiguity check', () => {
  it('passes on a contiguous sequence', () => {
    expect(firstSequenceGap(['1000000000000001', '1000000000000002', '1000000000000003'])).toBe(-1);
  });

  it('flags a gap', () => {
    expect(firstSequenceGap(['1000000000000001', '1000000000000003'])).toBe(1);
  });

  it('flags a duplicate', () => {
    expect(firstSequenceGap(['1000000000000001', '1000000000000001'])).toBe(1);
  });
});
