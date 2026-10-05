/**
 * U28 slice 1 — load-test orchestrator.
 *
 * Spins up N virtual clients against an injected gateway endpoint, runs a
 * fan-out round (arm-before-broadcast: every client's MESSAGE_CREATE handler
 * is registered before the sender posts), and produces a LoadTestReport.
 *
 * The gateway endpoint and REST seam are injectable so the unit test runs
 * against an in-process fake gateway (reusing the fake-gateway pattern from
 * packages/gateway-client) while the CLI runs against a live server.
 */

import { VirtualClient, type RestSeam } from './virtual_client.js';
import { percentiles, type LoadTestReport } from './report.js';
import { runScenario, scenarioNames } from './scenarios/index.js';
import type { ScenarioContext, ScenarioResult } from './scenarios/types.js';
import type { GatewaySocketLike } from '@cytale/gateway-client';

export interface HarnessOptions {
  /** Number of virtual clients to spin up. */
  clientCount: number;
  /** Gateway URL handed to each client. */
  url: string;
  /** Auth token for Identify. */
  token: string;
  /** Injectable socket factory (tests + U28); defaults to global WebSocket. */
  socketFactory?: (url: string) => GatewaySocketLike;
  /** REST send seam (real api-client in CLI, fake in tests). */
  rest: RestSeam;
  /** Channel every client sends/receives on. */
  channelId: string;
  /** Message content for the fan-out round. */
  content?: string;
  /** How long to wait for all clients to receive the broadcast (ms). */
  receiveTimeoutMs?: number;
}

export interface FanOutRoundResult {
  /** Message id the sender posted. */
  messageId: string;
  /** Per-client fan-out latency (ms) from post to receipt. */
  fanOutLatencies: number[];
  /** Number of clients that received the message. */
  receivedCount: number;
}

export class LoadTestHarness {
  private readonly options: HarnessOptions;
  private clients: VirtualClient[] = [];

  constructor(options: HarnessOptions) {
    this.options = options;
  }

  /** Spin up and connect all virtual clients. */
  async connectAll(): Promise<void> {
    const { clientCount, url, token, socketFactory, rest } = this.options;
    this.clients = [];
    for (let i = 0; i < clientCount; i++) {
      const client = new VirtualClient({
        url,
        token,
        socketFactory,
        rest,
        label: `vc-${i}`,
      });
      this.clients.push(client);
    }
    // Connect concurrently; each client's MESSAGE_CREATE handler is registered
    // in its constructor, so all are armed before any broadcast.
    await Promise.all(this.clients.map((c) => c.connect()));
  }

  get connectedCount(): number {
    return this.clients.filter((c) => c.isConnected).length;
  }

  /** Disconnect one client by index (for partial-connect scenarios). */
  disconnectClient(index: number): void {
    const client = this.clients[index];
    if (client) client.disconnect();
  }

  /**
   * Run one fan-out round: arm-before-broadcast. The sender posts via the
   * REST seam; every client's handler is already registered, so the broadcast
   * is observed by all. Returns per-client fan-out latencies.
   */
  async runFanOutRound(): Promise<FanOutRoundResult> {
    const { channelId, content = 'load-test message', receiveTimeoutMs = 5_000 } = this.options;
    const sender = this.clients[0];
    if (!sender) throw new Error('runFanOutRound: no clients connected');

    // Clear prior samples so this round's correlation is clean.
    for (const c of this.clients) c.clearSamples();

    const postTime = Date.now();
    const messageId = await sender.sendMessage(channelId, content);

    // Wait for every client to receive the broadcast (or timeout).
    const deadline = Date.now() + receiveTimeoutMs;
    while (Date.now() < deadline) {
      const allReceived = this.clients.every((c) => c.samplesFor(messageId).length > 0);
      if (allReceived) break;
      await sleep(10);
    }

    const fanOutLatencies: number[] = [];
    let receivedCount = 0;
    for (const c of this.clients) {
      const sample = c.samplesFor(messageId)[0];
      if (sample) {
        receivedCount++;
        fanOutLatencies.push(sample.receivedAt - postTime);
      }
    }

    return { messageId, fanOutLatencies, receivedCount };
  }

  /** Produce the report from a completed fan-out round. */
  buildReport(round: FanOutRoundResult, durationMs: number): LoadTestReport {
    // Per-message receive latency is the fan-out latency for this round.
    return {
      connectionsSustained: this.connectedCount,
      latency: percentiles(round.fanOutLatencies),
      fanOutMs: percentiles(round.fanOutLatencies),
      isolationAssertion: 'pending',
      resumeSuccessRate: 0,
      durationMs,
      scenarios: {},
    };
  }

  /**
   * Run a named scenario against this harness. The scenario's measurement and
   * assertion logic is gated on `isShipped` — when the subject is absent it
   * throws `subject not shipped yet (<subject>)`. Returns the scenario result
   * (callers fold it into the report's `scenarios` map).
   */
  async runScenario(name: string, ctx: Omit<ScenarioContext, 'harness'>): Promise<ScenarioResult> {
    return await runScenario(name, { ...ctx, harness: this });
  }

  /** Stable scenario names this harness can run. */
  get scenarioNames(): string[] {
    return scenarioNames();
  }

  /** Tear down all clients. */
  destroy(): void {
    for (const c of this.clients) c.destroy();
    this.clients = [];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
