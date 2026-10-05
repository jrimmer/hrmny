/**
 * @cytale/web — one avatar, one shape (owner report 2026-09-28).
 *
 * Home's inbox rendered its author avatar as a SQUARE tile with body-sized
 * initials: the base `.avatar` class carried only `position: relative`, every
 * surface restated the circle in its own sizing class, and the inbox passed
 * none. The fix makes `.avatar` a complete default (circle, centred and
 * size-scaled initials, a clipped image) driven by `--avatar-size`, so a
 * surface picks a SIZE and never a shape.
 *
 * Pinned here, without a browser:
 *   1. the base rule is complete, zero-specificity, and size-variable driven;
 *   2. every sizing class in shell.css is a size step, not a shape restated;
 *   3. every `<Avatar` call site in the app passes a size (`size={…}` or a
 *      sizing class from the scale) — or knowingly takes the 32px default;
 *   4. no surface hand-rolls an identity tile from `avatarTileStyle` /
 *      `avatarInitials` instead of rendering the shared component;
 *   5. the component sets `--avatar-size` from `size`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Avatar } from '../UserAvatar.js';

const WEB_ROOT = join(__dirname, '..', '..', '..', '..');
const SRC = join(WEB_ROOT, 'src');
const shellCss = readFileSync(join(SRC, 'app', 'theme', 'shell.css'), 'utf8');

function cssBlock(selector: string): string {
  const start = shellCss.indexOf(`\n${selector} {`);
  if (start === -1) throw new Error(`shell.css block not found: ${selector}`);
  return shellCss.slice(start, shellCss.indexOf('\n}', start));
}

/** The size scale: each sizing class and the step it sets. */
const SIZE_CLASSES: Record<string, string> = {
  'reply-context-avatar': '16px',
  'mention-autocomplete-avatar': '20px',
  'omni-avatar': '20px',
  'home-avatar': '28px',
  'user-panel-avatar': '32px',
  'people-avatar': '36px',
  'inbox-row-avatar': '36px',
  'message-avatar': '40px',
  'profile-avatar': '72px',
};

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) out.push(full);
    }
  };
  walk(root);
  return out;
}

/** Every `<Avatar …/>` JSX element's attribute text, by file. */
function avatarCallSites(): { file: string; attrs: string }[] {
  const sites: { file: string; attrs: string }[] = [];
  for (const file of sourceFiles(SRC)) {
    const src = readFileSync(file, 'utf8');
    // `SharedAvatar` is MessageItem's import alias for the shared component.
    const re = /<(?:Avatar|SharedAvatar)\b([\s\S]*?)\/>/g;
    for (const m of src.matchAll(re)) {
      sites.push({ file: relative(SRC, file).split(sep).join('/'), attrs: m[1]! });
    }
  }
  return sites;
}

describe('the base .avatar is a complete default', () => {
  it('is zero-specificity, round, centred and sized by --avatar-size', () => {
    const block = cssBlock(':where(.avatar)');
    expect(block).toContain('--avatar-size:');
    expect(block).toContain('width: var(--avatar-size)');
    expect(block).toContain('height: var(--avatar-size)');
    expect(block).toContain('border-radius: var(--radius-full)');
    expect(block).toContain('align-items: center');
    expect(block).toContain('justify-content: center');
    expect(block).toContain('flex-shrink: 0');
    expect(block).toMatch(/font-size: .*var\(--avatar-size\)/);
    expect(block).toContain('position: relative');
  });

  it('an uploaded image fills the circle and clips to it', () => {
    const block = cssBlock(':where(.avatar) > img');
    expect(block).toContain('inset: 0');
    expect(block).toContain('object-fit: cover');
    expect(block).toContain('border-radius: inherit');
  });

  it.each(Object.entries(SIZE_CLASSES))('.%s is a size step (%s), not a restated shape', (cls, px) => {
    const selector = cls === 'home-avatar' ? '.home-row .home-avatar' : `.${cls}`;
    // A class may share a block with a sibling at the same step.
    const start = shellCss.search(new RegExp(`\\n(?:[^{}\\n]*,\\n)?${selector.replace(/[.]/g, '\\.')}[ ,]`));
    expect(start, `${selector} has a block`).toBeGreaterThan(-1);
    const block = shellCss.slice(start, shellCss.indexOf('\n}', start));
    expect(block).toContain(`--avatar-size: ${px}`);
    expect(block).not.toMatch(/\n\s+(width|height|border-radius|font-size):/);
  });
});

