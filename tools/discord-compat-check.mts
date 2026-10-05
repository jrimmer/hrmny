/**
 * Bots plan U14 — the acceptance harness: compat proven by CONSUMPTION, not
 * assertion. A real, pinned Discord client library (discord.js 14.27.0, the
 * same library U7's minimal leg exercises) pointed at a locally booted
 * Cytale server completes the FULL scenario:
 *
 *   register → connect (READY/GUILD_CREATE) → filtered events → send →
 *   reply (type 19) → application command + INTERACTION_CREATE +
 *   callback → webhook execute (bare + /github) → file upload (multipart
 *   files[n]/payload_json, bot + webhook) → restricted-agent
 *   variant → revocation mid-run (4004, no hang) → COMPONENTS
 *   (components plan U5/R9: buttons + interaction.update, the
 *   deferUpdate→editReply continuation, select values, the DM
 *   user-shaped click, restricted-agent oracles).
 *
 * Boot/seeding runs on NATIVE REST (the human admin surface); every bot-side
 * motion goes through the LIBRARY (its REST manager + gateway session) so
 * the compat contract is exercised exactly the way an off-the-shelf bot
 * would consume it.
 *
 * Per-leg JSON-ish PASS/FAIL summary on stdout (with the received-vs-
 * expected delta on failure); non-zero exit if ANY leg fails.
 *
 * Usage: pnpm compat:check   (spawns its own server on an isolated port;
 * uses CYTALE_SCYLLA_NODES when set, else a local Scylla on 9042)
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import zlib from 'node:zlib';

import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  MessageType,
  ModalBuilder,
  Status,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextChannel,
  TextInputBuilder,
  TextInputStyle,
  type Message,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';

const PORT = Number(process.env.COMPAT_PORT ?? 4130);
const BASE = `http://127.0.0.1:${PORT}`;
const API = `${BASE}/api/v1`;
const MAILBOX = 'apps/server/tmp/dev_mailbox.jsonl';
const TIMEOUT_MS = 20_000;
/** How long to hold a negative probe open ("this event must NOT arrive"). */
const NEGATIVE_MS = 1_500;

// -- leg registry ---------------------------------------------------------------

/** Native history row (the /api/v1 message shape the owner reads). */
interface NativeMessage {
  id: string;
  content: string;
  author_id: string;
  reply_to_id?: string;
}

interface LegResult {
  leg: string;
  status: 'PASS' | 'FAIL';
  detail?: string;
}

const results: LegResult[] = [];

function pass(leg: string, detail?: string): void {
  results.push({ leg, status: 'PASS', detail });
  console.log(`ok    ${leg}${detail ? ` — ${detail}` : ''}`);
}

function failLeg(leg: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : JSON.stringify(err);
  results.push({ leg, status: 'FAIL', detail });
  console.error(`FAIL  ${leg} — ${detail}`);
  if (process.env.COMPAT_VERBOSE && err instanceof Error && err.stack) {
    console.error(err.stack.split('\n').slice(0, 6).join('\n'));
  }
}

/** Run one leg; a failure is RECORDED, not thrown — the remaining legs still
 * run so the final report shows every divergence, not just the first. */
async function leg(name: string, fn: () => Promise<void>, summary?: string): Promise<void> {
  try {
    await fn();
    pass(name, summary);
  } catch (err) {
    failLeg(name, err);
  }
}

function assert(leg: string, cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`${leg}: ${message}`);
}

// -- server lifecycle (discordjs-leg pattern) ------------------------------------

let server: ChildProcess | null = null;

