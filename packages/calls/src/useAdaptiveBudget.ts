/**
 * @cytale/web — the adaptive viewing budget (calls V2 plan U4, R7/KTD7/VM2/VM3).
 *
 * Receiver-side ladder over `getStats`: measures what the connection
 * actually delivers (freeze count, jitter, inbound bitrate vs the stream's
 * own trend) and steps the live-tile budget down under degradation and back
 * up when healthy — audio for everyone never degrades (R7), and the
 * stage/speaker protection is the SERVER's forwarding policy (KTD2/VM3:
 * last-N by activity); this module only declares HOW MANY tiles the
 * receiver sustains plus its max-quality preference (R9).
 *
 * Ladder shape (VM2, GO-simulcast branch — the spike's recorded branch):
 *   - initial budget 9, floor 1 (stage-only), ceiling 25, step ±1;
 *   - hysteresis ~10 s per window (the KTD7 ladder cadence);
 *   - upshift slower than downshift: a DOWN step fires on the first bad
 *     window, an UP step needs `upshiftWindows` (2) consecutive good ones;
 *   - the resulting want rides op-22 `state.video_want` — the ENGINE
 *     enforces the client half of the dedicated ~2 s window (never more
 *     than one want per 2 s; the server keeps its own).
 *
 * The stats source is an injectable seam (`getStats`): tests inject
 * sequences (the plan's fake-stats harness — degrade → step down →
 * hysteresis holds → recover). Stats parsing tolerates engines without
 * freezeCount (0 by absence), exactly as the plan's deferred metric
 * question anticipated; thresholds are exported constants so U7's real-
 * browser legs can tune them without re-deriving the ladder.
 */

import type { VideoQualityPreference, VideoWant } from '@cytale/protocol';

// ---------------------------------------------------------------------------
// Stats shapes (structural slices of RTCStatsReport)
// ---------------------------------------------------------------------------

/** One RTCStats object, viewed structurally (untrusted). */
export type StatsRecordLike = Record<string, unknown>;

/** Anything iterable of stats records — RTCStatsReport's used surface. */
export type StatsReportLike = Iterable<StatsRecordLike>;

/** The per-inbound-video-stream metrics one poll reads. */
export interface InboundVideoStats {
  freezeCount: number;
  /** RTCP jitter in SECONDS (the RTCStats unit). */
  jitter: number;
  bytesReceived: number;
}

/**
 * Extract the inbound-rtp VIDEO records from a raw stats report. Audio
 * inbound is deliberately ignored — it never degrades (R7).
 */
