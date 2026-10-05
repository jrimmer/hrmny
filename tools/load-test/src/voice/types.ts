/**
 * U13 voice scenarios — shared voice-seam types.
 *
 * The U28 doctrine split for voice (plan U13, pinned decomposition):
 * the TS harness — real codecs from @cytale/protocol — drives ALL gateway
 * signaling and assertions, while the Elixir sidecar
 * (tools/load-test/voice-sidecar) owns the real-WebRTC RTP pump/count legs.
 * These types are the process/protocol boundary between the two.
 */

/** Per-source video counters keyed from the offer manifest's attribution. */
export interface SidecarVideoStats {
  /** source -> packets sent ("camera" | "screen"). */
  sent: Record<string, number>;
  /** "userId/source" -> packets received (manifest-attributed owners). */
  recv: Record<string, number>;
}

/** One participant's counters as reported by the sidecar (atomics snapshot). */
export interface SidecarParticipantStats {
  label: string;
  connected: number;
  sent: number;
  received: number;
  last_latency_ms: number | null;
  max_latency_ms: number | null;
  offers: number;
  answers: number;
  ice_sent: number;
  inbound_tracks: number;
  connected_after_ms: number;
  ws_closed: number;
  /** V2 (U7): largest CALL_SIGNAL body this leg ever saw (bytes, vs the 128 KiB cap). */
  max_sdp_body_bytes?: number;
  /** V2 (U7): connection_state failed/disconnected transitions (leg-drop evidence). */
  pc_failures?: number;
  /** V2 (U7): video packets sent on this leg's published sources. */
  video_sent?: number;
  /** V2 (U7): video packets received (all budgeted sources). */
  video_received?: number;
  max_video_latency_ms?: number | null;
  /** V2 (U7): publish/unpublish toggles driven (the churn storm). */
  churn_toggles?: number;
  /** V2 (U7): per-source counters folded from the sidecar's ETS table. */
  video?: SidecarVideoStats;
}

/** A VOICE_TICK / VOICE_FINAL line from the sidecar. */
export interface SidecarReport {
  type: 'meta' | 'tick' | 'final';
  t?: number;
  n?: number;
  pps?: number;
  duration_s?: number;
  turn_only?: number;
  participants?: SidecarParticipantStats[];
  all_connected?: boolean;
  delivery_pct?: number | null;
  steady_window_ms?: number;
}

/** A sidecar run request (mirrors the env contract in voice-sidecar/README.md). */
export interface SidecarRequest {
  tokens: string[];
  channelId: string;
  host: string;
  port: number;
  path?: string;
  durationS: number;
  pps?: number;
  turnOnly?: number;
  participants?: number;
  labelPrefix?: string;
  turnUrl?: string;
  turnSecret?: string;
  /** V2 (U7): the video plane config (absent = audio-only, the V1 shape). */
  video?: SidecarVideoRequest;
}

/**
 * V2 (U7) sidecar video config: which participants publish what, the pump
 * rate, per-receiver tile budgets, and the publish-churn storm.
 */
export interface SidecarVideoRequest {
  /** First K participants publish camera (op-22 publish + video RTP pump). */
  cameraCount?: number;
  /** First K participants ALSO publish screen (multi-share / stage shape). */
  screenCount?: number;
  /** Video pump rate per published source (default 200pps). */
  videoPps?: number;
  /** Video payload bytes per packet (default 1000). */
  videoBytes?: number;
  /** Delay after connect before the first publish (default 2000ms). */
  publishDelayMs?: number;
  /** Participant idx -> tiles: those receivers declare video_want.tiles. */
  tiles?: Record<string, number>;
  /** First K participants toggle camera publish/unpublish (the storm). */
  churnPublishers?: number;
  /** Ms between churn toggles (default 400). */
  churnIntervalMs?: number;
  /** Toggles per churn publisher (default 8). */
  churnRounds?: number;
}

