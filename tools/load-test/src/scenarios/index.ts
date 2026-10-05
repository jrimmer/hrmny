/**
 * U28 slice 2 — scenario registry.
 *
 * Every scenario is a descriptor + runner. `runScenario(name, ctx)` dispatches
 * by stable name; `scenarioNames()` lists them for the CLI. A scenario whose
 * subject is not shipped throws the canonical "subject not shipped yet" error
 * (see types.ts assertShipped).
 */

import { crashStampedeScenario } from './crash_stampede.js';
import { fanOutLatencyScenario } from './fan_out_latency.js';
import { isolationScenario } from './isolation.js';
import { resumeScenario } from './resume.js';
import { searchFreshnessScenario } from './search_freshness.js';
import { voiceLoadScenario } from '../voice/scenarios/voice_load.js';
import { voiceResumeScenario } from '../voice/scenarios/voice_resume.js';
import { voiceVideoScenario } from '../voice/scenarios/voice_video.js';
import type { ScenarioContext, ScenarioResult, ScenarioRunner } from './types.js';

/** All scenarios, keyed by stable name. */
export const scenarios: Record<string, ScenarioRunner> = {
  [fanOutLatencyScenario.descriptor.name]: fanOutLatencyScenario,
  [isolationScenario.descriptor.name]: isolationScenario,
  [resumeScenario.descriptor.name]: resumeScenario,
  [crashStampedeScenario.descriptor.name]: crashStampedeScenario,
  [searchFreshnessScenario.descriptor.name]: searchFreshnessScenario,
  [voiceLoadScenario.descriptor.name]: voiceLoadScenario,
  [voiceResumeScenario.descriptor.name]: voiceResumeScenario,
  [voiceVideoScenario.descriptor.name]: voiceVideoScenario,
};

/** Stable scenario names (for the CLI / runScenario dispatch). */
export function scenarioNames(): string[] {
  return Object.keys(scenarios);
}

/**
 * Run a scenario by name. Throws `subject not shipped yet (<subject>)` when
 * the scenario's prerequisite is absent (ctx.isShipped false).
 */
export async function runScenario(name: string, ctx: ScenarioContext): Promise<ScenarioResult> {
  const scenario = scenarios[name];
  if (!scenario) {
    throw new Error(`unknown scenario '${name}' (known: ${scenarioNames().join(', ')})`);
  }
  return await scenario.run(ctx);
}
