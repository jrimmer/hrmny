#!/usr/bin/env tsx
/**
 * Local, end-to-end updater proof (forgejo #50 acceptance).
 *
 * Proves ON THIS MACHINE, with NO network beyond loopback and NO touching
 * the real Forgejo feed: an older build detects a newer one on an update
 * feed, downloads it, VERIFIES its minisign signature against the pubkey
 * baked into tauri.conf.json, installs it, and — after a relaunch of the
 * REPLACED bundle — reports the new version.
 *
 *   pnpm exec tsx apps/desktop/e2e/updater-proof.mts
 *
 * What it does:
 *   1. serves a throwaway static feed on 127.0.0.1:<ephemeral>;
 *   2. builds version 0.0.1-test ("A") with the updater endpoint overridden
 *      to that feed (`--config` merge, the same mechanism the CI fallback
 *      uses), SIGNED with the real key (TAURI_SIGNING_PRIVATE_KEY);
 *   3. builds version 0.0.2-test ("B"), signed the same; its
 *      Hrmny.app.tar.gz + .sig become the feed payload (latest.json with the
 *      darwin-aarch64/darwin-x86_64 key matching this Mac);
 *   4. copies A into a scratch install dir and launches its binary with
 *      CYTALE_UPDATER_SELFTEST=1 — the shell's dev-only selftest
 *      (src-tauri/src/updater_selftest.rs, debug builds only) walks the
 *      production updater path and prints UPDATER_SELFTEST stages to stdout;
 *   5. asserts every stage, relaunches the replaced bundle, and asserts it
 *      now reports 0.0.2-test with nothing newer offered;
 *   6. cleans up: server closed, scratch dir removed (UPDATER_PROOF_KEEP=1
 *      keeps it for debugging). Build artifacts live under a PRIVATE cargo
 *      target dir (src-tauri/target/updater-proof) so the e2e bundle in
 *      target/debug is never clobbered.
 *
 * Env: TAURI_SIGNING_PRIVATE_KEY (defaults to ~/.tauri/cytale-updater.key;
 *      the file is only ever REFERENCED, its contents are never printed),
 *      UPDATER_PROOF_KEEP.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { resolve } from 'node:path';

const DESKTOP = resolve('apps/desktop');
const TAURI = resolve(DESKTOP, 'src-tauri');
const PROOF_TARGET = resolve(TAURI, 'target/updater-proof');
const BUNDLE_DIR = resolve(PROOF_TARGET, 'debug/bundle/macos');
const BINARY = resolve(BUNDLE_DIR, 'Hrmny.app/Contents/MacOS/cytale-desktop');
const KEY_DEFAULT = resolve(homedir(), '.tauri/cytale-updater.key');

const STAGE_TIMEOUT_MS = 180_000;
const VERSION_A = '0.0.1-test';
const VERSION_B = '0.0.2-test';

function fail(message: string): never {
  console.error(`\n✗ updater proof: ${message}`);
  process.exit(1);
}

const t0 = Date.now();
const log = (line: string) => console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ${line}`);

interface StaticServer {
  port: number;
  close: () => void;
}

/** A dumb static file server on loopback — the stand-in for the Forgejo feed. */
function serveStatic(root: string): Promise<StaticServer> {
  const types: Record<string, string> = {
    '.json': 'application/json',
    '.gz': 'application/gzip',
    '.sig': 'application/octet-stream',
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const name = new URL(req.url ?? '/', 'http://127.0.0.1').pathname.slice(1);
    const file = resolve(root, name);
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    readFile(file)
      .then((body) => {
        res.writeHead(200, {
          'content-type': types[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream',
        });
        res.end(body);
      })
      .catch(() => res.writeHead(404).end());
  });
  return new Promise((res) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      res({ port: typeof addr === 'object' && addr ? addr.port : 0, close: () => server.close() });
    });
  });
}

