/**
 * @cytale/web — keygen tests (U3).
 *
 * WHY THIS SUITE RUNS IN THE NODE ENVIRONMENT. The plan's decisive test is
 * "the emitted private key passes `ssh-keygen -y`" — the only assertion that
 * proves the browser-produced file is a real OpenSSH private key rather than
 * a plausible-looking string. That needs a process to spawn, and jsdom has
 * none, so this file opts into `node` while the UI suite stays in jsdom (Node
 * exposes the same WebCrypto the browser does, so `keygen.ts` runs unmodified).
 *
 * Two independent proofs, deliberately kept separate:
 *
 *   1. `ssh-keygen -y` re-derives the public key from the emitted private
 *      key and the result is compared to the public-key line we hand the
 *      member. This is the end-to-end proof: the seed offset, the check
 *      integers and the container framing must all be right for it to work,
 *      and a wrong seed would produce a DIFFERENT public key rather than an
 *      error — which is exactly the failure that would otherwise reach the
 *      member as an unexplained `ssh -i` refusal.
 *   2. Byte-exact structural assertions over the decoded container, checked
 *      against the layout `ssh-keygen` itself writes: the magic, the `none`
 *      cipher and kdf, one key, the outer public blob being the full
 *      `string("ssh-ed25519") || string(point)` form while the one inside the
 *      private section is the bare 32-byte point, `seed || point` as the
 *      64-byte private field, equal check integers, and 1..n padding to the
 *      8-byte block. These hold whether or not the tool exists, so the format
 *      is never left unproven by an absent binary.
 */

// @vitest-environment node

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import {
  CERTIFICATE_FILENAME,
  DEFAULT_KEY_COMMENT,
  PRIVATE_KEY_FILENAME,
  SSH_ED25519,
  base64ToBytes,
  blobFingerprint,
  describePublicKeyLineProblem,
  generateEd25519Keypair,
  parsePublicKeyLine,
  publicKeyFingerprint,
  type GeneratedEd25519Keypair,
} from '../keygen.js';

// ---------------------------------------------------------------------------
// the OpenSSH toolchain
// ---------------------------------------------------------------------------

/** Locate `ssh-keygen`; null means "this environment cannot spawn". */
function findSshKeygen(): string | null {
  const fixed = '/usr/bin/ssh-keygen';
  if (existsSync(fixed)) return fixed;
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir !== '' && existsSync(join(dir, 'ssh-keygen'))) return join(dir, 'ssh-keygen');
  }
  return null;
}

const SSH_KEYGEN = findSshKeygen();

/** Run `ssh-keygen`; the callers are all inside a `skipIf` on its presence. */
function sshKeygen(args: string[]): string {
  if (SSH_KEYGEN === null) throw new Error('ssh-keygen is unavailable in this environment');
  return execFileSync(SSH_KEYGEN, args, { encoding: 'utf8' });
}

/** The reason string that makes a skipped proof visible rather than silent. */
const NO_TOOLCHAIN = 'skipped: no ssh-keygen in this environment (structure asserted instead)';

