/**
 * @cytale/tui — local-mode login (U9, R14): the credential file, the masked
 * prompt, and the interaction that turns a password into a live session.
 *
 * Everything here runs against a REAL server on loopback with the real
 * `@cytale/session` manager and the real `@cytale/api-client` — the login
 * request, the refresh exchange, and the first authenticated read are all
 * sockets that really accepted bytes. What is a seam: the prompt (a scripted
 * sequence of answers, so no case depends on a human), the terminal streams
 * (a fake TTY the test types into), and the gateway (a stub that reports
 * lifecycle transitions instead of dialling).
 *
 * Two properties are asserted directly rather than inferred from behaviour:
 * the credential file's MODE (owner-only, 0o600) and the fact that SSH mode
 * cannot reach any of this (`SshModeLoginError`, no file created) — the second
 * is the half of R27 that this unit could otherwise break.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@cytale/api-client';
import type { GatewayClient, GatewayClientOptions } from '@cytale/gateway-client';
import { createSessionManager, type SessionManager, type TokenStorage } from '@cytale/session';

import type { ClientConfig } from '../client.js';
import {
  CREDENTIAL_DIR_MODE,
  CREDENTIAL_FILE_MODE,
  createCredentialFile,
  credentialFilePath,
  type CredentialFile,
} from '../session/credentialFile.js';
import {
  IDENTIFIER_PROMPT,
  MAX_LOGIN_ATTEMPTS,
  PASSWORD_PROMPT,
  SshModeLoginError,
  createLocalLoginStorage,
  createLoginPrompt,
  describeLoginFailure,
  runLocalLogin,
  type LineInput,
  type LoginPrompt,
} from '../session/login.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The identifier the web login accepts: a username OR an email. */
const GOOD_IDENTIFIER = 'tester';
const GOOD_PASSWORD = 'correct horse battery staple';
const BAD_PASSWORD = 'hunter2';

const LOGIN_ACCESS = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.bG9naW4tYWNjZXNz';
const LOGIN_REFRESH = 'cyt_refresh_login';
const ROTATED_ACCESS = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.cm90YXRlZC0x';
const ROTATED_REFRESH = 'cyt_refresh_rotated_1';

const USER = {
  id: '123',
  username: 'tester',
  email: 'tester@example.com',
  email_verified_at: null,
};

const localConfig = (origin: string): ClientConfig => ({
  mode: 'local',
  origin,
  descriptorFd: null,
  ignoredArgument: null,
});

const sshConfig = (origin: string): ClientConfig => ({
  mode: 'ssh',
  origin,
  descriptorFd: 3,
  ignoredArgument: null,
});

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
// A real server: login, refresh, /users/@me, logout
// ---------------------------------------------------------------------------

interface StubRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
  readonly body: unknown;
}

interface StubServer {
  readonly origin: string;
  readonly requests: StubRequest[];
  /** Access tokens the server will accept (it mints them, so it knows them). */
  readonly accessTokens: Set<string>;
  /** 401 makes every authenticated read look like a dead credential. */
  setLive(status: 200 | 401): void;
  /** Make the refresh exchange fail, as a revoked/rotated-away token does. */
  setRefreshLive(live: boolean): void;
  requestsTo(url: string): StubRequest[];
  close(): Promise<void>;
}

function bearerOf(header: string | null | undefined): string | null {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length);
}

const servers: Server[] = [];
const roots: string[] = [];

beforeEach(() => {
  roots.push(fs.mkdtempSync(path.join(os.tmpdir(), 'cytale-tui-u9-')));
});

