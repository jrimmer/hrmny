/**
 * @cytale/web — adaptive budget tests (calls V2 plan U4, R7/KTD7/VM2).
 *
 * The fake-stats harness the plan's Approach names: injected sequences pin
 * the ladder's decisions — degrade → step down → hysteresis holds →
 * recover (upshift slower) — plus the parser and the VM2 constants'
 * boundaries (floor 1 / ceiling 25 / initial 9 GO branch).
 */
import { describe, expect, it } from 'vitest';

import {
  AdaptiveBudget,
  DEGRADE_STALLED_BYTES_PER_POLL,
  LADDER_INITIAL_TILES,
  LADDER_MAX_TILES,
  LADDER_MIN_TILES,
  LADDER_UPSHIFT_WINDOWS,
  collectInboundVideoStats,
  type StatsReportLike,
} from './useAdaptiveBudget.js';

function healthy(bytes: number): StatsReportLike {
  return [
    { type: 'inbound-rtp', kind: 'video', freezeCount: 0, jitter: 0.005, bytesReceived: bytes },
  ];
}

function degraded(bytes: number, freezes: number, jitter = 0.02): StatsReportLike {
  return [
    { type: 'inbound-rtp', kind: 'video', freezeCount: freezes, jitter, bytesReceived: bytes },
  ];
}

/**
 * Per-poll report factories — the fake-stats seam's SEQUENCES. Byte counters
 * must GROW across polls (a static count is the stall signature); freeze
 * counters must ACCRUE (a static count means no NEW freezes).
 */
type Feed = (poll: number) => StatsReportLike;

/** Healthy: bytes flowing, no freezes, calm jitter. */
function healthyFeed(base: number): Feed {
  return (i) => healthy(base + (i + 1) * 60_000);
}

/** Freezes accruing (≥1 new freeze inside the window). */
function freezeFeed(base: number): Feed {
  return (i) => degraded(base + (i + 1) * 60_000, i);
}

/** Jitter above the threshold on every poll. */
function jitterFeed(base: number): Feed {
  return (i) => degraded(base + (i + 1) * 60_000, 0, 0.08);
}

/** Bytes crawling under the stall floor. */
function stalledFeed(base: number): Feed {
  return () => healthy(base + 10);
}

describe('collectInboundVideoStats', () => {
  it('extracts inbound-rtp VIDEO rows and tolerates missing freezeCount', () => {
    const report: StatsReportLike = [
      { type: 'inbound-rtp', kind: 'audio', freezeCount: 0, jitter: 0.01, bytesReceived: 5 },
      { type: 'inbound-rtp', kind: 'video', jitter: 0.02, bytesReceived: 1000 },
      { type: 'outbound-rtp', kind: 'video', bytesReceived: 1 },
      { type: 'candidate-pair', state: 'succeeded' },
    ];
    expect(collectInboundVideoStats(report)).toEqual([
      { freezeCount: 0, jitter: 0.02, bytesReceived: 1000 },
    ]);
  });
});