export function collectInboundVideoStats(report: StatsReportLike): InboundVideoStats[] {
  const out: InboundVideoStats[] = [];
  for (const stat of report) {
    if (typeof stat !== 'object' || stat === null) continue;
    if (stat['type'] !== 'inbound-rtp' || stat['kind'] !== 'video') continue;
    out.push({
      freezeCount: typeof stat['freezeCount'] === 'number' ? stat['freezeCount'] : 0,
      jitter: typeof stat['jitter'] === 'number' ? stat['jitter'] : 0,
      bytesReceived: typeof stat['bytesReceived'] === 'number' ? stat['bytesReceived'] : 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tunables (exported for tests + U7 tuning; VM2's starting points)
// ---------------------------------------------------------------------------

/** VM2 GO branch: initial live-tile budget. */
export const LADDER_INITIAL_TILES = 9;
/** Floor 1 = stage-only (the share always stays — KTD2). */
export const LADDER_MIN_TILES = 1;
/** Ceiling 25 (the N=25 room). */
export const LADDER_MAX_TILES = 25;
/** Hysteresis: evaluation window length in ms (~10 s per KTD7). */
export const LADDER_WINDOW_MS = 10_000;
/** Stats poll cadence in ms (samples per window = 5). */
export const LADDER_POLL_MS = 2_000;
/** Upshift slowness: consecutive healthy windows required before +1. */
export const LADDER_UPSHIFT_WINDOWS = 2;
/** One freeze event per window is degradation (freezeCount is cumulative). */
export const DEGRADE_FREEZE_DELTA = 1;
/** Jitter above this (seconds) degrades. */
export const DEGRADE_JITTER_S = 0.05;
/** Per-poll byte growth below this on ANY stream = stalled bitrate. */
export const DEGRADE_STALLED_BYTES_PER_POLL = 2_000;

// ---------------------------------------------------------------------------
// Ladder
// ---------------------------------------------------------------------------

/** Narrow timer contracts (node/dom neutral — injectable for tests). */
export type LadderSetInterval = (fn: () => void, ms: number) => unknown;
export type LadderClearInterval = (id: unknown) => void;

export interface AdaptiveBudgetOptions {
  /** Raw stats provider (the fake-stats seam). */
  getStats: () => Promise<StatsReportLike>;
  /** Called with each CHANGED want (the engine rate-limits the op itself). */
  onWant: (want: VideoWant) => void;
  initialTiles?: number;
  minTiles?: number;
  maxTiles?: number;
  /** Window length ms (tests shrink it; production = LADDER_WINDOW_MS). */
  windowMs?: number;
  /** Internal timers (tests omit and drive `poll()`/`evaluateWindow()` by hand). */
  setIntervalFn?: LadderSetInterval;
  clearIntervalFn?: LadderClearInterval;
}

/** Quality ladder position: healthy streak climbs, degradation drops. */
function nextQuality(current: VideoQualityPreference, up: boolean): VideoQualityPreference {
  if (up) return current === 'low' ? 'medium' : 'high';
  return current === 'high' ? 'medium' : 'low';
}

/**
 * The engine-facing slice of the ladder (structural — tests inject fakes
 * without subclassing; the class satisfies it as-is).
 */
export interface AdaptiveBudgetHandle {
  start(): void;
  stop(): void;
  getWant(): VideoWant;
}

export class AdaptiveBudget {
  private readonly getStats: () => Promise<StatsReportLike>;
  private readonly onWant: (want: VideoWant) => void;
  private readonly minTiles: number;
  private readonly maxTiles: number;
  private readonly windowMs: number;
  private readonly setIntervalFn: LadderSetInterval;
  private readonly clearIntervalFn: LadderClearInterval;

  private tiles: number;
  private maxQuality: VideoQualityPreference = 'high';
  /** Cumulative freezeCount at the previous poll (freezeCount is monotonic). */
  private freezeBase: number | null = null;
  private windowJitterPeak = 0;
  private windowStalled = false;
  private windowSamples = 0;
  private healthyStreak = 0;
  private lastBytesTotal: number | null = null;
  private lastEmitted: VideoWant | null = null;
  private timer: unknown = null;
  private windowTimer: unknown = null;
  private polling = false;
  private started = false;

  constructor(options: AdaptiveBudgetOptions) {
    this.getStats = options.getStats;
    this.onWant = options.onWant;
    this.minTiles = options.minTiles ?? LADDER_MIN_TILES;
    this.maxTiles = options.maxTiles ?? LADDER_MAX_TILES;
    this.windowMs = options.windowMs ?? LADDER_WINDOW_MS;
    this.setIntervalFn = options.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalFn = options.clearIntervalFn ?? ((id) => clearInterval(id as ReturnType<typeof setInterval>));    this.tiles = Math.min(
      Math.max(options.initialTiles ?? LADDER_INITIAL_TILES, this.minTiles),
      this.maxTiles,
    );
  }

  /** Current budget (tile count + quality ceiling). */
  getWant(): VideoWant {
    return { tiles: this.tiles, max_quality: this.maxQuality };
  }

  /** Begin sampling (idempotent; the engine starts it with the PC). */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.timer = this.setIntervalFn(() => void this.poll(), LADDER_POLL_MS);
    this.windowTimer = this.setIntervalFn(() => this.evaluateWindow(), this.windowMs);
  }

  /** Stop sampling and freeze the budget (engine teardown). */
  stop(): void {
    if (this.timer !== null) this.clearIntervalFn(this.timer);
    if (this.windowTimer !== null) this.clearIntervalFn(this.windowTimer);
    this.timer = null;
    this.windowTimer = null;
    this.started = false;
  }

  /**
   * One stats poll (public — tests drive the sequence). Consecutive polls
   * are serialized; a failed getStats is a no-opinion sample (transient
   * RTCP gap, never a degradation signal on its own).
   */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    let stats: InboundVideoStats[];
    try {
      stats = collectInboundVideoStats(await this.getStats());
    } catch {
      this.polling = false;
      return;
    }
    this.polling = false;
    if (stats.length === 0) return; // no inbound video: no opinion
    this.windowSamples += 1;

    const totalFreezes = stats.reduce((sum, s) => sum + s.freezeCount, 0);
    if (this.freezeBase !== null && totalFreezes - this.freezeBase >= DEGRADE_FREEZE_DELTA) {
      this.windowStalled = true;
    }
    this.freezeBase = totalFreezes;

    this.windowJitterPeak = Math.max(this.windowJitterPeak, ...stats.map((s) => s.jitter));

    // Stalled-bitrate detection: aggregate inbound bytes barely moved since
    // the previous poll (vs the stream set's own delivered history).
    const total = stats.reduce((sum, s) => sum + s.bytesReceived, 0);
    if (
      this.lastBytesTotal !== null &&
      total - this.lastBytesTotal < DEGRADE_STALLED_BYTES_PER_POLL * stats.length
    ) {
      this.windowStalled = true;
    }
    this.lastBytesTotal = total;
  }

  /**
   * Window boundary (the ~10 s hysteresis): decide the step and (maybe)
   * emit. Public for tests; the window timer calls it in production.
   */
  evaluateWindow(): void {
    if (this.windowSamples === 0) return; // no data this window — hold
    const degraded = this.windowStalled || this.windowJitterPeak > DEGRADE_JITTER_S;
    let changed = false;
    if (degraded) {
      this.healthyStreak = 0;
      const next = Math.max(this.minTiles, this.tiles - 1);
      if (next !== this.tiles) changed = true;
      this.tiles = next;
      const q = nextQuality(this.maxQuality, false);
      if (q !== this.maxQuality) changed = true;
      this.maxQuality = q;
    } else {
      this.healthyStreak += 1;
      if (this.healthyStreak >= LADDER_UPSHIFT_WINDOWS) {
        const next = Math.min(this.maxTiles, this.tiles + 1);
        if (next !== this.tiles) changed = true;
        this.tiles = next;
        const q = nextQuality(this.maxQuality, true);
        if (q !== this.maxQuality) changed = true;
        this.maxQuality = q;
      }
    }
    // Reset the window accumulators.
    this.freezeBase = null;
    this.windowJitterPeak = 0;
    this.windowStalled = false;
    this.windowSamples = 0;
    this.lastBytesTotal = null;

    if (!changed) return;
    const want = this.getWant();
    const last = this.lastEmitted;
    if (last !== null && last.tiles === want.tiles && last.max_quality === want.max_quality) {
      return;
    }
    this.lastEmitted = want;
    this.onWant(want);
  }
}
