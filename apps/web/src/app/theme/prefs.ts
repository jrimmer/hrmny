/**
 * @cytale/web — theme + style preferences (#151): the runtime half of the
 * two-axis theming.
 *
 * Two INDEPENDENT axes, each persisted per-browser (localStorage) and
 * applied as document attributes the token layer keys on:
 *
 *   data-theme="dark" | "light"   — the Mode axis (palette)
 *   data-style="harmony" | "pixel" — the Style axis (#151 v1: Harmony =
 *                                    the house chrome; Pixel = the fully
 *                                    implemented Starbase theme, its own
 *                                    palette AND chrome, per owner
 *                                    direction 2026-09-24)
 *
 * Defaults: dark + harmony (today's look, byte-for-byte). The Mode default
 * honors prefers-color-scheme when nothing is stored (the ticket's term);
 * boot-theme.js performs the same resolution BEFORE first paint — this
 * module is what the app uses after boot, so runtime switches never flash.
 */

export type ThemeMode = 'dark' | 'light';
export type ThemeStyle = 'harmony' | 'pixel';

export const THEME_KEY = 'cytale.theme';
export const STYLE_KEY = 'cytale.style';

export function readTheme(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === 'dark' || v === 'light') return v;
  } catch {
    // storage unavailable — fall through to the system preference
  }
  return typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
}

export function readStyle(): ThemeStyle {
  try {
    const v = localStorage.getItem(STYLE_KEY);
    if (v === 'harmony' || v === 'pixel') return v;
  } catch {
    // storage unavailable — harmony is the unconditional default
  }
  return 'harmony';
}

/** Apply one axis (idempotent; safe pre- or post-hydration). */
export function applyTheme(mode: ThemeMode): void {
  document.documentElement.setAttribute('data-theme', mode);
}

export function applyStyle(style: ThemeStyle): void {
  document.documentElement.setAttribute('data-style', style);
}

export function persistTheme(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    // the choice still applies for this session; it just won't persist
  }
}

export function persistStyle(style: ThemeStyle): void {
  try {
    localStorage.setItem(STYLE_KEY, style);
  } catch {
    // as above
  }
}
