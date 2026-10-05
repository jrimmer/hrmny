/**
 * Design tokens (plan 004 M3) — the React Native half of "one token source,
 * two renderers".
 *
 * Source of truth: `apps/web/src/app/theme/tokens.css`, the CSS custom
 * properties the web app's Tailwind v4 bridge consumes. CSS custom properties
 * cannot cross to React Native, so this module restates the dark-default
 * values as typed objects; `__tests__/parity.test.ts` parses that CSS and
 * fails if any mirrored value drifts, which keeps the CSS authoritative.
 *
 * Dark-only in v1, matching web (R14): the web's light block is an empty
 * remap, so there is nothing else to mirror yet.
 */

/**
 * Semantic colors — every `--tk-*` value in the dark-default block, keyed by
 * the RN-facing name. `scrim` and `shade` are written in the comma syntax RN's color
 * parser understands (the CSS uses CSS Color 4 `rgb(r g b / a)`).
 */
export const colors = {
  background: '#131416',
  backgroundDeep: '#0e0e11',
  surface: '#2e2e34',
  surfaceEmphasized: '#1a1a1e',
  surfaceStrong: '#070709',
  surfaceSelected: '#35373c',
  surfaceHover: '#2e3035',
  surfaceHoverQuiet: '#24262a',
  lineInset: '#111216',
  text: '#dbdee1',
  textPrimary: '#f2f3f5',
  textMuted: '#949ba4',
  border: '#2e2e34',
  input: '#070709',
  inputBorder: '#5c5e66',
  accent: '#5865f2',
  accentHover: '#4752c4',
  onAccent: '#ffffff',
  focusRing: '#8ea1ff',
  highlight: '#00808c',
  presenceOnline: '#23a55a',
  presenceIdle: '#f0b232',
  presenceDnd: '#f23f43',
  presenceOffline: '#80848e',
  success: '#23a55a',
  warning: '#f0b232',
  // Ink on the warning fill (the shell's offline bar) — dark on amber.
  onWarning: '#131416',
  danger: '#f23f43',
  scrim: 'rgba(0, 0, 0, 0.6)',
  // The shadow an edge-docked surface (bottom sheet, side drawer) casts away
  // from its edge — per-theme on the web, the dark value here.
  shade: 'rgba(0, 0, 0, 0.35)',
} as const;

/**
 * Spacing ramp in px — whole multiples of Tailwind v4's default
 * `--spacing: 0.25rem` base (4px), which the web's `@import "tailwindcss"`
 * supplies. The comment on each entry is the Tailwind utility step it equals,
 * so web markup ports mechanically (`p-4` → `spacing.lg`). Hairlines are not
 * spacing; RN code uses `StyleSheet.hairlineWidth` for those.
 */
export const spacing = {
  none: 0, // p-0
  xs: 4, // p-1
  sm: 8, // p-2
  md: 12, // p-3
  lg: 16, // p-4
  xl: 24, // p-6
  xxl: 32, // p-8
  xxxl: 48, // p-12
} as const;

/** Corner radii in px — `--radius-*` from the `@theme` block. */
export const radii = {
  sm: 4,
  md: 8,
  lg: 16,
  full: 9999,
} as const;

/** Type ramp in px — `--text-*` from the `@theme` block. */
export const fontSizes = {
  xs: 12, // metadata, timestamps
  sm: 13, // secondary
  md: 14, // section labels
  lg: 16, // body
  xl: 18, // headers
} as const;

export type ColorToken = keyof typeof colors;
export type SpacingToken = keyof typeof spacing;
export type RadiusToken = keyof typeof radii;
export type FontSizeToken = keyof typeof fontSizes;
