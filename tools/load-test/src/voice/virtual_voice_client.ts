/**
 * U13 — the virtual voice caller (gateway signaling, real codecs).
 *
 * A load-test actor built on the SAME @cytale/gateway-client as the web app
 * (U28 doctrine): it Identifies, drives op-22 call control (start/join/
 * leave/state), sends op-23 signaling bursts, and records every CALL_*
 * dispatch (Start/Update/End/Sync/Ring/Signal) with receive timestamps into
 * a derived roster (roster.ts). It deliberately carries NO media stack —
 * the real-WebRTC legs belong to the Elixir sidecar; this class is the
 * codec-authoritative assertion path.
 */

import { GatewayClient, type GatewaySocketLike } from '@cytale/gateway-client';
import type { CallEnd, CallStart, CallSync, CallUpdate, Ready } from '@cytale/protocol';

import { applyCallEvent, applyCallSync, emptyRoster, type CallRoster } from './roster.js';

/** One captured dispatch. */
export interface CapturedEvent<T = unknown> {
  t: string;
  at: number;
  /** Dispatch sequence number when present (0 for handshake frames). */
  seq: number | null;
  payload: T;
}

export interface VirtualVoiceClientOptions {
  url: string;
  token: string;
  label?: string;
  socketFactory?: (url: string) => GatewaySocketLike;
  minReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  onInvalidSession?: (resumable: boolean) => void;
}

export class VirtualVoiceClient {
  readonly label: string;
  readonly gateway: GatewayClient;
  private user_id: string | null = null;
  private readonly events: CapturedEvent[] = [];
  private rosterByChannel = new Map<string, CallRoster>();
  private invalidSessions = 0;
  private readonly unsub: Array<() => void> = [];

  /** Own user id (from READY). */
  get userId(): string | null {
    return this.user_id;
  }

  constructor(options: VirtualVoiceClientOptions) {
    this.label = options.label ?? 'voice-vc';
    this.gateway = new GatewayClient({
      url: options.url,
      tokenProvider: () => options.token,
      socketFactory: options.socketFactory,
      compression: 'none',
      minReconnectDelayMs: options.minReconnectDelayMs ?? 200,
      maxReconnectDelayMs: options.maxReconnectDelayMs ?? 2_000,
      onInvalidSession: (resumable) => {
        this.invalidSessions++;
        options.onInvalidSession?.(resumable);
      },
    });

    this.unsub.push(
      this.gateway.onAny((event, meta) => {
        this.events.push({
          t: String(event.t),
          at: meta.receivedAt,
          seq: typeof event.s === 'number' && event.s > 0 ? event.s : meta.seq || null,
          payload: event.d,
        });

        switch (event.t) {
          case 'Ready':
            this.user_id = String((event.d as Ready).user.id);
            break;
          case 'CallStart':
            this.fold(String((event.d as CallStart).channel_id), event.d as CallStart);
            break;
          case 'CallUpdate':
            this.fold(String((event.d as CallUpdate).channel_id), event.d as CallUpdate);
            break;
          case 'CallEnd':
            this.fold(String((event.d as CallEnd).channel_id), event.d as CallEnd);
            break;
          case 'CallSync': {
            // Backfill: fold each entry into its own channel's roster, and
            // CLEAR tracked channels the sync does not carry (from this
            // recipient's view that call is no longer live — e.g. the boot
            // sweep ended it).
            const sync = event.d as CallSync;
            const all = [...sync.calls, ...sync.dm_calls];
            const present = new Set<string>();
            for (const entry of all) {
              const ch = String(entry.channel_id);
              present.add(ch);
              this.rosterByChannel.set(ch, applyCallSync(this.rosterFor(ch), ch, entry));
            }
            for (const ch of [...this.rosterByChannel.keys()]) {
              if (!present.has(ch)) this.rosterByChannel.set(ch, emptyRoster());
            }
            break;
          }
          default:
            break;
        }
      }),
    );
  }

  private fold(channelId: string, event: Parameters<typeof applyCallEvent>[1]): void {
    const roster = this.rosterByChannel.get(String(channelId)) ?? emptyRoster();
    this.rosterByChannel.set(String(channelId), applyCallEvent(roster, event));
  }

  async connect(): Promise<void> {
    await this.gateway.connect();
  }

  /** True once a Ready/Resumed was observed on the CURRENT connection. */
  get ready(): boolean {
    const cs = this.gateway.connectionState;
    return cs === 'ready' || cs === 'connected';
  }

  /** op 22: start (creates the call; the starter joins — AM16). */
  start(channelId: string, ring = false): void {
    this.gateway.sendCallState({ channel_id: channelId, action: 'start', ...(ring ? { ring: true } : {}) });
  }

