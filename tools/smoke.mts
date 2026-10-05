/**
 * Assembled-stack smoke (no browser): REST surfaces through the real
 * api-client and the real wire lifecycle through the real gateway-client.
 * Catches "unit tests green, wiring dead" rot — boot seams, fan-out route
 * joins, presence announces/snapshots, cross-user message + thread
 * delivery, last-socket offline — in seconds, against the dev server
 * on :4000.
 *
 * Usage: pnpm smoke   (start the stack first: scripts/dev.sh --server)
 *
 * Leg 1 (single user): health → register/verify/login → workspace+channel
 * → gateway READY → self PresenceUpdate(online) → REST send →
 * MESSAGE_CREATE dispatch.
 *
 * Leg 2 (two users, real wire crossings): member-scoped invite creation →
 * second user joins → BOTH gateways converge presence (snapshot + announce)
 * → owner's message reaches the joiner live → joiner (role-less, @everyone
 * base) starts a thread and the owner receives ThreadCreate → joiner's
 * disconnect flips the owner's view of them offline.
 *
 * Leg 3 (bot, bots plan U7/U14): a cytbot_ agent registered (native) →
 * connects via the COMPAT gateway dialect (Identify v=10 + intents, Discord
 * READY/GUILD_CREATE, SCREAMING dispatches) → receives an in-scope
 * MESSAGE_CREATE, is filtered from an out-of-profile channel, and sends
 * through the compat REST prefix (visible via native history).
 */

import { readFileSync } from 'node:fs';

import { CytaleApiClient } from '../packages/api-client/src/api-client.ts';
import { GatewayClient } from '../packages/gateway-client/src/gateway-client.ts';

const BASE = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:4000';
const API = `${BASE}/api/v1`;
const COMPAT_API = `${BASE}/api/v10`;
const GW_URL = `${BASE.replace(/^http/, 'ws')}/gateway/websocket`;
const COMPAT_GW_URL = `${GW_URL}?v=10`;
const TIMEOUT_MS = 10_000;
const MAILBOX = process.env.SMOKE_MAILBOX ?? 'apps/server/tmp/dev_mailbox.jsonl';

function fail(step: string, err: unknown): never {
  console.error(`SMOKE FAIL at "${step}":`, err instanceof Error ? err.message : err);
  process.exit(1);
}

function withTimeout<T>(step: string, p: Promise<T>, ms = TIMEOUT_MS): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms),
    ),
  ]).catch((err) => fail(step, err));
}

async function expectDispatch(
  gw: GatewayClient,
  eventName: string,
  match: (d: Record<string, unknown>) => boolean,
  step: string,
): Promise<void> {
  const seen: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      un?.();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${eventName} never arrived; dispatches seen: [${seen.join(', ') || 'none'}]`));
    }, TIMEOUT_MS);
    const un = gw.onAny((event: any) => {
      seen.push(`${event.t}#${event.s}`);
      if (event.t === eventName && match(event.d as Record<string, unknown>)) {
        cleanup();
        resolve();
      }
    });
  }).catch((err) => fail(step, err));
}

function jwtSub(jwt: string): string {
  const payload = JSON.parse(Buffer.from(jwt.split('.')![1]!, 'base64url').toString());
  return String(payload.sub);
}

/**
 * Id equality across the wire's possible id encodings. events.md pins every
 * Snowflake to a decimal STRING, and the native dispatch path now emits
 * contract-correct strings (the integer-encoding regression this smoke once
 * surfaced has been fixed server-side); REST-derived ids are strings too.
 * Routing both sides through Number() still compares the same double
 * rounding of the same integer either way, so the matcher stays tolerant
 * of both encodings — correct against the string wire and any regression
 * back to numeric ids.
 */
function sameId(a: unknown, b: unknown): boolean {
  return Number(a) === Number(b);
}

interface User {
  api: CytaleApiClient;
  access(): string;
}

