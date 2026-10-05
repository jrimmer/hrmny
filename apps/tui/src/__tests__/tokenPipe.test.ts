/**
 * @cytale/tui — the token descriptor's framing and reader (KTD8, R27).
 *
 * Three levels, deliberately:
 *
 *   1. **The framing rules**, as pure functions — a malformed write is dropped
 *      rather than fatal, a frame split across reads is reassembled, the
 *      relative and absolute expiry forms both land on a milliseconds value,
 *      and an `end` frame carries the host's reason through.
 *   2. **A real pipe**, from a spawned host process handed descriptor 3 — the
 *      production shape (KTD8 gives the child a descriptor NUMBER), including
 *      a renewal written later and EOF when the host exits. A stream double
 *      would prove the parsing and nothing about the transport.
 *   3. **A numeric descriptor** through `mkfifo`, so `descriptorFromFd` is
 *      exercised against a genuine inherited file descriptor. This one fails
 *      loudly (named reason, not a skip) when `mkfifo` is unavailable: it is
 *      the only place the number-to-stream adapter is proven, and a silent
 *      pass would leave it unverified.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DescriptorDecoder,
  SESSION_END_REASONS,
  TokenPathError,
  awaitFirstFrame,
  descriptorFromFd,
  descriptorFromStream,
  parseDescriptorFrame,
  startTokenPipe,
  type DescriptorFrame,
  type DescriptorStream,
  type TokenDescriptor,
} from '../session/tokenPipe.js';

const TOKEN_A = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlLWE';
const TOKEN_B = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlLWI';
const NOW = 1_700_000_000_000;

describe('descriptor framing', () => {
  it('reads a token with a relative expiry as an absolute one', () => {
    expect(parseDescriptorFrame(`{"access_token":"${TOKEN_A}","expires_in":900}`, NOW)).toEqual({
      type: 'token',
      accessToken: TOKEN_A,
      expiresAt: NOW + 900_000,
    });
  });

  it('accepts an absolute expiry, and reports "unknown" as 0 rather than expired', () => {
    expect(parseDescriptorFrame(`{"access_token":"${TOKEN_A}","expires_at":${NOW + 60_000}}`, NOW)).toEqual({
      type: 'token',
      accessToken: TOKEN_A,
      expiresAt: NOW + 60_000,
    });
    expect(parseDescriptorFrame(`{"access_token":"${TOKEN_A}"}`, NOW)).toEqual({
      type: 'token',
      accessToken: TOKEN_A,
      expiresAt: 0,
    });
  });

  it('reads an end frame with the host reason verbatim', () => {
    expect(parseDescriptorFrame('{"end":"idle_timeout"}', NOW)).toEqual({ type: 'end', reason: 'idle_timeout' });
    // An unknown code still ends the session — dropped, it would hang instead.
    expect(parseDescriptorFrame('{"end":"mystery"}', NOW)).toEqual({ type: 'end', reason: 'mystery' });
  });

  it('treats malformed input as "not a frame" instead of throwing', () => {
    for (const line of [
      '',
      '   ',
      'not json',
      '{"access_token":}',
      '"a string"',
      '42',
      'null',
      '[]',
      '{}',
      '{"access_token":""}',
      '{"access_token":123}',
      '{"end":""}',
    ]) {
      expect(parseDescriptorFrame(line, NOW), `line: ${JSON.stringify(line)}`).toBeNull();
    }
    // A non-numeric expiry is not malformed: the token is usable, its expiry
    // is simply unknown (0), which the session reads as "not expired".
    expect(parseDescriptorFrame(`{"access_token":"${TOKEN_A}","expires_in":"soon"}`, NOW)).toEqual({
      type: 'token',
      accessToken: TOKEN_A,
      expiresAt: 0,
    });
  });

  it('drops a malformed line and keeps the frames around it', () => {
    const decoder = new DescriptorDecoder();
    const frames = decoder.push(
      `{"access_token":"${TOKEN_A}","expires_at":1}\ngarbage\n{"access_token":"${TOKEN_B}","expires_at":2}\n`,
    );
    expect(frames).toEqual([
      { type: 'token', accessToken: TOKEN_A, expiresAt: 1 },
      { type: 'token', accessToken: TOKEN_B, expiresAt: 2 },
    ]);
  });

  it('reassembles a frame split across two reads and emits both of a joined pair', () => {
    const decoder = new DescriptorDecoder();
    const line = `{"access_token":"${TOKEN_A}","expires_in":900}`;
    expect(decoder.push(line.slice(0, 12))).toEqual([]);
    expect(decoder.pending).toBe(line.slice(0, 12));
    const rest = decoder.push(`${line.slice(12)}\n{"end":"max_session_duration"}\n`);
    expect(rest).toEqual([
      { type: 'token', accessToken: TOKEN_A, expiresAt: expect.any(Number) },
      { type: 'end', reason: 'max_session_duration' },
    ]);
    expect(decoder.pending).toBe('');
  });

  it('lists exactly the reason codes the host sends on an end frame', () => {
    // The other half of this list is `endFrameCode` in
    // apps/ssh-host/internal/session/handoff.go, and that package's suite pins
    // the same six spellings (TestEndFrameVocabularyIsTheLiveClientRule). The
    // two are one vocabulary: a code the host sends but this list omits leaves
    // the client rendering a cause it cannot name, and a code this list adds but
    // the host never sends is a documented lie. Whichever side drifts, this
    // fails.
    expect([...SESSION_END_REASONS]).toEqual([
      'max_session_duration',
      'idle_timeout',
      'certificate_expired',
      'credential_epoch_moved',
      'bridge_refused',
      'token_path_failed',
    ]);

    // And every listed code really is read as a frame carrying that reason.
    for (const reason of SESSION_END_REASONS) {
      expect(parseDescriptorFrame(`{"end":"${reason}"}`, NOW)).toEqual({ type: 'end', reason });
    }
  });
});

// ---------------------------------------------------------------------------
// The real thing: pipes and a genuine descriptor number
// ---------------------------------------------------------------------------

interface OpenFifo {
  readonly descriptor: () => Promise<TokenDescriptor>;
  /** The host's end: write bytes into the pipe. */
  write(bytes: string): Promise<void>;
  cleanup(): void;
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function openFifo(): OpenFifo {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cytale-tui-fifo-'));
  const fifo = path.join(dir, 'tokens');
  try {
    execFileSync('mkfifo', [fifo]);
  } catch (err) {
    // Named, not silent: without `mkfifo` the descriptor transport is unproven.
    throw new Error(`mkfifo is unavailable, so the descriptor cannot be tested against a real pipe: ${String(err)}`);
  }

  let readFd = -1;
  let writeFd = -1;
  let descriptor: TokenDescriptor | null = null;
  const opened = new Promise<void>((resolve, reject) => {
    fs.open(fifo, 'r', (err, fd) => {
      if (err) {
        reject(err);
        return;
      }
      readFd = fd;
      descriptor = descriptorFromFd(fd);
      resolve();
    });
  });

  // A FIFO's open blocks until both ends exist, so the writer's open is issued
  // after the reader's and both settle together.
  const writerOpened = new Promise<void>((resolve, reject) => {
    fs.open(fifo, 'w', (err, fd) => {
      if (err) {
        reject(err);
        return;
      }
      writeFd = fd;
      resolve();
    });
  });

  let ready: Promise<void> | null = null;
  const wait = (): Promise<void> => {
    ready ??= Promise.all([opened, writerOpened]).then(() => undefined);
    return ready;
  };

  const host = {
    async write(bytes: string) {
      await wait();
      fs.writeSync(writeFd, bytes);
    },
    async descriptor() {
      await wait();
      if (descriptor === null) throw new Error('descriptor not open');
      return descriptor;
    },
    cleanup() {
      descriptor?.close();
      if (writeFd !== -1) {
        try {
          fs.closeSync(writeFd);
        } catch {
          // already closed
        }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };

  cleanups.push(() => host.cleanup());
  return host;
}

describe('the descriptor transport (a real pipe)', () => {
  it('reads the first token off an inherited pipe, then a renewal, then EOF', async () => {
    // A real host: a child process handed a pipe on fd 3, exactly the shape
    // KTD8 describes. It writes the first token immediately, a renewal 120ms
    // later, then closes the descriptor and exits.
    const host = spawnTokenHost();
    const descriptor = descriptorFromStream(host.stream);
    const decoder = new DescriptorDecoder();

    await expect(awaitFirstFrame(descriptor, decoder, { timeoutMs: 2000 })).resolves.toEqual({
      type: 'token',
      accessToken: TOKEN_A,
      expiresAt: expect.any(Number),
    });

    // Renewals are a background push from here on.
    const frames: DescriptorFrame[] = [];
    let closed = 0;
    const pipe = startTokenPipe(descriptor, decoder, {
      onFrame: (frame) => frames.push(frame),
      onClose: () => {
        closed += 1;
      },
    });

    await waitFor(() => frames.length === 1);
    expect(frames[0]).toMatchObject({ type: 'token', accessToken: TOKEN_B });

    await waitFor(() => closed === 1);
    expect(closed).toBe(1);
    pipe.stop();
  });

  it('reports a closed descriptor as a token-path failure, not a hang', async () => {
    const host = spawnTokenHost({ frames: [] });
    const descriptor = descriptorFromStream(host.stream);
    const decoder = new DescriptorDecoder();

    await waitFor(() => host.exited);
    await expect(awaitFirstFrame(descriptor, decoder, { timeoutMs: 2000 })).rejects.toMatchObject({
      name: 'TokenPathError',
      failure: 'closed',
    });
  });

  it('reads the end frame the host writes before it closes the pipe', async () => {
    // The host's ending sequence, in order: the reason, then end-of-stream. The
    // frame is what turns an ending into a CAUSE; without it this reader would
    // see only the bare EOF the next test covers.
    const host = spawnTokenHost({
      frames: [`{"access_token":"${TOKEN_A}","expires_in":900}`, '{"end":"certificate_expired"}'],
    });
    const descriptor = descriptorFromStream(host.stream);
    const decoder = new DescriptorDecoder();

    await expect(awaitFirstFrame(descriptor, decoder, { timeoutMs: 2000 })).resolves.toMatchObject({
      type: 'token',
    });

    const frames: DescriptorFrame[] = [];
    let closed = 0;
    startTokenPipe(descriptor, decoder, {
      onFrame: (frame) => frames.push(frame),
      onClose: () => {
        closed += 1;
      },
    });

    await waitFor(() => frames.length === 1);
    expect(frames[0]).toEqual({ type: 'end', reason: 'certificate_expired' });
    await waitFor(() => closed === 1);
  });

  it('ignores a malformed write and still delivers the token after it', async () => {
    const fifo = openFifo();
    const descriptor = await fifo.descriptor();
    const decoder = new DescriptorDecoder();

    await fifo.write('this is not a frame\n');
    await fifo.write(`{"access_token":"${TOKEN_A}"}\n`);

    await expect(awaitFirstFrame(descriptor, decoder, { timeoutMs: 2000 })).resolves.toEqual({
      type: 'token',
      accessToken: TOKEN_A,
      expiresAt: 0,
    });
  });

  it('bounds the wait when the host never writes a token', async () => {
    const fifo = openFifo();
    const descriptor = await fifo.descriptor();
    const decoder = new DescriptorDecoder();

    await expect(awaitFirstFrame(descriptor, decoder, { timeoutMs: 60 })).rejects.toBeInstanceOf(TokenPathError);
  });
});

/**
 * A stand-in host process: it gets a pipe on descriptor 3 (the production
 * shape) and writes NDJSON frames into it, then exits — which closes the
 * descriptor and is what the client sees as a session end.
 */
function spawnTokenHost(options: { frames?: readonly string[] } = {}): {
  stream: DescriptorStream;
  exited: boolean;
  cleanup(): void;
} {
  const frames = options.frames ?? [
    `{"access_token":"${TOKEN_A}","expires_in":900}`,
    `{"access_token":"${TOKEN_B}","expires_in":900}`,
  ];
  const script = [
    "const fs = require('node:fs');",
    `const frames = ${JSON.stringify(frames)};`,
    'let i = 0;',
    'const write = () => {',
    "  if (i < frames.length) { fs.writeSync(3, frames[i] + '\\n'); i += 1; setTimeout(write, 120); }",
    '  else { fs.closeSync(3); }',
    '};',
    'write();',
  ].join('\n');

  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
  const stream = child.stdio[3] as unknown as DescriptorStream;
  const handle = {
    stream,
    exited: false,
    cleanup() {
      child.kill('SIGKILL');
    },
  };
  child.on('exit', () => {
    handle.exited = true;
  });
  cleanups.push(() => handle.cleanup());
  return handle;
}

describe('the numeric descriptor (a FIFO)', () => {
  it('reads a token written into a real numeric descriptor', async () => {
    const fifo = openFifo();
    const descriptor = await fifo.descriptor();
    const decoder = new DescriptorDecoder();

    await fifo.write(`{"access_token":"${TOKEN_A}","expires_in":900}\n`);

    await expect(awaitFirstFrame(descriptor, decoder, { timeoutMs: 2000 })).resolves.toEqual({
      type: 'token',
      accessToken: TOKEN_A,
      expiresAt: expect.any(Number),
    });
  });
});

/** Poll until `predicate` holds (or fail), so the pipe's push timing is not a race. */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  throw new Error('timed out waiting for the descriptor reader');
}
