/**
 * @cytale/tui — the two-column shell's geometry, its modes, and its focus model
 * (U6; R15, R28).
 *
 * Everything here is arithmetic and vocabulary, so it can be reasoned about and
 * tested without a terminal. Three decisions are stated rather than implied,
 * because each one is a number or a rule a later unit would otherwise invent
 * again:
 *
 *   1. **The split.** Column one takes `DEFAULT_COLUMN_RATIO` of the width
 *      (navigation:content = 1:2), then each column is held to its minimum
 *      (`MIN_NAVIGATION_WIDTH` / `MIN_CONTENT_WIDTH`) with one separator column
 *      between them. At `MIN_TWO_COLUMN_WIDTH` the minimums win and the ratio is
 *      already spent; below it there is no split to make.
 *   2. **The sub-minimum policy.** Below the minimum the shell renders ONE
 *      column at full width — the focused one — plus a notice naming the size
 *      two columns need and the key that switches which column is shown. A
 *      clamped split would silently destroy a column's content, and an
 *      unclamped one would wrap a column into the other's cells.
 *   3. **The focus model.** Keystrokes belong to exactly one surface: column one
 *      (`navigation`), column two (`content`), or the composer. The focused
 *      column is marked by a glyph as well as by colour (`FOCUS_MARKER` versus
 *      `UNFOCUSED_MARKER`), so a monochrome terminal and a colour-blind member
 *      both read it — the same rule the connection banner's phase markers
 *      follow.
 *
 * What is NOT here: text measurement. Every server-supplied string is rendered
 * inert by `sanitizeTerminalText` at the point it is projected (see
 * `NavigationColumn.tsx` / `ContentColumn.tsx`), and clipping to a column's
 * cells is Ink's job (`<Box width>` + `<Text wrap="truncate">`) rather than a
 * second width implementation living here.
 */
import { DEFAULT_WIDTH, sanitizeTerminalText } from '../format/markdown.js';

/** Which list column one is showing: the workspace's channels, or all DMs. */
export type ShellMode = 'channels' | 'dms';

/**
 * The surface that owns keystrokes. `composer` is not a column — it lives at
 * the bottom of column two — but it is a surface for input routing, because a
 * keystroke that belongs to the composer must never also be a navigation key
 * (`keys.ts`'s `resolveAction` is where that is decided).
 */
export type FocusSurface = 'navigation' | 'content' | 'composer';

/** The ratio the split starts from, before the column minimums apply. */
export const DEFAULT_COLUMN_RATIO = { navigation: 1, content: 2 } as const;

export const MIN_NAVIGATION_WIDTH = 20;
export const MIN_CONTENT_WIDTH = 24;
/** One column of vertical rule between the two. */
export const COLUMN_SEPARATOR_WIDTH = 1;
/** The rule itself; exported so a test can split a rendered line by column. */
export const COLUMN_SEPARATOR = '│';
/** The narrowest and shortest terminal the two-column shell draws in. */
export const MIN_TWO_COLUMN_WIDTH =
  MIN_NAVIGATION_WIDTH + COLUMN_SEPARATOR_WIDTH + MIN_CONTENT_WIDTH;
export const MIN_TWO_COLUMN_HEIGHT = 8;

/**
 * Rows the shell spends outside column two's message body: the connection
 * banner (two or three lines, with its detail), column two's own header, the
 * composer line, and the footer. The budget is deliberately conservative — it
 * is what the viewport pages by, so it must never exceed the rows that exist.
 */
export const CHROME_ROWS = 5;

export const DEFAULT_HEIGHT = 24;
export const DEFAULT_SIZE = { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT } as const;

/** The shared focus/selection glyphs (also used for the message-row cursor). */
export const FOCUS_MARKER = '▸';
export const UNFOCUSED_MARKER = '·';

export const MODE_LABELS: Record<ShellMode, string> = {
  channels: 'Channels',
  dms: 'Direct Messages',
};

export interface ColumnSize {
  readonly width: number;
  readonly height: number;
}

export interface TwoColumnLayout {
  readonly kind: 'two-column';
  readonly navigationWidth: number;
  readonly contentWidth: number;
  readonly totalWidth: number;
  readonly height: number;
}

export interface SingleColumnLayout {
  readonly kind: 'single-column';
  readonly reason: 'narrow' | 'short';
  readonly width: number;
  readonly height: number;
  /** What the member can do about it, in one line. */
  readonly notice: string;
}

export type ColumnLayout = TwoColumnLayout | SingleColumnLayout;

