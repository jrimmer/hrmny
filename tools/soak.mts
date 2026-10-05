/**
 * Pillars soak (#24): reliability + performance made executable.
 *
 * Spawns its OWN server on an isolated port, streams messages across two
 * live gateway clients, SIGKILLs the server mid-stream, restarts it, and
 * asserts:
 *
 *   1. ZERO LOSS    — every REST-accepted message id is present in the
 *                     post-restart channel history (persistence survived).
 *   2. NO LIVE MISS — every message sent while a leg was continuously
 *                     READY (reset→next-ready: from first READY until a
 *                     transport reset, and again once it has re-readied)
 *                     was dispatched to it in real time (the wire claim).
 *   3. CONVERGENCE  — clients reconnect unattended (fresh token on
 *                     Identify) without the script nudging them; after the
 *                     restart the harness GATES on every leg — humans +
 *                     bot — reaching READY/identified again (30s deadline,
 *                     hard fail) before verifying live delivery.
 *   4. BUDGETS      — scylla insert p99 ≤ 50ms and fan-out dispatch p99
 *                     ≤ 5ms over the run (admin /metrics).
 *
 * Usage: pnpm soak   (requires local Scylla on 9042; no other server)
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { CytaleApiClient } from '../packages/api-client/src/api-client.ts';
import { GatewayClient } from '../packages/gateway-client/src/gateway-client.ts';

const PORT = Number(process.env.SOAK_PORT ?? 4100);
const BASE = `http://127.0.0.1:${PORT}`;
const API = `${BASE}/api/v1`;
const GW_URL = `ws://127.0.0.1:${PORT}/gateway/websocket`;
const N_MESSAGES = 40;
const KILL_AFTER = 18; // messages before the SIGKILL
const BOT_CYCLE_AFTER = 9; // messages before the bot's drop→Resume cycle
const MAILBOX = 'apps/server/tmp/dev_mailbox.jsonl';

function fail(step: string, err: unknown): never {
  console.error(`SOAK FAIL at "${step}":`, err instanceof Error ? err.message : err);
  killServer(); // never orphan the spawned instance — it poisons the next run
  process.exit(1);
}

// Belt-and-braces for the paths fail() can't reach (an UNCAUGHT error kills
// Node without running the handler above — the spawned server survives,
// holds the port, and poisons the next run). Same guard the discordjs-leg
// carries.
process.on('exit', killServer);
process.on('SIGINT', () => {
  killServer();
  process.exit(130);
});

// -- the bot leg (bots plan U7): a raw compat session in the stability set --

/**
 * A minimal cytbot_ gateway client speaking the COMPAT dialect (U7/KTD5):
 * Identify(v=10, intents), Discord READY/GUILD_CREATE, SCREAMING dispatches.
 * Reconnects with Resume (session_id + seq + resume_token from our READY
 * extension); InvalidSession(false) — e.g. after the server SIGKILL wipes
 * the session store — falls back to a fresh Identify. Node's global
 * WebSocket; no compression (encoding=json).
 */
class CompatBotLeg {
  private ws: WebSocket | null = null;
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private backoff = 200;
  private stopping = false;
  private wantResume = false;
  /** Client-ACKED seq (heartbeat/Resume carry it). */
  private ackedSeq = 0;
  /** Highest seq ever seen on the CURRENT session (redelivery detection). */
  private maxSeq = 0;

