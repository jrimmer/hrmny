/**
 * @cytale/tui — the two-column shell's geometry, its workspace model, and its
 * key map (U6; R15, R16, R17, R25, R26a, R28).
 *
 * Three things are pure and therefore tested here without a terminal:
 *
 *   * the split (`layoutFor`) at and below the stated minimum, so the
 *     sub-minimum policy is a computed fact rather than a branch nobody ran;
 *   * the workspace model (`resolveActiveWorkspaceId`), which is client-local
 *     and re-derived from whatever list the shared store holds;
 *   * the key map (`KEY_MAP` / `resolveAction` / `applyToComposerText`), which
 *     is the SAME table the in-client key reference renders.
 *
 * The shell's rendered behaviour — navigation, both modes, empty and error
 * states, inert names — is driven through Ink in `navigation.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import {
  COLUMN_SEPARATOR_WIDTH,
  DEFAULT_COLUMN_RATIO,
  FOCUS_MARKER,
  MIN_CONTENT_WIDTH,
  MIN_NAVIGATION_WIDTH,
  MIN_TWO_COLUMN_HEIGHT,
  MIN_TWO_COLUMN_WIDTH,
  UNFOCUSED_MARKER,
  contentHeightFor,
  focusMarker,
  layoutFor,
  singleColumnScope,
  switchColumn,
  type FocusSurface,
} from '../columns/layout.js';
import {
  KEY_MAP,
  applyToComposerText,
  keystrokeOf,
  keyReferenceLines,
  resolveAction,
  type ShellAction,
} from '../keys.js';
import { needsWorkspaceSelection, resolveActiveWorkspaceId } from '../columns/WorkspaceSelect.js';

// ---------------------------------------------------------------------------
// The split
// ---------------------------------------------------------------------------

describe('the two-column split', () => {
  it('splits a default terminal at the stated ratio', () => {
    const layout = layoutFor();
    expect(layout.kind).toBe('two-column');
    if (layout.kind !== 'two-column') return;
    // 80 cells, 1:2 navigation:content, one separator column.
    expect(layout.navigationWidth).toBe(27);
    expect(layout.contentWidth).toBe(52);
    expect(layout.navigationWidth + layout.contentWidth + COLUMN_SEPARATOR_WIDTH).toBe(80);
    expect(DEFAULT_COLUMN_RATIO).toEqual({ navigation: 1, content: 2 });
  });

  it('gives both columns their minimum at exactly the minimum width', () => {
    const layout = layoutFor({ width: MIN_TWO_COLUMN_WIDTH });
    expect(layout.kind).toBe('two-column');
    if (layout.kind !== 'two-column') return;
    expect(layout.navigationWidth).toBeGreaterThanOrEqual(MIN_NAVIGATION_WIDTH);
    expect(layout.contentWidth).toBeGreaterThanOrEqual(MIN_CONTENT_WIDTH);
    expect(layout.navigationWidth + layout.contentWidth + COLUMN_SEPARATOR_WIDTH).toBe(
      MIN_TWO_COLUMN_WIDTH,
    );
  });

  it('renders the sub-minimum policy one column below the minimum', () => {
    const layout = layoutFor({ width: MIN_TWO_COLUMN_WIDTH - 1 });
    expect(layout.kind).toBe('single-column');
    if (layout.kind !== 'single-column') return;
    expect(layout.reason).toBe('narrow');
    // The notice states the size two columns need and the way to move between
    // the two columns that cannot both fit.
    expect(layout.notice).toContain(String(MIN_TWO_COLUMN_WIDTH));
    expect(layout.notice).toContain('Tab');
    // And it is NOT a clamped two-column split: no widths are offered at all.
    expect(layout.width).toBe(MIN_TWO_COLUMN_WIDTH - 1);
  });

  it('keeps the sub-minimum policy at absurd sizes and for a short terminal', () => {
    expect(layoutFor({ width: 12 }).kind).toBe('single-column');
    expect(layoutFor({ width: 0 }).kind).toBe('single-column');
    expect(layoutFor({ width: -5 }).kind).toBe('single-column');
    expect(layoutFor({ width: Number.NaN }).kind).toBe('single-column');

    const short = layoutFor({ width: 100, height: MIN_TWO_COLUMN_HEIGHT - 1 });
    expect(short.kind).toBe('single-column');
    if (short.kind !== 'single-column') return;
    expect(short.reason).toBe('short');
    expect(short.notice).toContain(String(MIN_TWO_COLUMN_HEIGHT));
  });

  it('widens navigation with the terminal, never past the content minimum', () => {
    const wide = layoutFor({ width: 120 });
    expect(wide.kind).toBe('two-column');
    if (wide.kind !== 'two-column') return;
    expect(wide.navigationWidth).toBe(40);
    expect(wide.contentWidth).toBe(79);
  });

  it('states a message-row budget that survives every accepted size', () => {
    for (const size of [{}, { width: 60 }, { width: 200, height: 60 }, { width: 10 }]) {
      expect(contentHeightFor(layoutFor(size))).toBeGreaterThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Focus: which column owns input, in two channels
// ---------------------------------------------------------------------------

describe('the focus indicator', () => {
  const surfaces: readonly FocusSurface[] = ['navigation', 'content', 'composer'];

  it('marks the focused surface with a non-colour glyph the others do not carry', () => {
    for (const surface of surfaces) {
      expect(focusMarker(surface, surface)).toBe(FOCUS_MARKER);
      for (const other of surfaces) {
        if (other === surface) continue;
        // A monochrome terminal shows the difference, because the marker is
        // text and not a colour.
        expect(focusMarker(surface, other)).toBe(UNFOCUSED_MARKER);
        expect(focusMarker(surface, other)).not.toBe(focusMarker(surface, surface));
      }
    }
  });

  it('switches columns with one action, and back out of the composer', () => {
    expect(switchColumn('navigation')).toBe('content');
    expect(switchColumn('content')).toBe('navigation');
    // Tab from the composer leaves it for the navigation column (the composer
    // is not a column; it is a surface inside column two).
    expect(switchColumn('composer')).toBe('navigation');
  });

  it('fills the width with the focused column below the minimum', () => {
    expect(singleColumnScope('navigation')).toBe('navigation');
    expect(singleColumnScope('content')).toBe('content');
    // The composer belongs to column two, so focusing it shows column two.
    expect(singleColumnScope('composer')).toBe('content');
  });
});

// ---------------------------------------------------------------------------
// The workspace model (client-local, re-derived when the list loads)
// ---------------------------------------------------------------------------

describe('the workspace selection', () => {
  const workspaces = [{ id: '100' }, { id: '200' }, { id: '300' }];

  it('keeps the chosen workspace while it is still in the list', () => {
    expect(resolveActiveWorkspaceId('200', workspaces)).toBe('200');
  });

  it('re-derives the selection when the list no longer holds it', () => {
    // A fresh Identify resets the store; the id is re-derived rather than
    // carried as a dangling reference.
    expect(resolveActiveWorkspaceId('999', workspaces)).toBe('100');
    expect(resolveActiveWorkspaceId(null, workspaces)).toBe('100');
    expect(resolveActiveWorkspaceId('200', [])).toBeNull();
  });

  it('needs no selection step for a member with fewer than two workspaces', () => {
    expect(needsWorkspaceSelection(workspaces)).toBe(true);
    expect(needsWorkspaceSelection([{ id: '100' }])).toBe(false);
    expect(needsWorkspaceSelection([])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The key map: one table, two renderings
// ---------------------------------------------------------------------------

/** The action vocabulary step 5 of the unit names, in its own words. */
const NAMED_ACTIONS: readonly ShellAction[] = [
  'move-up',
  'move-down',
  'switch-column',
  'switch-mode',
  'toggle-thread',
  'focus-composer',
  'search',
  'mark-read',
  'mark-unread',
  'help',
  'quit',
];