/** Register + mailbox-verify + fresh login; returns a token-backed client. */
async function makeVerifiedUser(label: string): Promise<User> {
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
    `register (${label})`,
    api.register({ username: label, email: `${label}@smoke.local`, password: 'smoke-password-1' }),
  );
  tokens.access = registered.access_token;
  tokens.refresh = registered.refresh_token;

  // Dev mailer appends verification tokens to the mailbox instead of
  // sending mail; mutations are view-only-gated until verified.
  const lines = readFileSync(MAILBOX, 'utf8').trim().split('\n');
  const mail = lines
    .map((l) => JSON.parse(l))
    .filter((m) => m.to === `${label}@smoke.local` && m.kind === 'verify_email')
    .at(-1);
  if (!mail) fail('dev mailbox', `no verify_email entry for ${label}@smoke.local in ${MAILBOX}`);
  await withTimeout(`verify email (${label})`, api.verifyEmail({ token: mail.token }));
  // Fresh claims: the pre-verify access token carries verified=false; and
  // login() RETURNS tokens without storing — persist like session.ts does.
  const relogged = await withTimeout(
    `re-login (${label})`,
    api.login({ identifier: label, password: 'smoke-password-1' }),
  );
  tokens.access = relogged.access_token;
  tokens.refresh = relogged.refresh_token;

  return { api, access: () => tokens.access ?? '' };
}

function connectGatewayWithRecorder(
  step: string,
  user: User,
  recorder: { current: ReturnType<typeof recordDispatches> | null },
): Promise<GatewayClient> {
  const gw = new GatewayClient({
    url: GW_URL,
    tokenProvider: () => user.access(),
  });
  recorder.current = recordDispatches(gw);

  return withTimeout(
    step,
    new Promise<GatewayClient>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('READY never arrived')), TIMEOUT_MS);
      const un = gw.onAny((event) => {
        if (event.t === 'Ready') {
          clearTimeout(timer);
          un?.();
          resolve(gw);
        }
      });
      gw.connect().catch(reject);
    }),
  );
}

/**
 * Record every dispatch from connection start and resolve waiters against
 * the log. The join-time frames (snapshot burst + self-announce) can land
 * back-to-back before sequential listeners attach — a persistent recorder
 * closes that window.
 */
function recordDispatches(gw: GatewayClient): {
  waitFor(eventName: string, match: (d: Record<string, unknown>) => boolean, step: string): Promise<void>;
} {
  const log: Array<{ t: string; d: Record<string, unknown> }> = [];
  gw.onAny((event: any) => log.push({ t: event.t, d: event.d }));

  return {
    waitFor(eventName, match, step) {
      return withTimeout(
        step,
        new Promise<void>((resolve) => {
          const poll = setInterval(() => {
            if (log.some((e) => e.t === eventName && match(e.d))) {
              clearInterval(poll);
              resolve();
            }
          }, 25);
        }),
      );
    },
  };
}

function connectGateway(step: string, user: User): Promise<GatewayClient> {
  const gw = new GatewayClient({
    url: GW_URL,
    tokenProvider: () => user.access(),
  });

  return withTimeout(
    step,
    new Promise<GatewayClient>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('READY never arrived')), TIMEOUT_MS);
      const un = gw.onAny((event) => {
        if (event.t === 'Ready') {
          clearTimeout(timer);
          un?.();
          resolve(gw);
        }
      });
      gw.connect().catch(reject);
    }),
  );
}

async function rest(step: string, method: string, path: string, user: User, body?: unknown): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${user.access()}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

// --- bot leg (bots plan U7/U14): a raw compat session --------------------------------

/**
 * A minimal cytbot_ gateway client speaking the COMPAT dialect: Identify
 * (v=10, intents), Discord READY/GUILD_CREATE, SCREAMING dispatches. Node's
 * global WebSocket; no compression (encoding=json). Assertions read the
 * public fields after the leg's waits.
 */
class CompatBotLeg {
  private ws: WebSocket | null = null;
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  private ackedSeq = 0;

  ready = false;
  readonly guilds = new Set<string>();
  readonly seen = new Map<string, string>(); // message id -> content

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  connect(): void {
    if (this.stopping) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.addEventListener('message', (ev: MessageEvent) => this.onMessage(String(ev.data)));
    ws.addEventListener('error', () => {
      /* close always follows */
    });
  }

