/**
 * base64 helpers behind the `btoa`/`atob` shims.
 *
 * `btoa`/`atob` are Latin-1 ("binary string") codecs, not UTF-8 — matching the
 * spec matters because callers (e.g. `@cytale/state`'s optimistic id encoder)
 * pass byte-per-character strings and then URL-safe them.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Spec-shaped `btoa`: throws on characters outside the Latin-1 range. */
export function encodeBase64(input: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code > 0xff) {
      throw new TypeError(
        'btoa: the string to be encoded contains characters outside of the Latin1 range',
      );
    }
    bytes.push(code);
  }

  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? '=' : ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : ALPHABET[b2 & 0x3f];
  }
  return out;
}

/** Spec-shaped `atob`: throws on invalid input, ignores padding/whitespace. */
export function decodeBase64(input: string): string {
  const clean = input.replace(/[\t\n\f\r ]/g, '').replace(/=+$/, '');
  let out = '';
  let buffer = 0;
  let bits = 0;

  for (let i = 0; i < clean.length; i += 1) {
    const index = ALPHABET.indexOf(clean[i] as string);
    if (index < 0) {
      throw new TypeError('atob: the string to be decoded is not correctly encoded');
    }
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  return out;
}