/** tauri build with a config merge on top of the committed tauri.conf.json. */
async function tauriBuild(version: string, feedUrl: string): Promise<void> {
  const override = JSON.stringify({
    version,
    plugins: { updater: { endpoints: [feedUrl] } },
    // The proof exercises the SHELL and the updater, not the SPA: skip the
    // beforeBuildCommand and bundle whatever was last built into apps/web/dist.
    // (A parallel session's in-flight edits can leave the web tree transiently
    // non-compiling; the selftest never needs the webview's content.)
    build: { beforeBuildCommand: '' },
  });
  const child = spawn('pnpm', ['exec', 'tauri', 'build', '--debug', '--bundles', 'app', '-c', override], {
    cwd: DESKTOP,
    env: {
      ...process.env,
      CARGO_TARGET_DIR: PROOF_TARGET,
      // The signing key is passed BY PATH; the CLI reads the file itself.
      TAURI_SIGNING_PRIVATE_KEY: SIGNING_KEY,
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let tail = '';
  child.stdout?.on('data', (b: Buffer) => (tail = (tail + b.toString()).slice(-4000)));
  child.stderr?.on('data', (b: Buffer) => (tail = (tail + b.toString()).slice(-4000)));
  const code = await new Promise<number>((res) => child.on('exit', (c) => res(c ?? -1)));
  if (code !== 0) fail(`tauri build ${version} exited ${code}\n--- tail ---\n${tail}`);
}

interface SelftestRun {
  code: number | null;
  lines: string[];
}

/** Launch the shell with the selftest switch; collect UPDATER_SELFTEST lines. */
function launchSelftest(binary: string, doneMarker?: string): Promise<SelftestRun> {
  return new Promise((res) => {
    const child: ChildProcess = spawn(
      binary,
      [],
      { env: { ...process.env, CYTALE_UPDATER_SELFTEST: '1' }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const lines: string[] = [];
    let settling = false;
    const settle = (code: number | null) => {
      if (settling) return;
      settling = true;
      res({ code, lines });
    };
    child.stdout?.on('data', (b: Buffer) => {
      for (const line of b.toString().split('\n')) {
        if (!line) continue;
        console.log(`    app: ${line}`);
        if (line.includes('UPDATER_SELFTEST')) {
          lines.push(line);
          // The install run exits on its own; the relaunch reports UP_TO_DATE
          // and would happily keep running — stop it at the verdict.
          if (doneMarker && line.includes(doneMarker)) {
            setTimeout(() => child.kill('SIGTERM'), 250).unref();
          }
        }
      }
    });
    child.stderr?.on('data', (b: Buffer) => process.stdout.write(`    app!: ${b.toString()}`));
    child.on('exit', (code) => settle(code));
    // A hang means something stalled; give the whole run a hard stop.
    setTimeout(() => {
      child.kill('SIGKILL');
      settle(null);
    }, STAGE_TIMEOUT_MS).unref();
  });
}

function requireStage(lines: string[], marker: string): string {
  const hit = lines.find((l) => l.includes(marker));
  if (!hit) fail(`stage "${marker}" never appeared in the selftest output`);
  return hit;
}

const SIGNING_KEY = process.env.TAURI_SIGNING_PRIVATE_KEY ?? KEY_DEFAULT;

async function main(): Promise<void> {
  if (!existsSync(SIGNING_KEY)) {
    fail(`no signing key at ${SIGNING_KEY} (set TAURI_SIGNING_PRIVATE_KEY to the key FILE path)`);
  }
  if (!existsSync(resolve(TAURI, 'tauri.conf.json'))) fail(`run from the repo root (no ${TAURI})`);
  if (!existsSync(resolve(TAURI, '../../web/dist/index.html'))) {
    fail('apps/web/dist is empty — build the SPA once first: pnpm --filter @cytale/web build');
  }

  const work = resolve(tmpdir(), 'cytale-updater-proof');
  await rm(work, { recursive: true, force: true });
  const install = resolve(work, 'install');
  const feedDir = resolve(work, 'feed');

  const feed = await serveStatic(feedDir);
  const feedUrl = `http://127.0.0.1:${feed.port}/latest.json`;
  console.log(`updater proof: A ${VERSION_A} → B ${VERSION_B}, feed ${feedUrl}`);

  // 1+2. Build A against the throwaway feed.
  log(`building A (${VERSION_A}, signed, endpoint=${feedUrl}) …`);
  await tauriBuild(VERSION_A, feedUrl);

  // Snapshot A IMMEDIATELY: build B reuses the same bundle path and would
  // clobber it (learned the hard way — the "old" install launched as B).
  await cp(resolve(BUNDLE_DIR, 'Hrmny.app'), resolve(install, 'Hrmny.app'), { recursive: true });

  // 3. Build B; its updater artifact is the payload.
  log(`building B (${VERSION_B}, signed) …`);
  await tauriBuild(VERSION_B, feedUrl);

  const payload = resolve(BUNDLE_DIR, 'Hrmny.app.tar.gz');
  const sigFile = resolve(BUNDLE_DIR, 'Hrmny.app.tar.gz.sig');
  if (!existsSync(payload) || !existsSync(sigFile)) {
    fail('build B produced no signed updater artifact (Hrmny.app.tar.gz[.sig])');
  }
  // This Mac's updater target key: darwin-aarch64 / darwin-x86_64.
  const platformKey = `darwin-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`;
  await mkdir(feedDir, { recursive: true });
  await cp(payload, resolve(feedDir, 'Hrmny.app.tar.gz'));
  await writeFile(
    resolve(feedDir, 'latest.json'),
    JSON.stringify(
      {
        version: VERSION_B,
        notes: `updater proof (${VERSION_B}) — local-only feed`,
        pub_date: new Date().toISOString(),
        platforms: {
          [platformKey]: {
            signature: (await readFile(sigFile, 'utf8')).trim(),
            url: `http://127.0.0.1:${feed.port}/Hrmny.app.tar.gz`,
          },
        },
      },
      null,
      2,
    ) + '\n',
  );
  log(`feed live: platforms.${platformKey} → ${VERSION_B} (127.0.0.1:${feed.port})`);

  const installedBinary = resolve(install, 'Hrmny.app/Contents/MacOS/cytale-desktop');
  log(`launching A (version ${VERSION_A}) with CYTALE_UPDATER_SELFTEST=1 …`);
  const first = await launchSelftest(installedBinary);

  const current = requireStage(first.lines, 'current_version=');
  if (!current.includes(`current_version=${VERSION_A}`)) fail(`A reports "${current.trim()}"`);
  requireStage(first.lines, `DETECTED current=${VERSION_A} available=${VERSION_B}`);
  requireStage(first.lines, `DOWNLOAD url=http://127.0.0.1:${feed.port}/Hrmny.app.tar.gz`);
  requireStage(first.lines, 'SIGNATURE_VERIFIED');
  requireStage(first.lines, `INSTALLED version=${VERSION_B}`);
  requireStage(first.lines, 'EXITING_FOR_RELAUNCH');
  if (first.code !== 0) fail(`A exited ${first.code} after a clean selftest transcript`);
  log('A: detected → downloaded → SIGNATURE VERIFIED → installed ✓ (bundle replaced in place)');

  // 5. Relaunch the REPLACED bundle: the acceptance's "newer build reports".
  log('relaunching the replaced bundle …');
  const second = await launchSelftest(installedBinary, 'UP_TO_DATE');
  const relaunch = requireStage(second.lines, 'current_version=');
  if (!relaunch.includes(`current_version=${VERSION_B}`)) fail(`relaunch reports "${relaunch.trim()}"`);
  requireStage(second.lines, `UP_TO_DATE version=${VERSION_B}`);
  spawn('pkill', ['-f', install]);

  console.log(
    `\n✓ updater proof pass — ${VERSION_A} checked the local feed, detected ${VERSION_B}, ` +
      'downloaded it, the minisign signature verified against the baked pubkey, the bundle was replaced, ' +
      `and the relaunched app reports ${VERSION_B} with nothing newer offered`,
  );

  // 6. Cleanup: server down; scratch dir gone unless kept.
  feed.close();
  if (process.env.UPDATER_PROOF_KEEP === '1') {
    console.log(`kept scratch dir: ${work} (UPDATER_PROOF_KEEP=1); build tree: ${PROOF_TARGET}`);
  } else {
    await rm(work, { recursive: true, force: true });
    await rm(PROOF_TARGET, { recursive: true, force: true });
    console.log('cleaned up (scratch dir + private build tree)');
  }
}

main().catch((err: unknown) => fail(err instanceof Error ? (err.stack ?? err.message) : String(err)));
