/**
 * U28 slice 1 — load-test report shape + formatters.
 *
 * The report is the "repeatable load-test result, not a vibe" success
 * criterion: a stable JSON shape that a phase gate can assert on, plus a
 * human-readable formatter for the CLI.
 */

/** Isolation assertion state: pass/fail once the AE1 scenario runs, pending
 * until then (slice 1 arms the fan-out round; isolation is a later slice). */
export type IsolationAssertion = 'pass' | 'fail' | 'pending';

export interface Percentiles {
  p50: number;
  p99: number;
}

export interface LoadTestReport {
  /** Number of virtual clients that connected and stayed connected. */
  connectionsSustained: number;
  /** Per-message receive latency (ms) across all clients. */
  latency: Percentiles;
  /** Fan-out time (ms) from sender post to each client's receipt. */
  fanOutMs: Percentiles;
  /** AE1 isolation assertion (armed in slice 1, asserted in a later slice). */
  isolationAssertion: IsolationAssertion;
  /** AE2 resume success rate (0..1); 0 until the resume scenario runs. */
  resumeSuccessRate: number;
  /** Wall-clock duration of the run (ms). */
  durationMs: number;
  /** Per-scenario results (U28 slice 2); empty until a scenario runs. */
  scenarios: Record<string, { passed: boolean; summary: string; metrics: Record<string, number | string | boolean> }>;
}

/** Sort a numeric array ascending (does not mutate the input). */
export function sorted(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

/** p-th percentile (0..100) of a sorted array, linear interpolation. */
export function percentile(sortedValues: readonly number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0]!;
  const idx = (p / 100) * (sortedValues.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedValues[lo]!;
  const frac = idx - lo;
  return sortedValues[lo]! + (sortedValues[hi]! - sortedValues[lo]!) * frac;
}

/** Compute p50/p99 from an unsorted sample. */
export function percentiles(values: readonly number[]): Percentiles {
  const s = sorted(values);
  return { p50: percentile(s, 50), p99: percentile(s, 99) };
}

/** JSON form of the report (the machine-consumable contract). */
export function toJson(report: LoadTestReport): string {
  return JSON.stringify(report, null, 2);
}

/** Human-readable form for the CLI / README. */
export function toHuman(report: LoadTestReport): string {
  const lines = [
    'Cytale load-test report',
    '-----------------------',
    `connections sustained : ${report.connectionsSustained}`,
    `latency p50/p99 (ms)  : ${report.latency.p50.toFixed(1)} / ${report.latency.p99.toFixed(1)}`,
    `fan-out p50/p99 (ms)  : ${report.fanOutMs.p50.toFixed(1)} / ${report.fanOutMs.p99.toFixed(1)}`,
    `isolation assertion   : ${report.isolationAssertion}`,
    `resume success rate   : ${(report.resumeSuccessRate * 100).toFixed(1)}%`,
    `duration (ms)         : ${report.durationMs}`,
    ...Object.entries(report.scenarios).map(([name, r]) => `scenario ${name}      : ${r.passed ? 'PASS' : 'FAIL'} — ${r.summary}`),
  ];
  return lines.join('\n');
}