  sessionId = '';
  resumeToken = '';
  ready = false;
  readonly seen = new Set<string>();
  readonly guilds = new Set<string>();
  /** Reset shadows (transport teardown after going ready): messages sent
   * between a reset and this leg's NEXT READY/RESUMED are replay-or-refetch,
   * not live-miss — the same reset→next-ready rule the human clients apply
   * (#26). */
  readonly resets: number[] = [];
  /** Timestamps of re-readiness (READY or RESUMED observed) — closes each
   * reset shadow, making live-miss eligibility deterministic instead of a
   * guessed window. */
  readonly readies: number[] = [];
  /** Seq discontinuities observed — a filtered-consistent stream has ZERO
   * (filtered events never consume a seq, so replay fills exactly). */
  gaps = 0;
  /** Dispatch redeliveries observed across the deliberate Resume replay. */
  redelivered = 0;
  resumes = 0;
  freshIdentifies = 0;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly label: string,
  ) {}

  /** Drop + reconnect through RESUME with a deliberately underrun acked seq
   * — forces the server to replay the last dispatch(es); the replay must be
   * gap-free and redeliver exactly the buffered tail. The reconnect WAITS
   * for the old socket's close to flush: the server must run its terminate
   * (mark the session disconnected) before the Resume arrives, else the
   * session reads as live-elsewhere and the resume bounces. */
  cycle(): void {
    this.wantResume = true;
    this.resets.push(Date.now());
    if (this.ackedSeq > 0) this.ackedSeq -= 1;
    const ws = this.ws;
    this.teardownSocket();
    if (!ws) {
      this.connect();
      return;
    }
    void new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 1_000);
      ws.addEventListener(
        'close',
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    }).then(() =>
      sleep(150).then(() => {
        this.connect();
      }),
    );
  }

  connect(): void {
    if (this.stopping) return;
    this.ready = false;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.addEventListener('message', this.onMessage);
    ws.addEventListener('close', this.onClose);
    ws.addEventListener('error', this.onError);
  }

  private onMessage = (ev: MessageEvent): void => {
    const f = JSON.parse(String(ev.data)) as { op: number; t?: string; s?: number; d?: any };

    if (f.op === 10) {
      this.identify(f.d.heartbeat_interval);
      return;
    }

    if (f.op === 11) return;

    if (f.op === 9) {
      // Not resumable (e.g. the SIGKILL wiped the store) — the next
      // connect() Identifies fresh.
      this.sessionId = '';
      this.resumeToken = '';
      return;
    }

    if (f.op === 0) {
      if (typeof f.s === 'number' && f.s > 0) {
        if (f.s > this.ackedSeq + 1) this.gaps++;
        if (f.s <= this.maxSeq) this.redelivered++;
        this.ackedSeq = f.s;
        this.maxSeq = Math.max(this.maxSeq, f.s);
      }

      switch (f.t) {
        case 'READY':
          this.sessionId = f.d.session_id;
          this.resumeToken = f.d.resume_token;
          this.freshIdentifies++;
          this.ready = true;
          this.backoff = 200;
          this.ackedSeq = 0;
          this.maxSeq = 0;
          this.readies.push(Date.now());
          console.log(`bot[${this.label}] READY (fresh #${this.freshIdentifies})`);
          break;
        case 'RESUMED':
          this.resumes++;
          this.ready = true;
          this.backoff = 200;
          this.readies.push(Date.now());
          console.log(`bot[${this.label}] RESUMED (replay #${this.resumes})`);
          break;
        case 'GUILD_CREATE':
          this.guilds.add(f.d.id);
          break;
        case 'MESSAGE_CREATE':
          this.seen.add(String(f.d.id));
          break;
        default:
          break;
      }
    }
  };

  private onClose = (): void => {
    this.stopHeartbeat();
    if (this.stopping) return;
    if (this.ready) this.resets.push(Date.now());
    this.ready = false;
    setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 2000);
  };

  private onError = (): void => {
    /* close always follows */
  };

  private identify(heartbeatIntervalMs: number): void {
    const ws = this.ws;
    if (!ws) return;
    this.stopHeartbeat();
    this.hbTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 1, d: this.ackedSeq }));
    }, heartbeatIntervalMs);

    const resumable = this.wantResume && this.sessionId && this.resumeToken;
    ws.send(
      JSON.stringify({
        op: resumable ? 5 : 2,
        d: resumable
          ? {
              token: this.token,
              session_id: this.sessionId,
              seq: this.ackedSeq,
              resume_token: this.resumeToken,
            }
          : {
              token: this.token,
              v: 10,
              intents: 2561, // GUILDS | GUILD_MESSAGES | GUILD_MESSAGE_TYPING
              compress: null,
              properties: { $os: 'linux', $browser: 'soak', $device: 'soak' },
            },
      }),
    );
    this.wantResume = false;
  }

  private stopHeartbeat(): void {
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.hbTimer = null;
  }

  private teardownSocket(): void {
    this.stopHeartbeat();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.removeEventListener('message', this.onMessage);
      ws.removeEventListener('close', this.onClose);
      ws.removeEventListener('error', this.onError);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
  }

  destroy(): void {
    this.stopping = true;
    this.teardownSocket();
  }
}

function withTimeout<T>(step: string, p: Promise<T>, ms = 15_000): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms),
    ),
  ]).catch((err) => fail(step, err));
}

// -- server lifecycle ---------------------------------------------------------

let server: ChildProcess | null = null;

