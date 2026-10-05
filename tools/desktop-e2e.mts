#!/usr/bin/env tsx
/**
 * Desktop in-shell e2e runner.
 *
 * Drives a REAL packaged Tauri shell through login → open channel → send a
 * message → read it back, then proves the `cytale://` deep links (forgejo
 * #50). macOS has no WebDriver for WKWebView (tauri-driver is
 * Windows/Linux only), so the app drives itself: an e2e web build bundles
 * `apps/web/src/e2e/driver.ts` (see `.env.e2e`), and this runner owns the
 * inputs + collects the report over a loopback control channel.
 *
 * Two phases, one run:
 *   1. classic — login → open channel → send a message → read it back.
 *   2. deep-link (#50) — `cytale://workspace/{w}/channel/{c}/message/{m}`
 *      must land on that message, BOTH delivery paths, at the OS level:
 *        cold start: `open -a <e2e bundle> <url>` launches the not-running
 *          app WITH the link (LaunchServices openURLs → the shell's retained
 *          pending URL → hash at boot, before login);
 *        running instance: a second `open -a <bundle> <url>` while the app
 *          is up (LS hands the URL to the live process → the shell's
 *          `cytale-deep-link` event → the listener rewrites the hash).
 *      The plugin treats argv as a deep link on Windows/Linux only, so on
 *      macOS LaunchServices is the only OS-level delivery — and proving it
 *      proves both paths. Skip with E2E_SKIP_DEEPLINK=1.
 *
 * Prerequisites:
 *   1. a server built from current main, reachable at E2E_API_ORIGIN with the
 *      CORS allowlist (defaults include tauri://localhost). A dedicated
 *      instance keeps the dev servers untouched:
 *        PORT=4102 SEARCH_INDEX_ROOT=/tmp/cytale-e2e-search \
 *        SECRET_KEY_BASE=… AUTH_JWT_SECRET=… AUTH_REFRESH_PEPPER=… \
 *        CYTALE_SCYLLA_NODES=127.0.0.1:9042 mix phx.server
 *   2. an e2e desktop build pointed at that origin:
 *        VITE_CYTALE_ORIGIN=http://127.0.0.1:4102 \
 *        pnpm --filter @cytale/desktop exec tauri build --debug --bundles app \
 *          -c '{"build":{"beforeBuildCommand":"pnpm --filter @cytale/web exec vite build --mode e2e"}}'
 *
 * Usage: pnpm exec tsx tools/desktop-e2e.mts
 *
 * Env: E2E_API_ORIGIN, E2E_APP (binary path), E2E_CONTROL_PORT, E2E_TIMEOUT_MS.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';

const API_ORIGIN = process.env.E2E_API_ORIGIN ?? 'http://127.0.0.1:4102';
const CONTROL_PORT = Number(process.env.E2E_CONTROL_PORT ?? 4199);
// Overall budget for the whole run, not per step. A seeded cold run spends
// most of it before the first assertion: session reset + reload, login, a
// 2.5s rail-icon settle, channel open, a 1.5s typing settle and (on the
// bridge fallback) another 1.5s. At 150s the post-send row assertion was the
// step that got cut off — the message had already returned 201 and the
// composer had cleared, so the budget, not the app, was the failure.
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 300_000);
const APP_BINARY = resolve(
  process.env.E2E_APP ??
    'apps/desktop/src-tauri/target/debug/bundle/macos/Hrmny.app/Contents/MacOS/cytale-desktop',
);
/** The bundle directory the binary lives in — what `open -a` targets. */
const APP_BUNDLE = APP_BINARY.split('/').slice(0, -3).join('/');
const MAILBOX = resolve('apps/server/tmp/dev_mailbox.jsonl');

const PASSWORD = 'e2e-desktop-1!';

interface Report {
  tag: string;
  data: Record<string, string>;
}

function fail(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${API_ORIGIN}/api/v1${path}`, init);
  return res;
}

async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await api(path, init);
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/** Fresh verified account through the API + the dev-mailer mailbox. */
async function seedUser(): Promise<{ username: string; password: string; token: string }> {
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const username = `e2e_desktop_${suffix}`;
  const email = `${username}@e2e.local`;

  const register = await api('/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, email, password: PASSWORD }),
  });
  if (register.status !== 201) {
    throw new Error(`register → ${register.status} ${await register.text()}`);
  }

  const token = await waitForVerifyToken(email);
  const verify = await api('/auth/verify-email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!verify.ok) throw new Error(`verify → ${verify.status} ${await verify.text()}`);

  const login = await apiJson<{ access_token: string }>('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: username, password: PASSWORD }),
  });

  return { username, password: PASSWORD, token: login.access_token };
}

/** The dev mailer appends JSONL; poll briefly for this registration's token. */
async function waitForVerifyToken(email: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const lines = readFileSync(MAILBOX, 'utf8').trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const entry = JSON.parse(lines[i]!) as { to?: string; token?: string };
        if (entry.to === email && entry.token) return entry.token;
      }
    } catch {
      /* mailbox not written yet */
    }
    if (Date.now() > deadline) throw new Error(`no verify token for ${email} in ${MAILBOX}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function seedWorkspace(token: string): Promise<{ wsId: string; chId: string }> {
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  const ws = await apiJson<{ workspace: { id: string } }>('/workspaces', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: `desktop-e2e-${Date.now().toString(36)}` }),
  });
  const ch = await apiJson<{ channel: { id: string } }>(
    `/workspaces/${ws.workspace.id}/channels`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'e2e' }),
    },
  );
  return { wsId: ws.workspace.id, chId: ch.channel.id };
}