describe('the key map', () => {
  it('binds every action the unit names, each with keys and a label', () => {
    const bound = new Set(KEY_MAP.map((binding) => binding.action));
    for (const action of NAMED_ACTIONS) expect(bound, action).toContain(action);
    for (const binding of KEY_MAP) {
      expect(binding.keys.length, binding.action).toBeGreaterThan(0);
      expect(binding.label.length, binding.action).toBeGreaterThan(0);
    }
  });

  it('renders its own table as the in-client key reference', () => {
    const lines = keyReferenceLines();
    expect(lines).toHaveLength(KEY_MAP.length);
    for (const binding of KEY_MAP) {
      const line = lines.find((candidate) => candidate.includes(binding.label));
      expect(line, binding.label).toBeDefined();
      for (const key of binding.keys) expect(line, `${binding.action} ${key}`).toContain(key);
    }
  });

  it('resolves a keystroke to its action outside the composer', () => {
    const cases: readonly [string, Partial<Record<string, boolean>>, ShellAction][] = [
      ['j', {}, 'move-down'],
      ['k', {}, 'move-up'],
      ['', { downArrow: true }, 'move-down'],
      ['', { upArrow: true }, 'move-up'],
      ['', { pageUp: true }, 'viewport-up'],
      ['', { pageDown: true }, 'viewport-down'],
      ['d', { ctrl: true }, 'viewport-down'],
      ['u', { ctrl: true }, 'viewport-up'],
      ['', { tab: true }, 'switch-column'],
      ['', { tab: true, shift: true }, 'switch-column'],
      ['m', {}, 'switch-mode'],
      ['w', {}, 'switch-workspace'],
      ['t', {}, 'toggle-thread'],
      ['i', {}, 'focus-composer'],
      ['/', {}, 'search'],
      ['r', {}, 'mark-read'],
      ['u', {}, 'mark-unread'],
      ['?', {}, 'help'],
      ['q', {}, 'quit'],
      ['c', { ctrl: true }, 'quit'],
      ['', { return: true }, 'activate'],
      ['', { escape: true }, 'cancel'],
    ];
    for (const [input, flags, action] of cases) {
      expect(resolveAction(keystrokeOf(input, flags), 'navigation'), `${input}${JSON.stringify(flags)}`).toBe(
        action,
      );
    }
  });

  it('hands the composer every printable key, and only Enter and Escape to the shell', () => {
    const printable = ['j', 'k', 'q', 'm', 'r', 'u', '/', '?', 'i', 't', 'w', 'x', '1'];
    for (const input of printable) {
      expect(resolveAction(keystrokeOf(input, {}), 'composer'), input).toBeNull();
    }
    expect(resolveAction(keystrokeOf('', { return: true }), 'composer')).toBe('activate');
    expect(resolveAction(keystrokeOf('', { escape: true }), 'composer')).toBe('cancel');
    // Ctrl+C is not text, in the composer or anywhere else.
    expect(resolveAction(keystrokeOf('c', { ctrl: true }), 'composer')).toBe('quit');
  });

  it('appends typed text to the composer buffer and never consumes a keystroke that is an action', () => {
    expect(applyToComposerText('', keystrokeOf('h', {}))).toBe('h');
    expect(applyToComposerText('h', keystrokeOf('i', {}))).toBe('hi');
    // A paste arrives as one chunk and is appended whole.
    expect(applyToComposerText('hi', keystrokeOf(' there', {}))).toBe('hi there');
    expect(applyToComposerText('hi', keystrokeOf('', { backspace: true }))).toBe('h');
    expect(applyToComposerText('', keystrokeOf('', { backspace: true }))).toBe('');
    // Enter, Escape, Tab and Ctrl+C are the shell's, not text.
    expect(applyToComposerText('hi', keystrokeOf('', { return: true }))).toBeNull();
    expect(applyToComposerText('hi', keystrokeOf('', { escape: true }))).toBeNull();
    expect(applyToComposerText('hi', keystrokeOf('', { tab: true }))).toBeNull();
    expect(applyToComposerText('hi', keystrokeOf('c', { ctrl: true }))).toBeNull();
  });
});