function startServer(): Promise<void> {
  server = spawn('mix', ['phx.server'], {
    cwd: 'apps/server',
    env: {
      ...process.env,
      MIX_ENV: 'dev',
      PORT: String(PORT),
      SECRET_KEY_BASE: 'soak-secret-key-base-32-chars-minimum!',
      AUTH_JWT_SECRET: 'soak-jwt-secret-key-base-32-chars-minim!',
      AUTH_REFRESH_PEPPER: 'soak-refresh-pepper-32-chars-minimum!!',
      CYTALE_SCYLLA_NODES: '127.0.0.1:9042',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout!.on('data', (d) => process.env.SOAK_VERBOSE && process.stderr.write(d));
  server.stderr!.on('data', (d) => process.env.SOAK_VERBOSE && process.stderr.write(d));

  return withTimeout(
    'server boot',
    (async () => {
      for (let i = 0; i < 100; i++) {
        try {
          const r = await fetch(`${BASE}/health`);
          if (r.ok) return;
        } catch {
          /* not up yet */
        }
        await sleep(300);
      }
      throw new Error('server never became healthy');
    })(),
    60_000,
  );
}

function killServer(): void {
  if (server?.pid) {
    try {
      process.kill(server.pid, 'SIGKILL'); // chaos: no drain, no reconnect wave
    } catch {
      /* already gone */
    }
  }
  server = null;
}

// -- users / clients ------------------------------------------------------------

async function makeVerifiedUser(label: string): Promise<{ api: CytaleApiClient; access(): string }> {
  const tokens: { access?: string; refresh?: string } = {};
  const api = new CytaleApiClient({
    baseUrl: API,
    tokens: {
      getAccessToken: async () => tokens.access ?? '',
      getRefreshToken: async () => tokens.refresh ?? '',
      updateTokens: async (a, r) => {
        tokens.access = a;
        tokens.refresh = r;
      },
    },
  });

  const registered = await withTimeout(
    `register ${label}`,
    api.register({ username: label, email: `${label}@soak.local`, password: 'soak-password-1' }),
  );
  tokens.access = registered.access_token;
  tokens.refresh = registered.refresh_token;

  const mail = readFileSync(MAILBOX, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .filter((m) => m.to === `${label}@soak.local` && m.kind === 'verify_email')
    .at(-1);
  if (!mail) fail('mailbox', `no verify token for ${label}`);
  await withTimeout(`verify ${label}`, api.verifyEmail({ token: mail.token }));
  const re = await withTimeout(
    `relogin ${label}`,
    api.login({ identifier: label, password: 'soak-password-1' }),
  );
  tokens.access = re.access_token;
  tokens.refresh = re.refresh_token;
  return { api, access: () => tokens.access ?? '' };
}

function connect(user: { access(): string }, label = 'client'): { gw: GatewayClient; seen: Set<string>; wire: { frames: number; binary: number; text: number }; resets: number[]; readies: number[] } {
  const seen = new Set<string>();
  /** Timestamps of transport resets (teardown after going ready) — live-miss
   * is only asserted for messages sent in a continuously-ready window;
   * across a reset the delivery contract is replay-or-refetch (#26). */
  const resets: number[] = [];
  /** Timestamps of re-readiness (Ready/Resumed dispatch observed) — closes
   * each reset shadow so eligibility is reset→next-ready, not a guessed
   * fixed window. */
  const readies: number[] = [];
  // #26 diagnostics: raw wire counters at the SOCKET level — decisively
  // splits "server never sent" from "client received but didn't deliver".
  const wire = { frames: 0, binary: 0, text: 0 };
  // Harness tuning: cap the reconnect backoff so the post-kill reconnect
  // assertion doesn't wait out production-grade escalation.
  const gw = new GatewayClient({
    url: GW_URL,
    tokenProvider: () => user.access(),
    minReconnectDelayMs: 200,
    maxReconnectDelayMs: 2000,
    socketFactory: (u: string) => {
      const ws = new WebSocket(u) as WebSocket & { binaryType?: string };
      ws.binaryType = 'arraybuffer';
      // #26: name the closer — every close() call, its code, and the stack.
      const origClose = ws.close.bind(ws);
      (ws as unknown as { close: (...a: unknown[]) => void }).close = (...args: unknown[]) => {
        console.log(
          `ws[${label}] CLOSE-CALL code=${String(args[0])} reason=${String(args[1]).slice(0, 50)}\n    ${new Error('stack').stack?.split('\n').slice(2, 5).join('\n    ')}`,
        );
        return origClose(...(args as []));
      };
      ws.addEventListener('message', (ev: MessageEvent) => {
        wire.frames++;
        if (typeof ev.data === 'string') wire.text++;
        else wire.binary++;
      });
      ws.addEventListener('close', (ev: CloseEvent) => {
        console.log(`ws[${label}] CLOSE code=${ev.code} wasClean=${ev.wasClean}`);
      });
      ws.addEventListener('error', () => {
        console.log(`ws[${label}] ERROR (no close yet)`);
      });
      return ws as never;
    },
    onInvalidSession: (resumable) => console.log(`gw[${label}] invalid_session resumable=${resumable}`),
    onResumeGap: (gap) => console.log(`gw[${label}] resume gap ${gap.expectedSeq}->${gap.receivedSeq}`),
    onStateChange: (c) => {
      console.log(`gw[${label}] ${c.from} -> ${c.to}`);
      // Any transport reset (teardown from any live-ish state), not just
      // ready — a collector death during identify/rec   over transitions
      // directly and is equally a reset shadow.
      if (c.to === 'reconnecting') resets.push(Date.now());
    },
    onClosed: (info) => console.log(`gw[${label}] closed code=${info.code} reason=${String(info.reason).slice(0, 60)}`),
  });
  gw.onAny((event: any) => {
    if (event.t === 'MessageCreate' && event.d?.id) seen.add(String(event.d.id));
  });
  gw.onAny((event: any) => {
    if (event.t === 'Ready' || event.t === 'Resumed') readies.push(Date.now());
  });
  gw.connect().catch(() => undefined); // the client owns reconnecting
  return { gw, seen, wire, resets, readies };
}

/** Baselines for the post-restart readiness gate, captured the moment the
 * server is killed: each leg must later show STRICTLY MORE resets (it
 * noticed the death — guards a stale socket still reading 'ready') and
 * strictly more READY/Resumed observations (it readied again on the fresh
 * connection) than at kill time. */
interface ReadinessBaselines {
  a: { resets: number; readies: number; wasReconnecting: boolean };
  b: { resets: number; readies: number; wasReconnecting: boolean };
  botFreshIdentifies: number;
}

/**
 * Reset→next-ready readiness gate (replaces the former fixed ~5s shadow +
 * fixed 4-message dead window): after the server restarts, EVERY tracked
 * leg — both human gateway clients and the compat bot — must re-reach
 * READY/identified before the live-delivery verification window opens.
 * Reconnect churn on a loaded box is unbounded, so the gate polls observed
 * state with a generous per-run deadline and HARD-FAILS if a leg never
 * readies (that is assertion 3 — convergence — not a timing guess).
 */
async function waitForAllReadied(baselines: ReadinessBaselines): Promise<void> {
  const deadlineMs = 30_000;
  const start = Date.now();
  const humanBack = (
    rec: { gw: GatewayClient; resets: number[]; readies: number[] },
    base: { resets: number; readies: number; wasReconnecting?: boolean },
  ): boolean =>
    rec.gw.connectionState === 'ready' &&
    // A leg already sitting IN 'reconnecting' at kill time can never RE-enter
    // it (the reset counter only counts entries) — for such legs the new
    // READY past the baseline is the recovery proof (U7: measured on a
    // loaded darwin box where a leg's early resume refusal left it in
    // 'reconnecting' across the kill; the old condition gated forever).
    (rec.resets.length > base.resets || base.wasReconnecting === true) &&
    rec.readies.length > base.readies;
  for (;;) {
    const a = humanBack(recA, baselines.a);
    const b = humanBack(recB, baselines.b);
    const botBack =
      bot.ready && bot.freshIdentifies > baselines.botFreshIdentifies;
    if (a && b && botBack) return;
    if (Date.now() - start > deadlineMs) {
      fail(
        'readiness gate',
        `legs not ready ${deadlineMs}ms after restart: A=${recA.gw.connectionState} ` +
          `(resets ${recA.resets.length}/${baselines.a.resets}, readies ${recA.readies.length}/${baselines.a.readies}) ` +
          `B=${recB.gw.connectionState} (resets ${recB.resets.length}/${baselines.b.resets}, readies ${recB.readies.length}/${baselines.b.readies}) ` +
          `bot.ready=${bot.ready} (fresh Identifies ${bot.freshIdentifies}/${baselines.botFreshIdentifies})`,
      );
    }
    await sleep(100);
  }
}

function waitReady(rec: { gw: GatewayClient }): Promise<void> {
  return withTimeout(
    'gateway READY',
    new Promise<void>((resolve, reject) => {
      // The client may already be live (initial connect races the wait) —
      // settle immediately instead of waiting for an event that already fired.
      if (rec.gw.connectionState === 'ready' || rec.gw.connectionState === 'connected') {
        resolve();
        return;
      }

      const un = rec.gw.onAny((event: any) => {
        if (event.t === 'Ready' || event.t === 'Resumed') {
          un?.();
          resolve();
        }
      });
      rec.gw.connect().catch(reject);
    }),
  );
}

// -- the soak -------------------------------------------------------------------

const run = `soak_${Date.now()}`;
console.log(`soak: spawning server on :${PORT}`);
await startServer();
console.log('ok  server up');

const owner = await makeVerifiedUser(`own_${run}`);
const joiner = await makeVerifiedUser(`usr_${run}`);

const ws = await withTimeout('workspace', owner.api.createWorkspace({ name: `soak-${run}` }));
const channel = await withTimeout('channel', owner.api.createChannel(ws.id, { name: 'general' }));
const invite = await withTimeout(
  'invite',
  fetch(`${API}/workspaces/${ws.id}/invites`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${owner.access()}` },
    body: '{}',
  }).then(async (r) => {
    if (!r.ok) throw new Error(`invite ${r.status}`);
    return (await r.json()).invite.code as string;
  }),
);
await withTimeout(
  'accept',
  fetch(`${API}/invites/${invite}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${joiner.access()}` },
  }).then(async (r) => {
    if (!r.ok) throw new Error(`accept ${r.status}`);
  }),
);
console.log('ok  users + channel ready');

// -- bot leg (bots plan U7): a cytbot_ compat session in the kill/restart --
// stability set. Its resume-with-static-token cycle + the SIGKILL exercise
// filtered-consistent replay and the fresh-Identify fallback.
const minted = await withTimeout(
  'agent mint',
  fetch(`${API}/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${owner.access()}` },
    body: JSON.stringify({ name: `soak-agent-${run}` }),
  }).then(async (r) => {
    if (!r.ok) throw new Error(`agent mint ${r.status}: ${await r.text()}`);
    return (await r.json()) as { id: string; token: string };
  }),
);

const bot = new CompatBotLeg(`ws://127.0.0.1:${PORT}/gateway/websocket?v=10`, minted.token, 'agent');
bot.connect();
await withTimeout('bot compat READY', pollUntil(() => bot.ready && bot.guilds.size >= 1));
console.log('ok  bot compat session live (READY + GUILD_CREATE)');

function pollUntil(cond: () => boolean, tickMs = 50, deadlineMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      clearInterval(p);
      reject(new Error(`poll condition not met within ${deadlineMs}ms`));
    }, deadlineMs);
    const p = setInterval(() => {
      if (cond()) {
        clearTimeout(t);
        clearInterval(p);
        resolve();
      }
    }, tickMs);
  });
}

let postKillBaselines: ReadinessBaselines | null = null;
// Phase isolation: clear boot-phase samples (taken under restart/co-tenant
// load) so budgets judge the steady-state message phase only.
await withTimeout(
  'metrics reset',
  fetch(`${API}/admin/metrics/reset`, {
    method: 'POST',
    headers: { authorization: `Bearer ${owner.access()}` },
  }).then(async (r) => {
    if (!r.ok) throw new Error(`metrics reset ${r.status}`);
  }),
);

const recA = connect(owner, 'A');
const recB = connect(joiner, 'B');
await waitReady(recA);
await waitReady(recB);
console.log('ok  both gateways live');

const accepted: Array<{ id: string; liveWindow: boolean; sendAt: number; index: number }> = [];
let liveWindow = true;

for (let i = 1; i <= N_MESSAGES; i++) {
  if (i === BOT_CYCLE_AFTER) {
    // Bot resume cycle: drop the socket and Resume with an underrun seq —
    // the server must replay the buffered tail gap-free (filtered events
    // never consume a seq) and redeliver exactly the last dispatch.
    bot.cycle();
    await withTimeout('bot RESUMED (replay cycle)', pollUntil(() => bot.ready && bot.resumes >= 1));
    console.log('ok  bot resumed (deliberate replay cycle)');
  }

  if (i === KILL_AFTER) {
    console.log(`soak: SIGKILL after ${KILL_AFTER} messages; restarting`);
    liveWindow = false;
    // Baselines for the reset→next-ready gate: every leg must later show a
    // NEW reset (noticed the kill) AND a NEW READY/Resumed (recovered) past
    // these counts before live delivery is verified again.
    postKillBaselines = {
      a: {
        resets: recA.resets.length,
        readies: recA.readies.length,
        wasReconnecting: recA.gw.connectionState === 'reconnecting',
      },
      b: {
        resets: recB.resets.length,
        readies: recB.readies.length,
        wasReconnecting: recB.gw.connectionState === 'reconnecting',
      },
      botFreshIdentifies: bot.freshIdentifies,
    };
    killServer();
    await startServer();
    console.log('ok  server restarted (unattended client reconnect expected)');
  }

  // Messages i=KILL_AFTER..KILL_AFTER+3 ride the reconnection window
  // (liveWindow=false): REST-accepted (zero-loss covers them) but not
  // live-verifiable. Then the readiness gate — not a fixed message gap —
  // decides when the wire is live again.
  if (i === KILL_AFTER + 4) {
    await withTimeout(
      'post-restart readiness of every leg',
      waitForAllReadied(postKillBaselines!),
      60_000,
    );
    console.log('ok  readiness gate cleared (humans + bot READY/identified again)');
    // Phase isolation #2: the restarted workspace process is COLD — its
    // first fan-outs load the channel cache from Scylla and land slow
    // samples in the ring. Clear again so budgets measure steady state.
    await withTimeout(
      'metrics reset (post-restart)',
      fetch(`${API}/admin/metrics/reset`, {
        method: 'POST',
        headers: { authorization: `Bearer ${owner.access()}` },
      }).then(async (r) => {
        if (!r.ok) throw new Error(`metrics reset ${r.status}`);
      }),
    );
    liveWindow = true;
    console.log('ok  live window open (steady-state verification begins)');
  }

  const sender = i % 2 === 0 ? owner : joiner;
  const sent = await withTimeout(
    `send #${i}`,
    sender.api.sendMessage(channel.id, { content: `soak ${i}` }),
  );
  accepted.push({ id: sent.id, liveWindow, sendAt: Date.now(), index: i });
}

// Drain: allow in-flight dispatches to land.
await sleep(1500);

console.log(`soak: ${accepted.length} messages accepted; asserting`);

// 1. ZERO LOSS — persistence survived the kill.
const page = await withTimeout(
  'post-restart history',
  owner.api.getMessagePage(channel.id, { limit: 100 }),
);
const persisted = new Set(page.items.map((m: any) => String(m.id)));
const lost = accepted.filter((m) => !persisted.has(m.id));
if (lost.length > 0) fail('zero loss', `${lost.length} accepted messages missing from history`);

// 2. NO LIVE MISS — messages dispatched in continuously-ready windows were
// dispatched live. Eligibility is reset→next-ready: a send is live-verifiable
// unless it fell inside a reset shadow — i.e. the client's LATEST reset at or
// before the send had not yet been closed by a READY/Resumed. Across such a
// span the delivery contract is replay-or-refetch (zero-loss covers it); once
// the client has readied again, live delivery is REQUIRED — with no fixed
// window to guess wrong about reconnect churn on a loaded box. The zero-loss
// and gap assertions are untouched.
const wasLiveEligible = (sentAt: number, resets: number[], readies: number[]): boolean => {
  let latestReset = -1;
  for (const r of resets) if (r <= sentAt && r > latestReset) latestReset = r;
  if (latestReset < 0) return true;
  return readies.some((t) => t > latestReset && t <= sentAt);
};
const missedA = accepted.filter(
  (m) => m.liveWindow && !recA.seen.has(m.id) && wasLiveEligible(m.sendAt, recA.resets, recA.readies),
);
const missedB = accepted.filter(
  (m) => m.liveWindow && !recB.seen.has(m.id) && wasLiveEligible(m.sendAt, recB.resets, recB.readies),
);
if (missedA.length > 0 || missedB.length > 0) {
  console.error(
    'DIAG A:', JSON.stringify(recA.gw.getTelemetry()), 'state', recA.gw.connectionState, 'wire', JSON.stringify(recA.wire),
    '\nDIAG B:', JSON.stringify(recB.gw.getTelemetry()), 'state', recB.gw.connectionState, 'wire', JSON.stringify(recB.wire), 'malformedSamples', JSON.stringify(recB.gw.lastMalformed), 'helloCount', recB.gw.helloCount, 'pendingDepth', recB.gw.pendingDepth(),
  );
  fail('no live miss', `A missed ${missedA.length}, B missed ${missedB.length} live-window messages`);
}

// 2b. BOT LEG — live delivery + filtered-consistent replay + fallback.
// Same reset→next-ready eligibility as the human legs (shadows close on the
// bot's own READY/RESUMED timestamps).
const botWasLiveEligible = (sentAt: number): boolean =>
  wasLiveEligible(sentAt, bot.resets, bot.readies);
const botMissed = accepted.filter(
  (m) => m.liveWindow && !bot.seen.has(m.id) && botWasLiveEligible(m.sendAt),
);
if (botMissed.length > 0) {
  fail(
    'bot no live miss',
    `bot missed ${botMissed.length} live-window messages: ${JSON.stringify(
      botMissed.map((m) => `#${m.index}:${m.id}`),
    )} (seen=${bot.seen.size}, resumes=${bot.resumes}, gaps=${bot.gaps}, redelivered=${bot.redelivered})`,
  );
}
if (!bot.guilds.has(ws.id)) {
  fail('bot guild cache', `GUILD_CREATE never carried workspace ${ws.id}`);
}
if (bot.gaps !== 0) {
  fail('bot replay consistency', `seq gaps observed: ${bot.gaps} (replay must fill exactly)`);
}
if (bot.resumes !== 1 || bot.redelivered !== 1) {
  fail(
    'bot resume replay',
    `resumes=${bot.resumes} redelivered=${bot.redelivered} (expected exactly 1 replay redelivery)`,
  );
}
if (bot.freshIdentifies !== 2) {
  fail('bot identify fallback', `fresh Identifies=${bot.freshIdentifies} (expected 2: boot + post-kill)`);
}
console.log(
  `ok  bot leg: ${bot.seen.size} messages, gaps=0, replay redelivery=1, resumes=1, fresh Identifies=2`,
);
bot.destroy();

// 4. BUDGETS — hop p99s over the run window.
const metrics = await withTimeout(
  'metrics',
  fetch(`${API}/admin/metrics`, { headers: { authorization: `Bearer ${owner.access()}` } }).then(
    (r) => {
      if (!r.ok) throw new Error(`metrics ${r.status}`);
      return r.json() as Promise<Record<string, { count: number; p99_ms: number }>>;
    },
  ),
);
const insert = metrics.scylla_insert_ms;
const fanout = metrics.fanout_dispatch_ms;
console.log(`soak: insert p99=${insert.p99_ms}ms (n=${insert.count}), fanout p99=${fanout.p99_ms}ms (n=${fanout.count})`);
// Coverage: enough samples for a meaningful p99. The ring is reset twice
// (boot + cold-workspace isolation), leaving the steady-state live-window
// messages only — assert at least half the run.
if (insert.count < 15) {
  fail('metrics coverage', `insert count ${insert.count} < 15`);
}
// Budgets are tight (5ms fanout) and this box runs co-tenants (vite, dev
// server, browser): a one-off scheduler/GC spike is environmental. One
// settle-and-retry on breach; a PERSISTENT regression still fails.
const fetchMetrics = () =>
  withTimeout(
    'metrics re-fetch',
    fetch(`${API}/admin/metrics`, { headers: { authorization: `Bearer ${owner.access()}` } }).then(
      (r) => {
        if (!r.ok) throw new Error(`metrics ${r.status}`);
        return r.json() as Promise<Record<string, { count: number; p99_ms: number }>>;
      },
    ),
  );

const assertBudget = async (label: string, key: string, budgetMs: number) => {
  if ((key === 'scylla_insert_ms' ? insert : fanout).p99_ms <= budgetMs) return;
  const settled = await fetchMetrics();
  if (settled[key].p99_ms > budgetMs) {
    fail(`${label} budget`, `p99 ${settled[key].p99_ms}ms > ${budgetMs}ms (persisted past settle)`);
  }
};

await assertBudget('insert', 'scylla_insert_ms', 50);
await assertBudget('fanout', 'fanout_dispatch_ms', 5);

// -- Voice soak (calls plan U13 + V2 U7 video phase) ----------------------------
// A live call across SIGKILL: media legs die with the socket, the BOOT SWEEP
// ends the stale call row, callers return to idle via backfill (post-restart
// CALL_SYNC shows no live call), and a NEW call starts + delivers media
// immediately on the restarted node. V2 (U7): the sidecar legs carry ONE
// CAMERA PUBLISHER — video rides the kill/restart cycle, the publish state
// is roster-visible (camera_on) pre-kill, and the post-restart re-join
// RE-PUBLISHES the source (VM8). TS drives all gateway signaling +
// assertions; the Elixir sidecar (tools/load-test/voice-sidecar) owns the
// real-WebRTC RTP pump/count legs (U28 doctrine split).
if (process.env.SOAK_SKIP_VOICE !== '1') {
  const { SidecarDriver } = await import('./load-test/src/voice/sidecar.js');
  const { VirtualVoiceClient } = await import('./load-test/src/voice/virtual_voice_client.js');
  const { waitFor } = await import('./load-test/src/voice/sidecar.js');

  console.log('voice soak: provisioning users + channel');
  const vusers = await Promise.all(
    ['a', 'b', 'c'].map(async (sfx) => makeVerifiedUser(`vs_${run}_${sfx}`)),
  );
  const vchannel = await withTimeout(
    'voice channel',
    owner.api.createChannel(ws.id, { name: 'voice-soak' }),
  );
  const invite2 = await withTimeout(
    'voice invite',
    fetch(`${API}/workspaces/${ws.id}/invites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${owner.access()}` },
      body: '{}',
    }).then(async (r) => {
      if (!r.ok) throw new Error(`invite ${r.status}`);
      return (await r.json()).invite.code as string;
    }),
  );
  for (const u of vusers) {
    await withTimeout(
      'voice member accept',
      fetch(`${API}/invites/${invite2}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${u.access()}` },
      }).then(async (r) => {
        if (!r.ok) throw new Error(`accept ${r.status}`);
      }),
    );
  }

  // The signaling/assertion leg: the owner on the production gateway client.
  const voiceOwner = new VirtualVoiceClient({ url: GW_URL, token: owner.access(), label: 'voice-owner' });
  voiceOwner.connect().catch(() => undefined);
  await withTimeout(
    'voice owner READY',
    waitFor('voice owner ready', () => (voiceOwner.ready ? true : undefined), 30_000),
  );
  voiceOwner.start(String(vchannel.id), false);
  await withTimeout(
    'voice CALL_START',
    waitFor('CallStart', () => (voiceOwner.hasCaptured('CallStart') ? true : undefined), 10_000),
  );
  console.log('ok  voice call live (owner started)');

  const sidecar = new SidecarDriver();
  const tokens = vusers.map((u) => u.access());
  const PORT_NUM = PORT;
  const leg1 = await sidecar.start({
    tokens,
    channelId: String(vchannel.id),
    host: '127.0.0.1',
    port: PORT_NUM,
    durationS: 60,
    // V2 (U7): one camera publisher among the three legs — video rides the
    // kill/restart cycle (single-layer sidecar publisher, the honest ceiling).
    video: { cameraCount: 1, videoPps: 200, publishDelayMs: 2_000 },
  });
  const connectedTick = await withTimeout(
    'voice sidecar all connected',
    leg1.waitAllConnected(60_000),
    90_000,
  );
  console.log(
    `ok  voice media up: ${connectedTick.participants?.length} legs connected ` +
      `(after ${Math.max(...(connectedTick.participants ?? []).map((p) => p.connected_after_ms))}ms)`,
  );

  // V2 (U7): the camera publish must be roster-visible (CALL_UPDATE
  // camera_on → derived roster sources) and video must FLOW before the kill.
  await withTimeout(
    'camera source published + video flowing pre-kill',
    waitFor('camera source + video rtp', () => {
      const withCamera = (voiceOwner.rosterIds(String(vchannel.id)) ?? []).filter((uid) =>
        voiceOwner.memberSources(String(vchannel.id), uid).includes('camera'),
      );
      if (withCamera.length === 0) return undefined;
      const t = leg1.ticks().at(-1);
      const videoRecv = (t?.participants ?? []).reduce((a, p) => a + (p.video_received ?? 0), 0);
      return videoRecv > 0 ? withCamera.length : undefined;
    }, 60_000),
    90_000,
  );
  console.log('ok  camera published + video RTP flowing pre-kill');

  // Let the pump run briefly, then SIGKILL mid-call.
  await sleep(5_000);
  const midTick = leg1.ticks().at(-1);
  console.log(
    `voice soak: SIGKILL mid-call (sent=${midTick?.participants?.reduce((a, p) => a + p.sent, 0)}, ` +
      `received=${midTick?.participants?.reduce((a, p) => a + p.received, 0)})`,
  );
  killServer();
  await startServer();
  console.log('ok  server restarted mid-call');

  // The sidecar notices the dropped sockets and reports FINAL (all dead).
  const deadFinal = await withTimeout('sidecar final after kill', leg1.done, 30_000).catch(() => null);
  if (deadFinal) {
    console.log(
      `ok  sidecar legs died with the server (delivery to kill: ${deadFinal.delivery_pct ?? 'n/a'}%)`,
    );
  }

  // Post-restart backfill: the owner's fresh Identify emits CALL_SYNC — the
  // boot sweep must have ended the stale call (no live entry). The sweep is
  // boot-async: poll CALL_SYNCs until the voice channel is absent.
  await withTimeout(
    'voice owner re-ready',
    waitFor('voice owner re-ready', () => (voiceOwner.ready ? true : undefined), 60_000),
  );
  await withTimeout(
    'post-restart CALL_SYNC shows no live voice call (boot sweep)',
    waitFor('swept', () => {
      const sawSync = voiceOwner.capturedOf('CallSync').length > 0;
      const live = voiceOwner.rosterSize(String(vchannel.id));
      return sawSync && live === 0 ? true : undefined;
    }, 30_000),
  );
  console.log('ok  boot sweep ended the stale call (CALL_SYNC backfill shows none live)');

  // A NEW call must start immediately on the restarted node. The boot
  // sweep is async (a Task beside the Scylla pool): if the stale row is
  // still open, op-22 `start` hits the one-live policy and silently drops —
  // retry the start until the sweep clears it (bounded).
  {
    const before2 = voiceOwner.capturedOf('CallStart').length;
    const deadline = Date.now() + 30_000;
    for (;;) {
      voiceOwner.start(String(vchannel.id), false);
      await sleep(1_500);
      if (voiceOwner.capturedOf('CallStart').length > before2) break;
      if (Date.now() > deadline) {
        fail('new CALL_START post-restart', 'start retried for 30s with no CALL_START (sweep never cleared the row?)');
      }
    }
  }
  const leg2 = await sidecar.start({
    tokens,
    channelId: String(vchannel.id),
    host: '127.0.0.1',
    port: PORT_NUM,
    durationS: 30,
    video: { cameraCount: 1, videoPps: 200, publishDelayMs: 2_000 },
  });
  const tick2 = await withTimeout('new call media up', leg2.waitAllConnected(60_000), 90_000);
  await withTimeout(
    'new call media flowing',
    waitFor('rtp flowing', () => {
      const t = leg2.ticks().at(-1);
      const total = (t?.participants ?? []).reduce((a, p) => a + p.received, 0);
      return total > 0 ? total : undefined;
    }, 30_000),
  );
  console.log(
    `ok  new call immediately post-restart: ${tick2.participants?.length} legs connected, media flowing`,
  );
  // V2 (U7 / VM8): the re-joined legs RE-PUBLISH the camera source on the
  // fresh call and video flows again post-restart.
  await withTimeout(
    'camera re-published post-restart (VM8)',
    waitFor('camera source re-published + video flowing', () => {
      const withCamera = (voiceOwner.rosterIds(String(vchannel.id)) ?? []).filter((uid) =>
        voiceOwner.memberSources(String(vchannel.id), uid).includes('camera'),
      );
      if (withCamera.length === 0) return undefined;
      const t = leg2.ticks().at(-1);
      const videoRecv = (t?.participants ?? []).reduce((a, p) => a + (p.video_received ?? 0), 0);
      return videoRecv > 0 ? withCamera.length : undefined;
    }, 60_000),
    90_000,
  );
  const final2 = await withTimeout('sidecar 2 final', leg2.done, 90_000);
  console.log(`ok  post-restart voice window delivery: ${final2.delivery_pct ?? 'n/a'}%`);
  console.log(
    `ok  post-restart video: sent=${(final2.participants ?? []).reduce((a, p) => a + (p.video_sent ?? 0), 0)}, ` +
      `received=${(final2.participants ?? []).reduce((a, p) => a + (p.video_received ?? 0), 0)}`,
  );

  voiceOwner.destroy();
}

recA.gw.destroy();
recB.gw.destroy();
killServer();
console.log(
  `SOAK PASS — ${N_MESSAGES} messages, ${process.env.SOAK_SKIP_VOICE === '1' ? '1' : '2'} kills, ` +
    `zero loss, budgets green${process.env.SOAK_SKIP_VOICE === '1' ? '' : ', voice kill/restart swept + new call immediate'} (${run})`,
);
process.exit(0);