function startServer(): Promise<void> {
  server = spawn('mix', ['phx.server'], {
    cwd: 'apps/server',
    env: {
      ...process.env,
      MIX_ENV: 'dev',
      PORT: String(PORT),
      SECRET_KEY_BASE: 'compat-secret-key-base-32-chars-minimum',
      AUTH_JWT_SECRET: 'compat-jwt-secret-key-base-32-chars-mi',
      AUTH_REFRESH_PEPPER: 'compat-refresh-pepper-32-chars-minimum',
      // A leased ScyllaDB (scripts/ci-scylla-lease.sh) when the caller names one.
      CYTALE_SCYLLA_NODES: process.env.CYTALE_SCYLLA_NODES ?? '127.0.0.1:9042',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout!.on('data', (d) => process.env.COMPAT_VERBOSE && process.stderr.write(d));
  server.stderr!.on('data', (d) => process.env.COMPAT_VERBOSE && process.stderr.write(d));

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
  if (process.env.COMPAT_KEEP_SERVER === '1') {
    console.error(`COMPAT_KEEP_SERVER: leaving server pid=${server?.pid} on :${PORT}`);
    return;
  }
  if (server?.pid) {
    try {
      process.kill(server.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  server = null;
}

// Never orphan the spawned server — ANY exit path cleans up (an orphan
// poisons the next run by holding the port AND answering its health checks).
process.on('exit', killServer);
process.on('SIGINT', () => {
  killServer();
  process.exit(130);
});
process.on('unhandledRejection', (reason) => {
  // Record, don't die — a library rejection inside a leg belongs to that leg.
  console.error('UNHANDLED REJECTION:', reason instanceof Error ? reason.message : reason);
});

function withTimeout<T>(step: string, p: Promise<T>, ms = TIMEOUT_MS): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${step}: timed out after ${ms}ms`)), ms),
    ),
  ]);
}

// -- file-upload fixtures ----------------------------------------------------------

/** A valid 1×1 PNG (transparent pixel) — the smallest blob that survives the
 * mime allowlist as a real image. Sent through discord.js as a Buffer. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

interface AttachmentObject {
  id: string;
  filename: string;
  name?: string;
  content_type?: string;
  contentType?: string;
  size: number;
  url: string;
}

// -- native REST fixtures ---------------------------------------------------------

async function rest<T>(method: string, path: string, token: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as T;
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

/** The non-throwing twin for ORACLE probes — the leg asserts the status/body
 * itself (a 403/404 IS the expected outcome, not an error). */
async function restRaw(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** Key-order-insensitive deep equality — the server stores component JSON
 * verbatim, but key ORDER on the wire is not a contract. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a as Record<string, unknown>).sort();
  const bk = Object.keys(b as Record<string, unknown>).sort();
  if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) return false;
  return ak.every((k) =>
    jsonEqual(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k],
    ),
  );
}

/** Normalize a possibly-builder-bearing structure to PLAIN JSON (a
 * stringify round-trip invokes every nested toJSON — builder instances
 * otherwise compare by their `{data}` wrapper, not their wire shape). */
function wireJson(x: unknown): unknown {
  return JSON.parse(JSON.stringify(x));
}

async function registerAndLogin(label: string): Promise<string> {
  const registered = await rest<{ access_token: string }>('POST', '/auth/register', '', {
    username: label,
    email: `${label}@compat.local`,
    password: 'compat-password-1',
  });
  const mail = readFileSync(MAILBOX, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .filter((m) => m.to === `${label}@compat.local` && m.kind === 'verify_email')
    .at(-1);
  if (!mail) throw new Error(`no verify mail for ${label}`);
  await rest('POST', '/auth/verify-email', registered.access_token, { token: mail.token });
  const re = await rest<{ access_token: string }>('POST', '/auth/login', '', {
    identifier: label,
    password: 'compat-password-1',
  });
  return re.access_token;
}

// -- library plumbing --------------------------------------------------------------

const INTENTS =
  GatewayIntentBits.Guilds |
  GatewayIntentBits.GuildMessages |
  GatewayIntentBits.GuildMessageTyping |
  // B-1 bot DMs: the DM event classes ride the DIRECT_* bits (1<<12/13/14)
  // — wired into the main bot's Identify so the DM leg below exercises
  // real delivery through the library.
  GatewayIntentBits.DirectMessages |
  GatewayIntentBits.DirectMessageReactions |
  GatewayIntentBits.DirectMessageTyping;

/** Every client absorbs (and records) library errors — an unhandled
 * EventEmitter 'error' would kill the runner before the report prints. */
function absorbErrors(client: Client, into: { label: string; message: string }[]): void {
  client.on(Events.Error, (err) => {
    into.push({ label: 'Events.Error', message: err instanceof Error ? err.message : String(err) });
  });
  client.on(Events.ShardError, (err) => {
    into.push({ label: 'Events.ShardError', message: err instanceof Error ? err.message : String(err) });
  });
}

// -- run ----------------------------------------------------------------------------

const run = `compat_${Date.now()}`;
console.log(`compat-check: spawning server on :${PORT}`);
await startServer();
console.log('ok    server up');

// --- leg 0: boot + seed (native REST) -----------------------------------------------
let ownerToken = '';
let wsId = '';
let channelA = '';
let channelB = '';
let botId = '';
let botToken = '';
let agentId = '';
let agentToken = '';
let webhookId = '';
let webhookToken = '';

await leg('boot+seed', async () => {
  ownerToken = await registerAndLogin(`own_${run}`);
  // Workspace create answers {workspace: {id, ...}} since the name-uniqueness
  // rework (8006d3b); the flat {id} this read made every later seed call ride
  // /workspaces/undefined/... — the leg failed 403 at boot, so the whole
  // harness (and its discord.js component-click proof) had been dark, masked
  // by the CI runner outage. Accept both shapes.
  const ws = await rest<{ id?: string; workspace?: { id: string } }>(
    'POST',
    '/workspaces',
    ownerToken,
    { name: `compat-ws-${run}` },
  );
  wsId = ws.workspace?.id ?? ws.id ?? '';
  const chA = await rest<{ channel: { id: string } }>(
    'POST',
    `/workspaces/${wsId}/channels`,
    ownerToken,
    { name: 'general' },
  );
  const chB = await rest<{ channel: { id: string } }>(
    'POST',
    `/workspaces/${wsId}/channels`,
    ownerToken,
    { name: 'restricted-b' },
  );
  channelA = chA.channel.id;
  channelB = chB.channel.id;

  // Machine credentials are owner-minted since the agents rework: the
  // workspace-scoped /workspaces/{id}/bots route is retired and /agents was
  // folded into /bots — a machine principal's workspace set derives from its
  // PARENT's memberships (Workspaces R1), so no join step exists or is needed.
  const bot = await rest<{ id: string; token: string }>(
    'POST',
    '/bots',
    ownerToken,
    { name: `compat-bot-${run}` },
  );
  botId = bot.id;
  botToken = bot.token;
  // A bare mint carries NO workspace access (the access document is
  // fail-closed since the agent-scoped rework) — the guild legs need the
  // all-workspaces read_write grant the data-layer tests hand out via
  // AgentGrants. PATCH /bots/:id is the REST form of that grant.
  await rest('PATCH', `/bots/${botId}`, ownerToken, {
    access: { v: 1, dms: 'read_write', workspaces: { mode: 'all', level: 'read_write' } },
  });

  const agent = await rest<{ id: string; token: string }>('POST', '/bots', ownerToken, {
    name: `compat-agent-${run}`,
  });
  agentId = agent.id;
  agentToken = agent.token;
  // The agent-scoped model replaced restrictions with the ACCESS document
  // (fail-closed; the legacy restrictions column is no longer consulted by
  // the resolver). The document rides PATCH, not the mint body — create
  // only parses restrictions. This grant is channelB-only read_write inside
  // the seed workspace; every other channel resolves :none, which is what
  // the out-of-scope and oracle assertions below pin.
  await rest('PATCH', `/bots/${agentId}`, ownerToken, {
    access: {
      v: 1,
      dms: 'none',
      workspaces: {
        mode: 'custom',
        grants: { [wsId]: { level: 'none', channels: { [channelB]: 'read_write' } } },
      },
    },
  });

  const hook = await rest<{ id: string; url: string }>(
    'POST',
    `/channels/${channelA}/webhooks`,
    ownerToken,
    { name: 'compat-hook' },
  );
  webhookId = hook.id;
  webhookToken = hook.url.split('/').pop() ?? '';

  assert(
    'boot+seed',
    wsId && channelA && channelB && channelA !== channelB && botToken.startsWith('cytbot_') &&
      agentToken.startsWith('cytbot_') && webhookId && webhookToken.length >= 32,
    `fixture shape wrong (ws=${wsId} A=${channelA} B=${channelB} bot=${botToken.slice(0, 8)}… agent=${agentToken.slice(0, 8)}… hook=${webhookId}/${webhookToken.length}ch)`,
  );
});

if (!botToken) {
  // Boot/seed failed catastrophically — no library leg can run at all.
  console.error('FATAL: seed failed; aborting before library legs');
  killServer();
  process.exit(1);
}

// --- the wire contract (#61 items 1-4, #63 roster) ------------------------------------
//
// Assertions written from the CLIENT's side — the ones no library leg here can
// make: discord.js tolerates a charset on `content-type`, never fetches
// `/oauth2/applications/@me` during login, and speaks permessage-deflate
// rather than the `?compress=zlib-stream` transport. No Python toolchain: the
// raw socket + `node:zlib` ARE the client, and `zlib.createInflate` with
// window bits 15 is the format Discord's transport actually uses.

/** Waits for `cond`, polling — the transport stream has no framing callback. */
async function waitFor(cond: () => boolean, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(25);
  }
  throw new Error(`wire-contract: timed out waiting for ${label}`);
}

async function transportProbe(): Promise<void> {
  const wsUrl = `${BASE.replace(/^http/, 'ws')}/gateway/websocket?compress=zlib-stream&encoding=json&v=10`;
  const ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';

  // The CLIENT's inflater: a zlib stream (header + sync-flushed members).
  const inflate = zlib.createInflate({ windowBits: 15 });
  const state: { hello: { op?: number } | null; text: string } = { hello: null, text: '' };
  inflate.on('data', (chunk: Buffer) => {
    state.text += chunk.toString('utf8');
    try {
      state.hello = JSON.parse(state.text) as { op?: number };
    } catch {
      /* the member is still partial */
    }
  });

  let closeCode: number | null = null;
  ws.onclose = (ev: CloseEvent) => {
    closeCode = ev.code;
  };
  ws.onmessage = (ev: MessageEvent) => {
    if (ev.data instanceof ArrayBuffer) inflate.write(Buffer.from(ev.data));
  };

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('transport websocket failed to open'));
  });

  // (3) Hello must decode through a ZLIB-format inflater. Raw DEFLATE — the
  // wire before #61 — fails here with `incorrect header check`, which is the
  // failure real clients swallowed into a silent hang.
  await waitFor(() => state.hello !== null, 5_000, 'Hello under a zlib-format inflater');
  assert('wire-contract', state.hello?.op === 10, `expected op 10 Hello, got ${JSON.stringify(state.hello)}`);

  // (4) A plain TEXT Identify (what discord.py sends — it has no compressor)
  // must reach AUTH. 4004 = auth failed; 4001 = decode error (the pre-fix
  // outcome, where the opcode was dropped and the frame hit the inflater).
  ws.send(JSON.stringify({ op: 2, d: { token: 'cytbot_not-a-real-token', v: 10, intents: 1 } }));
  await waitFor(() => closeCode !== null, 5_000, 'the auth close');

  assert(
    'wire-contract',
    closeCode === 4004,
    `plain-TEXT Identify on a compressed transport closed ${closeCode} (want 4004 auth-failed; 4001 = decode error)`,
  );

  ws.close();
}

/** Reads the required-key contract off a real compat session's bootstrap.
 *
 * Written from the CLIENT's contract (the field lists come from discord.py's
 * UNGUARDED `data[...]` accesses — #64's audit), never by importing the
 * server's codec: the whole point is that a payload can be schema-valid and
 * still end `Client.connect()` on a missing key. */
async function rosterProbe(): Promise<void> {
  const wsUrl = `${BASE.replace(/^http/, 'ws')}/gateway/websocket?compress=zlib-stream&encoding=json&v=10`;
  const ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';
  const inflate = zlib.createInflate({ windowBits: 15 });

  const frames: Record<string, unknown>[] = [];
  let buf = '';
  inflate.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    // Concatenated JSON envelopes: split complete top-level objects out.
    let depth = 0;
    let start = -1;
    let inStr = false;
    let esc = false;
    let cut = 0;
    for (let i = 0; i < buf.length; i += 1) {
      const c = buf[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') {
        if (depth === 0) start = i;
        depth += 1;
      } else if (c === '}') {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          try {
            frames.push(JSON.parse(buf.slice(start, i + 1)) as Record<string, unknown>);
          } catch {
            /* skip */
          }
          cut = i + 1;
          start = -1;
        }
      }
    }
    if (cut > 0) buf = buf.slice(cut);
  });

  ws.onmessage = (ev: MessageEvent) => {
    if (ev.data instanceof ArrayBuffer) inflate.write(Buffer.from(ev.data));
  };

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('roster websocket failed to open'));
  });

  // A plain TEXT Identify with the REAL token (the frame type discord.py sends).
  ws.send(
    JSON.stringify({
      op: 2,
      d: { token: botToken, v: 10, intents: 1, properties: { $os: 'linux', $browser: 'wire-contract', $device: 'wire-contract' } },
    }),
  );

  await waitFor(() => frames.some((f) => f.t === 'GUILD_CREATE'), 10_000, 'GUILD_CREATE');

  const ready = frames.find((f) => f.t === 'READY') as { d?: Record<string, unknown> } | undefined;
  assert('wire-contract', !!ready?.d?.session_id, 'no READY over the compressed transport');
  // `AutoShardedConnectionState.parse_ready` indexes data['shard'][0] unguarded.
  assert('wire-contract', Array.isArray(ready?.d?.shard), `READY.shard missing: ${JSON.stringify(ready?.d?.shard)}`);

  const guildCreate = frames.find((f) => f.t === 'GUILD_CREATE') as
    | { d?: Record<string, unknown> }
    | undefined;
  const guild = (guildCreate?.d ?? {}) as Record<string, unknown>;

  // #64 item 1 — every channel object needs an integer `position`
  // (TextChannel._update / CategoryChannel._update, unguarded).
  const channels = (guild.channels ?? []) as Record<string, unknown>[];
  assert('wire-contract', channels.length > 0, 'GUILD_CREATE carried no channels to check');
  for (const ch of channels) {
    assert(
      'wire-contract',
      Number.isInteger(ch.position),
      `channel ${String(ch.id)} position must be an int, got ${JSON.stringify(ch.position)}`,
    );
  }

  // #64 item 2 — thread objects need the three top-level fields and the two
  // metadata keys discord.py reads unguarded. This repo's seed creates no
  // thread, so the shape is asserted where present AND recorded as vacuous
  // otherwise (the server-side suite covers the populated case).
  const threads = (guild.threads ?? []) as Record<string, unknown>[];
  for (const t of threads) {
    const meta = (t.thread_metadata ?? {}) as Record<string, unknown>;
    for (const key of ['owner_id', 'message_count', 'member_count', 'thread_metadata']) {
      assert('wire-contract', key in t, `thread ${String(t.id)} missing ${key}`);
    }
    for (const key of ['archived', 'auto_archive_duration', 'archive_timestamp']) {
      assert('wire-contract', key in meta, `thread ${String(t.id)} metadata missing ${key}`);
    }
  }

  // The roster must be usable: `guild.me` resolves through an unguarded
  // get_member(self_id), and member_count must be an int.
  const members = (guild.members ?? []) as Record<string, unknown>[];
  assert('wire-contract', Number.isInteger(guild.member_count), `member_count ${JSON.stringify(guild.member_count)}`);
  assert(
    'wire-contract',
    members.some((m) => (m.user as Record<string, unknown> | undefined)?.id === botId),
    'the connecting bot is not in members (guild.me would be None)',
  );

  ws.close();
}

/** The part shape a REAL library sends, asserted over the wire (#65).
 *
 * discord.py hardcodes every `files[n]` part's content-type as
 * `application/octet-stream` (`discord/http.py`) — it has no code path that
 * emits anything else — so a bot could not upload ANY file while the server
 * compared that literal against the mime allowlist. This harness's own
 * upload leg builds its part from a `Blob` with an explicit `image/png`
 * type, which is a shape no library produces: it passed whether or not the
 * filename fallback works. This probe sends the bytes a library sends. */
async function octetStreamUploadProbe(): Promise<void> {
  const fd = new FormData();
  fd.append('payload_json', JSON.stringify({ content: 'octet-stream contract' }));
  // The critical detail: the part header says nothing about the file.
  fd.append('files[0]', new Blob([PNG_1X1], { type: 'application/octet-stream' }), 'contract.png');

  const res = await fetch(`${BASE}/api/v10/channels/${channelA}/messages`, {
    method: 'POST',
    headers: { authorization: `Bot ${botToken}` },
    body: fd,
  });
  // Read the body ONCE (a `await res.text()` inside the assert message would
  // consume it before the parse below).
  const msg = (await res.json().catch(() => null)) as {
    attachments?: { content_type?: string; proxy_url?: string; width?: number; height?: number }[];
  } | null;

  assert(
    'wire-contract',
    res.status === 201,
    `octet-stream upload → ${res.status} ${JSON.stringify(msg)}`,
  );

  const att = msg?.attachments?.[0];
  assert('wire-contract', !!att, 'no attachment object on the created message');
  // The filename decided: stored and served as the real type, not the header.
  assert(
    'wire-contract',
    att?.content_type === 'image/png',
    `content_type must resolve from the filename, got ${JSON.stringify(att?.content_type)}`,
  );
  assert('wire-contract', !!att?.proxy_url, 'attachment missing proxy_url (#64)');
  assert('wire-contract', att?.width === 1 && att?.height === 1, `sniffed dims missing: ${att?.width}x${att?.height}`);
}

/** #67: a Discord client's recovery path is op 6 RESUME. Written from the
 * client's contract — the harness used to stop at a green Identify, so a
 * resume that closes 4002 (a code Discord clients treat as RESUMABLE, i.e.
 * retry-forever) was invisible to every automated check. */
async function resumeProbe(): Promise<void> {
  const wsUrl = `${BASE.replace(/^http/, 'ws')}/gateway/websocket?compress=zlib-stream&encoding=json&v=10`;

  /** Opens a compat session, sends one frame, and collects decoded frames. */
  async function session(send?: () => void) {
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    const inflate = zlib.createInflate({ windowBits: 15 });
    const frames: Record<string, unknown>[] = [];
    const closed: { code: number | null } = { code: null };
    let buf = '';
    inflate.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let depth = 0;
      let start = -1;
      let inStr = false;
      let esc = false;
      let cut = 0;
      for (let i = 0; i < buf.length; i += 1) {
        const c = buf[i];
        if (inStr) {
          if (esc) esc = false;
          else if (c === '\\') esc = true;
          else if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') inStr = true;
        else if (c === '{') {
          if (depth === 0) start = i;
          depth += 1;
        } else if (c === '}') {
          depth -= 1;
          if (depth === 0 && start >= 0) {
            try {
              frames.push(JSON.parse(buf.slice(start, i + 1)) as Record<string, unknown>);
            } catch {
              /* skip */
            }
            cut = i + 1;
            start = -1;
          }
        }
      }
      if (cut > 0) buf = buf.slice(cut);
    });
    ws.onmessage = (ev: MessageEvent) => {
      if (process.env.WIRE_DEBUG) {
        const d = typeof ev.data === 'string' ? ev.data.slice(0, 120) : `[binary ${ev.data.byteLength}B]`;
        console.error(`WIRE_DEBUG msg: ${d}`);
      }
      if (typeof ev.data === 'string') {
        // TEXT frames parse directly — silently dropping them (this reader's
        // old shape) made a text-serving session read as "never answered"
        // and cost an evening of false resume-flake suspicion (2026-09-23).
        frames.push(JSON.parse(ev.data) as Record<string, unknown>);
        return;
      }
      if (ev.data instanceof ArrayBuffer) inflate.write(Buffer.from(ev.data));
    };
    ws.onclose = (ev: CloseEvent) => {
      closed.code = ev.code;
    };
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('resume probe socket failed to open'));
    });
    if (send) send();
    return { ws, frames, closed };
  }

  // Session 1: identify and keep the session id — exactly what a library
  // holds when the socket drops. (The send must run AFTER session() returns
  // the handle — the old inline callback referenced `first` from inside its
  // own initializer, a TDZ crash the dark-harness years never exercised.)
  const first = await session();
  first.ws.send(
    JSON.stringify({
      op: 2,
      d: {
        token: botToken,
        v: 10,
        intents: 1,
        properties: { $os: 'linux', $browser: 'wire-contract', $device: 'wire-contract' },
      },
    }),
  );
  await waitFor(() => first.frames.some((f) => f.t === 'READY'), 10_000, 'READY before resume');
  const sessionId = ((first.frames.find((f) => f.t === 'READY') as { d?: { session_id?: string } }).d
    ?.session_id ?? '') as string;
  assert('wire-contract', sessionId.startsWith('s'), `no session_id in READY: ${sessionId}`);
  // AWAIT the close handshake — a real client reconnects after its socket
  // finishes closing, and resuming while the old connection's teardown is
  // still in flight intermittently lost the reply (the evening's "resume
  // flake", 2026-09-23: the server provably pushed RESUMED — logged and
  // received by an external probe — while this raced session read
  // nothing). close() alone only BEGINS the handshake.
  first.ws.close();
  await waitFor(() => first.closed.code !== null, 5_000, 'session 1 close handshake');

  // Session 2: the drop → reconnect → RESUME sequence Discord clients perform.
  const second = await session();
  // A real client sends RESUME only after CONSUMING HELLO (discord.py and
  // discord.js both drive identify/resume off the HELLO event) — sending on
  // socket-open raced the server's per-connection setup and intermittently
  // lost the reply outright (the wire-contract flake, 2026-09-23).
  await waitFor(() => second.frames.some((f) => f.op === 10), 5_000, 'HELLO before resume');
  const resumeBody = JSON.stringify({ op: 6, d: { token: botToken, session_id: sessionId, seq: 0 } });
  second.ws.send(resumeBody);
  await waitFor(() => second.frames.some((f) => f.t === 'RESUMED' || f.op === 9) || second.closed.code !== null, 10_000, 'a resume answer');

  const resumed = second.frames.find((f) => f.t === 'RESUMED');
  const invalidSession = second.frames.find((f) => f.op === 9);
  assert(
    'wire-contract',
    !!resumed || !!invalidSession,
    `op 6 RESUME got neither RESUMED nor an InvalidSession frame: frames=${JSON.stringify(second.frames.map((f) => f.t ?? f.op))} close=${second.closed.code}`,
  );
  // 4002/4004 mean the client either retries Resume forever or gives up: both
  // leave a bot permanently deaf while the server still counts it online.
  assert(
    'wire-contract',
    second.closed.code === null || ![4002, 4004].includes(second.closed.code),
    `resume closed with ${second.closed.code} (4002/4004 are unrecoverable for a Discord client)`,
  );
  second.ws.close();
}

await leg('wire-contract', async () => {
  // (1) Compat responses are framed EXACTLY `application/json` — discord.py
  // compares the header string for equality (`discord/http.py`), so a charset
  // parameter turns every body into untranslatable text.
  const meRes = await fetch(`${BASE}/api/v10/users/@me`, {
    headers: { authorization: `Bot ${botToken}` },
  });
  assert('wire-contract', meRes.status === 200, `compat /users/@me → ${meRes.status}`);

  const contentType = meRes.headers.get('content-type');
  assert(
    'wire-contract',
    contentType === 'application/json',
    `compat content-type must be exactly application/json, got: ${contentType}`,
  );

  // (2) The application object `Client.login()` fetches BEFORE opening a
  // socket, at both spellings (discord.py /oauth2/, discord.js bare). Every
  // key here is read by `discord.appinfo.AppInfo.__init__` with `data[...]`.
  for (const path of ['/oauth2/applications/@me', '/applications/@me']) {
    const res = await fetch(`${BASE}/api/v10${path}`, {
      headers: { authorization: `Bot ${botToken}` },
    });
    assert('wire-contract', res.status === 200, `${path} → ${res.status}`);

    const app = (await res.json()) as Record<string, unknown>;
    for (const key of [
      'id',
      'name',
      'description',
      'icon',
      'bot_public',
      'bot_require_code_grant',
      'owner',
      'verify_key',
    ]) {
      assert('wire-contract', key in app, `${path} is missing required key ${key}`);
    }
    assert('wire-contract', app.id === botId, `${path} id ${String(app.id)} != ${botId}`);
  }

  await transportProbe();
  await rosterProbe();
  await octetStreamUploadProbe();
  await resumeProbe();
});

// --- the Hermes test: ONE discord.js client as the bot -------------------------------

const client = new Client({
  intents: INTENTS,
  rest: { api: `${BASE}/api` } as never,
});
const clientErrors: { label: string; message: string }[] = [];
absorbErrors(client, clientErrors);

/** Raw INTERACTION_CREATE payloads seen on the wire — the failure delta when
 * the library drops the dispatch (Events.Raw carries every raw dispatch). */
const rawInteractions: unknown[] = [];
client.on(Events.Raw, (data) => {
  if ((data as { t?: string }).t === 'INTERACTION_CREATE') {
    rawInteractions.push((data as { d?: unknown }).d);
  }
});

const botMessages: Message[] = [];
client.on(Events.MessageCreate, (msg) => botMessages.push(msg));

const interactions: ChatInputCommandInteraction[] = [];
/** Components plan U5 (R9): the type-3 half of the collector — every
 * sub-case waits on one of these. A malformed payload throws inside the
 * library's constructor and the event NEVER fires (the entitlements lesson,
 * institutionalized: consumption is the proof). */
const componentInteractions: MessageComponentInteraction[] = [];
/** #30: the type-5 half — modal submits, consumed as ModalSubmitInteraction. */
const modalSubmits: ModalSubmitInteraction[] = [];
const debugLines: string[] = [];
client.on('debug', (line) => debugLines.push(String(line)));
client.on(Events.InteractionCreate, (i) => {
  try {
    if (i.isChatInputCommand()) interactions.push(i);
    else if (i.isMessageComponent()) componentInteractions.push(i);
    else if (i.isModalSubmit()) modalSubmits.push(i);
    else debugLines.push(`[HARNESS] interactionCreate fired but not chat-input/component: type=${i.type} commandType=${(i as { commandType?: number }).commandType}`);
  } catch (probeErr) {
    debugLines.push(`[HARNESS] interactionCreate probe threw: ${String(probeErr)}`);
  }
});

let readyUserBot: boolean | null = null;
await leg('library-connect', async () => {
  const ready = new Promise<void>((resolve) => {
    client.once(Events.ClientReady, (c) => {
      readyUserBot = c.user.bot;
      resolve();
    });
  });
  await withTimeout('library login', client.login(botToken));
  await ready;
  assert('library-connect', readyUserBot === true, `READY user.bot=${String(readyUserBot)} (expected true)`);

  await withTimeout(
    'guild cache resolve (GUILD_CREATE)',
    (async () => {
      for (let i = 0; i < 100; i++) {
        if (client.guilds.cache.has(wsId)) return;
        await sleep(100);
      }
      throw new Error(`guild ${wsId} never landed in the client cache`);
    })(),
  );
  const guild = client.guilds.cache.get(wsId)!;
  assert(
    'library-connect',
    guild.channels.cache.has(channelA) && guild.channels.cache.has(channelB),
    `GUILD_CREATE channels missing (A=${guild.channels.cache.has(channelA)} B=${guild.channels.cache.has(channelB)})`,
  );
});

let sentByLibrary: Message | null = null;
await leg('library-messaging', async () => {
  // Human posts via NATIVE REST → library messageCreate fires (guild-scoped).
  await rest<{ message: { id: string } }>('POST', `/channels/${channelA}/messages`, ownerToken, {
    content: 'compat: native hello',
  });
  const received = await withTimeout(
    'messageCreate for the native-posted message',
    (async () => {
      for (let i = 0; i < 200; i++) {
        const hit = botMessages.find((m) => m.channelId === channelA && m.content === 'compat: native hello');
        if (hit) return hit;
        await sleep(100);
      }
      throw new Error('messageCreate never fired for the native-posted message');
    })(),
  );
  assert(
    'library-messaging',
    received.guild?.id === wsId,
    `message.guild unresolved: got ${String(received.guild?.id)} expected ${wsId}`,
  );
  assert(
    'library-messaging',
    received.author?.bot === false,
    `human author bot flag: got ${String(received.author?.bot)} expected false`,
  );

  // Library SENDS → visible via native history.
  const channel = client.channels.cache.get(channelA);
  if (!(channel instanceof TextChannel)) {
    throw new Error(`channel ${channelA} is not a TextChannel in the guild cache`);
  }
  sentByLibrary = await withTimeout('discord.js send', channel.send('compat: library hello'));

  // Library REPLIES (message_reference) → type 19 + referenced_message round-trip.
  // Reply target is the HUMAN's native message so the snapshot's author is
  // distinguishable from the replying bot.
  const reply = await withTimeout('discord.js reply', received.reply('compat: library reply'));
  assert(
    'library-messaging',
    Number(reply.type) === MessageType.Reply,
    `reply type: got ${String(reply.type)} expected 19 (Reply)`,
  );
  assert(
    'library-messaging',
    reply.reference?.messageId === received.id,
    `reply.message_reference: got ${String(reply.reference?.messageId)} expected ${received.id}`,
  );
  assert(
    'library-messaging',
    reply.mentions.repliedUser?.id === received.author?.id,
    // discord.js 14.27 dropped Message#referencedMessage; the snapshot's
    // author surfaces as mentions.repliedUser when referenced_message rides
    // the payload.
    `reply.referenced_message snapshot author: got ${String(reply.mentions.repliedUser?.id)} expected the human ${String(received.author?.id)}`,
  );

  // Native history cross-check: send + reply both landed, reply carries reply_to_id.
  const history = await rest<{ messages: NativeMessage[] }>(
    'GET',
    `/channels/${channelA}/messages?limit=10`,
    ownerToken,
  );
  const landedSend = history.messages.find((m) => m.id === sentByLibrary!.id);
  assert(
    'library-messaging',
    landedSend?.content === 'compat: library hello',
    `library send missing from native history (found=${String(Boolean(landedSend))})`,
  );
  const landedReply = history.messages.find((m) => m.id === reply.id);
  assert(
    'library-messaging',
    landedReply?.reply_to_id === received.id,
    `native reply_to_id: got ${String(landedReply?.reply_to_id)} expected ${String(received.id)}`,
  );

  // B-1 bot DMs: the bot opens a DM with the OWNER via the compat route
  // (POST /users/@me/channels — the library's own REST), sends into it, and
  // its own session receives the DM MESSAGE_CREATE on DIRECT_MESSAGES
  // (1<<12) — participation IS authorization, restrictions deliberately do
  // not apply. The channel-allowlist agent leg later re-proves the bypass.
  const me = await rest<{ user: { id: string } }>('GET', '/users/@me', ownerToken);
  const ownerId = me.user.id;
  const dmChannel = await withTimeout('discord.js createDM', client.users.createDM(ownerId));
  assert(
    'library-messaging',
    Number(dmChannel.type) === ChannelType.DM,
    `DM channel type: got ${String(dmChannel.type)} expected ${ChannelType.DM}`,
  );
  const dmSent = await withTimeout('discord.js DM send', dmChannel.send('compat: dm hello'));
  const dmEcho = await withTimeout(
    'DM messageCreate on DIRECT_MESSAGES',
    (async () => {
      for (let i = 0; i < 200; i++) {
        const hit = botMessages.find((m) => m.channelId === dmChannel.id && m.id === dmSent.id);
        if (hit) return hit;
        await sleep(100);
      }
      throw new Error('DM messageCreate never fired for the bot\'s own send');
    })(),
  );
  assert(
    'library-messaging',
    dmEcho.guild === null,
    `DM message.guild_id: got ${String(dmEcho.guild)} expected null (DMs carry no guild)`,
  );
});

let commandId = '';
await leg('interaction-loop', async () => {
  // Register an application command THROUGH THE LIBRARY (bulk PUT).
  const guild = client.guilds.cache.get(wsId);
  if (!guild) throw new Error('guild not in cache — connect leg must pass first');
  const set = await withTimeout(
    'library command registration (PUT applications/{bot}/guilds/{ws}/commands)',
    guild.commands.set([{ name: 'compat-ping', description: 'Cytale compat acceptance ping' }]),
  );
  commandId = set.first()?.id ?? '';
  assert('interaction-loop', commandId.length > 0, 'library command registration returned no command id');

  // Human invokes the command via NATIVE REST.
  await rest('POST', '/interactions', ownerToken, {
    command_id: commandId,
    channel_id: channelA,
  });

  // The library must surface INTERACTION_CREATE as interactionCreate.
  let interaction: ChatInputCommandInteraction | undefined;
  try {
    interaction = await withTimeout(
      'interactionCreate (INTERACTION_CREATE consumed by the library)',
      (async () => {
        for (let i = 0; i < 150; i++) {
          if (interactions.length > 0) return interactions[0]!;
          await sleep(100);
        }
        throw new Error('interactionCreate never fired');
      })(),
      15_000,
    );
  } catch (err) {
    // Delta report: what the library ACTUALLY received on the wire vs what
    // Discord's INTERACTION_CREATE carries, plus any absorbed client errors
    // and INTERACTION-related debug lines (constructor throws surface here).
    throw new Error(
      `${err instanceof Error ? err.message : err}. Delta — received INTERACTION_CREATE payload: ${JSON.stringify(
        rawInteractions.at(-1) ?? 'NONE (dispatch never arrived)',
      )}; clientErrors: ${JSON.stringify(clientErrors)}; interactionDebug: ${JSON.stringify(
        debugLines.filter((l) => /INTERACTION/i.test(l)).slice(-5),
      )}`,
    );
  }

  assert(
    'interaction-loop',
    interaction.commandName === 'compat-ping',
    `commandName: got ${interaction.commandName} expected compat-ping`,
  );

  // The library RESPONDS via its native reply path — the callback POST
  // carries no auth header; our route accepts the URL token.
  await withTimeout('interaction.reply (callback POST)', interaction.reply({ content: 'compat: interaction reply' }));

  // The bot's response lands in native history with the BOT as author.
  const history = await rest<{ messages: NativeMessage[] }>(
    'GET',
    `/channels/${channelA}/messages?limit=10`,
    ownerToken,
  );
  const response = history.messages.find((m) => m.content === 'compat: interaction reply');
  assert(
    'interaction-loop',
    Boolean(response),
    'the callback-created message never landed in native history',
  );
  assert(
    'interaction-loop',
    Number(response!.author_id) === Number(botId),
    // native rows carry author_id as a raw (lossy-in-JS) integer — compare
    // through the same double rounding on both sides.
    `callback message author_id: got ${String(response!.author_id)} expected the bot ${botId}`,
  );
});

await leg('webhook-execute', async () => {
  // Bare Discord execute payload with wait=true — raw fetch on the
  // CAPABILITY URL the native create returned (WebhookClient would version
  // the route /api/v10/webhooks/... which our server deliberately serves
  // only unversioned; the URL token IS the credential either way).
  const hookUrl = `${BASE}/api/webhooks/${webhookId}/${webhookToken}`;
  const executed = await fetch(`${hookUrl}?wait=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'compat: webhook hello', username: 'compat-override' }),
  });
  const message = (await executed.json().catch(() => null)) as
    | { id: string; content: string; webhook_id?: string; author?: { bot?: boolean; username?: string } }
    | null;
  if (!executed.ok || !message) {
    throw new Error(`bare execute: HTTP ${executed.status}: ${JSON.stringify(message)}`);
  }
  assert(
    'webhook-execute',
    message.content === 'compat: webhook hello' && message.id,
    `wait=true response shape: ${JSON.stringify(message)}`,
  );
  assert(
    'webhook-execute',
    message.webhook_id === webhookId,
    `webhook_id: got ${String(message.webhook_id)} expected ${webhookId}`,
  );
  assert(
    'webhook-execute',
    message.author?.bot === true && message.author?.username === 'compat-override',
    `webhook author: ${JSON.stringify(message.author)}`,
  );

  // GitHub push event → content line + embed card fields.
  const gh = await fetch(`${hookUrl}/github`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-github-event': 'push' },
    body: JSON.stringify({
      ref: 'refs/heads/main',
      compare: 'https://example.test/compare/before...after',
      pusher: { name: 'compat-ci' },
      repository: { full_name: 'cytale/compat' },
      commits: [{ id: 'abc1234def', message: 'add compat harness' }],
    }),
  });
  const card = (await gh.json().catch(() => null)) as
    | { id: string; content: string; embeds?: Array<{ title?: string; url?: string; fields?: Array<{ name: string; value: string }> }> }
    | null;
  if (!gh.ok || !card) {
    throw new Error(`/github execute: HTTP ${gh.status}: ${JSON.stringify(card)}`);
  }
  assert(
    'webhook-execute',
    card.content === '[cytale/compat] compat-ci pushed 1 commit to main: abc1234: add compat harness',
    `push content: got "${card.content}"`,
  );
  const embed = card.embeds?.[0];
  assert(
    'webhook-execute',
    embed?.title === '[cytale/compat] 1 new commit to main' && embed?.url === 'https://example.test/compare/before...after',
    `push embed card: ${JSON.stringify(embed)}`,
  );
  assert(
    'webhook-execute',
    embed?.fields?.some((f) => f.name === 'Pusher' && f.value === 'compat-ci') === true,
    `push embed fields: ${JSON.stringify(embed?.fields)}`,
  );

  // Both messages visible in NATIVE history with webhook attribution
  // (author_id = the webhook principal).
  const history = await rest<{ messages: NativeMessage[] }>(
    'GET',
    `/channels/${channelA}/messages?limit=25`,
    ownerToken,
  );
  for (const expected of [
    { id: message.id, content: 'compat: webhook hello' },
    { id: card.id, content: card.content },
  ]) {
    const found = history.messages.find((m) => m.id === expected.id);
    // Native rows carry author_id as a raw integer (lossy past 2^53 in JS);
    // both sides go through Number()'s identical double rounding.
    assert(
      'webhook-execute',
      found?.content === expected.content && Number(found?.author_id) === Number(webhookId),
      `native history attribution for ${expected.id}: ${JSON.stringify(found)}`,
    );
  }
});