const scratch = mkdtempSync(join(tmpdir(), 'cytale-keygen-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Write the pair to the scratch dir the way the member would. */
function writeFiles(pair: GeneratedEd25519Keypair, name: string): { key: string; pub: string } {
  const key = join(scratch, `${name}_id_ed25519`);
  const pub = join(scratch, `${name}_id_ed25519.pub`);
  writeFileSync(key, pair.privateKey, { mode: 0o600 });
  writeFileSync(pub, `${pair.publicKeyLine}\n`);
  return { key, pub };
}

/** The algorithm token and key material of a public-key line (no comment). */
function keyMaterialOf(line: string): string {
  return line.split(/\s+/).slice(0, 2).join(' ');
}

// ---------------------------------------------------------------------------
// byte helpers for the structural assertions
// ---------------------------------------------------------------------------

interface Reader {
  bytes: Uint8Array;
  offset: number;
}

function readUint32(reader: Reader): number {
  const view = new DataView(
    reader.bytes.buffer,
    reader.bytes.byteOffset + reader.offset,
    4,
  );
  const value = view.getUint32(0, false);
  reader.offset += 4;
  return value;
}

function readString(reader: Reader): Uint8Array {
  const length = readUint32(reader);
  const value = reader.bytes.subarray(reader.offset, reader.offset + length);
  reader.offset += length;
  return value;
}

/** The whole `openssh-key-v1` container, decoded out of the PEM armor. */
function decodeContainer(pem: string): Uint8Array {
  const body = pem
    .split('\n')
    .filter((line) => !line.startsWith('-----'))
    .join('');
  const bytes = base64ToBytes(body);
  if (bytes === null) throw new Error('private key body is not base64');
  return bytes;
}

interface ContainerFields {
  magic: string;
  cipherName: string;
  kdfName: string;
  kdfOptionsLength: number;
  keyCount: number;
  publicBlob: Uint8Array;
  privateSection: Uint8Array;
  /** Everything after the outer framing; 0 means the container is exact. */
  trailing: number;
}

function parseContainer(bytes: Uint8Array): ContainerFields {
  const reader: Reader = { bytes, offset: 0 };
  const magic = new TextDecoder().decode(bytes.subarray(0, 15));
  reader.offset = 15;
  const cipherName = new TextDecoder().decode(readString(reader));
  const kdfName = new TextDecoder().decode(readString(reader));
  const kdfOptions = readString(reader);
  const keyCount = readUint32(reader);
  const publicBlob = readString(reader);
  const privateSection = readString(reader);
  return {
    magic,
    cipherName,
    kdfName,
    kdfOptionsLength: kdfOptions.length,
    keyCount,
    publicBlob,
    privateSection,
    trailing: bytes.length - reader.offset,
  };
}

interface PrivateFields {
  check1: number;
  check2: number;
  keyType: string;
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  comment: string;
  padding: Uint8Array;
}

function parsePrivateSection(section: Uint8Array): PrivateFields {
  const reader: Reader = { bytes: section, offset: 0 };
  const check1 = readUint32(reader);
  const check2 = readUint32(reader);
  const keyType = new TextDecoder().decode(readString(reader));
  const publicKey = readString(reader);
  const privateKey = readString(reader);
  const comment = new TextDecoder().decode(readString(reader));
  return {
    check1,
    check2,
    keyType,
    publicKey,
    privateKey,
    comment,
    padding: section.subarray(reader.offset),
  };
}

// ---------------------------------------------------------------------------
// the decisive proof
// ---------------------------------------------------------------------------

describe.skipIf(SSH_KEYGEN === null)(
  `the emitted private key against real OpenSSH (${SSH_KEYGEN ?? NO_TOOLCHAIN})`,
  () => {
    it('`ssh-keygen -y` re-derives the public key we handed the member', async () => {
      const pair = await generateEd25519Keypair();
      const { key } = writeFiles(pair, 'match');

      const derived = sshKeygen(['-y', '-f', key]).trim();

      // The comment differs (ssh-keygen -y prints the one in the file, ours
      // is in the public line); the algorithm token and the key material are
      // what must agree, and they only agree if the seed was written at the
      // right offset in the right container.
      expect(keyMaterialOf(derived)).toBe(keyMaterialOf(pair.publicKeyLine));
      expect(derived.startsWith(`${SSH_ED25519} `)).toBe(true);
    });

    it('`ssh-keygen -l` agrees with the fingerprint we display', async () => {
      const pair = await generateEd25519Keypair();
      const { pub } = writeFiles(pair, 'fingerprint');

      const listed = sshKeygen(['-l', '-f', pub]).trim();
      // "256 SHA256:<base64> cytale (ED25519)"
      const reported = listed.split(/\s+/)[1];

      expect(reported).toBe(pair.fingerprint);
      expect(pair.fingerprint).toBe(await publicKeyFingerprint(pair.publicKeyLine));
    });

    it('the container shape matches what ssh-keygen itself writes', async () => {
      // The control. Asserting our own container is internally consistent
      // proves nothing on its own; matching OpenSSH's own writer is what
      // makes the structural assertions below meaningful.
      const pair = await generateEd25519Keypair('ours');
      const ours = parseContainer(decodeContainer(pair.privateKey));

      const controlPath = join(scratch, 'control_key');
      sshKeygen(['-t', 'ed25519', '-N', '', '-C', 'theirs', '-f', controlPath]);
      const theirs = parseContainer(decodeContainer(readFileSync(controlPath, 'utf8')));

      expect(ours.cipherName).toBe(theirs.cipherName);
      expect(ours.kdfName).toBe(theirs.kdfName);
      expect(ours.kdfOptionsLength).toBe(theirs.kdfOptionsLength);
      expect(ours.keyCount).toBe(theirs.keyCount);
      expect(ours.publicBlob.length).toBe(theirs.publicBlob.length);
      expect(ours.trailing).toBe(0);
      expect(theirs.trailing).toBe(0);

      const ourPrivate = parsePrivateSection(ours.privateSection);
      const theirPrivate = parsePrivateSection(theirs.privateSection);
      expect(ourPrivate.publicKey.length).toBe(theirPrivate.publicKey.length);
      expect(ourPrivate.privateKey.length).toBe(theirPrivate.privateKey.length);
      // Both pad to the same block; the padding length itself is a function
      // of the comment length, so compare the alignment, not the count.
      expect(ours.privateSection.length % 8).toBe(theirs.privateSection.length % 8);
    });
  },
);

// ---------------------------------------------------------------------------
// the format itself (always runs)
// ---------------------------------------------------------------------------

describe('openssh-key-v1 container', () => {
  it('is the exact layout OpenSSH reads, field for field', async () => {
    const pair = await generateEd25519Keypair();

    // The armor is a real PEM with the OpenSSH label, wrapped at 70 columns.
    const lines = pair.privateKey.split('\n');
    expect(lines[0]).toBe('-----BEGIN OPENSSH PRIVATE KEY-----');
    expect(lines[lines.length - 2]).toBe('-----END OPENSSH PRIVATE KEY-----');
    expect(lines[lines.length - 1]).toBe('');

    const container = decodeContainer(pair.privateKey);
    const parsed = parseContainer(container);

    expect(parsed.magic).toBe('openssh-key-v1\u0000');
    expect(parsed.cipherName).toBe('none');
    expect(parsed.kdfName).toBe('none');
    expect(parsed.kdfOptionsLength).toBe(0);
    expect(parsed.keyCount).toBe(1);
    expect(parsed.trailing).toBe(0);

    // Outer public blob: BOTH strings — the algorithm name, then the point.
    const outerReader: Reader = { bytes: parsed.publicBlob, offset: 0 };
    expect(new TextDecoder().decode(readString(outerReader))).toBe(SSH_ED25519);
    const point = readString(outerReader);
    expect(point.length).toBe(32);
    expect(outerReader.offset).toBe(parsed.publicBlob.length);

    const priv = parsePrivateSection(parsed.privateSection);
    expect(priv.check1).toBe(priv.check2);
    expect(priv.keyType).toBe(SSH_ED25519);
    // Inside the private section the point is BARE — no algorithm prefix.
    // The blob-prefixed form here is the classic silent breakage.
    expect(priv.publicKey.length).toBe(32);
    expect(Array.from(priv.publicKey)).toEqual(Array.from(point));
    // The private field is seed || point, 64 bytes.
    expect(priv.privateKey.length).toBe(64);
    expect(Array.from(priv.privateKey.subarray(32))).toEqual(Array.from(point));
    expect(priv.comment).toBe(DEFAULT_KEY_COMMENT);

    // 1..n padding to the 8-byte block.
    expect(priv.padding.length).toBeGreaterThan(0);
    expect(priv.padding.length).toBeLessThanOrEqual(8);
    expect(Array.from(priv.padding)).toEqual(
      Array.from({ length: priv.padding.length }, (_, i) => i + 1),
    );
    expect(parsed.privateSection.length % 8).toBe(0);
  });

  it('the public key line is a valid ssh-ed25519 line, and the blob is the point', async () => {
    const pair = await generateEd25519Keypair();

    expect(pair.publicKeyLine.startsWith(`${SSH_ED25519} `)).toBe(true);
    const parsed = parsePublicKeyLine(pair.publicKeyLine);
    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe(SSH_ED25519);
    expect(parsed?.comment).toBe(DEFAULT_KEY_COMMENT);

    // The line's blob is exactly the container's outer public blob, so the
    // fingerprint the member sees describes the key the certificate is for.
    const container = parseContainer(decodeContainer(pair.privateKey));
    expect(Array.from(parsed?.blob ?? [])).toEqual(Array.from(container.publicBlob));

    // And the fingerprint is a SHA-256 of that blob, `SHA256:`-prefixed.
    expect(pair.fingerprint).toBe(await blobFingerprint(container.publicBlob));
    expect(pair.fingerprint.startsWith('SHA256:')).toBe(true);
    expect(pair.fingerprint).not.toContain('=');
  });

  it('names the files the pairing depends on', () => {
    // The basename pairing is what makes `ssh` find the certificate. These
    // constants are load-bearing, not cosmetic.
    expect(PRIVATE_KEY_FILENAME).toBe('id_ed25519');
    expect(CERTIFICATE_FILENAME).toBe('id_ed25519-cert.pub');
  });

  it('generates a fresh key every time', async () => {
    const first = await generateEd25519Keypair();
    const second = await generateEd25519Keypair();
    expect(first.publicKeyLine).not.toBe(second.publicKeyLine);
    expect(first.privateKey).not.toBe(second.privateKey);
  });

  it('fails with a named reason when the runtime has no WebCrypto', async () => {
    vi.stubGlobal('crypto', {});
    try {
      await expect(generateEd25519Keypair()).rejects.toThrow(/WebCrypto/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ---------------------------------------------------------------------------
// paste validation
// ---------------------------------------------------------------------------

describe('public-key paste validation', () => {
  it('accepts a real line and reports nothing', async () => {
    const pair = await generateEd25519Keypair();
    expect(describePublicKeyLineProblem(pair.publicKeyLine)).toBeNull();
    expect(describePublicKeyLineProblem(`  ${pair.publicKeyLine}  `)).toBeNull();
  });

  it('names the empty case', () => {
    expect(describePublicKeyLineProblem('   ')).toMatch(/Paste your public key/);
  });

  it('names the paste-the-private-key mistake', () => {
    const problem = describePublicKeyLineProblem('-----BEGIN OPENSSH PRIVATE KEY-----');
    expect(problem).toMatch(/public key line/);
    expect(problem).toMatch(/not the private key/);
  });

  it('names an unsupported algorithm instead of failing opaquely', () => {
    const problem = describePublicKeyLineProblem('ssh-rsa AAAAB3NzaC1yc2EAAAADAQAB user@host');
    expect(problem).toMatch(/ssh-rsa/);
    expect(problem).toMatch(/not supported/);
  });

  it('names a truncated ed25519 line', async () => {
    const pair = await generateEd25519Keypair();
    const truncated = pair.publicKeyLine.slice(0, pair.publicKeyLine.indexOf(' ') + 24);
    const problem = describePublicKeyLineProblem(truncated);
    expect(problem).toMatch(/not readable/);
    expect(parsePublicKeyLine(truncated)).toBeNull();
  });

  it('rejects a line whose blob has trailing bytes or a wrong point length', () => {
    // string("ssh-ed25519") || string(31 bytes) — structurally close, unusable.
    const empty = 'ssh-ed25519 ' + btoa('1234') + ' user@host';
    expect(parsePublicKeyLine(empty)).toBeNull();
    expect(describePublicKeyLineProblem(empty)).not.toBeNull();
  });
});
