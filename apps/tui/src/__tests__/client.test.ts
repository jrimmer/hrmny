/**
 * @cytale/tui — the client's own behaviour: mode/origin resolution (R14), the
 * connection state it reports, the failure messages it distinguishes, the
 * session-end reasons it renders (R19a), and the first-request ordering KTD8
 * fixes.
 *
 * The servers here are REAL http/https servers on loopback with real `fetch`
 * through `@cytale/api-client` and a real `SessionManager` — the client's
 * request path is not stubbed anywhere, so "the client completed an
 * authenticated request" means a socket accepted one. What IS a seam: the
 * gateway (a stub that reports connection transitions instead of dialling),
 * the descriptor (a scripted byte source, because the host is U4's half), and
 * the Ink renderer for `runClient` (so the full CLI path can be driven without
 * a TTY).
 */
import { createServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createElement, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@cytale/api-client';
import type { ConnectionState, GatewayClientOptions, GatewayClient } from '@cytale/gateway-client';
import { createStateStore, defaultStore } from '@cytale/state';
import { render } from 'ink-testing-library';

import { App, type ConnectionView } from '../app.js';
import {
  ClientConfigError,
  classifyFailure,
  createClientSession,
  normalizeOrigin,
  parseInvocation,
  reissueUrl,
  runClient,
  sessionEndMessage,
  type ClientConfig,
  type ClientSession,
  type ClientSessionDeps,
} from '../client.js';
import type { LoginPrompt } from '../session/login.js';
import type { TokenDescriptor } from '../session/tokenPipe.js';
import { SESSION_END_REASONS } from '../session/tokenPipe.js';

const TOKEN_A = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlLWE';
const TOKEN_B = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlLWI';
/** The pair the stub server's login mints (U9's local sign-in). */
const LOGIN_REFRESH = 'cyt_refresh_login';
const GOOD_PASSWORD = 'correct horse battery staple';

const tokenFrame = (token: string): string => `{"access_token":"${token}","expires_in":900}\n`;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** A descriptor the test drives byte for byte, standing in for the host. */
interface ScriptedDescriptor extends TokenDescriptor {
  write(bytes: string): void;
}

function createScriptedDescriptor(): ScriptedDescriptor {
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

/** The gateway seam: reports lifecycle transitions instead of dialling a server. */
function stubGateway(): {
  factory: (options: GatewayClientOptions) => GatewayClient;
  emit(to: ConnectionState): void;
} {
  let options: GatewayClientOptions | null = null;
  const emit = (to: ConnectionState): void => {
    options?.onStateChange?.({ from: 'connecting', to });
  };
  return {
    emit,
    factory: (next: GatewayClientOptions): GatewayClient => {
      options = next;
      return {
        connect: async () => {
          emit('connecting');
          emit('connected');
        },
        disconnect: () => undefined,
        destroy: () => undefined,
        onAny: () => () => undefined,
      } as unknown as GatewayClient;
    },
  };
}

interface StubServer {
  readonly origin: string;
  readonly requests: Array<{ method: string; url: string; authorization: string | null }>;
  /** 200 (a valid session) or 401 (a token the server will not accept). */
  setMeStatus(status: 200 | 401): void;
  close(): Promise<void>;
}

/** A server the harness can shut down (http and https both fit). */
interface ListenableServer {
  listen(port: number, host: string, callback: () => void): unknown;
  close(callback: () => void): unknown;
  address(): AddressInfo | string | null;
}

const servers: ListenableServer[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});

/**
 * A real Cytale-shaped server: `/api/v1/users/@me`, the local sign-in
 * (`POST /auth/login`, U9), and the boot load's four reads (U12) — so a
 * `runClient` path that hydrates really fills the store from sockets.
 */
async function startStubServer(): Promise<StubServer> {
  let meStatus: 200 | 401 = 200;
  const requests: StubServer['requests'] = [];

  const server = createServer((req, res) => {
    const url = req.url ?? '';
    requests.push({
      method: req.method ?? '',
      url,
      authorization: req.headers.authorization ?? null,
    });
    const json = (status: number, payload: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (url.startsWith('/api/v1/users/@me') && url !== '/api/v1/users/@me/workspaces') {
      if (meStatus === 401) {
        json(401, { error: { key: 'unauthorized', code: 40101, message: 'The access token is not valid' } });
        return;
      }
      json(200, {
        user: { id: '123', username: 'tester', email: 'tester@example.com', email_verified_at: null },
      });
      return;
    }

    // The local sign-in (U9). Any identifier/password is accepted here: this
    // suite asserts the wiring, and the login unit owns the rejection copy.
    if (url === '/api/v1/auth/login' && req.method === 'POST') {
      json(200, { access_token: TOKEN_A, refresh_token: LOGIN_REFRESH, expires_in: 900 });
      return;
    }
    if (url === '/api/v1/auth/logout') {
      res.writeHead(204);
      res.end();
      return;
    }

    // The boot load's graph (U12), in the server's own envelopes.
    if (url === '/api/v1/users/@me/workspaces') {
      json(200, {
        workspaces: [
          {
            id: 'w1',
            name: 'Acme',
            description: null,
            icon_url: null,
            owner_id: '123',
            created_at: '2026-01-01T00:00:00Z',
            member_count: 1,
          },
        ],
      });
      return;
    }
    if (url === '/api/v1/users/@me/channels') {
      json(200, { channels: [] });
      return;
    }
    if (url === '/api/v1/workspaces/w1/channels') {
      json(200, {
        channels: [
          {
            id: 'c1',
            workspace_id: 'w1',
            name: 'general',
            type: 0,
            parent_id: null,
            topic: null,
            position: 0,
            last_message_id: null,
            created_at: '2026-01-01T00:00:00Z',
          },
        ],
      });
      return;
    }
    if (url === '/api/v1/workspaces/w1/people') {
      json(200, {
        people: [{ user: { id: '123', username: 'tester', avatar_url: null }, nickname: null, joined_at: '', roles: [] }],
        next_before: null,
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { key: 'not_found', code: 40401, message: 'no route' } }));
  });

  const origin = await listen(server, 'http');
  return {
    origin,
    requests,
    setMeStatus(status) {
      meStatus = status;
    },
    close: () => closeServer(server),
  };
}

/**
 * A real HTTPS server with a self-signed certificate, so the client's
 * certificate branch is exercised by a real TLS handshake and a real
 * verification failure (`DEPTH_ZERO_SELF_SIGNED_CERT`) rather than by a
 * hand-built error object. The key is a throwaway generated for this fixture
 * and valid only for 127.0.0.1 (see the bottom of this file).
 */
async function startSelfSignedServer(): Promise<string> {
  const server = createHttpsServer({ key: SELF_SIGNED_KEY, cert: SELF_SIGNED_CERT }, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  return await listen(server, 'https');
}

/** An origin nothing is listening on (a port that was open a moment ago). */
async function unusedOrigin(): Promise<string> {
  const server = createServer();
  const origin = await listen(server, 'http');
  await closeServer(server);
  return origin;
}

async function listen(server: ListenableServer, scheme: 'http' | 'https'): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the test server did not bind');
  return `${scheme}://127.0.0.1:${address.port}`;
}

async function closeServer(server: ListenableServer): Promise<void> {
  const index = servers.indexOf(server);
  if (index >= 0) servers.splice(index, 1);
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

const sshConfig = (origin: string, ignoredArgument: string | null = null): ClientConfig => ({
  mode: 'ssh',
  origin,
  descriptorFd: 3,
  ignoredArgument,
});

/** A wired SSH session against a real server, driven by a scripted descriptor. */
function sshSession(
  origin: string,
  descriptor: ScriptedDescriptor,
  gateway = stubGateway(),
): ClientSession {
  const deps: ClientSessionDeps = { descriptor, createGatewayClient: gateway.factory };
  return createClientSession(sshConfig(origin), deps);
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  throw new Error('timed out waiting for the client');
}

/** Let queued microtasks run (used to prove nothing happened yet). */
const settle = async (): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, 20);
  });
};