// --- file upload: Discord's multipart file model through a REAL library -------

await leg('file-upload', async () => {
  const guild = client.guilds.cache.get(wsId);
  const channel = guild?.channels.cache.get(channelA);
  if (!(channel instanceof TextChannel)) {
    throw new Error(`channel ${channelA} is not a TextChannel in the guild cache`);
  }

  // 1. discord.js SENDS A FILE: the library builds the multipart request
  //    (payload_json + files[0]) exactly as it would against Discord — the
  //    compat message-create multipart surface must answer with the created
  //    message carrying a real attachment object.
  const sent = await withTimeout(
    'discord.js file send (multipart message create)',
    channel.send({
      content: 'compat: file upload',
      files: [new AttachmentBuilder(PNG_1X1, { name: 'compat-pixel.png' })],
    }),
  );
  const [att] = [...sent.attachments.values()] as unknown as AttachmentObject[];
  assert(
    'file-upload',
    Boolean(att) && att.url.startsWith(`${BASE}/api/v1/attachments/`),
    `message.attachments missing or foreign: ${JSON.stringify(sent.attachments.map((a) => a.url))}`,
  );
  assert(
    'file-upload',
    att.name === 'compat-pixel.png' && att.size === PNG_1X1.length,
    `attachment name/size: ${String(att.name)}/${String(att.size)} expected compat-pixel.png/${String(PNG_1X1.length)}`,
  );
  assert(
    'file-upload',
    att.contentType === 'image/png',
    `attachment contentType: ${String(att.contentType)} expected image/png`,
  );

  // 2. The attachment URL serves the bytes back as an image (inline render).
  const blob = await fetch(att.url);
  assert('file-upload', blob.ok, `GET ${att.url}: HTTP ${blob.status}`);
  assert(
    'file-upload',
    (blob.headers.get('content-type') ?? '').startsWith('image/png'),
    `served content-type: ${String(blob.headers.get('content-type'))} expected image/png`,
  );
  assert(
    'file-upload',
    (blob.headers.get('content-disposition') ?? '').startsWith('inline'),
    `served content-disposition: ${String(blob.headers.get('content-disposition'))} expected inline for images`,
  );
  const bytes = Buffer.from(await blob.arrayBuffer());
  assert('file-upload', bytes.equals(PNG_1X1), `served ${String(bytes.length)} bytes, expected ${String(PNG_1X1.length)}`);

  // 3. Native history carries the stored descriptor (the owner reads it).
  const history = await rest<{
    messages: Array<NativeMessage & { attachments?: Array<{ filename: string; url: string }> }>;
  }>('GET', `/channels/${channelA}/messages?limit=10`, ownerToken);
  const landed = history.messages.find((m) => m.id === sent.id);
  assert(
    'file-upload',
    Boolean(landed?.attachments?.some((a) => a.filename === 'compat-pixel.png' && a.url === att.url)),
    `native history attachments for ${sent.id}: ${JSON.stringify(landed?.attachments)}`,
  );

  // 4. Webhook multipart execute (raw FormData): one file + payload_json —
  //    the created message lands with the attachment.
  const fd = new FormData();
  fd.append('payload_json', JSON.stringify({ content: 'compat: webhook file', username: 'compat-files' }));
  fd.append('files[0]', new Blob([PNG_1X1], { type: 'image/png' }), 'compat-hook.png');
  const hookRes = await fetch(`${BASE}/api/webhooks/${webhookId}/${webhookToken}?wait=true`, {
    method: 'POST',
    body: fd,
  });
  const hookMsg = (await hookRes.json().catch(() => null)) as
    | { id: string; content: string; attachments?: AttachmentObject[] }
    | null;
  if (!hookRes.ok || !hookMsg) {
    throw new Error(`webhook multipart execute: HTTP ${hookRes.status}: ${JSON.stringify(hookMsg)}`);
  }
  const hookAtt = hookMsg.attachments?.[0];
  assert(
    'file-upload',
    hookMsg.content === 'compat: webhook file' &&
      Boolean(hookAtt) &&
      hookAtt!.filename === 'compat-hook.png' &&
      hookAtt!.url.startsWith(`${BASE}/api/v1/attachments/`),
    `webhook multipart message: ${JSON.stringify(hookMsg)}`,
  );

  // 5. The webhook's blob serves back too.
  const hookBlob = await fetch(hookAtt!.url);
  assert(
    'file-upload',
    hookBlob.ok && (hookBlob.headers.get('content-type') ?? '').startsWith('image/png'),
    `webhook blob GET ${hookAtt!.url}: HTTP ${hookBlob.status} content-type ${String(hookBlob.headers.get('content-type'))}`,
  );
});