/** A message seeded straight through the API — the deep-link targets need ids. */
async function seedMessage(token: string, chId: string, content: string): Promise<string> {
  const res = await apiJson<{ message: { id: string } }>(`/channels/${chId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ content }),
  });
  return res.message.id;
}

/** The permalink URL the OS hands the shell (#50): `cytale://workspace/…/message/…`. */
function deepLink(wsId: string, chId: string, messageId: string): string {
  return `cytale://workspace/${wsId}/channel/${chId}/message/${messageId}`;
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr?.on('data', (b: Buffer) => (err += b.toString()));
    child.on('exit', (code) => (code === 0 ? res() : rej(new Error(`${cmd} exited ${code}: ${err}`))));
  });
}

/** Kill any e2e-bundle instance and wait until LaunchServices sees none. */
async function killE2EApp(): Promise<void> {
  const deadline = Date.now() + 10_000;
  spawn('pkill', ['-f', APP_BUNDLE]);
  for (;;) {
    const alive = spawn('pgrep', ['-f', APP_BUNDLE]);
    const gone = await new Promise<boolean>((res) => {
      alive.on('exit', (code) => res(code !== 0));
      alive.on('error', () => res(true));
    });
    if (gone) return;
    if (Date.now() > deadline) return; // best effort; the next launch would collide
    await new Promise((r) => setTimeout(r, 500));
  }
}

