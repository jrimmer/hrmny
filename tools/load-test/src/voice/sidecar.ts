/**
 * U13 — Elixir voice-sidecar supervisor.
 *
 * Spawns `mix run --no-halt` in tools/load-test/voice-sidecar with a tokens
 * file + env contract (README there), parses the VOICE_META / VOICE_TICK /
 * VOICE_FINAL stdout lines, and exposes them as a SidecarHandle. First run
 * compiles the mix project (deps are hex-cached; ex_webrtc's NIFs take ~a
 * minute once).
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import type { SidecarHandle, SidecarReport, SidecarRequest } from './types.js';

/** Repo root (…/tools/load-test/src/voice → 4 up). */
export const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
export const SIDECAR_DIR = join(REPO_ROOT, 'tools/load-test/voice-sidecar');

let compileChecked = false;

/** Ensure the sidecar project has deps + a build (idempotent, once per process). */
export function ensureSidecarBuilt(): void {
  if (compileChecked) return;
  for (const args of [['deps.get'], ['compile']]) {
    const res = spawnSync('mix', args, { cwd: SIDECAR_DIR, encoding: 'utf8' });
    if (res.status !== 0) {
      throw new Error(
        `voice sidecar ${args[0]} failed (mix ${args.join(' ')} in ${SIDECAR_DIR}): ${
          res.stderr?.slice(-2000) ?? res.stdout?.slice(-2000) ?? 'no output'
        }`,
      );
    }
  }
  compileChecked = true;
}

/** True when the sidecar can run here (mix on PATH). */
export function sidecarAvailable(): boolean {
  const res = spawnSync('mix', ['--version'], { cwd: SIDECAR_DIR, encoding: 'utf8' });
  return res.status === 0;
}

/** Parse one sidecar stdout line into a report, or null. */
export function parseReportLine(line: string): SidecarReport | null {
  const trimmed = line.trim();
  for (const kind of ['VOICE_META', 'VOICE_TICK', 'VOICE_FINAL'] as const) {
    if (trimmed.startsWith(kind + ' ')) {
      try {
        const json = JSON.parse(trimmed.slice(kind.length + 1)) as SidecarReport;
        return { ...json, type: kind === 'VOICE_META' ? 'meta' : kind === 'VOICE_TICK' ? 'tick' : 'final' };
      } catch {
        return null;
      }
    }
  }
  return null;
}

export interface SidecarDriverOptions {
  /** Directory of the sidecar mix project. */
  cwd?: string;
  /** Extra env (e.g. ETURNAL secret for the TURN leg). */
  env?: Record<string, string>;
}

/**
 * The sidecar env contract as a pure function (U7: unit-testable driver
 * contract — the Elixir sidecar's README is normative). `tokensFile` is
 * where the driver wrote the token array; video fields are omitted entirely
 * when `request.video` is absent (the V1 audio-only env shape).
 */
export function sidecarEnvFor(request: SidecarRequest, tokensFile: string): Record<string, string> {
  const video = request.video;
  return {
    VOICE_TOKENS_FILE: tokensFile,
    VOICE_CHANNEL_ID: request.channelId,
    VOICE_GATEWAY_HOST: request.host,
    VOICE_GATEWAY_PORT: String(request.port),
    VOICE_GATEWAY_PATH: request.path ?? '/gateway/websocket',
    VOICE_DURATION_S: String(request.durationS),
    VOICE_PPS: String(request.pps ?? 50),
    VOICE_TURN_ONLY_COUNT: String(request.turnOnly ?? 0),
    VOICE_TURN_URL: request.turnUrl ?? '',
    VOICE_TURN_SECRET: request.turnSecret ?? '',
    VOICE_LABEL_PREFIX: request.labelPrefix ?? 'v',
    ...(request.participants !== undefined
      ? { VOICE_PARTICIPANTS: String(request.participants) }
      : {}),
    ...(video !== undefined
      ? {
          VOICE_VIDEO: '1',
          ...(video.cameraCount !== undefined
            ? { VOICE_CAMERA_COUNT: String(video.cameraCount) }
            : {}),
          ...(video.screenCount !== undefined
            ? { VOICE_SCREEN_COUNT: String(video.screenCount) }
            : {}),
          ...(video.videoPps !== undefined ? { VOICE_VIDEO_PPS: String(video.videoPps) } : {}),
          ...(video.videoBytes !== undefined
            ? { VOICE_VIDEO_BYTES: String(video.videoBytes) }
            : {}),
          ...(video.publishDelayMs !== undefined
            ? { VOICE_PUBLISH_DELAY_MS: String(video.publishDelayMs) }
            : {}),
          ...(video.tiles !== undefined && Object.keys(video.tiles).length > 0
            ? { VOICE_TILES_JSON: JSON.stringify(video.tiles) }
            : {}),
          ...(video.churnPublishers !== undefined
            ? { VOICE_CHURN_PUBLISHERS: String(video.churnPublishers) }
            : {}),
          ...(video.churnIntervalMs !== undefined
            ? { VOICE_CHURN_INTERVAL_MS: String(video.churnIntervalMs) }
            : {}),
          ...(video.churnRounds !== undefined
            ? { VOICE_CHURN_ROUNDS: String(video.churnRounds) }
            : {}),
        }
      : {}),
  };
}

