/**
 * U15 gateway-client test suite.
 *
 * Covers every spec scenario (happy path, 30-second disconnect + resume with
 * replay, missed heartbeats, InvalidSession(false), zstd/zlib compression)
 * plus supplementary edge cases: sequence-gap detection, typing throttle,
 * MESSAGE_ACK contract, backoff bounds, malformed frame tolerance, state
 * machine transitions, and duplicate suppression across replay overlap.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CALL_SIGNAL_BODY_MAX_BYTES,
  GatewayOp,
  GATEWAY_VERSION,
  type GatewayClientMessageAckPayload,
} from '@cytale/protocol';
import { FakeGatewayServer, FakeSocket, closeInfo } from './fake-gateway.js';

// Under-test imports (targets of this suite).
import {
  EARLY_BINARY_BUFFER_MAX_BYTES,
  GatewayClient,
  GatewayOfflineError,
  MAX_MISSED_HEARTBEATS_DEFAULT,
  TYPING_THROTTLE_MS,
} from '../index.js';
import {
  ByteAccumulator,
  detectNativeInflate,
  detectNativeZstd,
  detectStreamingInflate,
  makeGatewayInflater,
  makeStreamTextDecoder,
  normalizePreferredCompression,
  scanJsonObjectSpans,
  selectCompression,
} from '../compression.js';
import { promisify } from 'node:util';
import { createDeflateRaw, constants as zlibConstants, deflateRaw as zDeflateRaw } from 'node:zlib';

/** Real macrotask hop (MessageChannel) — immune to fake timers. */
function realHop(): Promise<void> {
  return new Promise<void>((resolve) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => {
      port1.close();
      resolve();
    };
    port2.postMessage(0);
  });
}

// Real clock + timers, captured at MODULE LOAD — before beforeEach's
// vi.useFakeTimers() ever swaps the globals — so the deadline polls below
// measure genuine wall time even while fake timers are installed.
const realSetTimeout = globalThis.setTimeout.bind(globalThis) as (
  fn: () => void,
  ms: number,
) => unknown;
const realDateNow = Date.now.bind(Date);

/**
 * Poll `until` until it holds or a REAL-TIME deadline lapses, hopping the
 * event loop each iteration and yielding the CPU with a real 2ms sleep so
 * Node's zlib worker thread can land its completion.
 *
 * Replaces the former fixed hop-count spins (64/200/800 `realHop`s): a hop
 * costs microseconds, so a bounded spin measures a few milliseconds of
 * spinning, not of waiting. The DecompressionStream collector completes on
 * a background thread whose result arrives whenever the OS schedules it —
 * under box load that routinely outlasts the spin, exhausting the loop and
 * failing tests whose delivery was merely slow (the #26 standing flake).
 * The deadline changes only WHEN we stop waiting; every assertion after it
 * runs unchanged, so no check is weakened.
 */
async function drainUntil(until: () => boolean, deadlineMs = 5_000): Promise<void> {
  const start = realDateNow();
  while (!until()) {
    if (realDateNow() - start >= deadlineMs) return;
    await realHop();
    await new Promise<void>((resolve) => realSetTimeout(resolve, 2));
  }
}

// Raw deflate — mirrors the SERVER's zlib-stream encoder (raw,
// sync-flushed; windowBits -15), not the browser's wrapped 'deflate'.
const deflateRaw = promisify(zDeflateRaw) as (buf: string) => Promise<Buffer>;
const deflateAsync = deflateRaw;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function messageCreatePayload(seq: number) {
  return {
    id: `730000000000000${seq}`.padEnd(19, '0'),
    channel_id: '7300000000000000100',
    thread_id: null,
    author_id: '7300000000000000200',
    content: `hello ${seq}`,
    created_at: '2026-08-27T12:00:00.000Z',
    edited_at: null,
  };
}

