/**
 * U28 slice 1 — virtual client.
 *
 * A virtual client is a load-test actor: it opens a gateway connection via
 * @cytale/gateway-client (the SAME client the production web app uses — never
 * a drifting mock), identifies, heartbeats (the client does this on its own
 * timer), sends messages through a thin REST seam, and records the latency of
 * every MESSAGE_CREATE it receives.
 *
 * The REST seam is a small interface so the harness can inject either the
 * real @cytale/api-client (against a live server) or an in-process fake for
 * the unit test. Wire encode/decode always comes from @cytale/protocol.
 */

import { GatewayClient, type GatewaySocketLike } from '@cytale/gateway-client';
import type { MessageCreate } from '@cytale/protocol';

/** A single received-message latency sample. */
export interface MessageSample {
  /** The message id (Snowflake string). */
  messageId: string;
  /** Epoch ms when the client received the MESSAGE_CREATE dispatch. */
  receivedAt: number;
}

/**
 * Thin REST seam for the send path. The real implementation wraps
 * @cytale/api-client's `sendMessage`; the test injects a fake that records
 * the post and (in the fan-out round) triggers the gateway to broadcast.
 */
export interface RestSeam {
  /**
   * Post a message to a channel. Returns the server-assigned message id.
   * TODO(U9): the real api-client `sendMessage` returns a full Message; the
   * seam narrows to the id the harness needs for latency correlation.
   */
  sendMessage(channelId: string, content: string): Promise<string>;
}

export interface VirtualClientOptions {
  /** Gateway URL handed to the GatewayClient. */
  url: string;
  /** Auth token for Identify. */
  token: string;
  /** Injectable socket factory (tests + U28); defaults to global WebSocket. */
  socketFactory?: (url: string) => GatewaySocketLike;
  /** REST send seam. */
  rest: RestSeam;
  /** Optional per-client label for diagnostics. */
  label?: string;
}

export class VirtualClient {
  readonly label: string;
  readonly gateway: GatewayClient;
  private readonly rest: RestSeam;
  private readonly samples: MessageSample[] = [];
  private readonly unsubscribe: () => void;
  private connected = false;

  constructor(options: VirtualClientOptions) {
    this.label = options.label ?? 'vc';
    this.rest = options.rest;
    this.gateway = new GatewayClient({
      url: options.url,
      tokenProvider: () => options.token,
      socketFactory: options.socketFactory,
      compression: 'none',
    });

    // Record every MESSAGE_CREATE we receive with its local receive time.
    this.unsubscribe = this.gateway.on('MessageCreate', (payload: MessageCreate) => {
      this.samples.push({ messageId: payload.id, receivedAt: Date.now() });
    });
  }

  /** Open the gateway connection and wait until it reaches steady state. */
  async connect(): Promise<void> {
    await this.gateway.connect();
    this.connected = true;
  }

  /** True once connect() resolved. */
  get isConnected(): boolean {
    return this.connected;
  }

  /** Send a message through the REST seam; returns the server message id. */
  async sendMessage(channelId: string, content: string): Promise<string> {
    return await this.rest.sendMessage(channelId, content);
  }

  /** All latency samples collected so far (copy). */
  get samplesSnapshot(): readonly MessageSample[] {
    return [...this.samples];
  }

  /** Samples for a specific message id (for fan-out correlation). */
  samplesFor(messageId: string): readonly MessageSample[] {
    return this.samples.filter((s) => s.messageId === messageId);
  }

  /** Clear collected samples (between rounds). */
  clearSamples(): void {
    this.samples.length = 0;
  }

  /** Polite close; keeps resume eligibility (not used in slice 1). */
  disconnect(): void {
    this.connected = false;
    this.gateway.disconnect();
  }

  /** Terminal teardown. */
  destroy(): void {
    this.connected = false;
    this.unsubscribe();
    this.gateway.destroy();
  }
}
