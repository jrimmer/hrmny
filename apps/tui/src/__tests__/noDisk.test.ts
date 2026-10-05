/**
 * @cytale/tui — R27: the client keeps no Cytale token on disk in SSH mode.
 *
 * Proven two ways, neither of them by reading the code:
 *
 *   1. **A filesystem assertion.** A full SSH-mode session runs against a real
 *      local server — authenticate, one authenticated request, a descriptor
 *      renewal, a second request — with `HOME` and the temp variables pointed
 *      at two fresh trees this test owns. Afterwards both trees are scanned
 *      for the tokens that were in play and for anything JWT-shaped, and the
 *      home tree is compared byte for byte with its pre-session snapshot.
 *   2. **A write-call assertion.** The SSH-mode storage adapter's `write` is
 *      asserted never to have been called during the live session, and — the
 *      property that must survive a refactor — a DIRECT `write()` carrying a
 *      real token pair still lands nothing on disk, because the adapter has no
 *      sink. R27 therefore does not depend on every future caller behaving.
 *
 * Two guards keep the proofs from being vacuous, because "the scan found
 * nothing" is also what a broken scan reports: the token is asserted to have
 * been USED (the server saw it on a real request), and a control test plants a
 * token in the scanned tree and asserts the scan catches it.
 */
import { createServer, type Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { GatewayClient, GatewayClientOptions } from '@cytale/gateway-client';

import { createClientSession, type ClientConfig, type ClientSession } from '../client.js';
import { createWriteNullStorage, type WriteNullStorage } from '../session/tokenSource.js';
import type { TokenDescriptor } from '../session/tokenPipe.js';

const TOKEN_A = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlLWE';
const TOKEN_B = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlLWI';

/** The shape of anything the product mints (three base64url segments). */
const JWT_SHAPE = /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/;

// ---------------------------------------------------------------------------
// A scripted descriptor (the host's half of KTD8)
// ---------------------------------------------------------------------------

function createScriptedDescriptor(): TokenDescriptor & { write(bytes: string): void } {
  const queued: string[] = [];
  const waiters: Array<(value: string | null) => void> = [];
  let ended = false;
  return {
    write(bytes: string) {
      if (ended) return;
      const resolve = waiters.shift();
      if (resolve === undefined) queued.push(bytes);
      else resolve(bytes);
    },
    read() {
      const buffered = queued.shift();
      if (buffered !== undefined) return Promise.resolve(buffered);
      if (ended) return Promise.resolve(null);
      return new Promise<string | null>((resolve) => {
        waiters.push(resolve);
      });
    },
    close() {
      ended = true;
      for (const resolve of waiters.splice(0)) resolve(null);
    },
  };
}

const stubGateway = (): ((options: GatewayClientOptions) => GatewayClient) => {
  return () =>
    ({
      connect: async () => undefined,
      disconnect: () => undefined,
      destroy: () => undefined,
      onAny: () => () => undefined,
    }) as unknown as GatewayClient;
};

// ---------------------------------------------------------------------------
// Tree snapshots and the token scan
// ---------------------------------------------------------------------------

/** Every file under `root`, as relative path → base64 content. */
function snapshot(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.set(relative, fs.readFileSync(full).toString('base64'));
      else files.set(relative, '<not-a-file>');
    }
  };
  walk(root);
  return files;
}

interface TokenHit {
  readonly file: string;
  readonly needle: string;
}

/** Every file under `root` whose bytes contain one of `needles` or a JWT. */
function findTokens(root: string, needles: readonly string[]): TokenHit[] {
  const hits: TokenHit[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const content = fs.readFileSync(full).toString('utf8');
      for (const needle of needles) {
        if (content.includes(needle)) hits.push({ file: full, needle });
      }
      if (JWT_SHAPE.test(content)) hits.push({ file: full, needle: 'jwt-shaped value' });
    }
  };
  walk(root);
  return hits;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface StubServer {
  readonly origin: string;
  readonly requests: Array<{ url: string; authorization: string | null }>;
  close(): Promise<void>;
}

const servers: Server[] = [];
const roots: string[] = [];

