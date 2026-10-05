/**
 * @cytale/web — in-browser ed25519 keypair generation for the SSH surface (U3).
 *
 * R1: the member generates their keypair here, in the browser, and it never
 * touches the server. The whole flow lives or dies on this module: an
 * openssh private key file that `ssh -i` refuses is indistinguishable, to the
 * member, from a broken certificate, and every later step in the flow depends
 * on this file being exactly what OpenSSH expects.
 *
 * WHAT MAKES THIS NON-TRIVIAL. WebCrypto generates ed25519 keys happily but
 * exports **PKCS#8** (and `raw` for the public half). OpenSSH reads neither:
 * its key files are the `openssh-key-v1` container — a literal magic string
 * followed by length-prefixed SSH strings, a private section wrapped with a
 * repeated random "check" integer, and padding to the block size — with the
 * 32-byte ed25519 seed sitting at a fixed offset inside that private section.
 * There is no WebCrypto encoding for it, and no library in this app's
 * dependency set that writes it, so the translator is a deliverable of its
 * own (plan U3 approach step 1).
 *
 * The layout implemented below is verified two ways in `keygen.test.ts`:
 * byte-for-byte structural assertions against a real `ssh-keygen`-written
 * file, and the decisive one — the emitted PEM is handed to
 * `/usr/bin/ssh-keygen -y`, which re-derives the public key from the private
 * key. If the seed offset, the check integers, or the padding were wrong that
 * command fails, and `ssh -i` would have failed the same way.
 *
 * KEY MATERIAL RULES (binding for every caller):
 *   - never put key material in a URL, a query string, or history;
 *   - never log it, never hand it to an error reporter, never persist it;
 *   - the private key is delivered as a download, never as a clipboard copy.
 * This module is pure: it returns strings to its caller and touches no
 * storage, no clipboard, and no DOM.
 */

/** The OpenSSH algorithm token for the key type this surface issues. */
export const SSH_ED25519 = 'ssh-ed25519';

/**
 * The basenames are load-bearing, not cosmetic. `ssh` looks for a
 * certificate beside the private key as `<private>-cert.pub` and presents it
 * automatically — the basename pairing is what makes `ssh -i id_ed25519`
 * carry the certificate with no `-o CertificateFile=`. A download named
 * anything else silently authenticates as a bare key and is refused.
 */
export const PRIVATE_KEY_FILENAME = 'id_ed25519';
export const CERTIFICATE_FILENAME = 'id_ed25519-cert.pub';

/** The literal OpenSSH container magic, NUL-terminated. */
const AUTH_MAGIC = 'openssh-key-v1\0';

/**
 * The fixed 16-byte PKCS#8 prelude for a bare ed25519 private key. Node's and
 * every browser's WebCrypto produce exactly this for
 * `generateKey({ name: 'Ed25519' })`; the 32-byte seed follows immediately.
 * Asserting the prefix is what makes the seed slice safe — a silent
 * truncation on a different export shape would produce a *valid-looking* key
 * that does not match its own public half.
 */
const PKCS8_ED25519_PREFIX_HEX = '302e020100300506032b657004220420';

/** The default certificate/key identifier the server records for the key. */
export const DEFAULT_KEY_COMMENT = 'cytale';

/** The block size OpenSSH pads the private section to for the `none` cipher. */
const PRIVATE_SECTION_BLOCK = 8;

/** PEM body wrapping, matching what `ssh-keygen` writes (70 columns). */
const PEM_LINE_WIDTH = 70;

export interface GeneratedEd25519Keypair {
  /** The complete `id_ed25519` file text (PEM, `openssh-key-v1`). */
  privateKey: string;
  /** The `ssh-ed25519 AAAA… <comment>` line — what the member submits (R2). */
  publicKeyLine: string;
  /** `SHA256:…` for the public key; matches `ssh-keygen -lf`. */
  fingerprint: string;
}

// ---------------------------------------------------------------------------
// byte helpers
// ---------------------------------------------------------------------------