// --- restricted-agent variant: a SECOND library client -------------------------------

const agentClient = new Client({
  intents: INTENTS,
  rest: { api: `${BASE}/api` } as never,
});
const agentErrors: { label: string; message: string }[] = [];
absorbErrors(agentClient, agentErrors);
const agentMessages: Message[] = [];
agentClient.on(Events.MessageCreate, (msg) => agentMessages.push(msg));

await leg('restricted-agent', async () => {
  await withTimeout('restricted agent login', agentClient.login(agentToken));
  await withTimeout(
    'restricted agent READY',
    (async () => {
      for (let i = 0; i < 150; i++) {
        if (agentClient.isReady()) return;
        await sleep(100);
      }
      throw new Error('restricted agent never reached READY');
    })(),
    15_000,
  );
  assert(
    'restricted-agent',
    agentClient.guilds.cache.has(wsId),
    'restricted agent never got the GUILD_CREATE',
  );

  // Channel-B message IS delivered.
  await rest('POST', `/channels/${channelB}/messages`, ownerToken, {
    content: 'compat: restricted in-scope',
  });
  await withTimeout(
    'in-scope MESSAGE_CREATE',
    (async () => {
      for (let i = 0; i < 150; i++) {
        if (agentMessages.some((m) => m.channelId === channelB && m.content === 'compat: restricted in-scope')) {
          return;
        }
        await sleep(100);
      }
      throw new Error('channel-B message never reached the restricted agent');
    })(),
    15_000,
  );

  // Channel-A message is NOT delivered (visibility filter) — wait it out.
  await rest('POST', `/channels/${channelA}/messages`, ownerToken, {
    content: 'compat: restricted out-of-scope',
  });
  await sleep(NEGATIVE_MS);
  assert(
    'restricted-agent',
    !agentMessages.some((m) => m.content === 'compat: restricted out-of-scope'),
    'out-of-profile channel-A message LEAKED to the restricted agent',
  );

  // Liveness proof (B7d): the negative window must be a FILTER drop, not a
  // dead socket — post another IN-SCOPE message and assert it arrives...
  await rest('POST', `/channels/${channelB}/messages`, ownerToken, {
    content: 'compat: restricted in-scope (liveness)',
  });
  await withTimeout(
    'in-scope MESSAGE_CREATE after the negative window',
    (async () => {
      for (let i = 0; i < 150; i++) {
        if (
          agentMessages.some((m) => m.channelId === channelB && m.content === 'compat: restricted in-scope (liveness)')
        ) {
          return;
        }
        await sleep(100);
      }
      throw new Error('post-negative in-scope message never reached the restricted agent (socket dead?)');
    })(),
    15_000,
  );

  // ...then re-assert the out-of-scope absence (the filter still holds).
  assert(
    'restricted-agent',
    !agentMessages.some((m) => m.content === 'compat: restricted out-of-scope'),
    'out-of-profile channel-A message LEAKED to the restricted agent (post-liveness re-check)',
  );

  // Out-of-profile REST read → 404 Unknown Channel (anti-enumeration).
  let fetchError: unknown;
  try {
    await agentClient.channels.fetch(channelA);
    fetchError = null;
  } catch (err) {
    fetchError = err;
  }
  const status = (fetchError as { status?: number } | null)?.status;
  const code = (fetchError as { code?: number } | null)?.code;
  assert(
    'restricted-agent',
    status === 404 && code === 10003,
    `out-of-profile channel fetch: got status=${String(status)} code=${String(code)} expected 404/10003 (Unknown Channel)`,
  );

  // The client survived our error shapes — still ready, still connected.
  assert(
    'restricted-agent',
    agentClient.isReady(),
    `agent client not ready after the 404 (isReady=${String(agentClient.isReady())})`,
  );
});