  private onMessage(raw: string): void {
    const f = JSON.parse(raw) as { op: number; t?: string; s?: number; d?: any };
    if (f.op === 10) {
      this.identify(f.d.heartbeat_interval);
      return;
    }
    if (f.op === 11) return;
    if (f.op !== 0) return;

    if (typeof f.s === 'number' && f.s > 0) this.ackedSeq = f.s;
    switch (f.t) {
      case 'READY':
        this.ready = true;
        break;
      case 'GUILD_CREATE':
        this.guilds.add(String(f.d.id));
        break;
      case 'MESSAGE_CREATE':
        this.seen.set(String(f.d.id), String(f.d.content ?? ''));
        break;
      default:
        break;
    }
  }

  private identify(heartbeatIntervalMs: number): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    this.stopHeartbeat();
    this.hbTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 1, d: this.ackedSeq }));
    }, heartbeatIntervalMs);
    ws.send(
      JSON.stringify({
        op: 2,
        d: {
          token: this.token,
          v: 10,
          intents: 2561, // GUILDS | GUILD_MESSAGES | GUILD_MESSAGE_TYPING
          compress: null,
          properties: { os: 'darwin', browser: 'smoke', device: 'smoke' },
        },
      }),
    );
  }

  private stopHeartbeat(): void {
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.hbTimer = null;
  }

  destroy(): void {
    this.stopping = true;
    this.stopHeartbeat();
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
  }
}

function pollUntil(step: string, cond: () => boolean, ms = 8_000): Promise<void> {
  return withTimeout(
    step,
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        clearInterval(p);
        reject(new Error('condition not met in time'));
      }, ms);
      const p = setInterval(() => {
        if (cond()) {
          clearTimeout(t);
          clearInterval(p);
          resolve();
        }
      }, 50);
    }),
  );
}

// --- 1. health ---------------------------------------------------------------
const health = await fetch(`${BASE}/health`);
if (!health.ok) fail('health', `GET /health -> ${health.status}`);
console.log('ok  health');