  /** op 22: join the live call. */
  join(channelId: string): void {
    this.gateway.sendCallState({ channel_id: channelId, action: 'join' });
  }

  /** op 22: leave. */
  leave(channelId: string): void {
    this.gateway.sendCallState({ channel_id: channelId, action: 'leave' });
  }

  /** op 22: state (mute/deafen/ring-after-start). */
  state(channelId: string, body: { mute?: boolean; deafen?: boolean; ring?: boolean }): void {
    this.gateway.sendCallState({ channel_id: channelId, action: 'state', ...body });
  }

  /** op 22 publish (V2): start sending a source (roster-visible immediately). */
  publish(channelId: string, source: 'camera' | 'screen' | 'screen_audio'): void {
    this.gateway.sendCallState({ channel_id: channelId, action: 'publish', source });
  }

  /** op 22 unpublish (V2). */
  unpublish(channelId: string, source: 'camera' | 'screen' | 'screen_audio'): void {
    this.gateway.sendCallState({ channel_id: channelId, action: 'unpublish', source });
  }

  /** op 22 state carrying video_want (V2): the receiver's tile budget. */
  videoWant(channelId: string, tiles: number): void {
    this.gateway.sendCallState({
      channel_id: channelId,
      action: 'state',
      video_want: { tiles },
    });
  }

  /**
   * op 23 burst: `count` ICE-shaped signaling bodies (valid op-23 wire
   * payloads through the production client; the room consumes/drops them —
   * the pressure target is the ingress path's cap+throttle, per U13's
   * busy-call scenario). Paced to just under the 50 ms/session/channel
   * throttle so accepted, not dropped.
   */
  async signalBurst(channelId: string, count: number, gapMs = 60): Promise<void> {
    for (let i = 0; i < count; i++) {
      this.gateway.sendCallSignal({
        channel_id: channelId,
        kind: 'ice',
        body: JSON.stringify({
          candidate: `candidate:1 1 UDP 2130706431 127.0.0.1 ${9000 + (i % 500)} typ host`,
          sdpMid: '0',
          sdpMLineIndex: 0,
        }),
      });
      if (i < count - 1) await new Promise((r) => setTimeout(r, gapMs));
    }
  }

  /** Derived roster for a channel (live view). */
  rosterFor(channelId: string): CallRoster {
    return this.rosterByChannel.get(String(channelId)) ?? emptyRoster();
  }

  /** Roster member ids (sorted) — the VoiceClientHandle surface. */
  rosterIds(channelId: string): string[] {
    return [...this.rosterFor(channelId).members.keys()].sort();
  }

  /** Roster size — the VoiceClientHandle surface. */
  rosterSize(channelId: string): number {
    return this.rosterFor(channelId).members.size;
  }

  /** Live derived publish-sources of one roster member (V2). */
  memberSources(channelId: string, userId: string): string[] {
    return [...(this.rosterFor(channelId).members.get(userId)?.sources ?? [])].sort();
  }

  /** All captured events (copy), newest last. */
  captured(): CapturedEvent[] {
    return [...this.events];
  }

  /** Captured events of one name. */
  capturedOf(t: string): CapturedEvent[] {
    return this.events.filter((e) => e.t === t);
  }

  /** True when at least one dispatch of name `t` (optionally filtered) was captured. */
  hasCaptured(t: string, pred?: (seq: number | null) => boolean): boolean {
    return this.capturedOf(t).some((e) => (pred ? pred(e.seq) : true));
  }

  /** (seq, name) pairs of every captured dispatch. */
  capturedSeqs(): Array<{ seq: number | null; t: string }> {
    return this.events.map((e) => ({ seq: e.seq, t: e.t }));
  }

  /** InvalidSession dispatches seen (a resume REFUSAL indicator). */
  get invalidSessionCount(): number {
    return this.invalidSessions;
  }

  /** Last dispatch seq observed (client-side high-water mark). */
  get lastSeq(): number | null {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const s = this.events[i]!.seq;
      if (typeof s === 'number' && s > 0) return s;
    }
    return null;
  }

  /** Seqs captured strictly after `from` (replay-correlation helper). */
  seqsAfter(from: number): number[] {
    return this.events.filter((e) => typeof e.seq === 'number' && e.seq > from).map((e) => e.seq as number);
  }

  /** Polite drop (resume-eligible). */
  disconnect(): void {
    this.gateway.disconnect();
  }

  destroy(): void {
    for (const un of this.unsub.splice(0)) {
      try {
        un();
      } catch {
        /* dying emitter */
      }
    }
    this.gateway.destroy();
  }
}
