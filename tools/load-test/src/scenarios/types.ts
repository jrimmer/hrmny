/**
 * U28 slice 2 — shared scenario types.
 *
 * A scenario is a named, config-gated load-test exercise: a descriptor (name,
 * description, the subject it proves) plus a runner that measures and asserts
 * against a harness. Every runner is gated on `isShipped` — when the subject
 * (e.g. U11 workspace fan-out) is not deployed, the runner throws a clear
 * "subject not shipped yet" error instead of guessing. The measurement and
 * assertion logic is written and unit-testable against the fake gateway; the
 * gate is what keeps a scenario from running against a server that lacks its
 * subject.
 */

/** Static identity of a scenario. */
export interface ScenarioDescriptor {
  /** Stable machine name (used by `runScenario(name)` and the CLI). */
  name: string;
  /** One-line human description. */
  description: string;
  /** The subject this scenario proves (e.g. 'U11 workspace fan-out'). */
  subject: string;
  /** Config key that gates this scenario's execution. */
  gateKey: string;
}

/** Free-form measured values a scenario reports (numbers, flags, labels). */
export interface ScenarioMetrics {
  [key: string]: number | string | boolean;
}

/** A completed scenario run. */
export interface ScenarioResult {
  name: string;
  passed: boolean;
  /** Human-readable one-line summary. */
  summary: string;
  metrics: ScenarioMetrics;
}

/**
 * Minimal harness surface a scenario drives. Structural (not a runtime import
 * of LoadTestHarness) so scenario modules never create an import cycle with
 * the harness — the real LoadTestHarness satisfies it structurally.
 */
export interface ScenarioHarness {
  connectAll(): Promise<void>;
  runFanOutRound(): Promise<{
    messageId: string;
    fanOutLatencies: number[];
    receivedCount: number;
  }>;
  connectedCount: number;
  disconnectClient(index: number): void;
  destroy(): void;
}

/** Everything a scenario needs to run. */
export interface ScenarioContext {
  /** True when the scenario's subject is shipped (config-gated). */
  isShipped: boolean;
  /** The harness (real or fake) the scenario drives. */
  harness: ScenarioHarness;
  /** Channel ids for multi-workspace scenarios (A, B, ...). */
  channelIds: string[];
  /** Latency/recovery bounds (ms) the scenario asserts against. */
  bounds: Record<string, number>;
  /** Extra scenario-specific knobs (durations, counts). */
  knobs?: Record<string, number | string | boolean>;
  /**
   * U13 voice seam: provisioning (real REST) + the Elixir sidecar driver.
   * Present when the CLI runs a voice-* scenario against a live server;
   * absent in unit tests (which inject their own seam) and on hosts without
   * the voice subject shipped.
   */
  voice?: import('../voice/types.js').VoiceSeam;
}

/** A scenario: descriptor + runner. */
export interface ScenarioRunner {
  descriptor: ScenarioDescriptor;
  run(ctx: ScenarioContext): Promise<ScenarioResult>;
}

/**
 * Gate: throw the canonical "subject not shipped yet" error when the
 * scenario's prerequisite is absent. The subject string carries the unit id
 * (e.g. 'U11 workspace fan-out') so the operator knows what to deploy.
 */
export function assertShipped(ctx: ScenarioContext, subject: string): void {
  if (!ctx.isShipped) {
    throw new Error(`subject not shipped yet (${subject})`);
  }
}