// --- revocation mid-run: agent revoked while its socket is live -----------------------

await leg('revocation', async () => {
  if (!agentClient.isReady()) throw new Error('restricted-agent leg must pass first (client not live)');

  let closeCode: number | null = null;
  const closed = new Promise<void>((resolve) => {
    agentClient.on(Events.ShardDisconnect, (event) => {
      closeCode = (event as { code?: number }).code ?? null;
      resolve();
    });
  });

  await rest('DELETE', `/bots/${agentId}`, ownerToken);
  await withTimeout('close 4004 after revocation', closed, 15_000);
  assert('revocation', closeCode === 4004, `close code: got ${String(closeCode)} expected 4004`);

  // The library's reconnect handling must FAIL CLEANLY: 4004 is fatal in
  // Discord semantics — the shard settles Disconnected (no reconnect spin:
  // no second READY, no Connecting/Reconnecting state), and the runner is
  // never hung. Note: client.isReady() keeps returning true here — the
  // manager-level status is sticky after a fatal close (library behavior),
  // so the shard status is the honest signal.
  let reReady = 0;
  agentClient.on(Events.ClientReady, () => {
    reReady++;
  });
  await sleep(2_000);
  const shard = agentClient.ws.shards.get(0) as unknown as { status?: number } | undefined;
  assert(
    'revocation',
    reReady === 0,
    `client re-fired READY ${reReady}× after the 4004 (reconnect loop suspected)`,
  );
  assert(
    'revocation',
    shard?.status === Status.Disconnected,
    `shard status after 4004: got ${String(shard?.status)} expected Disconnected(${Status.Disconnected}) — reconnect in flight`,
  );
  const authFailure = agentErrors.some((e) => /authentication failed/i.test(e.message));
  console.log(`      library surfaced the auth-failure shard error: ${authFailure}`);
});