afterEach(async () => {
  vi.unstubAllGlobals();
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
  const requests: StubRequest[] = [];
  const accessTokens = new Set<string>([LOGIN_ACCESS]);
  let password = GOOD_PASSWORD;
  let live: 200 | 401 = 200;
  let refreshLive = true;
  let currentRefresh = LOGIN_REFRESH;
  let rotations = 0;

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = null;
      try {
        body = raw === '' ? null : JSON.parse(raw);
      } catch {
        body = raw;
      }
      const url = req.url ?? '';
      requests.push({
        method: req.method ?? '',
        url,
        authorization: req.headers.authorization ?? null,
        body,
      });

      const json = (status: number, payload: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const bearer = bearerOf(req.headers.authorization);

      if (url === '/api/v1/auth/login' && req.method === 'POST') {
        const body_ = body as { identifier?: unknown; password?: unknown } | null;
        if (body_?.identifier === GOOD_IDENTIFIER && body_?.password === password) {
          json(200, { access_token: LOGIN_ACCESS, refresh_token: LOGIN_REFRESH, expires_in: 900 });
        } else {
          json(401, {
            error: { key: 'INVALID_CREDENTIALS', code: 40101, message: 'Wrong username/email or password.' },
          });
        }
        return;
      }

      if (url === '/api/v1/auth/refresh' && req.method === 'POST') {
        const body_ = body as { refresh_token?: unknown } | null;
        if (refreshLive && bearer !== null && accessTokens.has(bearer) && body_?.refresh_token === currentRefresh) {
          rotations += 1;
          const access = rotations === 1 ? ROTATED_ACCESS : `${ROTATED_ACCESS}${rotations}`;
          const refresh = rotations === 1 ? ROTATED_REFRESH : `${ROTATED_REFRESH}_${rotations}`;
          accessTokens.add(access);
          currentRefresh = refresh;
          json(200, { access_token: access, refresh_token: refresh, expires_in: 900 });
        } else {
          json(401, {
            error: { key: 'INVALID_CREDENTIALS', code: 40101, message: 'Missing or unusable tokens for refresh.' },
          });
        }
        return;
      }

      if (url === '/api/v1/users/@me' && req.method === 'GET') {
        if (live === 200 && bearer !== null && accessTokens.has(bearer)) json(200, { user: USER });
        else {
          json(401, {
            error: { key: 'unauthorized', code: 40101, message: 'The access token is not valid' },
          });
        }
        return;
      }

      if (url === '/api/v1/auth/logout') {
        res.writeHead(204);
        res.end();
        return;
      }

      json(404, { error: { key: 'not_found', code: 40401, message: 'no route' } });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address() as AddressInfo | null;
  if (address === null) throw new Error('the stub server did not bind');

  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    accessTokens,
    setLive(status) {
      live = status;
    },
    setRefreshLive(next) {
      refreshLive = next;
    },
    requestsTo(url) {
      return requests.filter((request) => request.url === url);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** The session manager the client builds for local mode. */
function managerFor(origin: string, storage: TokenStorage): SessionManager {
  return createSessionManager({
    storage,
    resolveOrigin: () => origin,
    createGatewayClient: stubGateway(),
  });
}

// ---------------------------------------------------------------------------
// The terminal: a fake TTY the test types into, and a writer it reads back
// ---------------------------------------------------------------------------

interface FakeInput extends LineInput {
  type(chunk: string): void;
  end(): void;
}

function fakeInput(options: { tty?: boolean } = {}): FakeInput {
  const emitter = new EventEmitter();
  const tty = options.tty ?? true;
  return {
    isTTY: tty,
    isRaw: false,
    setEncoding: () => undefined,
    setRawMode(mode: boolean) {
      if (!tty) throw new Error('setRawMode on a non-TTY');
      this.isRaw = mode;
      return undefined;
    },
    on: (event: string, listener: (...args: never[]) => void) => {
      emitter.on(event, listener as (...args: unknown[]) => void);
      return undefined;
    },
    off: (event: string, listener: (...args: never[]) => void) => {
      emitter.off(event, listener as (...args: unknown[]) => void);
      return undefined;
    },
    resume: () => undefined,
    type(chunk: string) {
      emitter.emit('data', chunk);
    },
    end() {
      emitter.emit('end');
    },
  };
}

interface Captured {
  readonly writer: { write(chunk: string): unknown };
  text(): string;
}

function capture(): Captured {
  let buffer = '';
  return {
    writer: {
      write(chunk: string) {
        buffer += chunk;
        return true;
      },
    },
    text: () => buffer,
  };
}

/** A prompt that answers from a script and records what it was asked. */
interface ScriptedPrompt extends LoginPrompt {
  readonly asked: string[];
}

function scriptedPrompt(answers: Array<string | null>): ScriptedPrompt {
  const queue = [...answers];
  const asked: string[] = [];
  const next = (kind: string, label: string): string | null => {
    asked.push(kind);
    const value = queue.shift();
    if (value === undefined) throw new Error(`the client asked for a ${label} the script did not provide`);
    return value;
  };
  return {
    asked,
    askIdentifier: async (defaultValue?: string) => next('identifier', `identifier (default ${defaultValue ?? 'none'})`),
    askPassword: async () => next('password', 'password'),
  };
}

/** A prompt that fails the test if it is reached at all. */
function noPrompt(): LoginPrompt {
  return {
    askIdentifier: async () => {
      throw new Error('the client prompted when it should have reused the stored session');
    },
    askPassword: async () => {
      throw new Error('the client prompted when it should have reused the stored session');
    },
  };
}

function currentRoot(): string {
  const root = roots[roots.length - 1];
  if (root === undefined) throw new Error('no test root');
  return root;
}

/** A path inside the test's own tree (never the developer's real HOME). */
function tempCredentialPath(name = 'credentials.json'): string {
  return path.join(currentRoot(), 'config', 'cytale', name);
}

function modeOf(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

// ---------------------------------------------------------------------------
// Where the file lives
// ---------------------------------------------------------------------------

describe('the credential file location', () => {
  it('follows XDG_CONFIG_HOME, else the home directory’s .config', () => {
    expect(credentialFilePath({ HOME: '/home/member' })).toBe(
      '/home/member/.config/cytale/credentials.json',
    );
    expect(credentialFilePath({ HOME: '/home/member', XDG_CONFIG_HOME: '/xdg/config' })).toBe(
      '/xdg/config/cytale/credentials.json',
    );
    // A relative XDG_CONFIG_HOME is not a directory the spec allows: it is
    // ignored rather than resolved against the process's own cwd.
    expect(credentialFilePath({ HOME: '/home/member', XDG_CONFIG_HOME: 'relative/config' })).toBe(
      '/home/member/.config/cytale/credentials.json',
    );
    // Windows shells set USERPROFILE and no HOME.
    expect(credentialFilePath({ USERPROFILE: 'C:\\Users\\member' })).toBe(
      path.join('C:\\Users\\member', '.config', 'cytale', 'credentials.json'),
    );
  });
});

// ---------------------------------------------------------------------------
// The credential file: the storage contract, the mode, and every bad file
// ---------------------------------------------------------------------------

describe('the credential file', () => {
  const file = (options: { origin?: string } = {}): CredentialFile =>
    createCredentialFile({
      mode: 'local',
      path: tempCredentialPath(),
      origin: options.origin ?? 'https://chat.example.com',
    });

  it('persists a pair owner-only, and reads it back through the storage contract', async () => {
    const credential = file();
    await credential.hydrate();
    expect(credential.read()).toBeNull();
    expect(credential.diagnostics().found).toBe(false);

    credential.write({ accessToken: LOGIN_ACCESS, refreshToken: LOGIN_REFRESH });
    await credential.flush();

    expect(fs.existsSync(credential.path)).toBe(true);
    expect(modeOf(credential.path)).toBe(CREDENTIAL_FILE_MODE);
    expect(fs.statSync(path.dirname(credential.path)).mode & 0o777).toBe(CREDENTIAL_DIR_MODE);
    expect(JSON.parse(fs.readFileSync(credential.path, 'utf8'))).toEqual({
      origin: 'https://chat.example.com',
      accessToken: LOGIN_ACCESS,
      refreshToken: LOGIN_REFRESH,
    });

    // A second adapter over the same path reads what the first wrote — the
    // "next run" of the contract, without a session in the way.
    const later = file();
    await later.hydrate();
    expect(later.read()).toEqual({ accessToken: LOGIN_ACCESS, refreshToken: LOGIN_REFRESH });
    expect(later.diagnostics().found).toBe(true);
  });

  it('treats an empty token as absent, and clears the file on a null write', async () => {
    const credential = file();
    credential.write({ accessToken: '', refreshToken: LOGIN_REFRESH });
    await credential.flush();
    expect(JSON.parse(fs.readFileSync(credential.path, 'utf8')).accessToken).toBeNull();

    credential.write(null);
    await credential.flush();
    expect(fs.existsSync(credential.path)).toBe(false);
    expect(credential.read()).toBeNull();
  });

  it('keeps owner-only mode when it rewrites an existing file', async () => {
    const credential = file();
    credential.write({ accessToken: LOGIN_ACCESS, refreshToken: LOGIN_REFRESH });
    // A file that arrived world-readable (a copied backup, a bad umask) must
    // not stay that way after the adapter writes it.
    fs.chmodSync(credential.path, 0o644);

    credential.write({ accessToken: ROTATED_ACCESS, refreshToken: ROTATED_REFRESH });
    await credential.flush();

    expect(modeOf(credential.path)).toBe(CREDENTIAL_FILE_MODE);
  });

  it('discards a corrupt file with a reason instead of crashing', async () => {
    const credential = file();
    fs.mkdirSync(path.dirname(credential.path), { recursive: true });
    fs.writeFileSync(credential.path, '{"accessToken": "trunc');

    await expect(credential.hydrate()).resolves.toBeUndefined();

    const diagnostics = credential.diagnostics();
    expect(diagnostics.discarded?.reason).toBe('unparsable');
    expect(diagnostics.discarded?.detail).not.toBe('');
    expect(diagnostics.discarded?.removed).toBe(true);
    expect(diagnostics.found).toBe(false);
    // Discarded means gone: the next sign-in is not fought by a corpse.
    expect(fs.existsSync(credential.path)).toBe(false);
    expect(credential.read()).toBeNull();
  });

  it('discards a file whose shape is not this file, and names why', async () => {
    for (const content of ['[]', '"token"', '{"refreshToken": 123}', '{"accessToken": null}']) {
      const credential = file();
      fs.mkdirSync(path.dirname(credential.path), { recursive: true });
      fs.writeFileSync(credential.path, content);

      await credential.hydrate();

      expect(credential.diagnostics().discarded?.reason, content).toBe('malformed');
      expect(fs.existsSync(credential.path), content).toBe(false);
    }
  });

  it('discards an unreadable file with a reason, and still signs in afterwards', async () => {
    // Root reads anything, so an EACCES test is meaningless there.
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;

    const credential = file();
    credential.write({ accessToken: LOGIN_ACCESS, refreshToken: LOGIN_REFRESH });
    await credential.flush();
    fs.chmodSync(credential.path, 0o000);

    await credential.hydrate();

    const diagnostics = credential.diagnostics();
    expect(diagnostics.discarded?.reason).toBe('unreadable');
    expect(diagnostics.discarded?.detail).toContain('EACCES');
    expect(credential.read()).toBeNull();

    // The adapter is still usable: a login can replace what it could not read.
    credential.write({ accessToken: ROTATED_ACCESS, refreshToken: ROTATED_REFRESH });
    await credential.flush();
    expect(modeOf(credential.path)).toBe(CREDENTIAL_FILE_MODE);
    expect(JSON.parse(fs.readFileSync(credential.path, 'utf8')).refreshToken).toBe(ROTATED_REFRESH);
  });

  it('leaves a credential that belongs to another server alone, and does not adopt it', async () => {
    const other = createCredentialFile({
      mode: 'local',
      path: tempCredentialPath(),
      origin: 'https://other.example.com',
    });
    other.write({ accessToken: LOGIN_ACCESS, refreshToken: LOGIN_REFRESH });
    await other.flush();
    const before = fs.readFileSync(other.path, 'utf8');

    const mine = file({ origin: 'https://chat.example.com' });
    await mine.hydrate();

    expect(mine.read()).toBeNull();
    expect(mine.diagnostics().otherOrigin).toBe('https://other.example.com');
    expect(mine.diagnostics().discarded).toBeNull();
    // Not ours is not corrupt: the other server's session survives this run.
    expect(fs.readFileSync(mine.path, 'utf8')).toBe(before);
  });

  it('an empty file is nothing stored, not a corrupt file', async () => {
    const credential = file();
    fs.mkdirSync(path.dirname(credential.path), { recursive: true });
    fs.writeFileSync(credential.path, '');
    await credential.hydrate();
    expect(credential.diagnostics().discarded).toBeNull();
    expect(credential.diagnostics().found).toBe(false);
    expect(credential.read()).toBeNull();
  });

  it('reports an unwritable home directory up front, and tolerates the failed write', async () => {
    // The lever: HOME points at a FILE, so the credential directory cannot be
    // created under it on any uid (ENOTDIR) — no permission-dependent fixture.
    const blocked = path.join(currentRoot(), 'not-a-directory');
    fs.writeFileSync(blocked, 'this is a file, not a home\n');

    const credential = createCredentialFile({
      mode: 'local',
      env: { HOME: blocked },
      origin: 'https://chat.example.com',
    });
    const diagnostics = credential.diagnostics();
    expect(diagnostics.writable).toBe(false);
    expect(diagnostics.unwritable?.code).toBe('ENOTDIR');
    expect(diagnostics.path.startsWith(blocked)).toBe(true);

    // The storage contract tolerates a failing backend: the session keeps
    // working on the in-memory mirror, and the failure is reported.
    credential.write({ accessToken: LOGIN_ACCESS, refreshToken: LOGIN_REFRESH });
    await credential.flush();
    expect(credential.read()).toEqual({ accessToken: LOGIN_ACCESS, refreshToken: LOGIN_REFRESH });
    expect(credential.diagnostics().lastWriteError?.code).toBe('ENOTDIR');
    expect(fs.existsSync(credential.path)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The prompt: what is asked, and that the password is never echoed
// ---------------------------------------------------------------------------

describe('the login prompt', () => {
  it('asks for the identifier in the web login’s words, and echoes it', async () => {
    const input = fakeInput();
    const out = capture();
    const prompt = createLoginPrompt({ input, output: out.writer });

    const answered = prompt.askIdentifier();
    input.type('tester\n');
    expect(await answered).toBe('tester');
    expect(out.text()).toContain(IDENTIFIER_PROMPT);
    expect(out.text()).toContain('tester');
  });

  it('masks every character of the password and never echoes it', async () => {
    const input = fakeInput();
    const out = capture();
    const prompt = createLoginPrompt({ input, output: out.writer });

    // Typed as one chunk, then corrected one character at a time: the prompt
    // must mask both shapes, and a backspace must erase a star (not a
    // character of the password).
    const answered = prompt.askPassword();
    input.type('secrets');
    input.type('\x7f');
    input.type('!');
    input.type('\n');

    expect(await answered).toBe('secret!');
    const shown = out.text();
    expect(shown).toContain(PASSWORD_PROMPT);

    // The answer's echo — everything after the prompt — is stars, backspaces,
    // and the newline that ended the line, and nothing else.
    const echo = shown.slice(shown.indexOf(PASSWORD_PROMPT) + PASSWORD_PROMPT.length);
    expect(echo).toMatch(/^[*\b \n]+$/);
    expect(echo).toContain('\b \b'); // the erase erased a star
    // One star per accepted character: seven typed, one erased, one added.
    expect(echo.split('*').length - 1).toBe(8);
    // Masking is the mode it asked for, and it left the terminal as it found it.
    expect(input.isRaw).toBe(false);
  });

  it('swallows a cursor key instead of typing it into the password', async () => {
    const input = fakeInput();
    const out = capture();
    const prompt = createLoginPrompt({ input, output: out.writer });

    const answered = prompt.askPassword();
    input.type('ab');
    input.type('\x1b[D'); // left arrow: ESC [ D
    input.type('c');
    input.type('\x1b[3~'); // forward delete: ESC [ 3 ~
    input.type('d\n');

    // The sequence's bytes are neither the value nor the echo — a password is
    // typed once, not edited with a cursor a masked line cannot show.
    expect(await answered).toBe('abcd');
    const echo = out.text().slice(PASSWORD_PROMPT.length);
    expect(echo).toMatch(/^[*\b \n]+$/);
  });

  it('takes a default identifier on Enter, so a retry does not retype it', async () => {
    const input = fakeInput();
    const out = capture();
    const prompt = createLoginPrompt({ input, output: out.writer });

    const answered = prompt.askIdentifier('tester');
    expect(out.text()).toContain('tester');
    input.type('\n');

    expect(await answered).toBe('tester');
  });

  it('reads a line from a non-TTY stream without touching raw mode', async () => {
    const input = fakeInput({ tty: false });
    const out = capture();
    const prompt = createLoginPrompt({ input, output: out.writer });

    const answered = prompt.askIdentifier();
    input.type('tester\n');
    expect(await answered).toBe('tester');
  });

  it('reports a cancelled prompt rather than hanging, on Ctrl-C and on EOF', async () => {
    for (const cancel of [(input: FakeInput): void => input.type('\x03'), (input: FakeInput): void => input.end()]) {
      const input = fakeInput();
      const out = capture();
      const prompt = createLoginPrompt({ input, output: out.writer });
      const answered = prompt.askPassword();
      cancel(input);
      expect(await answered).toBeNull();
      expect(input.isRaw).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The interaction
// ---------------------------------------------------------------------------

describe('local-mode login', () => {
  it('is unreachable in SSH mode: it refuses to run and creates no credential file', async () => {
    const origin = 'https://chat.example.com';
    const ssh: ClientConfig = sshConfig(origin);
    const credentialPath = tempCredentialPath();

    // The gate is a throw, not a warning: the SSH path has no password prompt
    // (KTD1) and no token on disk (R27), so reaching this module is a bug that
    // must be loud. Neither entry point may create anything.
    expect(() => createLocalLoginStorage(ssh, { path: credentialPath })).toThrowError(SshModeLoginError);
    const manager = managerFor(origin, {
      read: () => null,
      write: () => undefined,
    });
    await expect(
      runLocalLogin(ssh, manager, { prompt: noPrompt(), output: capture().writer }),
    ).rejects.toThrowError(SshModeLoginError);
    expect(fs.existsSync(credentialPath)).toBe(false);
    expect(fs.existsSync(path.dirname(credentialPath))).toBe(false);
  });

  it('reports wrong credentials, asks again, and persists nothing from a failed attempt', async () => {
    const server = await startStubServer();
    const out = capture();
    const local = createLocalLoginStorage(localConfig(server.origin), { path: tempCredentialPath() });
    const manager = managerFor(server.origin, local.storage);
    const prompt = scriptedPrompt([GOOD_IDENTIFIER, BAD_PASSWORD, GOOD_IDENTIFIER, GOOD_PASSWORD]);

    const outcome = await runLocalLogin(localConfig(server.origin), manager, {
      localStorage: local,
      prompt,
      output: out.writer,
    });

    expect(outcome.status).toBe('authenticated');
    const shown = out.text();
    expect(shown).toContain('Signing in…');
    expect(shown).toContain('Wrong username/email or password.');
    expect(shown).toContain('INVALID_CREDENTIALS');
    // The rejected pair was never stored, and the accepted one was.
    const attempts = server.requestsTo('/api/v1/auth/login');
    expect(attempts).toHaveLength(2);
    expect(JSON.parse(fs.readFileSync(local.path, 'utf8'))).toEqual({
      origin: server.origin,
      accessToken: LOGIN_ACCESS,
      refreshToken: LOGIN_REFRESH,
    });
    expect(modeOf(local.path)).toBe(CREDENTIAL_FILE_MODE);
    expect(prompt.asked).toEqual(['identifier', 'password', 'identifier', 'password']);
  });

  it('reuses a stored credential on the next run, without prompting, and it authenticates a real request', async () => {
    const server = await startStubServer();
    const credentialPath = tempCredentialPath();

    // Run one: sign in, persist.
    const first = capture();
    const firstStorage = createLocalLoginStorage(localConfig(server.origin), { path: credentialPath });
    const firstManager = managerFor(server.origin, firstStorage.storage);
    const firstOutcome = await runLocalLogin(localConfig(server.origin), firstManager, {
      localStorage: firstStorage,
      prompt: scriptedPrompt([GOOD_IDENTIFIER, GOOD_PASSWORD]),
      output: first.writer,
    });
    expect(firstOutcome.status).toBe('authenticated');
    expect(fs.existsSync(credentialPath)).toBe(true);
    expect(modeOf(credentialPath)).toBe(CREDENTIAL_FILE_MODE);
    firstManager.getGateway()?.disconnect();
    firstManager.getGateway()?.destroy();

    // Run two: a fresh manager, a fresh adapter, the same file — no prompt.
    const second = capture();
    const secondStorage = createLocalLoginStorage(localConfig(server.origin), { path: credentialPath });
    const secondManager = managerFor(server.origin, secondStorage.storage);
    const secondOutcome = await runLocalLogin(localConfig(server.origin), secondManager, {
      localStorage: secondStorage,
      prompt: noPrompt(),
      output: second.writer,
    });

    expect(secondOutcome).toEqual({ status: 'authenticated', username: 'tester', reused: true });
    // The loading state is stated, not silent: the member sees what the client
    // is waiting on before it either reuses or prompts.
    expect(second.text()).toContain('Checking your saved session');
    expect(second.text()).toContain('from your saved session');
    // The persisted refresh token really was exchanged…
    expect(server.requestsTo('/api/v1/auth/refresh')).toEqual([
      expect.objectContaining({
        method: 'POST',
        authorization: `Bearer ${LOGIN_ACCESS}`,
        body: { refresh_token: LOGIN_REFRESH },
      }),
    ]);
    // …and the rotated access token is what the server saw on a real request.
    await secondManager.api.getCurrentUser();
    const me = server.requestsTo('/api/v1/users/@me');
    expect(me[me.length - 1]?.authorization).toBe(`Bearer ${ROTATED_ACCESS}`);
    // The rotation is persisted, owner-only, for the run after this one.
    expect(JSON.parse(fs.readFileSync(credentialPath, 'utf8'))).toEqual({
      origin: server.origin,
      accessToken: ROTATED_ACCESS,
      refreshToken: ROTATED_REFRESH,
    });
    expect(modeOf(credentialPath)).toBe(CREDENTIAL_FILE_MODE);
    secondManager.getGateway()?.disconnect();
    secondManager.getGateway()?.destroy();
  });

  it('discards a corrupt credential file with a message, then signs in', async () => {
    const server = await startStubServer();
    const credentialPath = tempCredentialPath();
    fs.mkdirSync(path.dirname(credentialPath), { recursive: true });
    fs.writeFileSync(credentialPath, '{"refreshToken": "cyt_refresh_dead"'); // truncated

    const out = capture();
    const local = createLocalLoginStorage(localConfig(server.origin), { path: credentialPath });
    const manager = managerFor(server.origin, local.storage);

    const outcome = await runLocalLogin(localConfig(server.origin), manager, {
      localStorage: local,
      prompt: scriptedPrompt([GOOD_IDENTIFIER, GOOD_PASSWORD]),
      output: out.writer,
    });

    expect(outcome.status).toBe('authenticated');
    const shown = out.text();
    expect(shown).toContain('could not be read');
    expect(shown).toContain(credentialPath);
    // The corpse is gone and the live pair replaced it.
    expect(JSON.parse(fs.readFileSync(credentialPath, 'utf8')).refreshToken).toBe(LOGIN_REFRESH);
    manager.getGateway()?.disconnect();
    manager.getGateway()?.destroy();
  });

  it('tells the member a saved session is no longer valid, then signs in again', async () => {
    const server = await startStubServer();
    const credentialPath = tempCredentialPath();
    const stale = createCredentialFile({
      mode: 'local',
      path: credentialPath,
      origin: server.origin,
    });
    stale.write({ accessToken: LOGIN_ACCESS, refreshToken: 'cyt_refresh_revoked' });
    await stale.flush();
    server.setRefreshLive(false);

    const out = capture();
    const local = createLocalLoginStorage(localConfig(server.origin), { path: credentialPath });
    const manager = managerFor(server.origin, local.storage);

    const outcome = await runLocalLogin(localConfig(server.origin), manager, {
      localStorage: local,
      prompt: scriptedPrompt([GOOD_IDENTIFIER, GOOD_PASSWORD]),
      output: out.writer,
    });

    expect(outcome.status).toBe('authenticated');
    expect(out.text()).toContain('no longer valid');
    manager.getGateway()?.disconnect();
    manager.getGateway()?.destroy();
  });

  it('clears a dead stored credential, and says the session is no longer valid', async () => {
    const server = await startStubServer();
    const credentialPath = tempCredentialPath();
    const dead = createCredentialFile({ mode: 'local', path: credentialPath, origin: server.origin });
    dead.write({ accessToken: LOGIN_ACCESS, refreshToken: 'cyt_refresh_revoked' });
    await dead.flush();
    server.setRefreshLive(false);

    const out = capture();
    const local = createLocalLoginStorage(localConfig(server.origin), { path: credentialPath });
    const manager = managerFor(server.origin, local.storage);

    const outcome = await runLocalLogin(localConfig(server.origin), manager, {
      localStorage: local,
      prompt: scriptedPrompt([null]), // the member reads the message and gives up
      output: out.writer,
    });

    expect(outcome).toEqual({ status: 'cancelled' });
    expect(out.text()).toContain('no longer valid');
    // A credential the server will not take is cleared rather than retried on
    // every later run (the session's failed-restore reset persists null).
    expect(fs.existsSync(credentialPath)).toBe(false);
  });

  it('leaves another server’s saved session alone, and replaces it only on a sign-in here', async () => {
    const server = await startStubServer();
    const credentialPath = tempCredentialPath();
    const other = createCredentialFile({ mode: 'local', path: credentialPath, origin: 'https://other.example.com' });
    other.write({ accessToken: LOGIN_ACCESS, refreshToken: LOGIN_REFRESH });
    await other.flush();
    const written = fs.readFileSync(credentialPath, 'utf8');

    // Run one: the member changes their mind. Nothing of the other server's
    // session is adopted, and nothing of it is destroyed either.
    const first = capture();
    const firstStorage = createLocalLoginStorage(localConfig(server.origin), { path: credentialPath });
    const firstManager = managerFor(server.origin, firstStorage.storage);
    const firstOutcome = await runLocalLogin(localConfig(server.origin), firstManager, {
      localStorage: firstStorage,
      prompt: scriptedPrompt([null]),
      output: first.writer,
    });
    expect(firstOutcome).toEqual({ status: 'cancelled' });
    expect(first.text()).toContain('belongs to https://other.example.com');
    expect(first.text()).toContain(server.origin);
    expect(fs.readFileSync(credentialPath, 'utf8')).toBe(written);

    // Run two: signing in here makes the file this server's session — one
    // saved session per client, which is the plan's single-server V1 scope.
    const second = capture();
    const secondStorage = createLocalLoginStorage(localConfig(server.origin), { path: credentialPath });
    const secondManager = managerFor(server.origin, secondStorage.storage);
    const secondOutcome = await runLocalLogin(localConfig(server.origin), secondManager, {
      localStorage: secondStorage,
      prompt: scriptedPrompt([GOOD_IDENTIFIER, GOOD_PASSWORD]),
      output: second.writer,
    });
    expect(secondOutcome.status).toBe('authenticated');
    expect(JSON.parse(fs.readFileSync(credentialPath, 'utf8'))).toEqual({
      origin: server.origin,
      accessToken: LOGIN_ACCESS,
      refreshToken: LOGIN_REFRESH,
    });
    secondManager.getGateway()?.disconnect();
    secondManager.getGateway()?.destroy();
  });

  it('reports an unreachable server rather than a credential error', async () => {
    const origin = await unusedOrigin();
    const out = capture();
    const local = createLocalLoginStorage(localConfig(origin), { path: tempCredentialPath() });
    const manager = managerFor(origin, local.storage);

    const outcome = await runLocalLogin(localConfig(origin), manager, {
      localStorage: local,
      prompt: scriptedPrompt([GOOD_IDENTIFIER, GOOD_PASSWORD]),
      output: out.writer,
      attempts: 1,
    });

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    expect(outcome.message).toContain("Couldn't reach the server");
    expect(out.text()).not.toContain('Wrong username/email or password.');
    expect(fs.existsSync(local.path)).toBe(false);
  });

  it('falls back to a session-only login when the credential file cannot be written', async () => {
    const server = await startStubServer();
    const blocked = path.join(currentRoot(), 'not-a-directory');
    fs.writeFileSync(blocked, 'a file, not a home\n');

    const out = capture();
    const env = { ...process.env, HOME: blocked, XDG_CONFIG_HOME: undefined };
    const local = createLocalLoginStorage(localConfig(server.origin), { env });
    expect(local.writable).toBe(false);
    const manager = managerFor(server.origin, local.storage);

    const outcome = await runLocalLogin(localConfig(server.origin), manager, {
      localStorage: local,
      prompt: scriptedPrompt([GOOD_IDENTIFIER, GOOD_PASSWORD]),
      output: out.writer,
    });

    // The session is live; only its persistence is missing, and it says so,
    // including why the member will be asked again.
    expect(outcome).toEqual({ status: 'authenticated', username: 'tester', reused: false });
    const shown = out.text();
    expect(shown).toContain('cannot be saved');
    expect(shown).toContain(local.path);
    expect(shown).toContain('ENOTDIR');
    expect(shown).toContain('memory only');
    expect(shown).toContain('sign in again next time');
    // The unwritable target is reported ONCE, as the persistence problem it is
    // — never also as a corrupt file that could not be read.
    expect(shown).not.toContain('could not be read');
    expect(fs.existsSync(local.path)).toBe(false);
    await manager.api.getCurrentUser();
    expect(server.requestsTo('/api/v1/users/@me').length).toBeGreaterThanOrEqual(1);
    manager.getGateway()?.disconnect();
    manager.getGateway()?.destroy();
  });

  it('uses the process home directory when no environment is injected', () => {
    const home = fs.mkdtempSync(path.join(currentRoot(), 'home-'));
    const saved = process.env.HOME;
    const savedXdg = process.env.XDG_CONFIG_HOME;
    try {
      process.env.HOME = home;
      delete process.env.XDG_CONFIG_HOME;

      const storage = createLocalLoginStorage(localConfig('https://chat.example.com'));
      expect(storage.writable).toBe(true);
      expect(storage.path).toBe(path.join(home, '.config', 'cytale', 'credentials.json'));
      storage.storage.write({ accessToken: LOGIN_ACCESS, refreshToken: LOGIN_REFRESH });
      expect(modeOf(storage.path)).toBe(CREDENTIAL_FILE_MODE);
    } finally {
      if (saved === undefined) delete process.env.HOME;
      else process.env.HOME = saved;
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
    }
  });

  it('gives up after a bounded number of attempts, with the last reason intact', async () => {
    const server = await startStubServer();
    const out = capture();
    const local = createLocalLoginStorage(localConfig(server.origin), { path: tempCredentialPath() });
    const manager = managerFor(server.origin, local.storage);
    const answers = Array.from({ length: MAX_LOGIN_ATTEMPTS * 2 }, () => [GOOD_IDENTIFIER, BAD_PASSWORD]).flat();

    const outcome = await runLocalLogin(localConfig(server.origin), manager, {
      localStorage: local,
      prompt: scriptedPrompt(answers),
      output: out.writer,
    });

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('expected a failure');
    expect(outcome.message).toContain('Wrong username/email or password.');
    expect(outcome.attempts).toBe(MAX_LOGIN_ATTEMPTS);
    expect(server.requestsTo('/api/v1/auth/login')).toHaveLength(MAX_LOGIN_ATTEMPTS);
    expect(fs.existsSync(local.path)).toBe(false);
  });

  it('re-asks an empty identifier or password instead of sending it', async () => {
    const server = await startStubServer();
    const out = capture();
    const local = createLocalLoginStorage(localConfig(server.origin), { path: tempCredentialPath() });
    const manager = managerFor(server.origin, local.storage);

    const outcome = await runLocalLogin(localConfig(server.origin), manager, {
      localStorage: local,
      prompt: scriptedPrompt(['', GOOD_IDENTIFIER, '', GOOD_PASSWORD]),
      output: out.writer,
    });

    expect(outcome.status).toBe('authenticated');
    expect(server.requestsTo('/api/v1/auth/login')).toHaveLength(1);
    expect(out.text()).toContain('required');
    manager.getGateway()?.disconnect();
    manager.getGateway()?.destroy();
  });

  it('cancels cleanly when the member interrupts the prompt', async () => {
    const server = await startStubServer();
    const out = capture();
    const local = createLocalLoginStorage(localConfig(server.origin), { path: tempCredentialPath() });
    const manager = managerFor(server.origin, local.storage);

    const outcome = await runLocalLogin(localConfig(server.origin), manager, {
      localStorage: local,
      prompt: scriptedPrompt([null]),
      output: out.writer,
    });

    expect(outcome).toEqual({ status: 'cancelled' });
    expect(server.requestsTo('/api/v1/auth/login')).toHaveLength(0);
    expect(fs.existsSync(local.path)).toBe(false);
  });

  it('names each failure the way the web login does, and keeps the three apart', () => {
    const rejected = describeLoginFailure(
      new ApiError({ key: 'INVALID_CREDENTIALS', code: 40101, message: 'denied', status: 401 }),
    );
    const offline = describeLoginFailure(
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      }),
    );
    const other = describeLoginFailure(new ApiError({ key: 'RATE_LIMITED', code: 42901, message: 'slow', status: 429 }));

    expect(rejected.message).toBe('Wrong username/email or password.');
    expect(rejected.detail).toContain('INVALID_CREDENTIALS');

    // 6.4 rename window: the server's key is `invalid_credentials` now, and the
    // shouty spelling above is what a pre-rename server sent. Both must map to
    // the credential copy — the first cut of the rename missed this client.
    const lower = describeLoginFailure(
      new ApiError({ key: 'invalid_credentials', code: 40101, message: 'denied', status: 401 }),
    );
    expect(lower.message).toBe('Wrong username/email or password.');
    expect(offline.message).toContain('ECONNREFUSED');
    expect(offline.message).not.toContain('Wrong username');
    expect(other.message).toContain('Could not sign in');
    expect(other.detail).toContain('RATE_LIMITED');
    expect(new Set([rejected.message, offline.message, other.message]).size).toBe(3);
  });
});

/** An origin nothing is listening on (a port that was open a moment ago). */
async function unusedOrigin(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo | null;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  if (address === null) throw new Error('the probe server did not bind');
  return `http://127.0.0.1:${address.port}`;
}
