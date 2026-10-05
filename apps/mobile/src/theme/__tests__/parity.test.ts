/**
 * Token parity test (plan 004 M3) — "one token source, two renderers".
 *
 * The web app's token source of truth is
 * `apps/web/src/app/theme/tokens.css` (CSS custom properties consumed through
 * Tailwind utilities). React Native cannot read custom properties, so
 * `src/theme/tokens.ts` restates the dark-default values as typed objects.
 * This test parses the CSS at run time and fails on any drift: change the CSS
 * and the mirror must follow, change the mirror and it must match the CSS.
 */
import { colors, fontSizes, radii, spacing } from '../tokens';
import { readWebTokensCss } from './readWebTokens';

const css = readWebTokensCss().replace(/\/\*[\s\S]*?\*\//g, '');

/** Text of the first `{ ... }` block after `header`. */
function blockOf(header: string): string {
  const headerAt = css.indexOf(header);
  if (headerAt === -1) throw new Error(`tokens.css: no "${header}" block`);
  const open = css.indexOf('{', headerAt);
  const close = css.indexOf('}', open);
  if (open === -1 || close === -1) {
    throw new Error(`tokens.css: unterminated "${header}" block`);
  }
  return css.slice(open + 1, close);
}

/** `--name: value;` declarations of a block, keyed by the variable name. */
function declarations(block: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of block.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
    found.set(match[1], match[2].trim());
  }
  return found;
}

/** `--name: 12px;` → 12; throws when the token is absent or not a px length. */
function px(block: Map<string, string>, name: string): number {
  const value = block.get(name);
  if (value === undefined) throw new Error(`tokens.css: missing ${name}`);
  const match = value.match(/^(\d+)px$/);
  if (match === null) throw new Error(`tokens.css: ${name} is not a px value: ${value}`);
  return Number(match[1]);
}

// The dark-default values live in the `:root, :root[data-theme='dark']` block;
// the `@theme` block carries the Tailwind-facing type/radius scales.
const darkTokens = declarations(blockOf(":root[data-theme='dark']"));
const themeTokens = declarations(blockOf('@theme'));

/**
 * CSS variable → RN theme key. The test asserts this map covers the CSS
 * exhaustively in both directions, so adding a color to either side without
 * the other fails.
 */
const COLOR_VARS: Record<string, keyof typeof colors> = {
  '--tk-background': 'background',
  '--tk-background-deep': 'backgroundDeep',
  '--tk-surface': 'surface',
  '--tk-surface-emphasized': 'surfaceEmphasized',
  '--tk-surface-strong': 'surfaceStrong',
  '--tk-surface-selected': 'surfaceSelected',
  '--tk-surface-hover': 'surfaceHover',
  '--tk-surface-hover-quiet': 'surfaceHoverQuiet',
  '--tk-line-inset': 'lineInset',
  '--tk-text': 'text',
  '--tk-text-top': 'textPrimary',
  '--tk-text-muted': 'textMuted',
  '--tk-border': 'border',
  '--tk-input': 'input',
  '--tk-input-border': 'inputBorder',
  '--tk-action': 'accent',
  '--tk-action-hover': 'accentHover',
  '--tk-on-action': 'onAccent',
  '--tk-focus-ring': 'focusRing',
  '--tk-highlight': 'highlight',
  '--tk-presence-online': 'presenceOnline',
  '--tk-presence-idle': 'presenceIdle',
  '--tk-presence-dnd': 'presenceDnd',
  '--tk-presence-offline': 'presenceOffline',
  '--tk-success': 'success',
  '--tk-warning': 'warning',
  '--tk-on-warning': 'onWarning',
  '--tk-danger': 'danger',
  '--tk-scrim': 'scrim',
  '--tk-shade': 'shade',
};

/**
 * CSS variable → RN theme key for the numeric scales. Same contract as
 * COLOR_VARS: each map is asserted against the CSS variable set and the RN
 * key set exhaustively in both directions, so a `--radius-*` or `--text-*`
 * token added to either side without the other fails here.
 */