function startControlServer(onReport: (r: Report) => void) {
  // Swapped between phases: each app launch reads the config once, at boot.
  let currentConfig: unknown = {};
  // S-4: this server mutates run state (GET /report) and serves the run's
  // CREDENTIALS (GET /config) on a loopback port any page in the operator's
  // browser can reach. CORS never blocked cross-origin WRITES, and the old
  // `access-control-allow-origin: *` additionally let such a page READ
  // /config. So the control plane is now gated three ways:
  //   * Host must be exactly 127.0.0.1:<port> — a DNS-rebinding page arrives
  //     with the attacker's host and is refused before CORS even applies.
  //   * A request that ANNOUNCES a foreign Origin is refused outright — this
  //     is what kills the no-cors `fetch('…/report?tag=fail')` write, which
  //     ACAO never prevented. (Announcing = header present; the runner's own
  //     curl probes and the app's webview fetches are handled below.)
  //   * ACAO is reflected ONLY for the app-under-test's webview origin, so
  //     the driver can still read /config while every other origin gets an
  //     opaque (unreadable) response under the same-origin policy.
  // Residual risk, documented: a NON-browser local process (or forged
  // headers outside a real browser) can still call the endpoints — the
  // per-run shared secret that would close this cannot be delivered inside
  // this file's scope: the token must reach the webview JS (a Tauri env
  // bridge + apps/web/src/e2e/driver.ts change), and the deep-link phase's
  // cold start is launched by LaunchServices (`open -a`), which passes no
  // spawner environment to the app at all.
  const WEBVIEW_ORIGINS = ['tauri://localhost', 'http://tauri.localhost'];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${CONTROL_PORT}`);
    if (req.headers.host !== `127.0.0.1:${CONTROL_PORT}`) {
      res.writeHead(403).end();
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !WEBVIEW_ORIGINS.includes(origin)) {
      res.writeHead(403).end();
      return;
    }
    if (origin !== undefined) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'origin');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === '/config') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(currentConfig));
      return;
    }
    if (url.pathname === '/report') {
      const data: Record<string, string> = {};
      for (const [k, v] of url.searchParams) if (k !== 'tag') data[k] = v;
      const report = { tag: url.searchParams.get('tag') ?? 'unknown', data };
      onReport(report);
      res.writeHead(204).end();
      return;
    }
    res.writeHead(404).end();
  });
  const handle = {
    listen: () =>
      new Promise<typeof handle>((res) => server.listen(CONTROL_PORT, '127.0.0.1', () => res(handle))),
    serveConfig: (config: unknown) => (currentConfig = config),
    close: () => server.close(),
  };
  return handle;
}

async function main(): Promise<void> {
  const smoke = process.env.E2E_SKIP_SEED === '1';
  console.log(`desktop e2e → ${API_ORIGIN} (control :${CONTROL_PORT})${smoke ? ' [smoke]' : ''}`);

  const health = await fetch(`${API_ORIGIN}/health`).catch(() => null);
  if (!health?.ok) fail(`no server at ${API_ORIGIN} — start the e2e instance first (see header)`);

  // Smoke mode targets a deployment we cannot seed (no dev mailbox): the app
  // logs in with a deliberately invalid account and a 401 proves the shell
  // reached the server (a CORS/network failure reads differently).
  // E2E_USER/E2E_PASS/E2E_WS/E2E_CH (optionally E2E_TOKEN) drive a
  // pre-provisioned account — production, where the dev mailbox is not on
  // this machine.
  const preset = {
    username: process.env.E2E_USER ?? '',
    password: process.env.E2E_PASS ?? '',
    wsId: process.env.E2E_WS ?? '',
    chId: process.env.E2E_CH ?? '',
    token: process.env.E2E_TOKEN ?? '',
  };
  const hasPreset = Boolean(preset.username && preset.password && preset.wsId && preset.chId);

  const user = smoke
    ? { username: 'e2e_smoke_no_such_user', password: 'wrong-password-1!', token: '' }
    : hasPreset
      ? { username: preset.username, password: preset.password, token: preset.token }
      : await seedUser();
  const { wsId, chId } = smoke
    ? { wsId: '0', chId: '0' }
    : hasPreset
      ? { wsId: preset.wsId, chId: preset.chId }
      : await seedWorkspace(user.token);
  const message = `desktop e2e ${new Date().toISOString()}`;
  if (!smoke && hasPreset) console.log(`using preset account ${user.username} ws=${wsId} ch=${chId}`);
  if (!smoke && !hasPreset) console.log(`seeded ${user.username} ws=${wsId} ch=${chId}`);

  // Phase dispatcher: each phase installs its own settle promise; the control
  // server routes every driver report here.
  type Phase = 'classic' | 'deep-link';
  let phase: Phase = 'classic';
  let settle: (r: Report) => void = () => {};
  let outcome = new Promise<Report>((res) => (settle = res));
  const seen: string[] = [];
  let coldHashSeen = false;
  let coldLandedSeen = false;

  const server = await startControlServer((report) => {
    seen.push(report.tag);
    const detail = Object.keys(report.data).length > 0 ? ` ${JSON.stringify(report.data)}` : '';
    console.log(`  driver: ${report.tag}${detail}`);
    if (phase === 'deep-link') {
      // The two #50 assertions the OS owns: the hash must already name the
      // message BEFORE login (cold start = pending-URL handover at boot),
      // and a second link must land while the instance is up (live event).
      if (report.tag === 'deeplink-cold-hash') coldHashSeen = true;
      if (report.tag === 'deeplink-cold-landed') {
        coldLandedSeen = true;
        // The app is up and the cold link landed: deliver the second URL to
        // the LIVE instance (LaunchServices hands it to the running app).
        void deliverLiveLink(liveUrl);
      }
      if (report.tag === 'pass' || report.tag === 'fail') settle(report);
      return;
    }
    if (report.tag === 'pass' || report.tag === 'fail') settle(report);
  }).listen();

  server.serveConfig({ username: user.username, password: user.password, wsId, chId, message });

  // --------------------------------------------------------------- phase 1
  // Classic: login → channel → send → transcript, in the packaged shell.
  const child: ChildProcess = spawn(APP_BINARY, [], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('error', (err) =>
    settle({ tag: 'fail', data: { error: `spawn ${APP_BINARY}: ${err.message}` } }),
  );
  child.stdout?.on('data', (b: Buffer) => process.stdout.write(`  app: ${b.toString()}`));
  child.stderr?.on('data', (b: Buffer) => process.stdout.write(`  app! ${b.toString()}`));

  let report = await withTimeout(outcome, 'classic');
  await stopApp(child);

  if (smoke) {
    const error = report.data.error ?? '';
    if (/Wrong username\/email or password/i.test(error)) {
      console.log('\n✓ smoke pass — the packaged shell reached the deployment and got a 401 (not a network/CORS error)');
      console.log(`  steps: ${seen.join(' → ')}`);
      server.close();
      return;
    }
    server.close();
    fail(`smoke failed: ${error || '(no error reported)'}\n  steps: ${seen.join(' → ')}`);
  }

  if (report.tag !== 'pass') {
    server.close();
    fail(`driver reported ${report.tag}: ${report.data.error ?? '(no error)'}\n  steps: ${seen.join(' → ')}`);
  }
  console.log(`\n✓ classic pass — logged in as ${user.username}, sent "${message}", saw it in the transcript`);
  console.log(`  steps: ${seen.join(' → ')}`);

  // --------------------------------------------------------------- phase 2
  // Deep links (#50), macOS only: LaunchServices owns BOTH delivery paths —
  // `open -a <bundle> <url>` on a not-running app is the cold start; the
  // same command against the RUNNING instance is the live handoff. (The
  // plugin treats argv as a deep link on Windows/Linux only; macOS
  // exclusively consumes LS openURLs events.)
  if (process.platform !== 'darwin') {
    console.log('\n(skipping deep-link phase: LaunchServices delivery is macOS-only here)');
    server.close();
    return;
  }
  if (process.env.E2E_SKIP_DEEPLINK === '1') {
    console.log('\n(skipping deep-link phase: E2E_SKIP_DEEPLINK=1)');
    server.close();
    return;
  }
  if (!user.token) {
    console.log('\n(skipping deep-link phase: no API token to seed the target messages with)');
    server.close();
    return;
  }

  const coldMessage = `deeplink cold ${new Date().toISOString()}`;
  const liveMessage = `deeplink live ${new Date().toISOString()}`;
  const coldId = await seedMessage(user.token, chId, coldMessage);
  const liveId = await seedMessage(user.token, chId, liveMessage);
  const coldUrl = deepLink(wsId, chId, coldId);
  const liveUrl = deepLink(wsId, chId, liveId);
  console.log(`\ndeep-link phase\ncold start: ${coldUrl}\nrunning:    ${liveUrl}`);

  server.serveConfig({
    username: user.username,
    password: user.password,
    wsId,
    chId,
    message: '',
    scenario: 'deep-link',
    deepLink: {
      coldMessageId: coldId,
      coldMessage,
      liveMessageId: liveId,
      liveMessage,
    },
  });

  async function deliverLiveLink(url: string): Promise<void> {
    if (!url) return;
    console.log(`  → app is running; delivering the second link to the LIVE instance`);
    try {
      await run('open', ['-a', APP_BUNDLE, url]);
    } catch (err) {
      settle({ tag: 'fail', data: { error: `open (live) failed: ${String(err)}` } });
    }
  }

  await killE2EApp();
  outcome = new Promise<Report>((res) => (settle = res));
  phase = 'deep-link';
  try {
    // COLD START: the app is not running; LaunchServices launches it WITH
    // the URL. The URL rides the OS openURLs event, is held by the shell's
    // PendingDeepLink, and is handed to the webview at boot.
    await run('open', ['-a', APP_BUNDLE, coldUrl]);
  } catch (err) {
    server.close();
    fail(`open (cold start) failed: ${String(err)}\n  is ${APP_BUNDLE} the fresh e2e build?`);
  }

  report = await withTimeout(outcome, 'deep-link');
  await killE2EApp();
  server.close();

  if (report.tag !== 'pass') {
    fail(
      `deep-link phase reported ${report.tag}: ${report.data.error ?? '(no error)'}\n` +
        `  steps: ${seen.join(' → ')}`,
    );
  }
  if (!coldHashSeen) {
    fail('deep-link phase passed but the COLD-START evidence (hash before login) was never reported');
  }
  if (!coldLandedSeen) {
    fail('deep-link phase passed but the cold landing was never reported');
  }

  console.log('\n✓ deep-link pass — cold start landed on the linked message before login,');
  console.log('  and the running instance landed on a second link via the live event');
  console.log(`  steps: ${seen.filter((t) => t.startsWith('deeplink') || t === 'pass').join(' → ')}`);
}

/** Phase budget wrapper: settles the awaited outcome as a failure report. */
async function withTimeout(outcome: Promise<Report>, name: string): Promise<Report> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Report>((res) => {
    timer = setTimeout(
      () => res({ tag: 'fail', data: { error: `${name} timeout after ${TIMEOUT_MS}ms` } }),
      TIMEOUT_MS,
    );
  });
  const settled = await Promise.race([outcome, timeout]);
  clearTimeout(timer);
  return settled;
}

/** SIGTERM the directly-spawned classic child, then make sure it is gone. */
async function stopApp(child: ChildProcess): Promise<void> {
  child.kill('SIGTERM');
  setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
  // The deep-link phase must not inherit a live instance: `open -a` would
  // deliver the cold-start URL to the STILL-RUNNING app, turning the cold
  // start into a warm event. Wait for exit, then sweep by bundle path.
  await new Promise<void>((res) => {
    if (child.exitCode !== null) return res();
    child.on('exit', () => res());
  });
  await killE2EApp();
}

void main().catch((err: unknown) => fail(err instanceof Error ? (err.stack ?? err.message) : String(err)));
