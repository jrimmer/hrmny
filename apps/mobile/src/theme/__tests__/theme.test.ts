/**
 * Theme surface tests (plan 004 M3, R14): the object later units consume is
 * dark-only and complete, so a family that disappears fails here instead of
 * rendering as `undefined` on a screen. Exact values are pinned against
 * tokens.css by `parity.test.ts`; this file pins the shape.
 */
import { colors, fontSizes, radii, spacing, theme } from '..';

describe('mobile theme surface', () => {
  it('is dark-only, matching web (R14)', () => {
    expect(theme.scheme).toBe('dark');
  });

  it('re-exports each token family through the theme object', () => {
    expect(theme.colors).toBe(colors);
    expect(theme.spacing).toBe(spacing);
    expect(theme.radii).toBe(radii);
    expect(theme.fontSizes).toBe(fontSizes);
  });

  it('has an RN-parseable value for every color token', () => {
    const entries = Object.entries(colors);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.filter(([, value]) => !/^(#[0-9a-f]{6}|rgba?\([\d., ]+\))$/.test(value))).toEqual(
      [],
    );
  });

  it('carries the families a dark surface needs', () => {
    expect(colors.background).toBeDefined();
    expect(colors.surface).toBeDefined();
    expect(colors.text).toBeDefined();
    expect(colors.textMuted).toBeDefined();
    expect(colors.border).toBeDefined();
    expect(colors.accent).toBeDefined();
    expect(colors.danger).toBeDefined();
    expect(colors.scrim).toBeDefined();
  });

  it('exposes ascending numeric scales for spacing, radii, and type', () => {
    for (const scale of [spacing, fontSizes]) {
      const values = Object.values(scale);
      expect([...values].sort((a, b) => a - b)).toEqual(values);
      expect(values.every((value) => value >= 0)).toBe(true);
    }
    for (const value of Object.values(radii)) {
      expect(value).toBeGreaterThan(0);
    }
  });
});
