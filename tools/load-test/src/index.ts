/**
 * U28 slice 1 — load-test harness entry point.
 *
 * Programmatic API: `runLoadTest(options)` spins up N virtual clients, runs
 * a fan-out round, and returns a LoadTestReport.
 *
 * CLI: `node --experimental-strip-types tools/load-test/src/index.ts --clients 25 --url ws://127.0.0.1:4001/gateway/websocket --token <tok> --channel <id>`
 * prints the human report. The CLI wires the real @cytale/api-client REST
 * seam; the unit test injects an in-process fake.
 */

import { LoadTestHarness, type HarnessOptions } from './harness.js';
import { toHuman, toJson, type LoadTestReport } from './report.js';
import { runScenario, scenarioNames } from './scenarios/index.js';
import { parseGatewayUrl, realVoiceSeam } from './voice/runtime.js';
import { CytaleApiClient, createInMemoryTokenProvider } from '@cytale/api-client';
import type { RestSeam } from './virtual_client.js';

/** Build a REST seam backed by the real @cytale/api-client. */
export function realRestSeam(baseUrl: string, token: string): RestSeam {
  const api = new CytaleApiClient({
    baseUrl,
    tokens: createInMemoryTokenProvider({ access_token: token, refresh_token: '', expires_in: 0 }),
  });
  return {
    async sendMessage(channelId: string, content: string): Promise<string> {
      const message = await api.sendMessage(channelId, { content });
      return message.id;
    },
  };
}

export interface RunOptions {
  clientCount: number;
  url: string;
  token: string;
  channelId: string;
  /** API base URL for the real REST seam (e.g. http://127.0.0.1:4001). */
  apiBaseUrl: string;
  content?: string;
  receiveTimeoutMs?: number;
  /** Optional scenario to run (U28 slice 2); when set, the report carries its result. */
  scenario?: string;
  /** Whether the scenario's subject is shipped (config-gated). */
  scenarioShipped?: boolean;
  /** Scenario knobs (`--set k=v`, repeatable) — U13 voice scenarios. */
  knobs?: Record<string, number | string | boolean>;
  /** TURN config for the sidecar's forced-relay participants (U13 TURN leg). */
  turnUrl?: string;
  turnSecret?: string;
  /** First N sidecar participants are RELAY-only (U13 TURN leg). */
  turnOnly?: number;
}

/**
 * U13 — run a voice_* scenario standalone: provisioning + sidecar + TS
 * signaling clients, no fan-out round (voice scenarios provision their own
 * room and drive everything through the voice seam).
 */
export async function runVoiceScenario(options: RunOptions): Promise<LoadTestReport> {
  const gw = parseGatewayUrl(options.url);
  const voice = realVoiceSeam({
    apiBaseUrl: options.apiBaseUrl,
    gatewayUrl: options.url,
    gatewayHost: gw.host,
    gatewayPort: gw.port,
    gatewayPath: gw.path,
  });

  const start = Date.now();
  const result = await runScenario(options.scenario!, {
    isShipped: true,
    // Voice scenarios never touch the fan-out harness — a loud stub keeps
    // any accidental use honest.
    harness: {
      connectAll: () => Promise.reject(new Error('voice scenarios do not use the fan-out harness')),
      runFanOutRound: () => Promise.reject(new Error('voice scenarios do not use the fan-out harness')),
      connectedCount: 0,
      disconnectClient: () => undefined,
      destroy: () => undefined,
    },
    channelIds: [],
    bounds: {},
    knobs: options.knobs,
    voice: {
      ...voice,
      startSidecar: (request) =>
        voice.startSidecar({
          ...request,
          turnUrl: options.turnUrl,
          turnSecret: options.turnSecret,
          turnOnly: options.turnOnly,
        }),
    },
  });

  return {
    connectionsSustained: 0,
    latency: { p50: 0, p99: 0 },
    fanOutMs: { p50: 0, p99: 0 },
    isolationAssertion: 'pending',
    resumeSuccessRate: typeof result.metrics.resumeSuccessRate === 'number' ? result.metrics.resumeSuccessRate : 0,
    durationMs: Date.now() - start,
    scenarios: { [result.name]: { passed: result.passed, summary: result.summary, metrics: result.metrics } },
  };
}