// --- components (components plan U5, R9): the click loop proven BY CONSUMPTION --

await leg(
  'components',
  async () => {
    const channel = client.channels.cache.get(channelA);
    if (!(channel instanceof TextChannel)) {
      throw new Error(`channel ${channelA} is not a TextChannel in the guild cache`);
    }
    const me = await rest<{ user: { id: string } }>('GET', '/users/@me', ownerToken);
    const ownerId = me.user.id;

    // The raw-wire delta reporter shared by every wait below — a payload the
    // library's constructor rejects surfaces as "never fired", and the delta
    // shows exactly what arrived on the wire (the entitlements lesson).
    const nextComponent = async (customId: string): Promise<MessageComponentInteraction> => {
      try {
        return await withTimeout(
          `interactionCreate (${customId})`,
          (async () => {
            for (let i = 0; i < 150; i++) {
              const hit = componentInteractions.find((x) => x.customId === customId);
              if (hit) return hit;
              await sleep(100);
            }
            throw new Error(`component interaction ${customId} never fired`);
          })(),
          15_000,
        );
      } catch (err) {
        throw new Error(
          `${err instanceof Error ? err.message : err}. Delta — last raw INTERACTION_CREATE: ${JSON.stringify(
            rawInteractions.at(-1) ?? 'NONE',
          )}; clientErrors: ${JSON.stringify(clientErrors)}; interactionDebug: ${JSON.stringify(
            debugLines.filter((l) => /INTERACTION/i.test(l)).slice(-5),
          )}`,
        );
      }
    };

    // A HUMAN click through the native interaction route (message-keyed body).
    const click = async (messageId: string, customId: string, componentType: 2 | 3, values?: string[]) => {
      const body: Record<string, unknown> = {
        channel_id: channelA,
        message_id: messageId,
        custom_id: customId,
        component_type: componentType,
      };
      if (values) body.values = values;
      return restRaw('POST', '/interactions', ownerToken, body);
    };

    const historyRow = async (channelId: string, messageId: string) => {
      const history = await rest<{ messages: Array<NativeMessage & { components?: unknown }> }>(
        'GET',
        `/channels/${channelId}/messages?limit=25`,
        ownerToken,
      );
      return history.messages.find((m) => m.id === messageId);
    };

    // -- (a) buttons: library send → native-REST click → type-3 consumed →
    //    resolved via interaction.update() (type 7).
    const cardRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('compat-approve').setLabel('Approve').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('compat-defer').setLabel('Defer').setStyle(ButtonStyle.Secondary),
    );
    const card = await withTimeout(
      'discord.js component send',
      channel.send({ content: 'compat: approve this run', components: [cardRow] }),
    );
    // The created object's components round-trip through the library parser.
    const echoed = wireJson(card.components[0]);
    assert(
      'components',
      jsonEqual(echoed, wireJson(cardRow)),
      `send echo components: ${JSON.stringify(echoed)}`,
    );

    let res = await click(card.id, 'compat-approve', 2);
    assert('components', res.status === 202, `approve click: HTTP ${res.status} ${JSON.stringify(res.json)}`);

    const approveI = await nextComponent('compat-approve');
    assert('components', approveI.isButton(), 'approve interaction is not a ButtonInteraction');
    assert(
      'components',
      approveI.message.id === card.id,
      `interaction.message.id: ${String(approveI.message.id)} expected ${card.id}`,
    );
    assert(
      'components',
      approveI.user.id === ownerId,
      `interaction.user.id: ${String(approveI.user.id)} expected ${ownerId}`,
    );
    assert(
      'components',
      approveI.inGuild() && approveI.guildId === wsId,
      `interaction guild: ${String(approveI.guildId)} expected ${wsId}`,
    );

    // The type-7 flip: disable what is consumed, keep the defer button live
    // (the approval-card lifecycle — the sub-case below still needs it).
    const halfResolvedRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('compat-approve').setLabel('Approved').setStyle(ButtonStyle.Success).setDisabled(true),
      new ButtonBuilder().setCustomId('compat-defer').setLabel('Defer').setStyle(ButtonStyle.Secondary),
    );
    await withTimeout(
      'interaction.update (type 7)',
      approveI.update({ content: 'compat: run approved', components: [halfResolvedRow] }),
    );

    let row = await historyRow(channelA, card.id);
    assert(
      'components',
      row?.content === 'compat: run approved',
      `post-update content: ${JSON.stringify(row?.content)}`,
    );
    assert(
      'components',
      jsonEqual(row?.components, wireJson([halfResolvedRow])),
      `post-update components: ${JSON.stringify(row?.components)}`,
    );

    // -- (a-2) the defer continuation riding sub-case (a): deferUpdate()
    //    (type 6) then editReply() — the webhook-shaped @original PATCH.
    res = await click(card.id, 'compat-defer', 2);
    assert('components', res.status === 202, `defer click: HTTP ${res.status} ${JSON.stringify(res.json)}`);

    const deferI = await nextComponent('compat-defer');
    await withTimeout('interaction.deferUpdate (type 6)', deferI.deferUpdate());

    // The defer edited NOTHING — the interim row is still intact.
    row = await historyRow(channelA, card.id);
    assert(
      'components',
      row?.content === 'compat: run approved',
      `defer mutated content early: ${JSON.stringify(row?.content)}`,
    );

    const resolvedRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('compat-approve').setLabel('Approved').setStyle(ButtonStyle.Success).setDisabled(true),
      new ButtonBuilder().setCustomId('compat-defer').setLabel('Resolved').setStyle(ButtonStyle.Secondary).setDisabled(true),
    );
    await withTimeout(
      'interaction.editReply (@original PATCH)',
      deferI.editReply({ content: 'compat: run approved (final)', components: [resolvedRow] }),
    );

    row = await historyRow(channelA, card.id);
    assert(
      'components',
      row?.content === 'compat: run approved (final)',
      `editReply content: ${JSON.stringify(row?.content)}`,
    );
    assert(
      'components',
      jsonEqual(row?.components, wireJson([resolvedRow])),
      `editReply components: ${JSON.stringify(row?.components)}`,
    );

    // -- (b) select: isStringSelectMenu() + values[] survive the library
    //    constructor; resolved via a components-only update (content intact).
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('compat-model')
      .setPlaceholder('pick a model')
      .addOptions(
        new StringSelectMenuOptionBuilder().setLabel('Standard').setValue('standard'),
        new StringSelectMenuOptionBuilder().setLabel('Pro').setValue('pro'),
      );
    const selectCard = await withTimeout(
      'discord.js select send',
      channel.send({
        content: 'compat: pick a model',
        components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)],
      }),
    );

    res = await click(selectCard.id, 'compat-model', 3, ['pro']);
    assert('components', res.status === 202, `select click: HTTP ${res.status} ${JSON.stringify(res.json)}`);

    const selectI = await nextComponent('compat-model');
    assert(
      'components',
      selectI.isStringSelectMenu(),
      'select interaction is not a StringSelectMenuInteraction',
    );
    assert(
      'components',
      Array.isArray(selectI.values) && selectI.values.length === 1 && selectI.values[0] === 'pro',
      `select values: ${JSON.stringify(selectI.values)}`,
    );

    const resolvedSelectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('compat-model')
        .setPlaceholder('model: pro')
        .setDisabled(true)
        .addOptions(new StringSelectMenuOptionBuilder().setLabel('Pro').setValue('pro')),
    );
    await withTimeout(
      'interaction.update (components-only)',
      selectI.update({ components: [resolvedSelectRow] }),
    );

    row = await historyRow(channelA, selectCard.id);
    assert(
      'components',
      row?.content === 'compat: pick a model',
      `components-only update touched content: ${JSON.stringify(row?.content)}`,
    );
    assert(
      'components',
      jsonEqual(row?.components, wireJson([resolvedSelectRow])),
      `resolved select components: ${JSON.stringify(row?.components)}`,
    );

    // -- (c) DM click: the user-shaped payload (no member, no guild_id, the
    //    %{"1" => clicker} AIO shape) survives the constructor.
    const dmChannel = await withTimeout('discord.js createDM', client.users.createDM(ownerId));
    const dmCard = await withTimeout(
      'discord.js DM component send',
      dmChannel.send({
        content: 'compat: dm approval',
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId('compat-dm-approve').setLabel('Approve').setStyle(ButtonStyle.Primary),
          ),
        ],
      }),
    );

    const dmClick = await restRaw('POST', '/interactions', ownerToken, {
      channel_id: dmChannel.id,
      message_id: dmCard.id,
      custom_id: 'compat-dm-approve',
      component_type: 2,
    });
    assert(
      'components',
      dmClick.status === 202,
      `DM click: HTTP ${dmClick.status} ${JSON.stringify(dmClick.json)}`,
    );

    const dmI = await nextComponent('compat-dm-approve');
    assert('components', dmI.inGuild() === false, 'DM interaction claims inGuild()');
    assert('components', dmI.member === null, `DM interaction.member: ${String(dmI.member)}`);
    assert(
      'components',
      dmI.user.id === ownerId,
      `DM interaction.user.id: ${String(dmI.user.id)} expected ${ownerId}`,
    );

    // The raw wire pins (KTD3): type 3, user shape, no guild_id/member keys,
    // the user-install AIO key carrying the clicker, entitlements an array.
    const dmRaw = rawInteractions.at(-1) as Record<string, unknown> | undefined;
    const aio = dmRaw?.authorizing_integration_owners as Record<string, string> | undefined;
    assert('components', dmRaw?.type === 3, `DM raw type: ${JSON.stringify(dmRaw?.type)}`);
    assert(
      'components',
      dmRaw !== undefined && !('guild_id' in dmRaw) && !('member' in dmRaw),
      `DM raw carries guild_id/member: ${JSON.stringify(dmRaw ? { guild_id: 'guild_id' in dmRaw, member: 'member' in dmRaw } : null)}`,
    );
    assert(
      'components',
      Boolean(aio) && Object.keys(aio!).length === 1 && aio!['1'] === ownerId,
      `DM raw AIO: ${JSON.stringify(aio)} expected {"1": "${ownerId}"}`,
    );
    assert(
      'components',
      Array.isArray(dmRaw?.entitlements) && (dmRaw?.entitlements as unknown[]).length === 0,
      `DM raw entitlements: ${JSON.stringify(dmRaw?.entitlements)}`,
    );

    await withTimeout('DM interaction.update (content-only)', dmI.update({ content: 'compat: dm approved' }));
    row = await historyRow(dmChannel.id, dmCard.id);
    assert(
      'components',
      row?.content === 'compat: dm approved',
      `DM update content: ${JSON.stringify(row?.content)}`,
    );

    // -- edge oracle: a restricted-agent card in an out-of-profile channel
    //    cannot EXIST (the library send was already gated — prior legs), so
    //    both remaining probes are pinned: the components send itself hits
    //    the compat anti-enumeration gate (404 10003, the identical oracle
    //    the restricted agent's channel fetch surfaced in leg 7), and a
    //    click attempt by the machine principal is the native 403 — never a
    //    mint.
    // Name discipline: mint usernames slugify-truncate the label to 28 chars,
    // so the base must stay short enough for the 13-digit run suffix to
    // survive — the old `compat-components-agent-` prefix collided across
    // runs seconds apart (username_taken flake). This agent is deliberately
    // minted with NO access document: fail-closed = zero bits, which is the
    // out-of-profile shape the two oracle probes below pin.
    const agent2 = await rest<{ id: string; token: string }>('POST', '/bots', ownerToken, {
      name: `cc-agent-${run}`,
    });

    const oracleCard = await withTimeout(
      'discord.js oracle card send',
      channel.send({
        content: 'compat: oracle card',
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId('compat-oracle').setLabel('Go').setStyle(ButtonStyle.Primary),
          ),
        ],
      }),
    );

    const rawBefore = rawInteractions.length;

    const gateRes = await fetch(`${BASE}/api/v10/channels/${channelA}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bot ${agent2.token}` },
      body: JSON.stringify({ content: 'compat: agent card', components: [cardRow.toJSON()] }),
    });
    const gateBody = (await gateRes.json().catch(() => null)) as { code?: number } | null;
    assert(
      'components',
      gateRes.status === 404 && gateBody?.code === 10_003,
      `out-of-profile components send: HTTP ${gateRes.status} ${JSON.stringify(gateBody)} expected 404 10003 (Unknown Channel)`,
    );

    const clickRes = await restRaw('POST', '/interactions', agent2.token, {
      channel_id: channelA,
      message_id: oracleCard.id,
      custom_id: 'compat-oracle',
      component_type: 2,
    });
    const clickErr = (clickRes.json as { error?: { key?: string } } | null)?.error;
    assert(
      'components',
      clickRes.status === 403 && clickErr?.key === 'forbidden',
      `machine click: HTTP ${clickRes.status} ${JSON.stringify(clickRes.json)} expected 403 forbidden`,
    );

    await sleep(NEGATIVE_MS);
    assert(
      'components',
      rawInteractions.length === rawBefore,
      `the 403 click minted an interaction anyway (${rawInteractions.length - rawBefore} new)`,
    );
  },
  'buttons+update(7) · deferUpdate→editReply(@original) · select values · DM user-shape · restricted-agent 403/10003 oracles',
);