// --- 2. leg 1: single user, boot-to-dispatch -----------------------------------
const run = `smoke_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const owner = await makeVerifiedUser(`own_${run}`);
console.log('ok  owner registered + verified');

const ws = await withTimeout('create workspace', owner.api.createWorkspace({ name: `smoke-ws-${run}` }));
const channel = await withTimeout('create channel', owner.api.createChannel(ws.id, { name: 'general' }));
const channelId: string = channel.id;
console.log('ok  workspace + channel');

const ownerRecorder = { current: null as ReturnType<typeof recordDispatches> | null };
const gwOwner = await connectGatewayWithRecorder('owner gateway READY', owner, ownerRecorder);
console.log('ok  owner gateway READY');

await ownerRecorder.current!.waitFor(
  'PresenceUpdate',
  (d) => d.user_id === jwtSub(owner.access()) && d.status === 'online',
  'self presence announce (join_fanout_routes)',
);
console.log('ok  presence announce (online)');

// Listener FIRST, then send — the fan-out beats a late subscription.
const sentPending = expectDispatch(
  gwOwner,
  'MessageCreate',
  (d) => sameId(d.channel_id, channelId),
  'MESSAGE_CREATE fan-out to joined channel route',
);
const sent: { id: string } = await withTimeout(
  'send message',
  owner.api.sendMessage(channelId, { content: 'smoke hello' }),
);
await sentPending;
console.log('ok  REST send → MESSAGE_CREATE dispatch');

// --- 3. leg 2: two users, real wire crossings -----------------------------------
const joiner = await makeVerifiedUser(`usr_${run}`);
console.log('ok  joiner registered + verified');

// Member-scoped invite creation → accept (the api-client has no invite
// methods yet; the raw REST shape is the contract).
const invite = await withTimeout(
  'create invite',
  rest('invite create', 'POST', `/workspaces/${ws.id}/invites`, owner, {}),
);
await withTimeout('accept invite', rest('invite accept', 'POST', `/invites/${invite.invite.code}`, joiner));
console.log('ok  invite created + accepted');

// The owner's gateway must learn about the new member (MemberAdd).
await ownerRecorder.current!.waitFor(
  'MemberAdd',
  (d) => sameId(d.user?.id, jwtSub(joiner.access())),
  'owner receives MemberAdd on invite accept',
);
console.log('ok  owner sees MemberAdd (live)');

// Joiner connects: must receive (a) the owner's live status via the join
// snapshot, (b) their own self-announce.
const joinerRecorder = { current: null as ReturnType<typeof recordDispatches> | null };
const gwJoiner = await connectGatewayWithRecorder('joiner gateway READY', joiner, joinerRecorder);
console.log('ok  joiner gateway READY');

await joinerRecorder.current!.waitFor(
  'PresenceUpdate',
  (d) => d.user_id === jwtSub(owner.access()) && d.status === 'online',
  'join snapshot: joiner learns the owner is online',
);
await joinerRecorder.current!.waitFor(
  'PresenceUpdate',
  (d) => d.user_id === jwtSub(joiner.access()) && d.status === 'online',
  'joiner self-announce',
);
console.log('ok  presence converged on the joiner (snapshot + self)');

await ownerRecorder.current!.waitFor(
  'PresenceUpdate',
  (d) => d.user_id === jwtSub(joiner.access()) && d.status === 'online',
  'owner sees the joiner come online',
);
console.log('ok  owner sees joiner online (live announce)');

// Owner sends; the joiner (subscribed to the channel route) receives it.
const crossPending = expectDispatch(
  gwJoiner,
  'MessageCreate',
  (d) => d.content === 'cross-user hello',
  'cross-user MESSAGE_CREATE delivery',
);
const crossMsg = await withTimeout(
  'owner sends again',
  rest('cross send', 'POST', `/channels/${channelId}/messages`, owner, { content: 'cross-user hello' }),
); // raw REST keeps the envelope {message}
await crossPending;
console.log('ok  cross-user message delivery');

// Inline reply (Discord message_reference): the reply carries reply_to_id
// and BOTH clients receive the referenced snapshot.
const replyPendingA = ownerRecorder.current!.waitFor(
  'MessageCreate',
  (d) => d.content === 'cross-user reply',
  'owner receives the reply dispatch',
);
const replyPendingB = joinerRecorder.current!.waitFor(
  'MessageCreate',
  (d) => d.content === 'cross-user reply' && d.referenced?.content === 'cross-user hello',
  'joiner receives reply with referenced snapshot',
);
const replyMsg = await withTimeout(
  'joiner replies inline',
  rest(
    'reply send',
    'POST',
    `/channels/${channelId}/messages`,
    joiner,
    { content: 'cross-user reply', reply_to_id: crossMsg.message?.id ?? crossMsg.id },
  ),
);
if (replyMsg.message?.reply_to_id !== (crossMsg.message?.id ?? crossMsg.id)) {
  fail('reply reference', 'REST reply did not echo reply_to_id');
}
await replyPendingA;
await replyPendingB;
console.log('ok  inline reply carries referenced snapshot to both clients');

// The joiner — role-less, @everyone base — starts a thread on that message;
// the owner must receive ThreadCreate live (sidebar nav row).
const threadPending = expectDispatch(
  gwOwner,
  'ThreadCreate',
  (d) => d.name === 'smoke thread',
  'ThreadCreate fan-out to the owner',
);
await withTimeout(
  'joiner starts thread',
  rest(
    'thread start',
    'POST',
    `/channels/${channelId}/messages/${crossMsg.message?.id ?? crossMsg.id}/threads`,
    joiner,
    { name: 'smoke thread' },
  ),
);
await threadPending;
console.log('ok  role-less joiner threads; owner receives ThreadCreate');

// Live delete propagation: owner deletes the cross message, both clients
// must see it vanish in real time.
const delPendingA = ownerRecorder.current!.waitFor(
  'MessageDelete',
  (d) => sameId(d.id, crossMsg.message?.id),
  'owner receives own MessageDelete',
);
const delPendingB = joinerRecorder.current!.waitFor(
  'MessageDelete',
  (d) => sameId(d.id, crossMsg.message?.id),
  'joiner receives MessageDelete live',
);
await withTimeout(
  'owner deletes message',
  rest('delete', 'DELETE', `/channels/${channelId}/messages/${crossMsg.message?.id ?? crossMsg.id}`, owner),
);
await delPendingA;
await delPendingB;
console.log('ok  MessageDelete propagates to both clients');

// Channel CRUD propagation: a created channel reaches the joiner live.
const chPending = joinerRecorder.current!.waitFor(
  'ChannelCreate',
  (d) => d.name === 'smoke-extra',
  'joiner receives ChannelCreate live',
);
const chCreated = await withTimeout(
  'owner creates second channel',
  rest('channel create', 'POST', `/workspaces/${ws.id}/channels`, owner, { name: 'smoke-extra' }),
);
await chPending;
console.log('ok  ChannelCreate propagates live');

// Joiner disconnects; the owner's view of them must flip offline (last
// live socket for that user).
const offlinePending = ownerRecorder.current!.waitFor(
  'PresenceUpdate',
  (d) => d.user_id === jwtSub(joiner.access()) && d.status === 'offline',
  'offline announce on last-socket close',
);
gwJoiner.destroy();
await offlinePending;
console.log('ok  joiner offline announce reached the owner');

// Kick: removing the (disconnected) joiner must reach the owner as
// MemberRemove — the roster converges live. (Listener first, then fire.)
const kickPending = ownerRecorder.current!.waitFor(
  'MemberRemove',
  (d) => sameId(d.user_id, jwtSub(joiner.access())),
  'owner receives MemberRemove on kick',
);
await withTimeout(
  'owner kicks joiner',
  rest('kick', 'DELETE', `/workspaces/${ws.id}/members/${jwtSub(joiner.access())}`, owner),
);
await kickPending;
console.log('ok  MemberRemove propagates on kick');

gwOwner.destroy();

// --- 4. leg 3: bot, compat dialect (register → join → filtered events → send) ------
// The agent is restricted to the general channel, so the 'smoke-extra'
// channel created above is out-of-profile: the filter must keep its events
// off the bot's wire while the in-scope channel flows.
const mintedBot = await withTimeout(
  'bot mint',
  rest('agent mint', 'POST', '/agents', owner, {
    name: `smoke-agent-${run}`,
    // BOTH axes: a channels-only restriction grants NO action bits (KTD3) —
    // the agent could not even read its allowlisted channel.
    restrictions: { actions: ['read', 'post'], channels: [channelId] },
  }),
);

const bot = new CompatBotLeg(COMPAT_GW_URL, mintedBot.token as string);
bot.connect();
await pollUntil('bot compat READY + GUILD_CREATE', () => bot.ready && bot.guilds.has(ws.id));
console.log('ok  bot compat session live (READY + GUILD_CREATE)');

// In-scope delivery: owner posts to general → MESSAGE_CREATE on the bot.
const inScope = await withTimeout(
  'bot-scope post',
  rest('post in-scope', 'POST', `/channels/${channelId}/messages`, owner, { content: 'bot leg: in-scope hello' }),
);
await pollUntil('bot receives in-scope MESSAGE_CREATE', () =>
  bot.seen.has(String(inScope.message?.id ?? inScope.id)),
);
console.log('ok  bot received the in-scope MESSAGE_CREATE');

// Out-of-profile silence: 'smoke-extra' is NOT in the agent's allowlist.
await withTimeout(
  'bot-out-of-scope post',
  rest('post out-of-scope', 'POST', `/channels/${chCreated.channel?.id ?? chCreated.channel_id}/messages`, owner, {
    content: 'bot leg: out-of-scope hello',
  }),
);
await new Promise((r) => setTimeout(r, 1_200));
const leaked = [...bot.seen.entries()].find(([, content]) => content === 'bot leg: out-of-scope hello');
if (leaked) fail('bot filter', `out-of-profile message ${leaked[0]} reached the restricted bot`);
console.log('ok  bot filtered from the out-of-profile channel');

// Compat send: the bot posts through the Bot-scheme compat prefix and the
// message must land in NATIVE history (KD2 merge parity).
const botSent = await withTimeout(
  'bot compat send',
  fetch(`${COMPAT_API}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bot ${mintedBot.token}` },
    body: JSON.stringify({ content: 'bot leg: library-side hello' }),
  }).then(async (r) => {
    if (!r.ok) throw new Error(`compat send ${r.status}: ${await r.text()}`);
    return (await r.json()) as { id: string };
  }),
);
const botHistory = await withTimeout(
  'bot history check',
  owner.api.getMessagePage(channelId, { limit: 25 }),
);
if (!botHistory.items.some((m: any) => String(m.id) === botSent.id && m.content === 'bot leg: library-side hello')) {
  fail('bot history', `compat-sent message ${botSent.id} missing from native history`);
}
console.log('ok  bot compat send visible via native REST');

bot.destroy();
console.log(`SMOKE PASS (${run})`);
process.exit(0);