// ---------------------------------------------------------------------------
// Mode and origin resolution (R14)
// ---------------------------------------------------------------------------

describe('resolving the origin before the session exists', () => {
  it('parses a server URL argument in local mode and normalizes it to an origin', () => {
    expect(parseInvocation({ argv: ['https://chat.example.com/'], env: {} })).toEqual({
      mode: 'local',
      origin: 'https://chat.example.com',
      descriptorFd: null,
      ignoredArgument: null,
    });
    // A path is dropped, not doubled: /api/v1 and /gateway/websocket come later.
    expect(parseInvocation({ argv: ['http://localhost:4000/some/path'], env: {} }).origin).toBe(
      'http://localhost:4000',
    );
  });

  it('refuses a bare host:port, because the transport is derived from the scheme', () => {
    expect(() => normalizeOrigin('localhost:4000')).toThrowError(ClientConfigError);
    try {
      normalizeOrigin('chat.example.com');
      throw new Error('expected a ClientConfigError');
    } catch (err) {
      expect(err).toBeInstanceOf(ClientConfigError);
      expect((err as ClientConfigError).kind).toBe('usage');
      expect((err as ClientConfigError).message).toContain('bare host:port');
    }
  });

  it('treats a missing URL, and extra arguments, as usage errors', () => {
    for (const argv of [[], ['   '], ['https://chat.example.com', 'extra']] as string[][]) {
      try {
        parseInvocation({ argv, env: {} });
        throw new Error(`expected a usage error for ${JSON.stringify(argv)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(ClientConfigError);
        expect((err as ClientConfigError).kind).toBe('usage');
      }
    }
  });

  it('ignores a session-supplied URL in SSH mode, in favour of the host configuration', async () => {
    const server = await startStubServer();
    const config = parseInvocation({
      argv: ['http://evil.example'],
      env: { CYTALE_TOKEN_FD: '7', CYTALE_ORIGIN: server.origin },
    });

    expect(config.mode).toBe('ssh');
    expect(config.origin).toBe(server.origin);
    expect(config.descriptorFd).toBe(7);
    // Recorded, so "ignored" is inspectable rather than merely absent.
    expect(config.ignoredArgument).toBe('http://evil.example');

    // And the request really goes to the host's server.
    const descriptor = createScriptedDescriptor();
    descriptor.write(tokenFrame(TOKEN_A));
    const session = sshSession(config.origin, descriptor);
    await session.start();
    expect(session.view().phase).toBe('online');
    expect(server.requests).toHaveLength(1);
    session.stop();
  });

  it('refuses to run in SSH mode when the host set no origin (and never guesses)', () => {
    try {
      parseInvocation({ argv: ['https://chat.example.com'], env: { CYTALE_TOKEN_FD: '7' } });
      throw new Error('expected a host-config error');
    } catch (err) {
      expect(err).toBeInstanceOf(ClientConfigError);
      expect((err as ClientConfigError).kind).toBe('host-config');
      expect((err as ClientConfigError).message).toContain('CYTALE_ORIGIN');
    }
    // A junk descriptor number is a host misconfiguration too.
    expect(() =>
      parseInvocation({ argv: [], env: { CYTALE_TOKEN_FD: 'not-a-number', CYTALE_ORIGIN: 'https://x.example' } }),
    ).toThrowError(ClientConfigError);
  });
});

// ---------------------------------------------------------------------------
// Usage errors never become connection attempts
// ---------------------------------------------------------------------------

describe('the CLI entry', () => {
  it('prints a usage error and makes no connection attempt when the URL is missing', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const out = captureStdio();
    const code = await runClient({
      argv: [],
      env: {},
      stdout: out.stdout,
      stderr: out.stderr,
      deps: {
        render: () => {
          throw new Error('the client must not draw before the origin resolves');
        },
      },
    });

    expect(code).toBe(2);
    expect(out.stderrText()).toContain('usage error');
    expect(out.stderrText()).toContain('cytale-tui <server-url>');
    expect(out.stdoutText()).toBe('');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('prints the usage for --help without a URL', async () => {
    const out = captureStdio();
    const code = await runClient({ argv: ['--help'], env: {}, stdout: out.stdout, stderr: out.stderr });
    expect(code).toBe(0);
    expect(out.stdoutText()).toContain('cytale-tui <server-url>');
  });
});

// ---------------------------------------------------------------------------
// Reaching a ready state, and the first-request ordering (KTD8)
// ---------------------------------------------------------------------------

describe('connecting', () => {
  it('reaches a ready state against a stub server and reports it', async () => {
    const server = await startStubServer();
    const descriptor = createScriptedDescriptor();
    descriptor.write(tokenFrame(TOKEN_A));

    const session = sshSession(server.origin, descriptor);
    expect(session.view().phase).toBe('connecting');

    await session.start();

    const view = session.view();
    expect(view.phase).toBe('online');
    expect(view.headline).toContain(server.origin);
    expect(view.detail).toContain('@tester');
    session.stop();
  });

  it('issues no request before the host writes the first token', async () => {
    const server = await startStubServer();
    const descriptor = createScriptedDescriptor();
    const session = sshSession(server.origin, descriptor);

    const started = session.start();
    await settle();

    // The session is authenticated by nothing yet, so nothing was sent.
    expect(server.requests).toHaveLength(0);
    expect(session.view().phase).toBe('connecting');

    descriptor.write(tokenFrame(TOKEN_A));
    await started;

    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.authorization).toBe(`Bearer ${TOKEN_A}`);
    session.stop();
  });

  it('publishes a renewal from the descriptor into the live request path', async () => {
    const server = await startStubServer();
    const descriptor = createScriptedDescriptor();
    descriptor.write(tokenFrame(TOKEN_A));

    const session = sshSession(server.origin, descriptor);
    await session.start();
    expect(session.tokenSource?.current().accessToken).toBe(TOKEN_A);

    descriptor.write(tokenFrame(TOKEN_B));
    await waitFor(() => session.tokenSource?.current().accessToken === TOKEN_B);

    // The next request carries the renewed token, with no restart and no
    // storage round-trip (KTD8).
    await session.manager.api.getCurrentUser();
    expect(server.requests[server.requests.length - 1]?.authorization).toBe(`Bearer ${TOKEN_B}`);
    session.stop();
  });

  it('integrates: one authenticated REST request against a real server, using only the descriptor token', async () => {
    const server = await startStubServer();
    const descriptor = createScriptedDescriptor();
    descriptor.write(tokenFrame(TOKEN_A));

    // Nothing but the descriptor carries a token: no env var, no argument.
    const session = sshSession(server.origin, descriptor);
    await session.start();

    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toEqual({
      method: 'GET',
      url: '/api/v1/users/@me',
      authorization: `Bearer ${TOKEN_A}`,
    });
    expect(session.view().phase).toBe('online');
    session.stop();
  });

  it('ignores a malformed descriptor value instead of crashing at startup', async () => {
    const server = await startStubServer();
    const descriptor = createScriptedDescriptor();
    descriptor.write('{"this is":');
    descriptor.write('not a frame at all\n');
    descriptor.write('\n');
    descriptor.write(tokenFrame(TOKEN_A));

    const session = sshSession(server.origin, descriptor);
    await session.start();

    expect(session.view().phase).toBe('online');
    expect(server.requests[0]?.authorization).toBe(`Bearer ${TOKEN_A}`);
    session.stop();
  });

  it('reports local mode as signed out after a cancelled sign-in, having consulted its credential file', async () => {
    const origin = 'http://localhost:4000';
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cytale-tui-client-'));
    const credentialPath = path.join(root, 'cytale', 'credentials.json');
    const out = captureStdio();
    try {
      const session = createClientSession(
        { mode: 'local', origin, descriptorFd: null, ignoredArgument: null },
        {
          credentialPath,
          // A prompt the member interrupts: the no-TTY/EOF case, without
          // depending on the runner's own stdin.
          loginPrompt: { askIdentifier: async () => null, askPassword: async () => null },
          loginOutput: out.stdout,
        },
      );

      await session.start();

      expect(session.config.mode).toBe('local');
      expect(session.tokenSource).toBeNull();
      // U9's storage is the credential file, not the memory adapter, and it is
      // the same object the sign-in used.
      expect(session.localStorage?.path).toBe(credentialPath);
      expect(session.storage).toBe(session.localStorage?.storage);
      // The file was consulted, and the client said so before it asked.
      expect(out.stdoutText()).toContain(`Checking your saved session for ${origin}…`);
      // Still signed out — but now the copy says the sign-in was interrupted
      // rather than that no credential exists.
      expect(session.view()).toEqual({
        phase: 'signed_out',
        headline: 'Not signed in',
        detail: `The sign-in was cancelled; run the client again to sign in to ${origin}.`,
      });
      // A cancelled sign-in persists nothing.
      expect(fs.existsSync(credentialPath)).toBe(false);
      session.stop();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('pins the shared store: the session writes the same instance the shell is handed', () => {
    // The module default, for the host that injects nothing (which is every
    // production run)…
    const plain = createClientSession(sshConfig('https://x.example'), {
      descriptor: createScriptedDescriptor(),
    });
    expect(plain.store).toBe(defaultStore);
    expect(plain.localStorage).toBeNull();

    // …and the injected instance, for everyone else. The hydrator is built over
    // `session.store`, so "one instance" is a property of this module.
    const store = createStateStore();
    const injected = createClientSession(sshConfig('https://x.example'), {
      descriptor: createScriptedDescriptor(),
      store,
    });
    expect(injected.store).toBe(store);
    expect(injected.store).not.toBe(defaultStore);
  });
});

// ---------------------------------------------------------------------------
// The three seams, at the call site (U6's shell, U9's sign-in, U12's load)
// ---------------------------------------------------------------------------

describe('wiring the committed units to the entry point', () => {
  it('local mode consults the credential file it was given before it mounts the tree', async () => {
    // The contrast with the pre-wiring characterization: the same local config
    // now reaches the credential file (which it was told to use) rather than
    // falling straight to a signed-out banner with no I/O at all.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cytale-tui-wired-'));
    const credentialPath = path.join(root, 'cytale', 'credentials.json');
    const out = captureStdio();
    try {
      const session = createClientSession(
        { mode: 'local', origin: 'http://localhost:4000', descriptorFd: null, ignoredArgument: null },
        {
          credentialPath,
          loginPrompt: { askIdentifier: async () => null, askPassword: async () => null },
          loginOutput: out.stdout,
        },
      );
      await session.start();

      // The file was opened for the origin this run targets: the adapter's own
      // probe created the owner-only directory (and left no credential).
      expect(session.localStorage?.file.diagnostics().path).toBe(credentialPath);
      expect(session.localStorage?.file.diagnostics().found).toBe(false);
      expect(fs.statSync(path.dirname(credentialPath)).mode & 0o777).toBe(0o700);
      expect(out.stdoutText()).toContain('Checking your saved session');
      expect(session.view().phase).toBe('signed_out');
      session.stop();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs the sign-in to completion BEFORE the Ink tree mounts', async () => {
    const server = await startStubServer();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cytale-tui-order-'));
    const out = captureStdio();
    const events: string[] = [];
    const held = gate();
    const prompt: LoginPrompt = {
      async askIdentifier() {
        events.push('prompt:identifier');
        await held.promise;
        return 'tester';
      },
      async askPassword() {
        return GOOD_PASSWORD;
      },
    };
    const seen: Array<Record<string, unknown>> = [];
    try {
      const running = runClient({
        argv: [server.origin],
        env: {},
        stdout: out.stdout,
        stderr: out.stderr,
        deps: {
          credentialPath: path.join(root, 'cytale', 'credentials.json'),
          loginPrompt: prompt,
          createGatewayClient: stubGateway().factory,
          store: createStateStore(),
          render: (node: ReactElement) => {
            seen.push(node.props as Record<string, unknown>);
            return { rerender: () => undefined, unmount: () => undefined };
          },
        },
      });

      // The prompt is mid-question and the tree does not exist: the two writers
      // of one terminal never overlap (U9's ordering constraint).
      await waitFor(() => events.includes('prompt:identifier'));
      await settle();
      expect(seen).toHaveLength(0);
      expect(out.stdoutText()).toContain(`Checking your saved session for ${server.origin}…`);

      held.open();
      await waitFor(() => seen.length > 0);
      // Every line the sign-in printed came before the first frame.
      expect(out.stdoutText()).toContain('Signing in…');
      expect(out.stdoutText()).toContain('Signed in as @tester.');

      (seen[0]?.onQuit as () => void)();
      expect(await running).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('signs in locally, persists the credential owner-only, and reaches the online view', async () => {
    const server = await startStubServer();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cytale-tui-e2e-'));
    const credentialPath = path.join(root, 'cytale', 'credentials.json');
    const out = captureStdio();
    const store = createStateStore();
    const seen: Array<Record<string, unknown>> = [];
    const persisted: Array<{ mode: number; body: unknown }> = [];
    try {
      const running = runClient({
        argv: [server.origin],
        env: {},
        stdout: out.stdout,
        stderr: out.stderr,
        deps: {
          credentialPath,
          loginPrompt: scriptedLoginPrompt(['tester', GOOD_PASSWORD]),
          createGatewayClient: stubGateway().factory,
          store,
          render: (node: ReactElement) => {
            const props = node.props as Record<string, unknown>;
            seen.push(props);
            // Read the credential while the session is live: ending a local
            // session signs it out (see U9's lifecycle), so the file is gone by
            // the time the run resolves.
            if (persisted.length === 0 && fs.existsSync(credentialPath)) {
              persisted.push({
                mode: fs.statSync(credentialPath).mode & 0o777,
                body: JSON.parse(fs.readFileSync(credentialPath, 'utf8')),
              });
            }
            return { rerender: () => undefined, unmount: () => undefined };
          },
        },
      });

      await waitFor(() => seen.some((props) => (props.view as ConnectionView).phase === 'online'));
      await waitFor(() => Object.keys(store.getState().workspaces).length > 0);
      await waitFor(() => store.getState().channels.c1 !== undefined);

      // The sign-in really went to the server…
      expect(server.requests.filter((request) => request.url === '/api/v1/auth/login')).toHaveLength(1);
      // …and reached an authenticated session, which the banner says.
      expect(out.stdoutText()).toContain('Signed in as @tester.');
      // R27 is scoped to SSH mode: local mode is the one surface allowed to
      // persist a credential, and it persists it owner-only.
      expect(persisted[0]?.mode).toBe(0o600);
      expect(persisted[0]?.body).toEqual({
        origin: server.origin,
        accessToken: TOKEN_A,
        refreshToken: LOGIN_REFRESH,
      });
      // The boot load ran on the signed-in session, into the shell's own store.
      expect(store.getState().workspaces.w1?.name).toBe('Acme');
      expect(store.getState().channels.c1?.name).toBe('general');

      (seen[0]?.onQuit as () => void)();
      expect(await running).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('hands the shell its store, the boot load’s snapshot, and the quit binding', async () => {
    const server = await startStubServer();
    const descriptor = createScriptedDescriptor();
    descriptor.write(tokenFrame(TOKEN_A));
    const store = createStateStore();
    const seen: Array<Record<string, unknown>> = [];
    const events: string[] = [];
    const out = captureStdio();

    const running = runClient({
      argv: [],
      env: { CYTALE_TOKEN_FD: '3', CYTALE_ORIGIN: server.origin },
      stdout: out.stdout,
      stderr: out.stderr,
      deps: {
        descriptor,
        createGatewayClient: stubGateway().factory,
        store,
        render: (node: ReactElement) => {
          seen.push(node.props as Record<string, unknown>);
          return {
            rerender: (next: ReactElement) => {
              seen.push(next.props as Record<string, unknown>);
            },
            unmount: () => events.push('unmount'),
          };
        },
      },
    });

    // U12: the store the shell is handed is the instance the hydrator fills.
    await waitFor(() => Object.keys(store.getState().workspaces).length > 0);
    await waitFor(() => seen.some((props) => navigationOf(props)?.phase === 'ready'));
    expect(seen[0]?.store).toBe(store);

    const latest = seen[seen.length - 1] as Record<string, unknown>;
    const navigation = navigationOf(latest);
    expect(navigation?.phase).toBe('ready');
    expect(navigation?.notice).toBeNull();
    // The snapshot's own vocabulary reaches the shell unchanged: `phase`,
    // `error`, `errorDetail` and `dmsFailed` are the column's `NavigationStatus`.
    expect(navigation?.dmsFailed).toBe(false);
    expect(navigation?.error).toBeNull();

    // U6: the quit binding stops the session and takes the Ink tree down.
    expect(typeof latest.onQuit).toBe('function');
    (latest.onQuit as () => void)();
    expect(await running).toBe(0);
    expect(events).toContain('unmount');
    // A member who quit is not told the session ended for a host reason.
    expect(out.stdoutText()).not.toContain('Connect again to continue');
  });

  it('stops the boot load when the session ends, rather than leaving it polling', async () => {
    const server = await startStubServer();
    const descriptor = createScriptedDescriptor();
    descriptor.write(tokenFrame(TOKEN_A));
    const store = createStateStore();
    const seen: Array<Record<string, unknown>> = [];

    const running = runClient({
      argv: [],
      env: { CYTALE_TOKEN_FD: '3', CYTALE_ORIGIN: server.origin },
      stdout: captureStdio().stdout,
      stderr: captureStdio().stderr,
      deps: {
        descriptor,
        createGatewayClient: stubGateway().factory,
        store,
        render: (node: ReactElement) => {
          seen.push(node.props as Record<string, unknown>);
          return {
            rerender: (next: ReactElement) => {
              seen.push(next.props as Record<string, unknown>);
            },
            unmount: () => undefined,
          };
        },
      },
    });

    // Wait for the boot load to settle, so the baseline is the whole fan-out
    // and not the one request the session itself made.
    await waitFor(() => seen.some((props) => navigationOf(props)?.phase === 'ready'));
    const requestsAtEnd = server.requests.length;
    expect(requestsAtEnd).toBeGreaterThan(1);
    (seen[0]?.onQuit as () => void)();
    expect(await running).toBe(0);

    // The epoch re-run is the only thing that would load again, and it is
    // unsubscribed: a store write after the session ended starts no request.
    store.setState((state) => ({ sessionEpoch: state.sessionEpoch + 1 }));
    await settle();
    expect(server.requests.length).toBe(requestsAtEnd);
  });
});

// ---------------------------------------------------------------------------
// Failure messages: three causes, three messages
// ---------------------------------------------------------------------------

describe('failure reporting', () => {
  it('renders a distinct message for an unreachable server', async () => {
    const origin = await unusedOrigin();
    const descriptor = createScriptedDescriptor();
    descriptor.write(tokenFrame(TOKEN_A));

    const session = sshSession(origin, descriptor);
    await session.start();

    const view = session.view();
    expect(view.phase).toBe('failed');
    expect(view.headline).toContain('Cannot reach the Hrmny server');
    expect(view.headline).toContain(origin);
    expect(view.detail).toContain('ECONNREFUSED');
    session.stop();
  });

  it('renders a distinct message for a certificate the client will not trust', async () => {
    const origin = await startSelfSignedServer();
    const descriptor = createScriptedDescriptor();
    descriptor.write(tokenFrame(TOKEN_A));

    const session = sshSession(origin, descriptor);
    await session.start();

    const view = session.view();
    expect(view.phase).toBe('failed');
    expect(view.headline).toContain('TLS certificate could not be verified');
    expect(view.detail).toContain('certificate');
    session.stop();
  });

  it('renders a distinct message for a token the server rejects', async () => {
    const server = await startStubServer();
    server.setMeStatus(401);
    const descriptor = createScriptedDescriptor();
    descriptor.write(tokenFrame(TOKEN_A));

    const session = sshSession(server.origin, descriptor);
    await session.start();

    const view = session.view();
    expect(view.phase).toBe('failed');
    expect(view.headline).toContain('rejected this session');
    session.stop();
  });

  it('keeps the three messages distinct', async () => {
    const unreachableOrigin = await unusedOrigin();
    const tlsOrigin = await startSelfSignedServer();
    const rejected = await startStubServer();
    rejected.setMeStatus(401);

    const views: ConnectionView[] = [];
    for (const origin of [unreachableOrigin, tlsOrigin, rejected.origin]) {
      const descriptor = createScriptedDescriptor();
      descriptor.write(tokenFrame(TOKEN_A));
      const session = sshSession(origin, descriptor);
      await session.start();
      views.push(session.view());
      session.stop();
    }

    const [unreachable, certificate, badToken] = views as [ConnectionView, ConnectionView, ConnectionView];
    expect(new Set([unreachable.headline, certificate.headline, badToken.headline]).size).toBe(3);
    expect(unreachable.headline).not.toContain('certificate');
    expect(certificate.headline).not.toContain('Cannot reach');
    expect(badToken.headline).not.toContain('Cannot reach');
  });

  it('classifies a fetch-wrapped DNS failure and an unknown error without collapsing them', () => {
    const wrapped = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) });
    expect(classifyFailure(wrapped, 'https://chat.example.com').headline).toContain('Cannot reach');
    expect(classifyFailure(new Error('something else'), 'https://chat.example.com').phase).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// A 401 is recoverable, never a sign-out (the access-only contract)
// ---------------------------------------------------------------------------

describe('renewal recovery', () => {
  it('surfaces a 401, keeps the session, and re-establishes it on the next token', async () => {
    const server = await startStubServer();
    const descriptor = createScriptedDescriptor();
    descriptor.write(tokenFrame(TOKEN_A));

    const session = sshSession(server.origin, descriptor);
    await session.start();
    expect(session.view().phase).toBe('online');

    server.setMeStatus(401);
    await expect(session.manager.api.getCurrentUser()).rejects.toMatchObject({ key: 'session_expired' });

    // Surfaced, not torn down: no sign-out, no re-login path needed.
    expect(session.view().phase).toBe('expired');
    expect(session.manager.authStore.getState().status).toBe('authenticated');

    server.setMeStatus(200);
    descriptor.write(tokenFrame(TOKEN_B));
    await waitFor(() => session.view().phase === 'online');
    expect(server.requests[server.requests.length - 1]?.authorization).toBe(`Bearer ${TOKEN_B}`);
    session.stop();
  });

  it('goes offline, not silent, when the gateway link drops', async () => {
    const server = await startStubServer();
    const descriptor = createScriptedDescriptor();
    descriptor.write(tokenFrame(TOKEN_A));
    const gateway = stubGateway();

    const session = sshSession(server.origin, descriptor, gateway);
    await session.start();
    expect(session.view().phase).toBe('online');

    gateway.emit('reconnecting');
    expect(session.view().phase).toBe('offline');
    expect(session.view().headline).toContain('Connection lost');
    session.stop();
  });
});

// ---------------------------------------------------------------------------
// Session end (R19a)
// ---------------------------------------------------------------------------

describe('session end', () => {
  it('names each cause, and where re-issuing is the remedy, where to re-issue', () => {
    const url = reissueUrl('https://chat.example.com');
    expect(url).toBe('https://chat.example.com/#/settings/ssh');

    const expired = sessionEndMessage('certificate_expired', { reissueUrl: url });
    expect(expired).toContain('certificate expired');
    expect(expired).toContain(url);

    const epochMoved = sessionEndMessage('credential_epoch_moved', { reissueUrl: url });
    expect(epochMoved).toContain('credentials were reset');
    expect(epochMoved).toContain(url);

    const refused = sessionEndMessage('bridge_refused', { reissueUrl: url });
    expect(refused).toContain('refused');
    expect(refused).toContain(url);

    const duration = sessionEndMessage('max_session_duration', { reissueUrl: url });
    expect(duration).toContain('maximum duration');
    expect(duration).not.toContain(url);

    const idle = sessionEndMessage('idle_timeout', { reissueUrl: url });
    expect(idle).toContain('idle');

    const tokenPath = sessionEndMessage('token_path_failed', { reissueUrl: url });
    expect(tokenPath).toContain('renew');

    // A code the client does not know is still named rather than swallowed.
    expect(sessionEndMessage('mystery', { reissueUrl: url })).toContain('mystery');
  });

  it('renders a distinct message for each reason in the host vocabulary', () => {
    const url = reissueUrl('https://chat.example.com');
    const messages = SESSION_END_REASONS.map((reason) => sessionEndMessage(reason, { reissueUrl: url }));
    expect(new Set(messages).size).toBe(SESSION_END_REASONS.length);
    for (const message of messages) expect(message).not.toBe('');
    // Every code the host sends is one this renderer knows, rather than falling
    // through to the generic "This session ended: …" default: naming the cause is
    // the whole of R19a.
    for (const reason of SESSION_END_REASONS) {
      expect(sessionEndMessage(reason, { reissueUrl: url })).not.toContain(`This session ended: ${reason}`);
    }
  });

  it('ends the session when the host sends an end frame', async () => {
    const server = await startStubServer();
    const descriptor = createScriptedDescriptor();
    descriptor.write(tokenFrame(TOKEN_A));

    const session = sshSession(server.origin, descriptor);
    const seen: string[] = [];
    session.onEnd((reason) => seen.push(reason));
    await session.start();

    descriptor.write('{"end":"max_session_duration"}\n');
    await waitFor(() => seen.length === 1);
    expect(seen).toEqual(['max_session_duration']);
    session.stop();
  });

  it('keeps the host reason when end-of-stream follows the end frame', async () => {
    // The host's ending sequence exactly: the reason frame, then the write end
    // closes. The close is what used to be the only signal, and it reports a
    // token-path failure — so this asserts the frame, not the EOF, decides the
    // cause the member is told.
    const server = await startStubServer();
    const descriptor = createScriptedDescriptor();
    descriptor.write(tokenFrame(TOKEN_A));

    const session = sshSession(server.origin, descriptor);
    const seen: string[] = [];
    session.onEnd((reason) => seen.push(reason));
    await session.start();

    descriptor.write('{"end":"certificate_expired"}\n');
    descriptor.close();
    await waitFor(() => seen.length === 1);
    expect(seen).toEqual(['certificate_expired']);

    // A second ending cannot overwrite the first: the close that follows the
    // frame is not a cause of its own.
    expect(seen).toHaveLength(1);
    session.stop();
  });

  it('ends the session, as a token-path failure, when the host stops renewing', async () => {
    const server = await startStubServer();
    const descriptor = createScriptedDescriptor();
    descriptor.write(tokenFrame(TOKEN_A));

    const session = sshSession(server.origin, descriptor);
    const seen: string[] = [];
    session.onEnd((reason) => seen.push(reason));
    await session.start();

    descriptor.close();
    await waitFor(() => seen.length === 1);
    expect(seen).toEqual(['token_path_failed']);
    session.stop();
  });

  it('ends the session, visibly, when no token ever arrives', async () => {
    const origin = await unusedOrigin();
    const descriptor = createScriptedDescriptor();
    const session = createClientSession(sshConfig(origin), {
      descriptor,
      createGatewayClient: stubGateway().factory,
      firstTokenTimeoutMs: 40,
    });
    const seen: string[] = [];
    session.onEnd((reason) => seen.push(reason));

    await session.start();

    expect(session.view().headline).toContain('No access token arrived');
    expect(seen).toEqual(['token_path_failed']);
  });
});

// ---------------------------------------------------------------------------
// The CLI's end path: leave the terminal readable, then print the reason
// ---------------------------------------------------------------------------

describe('running the client to a session end', () => {
  it('unmounts the app before it prints the host reason', async () => {
    const server = await startStubServer();
    const descriptor = createScriptedDescriptor();
    descriptor.write(tokenFrame(TOKEN_A));

    const events: string[] = [];
    const out = captureStdio(() => events.push('stdout:end-message'));
    const gateway = stubGateway();
    const running = runClient({
      argv: [],
      env: { CYTALE_TOKEN_FD: '3', CYTALE_ORIGIN: server.origin },
      stdout: out.stdout,
      stderr: out.stderr,
      deps: {
        descriptor,
        createGatewayClient: gateway.factory,
        render: () => {
          events.push('render');
          return {
            rerender: () => undefined,
            unmount: () => events.push('unmount'),
          };
        },
      },
    });

    await waitFor(() => events.includes('render'));
    descriptor.write('{"end":"certificate_expired"}\n');
    const code = await running;

    expect(code).toBe(0);
    expect(events.indexOf('unmount')).toBeLessThan(events.indexOf('stdout:end-message'));
    expect(out.stdoutText()).toContain('certificate expired');
    expect(out.stdoutText()).toContain(reissueUrl(server.origin));
  });

  it('ends the whole client when the host closes the renewal channel', async () => {
    const server = await startStubServer();
    const descriptor = createScriptedDescriptor();
    descriptor.write(tokenFrame(TOKEN_A));

    const out = captureStdio();
    const running = runClient({
      argv: [],
      env: { CYTALE_TOKEN_FD: '3', CYTALE_ORIGIN: server.origin },
      stdout: out.stdout,
      stderr: out.stderr,
      deps: {
        descriptor,
        createGatewayClient: stubGateway().factory,
        render: () => ({ rerender: () => undefined, unmount: () => undefined }),
      },
    });

    // The client reached the server before the host closed the renewal
    // channel. (`>= 1`, not `=== 1`: the boot load U12 starts alongside the
    // session may add its own requests while this polls.)
    await waitFor(() => server.requests.length >= 1);
    // The host closed the descriptor: no further token can arrive, so the
    // client stops trying and says so (exit 1 — a token-path failure).
    descriptor.close();

    expect(await running).toBe(1);
    expect(out.stdoutText()).toContain('could not renew');
  });
});

// ---------------------------------------------------------------------------
// The banner renders what the view model says
// ---------------------------------------------------------------------------

describe('the connection banner', () => {
  // `createElement` rather than JSX: this file is `.ts` (the components live
  // in `app.tsx`).
  const banner = (view: ConnectionView, mode: 'ssh' | 'local' = 'ssh', origin = 'https://x.example'): string =>
    render(createElement(App, { view, mode, origin })).lastFrame() ?? '';

  it('renders every phase with a non-colour marker and its own headline', () => {
    const views: Record<string, ConnectionView> = {
      connecting: { phase: 'connecting', headline: 'Connecting to https://chat.example.com…' },
      online: { phase: 'online', headline: 'Connected to https://chat.example.com', detail: 'Signed in as @tester.' },
      offline: { phase: 'offline', headline: 'Connection lost — reconnecting' },
      expired: { phase: 'expired', headline: 'Access token expired — waiting for a renewed token' },
      failed: { phase: 'failed', headline: 'Cannot reach the Hrmny server at https://chat.example.com' },
      signed_out: { phase: 'signed_out', headline: 'Not signed in' },
    };

    for (const [phase, view] of Object.entries(views)) {
      const frame = banner(view, 'ssh', 'https://chat.example.com');
      expect(frame, `phase ${phase}`).toContain(view.headline);
      expect(frame, `phase ${phase}`).toContain('ssh mode');
    }
  });

  it('renders the three failure causes differently', () => {
    const unreachable = banner(
      classifyFailure(Object.assign(new Error('nope'), { code: 'ECONNREFUSED' }), 'https://x.example'),
    );
    const certificate = banner(
      classifyFailure(Object.assign(new Error('nope'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }), 'https://x.example'),
    );
    const rejected = banner(
      classifyFailure(
        new ApiError({ key: 'session_expired', code: 40101, message: 'nope', status: 401 }),
        'https://x.example',
      ),
    );

    expect(new Set([unreachable, certificate, rejected]).size).toBe(3);
    expect(certificate).toContain('certificate');
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A promise the test opens by hand, to hold a prompt mid-question. */
function gate(): { readonly promise: Promise<void>; open(): void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open: () => open() };
}

/** A prompt that answers from a script — the login's own seam, in miniature. */function scriptedLoginPrompt(answers: readonly string[]): LoginPrompt {
  const queue = [...answers];
  const next = (): string | null => queue.shift() ?? null;
  return {
    askIdentifier: async () => next(),
    askPassword: async () => next(),
  };
}

/** The shell's `navigation` prop (U12's snapshot), read structurally. */
function navigationOf(props: Record<string, unknown> | undefined): {
  phase?: string;
  notice?: string | null;
  error?: string | null;
  errorDetail?: string | null;
  dmsFailed?: boolean;
} | undefined {
  return props?.navigation as
    | {
        phase?: string;
        notice?: string | null;
        error?: string | null;
        errorDetail?: string | null;
        dmsFailed?: boolean;
      }
    | undefined;
}

function captureStdio(onWrite?: () => void): {
  stdout: { write(chunk: string): boolean };
  stderr: { write(chunk: string): boolean };
  stdoutText(): string;
  stderrText(): string;
} {
  let stdoutText = '';
  let stderrText = '';
  return {
    stdout: {
      write(chunk: string) {
        stdoutText += chunk;
        onWrite?.();
        return true;
      },
    },
    stderr: {
      write(chunk: string) {
        stderrText += chunk;
        return true;
      },
    },
    stdoutText: () => stdoutText,
    stderrText: () => stderrText,
  };
}

/** A throwaway self-signed certificate for 127.0.0.1 (test fixture only). */
const SELF_SIGNED_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgpRD7b3kHOr6qTs3H
NJ30O7LMZo76KrH+ZijCUAH1nWChRANCAAQZESOysXgg63mdnLKN4FeXEzBhkHIH
AaM5YDQITUezSgDD9aQHuDRQU1QrSKb+R7wWkYDeAlKRLoq1hD7gXWvv
-----END PRIVATE KEY-----`;

const SELF_SIGNED_CERT = `-----BEGIN CERTIFICATE-----
MIIBjTCCATSgAwIBAgIUCP9ob5XYax+FKJJ5Zn4pM5qA6YIwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MDkxMzE5NDMwNVoXDTM2MDkxMDE5
NDMwNVowFDESMBAGA1UEAwwJMTI3LjAuMC4xMFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAEGREjsrF4IOt5nZyyjeBXlxMwYZByBwGjOWA0CE1Hs0oAw/WkB7g0UFNU
K0im/ke8FpGA3gJSkS6KtYQ+4F1r76NkMGIwHQYDVR0OBBYEFAiqKpBfwhOZCjN+
amsLPi9lSey/MB8GA1UdIwQYMBaAFAiqKpBfwhOZCjN+amsLPi9lSey/MA8GA1Ud
EwEB/wQFMAMBAf8wDwYDVR0RBAgwBocEfwAAATAKBggqhkjOPQQDAgNHADBEAiBj
34yLrn9l0EcAA5Y0NSGgwIFbYnJW1wplnPva/oRMwwIga/9sFp/iBkTLWGEO0ZcO
KPN1kJvuOFNzMMYiQuv5Qr4=
-----END CERTIFICATE-----`;