function uint32BE(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** One `string` in the SSH wire encoding: a big-endian length, then the bytes. */
function sshString(value: string | Uint8Array): Uint8Array {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return concatBytes([uint32BE(bytes.length), bytes]);
}

function bytesToBinaryString(bytes: Uint8Array): string {
  // Chunked: `String.fromCharCode(...bytes)` overflows the argument list on a
  // key-sized buffer.
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  return btoa(bytesToBinaryString(bytes));
}

export function base64ToBytes(base64: string): Uint8Array | null {
  try {
    const binary = atob(base64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function pemArmor(label: string, der: Uint8Array): string {
  const body = bytesToBase64(der);
  const lines: string[] = [];
  for (let i = 0; i < body.length; i += PEM_LINE_WIDTH) {
    lines.push(body.slice(i, i + PEM_LINE_WIDTH));
  }
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

// ---------------------------------------------------------------------------
// public key encoding
// ---------------------------------------------------------------------------

/**
 * The SSH public-key blob for a raw ed25519 point:
 * `string("ssh-ed25519") || string(32-byte point)`. This exact blob is what a
 * public-key line base64s, what the fingerprint hashes, and what the
 * certificate signs over — one encoding, three consumers.
 */
export function encodeEd25519PublicKeyBlob(rawPublicKey: Uint8Array): Uint8Array {
  if (rawPublicKey.length !== 32) {
    throw new Error(
      `ed25519 public keys are 32 bytes; WebCrypto produced ${rawPublicKey.length}`,
    );
  }
  return concatBytes([sshString(SSH_ED25519), sshString(rawPublicKey)]);
}

/** `ssh-ed25519 <base64 blob> <comment>` — the line the member submits. */
export function formatPublicKeyLine(rawPublicKey: Uint8Array, comment = DEFAULT_KEY_COMMENT): string {
  const blob = encodeEd25519PublicKeyBlob(rawPublicKey);
  return `${SSH_ED25519} ${bytesToBase64(blob)} ${comment}`;
}

/** `SHA256:<base64, unpadded>` over the public-key blob (`ssh-keygen -lf`). */
export async function blobFingerprint(blob: Uint8Array): Promise<string> {
  // `new Uint8Array(blob)` (a 51-byte copy) rather than the view itself: the
  // DOM types require an `ArrayBuffer`-backed source, and a view off a
  // shared backing store does not satisfy them.
  const digest = new Uint8Array(await webcrypto().subtle.digest('SHA-256', new Uint8Array(blob)));
  return `SHA256:${bytesToBase64(digest).replace(/=+$/, '')}`;
}

/** The fingerprint of a public-key line, or null when the line does not parse. */
export async function publicKeyFingerprint(line: string): Promise<string | null> {
  const parsed = parsePublicKeyLine(line);
  return parsed === null ? null : await blobFingerprint(parsed.blob);
}

export interface ParsedPublicKeyLine {
  /** The algorithm token as written (`ssh-ed25519`). */
  type: string;
  /** The whole SSH public-key blob. */
  blob: Uint8Array;
  /** Trailing comment, or null when the line carried none. */
  comment: string | null;
}

/**
 * Parse an `ssh-ed25519 <base64> [comment]` line, or null when it is not one.
 *
 * Deliberately structural rather than "any base64": it re-reads the length
 * prefixes inside the blob, so a truncated or hand-edited paste is caught
 * here — with a message the member can act on — instead of arriving at the
 * server as an opaque 400.
 */
export function parsePublicKeyLine(line: string): ParsedPublicKeyLine | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;

  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) return null;
  const [type, encoded, ...commentParts] = parts as [string, string, ...string[]];
  if (type !== SSH_ED25519) return null;

  const blob = base64ToBytes(encoded);
  if (blob === null || blob.length < 4) return null;

  // Re-read the wire structure: string(type) || string(32-byte point).
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  let offset = 0;
  const readString = (): Uint8Array | null => {
    if (offset + 4 > blob.length) return null;
    const length = view.getUint32(offset, false);
    offset += 4;
    if (length < 0 || offset + length > blob.length) return null;
    const value = blob.subarray(offset, offset + length);
    offset += length;
    return value;
  };

  const innerType = readString();
  const point = readString();
  if (innerType === null || point === null) return null;
  if (new TextDecoder().decode(innerType) !== SSH_ED25519) return null;
  if (point.length !== 32 || offset !== blob.length) return null;

  const comment = commentParts.length > 0 ? commentParts.join(' ') : null;
  return { type, blob, comment };
}

/**
 * An actionable sentence for a pasted public key, or null when it is usable.
 *
 * This is the copy the member reads when the paste is wrong, so it names what
 * a correct line looks like rather than "invalid input". The server still
 * validates; this only spares the round trip for the obvious cases.
 */
export function describePublicKeyLineProblem(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed === '') return 'Paste your public key first.';

  const parts = trimmed.split(/\s+/);
  const type = parts[0] ?? '';
  if (!type.startsWith('ssh-') && !type.startsWith('ecdsa-') && !type.startsWith('sk-')) {
    return 'That does not look like a public key line — it should start with ssh-ed25519. Paste the contents of id_ed25519.pub, not the private key.';
  }
  if (parts.length < 2 || (parts[1] ?? '') === '') {
    return 'The public key line is missing its key material. Copy the whole line from id_ed25519.pub, base64 and all.';
  }
  if (parsePublicKeyLine(trimmed) === null) {
    if (type !== SSH_ED25519) {
      return `${type} keys are not supported here — this surface issues certificates for ssh-ed25519 keys.`;
    }
    return 'That ssh-ed25519 line is not readable — the base64 looks truncated or edited. Copy it again from id_ed25519.pub.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// private key encoding
// ---------------------------------------------------------------------------

/** WebCrypto, or a named failure rather than a crash deep in a task. */
function webcrypto(): Crypto {
  const maybe = globalThis.crypto as Crypto | undefined;
  if (maybe?.subtle === undefined) {
    throw new Error(
      'This browser does not expose WebCrypto, so a keypair cannot be generated here. Use a current browser over HTTPS, or generate the key with ssh-keygen and paste its public half below.',
    );
  }
  return maybe;
}

/**
 * Wrap the ed25519 seed in OpenSSH's `openssh-key-v1` container.
 *
 * Field order is the format's, and the two "public key" occurrences are NOT
 * the same encoding — the outer one (field 5) is the full SSH blob, while the
 * one inside the private section is the bare 32-byte point. That asymmetry is
 * the same trap U1 documents for the certificate body; here the outer blob is
 * what the fingerprint hashes, and the inner one is what OpenSSH compares
 * against the key it derives from the seed.
 */
function encodeOpenSshPrivateKey(options: {
  seed: Uint8Array;
  rawPublicKey: Uint8Array;
  checkInt: number;
  comment: string;
}): Uint8Array {
  const { seed, rawPublicKey, checkInt, comment } = options;
  const publicBlob = encodeEd25519PublicKeyBlob(rawPublicKey);

  // The private section: ciphername "none" means this is plaintext, whose
  // only integrity signal is the check integer written twice. OpenSSH uses
  // the pair to detect a wrong passphrase; both must match.
  const privateFields = concatBytes([
    uint32BE(checkInt),
    uint32BE(checkInt),
    sshString(SSH_ED25519),
    sshString(rawPublicKey),
    sshString(concatBytes([seed, rawPublicKey])),
    sshString(comment),
  ]);

  const padLength =
    (PRIVATE_SECTION_BLOCK - (privateFields.length % PRIVATE_SECTION_BLOCK)) % PRIVATE_SECTION_BLOCK;
  const padding = new Uint8Array(padLength);
  for (let i = 0; i < padLength; i += 1) padding[i] = i + 1;

  return concatBytes([
    new TextEncoder().encode(AUTH_MAGIC),
    sshString('none'), // ciphername
    sshString('none'), // kdfname
    sshString(new Uint8Array(0)), // kdfoptions
    uint32BE(1), // number of keys
    sshString(publicBlob),
    sshString(concatBytes([privateFields, padding])),
  ]);
}

/**
 * Generate an ed25519 keypair and serialize both halves the way OpenSSH
 * wants them: the private key as an `openssh-key-v1` PEM file, the public key
 * as a submittable line, plus its fingerprint so the member can match the
 * row the server lists against the key they hold.
 *
 * The key material is returned to the caller and forgotten — nothing here
 * holds, logs, or stores it.
 */
export async function generateEd25519Keypair(
  comment = DEFAULT_KEY_COMMENT,
): Promise<GeneratedEd25519Keypair> {
  const crypto = webcrypto();
  const generated = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  // The DOM lib types an unrecognised algorithm as `CryptoKey | CryptoKeyPair`;
  // ed25519 is a key-PAIR algorithm, so narrow rather than assert.
  if (!('privateKey' in generated)) {
    throw new Error(
      'This browser generated an unusable ed25519 key. Use a current browser, or generate the key with ssh-keygen.',
    );
  }
  const pair: CryptoKeyPair = generated;

  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const rawPublicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));

  const prefix = hexToBytes(PKCS8_ED25519_PREFIX_HEX);
  const prefixOk =
    pkcs8.length === prefix.length + 32 &&
    prefix.every((byte, index) => pkcs8[index] === byte);
  if (!prefixOk) {
    throw new Error(
      'This browser exported the private key in an unexpected format, so it cannot be written as an OpenSSH key file. Use a current browser, or generate the key with ssh-keygen.',
    );
  }
  const seed = pkcs8.slice(prefix.length);

  const checkBytes = new Uint8Array(4);
  crypto.getRandomValues(checkBytes);
  const checkInt = new DataView(checkBytes.buffer).getUint32(0, false);

  const container = encodeOpenSshPrivateKey({ seed, rawPublicKey, checkInt, comment });
  const publicBlob = encodeEd25519PublicKeyBlob(rawPublicKey);

  return {
    privateKey: pemArmor('OPENSSH PRIVATE KEY', container),
    publicKeyLine: formatPublicKeyLine(rawPublicKey, comment),
    fingerprint: await blobFingerprint(publicBlob),
  };
}