// --- components v2 (#30): multi-select + modals, proven BY CONSUMPTION -----------------

await leg(
  'components-v2',
  async () => {
    const channel = client.channels.cache.get(channelA);
    if (!(channel instanceof TextChannel)) {
      throw new Error(`channel ${channelA} is not a TextChannel in the guild cache`);
    }

    const waitFor = async <T,>(label: string, find: () => T | undefined): Promise<T> =>
      withTimeout(
        label,
        (async () => {
          for (let i = 0; i < 150; i++) {
            const hit = find();
            if (hit) return hit;
            await sleep(100);
          }
          throw new Error(
            `${label} never fired. Delta — last raw INTERACTION_CREATE: ${JSON.stringify(
              rawInteractions.at(-1) ?? 'NONE',
            )}; clientErrors: ${JSON.stringify(clientErrors)}`,
          );
        })(),
        15_000,
      );

    const click = (messageId: string, customId: string, componentType: 2 | 3, values?: string[]) =>
      restRaw('POST', '/interactions', ownerToken, {
        channel_id: channelA,
        message_id: messageId,
        custom_id: customId,
        component_type: componentType,
        ...(values ? { values } : {}),
      });

    // -- (a) multi-select: a discord.js select with min 1 / max 2 stores, a
    //    human multi-pick mints, and interaction.values carries the SET.
    const multi = new StringSelectMenuBuilder()
      .setCustomId('compat-tags')
      .setPlaceholder('pick tags')
      .setMinValues(1)
      .setMaxValues(2)
      .addOptions(
        new StringSelectMenuOptionBuilder().setLabel('Alpha').setValue('a'),
        new StringSelectMenuOptionBuilder().setLabel('Beta').setValue('b'),
        new StringSelectMenuOptionBuilder().setLabel('Gamma').setValue('c'),
      );
    const multiCard = await withTimeout(
      'discord.js multi-select send',
      channel.send({
        content: 'compat: pick up to two',
        components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(multi)],
      }),
    );
    let res = await click(multiCard.id, 'compat-tags', 3, ['a', 'c']);
    assert('components-v2', res.status === 202, `multi-select click: HTTP ${res.status} ${JSON.stringify(res.json)}`);
    const multiI = await waitFor('interactionCreate (compat-tags)', () =>
      componentInteractions.find((x) => x.customId === 'compat-tags'),
    );
    assert('components-v2', multiI.isStringSelectMenu(), 'multi-select interaction is not a StringSelectMenuInteraction');
    assert(
      'components-v2',
      JSON.stringify(multiI.values) === JSON.stringify(['a', 'c']),
      `multi-select values: ${JSON.stringify(multiI.values)}`,
    );
    await withTimeout('multi-select deferUpdate', multiI.deferUpdate());
    // A set, not a list: the same value twice is refused before any mint.
    res = await click(multiCard.id, 'compat-tags', 3, ['a', 'a']);
    assert('components-v2', res.status === 400, `duplicate pick: HTTP ${res.status} expected 400`);

    // -- (b) modal: the bot answers a click with discord.js's showModal(); the
    //    human submits through the native route; the bot consumes a real
    //    ModalSubmitInteraction and answers with update() against the card.
    const modalCard = await withTimeout(
      'discord.js modal card send',
      channel.send({
        content: 'compat: give feedback',
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId('compat-feedback').setLabel('Feedback').setStyle(ButtonStyle.Primary),
          ),
        ],
      }),
    );
    res = await click(modalCard.id, 'compat-feedback', 2);
    assert('components-v2', res.status === 202, `modal click: HTTP ${res.status} ${JSON.stringify(res.json)}`);
    const originId = (res.json as { interaction_id?: string } | null)?.interaction_id;
    assert('components-v2', typeof originId === 'string', `click 202 without interaction_id: ${JSON.stringify(res.json)}`);

    const buttonI = await waitFor('interactionCreate (compat-feedback)', () =>
      componentInteractions.find((x) => x.customId === 'compat-feedback'),
    );
    await withTimeout(
      'interaction.showModal',
      buttonI.showModal(
        new ModalBuilder()
          .setCustomId('compat-feedback-form')
          .setTitle('Feedback')
          .addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder().setCustomId('why').setLabel('Why?').setStyle(TextInputStyle.Short),
            ),
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder()
                .setCustomId('more')
                .setLabel('Anything else')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(false),
            ),
          ),
      ),
    );

    const submit = (components: unknown) =>
      restRaw('POST', '/interactions', ownerToken, {
        kind: 'modal_submit',
        interaction_id: originId,
        custom_id: 'compat-feedback-form',
        components,
      });
    const answer = (id: string, value: string) => ({ type: 1, components: [{ type: 4, custom_id: id, value }] });

    // A required field left empty is refused — and does not burn the form.
    res = await submit([answer('why', ''), answer('more', '')]);
    assert('components-v2', res.status === 400, `empty required field: HTTP ${res.status} expected 400`);

    res = await submit([answer('why', 'because'), answer('more', 'line one\nline two')]);
    assert('components-v2', res.status === 202, `modal submit: HTTP ${res.status} ${JSON.stringify(res.json)}`);

    const modalI = await waitFor('interactionCreate (modal submit)', () =>
      modalSubmits.find((x) => x.customId === 'compat-feedback-form'),
    );
    assert('components-v2', modalI.fields.getTextInputValue('why') === 'because', `why: ${modalI.fields.getTextInputValue('why')}`);
    assert(
      'components-v2',
      modalI.fields.getTextInputValue('more') === 'line one\nline two',
      `more: ${JSON.stringify(modalI.fields.getTextInputValue('more'))}`,
    );
    assert('components-v2', modalI.isFromMessage(), 'modal submit from a click is not isFromMessage()');
    const modalRaw = rawInteractions.at(-1) as Record<string, unknown> | undefined;
    assert('components-v2', modalRaw?.type === 5, `modal raw type: ${JSON.stringify(modalRaw?.type)}`);

    await withTimeout(
      'modal submit update(7)',
      modalI.update({ content: 'compat: feedback received', components: [] }),
    );
    const history = await rest<{ messages: Array<NativeMessage> }>(
      'GET',
      `/channels/${channelA}/messages?limit=20`,
      ownerToken,
    );
    const row = history.messages.find((m) => m.id === modalCard.id);
    assert('components-v2', row?.content === 'compat: feedback received', `card after modal update: ${JSON.stringify(row?.content)}`);

    // A modal submits once.
    res = await submit([answer('why', 'again'), answer('more', '')]);
    const key = (res.json as { error?: { key?: string } } | null)?.error?.key;
    assert('components-v2', res.status === 400 && key === 'modal_unavailable', `second submit: HTTP ${res.status} ${key}`);
  },
  'multi-select values[] (min1/max2, dup refused) · showModal(9) → ModalSubmitInteraction(5) fields + isFromMessage + update(7) · required/single-use gates',
);

// --- teardown + report ----------------------------------------------------------------

try {
  await client.destroy();
} catch {
  /* already destroyed by a fatal close */
}
try {
  await agentClient.destroy();
} catch {
  /* already destroyed by the 4004 */
}
killServer();

const failed = results.filter((r) => r.status === 'FAIL');
console.log('\ncompat-check summary:');
console.log(JSON.stringify(results, null, 2));
if (failed.length > 0) {
  console.error(`\nCOMPAT CHECK FAIL — ${failed.length}/${results.length} legs failed (${run})`);
  process.exit(1);
}
console.log(`\nCOMPAT CHECK PASS — ${results.length} legs green (${run})`);
process.exit(0);
