/**
 * @cytale/web — the #151 palette registry (TS side).
 *
 * This module is the AUDIT's data: palettes.test.ts computes WCAG contrast
 * ratios from these values (the ticket's AA gate, enforced in CI) and
 * asserts tokens.css carries each value verbatim in its matching block, so
 * the CSS and this registry can never drift apart silently.
 *
 * The four looks (#151, owner direction 2026-09-24 — style names Harmony |
 * Pixel, each with Dark and Light):
 *   harmony/dark   — the shipped look, unchanged (audit-exempt: it predates
 *                    the gate; recorded here for completeness)
 *   harmony/light  — the house design language rendered light
 *   pixel/dark     — Starbase as a warm CRT terminal
 *   pixel/light    — the Starbase mockup verbatim (muted/status darkened
 *                    only where AA demands)
 */

export type PaletteToken =
  | 'background'
  | 'background-deep'
  | 'surface'
  | 'surface-emphasized'
  | 'surface-strong'
  | 'surface-selected'
  | 'surface-hover'
  | 'surface-hover-quiet'
  | 'text'
  | 'text-top'
  | 'text-muted'
  | 'border'
  | 'line-inset'
  | 'input'
  | 'input-border'
  | 'action'
  | 'action-hover'
  | 'on-action'
  | 'focus-ring'
  | 'highlight'
  | 'presence-online'
  | 'presence-idle'
  | 'presence-dnd'
  | 'presence-offline'
  | 'success'
  | 'warning'
  | 'on-warning'
  | 'danger';

export type Palette = Record<PaletteToken, string>;

export const HARMONY_LIGHT: Palette = {
  background: '#ffffff',
  'background-deep': '#e7e8ec',
  surface: '#f4f5f7',
  'surface-emphasized': '#fafbfc',
  'surface-strong': '#ffffff',
  'surface-selected': '#e4e6ea',
  'surface-hover': '#eceef0',
  'surface-hover-quiet': '#e9ebee',
  text: '#2e3338',
  'text-top': '#060607',
  'text-muted': '#5c5e66',
  border: '#dcdee2',
  'line-inset': '#e3e5e9',
  input: '#f4f5f7',
  'input-border': '#7e848e',
  action: '#4752c4',
  'action-hover': '#3c45a5',
  'on-action': '#ffffff',
  'focus-ring': '#5865f2',
  highlight: '#00808c',
  'presence-online': '#1a7f42',
  'presence-idle': '#8a6800',
  'presence-dnd': '#cc3437',
  'presence-offline': '#6a6e78',
  success: '#1a7f42',
  warning: '#8a6800',
  'on-warning': '#ffffff',
  danger: '#cc3437',
};

export const PIXEL_DARK: Palette = {
  background: '#171610',
  'background-deep': '#100f0b',
  surface: '#211f16',
  'surface-emphasized': '#1c1a12',
  'surface-strong': '#262218',
  'surface-selected': '#2c2a1e',
  'surface-hover': '#28261b',
  'surface-hover-quiet': '#232117',
  text: '#d8d2bd',
  'text-top': '#e9e3cf',
  'text-muted': '#97907a',
  border: '#3c392c',
  'line-inset': '#0e0d09',
  input: '#100f0b',
  'input-border': '#8f886f',
  action: '#57b06a',
  'action-hover': '#4a9d5c',
  'on-action': '#17160f',
  'focus-ring': '#63bd75',
  highlight: '#57b06a',
  'presence-online': '#63bd75',
  'presence-idle': '#cf943f',
  'presence-dnd': '#e06060',
  'presence-offline': '#97907a',
  success: '#63bd75',
  warning: '#cf943f',
  'on-warning': '#17160f',
  danger: '#e06060',
};

export const PIXEL_LIGHT: Palette = {
  background: '#d8d2bd',
  'background-deep': '#e9e3cf',
  surface: '#e9e3cf',
  'surface-emphasized': '#e0dac6',
  'surface-strong': '#e9e3cf',
  'surface-selected': '#d8d2bd',
  'surface-hover': '#ddd7c3',
  'surface-hover-quiet': '#e1dbc8',
  text: '#24211a',
  'text-top': '#1b1812',
  'text-muted': '#5d563f',
  border: '#a49b7e',
  'line-inset': '#cfc8ae',
  input: '#e9e3cf',
  'input-border': '#24211a',
  action: '#2e6b3a',
  'action-hover': '#265c34',
  'on-action': '#e9e3cf',
  'focus-ring': '#2e6b3a',
  highlight: '#2e6b3a',
  'presence-online': '#265c34',
  'presence-idle': '#7c4f15',
  'presence-dnd': '#8e2f2f',
  'presence-offline': '#5d563f',
  success: '#265c34',
  warning: '#7c4f15',
  'on-warning': '#e9e3cf',
  danger: '#8e2f2f',
};

/** The palettes the AA gate audits (harmony/dark predates the gate and is
 *  recorded nowhere here — changing IT remains a deliberate, reviewable act). */
export const AUDITED_PALETTES: Record<string, Palette> = {
  'harmony/light': HARMONY_LIGHT,
  'pixel/dark': PIXEL_DARK,
  'pixel/light': PIXEL_LIGHT,
};

/** Text tokens that must clear 4.5:1 on every surface they can sit on. */
export const TEXT_TOKENS: PaletteToken[] = ['text-top', 'text', 'text-muted'];
export const TEXT_SURFACES: PaletteToken[] = [
  'background',
  'background-deep',
  'surface',
  'surface-emphasized',
  'surface-strong',
  'surface-selected',
  'surface-hover',
  'surface-hover-quiet',
  'input',
];

/** Status colors that appear as inline text on the three canvases. */
export const STATUS_TEXT: PaletteToken[] = ['success', 'warning', 'danger'];
export const STATUS_SURFACES: PaletteToken[] = ['background', 'surface', 'surface-strong'];

/** Non-text UI (focus rings, input boundaries, presence dots): 3:1. */
export const NON_TEXT: PaletteToken[] = [
  'focus-ring',
  'input-border',
  'presence-online',
  'presence-idle',
  'presence-dnd',
  'presence-offline',
];
export const NON_TEXT_SURFACES: PaletteToken[] = ['background', 'surface', 'background-deep'];

/** Warning fills (the shell's offline bar): the on-warning text on the amber. */
export const WARNING_FILL: PaletteToken[] = ['warning'];

/** Buttons/active chips: the on-action text on its fill. */
export const ACTION_FILL: PaletteToken[] = ['action', 'action-hover', 'highlight'];
