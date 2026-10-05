/**
 * @cytale/web — default-avatar identity tiles.
 *
 * One visual language for every avatar that lacks an uploaded image:
 * a deterministic hue hashed from the member's id and up to two initials,
 * white on the tinted circle — at AA contrast on every hue (`avatarTileColor`). Shared by the message list, the people
 * directory, and the sidebar user panel so a member reads as the same
 * color everywhere.
 */

/** Deterministic pastel-tile hue from a snowflake (no deps). */
export function avatarHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

/** A letter or digit — the characters an initial can actually be taken from. */
const INITIAL_CHAR = /[\p{L}\p{N}]/u;

/**
 * One uppercase code point — the tile's whole budget per initial. Case
 * mapping can EXPAND a character ('ß'→'SS', 'ﬃ'→'FFI'), which broke the
 * two-initial contract and overflowed the fixed tile (PR #132 review,
 * 2026-09-18); the first code point of the mapping is the initial.
 */
function onePoint(ch: string): string {
  const up = ch.toUpperCase();
  for (const point of up) return point;
  return '';
}

/** The first letter or digit a word offers, uppercased — '' when it has none. */
function initialOf(word: string): string {
  for (const ch of word) {
    if (INITIAL_CHAR.test(ch)) return onePoint(ch);
  }
  return '';
}

/**
 * Up to two initials for the fallback tile.
 *
 * Rule (user direction 2026-09-17): *first and last name initials where the
 * name has them, otherwise the first two letters of the name.*
 *
 * - `Mia Helper` → `MH`, `Mary Jane Watson` → `MW` (last means last, middle
 *   names do not contribute), `jordan` → `JR`.
 * - Words that offer no letter or digit are not name parts: `🐍 max hermes` →
 *   `MH`, `@jason` → `JA`. A display name is user-controlled, and a leading
 *   emoji or sigil used to land in the tile as half of whatever character
 *   followed it — `slice(0, 2)` cut through surrogate pairs.
 * - Counted in code points, not UTF-16 units, for the same reason.
 * - A single name part yields its first two letters (`ada` → `AD`), one letter
 *   yields one (`a` → `A`).
 * - No usable part yields `''`; the caller owns that case (HomeSidebar
 *   substitutes `'Unknown'` rather than letting an empty tile paint a bare
 *   circle).
 *
 * Deliberately whitespace-only splitting: `mary-jane` is one word here and
 * renders `MA`. Refining that means deciding about hyphenated surnames and
 * `Ada (OpenClaw)`-style tags, which is a product call, not a helper detail.
 */
export function avatarInitials(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .map((word) => ({ word, initial: initialOf(word) }))
    .filter((part) => part.initial !== '');

  if (parts.length >= 2) {
    return parts[0]!.initial + parts[parts.length - 1]!.initial;
  }
  if (parts.length === 1) {
    const letters: string[] = [];
    for (const ch of parts[0]!.word) {
      if (INITIAL_CHAR.test(ch)) letters.push(onePoint(ch));
      if (letters.length === 2) break;
    }
    return letters.join('');
  }
  return '';
}

/**
 * The tile palette: one saturation, and the lightest lightness up to 42% at
 * which WHITE initials clear WCAG AA (4.5:1) on that hue.
 *
 * A flat `hsl(h 45% 42%)` failed AA across the warm and green hues — white
 * on the yellow tile measured 2.94:1, on orange ~3.35:1 (axe, 2026-09-28) —
 * because a hue's luminance at one HSL lightness varies ~3x around the wheel.
 * So the lightness is per hue: the blues, purples, reds and pinks keep 42%
 * (they already pass — 191 of the 360 hues are unchanged), and the yellows,
 * greens and cyans step down until they pass too (yellow lands at 32.5%). The
 * target carries a small margin (4.6:1) over AA so browser colour rounding
 * can never tip a tile under. The contrast is measured on the emitted 8-bit
 * colour, the value the browser actually paints.
 */
const TILE_SATURATION = 0.45;
const TILE_MAX_LIGHTNESS = 42;
const TILE_LIGHTNESS_STEP = 0.5;
const TILE_TARGET_CONTRAST = 4.6;

/** hsl (h in degrees, s and l in 0..1) → 8-bit sRGB. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

/** WCAG 2.x relative luminance of an 8-bit sRGB colour. */
function relativeLuminance([r, g, b]: [number, number, number]): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio of white text on an 8-bit sRGB colour. */
export function contrastWithWhite(rgb: [number, number, number]): number {
  return 1.05 / (relativeLuminance(rgb) + 0.05);
}

/** `#rrggbb` → 8-bit sRGB. */
export function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const tileByHue = new Map<number, string>();

/** The tile colour for a hue (0–359), as `#rrggbb` — see the palette note above. */
export function avatarTileColor(hue: number): string {
  const h = ((Math.round(hue) % 360) + 360) % 360;
  const cached = tileByHue.get(h);
  if (cached !== undefined) return cached;
  let rgb = hslToRgb(h, TILE_SATURATION, TILE_MAX_LIGHTNESS / 100);
  for (
    let l = TILE_MAX_LIGHTNESS;
    l > 0 && contrastWithWhite(rgb) < TILE_TARGET_CONTRAST;
    l -= TILE_LIGHTNESS_STEP
  ) {
    rgb = hslToRgb(h, TILE_SATURATION, (l - TILE_LIGHTNESS_STEP) / 100);
  }
  const hex = `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  tileByHue.set(h, hex);
  return hex;
}

/** Inline style for the tile background (kept identical across surfaces). */
export function avatarTileStyle(id: string): { background: string } {
  return { background: avatarTileColor(avatarHue(id)) };
}