/** Runs one sidecar session against a live server. */
export class SidecarDriver {
  private readonly cwd: string;
  private readonly extraEnv: Record<string, string>;

  constructor(options: SidecarDriverOptions = {}) {
    this.cwd = options.cwd ?? SIDECAR_DIR;
    this.extraEnv = options.env ?? {};
  }

  async start(request: SidecarRequest): Promise<SidecarHandle> {
    ensureSidecarBuilt();

    const dir = mkdtempSync(join(tmpdir(), 'cytale-voice-'));
    const tokensFile = join(dir, 'tokens.json');
    writeFileSync(tokensFile, JSON.stringify(request.tokens));

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    Object.assign(env, this.extraEnv, sidecarEnvFor(request, tokensFile));

    const child: ChildProcess = spawn('mix', ['run', '--no-halt'], {
      cwd: this.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const reports: SidecarReport[] = [];
    const waiters: Array<{ pred: (r: SidecarReport) => boolean; resolve: (r: SidecarReport) => void }> = [];
    let buffer = '';
    let stderrTail = '';

    let resolveDone: (r: SidecarReport) => void;
    let rejectDone: (err: Error) => void;
    const done = new Promise<SidecarReport>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });

    const feed = (chunk: string): void => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const report = parseReportLine(line);
        if (process.env.LOAD_TEST_DEBUG === '1' && line.trim().length > 0 && !line.includes('[debug]')) {
          // eslint-disable-next-line no-console
          console.error(`[sidecar] ${line.trimEnd().slice(0, 400)}`);
        }
        if (!report) continue;
        reports.push(report);
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i]!.pred(report)) {
            waiters[i]!.resolve(report);
            waiters.splice(i, 1);
          }
        }
        if (report.type === 'final') resolveDone(report);
      }
    };

    child.stdout!.setEncoding('utf8').on('data', feed);
    child.stderr!.setEncoding('utf8').on('data', (d: string) => {
      stderrTail = (stderrTail + d).slice(-4000);
    });
    child.on('error', (err) => rejectDone(new Error(`sidecar spawn failed: ${err.message}`)));
    child.on('close', (code) => {
      if (!reports.some((r) => r.type === 'final')) {
        rejectDone(
          new Error(`sidecar exited (${code}) without VOICE_FINAL\nstderr tail:\n${stderrTail}`),
        );
      }
      rmSync(dir, { recursive: true, force: true });
    });

    const poll = async (pred: (r: SidecarReport) => boolean, timeoutMs: number): Promise<SidecarReport> => {
      const existing = reports.find(pred);
      if (existing) return existing;
      return await new Promise<SidecarReport>((resolve, reject) => {
        const waiter = { pred, resolve };
        waiters.push(waiter);
        const timer = setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error(`sidecar condition not met within ${timeoutMs}ms`));
        }, timeoutMs);
        const origResolve = waiter.resolve;
        waiter.resolve = (r) => {
          clearTimeout(timer);
          origResolve(r);
        };
      });
    };

    return {
      ticks: () => [...reports],
      waitAllConnected: (timeoutMs) =>
        poll((r) => r.type === 'tick' && r.all_connected === true, timeoutMs),
      done,
      kill: () => {
        try {
          child.kill('SIGTERM');
        } catch {
          /* already gone */
        }
      },
    };
  }
}

/** Wait helper used by scenarios (kept beside the driver for reuse). */
export async function waitFor<T>(
  what: string,
  probe: () => T | undefined,
  timeoutMs: number,
  tickMs = 50,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await sleep(tickMs);
  }
}
