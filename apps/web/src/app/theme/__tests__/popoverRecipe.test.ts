/**
 * @cytale/web — the one-popover-recipe guard (UI consistency, 2026-09-27).
 *
 * Every anchored floating surface takes the SAME fill, radius and elevation
 * tokens. They drifted three ways (surface-strong/rounded-lg/shadow-lg on the
 * slash palette and several pickers, surface-emphasized/radius-md/
 * --shadow-popover on the composer palettes) and `shadow-lg` ignored the
 * pixel style's hard shadows entirely. This reads the sources as text — no
 * browser needed — so a new picker that hand-rolls its chrome fails CI.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(p, 'utf8');
const shellCss = read('src/app/theme/shell.css');

/** The anchored pickers/menus that must wear the `.popover` class. */
const POPOVER_COMPONENTS = [
  'src/features/commands/CommandAutocomplete.tsx',
  'src/features/messages/ReactionPicker.tsx',
  'src/features/messages/MarkPicker.tsx',
  'src/features/messages/MessageComponents.tsx',
  'src/features/calls/video/QualityPicker.tsx',
  'src/features/calls/video/ShareSwitcher.tsx',
  'src/features/calls/dm/DmCallIndicator.tsx',
  'src/features/messages/MessageItem.tsx',
];

function cssBlock(selector: string): string {
  const start = shellCss.indexOf(`\n${selector} {`);
  if (start === -1) throw new Error(`shell.css block not found: ${selector}`);
  return shellCss.slice(start, shellCss.indexOf('\n}', start));
}

describe('one popover recipe', () => {
  it('.popover is the popover fill + radius-md + --shadow-popover', () => {
    const block = cssBlock('.popover');
    expect(block).toContain('background: var(--color-popover)');
    expect(block).toContain('border-radius: var(--radius-md)');
    expect(block).toContain('box-shadow: var(--shadow-popover)');
  });

  it.each(POPOVER_COMPONENTS)('%s wears .popover, never shadow-lg', (path) => {
    const src = read(path);
    expect(src).toMatch(/['" ]popover[ '"]/);
    expect(src).not.toContain('shadow-lg');
  });

  it('the composer palettes, emoji panel and menus share the same fill', () => {
    for (const sel of [
      '.emoji-autocomplete',
      '.emoji-panel',
      '.composer-plus-menu',
      '.header-actions-menu',
      '.reaction-tooltip',
      '.channel-context-menu',
      '.workspace-menu-popover',
      '.presence-menu-popover',
    ]) {
      const block = cssBlock(sel);
      expect(block, sel).toContain('background: var(--color-popover)');
      expect(block, sel).toContain('box-shadow: var(--shadow-popover)');
      expect(block, sel).not.toContain('surface-emphasized');
    }
  });

  it('the editor palettes float above their host: out of flow, capped, scrolling, under dialogs', () => {
    // Owner report 2026-09-28: `#`/`@` search pushed the conversation up.
    const block = cssBlock('.editor-palettes');
    expect(block).toContain('position: absolute');
    expect(block).toContain('bottom: 100%');
    expect(block).toContain('left: 0');
    expect(block).toContain('right: 0');
    // Above the timeline's layers, below dialogs/sheets (z 50).
    const z = Number(/z-index: (\d+)/.exec(block)?.[1]);
    expect(z).toBeGreaterThanOrEqual(30);
    expect(z).toBeLessThan(50);
    const list = cssBlock('.editor-palettes > .emoji-autocomplete');
    expect(list).toMatch(/max-height: min\(\d+px, \d+dvh\)/);
    expect(list).toContain('overflow-y: auto');
  });

  it('the hover toolbar divider comes from a token, not white/20', () => {
    const src = read('src/features/messages/MessageItem.tsx');
    expect(src).not.toContain('bg-white/20');
    expect(src).toContain('bg-separator');
  });
});
