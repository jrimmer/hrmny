/**
 * Mobile theme surface (plan 004 M3) — what later units import.
 *
 * `theme` is the single object screens consume; the raw token objects are
 * re-exported for code that wants one family (`colors.danger`) without
 * threading the whole theme. The values mirror
 * `apps/web/src/app/theme/tokens.css` and are pinned by
 * `__tests__/parity.test.ts`.
 */
import { colors, fontSizes, radii, spacing } from './tokens';

/**
 * The app theme. `scheme` is a literal `'dark'`: v1 is dark-only, matching
 * web (R14), so there is no theme switching to model.
 */
export interface Theme {
  readonly scheme: 'dark';
  readonly colors: typeof colors;
  readonly spacing: typeof spacing;
  readonly radii: typeof radii;
  readonly fontSizes: typeof fontSizes;
}

export const theme: Theme = {
  scheme: 'dark',
  colors,
  spacing,
  radii,
  fontSizes,
};

export { colors, fontSizes, radii, spacing };
export type { ColorToken, FontSizeToken, RadiusToken, SpacingToken } from './tokens';