/** Run a full load-test round and return the report. */
export async function runLoadTest(options: RunOptions): Promise<LoadTestReport> {
  const start = Date.now();
  const harness = new LoadTestHarness({
    clientCount: options.clientCount,
    url: options.url,
    token: options.token,
    rest: realRestSeam(options.apiBaseUrl, options.token),
    channelId: options.channelId,
    content: options.content,
    receiveTimeoutMs: options.receiveTimeoutMs,
  } satisfies HarnessOptions);

  try {
    await harness.connectAll();
    const round = await harness.runFanOutRound();
    const report = harness.buildReport(round, Date.now() - start);

    if (options.scenario) {
      const result = await harness.runScenario(options.scenario, {
        isShipped: options.scenarioShipped ?? false,
        channelIds: [options.channelId],
        bounds: {},
      });
      report.scenarios[result.name] = {
        passed: result.passed,
        summary: result.summary,
        metrics: result.metrics,
      };
      // Fold the scenario's headline metrics into the report's top-level fields.
      if (typeof result.metrics.isolationAssertion === 'string') {
        report.isolationAssertion = result.metrics.isolationAssertion as 'pass' | 'fail' | 'pending';
      }
      if (typeof result.metrics.resumeSuccessRate === 'number') {
        report.resumeSuccessRate = result.metrics.resumeSuccessRate;
      }
    }

    return report;
  } finally {
    harness.destroy();
  }
}

// -- CLI ---------------------------------------------------------------------

function parseArgs(argv: string[]): RunOptions {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  // Repeated --set k=v pairs become scenario knobs (voice_* scenarios).
  const knobs: Record<string, number | string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--set' && argv[i + 1]?.includes('=')) {
      const [k, v] = argv[i + 1]!.split('=');
      if (k !== undefined && v !== undefined) {
        const num = Number(v);
        knobs[k] = v !== '' && Number.isFinite(num) && /^-?\d+(\.\d+)?$/.test(v) ? num : (v as string);
      }
    }
  }
  const clientCount = Number(get('clients') ?? '25');
  const url = get('url') ?? 'ws://127.0.0.1:4001/gateway/websocket';
  const token = get('token') ?? '';
  const channelId = get('channel') ?? '';
  const apiBaseUrl = get('api') ?? 'http://127.0.0.1:4001';
  const scenario = get('scenario');
  const scenarioShipped = get('scenario-shipped') === '1';
  const turnUrl = get('turn-url') ?? process.env.ETURNAL_URL;
  const turnSecret = get('turn-secret') ?? process.env.ETURNAL_SECRET;
  const turnOnlyRaw = get('turn-only');
  const turnOnly = turnOnlyRaw !== undefined ? Number(turnOnlyRaw) : undefined;
  const isVoice = scenario?.startsWith('voice_') === true;
  if (!isVoice && (!token || !channelId)) {
    throw new Error('CLI requires --token and --channel (voice_* scenarios provision their own)');
  }
  if (scenario && !scenarioNames().includes(scenario)) {
    throw new Error(`unknown scenario '${scenario}' (known: ${scenarioNames().join(', ')})`);
  }
  return {
    clientCount,
    url,
    token,
    channelId,
    apiBaseUrl,
    scenario,
    scenarioShipped,
    ...(Object.keys(knobs).length > 0 ? { knobs } : {}),
    ...(turnUrl !== undefined ? { turnUrl } : {}),
    ...(turnSecret !== undefined ? { turnSecret } : {}),
    ...(turnOnly !== undefined && Number.isFinite(turnOnly) ? { turnOnly } : {}),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const report = options.scenario?.startsWith('voice_')
    ? await runVoiceScenario(options)
    : await runLoadTest(options);
  if (process.env.LOAD_TEST_JSON === '1') {
    process.stdout.write(toJson(report) + '\n');
  } else {
    process.stdout.write(toHuman(report) + '\n');
  }
  // A failed scenario is a failed gate — exit non-zero so automation sees it.
  const failed = Object.values(report.scenarios).some((s) => !s.passed);
  if (failed) process.exitCode = 1;
}

// Run only when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