describe('AdaptiveBudget — the ladder sequences (fake stats)', () => {
  function makeBudget(initialStats: StatsReportLike): {
    budget: AdaptiveBudget;
    wants: Array<{ tiles: number; max_quality?: string }>;
    setStats: (report: StatsReportLike) => void;
  } {
    let stats = initialStats;
    const wants: Array<{ tiles: number; max_quality?: string }> = [];
    const budget = new AdaptiveBudget({
      getStats: () => Promise.resolve(stats),
      onWant: (w) => wants.push(w),
    });
    return { budget, wants, setStats: (r) => (stats = r) };
  }

  /** One window: 5 polls then the boundary evaluation. */
  async function window(
    b: { budget: AdaptiveBudget; setStats: (r: StatsReportLike) => void },
    feed: Feed,
  ): Promise<void> {
    for (let i = 0; i < 5; i++) {
      b.setStats(feed(i));
      await b.budget.poll();
    }
    b.budget.evaluateWindow();
  }

  it('VM2 GO constants: initial 9, floor 1, ceiling 25; upshift needs 2 healthy windows', () => {
    expect(LADDER_INITIAL_TILES).toBe(9);
    expect(LADDER_MIN_TILES).toBe(1);
    expect(LADDER_MAX_TILES).toBe(25);
    expect(LADDER_UPSHIFT_WINDOWS).toBe(2);
    expect(DEGRADE_STALLED_BYTES_PER_POLL).toBeGreaterThan(0);
  });

  it('degrade → step down; hysteresis holds during the window; recover upshifts slower', async () => {
    const { budget, wants, setStats } = makeBudget(healthy(1_000_000));

    // Healthy baseline window: 9 stays, no emission (nothing changed).
    await window({ budget, setStats }, healthyFeed(1_000_000));
    expect(budget.getWant()).toEqual({ tiles: 9, max_quality: 'high' });
    expect(wants).toEqual([]);

    // Degraded window (freezes): 9 → 8, quality high → medium.
    await window({ budget, setStats }, freezeFeed(1_300_000));
    expect(budget.getWant()).toEqual({ tiles: 8, max_quality: 'medium' });
    expect(wants.at(-1)).toEqual({ tiles: 8, max_quality: 'medium' });

    // A second degraded window steps down again (the window is the decision
    // unit — the ~10 s hold, never per-poll thrash).
    await window({ budget, setStats }, freezeFeed(1_500_000));
    expect(budget.getWant()).toEqual({ tiles: 7, max_quality: 'low' });

    // Recovery: ONE healthy window is not enough (upshift slower — the
    // streak must reach 2)...
    await window({ budget, setStats }, healthyFeed(1_500_000));
    expect(budget.getWant()).toEqual({ tiles: 7, max_quality: 'low' });
    // ...the SECOND healthy window steps BOTH back up.
    await window({ budget, setStats }, healthyFeed(1_800_000));
    expect(budget.getWant()).toEqual({ tiles: 8, max_quality: 'medium' });
    await window({ budget, setStats }, healthyFeed(2_100_000));
    expect(budget.getWant()).toEqual({ tiles: 9, max_quality: 'high' });
    expect(wants.at(-1)).toEqual({ tiles: 9, max_quality: 'high' });

    // Continued health keeps climbing toward the ceiling (VM2: budget is
    // adaptive, not fixed) — one more step, then check the next emission.
    await window({ budget, setStats }, healthyFeed(2_400_000));
    expect(budget.getWant()).toEqual({ tiles: 10, max_quality: 'high' });
  });

  it('jitter alone degrades; stalled bitrate alone degrades', async () => {
    const { budget, setStats } = makeBudget(healthy(500_000));
    // Jitter spike (0.08 s > 0.05 threshold).
    await window({ budget, setStats }, jitterFeed(700_000));
    expect(budget.getWant().tiles).toBe(8);
    // Stalled bytes: growth under the floor across the window's polls.
    await window({ budget, setStats }, stalledFeed(701_000));
    expect(budget.getWant().tiles).toBe(7);
  });

  it('the floor is stage-only (1) and the ceiling caps at 25', async () => {
    // Floor: 12 consecutive degraded windows from 9 cannot pass 1.
    const low = makeBudget(healthy(100_000));
    for (let i = 0; i < 12; i++) {
      await window(low, freezeFeed(100_000));
    }
    expect(low.budget.getWant().tiles).toBe(1);

    // Ceiling: from initial 9, healthy streaks cannot pass 25 (17 upshifts
    // need 17 windows; run 25 to be sure the cap holds).
    const high = makeBudget(healthy(900_000));
    for (let i = 0; i < 25; i++) {
      await window(high, healthyFeed(900_000));
    }
    expect(high.budget.getWant().tiles).toBe(25);
    // At the cap, further health changes nothing — no emission.
    const before = high.wants.length;
    await window(high, healthyFeed(900_000));
    expect(high.budget.getWant().tiles).toBe(25);
    expect(high.wants.length).toBe(before);
  });

  it('no inbound video (audio-only leg) holds the budget — no opinion, no emission', async () => {
    const { budget, wants, setStats } = makeBudget(healthy(10_000));
    setStats([]); // audio-only leg
    for (let i = 0; i < 5; i++) await budget.poll();
    budget.evaluateWindow();
    expect(budget.getWant()).toEqual({ tiles: 9, max_quality: 'high' });
    expect(wants).toEqual([]);
  });

  it('a failed getStats never degrades on its own (transient RTCP gap)', async () => {
    let fail = false;
    let poll = 0;
    const budget = new AdaptiveBudget({
      getStats: () =>
        fail ? Promise.reject(new Error('rtcp gap')) : Promise.resolve(healthy(50_000 + poll * 60_000)),
      onWant: () => undefined,
    });
    await budget.poll();
    poll++;
    fail = true;
    await budget.poll(); // rejected — no throw, no opinion
    fail = false;
    await budget.poll();
    budget.evaluateWindow();
    expect(budget.getWant().tiles).toBe(9);
  });
});
