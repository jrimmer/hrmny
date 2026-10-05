/**
 * avatarInitials — the identity tile's initials rule.
 *
 * "First and last name initials where the name has them, otherwise the first
 * two letters of the name" (user direction 2026-09-17). These cases pin the
 * rule in one place: every avatar surface (message list, people directory,
 * sidebar, call tiles) renders through this helper, so a divergence here is a
 * divergence everywhere.
 */
import { describe, expect, it } from 'vitest';

import { avatarHue, avatarInitials, avatarTileColor, avatarTileStyle, contrastWithWhite, hexToRgb } from '../avatar.js';

describe('avatarInitials', () => {
  it('uses the first and last name initials when the name has two parts', () => {
    expect(avatarInitials('Mia Helper')).toBe('MH');
    expect(avatarInitials('jordan rowan')).toBe('JR');
  });

  it('drops middle parts — last means last', () => {
    expect(avatarInitials('Mary Jane Watson')).toBe('MW');
  });

  it('falls back to the first two letters of a single-word name', () => {
    expect(avatarInitials('jordan')).toBe('JO');
    expect(avatarInitials('ada')).toBe('AD');
    expect(avatarInitials('a')).toBe('A');
  });

  it('collapses whitespace instead of counting it as a name part', () => {
    expect(avatarInitials('  max   hermes  ')).toBe('MH');
    expect(avatarInitials('\tada\nlovelace')).toBe('AL');
  });

  it('filters a trailing unusable part — last means last AFTER filtering (PR #132 review)', () => {
    expect(avatarInitials('max hermes 🐍')).toBe('MH');
  });

  it('a name that filters down to ONE part takes the single-word branch', () => {
    expect(avatarInitials('🐍 max')).toBe('MA');
  });

  it('digits alone are a usable name', () => {
    expect(avatarInitials('42')).toBe('42');
  });

  it('expanding uppercase mappings clamp to one code point (PR #132 review)', () => {
    // 'ß'.toUpperCase() is 'SS' and 'ﬃ' is 'FFI' — the tile's budget is ONE
    // character per initial.
    expect(avatarInitials('ß x')).toBe('SX');
    expect(avatarInitials('straße')).toBe('ST');
  });

  it('ignores parts that offer no letter or digit', () => {
    // A display name is user-controlled: a leading emoji or sigil must not
    // become the tile's first character.
    expect(avatarInitials('@jason')).toBe('JA');
    expect(avatarInitials('"mia" helper')).toBe('MH');
  });

  it('never splits a surrogate pair (emoji-prefixed display name)', () => {
    // `slice(0, 2)` cut "🐍 max hermes" mid-pair and rendered half a character.
    expect(avatarInitials('🐍 max hermes')).toBe('MH');
    expect(avatarInitials('🐍 hermes')).toBe('HE');
  });

  it('returns nothing when no part can yield an initial', () => {
    expect(avatarInitials('')).toBe('');
    expect(avatarInitials('   ')).toBe('');
    expect(avatarInitials('🐍')).toBe('');
  });

  it('keeps accented and numeric parts intact', () => {
    expect(avatarInitials('Élodie Durand')).toBe('ÉD');
    expect(avatarInitials('123 456')).toBe('14');
  });

  it('treats a hyphenated single word as one part (documented limitation)', () => {
    expect(avatarInitials('mary-jane')).toBe('MA');
  });
});

describe('avatarTileColor — white initials meet WCAG AA on every hue', () => {
  it('clears 4.5:1 against white for all 360 hues', () => {
    const failing: string[] = [];
    let min = Infinity;
    for (let hue = 0; hue < 360; hue += 1) {
      const color = avatarTileColor(hue);
      expect(color).toMatch(/^#[0-9a-f]{6}$/);
      const ratio = contrastWithWhite(hexToRgb(color));
      min = Math.min(min, ratio);
      if (ratio < 4.5) failing.push(`${hue}: ${color} ${ratio.toFixed(2)}:1`);
    }
    expect(failing).toEqual([]);
    expect(min).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the old tile where it already passed (blue) and darkens only where it did not (yellow)', () => {
    // hsl(240 45% 42%) — unchanged.
    expect(avatarTileColor(240)).toBe('#3b3b9b');
    // hsl(60 45% 42%) was 2.94:1; the yellow tile is darker, still a yellow.
    const yellow = hexToRgb(avatarTileColor(60));
    expect(yellow[0]).toBe(yellow[1]);
    expect(yellow[2]).toBeLessThan(yellow[0]);
    expect(contrastWithWhite(yellow)).toBeGreaterThanOrEqual(4.5);
  });

  it('computes the WCAG ratio correctly (white on black is 21:1, white on white 1:1)', () => {
    expect(contrastWithWhite([0, 0, 0])).toBeCloseTo(21, 5);
    expect(contrastWithWhite([255, 255, 255])).toBeCloseTo(1, 5);
  });

  it('every surface paints the same tile for an id (the hue hash, then the palette)', () => {
    expect(avatarTileStyle('7000000000000002')).toEqual({ background: avatarTileColor(avatarHue('7000000000000002')) });
  });
});