/** Drive the standard happy-path handshake on the current socket. */
async function handshake(
  server: FakeGatewayServer,
  opts: { sessionId?: string; resumeToken?: string; heartbeatIntervalMs?: number } = {},
): Promise<void> {
  const socket = server.sockets.at(-1)!;
  server.sendHello(socket, opts.heartbeatIntervalMs ?? 4000);
  await vi.advanceTimersByTimeAsync(0); // let identify token promise resolve
  server.sendReady(socket, {
    sessionId: opts.sessionId,
    resumeToken: opts.resumeToken,
  });
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('happy path', () => {
  it('connect → Hello → Identify → READY → steady state → dispatch to subscriber', async () => {
    const server = new FakeGatewayServer();
    // Auto-ACK heartbeats once ready.
    server.hooks.onHeartbeat = (_socket) => {
      const s = server.sockets[0]!;
      s.serverSend({ op: GatewayOp.HeartbeatACK, d: null } as never);
    };

    const states: string[] = [];
    const seen: Array<{ t: string; d: unknown }> = [];
    void seen;

    const client = new GatewayClient({
      url: 'ws://fake/gateway',
      tokenProvider: async () => 'tok',
      socketFactory: server.socketFactory,
      onStateChange: (c) => states.push(c.to),
    });

    const subReceipts: unknown[] = [];
    client.on('MessageCreate', (payload) => {
      subReceipts.push(payload);
    });

    const connPromise = client.connect();
    await vi.runAllTimersAsync();
    await connPromise;

    // Client sends nothing before Hello.
    expect(server.sent).toHaveLength(0);

    // Server Hello arrives; client must Identify with U2 shape.
    server.sendHello(server.sockets[0]!, 4000);
    await vi.advanceTimersByTimeAsync(0);

    const identify = server.lastIdentify();
    expect(identify).toMatchObject({
      token: 'tok',
      v: GATEWAY_VERSION,
      compress: null,
    });
    expect((identify as { properties: unknown }).properties).toBeTruthy();

    // Server issues READY.
    server.sendReady(server.sockets[0]!, { sessionId: 'sess-A', resumeToken: 'rt-A' });
    await vi.advanceTimersByTimeAsync(0);

    expect(client.connectionState).toBe('ready');
    expect(client.getSession()).toEqual({
      sessionId: 'sess-A',
      seq: 0,
      resumeToken: 'rt-A',
    });

    // Steady state: advance one heartbeat interval and count beats sent.
    await vi.advanceTimersByTimeAsync(4000);
    expect(server.heartbeatCount(server.sockets[0]!)).toBe(1);

    // Live dispatch flows to the typed subscriber.
    server.sendDispatch(server.sockets[0]!, 'MessageCreate', 2, messageCreatePayload(2));
    await vi.advanceTimersByTimeAsync(0);

    expect(subReceipts).toHaveLength(1);
    expect((subReceipts[0] as { content: string }).content).toBe('hello 2');
    expect(client.lastSequenceNumber).toBe(2);
    // Heartbeat ACK keeps the state machine in the steady-state set.
    client.destroy();
  });

  it('heartbeat ACK resets the missed counter and emits heartbeat telemetry', async () => {
    const server = new FakeGatewayServer();
    server.hooks.autoAckHeartbeats;
    let acks = 3;
    server.hooks.onHeartbeat = (_s) => {
      if (acks-- > 0) {
        server.sockets[0]!.serverSend({ op: GatewayOp.HeartbeatACK, d: null } as never);
      }
    };

    const client = new GatewayClient({
      url: 'ws://fake/gateway',
      tokenProvider: async () => 'tok',
      socketFactory: server.socketFactory,
    });
    void client.connect().catch(() => {});
    await handshake(server);

    await vi.advanceTimersByTimeAsync(4000 * 4);
    expect(client.diagnostics.missedHeartbeats).toBe(1);
    expect(client.getTelemetry().heartbeats_missed_total).toBeGreaterThanOrEqual(1);
    client.destroy();
  });
});

// ---------------------------------------------------------------------------
// Disconnect / Resume integration
// ---------------------------------------------------------------------------

describe('disconnect → reconnect → Resume → replay', () => {
  it('30s drop resumes from last seq with no duplicates and no full reload', async () => {
    const server = newFakeServer();
    let resentForResume = 0;

    server.hooks.onResume = (socket, frame) => {
      const r = frame.d as { session_id: string; seq: number; resume_token: string };
      expect(r.session_id).toBe('sess-R');
      expect(r.seq).toBe(10);
      expect(r.resume_token).toBe('rt-R');
      // Replay events seq+1.. exactly once each, then Resumed.
      resentForResume++;
      server.sendDispatch(socket, 'MessageCreate', 11, messageCreatePayload(11));
      server.sendDispatch(socket, 'MessageCreate', 12, messageCreatePayload(12));
      socket.serverSend({
        op: GatewayOp.Dispatch,
        t: 'Resumed',
        s: 13,
        d: { replayed_events: 2, heartbeat_interval: 4000 },
      } as never);
    };

    const received: number[] = [];
    const client = new GatewayClient({
      url: 'ws://fake/gateway',
      tokenProvider: async () => 'tok',
      socketFactory: server.socketFactory,
    });
    client.on('MessageCreate', (p) => {
      received.push(p.id.length === 19 ? Number(p.id.slice(15).replace(/0+$/, '')) || 10 : Number(p.id.slice(-2)));
    });

    void client.connect().catch(() => {});
    await handshake(server, { sessionId: 'sess-R', resumeToken: 'rt-R' });

    // Live traffic up to seq 10.
    for (let s = 2; s <= 10; s++) {
      server.sendDispatch(
        server.sockets[0]!,
        'MessageCreate',
        s,
        messageCreatePayload(s),
      );
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(received).toHaveLength(9); // seq 2..10
    expect(client.lastSequenceNumber).toBe(10);

    // -- the 30-second network partition ---------------------------------
    client.forceReconnect('network partition');
    await vi.advanceTimersByTimeAsync(30_000);

    const second = server.sockets[1];
    expect(second).toBeDefined();
    server.sendHello(second!, 4000);
    await vi.advanceTimersByTimeAsync(0);

    // Resume must have been chosen over Identify.
    expect(resentForResume).toBe(1);
    expect(server.opsSentTo(second!)).not.toContain(GatewayOp.Identify);

    const receiptIds = received.join(',');
    // Replay arrives (11, 12) — subscriber sees them exactly once.
    expect(received.filter((n) => n === 11)).toHaveLength(1);
    expect(received.filter((n) => n === 12)).toHaveLength(1);
    void receiptIds;

    expect(client.connectionState).toBe('ready');
    expect(client.lastSequenceNumber).toBe(13);
    expect(client.getTelemetry().resume_successes_total).toBe(1);
    client.destroy();
  });

  it('adopts the fresh resume_token Resumed carries, so a second drop resumes again', async () => {
    const server = newFakeServer();
    const presented: string[] = [];
    let n = 0;

    server.hooks.onResume = (socket, frame) => {
      presented.push((frame.d as { resume_token: string }).resume_token);
      n++;
      socket.serverSend({
        op: GatewayOp.Dispatch,
        t: 'Resumed',
        s: 0,
        d: { replayed_events: 0, heartbeat_interval: 4000, resume_token: `rt-next-${n}` },
      } as never);
    };

    const client = new GatewayClient({
      url: 'ws://fake/gateway',
      tokenProvider: async () => 'tok',
      socketFactory: server.socketFactory,
    });
    void client.connect().catch(() => {});
    await handshake(server, { sessionId: 'sess-T', resumeToken: 'rt-first' });

    for (let drop = 1; drop <= 2; drop++) {
      client.forceReconnect('blip');
      await vi.advanceTimersByTimeAsync(30_000);
      const socket = server.sockets[drop]!;
      server.sendHello(socket, 4000);
      await vi.advanceTimersByTimeAsync(0);
      expect(server.opsSentTo(socket)).not.toContain(GatewayOp.Identify);
    }

    expect(presented).toEqual(['rt-first', 'rt-next-1']);
    expect(client.getSession()?.resumeToken).toBe('rt-next-2');
    client.destroy();
  });
});

// ---------------------------------------------------------------------------
// Missed heartbeats
// ---------------------------------------------------------------------------

describe('missed heartbeats', () => {
  it('kills the connection at 5 consecutive missing ACKs and reconnects with backoff', async () => {
    const server = newFakeServer();
    const client = new GatewayClient({
      url: 'ws://fake/gateway',
      tokenProvider: async () => 'tok',
      socketFactory: server.socketFactory,
      minReconnectDelayMs: 500,
      maxMissedHeartbeats: MAX_MISSED_HEARTBEATS_DEFAULT,
    });
    void client.connect().catch(() => {});
    await handshake(server);

    const firstSocket = server.sockets[0]!;
    // No ACK ever comes. Missed counter reaches the limit at the 6th tick
    // (5 unACKed beats then detection), so advance 6 full intervals.
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(4000);
    }
    expect(firstSocket.closedCodes.length).toBeGreaterThan(0);
    // Teardown reset the miss accounting for the next connection.
    expect(client.diagnostics.missedHeartbeats).toBe(0);

    // Reconnect scheduled within backoff bounds (default max 30s).
    await vi.advanceTimersByTimeAsync(30_000);
    expect(server.sockets.length).toBeGreaterThanOrEqual(2);
    client.destroy();
  });

  it('jitters reconnect delays inside [min, max] bounds', async () => {
    // Direct evaluation through repeated forced scheduling is awkward; probe
    // via a real instance using stubbed rng.
    const rngValues = [0, 0.5, 1, 0.5, 0, 1, 0.25, 0.75];
    let callIdx = 0;
    const server = newFakeServer();
    const delays: Array<number> = [];
    const originalSetTimeout = globalThis.setTimeout;

    const client = new GatewayClient({
      url: 'ws://fake/gateway',
      tokenProvider: async () => 'tok',
      socketFactory: server.socketFactory,
      minReconnectDelayMs: 500,
      maxReconnectDelayMs: 8000,
      jitterRatio: 0.5,
      // Keep the (unrelated) connect-timeout timer out of the captured delay
      // set: it is not a backoff delay.
      connectTimeoutMs: 10,
      rng: () => rngValues[callIdx++ % rngValues.length]!,
    });

    // Intercept backoff computations by watching reconnect timer creation:
    const spy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((fn: (args: void) => void, ms?: number) => {
        delays.push(ms ?? 0);
        return originalSetTimeout(fn, 0);
      });

    // Force several disconnect/reconnect cycles. Each forceReconnect closes
    // the current socket, schedules backoff (captured by the spy), and the
    // immediate-zero timer spawns a fresh socket.
    for (let i = 0; i < 4; i++) {
      client.forceReconnect('probe');
      await vi.advanceTimersByTimeAsync(0);
    }
    spy.mockRestore();

    const reconnectDelays = delays.filter((d) => d >= 250); // ignore microdelays
    expect(reconnectDelays.length).toBeGreaterThanOrEqual(3);
    for (const d of reconnectDelays) {
      expect(d).toBeLessThanOrEqual(8000);
      expect(d).toBeGreaterThanOrEqual(0);
    }
    client.destroy();
  });
});

// ---------------------------------------------------------------------------
// InvalidSession handling
// ---------------------------------------------------------------------------

describe('InvalidSession', () => {
  it('resumable=false re-identifies and reaches a fresh READY', async () => {
    const server = newFakeServer();
    const invalidEvents: boolean[] = [];
    const readySessions: Array<string> = [];
    let firstIdentifySeen = false;

    // Second Identify (post-InvalidSession) gets a fresh READY from the fake
    // server; the first Identify's READY is delivered by handshake() below.
    server.hooks.onIdentify = (socket) => {
      if (!firstIdentifySeen) {
        firstIdentifySeen = true;
        return;
      }
      server.sendReady(socket, { sessionId: 'sess-2', resumeToken: 'rt-2' });
    };

    const client = new GatewayClient({
      url: 'ws://fake/gateway',
      tokenProvider: async () => 'tok',
      socketFactory: server.socketFactory,
      minReconnectDelayMs: 1,
      maxReconnectDelayMs: 5,
      onInvalidSession: (resumable) => invalidEvents.push(resumable),
    });
    client.on('Ready', (p) => readySessions.push(p.session_id));

    void client.connect().catch(() => {});
    await handshake(server, { sessionId: 'sess-1', resumeToken: 'rt-1' });
    expect(readySessions).toEqual(['sess-1']);

    // Server declares the session unrecoverable. In production this reply
    // rides a socket the server is ABOUT TO CLOSE — identifying on it wedges
    // the client (observed post-restart). The contract: drop the socket,
    // reconnect, Identify on the fresh connection.
    server.sockets[0]!.serverSend({ op: GatewayOp.InvalidSession, d: false } as never);
    await vi.advanceTimersByTimeAsync(10);

    expect(invalidEvents).toEqual([false]);
    // Reconnect happened: a second socket exists.
    expect(server.sockets.length).toBe(2);
    // Drive the fresh socket's handshake (the fake does not auto-Hello):
    // Hello → client Identifies (session was reset) → hook READYs sess-2.
    server.sendHello(server.sockets[1]!, 30_000);
    await vi.advanceTimersByTimeAsync(10);
    const identifyCount = server.sent.filter(
      (f) => f.socket === server.sockets[1] && f.op === GatewayOp.Identify,
    ).length;
    expect(identifyCount).toBe(1);
    // New session material replaced the dead one.
    expect(client.getSession()).toEqual({ sessionId: 'sess-2', seq: 0, resumeToken: 'rt-2' });
    expect(readySessions).toEqual(['sess-1', 'sess-2']);
    expect(client.connectionState).toBe('ready');
    client.destroy();
  });
});

// ---------------------------------------------------------------------------
// Sequence-gap detection
// ---------------------------------------------------------------------------

describe('sequence gaps', () => {
  it('detects a hole, bumps resume_gap_total, invokes onResumeGap, resyncs session', async () => {
    const server = newFakeServer();
    const gaps: Array<{ expectedSeq: number; receivedSeq: number }> = [];
    const client = new GatewayClient({
      url: 'ws://fake/gateway',
      tokenProvider: async () => 'tok',
      socketFactory: server.socketFactory,
      onResumeGap: (g) => gaps.push({ ...g }),
    });

    void client.connect().catch(() => {});
    await handshake(server, { sessionId: 'sess-G', resumeToken: 'rt-G' });

    server.sendDispatch(server.sockets[0]!, 'MessageCreate', 2, messageCreatePayload(2));
    await vi.advanceTimersByTimeAsync(0);

    // Baseline established at seq 2; now a jump to 5 is an unambiguous hole.
    server.sendDispatch(server.sockets[0]!, 'MessageCreate', 5, messageCreatePayload(5));
    server.sendDispatch(server.sockets[0]!, 'MessageCreate', 6, messageCreatePayload(6));
    await vi.advanceTimersByTimeAsync(0);

    expect(gaps).toEqual([{ expectedSeq: 3, receivedSeq: 5 }]);
    expect(client.getTelemetry().resume_gap_total).toBe(1);
    // Full-sync fallback invalidated stored identity rather than continuing.
    expect(client.getSession()).toBeNull();
    client.destroy();
  });

  it('suppresses duplicate seq deliveries during replay overlap', async () => {
    const server = newFakeServer();
    const client = new GatewayClient({
      url: 'ws://fake/gateway',
      tokenProvider: async () => 'tok',
      socketFactory: server.socketFactory,
    });
    const seen: number[] = [];
    client.onAny((event) => {
      // Skip the READY lifecycle dispatch; assertions concern live traffic.
      if (event.t === 'Ready') return;
      seen.push(event.s);
    });

    void client.connect().catch(() => {});
    await handshake(server);

    for (const s of [2, 3, 3, 4, 2]) {
      server.sendDispatch(server.sockets[0]!, 'PresenceUpdate', s, {
        user_id: '1',
        status: 'online',
        last_seen_at: '2026-08-27T12:00:00.000Z',
      });
    }
    await vi.advanceTimersByTimeAsync(0);

    expect(seen).toEqual([2, 3, 4]);
    expect(client.getTelemetry().dispatch_duplicates_dropped_total).toBe(2);
    client.destroy();
  });
});

// ---------------------------------------------------------------------------
// Client → server signals
// ---------------------------------------------------------------------------

describe('typing throttle + message ack', () => {
  it('allows one TYPING_START per throttle window per channel/thread and suppresses bursts', async () => {
    const server = newFakeServer();
    let clockMs = 1_700_000_000_000;
    const client = new GatewayClient({
      url: 'ws://fake/gateway',
      tokenProvider: async () => 'tok',
      socketFactory: server.socketFactory,
      now: () => clockMs,
    });
    void client.connect().catch(() => {});
    await handshake(server);

    const chA = '7300000000000000100';
    const chB = '7300000000000000101';
    const threadT = '7300000000000000900';

    expect(client.sendTyping(chA)).toBe(true);
    expect(client.sendTyping(chA)).toBe(false);
    // Lane D #21: the window is the 5 s emit interval.
    expect(TYPING_THROTTLE_MS).toBe(5_000);
    clockMs += TYPING_THROTTLE_MS - 1;
    expect(client.sendTyping(chA)).toBe(false);
    clockMs += 1;
    expect(client.sendTyping(chA)).toBe(true);

    // Independent windows per channel/thread key.
    expect(client.sendTyping(chB)).toBe(true);
    expect(client.sendTyping(chB, threadT)).toBe(true);

    const typingFrames = server.sent.filter(
      (f) => f.op === GatewayOp.TYPING_START_CLIENT,
    );
    expect(typingFrames).toHaveLength(4);
    expect(typingFrames[3]!.d).toMatchObject({ channel_id: chB, thread_id: threadT });
    client.destroy();
  });

  it('prunes lapsed typing entries so the throttle map cannot grow without bound', async () => {
    const server = newFakeServer();
    let clockMs = 1_700_000_000_000;
    const client = new GatewayClient({
      url: 'ws://fake/gateway',
      tokenProvider: async () => 'tok',
      socketFactory: server.socketFactory,
      now: () => clockMs,
    });
    void client.connect().catch(() => {});
    await handshake(server);

    // Private throttle cache, read through a cast — the suite's internal-probe
    // convention (see compression.test.ts).
    const internals = client as unknown as { typingSentAt: Map<string, number> };

    for (let i = 0; i < 100; i++) {
      expect(client.sendTyping(`7300000000000000${String(i).padStart(3, '0')}`)).toBe(true);
    }
    // Every entry is inside its window: none may be dropped early.
    expect(internals.typingSentAt.size).toBe(100);

    // Advance exactly one throttle window: no recorded entry can suppress a
    // send any more, so the next send prunes them and keeps only its own.
    clockMs += TYPING_THROTTLE_MS;
    expect(client.sendTyping('7300000000000000100')).toBe(true);
    expect(internals.typingSentAt.size).toBe(1);
    client.destroy();
  });

  it('MESSAGE_ACK rides op 21 with the U2 payload intact', async () => {
    const server = newFakeServer();
    const client = new GatewayClient({
      url: 'ws://fake/gateway',
      tokenProvider: async () => 'tok',
      socketFactory: server.socketFactory,
    });
    void client.connect().catch(() => {});
    await vi.advanceTimersByTimeAsync(0); // open the socket before sending

    const ack: GatewayClientMessageAckPayload = {
      channel_id: '7300000000000000100',
      message_ids: ['7300000000000010001', '7300000000000010002'],
    };
    expect(() =>
      client.sendMessageAck({ channel_id: 'nope!!', message_ids: [] }),
    ).toThrow(TypeError);
    client.sendMessageAck(ack);
    const ackFrame = server.sent.find((f) => f.op === GatewayOp.MESSAGE_ACK);
    expect(ackFrame?.d).toEqual(ack);
    client.destroy();
  });
});

// ---------------------------------------------------------------------------
// Call control + signaling (ops 22/23, calls plan U1/U8)
// ---------------------------------------------------------------------------

describe('call state + call signal wrappers', () => {
  it('sendCallState rides op 22 with the payload intact (start/join/leave/state)', async () => {
    const server = newFakeServer();
    const client = new GatewayClient({
      url: 'ws://fake/gateway',
      tokenProvider: async () => 'tok',
      socketFactory: server.socketFactory,
    });
    void client.connect().catch(() => {});
    await handshake(server);

    client.sendCallState({ channel_id: '7300000000000000100', action: 'start', ring: true });
    client.sendCallState({ channel_id: '7300000000000000100', action: 'join' });
    client.sendCallState({ channel_id: '7300000000000000100', action: 'state', mute: true, deafen: true });
    client.sendCallState({ channel_id: '7300000000000000100', action: 'leave' });

    const frames = server.sent.filter((f) => f.op === GatewayOp.CALL_STATE_UPDATE);
    expect(frames).toHaveLength(4);
    expect(frames[0]!.d).toEqual({
      channel_id: '7300000000000000100',
      action: 'start',
      ring: true,
    });
    expect(frames[2]!.d).toEqual({
      channel_id: '7300000000000000100',
      action: 'state',
      mute: true,
      deafen: true,
    });
    client.destroy();
  });

  it('sendCallState rejects malformed channel ids and unknown actions', async () => {
    const server = newFakeServer();
    const client = new GatewayClient({
      url: 'ws://fake/gateway',
      tokenProvider: async () => 'tok',
      socketFactory: server.socketFactory,
    });
    void client.connect().catch(() => {});
    await handshake(server);

    expect(() =>
      client.sendCallState({ channel_id: 'nope!!', action: 'join' }),
    ).toThrow(TypeError);
    expect(() =>
      client.sendCallState({
        channel_id: '7300000000000000100',
        action: 'shout' as never,
      }),
    ).toThrow(TypeError);
    expect(server.sent.filter((f) => f.op === GatewayOp.CALL_STATE_UPDATE)).toHaveLength(0);
    client.destroy();
  });

  it('sendCallSignal rides op 23 with sdp/ice bodies verbatim', async () => {
    const server = newFakeServer();
    const client = new GatewayClient({
      url: 'ws://fake/gateway',
      tokenProvider: async () => 'tok',
      socketFactory: server.socketFactory,
    });
    void client.connect().catch(() => {});
    await handshake(server);

    client.sendCallSignal({
      channel_id: '7300000000000000100',
      kind: 'sdp',
      body: '{"type":"answer","sdp":"v=0…"}',
    });
    client.sendCallSignal({
      channel_id: '7300000000000000100',
      kind: 'ice',
      body: '{"candidate":"candidate:1","sdpMid":"0","sdpMLineIndex":0}',
    });

    const frames = server.sent.filter((f) => f.op === GatewayOp.CALL_SIGNAL);
    expect(frames).toHaveLength(2);
    expect(frames[0]!.d).toEqual({
      channel_id: '7300000000000000100',
      kind: 'sdp',
      body: '{"type":"answer","sdp":"v=0…"}',
    });
    client.destroy();
  });

  it('sendCallSignal pre-sizes the body against the shared cap (bytes, not UTF-16 units)', async () => {
    const server = newFakeServer();
    const client = new GatewayClient({
      url: 'ws://fake/gateway',
      tokenProvider: async () => 'tok',
      socketFactory: server.socketFactory,
    });
    void client.connect().catch(() => {});
    await handshake(server);

    // Exactly at the cap passes; one byte beyond throws (multi-byte chars
    // must count as their UTF-8 byte width).
    const at = 'x'.repeat(CALL_SIGNAL_BODY_MAX_BYTES);
    expect(() =>
      client.sendCallSignal({ channel_id: '7300000000000000100', kind: 'sdp', body: at }),
    ).not.toThrow();
    expect(() =>
      client.sendCallSignal({
        channel_id: '7300000000000000100',
        kind: 'sdp',
        body: at + 'x',
      }),
    ).toThrow(TypeError);
    // 44,000 CJK chars = 132,000 UTF-8 bytes > the V2-raised 128 KiB cap
    // despite .length 44k (VM14: 65,536 → 131,072, calls V2 spike arm b).
    expect(() =>
      client.sendCallSignal({ channel_id: '7300000000000000100', kind: 'ice', body: 'あ'.repeat(44_000) }),
    ).toThrow(TypeError);
    client.destroy();
  });

  it('reuses one module-level TextEncoder instead of constructing one per frame', async () => {
    const server = newFakeServer();
    const client = new GatewayClient({
      url: 'ws://fake/gateway',
      tokenProvider: async () => 'tok',
      socketFactory: server.socketFactory,
    });
    void client.connect().catch(() => {});
    await handshake(server);

    // The shared encoder is built at import time; nothing on the send path may
    // construct another (hardening 7.6: per-frame TextEncoder allocation).
    const constructed = vi.spyOn(globalThis, 'TextEncoder');
    let calls = 0;
    try {
      client.sendCallSignal({ channel_id: '7300000000000000100', kind: 'sdp', body: 'v=0\r\n' });
      client.sendCallSignal({ channel_id: '7300000000000000100', kind: 'ice', body: 'あ'.repeat(10) });
      calls = constructed.mock.calls.length; // read BEFORE mockRestore clears history
    } finally {
      constructed.mockRestore();
    }
    expect(calls).toBe(0);
    client.destroy();
  });

  it('both call ops throw GatewayOfflineError when no socket exists', () => {
    const server = newFakeServer();
    const client = new GatewayClient({
      url: 'ws://fake/gateway',
      tokenProvider: async () => 'tok',
      socketFactory: server.socketFactory,
    });
    // Never connected — no socket.
    expect(() =>
      client.sendCallState({ channel_id: '7300000000000000100', action: 'join' }),
    ).toThrow(GatewayOfflineError);
    expect(() =>
      client.sendCallSignal({ channel_id: '7300000000000000100', kind: 'sdp', body: 'x' }),
    ).toThrow(GatewayOfflineError);
    client.destroy();
  });
});

// ---------------------------------------------------------------------------
// Compression
// ---------------------------------------------------------------------------

describe('compression mode selection (pure logic)', () => {
  it('normalizes option values deterministically', () => {
    expect(normalizePreferredCompression(undefined)).toBe('zstd_stream');
    expect(normalizePreferredCompression('none')).toBe('none');
    expect(normalizePreferredCompression('zlib_stream')).toBe('zlib_stream');
    // Unknown garbage coerces to the safe default instead of poisoning wire.
    expect(normalizePreferredCompression('brotli' as never)).toBe('zstd_stream');
  });

  it('selects codecs per offered/capability matrix', () => {
    // No offers ⇒ none.
    expect(selectCompression('zstd_stream', [], true, true, true)).toBe('none');
    // zstd available + offered ⇒ zstd.
    expect(selectCompression('zstd_stream', ['zstd_stream', 'zlib_stream'], true, false, true)).toBe('zstd_stream');
    // WASM loader counts as a decode path even without native support.
    expect(selectCompression('zstd_stream', ['zstd_stream'], false, true, true)).toBe('zstd_stream');
    // zstd requested+offered but no decode path anywhere ⇒ zlib fallback.
    expect(selectCompression('zstd_stream', ['zstd_stream', 'zlib_stream'], false, false, true)).toBe('zlib_stream');
    // zlib unavailable entirely ⇒ none.
    expect(selectCompression('zstd_stream', ['zstd_stream'], false, false, false)).toBe('none');
    // zlib preferred without inflate capability ⇒ none.
    expect(selectCompression('zlib_stream', ['zlib_stream'], true, false, false)).toBe('none');
    // Preferred not offered ⇒ fall to zlib when decodable.
    expect(selectCompression('zstd_stream', ['zlib_stream'], true, false, true)).toBe('zlib_stream');
    // Explicit none stays none regardless of offers.
    expect(selectCompression('none', ['zstd_stream'], true, true, true)).toBe('none');
  });

  it('probes runtime capabilities honestly', () => {
    // Node 22: native zstd unsupported, deflate supported.
    expect(typeof detectNativeZstd()).toBe('boolean');
    expect(detectNativeInflate()).toBe(true);
  });

  it('#111: Node\'s DecompressionStream PROVES it streams (output without close)', async () => {
    // The probe feeds a hand-crafted sync-flushed raw-deflate stream (the
    // server's exact wire shape — never a finished stream) and requires
    // output to emerge while the source stays open. Node's undici
    // DecompressionStream streams; negotiation may keep zlib_stream here.
    expect(await detectStreamingInflate()).toBe(true);
  });

  it('#111: a hold-until-close engine must negotiate none, not a dead zlib', () => {
    // hasInflate is now the PROVEN-streaming answer, not constructibility:
    // an engine that releases inflate output only at close would decode
    // nothing from a never-closing gateway stream.
    expect(selectCompression('zstd_stream', ['zstd_stream', 'zlib_stream'], false, false, false)).toBe('none');
    expect(selectCompression('zstd_stream', ['zstd_stream', 'zlib_stream'], false, false, true)).toBe('zlib_stream');
    // A zstd-capable engine is unaffected by the zlib probe either way.
    expect(selectCompression('zstd_stream', ['zstd_stream', 'zlib_stream'], true, false, false)).toBe('zstd_stream');
  });

  it('#111: multi-byte characters survive engine-chosen output chunk boundaries', () => {
    // The zlib collector decodes DecompressionStream output chunks whose
    // boundaries land wherever the engine's 64 KiB buffer says — often
    // mid-character. The streaming decoder carries the partial tail;
    // a fresh decoder per chunk (the old shape) corrupted it to U+FFFD.
    const text = 'A斜photo 📸';
    const bytes = new TextEncoder().encode(text);
    for (let cut = 1; cut < bytes.length; cut++) {
      const decoder = makeStreamTextDecoder();
      const joined =
        decoder.push(bytes.subarray(0, cut)) + decoder.push(bytes.subarray(cut));
      expect(joined).toBe(text);
      // And the old per-chunk-decoder shape really did corrupt this cut —
      // the regression this pins could otherwise never reproduce.
      const broken =
        new TextDecoder().decode(bytes.subarray(0, cut)) +
        new TextDecoder().decode(bytes.subarray(cut));
      if (broken !== text) {
        expect(makeStreamTextDecoder, 'the split corrupts only under the old shape').toBeTruthy();
        expect(joined === text && broken !== text).toBe(true);
      }
    }
  });
});

describe('zstd decompression round-trip', () => {
  it('round-trips multi-message streams through the injected WASM path', async () => {
    // Synthesize "zstd" bytes: our loader is the decoder (like real WASM use),
    // which parses the scanJsonPayloads-friendly fixture format.
    const frames = [
      JSON.stringify({ op: 0, t: 'MessageCreate', s: 1, d: { ok: 1 } }),
      JSON.stringify({ op: 11, d: null }),
    ].join('\n');

    const encodeFixture = (text: string): Uint8Array => new TextEncoder().encode(text);
    let calls = 0;
    const loader = async () => ({
      decompress: async (input: Uint8Array) => {
        calls++;
        return input; // passthrough codec standing in for zstd WASM
      },
    });

    const inflater = await makeGatewayInflater('zstd_stream', { zstdWasmLoader: loader });
    expect(inflater.codec).toBe('zstd_stream');
    expect(inflater.degraded).toBe(false);

    // Split into two wire messages cutting mid-frame.
    const all = encodeFixture(frames);
    const cut = Math.floor(all.length / 2);
    const first = await inflater.push(all.subarray(0, cut));
    const second = await inflater.push(all.subarray(cut));
    const payloads = [...first, ...second];

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(payloads).toHaveLength(2);
    expect(JSON.parse(payloads[0]!)).toMatchObject({ t: 'MessageCreate' });
    expect(JSON.parse(payloads[1]!)).toMatchObject({ op: 11 });

    // Degraded detection: no loader, natives lack zstd in Node 22.
    const degradedInflater = await makeGatewayInflater('zstd_stream');
    expect(degradedInflater.degraded).toBe(true);
    void degradedInflater;
  });
});

describe('#26 lifecycle repros (compressed streams across reconnects)', () => {
  it('full client: burst of 30 binary frames through the sink all deliver', async () => {
    const server = newFakeServer();
    const dispatches: string[] = [];
    const client = new GatewayClient({
      url: 'ws://fake/gateway',
      tokenProvider: async () => 'tok',
      socketFactory: server.socketFactory,
      minReconnectDelayMs: 1,
      maxReconnectDelayMs: 5,
    });
    client.onAny((e: any) => dispatches.push(e.t));

    void client.connect().catch(() => {});
    const sock = server.sockets[0]!;
    server.sendHello(sock, 30_000, ['zlib_stream']);
    await vi.advanceTimersByTimeAsync(0);
    server.sendReady(sock, { sessionId: 's1', resumeToken: 'r1' });
    await vi.advanceTimersByTimeAsync(0);

    // Server-side compressed burst: one persistent deflate stream,
    // sync-flushed per frame — coalescing/splitting land as they will.
    const def = createDeflateRaw();
    const frames = Array.from({ length: 30 }, (_, i) =>
      JSON.stringify({ op: 0, t: 'MessageCreate', s: i + 2, d: { n: i } }),
    );
    const wire: Buffer[] = [];
    for (const f of frames) {
      const chunk = await new Promise<Buffer>((resolve) => {
        def.once('data', (b: Buffer) => resolve(b));
        def.write(f, () => def.flush(zlibConstants.Z_SYNC_FLUSH));
      });
      wire.push(chunk);
    }
    // Deliver exactly as the socket would: one binary message per chunk.
    for (const chunk of wire) sock.emitBinary(new Uint8Array(chunk));
    // Drain: the collector releases one chunk per background completion —
    // wait against a real-time deadline (see drainUntil), not a hop count.
    await drainUntil(() => dispatches.filter((t) => t === 'MessageCreate').length >= 30);
    expect(dispatches.filter((t) => t === 'MessageCreate')).toHaveLength(30);
    expect(client.getTelemetry().malformed_frames_total).toBe(0);
    client.destroy();
  });

  it('full client: truncated frame then hard close — reconnect delivers cleanly', async () => {
    const server = newFakeServer();
    const dispatches: string[] = [];
    const client = new GatewayClient({
      url: 'ws://fake/gateway',
      tokenProvider: async () => 'tok',
      socketFactory: server.socketFactory,
      minReconnectDelayMs: 1,
      maxReconnectDelayMs: 5,
    });
    client.onAny((e: any) => dispatches.push(e.t));

    void client.connect().catch(() => {});
    const sock1 = server.sockets[0]!;
    server.sendHello(sock1, 30_000, ['zlib_stream']);
    await vi.advanceTimersByTimeAsync(0);
    server.sendReady(sock1, { sessionId: 's1', resumeToken: 'r1' });
    await vi.advanceTimersByTimeAsync(0);

    // Connection 1: one clean frame + one TRUNCATED chunk (SIGKILL cut it),
    // then the socket dies without a close handshake.
    const def = createDeflateRaw();
    const frame1 = await new Promise<Buffer>((resolve) => {
      def.once('data', (b: Buffer) => resolve(b));
      def.write(JSON.stringify({ op: 0, t: 'MessageCreate', s: 2, d: { a: 1 } }), () =>
        def.flush(zlibConstants.Z_SYNC_FLUSH),
      );
    });
    sock1.emitBinary(new Uint8Array(frame1));
    // Truncated: half of the next frame's bytes.
    const half = await new Promise<Buffer>((resolve) => {
      def.once('data', (b: Buffer) => resolve(b));
      def.write(JSON.stringify({ op: 0, t: 'MessageCreate', s: 3, d: { b: 2 } }), () =>
        def.flush(zlibConstants.Z_SYNC_FLUSH),
      );
    });
    sock1.emitBinary(new Uint8Array(half.subarray(0, Math.floor(half.length / 2))));
    sock1.simulateRemoteClose({ code: 1006, reason: 'SIGKILL' });
    await vi.advanceTimersByTimeAsync(50);

    // Connection 2 (fresh identify — old session unknown to the fake): the
    // new stream's frames must all deliver; none may vanish.
    const sock2 = server.sockets[1] ?? server.sockets[0]!;
    server.sendHello(sock2, 30_000, ['zlib_stream']);
    await vi.advanceTimersByTimeAsync(0);
    server.sendReady(sock2, { sessionId: 's2', resumeToken: 'r2' });
    await vi.advanceTimersByTimeAsync(0);

    const def2 = createDeflateRaw();
    const fresh: Buffer[] = [];
    for (let i = 0; i < 10; i++) {
      const chunk = await new Promise<Buffer>((resolve) => {
        def2.once('data', (b: Buffer) => resolve(b));
        def2.write(JSON.stringify({ op: 0, t: 'PresenceUpdate', s: i + 1, d: { n: i } }), () =>
          def2.flush(zlibConstants.Z_SYNC_FLUSH),
        );
      });
      fresh.push(chunk);
    }
    for (const chunk of fresh) sock2.emitBinary(new Uint8Array(chunk));
    await drainUntil(() => dispatches.filter((t) => t === 'PresenceUpdate').length >= 10);

    const presence = dispatches.filter((t) => t === 'PresenceUpdate');
    expect(presence).toHaveLength(10);
    client.destroy();
  });
});

describe('inflater race (binary frames beat async inflater setup)', () => {
  it('buffers binary frames until the inflater resolves, then delivers them', async () => {
    const server = newFakeServer();
    const dispatches: string[] = [];

    // A loader whose promise WE resolve: the client's inflater stays pending
    // while the server (passthrough codec) fires binary dispatches.
    let releaseLoader!: (mod: { decompress: (u: Uint8Array) => Promise<Uint8Array> }) => void;
    const loader = () =>
      new Promise<{ decompress: (u: Uint8Array) => Promise<Uint8Array> }>((resolve) => {
        releaseLoader = (mod) => resolve(mod);
      });

    const client = new GatewayClient({
      url: 'ws://fake/gateway',
      tokenProvider: async () => 'tok',
      socketFactory: server.socketFactory,
      compression: 'zstd_stream',
      zstdWasmLoader: loader,
    });
    client.onAny((event: any) => dispatches.push(event.t));

    void client.connect().catch(() => {});

    // Manual handshake offering ONLY zstd (with both offered, compression
    // selection prefers the native-capable zlib and the loader never gates).
    const sock = server.sockets[0]!;
    server.sendHello(sock, 30_000, ['zstd_stream']);
    await vi.advanceTimersByTimeAsync(0);
    server.sendReady(sock, { sessionId: 'sess-race', resumeToken: 'rt-race' });
    await vi.advanceTimersByTimeAsync(0);

    // Binary dispatch races the (still-pending) inflater — must not drop.
    const frame = JSON.stringify({ op: 0, t: 'MessageCreate', s: 2, d: { ok: 1 } });
    sock.emitBinary(new TextEncoder().encode(frame));
    await vi.advanceTimersByTimeAsync(5);

    // Still pending: buffered, not delivered, not counted malformed.
    expect(dispatches).not.toContain('MessageCreate');
    expect(client.getTelemetry().malformed_frames_total).toBe(0);

    releaseLoader({ decompress: async (u: Uint8Array) => u });
    await vi.advanceTimersByTimeAsync(20);

    expect(dispatches).toContain('MessageCreate');
    client.destroy();
  });
});

describe('decompressor readiness gates the handshake (lane D #19)', () => {
  function pendingZstdClient(server: FakeGatewayServer) {
    let releaseLoader!: (mod: { decompress: (u: Uint8Array) => Promise<Uint8Array> }) => void;
    const loader = () =>
      new Promise<{ decompress: (u: Uint8Array) => Promise<Uint8Array> }>((resolve) => {
        releaseLoader = (mod) => resolve(mod);
      });
    const client = new GatewayClient({
      url: 'ws://fake/gateway',
      tokenProvider: async () => 'tok',
      socketFactory: server.socketFactory,
      compression: 'zstd_stream',
      zstdWasmLoader: loader,
    });
    return { client, release: () => releaseLoader({ decompress: async (u: Uint8Array) => u }) };
  }

  it('sends Identify only once the decompressor is built', async () => {
    const server = newFakeServer();
    const { client, release } = pendingZstdClient(server);
    void client.connect().catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    const sock = server.sockets[0]!;
    server.sendHello(sock, 30_000, ['zstd_stream']);
    await vi.advanceTimersByTimeAsync(10);

    // The server would start compressing right after Identify; nothing may
    // go out before the client can read what comes back.
    expect(server.opsSentTo(sock)).not.toContain(GatewayOp.Identify);
    release();
    await vi.advanceTimersByTimeAsync(10);
    expect(server.opsSentTo(sock)).toContain(GatewayOp.Identify);
    client.destroy();
  });

  it('tears down (never drops) when early compressed bytes overflow the buffer', async () => {
    const server = newFakeServer();
    const { client } = pendingZstdClient(server);
    const states: string[] = [];
    void client.connect().catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    const sock = server.sockets[0]!;
    server.sendHello(sock, 30_000, ['zstd_stream']);
    await vi.advanceTimersByTimeAsync(0);

    sock.emitBinary(new Uint8Array(EARLY_BINARY_BUFFER_MAX_BYTES - 10));
    expect(client.connectionState).not.toBe('reconnecting');
    sock.emitBinary(new Uint8Array(64));
    states.push(client.connectionState);
    expect(states).toContain('reconnecting');
    expect(client.getTelemetry().malformed_frames_total).toBeGreaterThan(0);
    client.destroy();
  });
});

describe('zlib-stream fallback', () => {
  // Sink-mode harness: the collector delivers spans the moment they decode;
  // push() only feeds bytes (#26 — delivery never rides push completion).
  async function sinkInflater() {
    const inflater = await makeGatewayInflater('zlib_stream');
    const delivered: string[] = [];
    inflater.setSink!((t) => delivered.push(t));
    return { inflater, delivered };
  }
  // Deadline-based drain (see drainUntil): waits until the predicate holds
  // or a real-time deadline lapses — never a fixed hop count, which races
  // the zlib background thread's completion under box load (#26 flake).
  const settle = (until: () => boolean): Promise<void> => drainUntil(until);

  it('delivers concatenated frames through the sink as they decode', async () => {
    const { inflater, delivered } = await sinkInflater();
    expect(inflater.codec).toBe('zlib_stream');

    const msg1 = JSON.stringify({ op: 10, d: { heartbeat_interval: 100 } });
    const msg2 = JSON.stringify({ op: 0, t: 'Ready', s: 1, d: { v: 1 } });
    const compressedAll = await deflateAsync(msg1 + '\n' + msg2);

    await inflater.push(compressedAll.subarray(0, 40));
    await inflater.push(compressedAll.subarray(40));
    await settle(() => delivered.length >= 2);

    expect(delivered).toHaveLength(2);
    expect(JSON.parse(delivered[0]!)).toMatchObject({ op: 10 });
    expect(JSON.parse(delivered[1]!)).toMatchObject({ op: 0, s: 1 });
    inflater.dispose?.();
  });

  it('survives coalesced writes — two frames, one write, both delivered (#26)', async () => {
    const { inflater, delivered } = await sinkInflater();
    // The exact jam case: one write carries BOTH frames' bytes; under the
    // old read/write pairing the second read had nothing to resolve.
    const coalesced = await deflateAsync(
      JSON.stringify({ op: 0, t: 'A', s: 1, d: {} }) +
        '\n' +
        JSON.stringify({ op: 0, t: 'B', s: 2, d: {} }),
    );
    await inflater.push(coalesced);
    await settle(() => delivered.length >= 2);
    expect(delivered.map((t) => JSON.parse(t)!.t)).toEqual(['A', 'B']);
    inflater.dispose?.();
  });

  it('survives split frames — one frame\'s bytes across two writes (#26)', async () => {
    const { inflater, delivered } = await sinkInflater();
    const bytes = await deflateAsync(JSON.stringify({ op: 0, t: 'SPLIT', s: 1, d: { x: 'y'.repeat(64) } }));
    const cut = Math.floor(bytes.length / 2);
    await inflater.push(bytes.subarray(0, cut));
    await realHop();
    expect(delivered).toHaveLength(0); // partial: nothing complete yet
    await inflater.push(bytes.subarray(cut));
    await settle(() => delivered.length >= 1);
    expect(delivered).toHaveLength(1);
    expect(JSON.parse(delivered[0]!).t).toBe('SPLIT');
    inflater.dispose?.();
  });

  it('client responds to Hello offering zlib only by sending compress=zlib_stream', async () => {
    const server = newFakeServer();
    const client = new GatewayClient({
      url: 'ws://fake/gateway',
      tokenProvider: async () => 'tok',
      socketFactory: server.socketFactory,
      compression: 'zstd_stream',
    });
    const p = client.connect().catch(() => {});
    await vi.advanceTimersByTimeAsync(0);

    const socket = server.sockets[0]!;
    socket.simulateOpen();
    // Custom Hello carrying an explicit offer array:
    socket.serverSend({
      op: GatewayOp.Hello,
      d: { heartbeat_interval: 4000, compress: ['zlib_stream'] },
    } as never);
    await vi.advanceTimersByTimeAsync(0);

    expect(client.compressionCodec).toBe('zlib_stream');
    const identify = server.lastIdentify();
    expect((identify as { compress: unknown }).compress).toBe('zlib_stream');
    client.destroy();
  });

  it('plain-text frames still flow when negotiation ends at none', async () => {
    const server = newFakeServer();
    const client = new GatewayClient({
      url: 'ws://fake/gateway',
      tokenProvider: async () => 'tok',
      socketFactory: server.socketFactory,
    });
    const p = client.connect().catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    server.sendHello(server.sockets[0]!, 4000);
    await vi.advanceTimersByTimeAsync(0);
    server.sendReady(server.sockets[0]!);
    await vi.advanceTimersByTimeAsync(0);

    expect(client.compressionCodec).toBe('none');
    expect(client.connectionState).toBe('ready');
    client.destroy();
    void p;
  });
});

// ---------------------------------------------------------------------------
// Supplementary robustness
// ---------------------------------------------------------------------------

describe('robustness edges', () => {
  it('counts malformed frames without dying', async () => {
    const server = newFakeServer();
    const client = new GatewayClient({
      url: 'ws://fake/gateway',
      tokenProvider: async () => 'tok',
      socketFactory: server.socketFactory,
    });
    void client.connect().catch(() => {});
    await handshake(server);

    server.sockets[0]!.serverSend('this is not json {{');
    server.sockets[0]!.serverSend(JSON.stringify({ op: 4, d: {} })); // undefined op
    await vi.advanceTimersByTimeAsync(0);

    expect(client.getTelemetry().malformed_frames_total).toBeGreaterThanOrEqual(2);
    expect(client.connectionState).toBe('ready'); // still alive
    client.destroy();
  });

  it('disconnect() suppresses auto-reconnect; destroy() is terminal', async () => {
    const server = newFakeServer();
    const client = new GatewayClient({
      url: 'ws://fake/gateway',
      tokenProvider: async () => 'tok',
      socketFactory: server.socketFactory,
    });
    void client.connect().catch(() => {});
    await handshake(server);

    client.disconnect();
    expect(client.connectionState).toBe('disconnected');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(server.sockets).toHaveLength(1); // no reconnect spawned

    const before = server.sockets.length;
    client.destroy();
    await expect(client.connect()).rejects.toThrow(/dead/);
    expect(server.sockets.length).toBe(before);
  });

  it('ByteAccumulator and span scanner behave on adversarial inputs', async () => {
    const acc = new ByteAccumulator();
    acc.append(new TextEncoder().encode('{"a":'));
    acc.append(new TextEncoder().encode('"b"} {"c": "x\\"y{"}'));
    expect(acc.length).toBe(24);
    const text = new TextDecoder().decode(acc.bytes());
    const spans = scanJsonObjectSpans(text);
    expect(spans).toHaveLength(2);

    // String containing braces survives the scanner.
    const tricky = '{"s":"}{ no really }"}';
    expect(scanJsonObjectSpans(tricky)).toHaveLength(1);

    // Binary garbage in accumulator just yields zero valid spans or throws upstream.
    const acc2 = new ByteAccumulator();
    acc2.append(new Uint8Array([0xff, 0xfe, 0x00]));
    expect(() => scanJsonObjectSpans(new TextDecoder().decode(acc2.bytes()))).not.toThrow();
  });

  it('close info propagates through onClosed when the remote drops us', async () => {
    const server = newFakeServer();
    const closed: Array<number> = [];
    const client = new GatewayClient({
      url: 'ws://fake/gateway',
      tokenProvider: async () => 'tok',
      socketFactory: server.socketFactory,
      onClosed: (info) => closed.push(info.code),
    });
    void client.connect().catch(() => {});
    await handshake(server);

    server.sockets[0]!.simulateRemoteClose(closeInfo(1006, 'partition'));
    await vi.advanceTimersByTimeAsync(31_000);

    expect(closed).toContain(1006);
    client.destroy();
  });
});

// ---------------------------------------------------------------------------
// F5b — bounded connect
// ---------------------------------------------------------------------------

describe('connect timeout (F5b)', () => {
  it('closes a black-holed connect and lets the backoff retry', async () => {
    // A socket that never opens, never errors, never closes: the shape a
    // dropped SYN produces (the OS socket gives up after 10-60s).
    const server = newFakeServer();
    const sockets: Array<FakeSocket> = [];
    const states: string[] = [];
    const client = new GatewayClient({
      url: 'ws://fake/gateway',
      tokenProvider: async () => 'tok',
      socketFactory: (url) => {
        const socket = new FakeSocket(url, server);
        sockets.push(socket);
        return socket;
      },
      connectTimeoutMs: 1_000,
      minReconnectDelayMs: 10,
      maxReconnectDelayMs: 10,
      onStateChange: (c) => states.push(c.to),
    });

    const attempt = client.connect();
    // Observed now, asserted below: the rejection lands inside the timer
    // advance, before the `rejects` matcher attaches.
    attempt.catch(() => {});

    await vi.advanceTimersByTimeAsync(999);
    expect(client.connectionState).toBe('connecting');
    expect(sockets).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(attempt).rejects.toThrow(/timed out/);
    // Bounded: the client left 'connecting' on its own…
    expect(states).toContain('reconnecting');

    // …and the existing backoff owns the retry: a fresh socket appears.
    await vi.advanceTimersByTimeAsync(20);
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    client.destroy();
  });

  it('does not fire for a socket that opens inside the window', async () => {
    const server = newFakeServer();
    const client = new GatewayClient({
      url: 'ws://fake/gateway',
      tokenProvider: async () => 'tok',
      socketFactory: server.socketFactory,
      connectTimeoutMs: 1_000,
    });

    await client.connect();
    await vi.advanceTimersByTimeAsync(60_000);

    // No spurious close/reconnect from a stale timer.
    expect(server.sockets).toHaveLength(1);
    expect(client.connectionState).not.toBe('reconnecting');
    client.destroy();
  });

  it('a socket that goes SILENT AFTER HELLO is torn down and retried (6.1)', async () => {
    // The wedge this closes: Hello arrives (so the client Identifies) and then
    // nothing ever follows — no Ready. No heartbeat runs in 'identifying' (the
    // server closes 4003 on a heartbeat that beats its Identify), so without a
    // handshake deadline the client sits there for the life of the process.
    const server = newFakeServer();
    const sockets: Array<FakeSocket> = [];
    const states: string[] = [];
    const client = new GatewayClient({
      url: 'ws://fake/gateway',
      tokenProvider: async () => 'tok',
      socketFactory: (url) => {
        const socket = new FakeSocket(url, server);
        sockets.push(socket);
        return socket;
      },
      handshakeTimeoutMs: 5_000,
      minReconnectDelayMs: 10,
      maxReconnectDelayMs: 10,
      onStateChange: (c) => states.push(c.to),
    });

    void client.connect().catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(1);
    sockets[0]!.simulateOpen();
    await vi.advanceTimersByTimeAsync(0);

    // Hello arrives, the client Identifies, then the peer goes silent.
    server.sendHello(sockets[0]!, 4_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(server.lastIdentify()).toBeTruthy();

    await vi.advanceTimersByTimeAsync(4_000);
    expect(client.connectionState).not.toBe('reconnecting');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(states).toContain('reconnecting');
    expect(client.getTelemetry().reconnects_total).toBeGreaterThanOrEqual(1);

    // …and the backoff owns the retry.
    await vi.advanceTimersByTimeAsync(20);
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    client.destroy();
  });

  it('the handshake deadline is retired by Ready (6.1)', async () => {
    const server = newFakeServer();
    const client = new GatewayClient({
      url: 'ws://fake/gateway',
      tokenProvider: async () => 'tok',
      socketFactory: server.socketFactory,
      handshakeTimeoutMs: 500,
    });

    void client.connect().catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    server.sockets[0]!.simulateOpen();
    await vi.advanceTimersByTimeAsync(0);
    await handshake(server);

    // Four times the deadline: a stale handshake timer would have fired by now.
    // (Longer than this and the session's own heartbeat accounting, not the
    // handshake, decides whether the connection lives.)
    await vi.advanceTimersByTimeAsync(2_000);
    expect(client.connectionState).not.toBe('reconnecting');
    expect(client.connectionState).not.toBe('dead');
    expect(server.sockets).toHaveLength(1);
    client.destroy();
  });

  it('keeps malformed-frame diagnostics payload-free (F5a)', async () => {
    const server = newFakeServer();
    const client = new GatewayClient({
      url: 'ws://fake/gateway',
      tokenProvider: async () => 'tok',
      socketFactory: server.socketFactory,
    });
    void client.connect().catch(() => {});
    await handshake(server);

    const truncated =
      '{"op":0,"t":"MessageCreate","d":{"content":"ATTACKER-SECRET"';
    server.sockets[0]!.serverSend(truncated);
    await vi.advanceTimersByTimeAsync(0);

    expect(client.getTelemetry().malformed_frames_total).toBe(1);
    expect(client.lastMalformed).toHaveLength(1);
    expect(client.lastMalformed[0]).toEqual({
      kind: 'not_json',
      bytes: new TextEncoder().encode(truncated).length,
    });
    // No field of the diagnostic can carry the inbound payload.
    expect(JSON.stringify(client.lastMalformed)).not.toContain('ATTACKER-SECRET');
    client.destroy();
  });
});

// ---------------------------------------------------------------------------
// 6.2 — malformed dispatch payloads must not wedge the socket handler
// ---------------------------------------------------------------------------

describe('malformed dispatch payloads (6.2)', () => {
  it('a null Ready payload is counted, tears down, and reconnects — never wedges (6.2)', async () => {
    const server = newFakeServer();
    const states: string[] = [];
    const client = new GatewayClient({
      url: 'ws://fake/gateway',
      tokenProvider: async () => 'tok',
      socketFactory: server.socketFactory,
      // Keep the 6.1 handshake deadline out of the window so the assertion
      // below can only be satisfied by the dispatch guard itself.
      handshakeTimeoutMs: 60_000,
      minReconnectDelayMs: 10,
      maxReconnectDelayMs: 10,
      onStateChange: (c) => states.push(c.to),
    });
    void client.connect().catch(() => {});
    await vi.advanceTimersByTimeAsync(0);

    const socket = server.sockets[0]!;
    server.sendHello(socket, 4_000);
    await vi.advanceTimersByTimeAsync(0); // Identify sent; handshake in flight
    expect(client.connectionState).toBe('identifying');

    // Parses as a valid envelope (op 0, known t, s >= 0, `d` present) but the
    // payload is null: the exact frame that used to throw on `ready.session_id`.
    expect(() => server.sendDispatch(socket, 'Ready', 0, null)).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);

    // Counted + surfaced structurally (no payload content)…
    expect(client.getTelemetry().dispatch_errors_total).toBe(1);
    expect(client.lastMalformed.at(-1)).toMatchObject({
      kind: 'payload',
      event: 'Ready',
    });
    // The diagnostic is structural (field names/types only), never content.
    expect(client.lastMalformed.at(-1)?.detail).toBeTruthy();
    // …and the state machine advanced INTO recovery rather than wedging.
    expect(states).toContain('reconnecting');
    expect(client.connectionState).toBe('reconnecting');

    // The existing backoff owns the retry.
    await vi.advanceTimersByTimeAsync(20);
    expect(server.sockets.length).toBeGreaterThanOrEqual(2);
    client.destroy();
  });

  it('a Ready payload missing the fields the client reads is rejected (6.2)', async () => {
    const server = newFakeServer();
    const client = new GatewayClient({
      url: 'ws://fake/gateway',
      tokenProvider: async () => 'tok',
      socketFactory: server.socketFactory,
      handshakeTimeoutMs: 60_000,
      minReconnectDelayMs: 10,
      maxReconnectDelayMs: 10,
    });
    void client.connect().catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    const socket = server.sockets[0]!;
    server.sendHello(socket, 4_000);
    await vi.advanceTimersByTimeAsync(0);

    // An object, but without the session identity Ready must carry: the old
    // cast stored `undefined` session fields and only failed much later.
    server.sendDispatch(socket, 'Ready', 0, {});
    await vi.advanceTimersByTimeAsync(0);

    expect(client.getSession()).toBeNull();
    expect(client.getTelemetry().dispatch_errors_total).toBe(1);
    expect(client.lastMalformed.at(-1)?.detail).toMatch(/session_id/);
    expect(client.connectionState).toBe('reconnecting');
    client.destroy();
  });

  it('a null payload on a common data event is counted and never reaches listeners (6.2)', async () => {
    const server = newFakeServer();
    const received: unknown[] = [];
    const client = new GatewayClient({
      url: 'ws://fake/gateway',
      tokenProvider: async () => 'tok',
      socketFactory: server.socketFactory,
      minReconnectDelayMs: 10,
      maxReconnectDelayMs: 10,
    });
    client.on('MessageCreate', (p) => received.push(p));
    void client.connect().catch(() => {});
    await handshake(server);

    server.sendDispatch(server.sockets[0]!, 'MessageCreate', 2, null);
    await vi.advanceTimersByTimeAsync(0);

    expect(received).toHaveLength(0);
    expect(client.getTelemetry().dispatch_errors_total).toBe(1);
    expect(client.lastMalformed.at(-1)).toMatchObject({
      kind: 'payload',
      event: 'MessageCreate',
    });
    expect(client.connectionState).toBe('reconnecting');
    client.destroy();
  });
});

// ---------------------------------------------------------------------------
// 6.3 — terminal close codes must never reconnect
// ---------------------------------------------------------------------------

describe('terminal close codes (6.3)', () => {
  it.each([4004, 4013, 4014])(
    'close %d is terminal: dead state + onDead, no reconnect',
    async (code) => {
      const server = newFakeServer();
      const states: string[] = [];
      const dead: string[] = [];
      const closed: number[] = [];
      const client = new GatewayClient({
        url: 'ws://fake/gateway',
        tokenProvider: async () => 'tok',
        socketFactory: server.socketFactory,
        minReconnectDelayMs: 10,
        maxReconnectDelayMs: 10,
        onStateChange: (c) => states.push(c.to),
        onDead: (info) => dead.push(info.reason),
        onClosed: (info) => closed.push(info.code),
      });
      void client.connect().catch(() => {});
      await handshake(server);
      expect(client.connectionState).toBe('ready');

      server.sockets[0]!.simulateRemoteClose(closeInfo(code, 'terminal'));

      expect(closed).toContain(code);
      expect(states).toContain('dead');
      expect(client.connectionState).toBe('dead');
      expect(dead).toHaveLength(1);
      expect(dead[0]).toMatch(new RegExp(String(code)));
      expect(client.getTelemetry().reconnects_total).toBe(0);

      // The whole backoff horizon: a classification bug would spawn sockets.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(server.sockets).toHaveLength(1);
      expect(client.connectionState).toBe('dead');
      expect(client.getTelemetry().reconnects_total).toBe(0);
      client.destroy();
    },
  );

  it('a non-terminal close still reconnects (classification, not a blanket stop)', async () => {
    const server = newFakeServer();
    const client = new GatewayClient({
      url: 'ws://fake/gateway',
      tokenProvider: async () => 'tok',
      socketFactory: server.socketFactory,
      minReconnectDelayMs: 10,
      maxReconnectDelayMs: 10,
    });
    void client.connect().catch(() => {});
    await handshake(server);

    server.sockets[0]!.simulateRemoteClose(closeInfo(1006, 'partition'));
    await vi.advanceTimersByTimeAsync(50);

    expect(client.connectionState).not.toBe('dead');
    expect(client.getTelemetry().reconnects_total).toBe(1);
    expect(server.sockets.length).toBeGreaterThanOrEqual(2);
    client.destroy();
  });
});

// ---------------------------------------------------------------------------
// Shared-server helper (post-declaration hoist via function statement)
// ---------------------------------------------------------------------------

function newFakeServer(): FakeGatewayServer {
  return new FakeGatewayServer();
}
