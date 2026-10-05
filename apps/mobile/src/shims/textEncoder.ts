/**
 * Minimal UTF-8 `TextEncoder` for runtimes that lack it (Hermes has no
 * `TextEncoder`; Expo's WinterCG layer installs `TextDecoder` and the stream
 * variants but not the plain encoder). Only `encode` is implemented because
 * that is the whole surface the shared packages use — `@cytale/gateway-client`
 * measures UTF-8 byte length for frame-size accounting.
 */
export class Utf8TextEncoder {
  readonly encoding = 'utf-8';

  encode(input = ''): Uint8Array {
    const bytes: number[] = [];

    for (let i = 0; i < input.length; i += 1) {
      let code = input.charCodeAt(i);

      // Fold surrogate pairs into a single code point.
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
        const next = input.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          code = ((code - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
          i += 1;
        }
      }

      if (code < 0x80) {
        bytes.push(code);
      } else if (code < 0x800) {
        bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      } else if (code < 0x10000) {
        bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      } else {
        bytes.push(
          0xf0 | (code >> 18),
          0x80 | ((code >> 12) & 0x3f),
          0x80 | ((code >> 6) & 0x3f),
          0x80 | (code & 0x3f),
        );
      }
    }

    return new Uint8Array(bytes);
  }
}
