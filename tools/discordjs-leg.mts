/**
 * Bots plan U7 — the minimal pinned-library leg (B3 review fix): drive a
 * REAL Discord client library (discord.js, pinned in the workspace root
 * devDependencies) against a locally booted Cytale server.
 *
 * Flow (the unit's integration gate): boot server → verified owner +
 * workspace + channel + minted agent → discord.js connects (REST base
 * overridden to the local /api/v10, gateway URL taken from our
 * /gateway/bot) → READY → GUILD_CREATE (guild cache resolves) → a
 * MESSAGE_CREATE posted via NATIVE REST arrives on a guild-scoped handler
 * → the library SENDS a message through the compat REST → assert it landed
 * via a native REST read.
 *
 * Usage: pnpm discordjs:leg   (spawns its own server on an isolated port;
 * requires local Scylla on 9042, like the soak)
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  TextChannel,
} from 'discord.js';

const PORT = Number(process.env.LEG_PORT ?? 4120);
const BASE = `http://127.0.0.1:${PORT}`;
const API = `${BASE}/api/v1`;
const COMPAT_API = `${BASE}/api/v10`;
const MAILBOX = 'apps/server/tmp/dev_mailbox.jsonl';
const TIMEOUT_MS = 20_000;

function fail(step: string, err: unknown): never {
  console.error(`LEG FAIL at "${step}":`, err instanceof Error ? err.message : err);
  // @discordjs errors chain their causes — print the whole chain.
  let cause = (err as { cause?: unknown } | undefined)?.cause;
  let depth = 0;
  while (cause && depth < 6) {
    console.error(`  cause[${depth}]:`, cause instanceof Error ? `${cause.name}: ${cause.message}` : cause);
    cause = (cause as { cause?: unknown }).cause;
    depth++;
  }
  killServer();
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

// -- server lifecycle (soak pattern) ----------------------------------------

let server: ChildProcess | null = null;

function startServer(): Promise<void> {
  server = spawn('mix', ['phx.server'], {
    cwd: 'apps/server',
    env: {
      ...process.env,
      MIX_ENV: 'dev',
      PORT: String(PORT),
      SECRET_KEY_BASE: 'leg-secret-key-base-32-chars-minimum!',
      AUTH_JWT_SECRET: 'leg-jwt-secret-key-base-32-chars-minim!',
      AUTH_REFRESH_PEPPER: 'leg-refresh-pepper-32-chars-minimum!!!',
      CYTALE_SCYLLA_NODES: '127.0.0.1:9042',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout!.on('data', (d) => process.env.LEG_VERBOSE && process.stderr.write(d));
  server.stderr!.on('data', (d) => process.env.LEG_VERBOSE && process.stderr.write(d));

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
  fail('unhandled rejection', reason);
});

// -- native REST fixtures ------------------------------------------------------

async function rest<T>(step: string, method: string, path: string, token: string, body?: unknown): Promise<T> {
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
  void step;
  return json;
}

async function registerAndLogin(label: string): Promise<string> {
  const registered = await rest<{ access_token: string }>('register', 'POST', '/auth/register', '', {
    username: label,
    email: `${label}@leg.local`,
    password: 'leg-password-1',
  });
  const mail = readFileSync(MAILBOX, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .filter((m) => m.to === `${label}@leg.local` && m.kind === 'verify_email')
    .at(-1);
  if (!mail) throw new Error(`no verify mail for ${label}`);
  await rest('verify', 'POST', '/auth/verify-email', registered.access_token, { token: mail.token });
  const re = await rest<{ access_token: string }>('login', 'POST', '/auth/login', '', {
    identifier: label,
    password: 'leg-password-1',
  });
  return re.access_token;
}

// -- the leg -------------------------------------------------------------------

const run = `leg_${Date.now()}`;
console.log('discordjs-leg: spawning server');
await startServer();
console.log('ok  server up');

const ownerToken = await registerAndLogin(`own_${run}`);
// Native REST shapes: workspace create answers {id}; channel create
// answers {channel}.
const ws = await rest<{ id: string }>('ws', 'POST', '/workspaces', ownerToken, {
  name: `leg-ws-${run}`,
});
const wsId = ws.id;
const ch = await rest<{ channel: { id: string } }>('channel', 'POST', `/workspaces/${wsId}/channels`, ownerToken, {
  name: 'general',
});
const channelId = ch.channel.id;
const minted = await rest<{ id: string; token: string }>('agent', 'POST', '/agents', ownerToken, {
  name: `leg-agent-${run}`,
});
console.log('ok  fixtures ready (owner, workspace, channel, agent)');

// discord.js: REST base overridden to the local compat prefix; the gateway
// URL comes from our /gateway/bot (which discord.js fetches through that
// same REST base on login).
// discord.js appends its own /v10 version segment to the REST base — the
// bare unversioned compat alias (/api) exists for exactly this (KTD7).
const client = new Client({
  intents:
    GatewayIntentBits.Guilds | GatewayIntentBits.GuildMessages | GatewayIntentBits.GuildMessageTyping,
  rest: { api: `${BASE}/api` } as never,
});

const created = new Promise<Message>((resolve, reject) => {
  const timer = setTimeout(
    () => reject(new Error('messageCreate never fired for the native-posted message')),
    TIMEOUT_MS,
  );
  client.on(Events.MessageCreate, (msg) => {
    if (msg.channelId === channelId && msg.content === 'leg: native hello') {
      clearTimeout(timer);
      resolve(msg);
    }
  });
});

// Keep the created-promise's eventual timeout rejection "handled" until its
// await site (unhandled rejections kill Node before diagnostics print).
created.catch(() => undefined);

const ready = withTimeout(
  'discord.js READY',
  new Promise<void>((resolve) => {
    client.once(Events.ClientReady, (c) => {
      console.log(`ok  discord.js READY as ${c.user.tag} (bot=${c.user.bot})`);
      resolve();
    });
  }),
);

await withTimeout('discord.js login', client.login(minted.token));
await ready;

// Guild cache: built from GUILD_CREATE — the library must resolve the
// workspace as a guild without any REST guild fetch.
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
console.log('ok  guild cache resolved from GUILD_CREATE');

// A guild-scoped handler: the received message must resolve .guild.
const nativeMsg = await rest<{ message: { id: string } }>(
  'native post',
  'POST',
  `/channels/${channelId}/messages`,
  ownerToken,
  { content: 'leg: native hello' },
);
const received = await created;
if (!received.guild || received.guild.id !== wsId) {
  fail('guild-scoped handler', `message.guild unresolved: ${String(received.guild?.id)}`);
}
if (received.author?.bot !== false) {
  fail('author shape', `expected the human author to carry bot=false, got ${String(received.author?.bot)}`);
}
console.log('ok  MESSAGE_CREATE received through a guild-scoped handler');

// The library SENDS one message (compat REST POST → 201 Discord object).
const channel = client.channels.cache.get(channelId);
if (!(channel instanceof TextChannel)) {
  fail('channel resolve', `channel ${channelId} is not a TextChannel in the guild cache`);
}
const sent = await withTimeout('discord.js send', channel.send('leg: library hello'));
console.log(`ok  library message sent (id=${sent.id})`);

// Assert it landed via a NATIVE REST read (KD2 merge parity).
const history = await rest<{ messages: Array<{ id: string; content: string }> }>(
  'native history',
  'GET',
  `/channels/${channelId}/messages?limit=10`,
  ownerToken,
);
const landed = history.messages.find((m) => m.id === sent.id && m.content === 'leg: library hello');
if (!landed) {
  fail('library message landed', `message ${sent.id} missing from native history`);
}
console.log('ok  library-authored message visible via native REST');

await client.destroy();
killServer();
console.log(`DISCORDJS LEG PASS (${run})`);
process.exit(0);