beforeEach(() => {
  roots.push(fs.mkdtempSync(path.join(os.tmpdir(), 'cytale-tui-r27-')));
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function startStubServer(): Promise<StubServer> {
  const requests: StubServer['requests'] = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url ?? '', authorization: req.headers.authorization ?? null });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        user: { id: '123', username: 'tester', email: 'tester@example.com', email_verified_at: null },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address() as AddressInfo | null;
  if (address === null) throw new Error('the stub server did not bind');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** The member's environment, pointed at two trees this test owns. */
interface MemberTree {
  readonly root: string;
  readonly home: string;
  readonly tmp: string;
  restore(): void;
}

function memberTree(root: string): MemberTree {
  const home = path.join(root, 'home');
  const tmp = path.join(root, 'tmp');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });

  const saved = { ...process.env };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.XDG_DATA_HOME = path.join(home, '.local', 'share');
  process.env.XDG_STATE_HOME = path.join(home, '.local', 'state');
  process.env.XDG_CACHE_HOME = path.join(home, '.cache');
  process.env.TMPDIR = tmp;
  process.env.TMP = tmp;
  process.env.TEMP = tmp;

  return {
    root,
    home,
    tmp,
    restore() {
      // Every variable set above is restored — TMP was missing, so the next
      // jail nested its temp dir inside the previous (deleted) one: ENOENT.
      for (const key of ['HOME', 'USERPROFILE', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'TMPDIR', 'TMP', 'TEMP']) {
        const value = saved[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

const sshConfig = (origin: string): ClientConfig => ({
  mode: 'ssh',
  origin,
  descriptorFd: 3,
  ignoredArgument: null,
});

/** Run one full SSH-mode session: authenticate, request, renew, request. */
async function runSshSession(
  origin: string,
  descriptor: ReturnType<typeof createScriptedDescriptor>,
): Promise<ClientSession> {
  const session = createClientSession(sshConfig(origin), {
    descriptor,
    createGatewayClient: stubGateway(),
  });

  const started = session.start();
  await started;

  await session.manager.api.getCurrentUser();
  descriptor.write(`{"access_token":"${TOKEN_B}","expires_in":900}\n`);
  await waitEventually(() => session.tokenSource?.current().accessToken === TOKEN_B);
  await session.manager.api.getCurrentUser();

  return session;
}

async function waitEventually(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  throw new Error('timed out waiting for the client');
}

// ---------------------------------------------------------------------------
// The control: the scan can find a token
// ---------------------------------------------------------------------------

describe('the token scan itself', () => {
  it('finds a token planted in the tree it is pointed at', () => {
    const root = currentRoot();
    const planted = path.join(root, 'home', '.cache', 'cytale', 'token');
    fs.mkdirSync(path.dirname(planted), { recursive: true });
    fs.writeFileSync(planted, `refresh=${TOKEN_A}\n`);

    const hits = findTokens(root, [TOKEN_A, TOKEN_B]);
    expect(hits.map((hit) => hit.file)).toContain(planted);
  });
});

// ---------------------------------------------------------------------------
// R27
// ---------------------------------------------------------------------------

describe('R27 — no Cytale token on disk in SSH mode', () => {
  it('writes no token to the member’s home or temp tree, and never calls write, in a live session', async () => {
    const tree = memberTree(currentRoot());
    try {
      const server = await startStubServer();
      const descriptor = createScriptedDescriptor();
      descriptor.write(`{"access_token":"${TOKEN_A}","expires_in":900}\n`);

      const homeBefore = snapshot(tree.home);
      const tmpBefore = snapshot(tree.tmp);

      const session = await runSshSession(server.origin, descriptor);

      // (a) The token really was used — this is what makes the scan meaningful.
      expect(server.requests.length).toBeGreaterThanOrEqual(2);
      expect(server.requests[0]?.authorization).toBe(`Bearer ${TOKEN_A}`);
      expect(server.requests[server.requests.length - 1]?.authorization).toBe(`Bearer ${TOKEN_B}`);

      // (b) The write-call assertion, taken while the session is live.
      const storage = session.writeNullStorage;
      if (storage === null) throw new Error('SSH mode must use the write-null adapter');
      expect(storage.writeCalls).toBe(0);
      expect(storage.tokenWrites).toBe(0);
      // And no mirror either: the adapter's synchronous `read` (the refresh
      // contract's) holds nothing, so nothing can hand a token back out of it.
      expect(storage.read()).toBeNull();

      // (c) The filesystem assertion, over both writable trees.
      expect(findTokens(tree.home, [TOKEN_A, TOKEN_B])).toEqual([]);
      expect(findTokens(tree.tmp, [TOKEN_A, TOKEN_B])).toEqual([]);

      // The home tree is not merely token-free: nothing touched it at all.
      expect(snapshot(tree.home)).toEqual(homeBefore);
      expect(snapshot(tree.tmp)).toEqual(tmpBefore);

      // A teardown clears local state; that clear must still carry no token.
      session.stop();
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
      expect(storage.tokenWrites).toBe(0);
      expect(findTokens(tree.home, [TOKEN_A, TOKEN_B])).toEqual([]);
      expect(findTokens(tree.tmp, [TOKEN_A, TOKEN_B])).toEqual([]);
      await server.close();
    } finally {
      tree.restore();
    }
  });

  it('holds for a refactor: a write carrying a real token pair still lands nothing', async () => {
    const tree = memberTree(currentRoot());
    try {
      const storage = createWriteNullStorage();
      // The shape a future caller would take (the persisting setter), called
      // directly — which is the case "no caller happens to call write" does
      // not cover.
      storage.write({ accessToken: TOKEN_A, refreshToken: TOKEN_B });
      await storage.flush?.();

      expect(storage.writeCalls).toBe(1);
      expect(storage.tokenWrites).toBe(1);
      // Nothing to read back either: there is no mirror of the live token.
      expect(storage.read()).toBeNull();

      expect(findTokens(tree.home, [TOKEN_A, TOKEN_B])).toEqual([]);
      expect(findTokens(tree.tmp, [TOKEN_A, TOKEN_B])).toEqual([]);
      expect(snapshot(tree.home).size).toBe(0);
    } finally {
      tree.restore();
    }
  });
});

/** The temp root this test created (never `''`, which would scan everything). */
function currentRoot(): string {
  const root = roots[roots.length - 1];
  if (root === undefined) throw new Error('no member tree was created for this test');
  return root;
}