describe('every Avatar call site takes the shared shape', () => {
  const sites = avatarCallSites();

  it('finds the call sites (non-vacuous)', () => {
    expect(sites.length).toBeGreaterThanOrEqual(15);
  });

  it('every call site picks a size from the scale (or knowingly takes the default)', () => {
    const unsized = sites.filter(({ attrs }) => {
      if (/\bsize=\{\d+\}/.test(attrs)) return false;
      const cls = /className=(?:"([^"]*)"|\{([\s\S]*?)\}\s*(?:\w+=|$))/.exec(attrs);
      const classes = cls ? (cls[1] ?? cls[2] ?? '') : '';
      return !Object.keys(SIZE_CLASSES).some((c) => classes.includes(c));
    });
    expect(unsized.map((s) => s.file)).toEqual([]);
  });

  it('no call site restates the shape with utility classes', () => {
    const restated = sites.filter(({ attrs }) =>
      /\b(rounded-(full|lg|md|xl)|h-\d+ w-\d+|text-\[\d+px\]|text-(xs|sm|base|lg|xl))\b/.test(attrs),
    );
    expect(restated.map((s) => `${s.file}: ${s.attrs.trim().slice(0, 80)}`)).toEqual([]);
  });

  it('no surface hand-rolls an identity tile beside the component', () => {
    // The rail's workspace tile is the one non-person tile: a one-initial
    // rounded square that shares the hue helper, not the person circle.
    const allowed = new Set([
      'app/ui/UserAvatar.tsx',
      'app/ui/avatar.ts',
      'features/channels/WorkspaceSwitcher.tsx',
    ]);
    const offenders = sourceFiles(SRC)
      .map((f) => relative(SRC, f).split(sep).join('/'))
      .filter((f) => !allowed.has(f))
      .filter((f) => /avatarTileStyle\(|avatarHue\(/.test(readFileSync(join(SRC, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});

describe('Avatar size prop', () => {
  it('sets --avatar-size on the tile and on the image root', () => {
    const { container, rerender } = render(<Avatar id="1" name="Ada Lovelace" size={48} />);
    const tile = container.querySelector('.avatar') as HTMLElement;
    expect(tile.style.getPropertyValue('--avatar-size')).toBe('48px');
    expect(tile.style.background).not.toBe('');

    rerender(<Avatar id="1" name="Ada Lovelace" size={48} src="/a.png" />);
    const withImg = container.querySelector('.avatar') as HTMLElement;
    expect(withImg.style.getPropertyValue('--avatar-size')).toBe('48px');
    expect(withImg.querySelector('img')).not.toBeNull();
  });

  it('without size or class it is still the base avatar (the 32px default)', () => {
    const { container } = render(<Avatar id="1" name="Ada Lovelace" />);
    const tile = container.querySelector('.avatar') as HTMLElement;
    expect(tile.className).toBe('avatar');
    expect(tile.style.getPropertyValue('--avatar-size')).toBe('');
    expect(tile.textContent).toBe('AL');
  });
});

describe('a workspace tile is one character wherever it is drawn', () => {
  it('maxInitials={1} draws the rail tile’s single initial (the settings preview matched two)', () => {
    const { container } = render(<Avatar id="w1" name="Playground" maxInitials={1} />);
    expect((container.querySelector('.avatar') as HTMLElement).textContent).toBe('P');
  });

  it('counts code points, not UTF-16 units', () => {
    const { container } = render(<Avatar id="w2" name="𝒜da Lab" maxInitials={1} />);
    const text = (container.querySelector('.avatar') as HTMLElement).textContent ?? '';
    expect(Array.from(text)).toHaveLength(1);
    // Never half a surrogate pair.
    expect(/^[\uD800-\uDBFF]$/.test(text)).toBe(false);
  });

  it('the workspace settings preview asks for one initial, like RailIcon', () => {
    const src = readFileSync(join(__dirname, '..', '..', '..', 'features', 'wsettings', 'WorkspaceOverview.tsx'), 'utf8');
    expect(src).toMatch(/data-testid="wsettings-icon-preview"/);
    expect(src).toMatch(/maxInitials=\{1\}/);
  });
});