/**
 * A size the shell can actually draw in. `undefined` means "not measured" and
 * takes the default; anything else that is not a positive finite number is
 * treated as unusable (0), which lands on the sub-minimum policy — a shell that
 * cannot measure itself must not guess a layout.
 */
function usable(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

const narrowNotice = (width: number): string =>
  `Terminal is ${width} columns wide; two columns need ${MIN_TWO_COLUMN_WIDTH}. ` +
  'Showing one column — press Tab to switch between the navigation and message columns.';

const shortNotice = (height: number): string =>
  `Terminal is ${height} rows tall; the two-column shell needs ${MIN_TWO_COLUMN_HEIGHT}. ` +
  'Resize the window to continue.';

/**
 * The layout for a terminal size. The ratio sets the intent; the minimums and
 * the separator decide whether it fits at all.
 */
export function layoutFor(size: Partial<ColumnSize> = {}): ColumnLayout {
  const width = usable(size.width, DEFAULT_SIZE.width);
  const height = usable(size.height, DEFAULT_SIZE.height);

  if (width < MIN_TWO_COLUMN_WIDTH) {
    return { kind: 'single-column', reason: 'narrow', width, height, notice: narrowNotice(width) };
  }
  if (height < MIN_TWO_COLUMN_HEIGHT) {
    return { kind: 'single-column', reason: 'short', width, height, notice: shortNotice(height) };
  }

  const parts = DEFAULT_COLUMN_RATIO.navigation + DEFAULT_COLUMN_RATIO.content;
  const share = (width * DEFAULT_COLUMN_RATIO.navigation) / parts;
  const navigationWidth = Math.min(
    Math.max(Math.round(share), MIN_NAVIGATION_WIDTH),
    width - COLUMN_SEPARATOR_WIDTH - MIN_CONTENT_WIDTH,
  );
  return {
    kind: 'two-column',
    navigationWidth,
    contentWidth: width - navigationWidth - COLUMN_SEPARATOR_WIDTH,
    totalWidth: width,
    height,
  };
}

/** How many message rows column two can draw without overflowing the terminal. */
export function contentHeightFor(layout: ColumnLayout): number {
  return Math.max(1, layout.height - CHROME_ROWS);
}

/**
 * Clamp an index into a list of `count` rows (0 when there is nothing to index).
 * Shared by the shell's reducer and the columns, so "in range" means one thing.
 */
export function clampIndex(value: number, count: number): number {
  if (!Number.isFinite(value) || count <= 0) return 0;
  return Math.min(Math.max(Math.floor(value), 0), count - 1);
}

/**
 * A server-supplied string, made inert and never empty.
 *
 * R26a's single call site rule: every server string a column draws goes through
 * `sanitizeTerminalText` before it can reach a cell, and a value that sanitizes
 * to nothing gets a label saying what the row is rather than rendering a
 * nameless one — the sanitizer removes sequences, it never invents text.
 */
export function inertText(value: string | null | undefined, fallback = ''): string {
  const clean = sanitizeTerminalText(value ?? '').trim();
  return clean === '' ? fallback : clean;
}

/** The marker a surface carries: the focused one, or the unfocused one. */
export function focusMarker(surface: FocusSurface, focus: FocusSurface): string {
  return surface === focus ? FOCUS_MARKER : UNFOCUSED_MARKER;
}

/**
 * Tab's rule. With exactly two columns this is a toggle; from the composer it
 * lands on column one, because the composer is a surface inside column two and
 * Tab is how a member leaves it.
 */
export function switchColumn(focus: FocusSurface): FocusSurface {
  return focus === 'navigation' ? 'content' : 'navigation';
}

/**
 * Which column fills the terminal below the minimum. The composer counts as
 * column two, since it renders there.
 */
export function singleColumnScope(focus: FocusSurface): 'navigation' | 'content' {
  return focus === 'navigation' ? 'navigation' : 'content';
}

/** The other mode. */
export function otherMode(mode: ShellMode): ShellMode {
  return mode === 'channels' ? 'dms' : 'channels';
}

/**
 * The key column one's selection is remembered under.
 *
 * One key per (mode, workspace): switching modes or workspaces must preserve
 * each list's own selection, and a member in two workspaces has two channel
 * lists. DMs are account-wide, so they are not scoped by workspace (R17).
 */
export function navigationKeyFor(mode: ShellMode, workspaceId: string | null): string {
  return mode === 'dms' ? 'dms' : `channels:${workspaceId ?? ''}`;
}