/** A provisioned voice room: owner + N verified member users + a channel. */
export interface ProvisionedVoiceRoom {
  workspaceId: string;
  channelId: string;
  ownerToken: string;
  ownerUserId: string;
  /** One auth token per provisioned member user (sidecar participants). */
  tokens: string[];
  userIds: string[];
}

/** The signaling surface the voice scenarios drive (real: VirtualVoiceClient). */
export interface VoiceClientHandle {
  readonly label: string;
  readonly ready: boolean;
  /** Own user id once READY named it (roster assertions key on this). */
  readonly userId: string | null;
  readonly lastSeq: number | null;
  readonly invalidSessionCount: number;
  connect(): Promise<void>;
  start(channelId: string, ring?: boolean): void;
  join(channelId: string): void;
  leave(channelId: string): void;
  /** op 22 publish (V2): start sending a source (roster-visible immediately). */
  publish(channelId: string, source: 'camera' | 'screen' | 'screen_audio'): void;
  /** op 22 unpublish (V2). */
  unpublish(channelId: string, source: 'camera' | 'screen' | 'screen_audio'): void;
  /** op 22 state carrying video_want (V2): the receiver's tile budget. */
  videoWant(channelId: string, tiles: number): void;
  /** Live derived publish-sources of one roster member (V2). */
  memberSources(channelId: string, userId: string): string[];
  signalBurst(channelId: string, count: number): Promise<void>;
  /** Live derived roster member ids for a channel. */
  rosterIds(channelId: string): string[];
  /** Live derived roster size for a channel. */
  rosterSize(channelId: string): number;
  /** Captured dispatch names+timestamps (newest last), for assertions. */
  capturedOf(t: string): Array<{ at: number; seq: number | null; payload?: unknown }>;
  /** (seq, name) pairs of every captured dispatch (replay composition). */
  capturedSeqs(): Array<{ seq: number | null; t: string }>;
  hasCaptured(t: string, pred?: (seq: number | null) => boolean): boolean;
  seqsAfter(from: number): number[];
  disconnect(): void;
  destroy(): void;
}

/** A sidecar run request minus the connection triple (the seam injects it). */
export type SidecarRequestSpec = Omit<SidecarRequest, 'host' | 'port' | 'path'>;

/** The raw-resume prober surface the busy-call scenario drives. */
export interface RawResumeProberLike {
  readonly lastSeq: number;
  readonly events: ReadonlyArray<{ seq: number; t: string; at: number }>;
  connect(timeoutMs?: number): Promise<void>;
  drop(): void;
  resumeWith(seq: number, timeoutMs?: number, drainMs?: number): Promise<{
    resumed: boolean;
    refused: boolean;
    replayed: ReadonlyArray<{ seq: number; t: string }>;
    contiguous: boolean;
    firstBadIndex: number;
  }>;
  destroy(): void;
}

/** What the voice scenarios need from the host harness (CLI wires real ones). */
export interface VoiceSeam {
  /** Register + verify N member users, create a fresh channel for them. */
  provision(request: { userCount: number; label: string }): Promise<ProvisionedVoiceRoom>;
  /** Start the Elixir sidecar; the handle exposes ticks + the final report. */
  startSidecar(request: SidecarRequestSpec): Promise<SidecarHandle>;
  /** One signaling client (real codecs, the production gateway client). */
  createClient(token: string, label: string): VoiceClientHandle;
  /** The deliberate-underrun resume prober (raw native dialect). */
  createProber(token: string, label?: string): RawResumeProberLike;
}

/** A live sidecar run. */
export interface SidecarHandle {
  /** Reports seen so far (ticks; meta first). */
  ticks(): SidecarReport[];
  /** Resolves on the first tick where every participant is connected. */
  waitAllConnected(timeoutMs: number): Promise<SidecarReport>;
  /** Resolves with the VOICE_FINAL report (rejects if the sidecar dies first). */
  done: Promise<SidecarReport>;
  /** Kill the sidecar process (soak chaos). */
  kill(): void;
}