const RADIUS_VARS: Record<string, keyof typeof radii> = {
  '--radius-sm': 'sm',
  '--radius-md': 'md',
  '--radius-lg': 'lg',
  '--radius-full': 'full',
};

const TEXT_VARS: Record<string, keyof typeof fontSizes> = {
  '--text-xs': 'xs',
  '--text-sm': 'sm',
  '--text-md': 'md',
  '--text-lg': 'lg',
  '--text-xl': 'xl',
};

/**
 * React Native's color parser predates CSS Color 4, so the theme stores
 * `rgba(0, 0, 0, 0.6)` where the CSS writes `rgb(0 0 0 / 0.6)`. Normalize the
 * CSS side; every token but scrim and shade is a literal hex.
 */
function normalizeCssColor(value: string): string {
  const modern = value.match(/^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\/\s*([\d.]+)\s*\)$/);
  if (modern === null) return value;
  const [, r, g, b, a] = modern;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

describe('design token parity with apps/web tokens.css', () => {
  it('reads the dark-default block the RN theme mirrors', () => {
    expect(darkTokens.get('--tk-background')).toBe('#131416');
    expect(darkTokens.get('--tk-action')).toBe('#5865f2');
    expect(themeTokens.get('--radius-md')).toBe('8px');
  });

  it('maps every CSS color token to exactly one theme key', () => {
    const cssColorVars = [...darkTokens.keys()]
      .filter((name) => name.startsWith('--tk-'))
      .sort();

    expect(cssColorVars).toEqual(Object.keys(COLOR_VARS).sort());
    expect(Object.values(COLOR_VARS).sort()).toEqual(Object.keys(colors).sort());
  });

  it('maps every CSS radius token to exactly one theme key', () => {
    const cssRadiusVars = [...themeTokens.keys()]
      .filter((name) => name.startsWith('--radius-'))
      .sort();

    expect(cssRadiusVars).toEqual(Object.keys(RADIUS_VARS).sort());
    expect(Object.values(RADIUS_VARS).sort()).toEqual(Object.keys(radii).sort());
  });

  it('maps every CSS type token to exactly one theme key', () => {
    const cssTextVars = [...themeTokens.keys()]
      .filter((name) => name.startsWith('--text-'))
      .sort();

    expect(cssTextVars).toEqual(Object.keys(TEXT_VARS).sort());
    expect(Object.values(TEXT_VARS).sort()).toEqual(Object.keys(fontSizes).sort());
  });

  it('mirrors every color token with the exact CSS value', () => {
    for (const [name, key] of Object.entries(COLOR_VARS)) {
      const cssValue = darkTokens.get(name);
      expect(cssValue).toBeDefined();
      expect(colors[key]).toBe(normalizeCssColor(cssValue as string));
    }
  });

  it('mirrors the radius scale', () => {
    expect(radii).toEqual({
      sm: px(themeTokens, '--radius-sm'),
      md: px(themeTokens, '--radius-md'),
      lg: px(themeTokens, '--radius-lg'),
      full: px(themeTokens, '--radius-full'),
    });
  });

  it('mirrors the type scale', () => {
    expect(fontSizes).toEqual({
      xs: px(themeTokens, '--text-xs'),
      sm: px(themeTokens, '--text-sm'),
      md: px(themeTokens, '--text-md'),
      lg: px(themeTokens, '--text-lg'),
      xl: px(themeTokens, '--text-xl'),
    });
  });

  it('pins the Tailwind v4 spacing base the web imports', () => {
    // Spacing has no CSS custom property to parse: the web consumes Tailwind
    // v4's default `--spacing: 0.25rem` ramp, which tokens.css pulls in with
    // this import. That base is the unguarded source — tokens.css never states
    // the 4px step — so the ramp is pinned exactly: every key, every value.
    expect(css).toContain('@import "tailwindcss"');
    expect(spacing).toEqual({
      none: 0,
      xs: 4,
      sm: 8,
      md: 12,
      lg: 16,
      xl: 24,
      xxl: 32,
      xxxl: 48,
    });
  });
});
