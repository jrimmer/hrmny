/**
 * @cytale/web — #151's AA gate, enforced in CI.
 *
 * Two assertions per palette:
 *   1. LOCKSTEP — every value in palettes.ts appears verbatim inside its
 *      matching tokens.css block (drift between the registry and the CSS
 *      fails the build, not a user's eyes).
 *   2. CONTRAST — WCAG 2.1 ratios computed from the registry clear the
 *      ticket's bar: 4.5:1 for text pairs, 3:1 for non-text UI.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  ACTION_FILL,
  AUDITED_PALETTES,
  NON_TEXT,
  NON_TEXT_SURFACES,
  STATUS_SURFACES,
  STATUS_TEXT,
  TEXT_SURFACES,
  TEXT_TOKENS,
  WARNING_FILL,
  type Palette,
  type PaletteToken,
} from '../palettes.js';

/** The CSS block each palette owns in tokens.css (substring anchors). */
const CSS_BLOCK: Record<string, string> = {
  'harmony/light': ':root[data-theme=\'light\']',
  'pixel/dark': ':root[data-style=\'pixel\'][data-theme=\'dark\']',
  'pixel/light': ':root[data-style=\'pixel\'][data-theme=\'light\']',
};

// vitest's CSS pipeline swallows `?raw` imports (empty string) — read the
// file directly; tests run in Node, so fs is available.
const tokensCss = readFileSync('src/app/theme/tokens.css', 'utf8');

function blockOf(css: string, anchor: string): string {
  const start = css.indexOf(anchor);
  if (start === -1) throw new Error(`tokens.css block not found: ${anchor}`);
  const end = css.indexOf('\n}', start);
  return css.slice(start, end);
}

function srgb(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const channels = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  const r = srgb(channels[0]!);
  const g = srgb(channels[1]!);
  const b = srgb(channels[2]!);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const ls = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (ls[0]! + 0.05) / (ls[1]! + 0.05);
}

describe('#151 palette lockstep (tokens.css ↔ palettes.ts)', () => {
  for (const [name, palette] of Object.entries(AUDITED_PALETTES)) {
    it(`${name}: every value sits verbatim in its CSS block`, () => {
      const block = blockOf(tokensCss, CSS_BLOCK[name]!);
      for (const [token, value] of Object.entries(palette)) {
        expect(
          block,
          `--tk-${token} in ${name}`,
        ).toContain(`--tk-${token}: ${value};`);
      }
    });
  }
});

describe('#151 AA gate (WCAG 2.1)', () => {
  for (const [name, palette] of Object.entries(AUDITED_PALETTES)) {
    const pair = (fg: PaletteToken, bg: PaletteToken) =>
      contrast(palette[fg], palette[bg]);

    it(`${name}: text tokens ≥ 4.5:1 on every surface`, () => {
      const failures: string[] = [];
      for (const t of TEXT_TOKENS) {
        for (const s of TEXT_SURFACES) {
          const r = pair(t, s);
          if (r < 4.5) failures.push(`${t} on ${s}: ${r.toFixed(2)}`);
        }
      }
      expect(failures, failures.join('; ')).toEqual([]);
    });

    it(`${name}: status colors as text ≥ 4.5:1 on the canvases`, () => {
      const failures: string[] = [];
      for (const t of STATUS_TEXT) {
        for (const s of STATUS_SURFACES) {
          const r = pair(t, s);
          if (r < 4.5) failures.push(`${t} on ${s}: ${r.toFixed(2)}`);
        }
      }
      expect(failures, failures.join('; ')).toEqual([]);
    });

    it(`${name}: non-text UI ≥ 3:1 (focus ring, field boundaries, presence dots)`, () => {
      const failures: string[] = [];
      for (const t of NON_TEXT) {
        for (const s of NON_TEXT_SURFACES) {
          const r = pair(t, s);
          if (r < 3) failures.push(`${t} on ${s}: ${r.toFixed(2)}`);
        }
      }
      expect(failures, failures.join('; ')).toEqual([]);
    });

    it(`${name}: on-warning text ≥ 4.5:1 on the warning fill (offline bar)`, () => {
      const failures: string[] = [];
      for (const fill of WARNING_FILL) {
        const r = contrast(palette['on-warning'], palette[fill]);
        if (r < 4.5) failures.push(`on-warning on ${fill}: ${r.toFixed(2)}`);
      }
      expect(failures, failures.join('; ')).toEqual([]);
    });

    it(`${name}: on-action text ≥ 4.5:1 on every action fill`, () => {
      const failures: string[] = [];
      for (const fill of ACTION_FILL) {
        const r = contrast(palette['on-action'], palette[fill]);
        if (r < 4.5) failures.push(`on-action on ${fill}: ${r.toFixed(2)}`);
      }
      expect(failures, failures.join('; ')).toEqual([]);
    });
  }
});

/** Compile-time shape guard: the registry stays a complete palette. */
describe('palette registry shape', () => {
  it('every audited palette covers every token', () => {
    for (const palette of Object.values(AUDITED_PALETTES)) {
      expect(Object.keys(palette).length).toBe(28);
    }
  });
});

// Keep the Palette type referenced for consumers importing the test's
// contrast helper.
export type { Palette };
