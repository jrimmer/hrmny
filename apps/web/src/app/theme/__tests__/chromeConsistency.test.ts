/**
 * @cytale/web — chrome consistency pins (UI consistency pass, 2026-09-28).
 *
 * Source scans, no browser: each pins one capability to ONE rendering so a
 * new surface cannot quietly fork it again.
 *
 *   - every CSS custom property the app reads is defined: `.reply-bar-*` read
 *     `--muted-foreground` / `--foreground`, which never existed, so the reply
 *     bar's controls silently inherited instead of reading muted;
 *   - a pane's ✕ is the shared `paneCloseButtonClass` (the copies drifted: a
 *     text-xl glyph on one, no hover brightening on two);
 *   - retry is the shared PaneRetryButton ("Retry"), never a hand-rolled copy
 *     of its class string or a "Try again" button;
 *   - controls without a focus rule get the one --color-focus ring (the UA
 *     outline showed on them);
 *   - the ring-toast pulse uses the accent, not a hard-coded blurple.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

const WEB_ROOT = join(__dirname, '..', '..', '..', '..');
const SRC = join(WEB_ROOT, 'src');
const tokensCss = readFileSync(join(SRC, 'app', 'theme', 'tokens.css'), 'utf8');
const shellCss = readFileSync(join(SRC, 'app', 'theme', 'shell.css'), 'utf8');

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

const files = sourceFiles(SRC).map((f) => ({
  path: relative(SRC, f).split(sep).join('/'),
  text: readFileSync(f, 'utf8'),
}));

describe('tokens', () => {
  const defined = new Set(Array.from((tokensCss + shellCss).matchAll(/(--[\w-]+)\s*:/g), (m) => m[1]!));

  it('every var() without a fallback in shell.css names a defined property', () => {
    const used = Array.from(shellCss.matchAll(/var\((--[\w-]+)\)/g), (m) => m[1]!);
    expect(used.length).toBeGreaterThan(100);
    expect([...new Set(used.filter((v) => !defined.has(v)))]).toEqual([]);
  });

  it('every var() without a fallback in the components names a defined property', () => {
    const missing = new Set<string>();
    for (const { text } of files) {
      for (const m of text.matchAll(/var\((--[\w-]+)\)/g)) {
        // Radix sets its own runtime properties on the element.
        if (!m[1]!.startsWith('--radix-') && !defined.has(m[1]!)) missing.add(m[1]!);
      }
    }
    expect([...missing]).toEqual([]);
  });

  it('the ring-toast pulse is the accent, not a hard-coded hue', () => {
    const start = shellCss.indexOf('@keyframes ring-toast-ping');
    const block = shellCss.slice(start, shellCss.indexOf('\n}', start));
    expect(block).toContain('var(--color-accent)');
    expect(block).not.toMatch(/rgb\(\d/);
  });
});

describe('one pane ✕', () => {
  const PANES = [
    'features/releasenotes/ReleaseNotesPane.tsx',
    'features/settings/SettingsPane.tsx',
    'features/serversettings/ServerSettingsPage.tsx',
    'features/threads/ThreadSidePanel.tsx',
    'features/calls/log/CallLogStandalone.tsx',
  ];

  it.each(PANES)('%s closes with paneCloseButtonClass', (path) => {
    const text = files.find((f) => f.path === path)!.text;
    expect(text).toContain('className={paneCloseButtonClass}');
  });
});

describe('one Retry', () => {
  it('no surface hand-rolls a copy of the PaneRetryButton class string', () => {
    const signature = 'hover:bg-accent/15';
    const copies = files
      .filter((f) => f.path !== 'app/ui/PaneStates.tsx' && f.text.includes(signature))
      .map((f) => f.path);
    expect(copies).toEqual([]);
  });

  it('pane-state failures never say "Try again" on a button', () => {
    const offenders = files
      .filter((f) => /<button[\s\S]{0,600}?>\s*Try again\s*<\/button>/.test(f.text))
      .map((f) => f.path)
      // The command palette's "Try again" RE-INVOKES a command (a different
      // action from reloading a pane), so it keeps its own verb.
      .filter((p) => p !== 'features/messages/MessageCompose.tsx');
    expect(offenders).toEqual([]);
  });
});

describe('one focus ring', () => {
  it('the controls that had no focus rule share the --color-focus ring', () => {
    const start = shellCss.indexOf('/* ONE keyboard focus ring');
    expect(start).toBeGreaterThan(-1);
    const block = shellCss.slice(start, shellCss.indexOf('\n}', start));
    for (const cls of ['.home-btn', '.modal-close', '.modal-btn-primary', '.dm-add', '.reply-bar-cancel']) {
      expect(block).toContain(cls);
    }
    expect(block).toContain('box-shadow: 0 0 0 2px var(--color-focus)');
  });

  it('no surface rings with the accent — the focus token is the one ring colour', () => {
    // The auth pages, the shared button helpers and a handful of rows drew
    // their ring in the accent while 120+ controls used --color-focus (a
    // different hue in every palette).
    const offenders = files.filter((f) => /ring-accent\b/.test(f.text)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});

describe('one empty state', () => {
  it('no surface hand-rolls a copy of PaneEmpty (the dashed, centred title + hint)', () => {
    // The call log and the people directory each carried a near-copy — one
    // with its own padding, one without the dashed frame.
    const signature = /flex-col items-center gap-1[^"]*text-center/;
    const copies = files
      .filter((f) => f.path !== 'app/ui/PaneStates.tsx' && signature.test(f.text))
      .map((f) => f.path);
    expect(copies).toEqual([]);
  });
});

describe('one dialog ✕', () => {
  it("no dialog falls back to the wrapper's lucide close — each draws the house ✕ (or none)", () => {
    // Omnisearch and the reminder picker wore the shadcn default (a thin
    // lucide X at its own inset and focus style); every other dialog opts
    // out and draws `.modal-close` ✕.
    const offenders = files
      .filter((f) => !f.path.startsWith('components/shadcn/'))
      .filter((f) => {
        const opens = (f.text.match(/<(DialogContent|CommandDialog)\b/g) ?? []).length;
        const optOuts = (f.text.match(/showCloseButton=\{false\}/g) ?? []).length;
        return opens > optOuts;
      })
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});

describe('one settings section heading', () => {
  it('every settings page titles its sections with the uppercase muted heading', () => {
    // SSH titled its sections in bold primary text while every other page used
    // the small uppercase muted heading.
    const HEADING = 'text-sm font-bold uppercase tracking-wide text-text-muted';
    const pages = files.filter((f) => /^features\/(settings\/\w+Section|wsettings\/\w+)\.tsx$/.test(f.path));
    const headings = pages.flatMap((f) =>
      Array.from(f.text.matchAll(/<h2\b[^>]*className="([^"]*)"/g), (m) => ({ path: f.path, cls: m[1]! })),
    );
    expect(headings.length).toBeGreaterThanOrEqual(10);
    expect(headings.map((h) => h.path)).toContain('features/settings/SshSection.tsx');
    // The mobile LIST headers (SettingsNav / WorkspaceSettingsNav) are nav
    // titles, not section headings; sr-only headings are invisible by design.
    const off = headings.filter(
      (h) => h.cls !== HEADING && !h.cls.includes('sr-only') && !/Nav\.tsx$/.test(h.path),
    );
    expect(off).toEqual([]);
  });
});

describe('one shadow vocabulary', () => {
  /** Every `box-shadow:` declaration in shell.css, with the selector it sits under. */
  function shadowDecls(): Array<{ selector: string; value: string }> {
    const out: Array<{ selector: string; value: string }> = [];
    for (const m of shellCss.matchAll(/box-shadow:\s*([^;]+);/g)) {
      const before = shellCss.slice(0, m.index);
      const open = before.lastIndexOf('{');
      const prevClose = before.lastIndexOf('}', open);
      const selector = before.slice(prevClose + 1, open).replace(/\/\*[\s\S]*?\*\//g, '').trim();
      out.push({ selector, value: m[1]!.trim() });
    }
    return out;
  }

  it('no box-shadow in shell.css hard-codes a colour — shadows come from tokens', () => {
    // The sheets and drawers carried their own rgba(0,0,0,.35) directional
    // shadows, the same smudge in the light themes as in the dark ones.
    const decls = shadowDecls();
    expect(decls.length).toBeGreaterThan(20);
    const literal = /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?|oklch|oklab)\(/i;
    const offenders = decls
      .filter((d) => literal.test(d.value.replace(/color-mix\([^)]*\)/g, '')))
      // The self-view tile floats over live VIDEO, not over themed chrome: its
      // shade separates it from arbitrary camera pixels in every theme.
      .filter((d) => d.selector !== '.self-view-overlay')
      .map((d) => `${d.selector}: ${d.value}`);
    expect(offenders).toEqual([]);
  });

  it('the sheets and drawers read the sheet/drawer tokens', () => {
    const bySelector = new Map(shadowDecls().map((d) => [d.selector.split('\n').pop()!.trim(), d.value]));
    expect(bySelector.get('.call-sheet')).toBe('var(--shadow-sheet)');
    expect(bySelector.get('.thread-sheet')).toBe('var(--shadow-sheet)');
    expect(bySelector.get('.drawer')).toBe('var(--shadow-drawer-start)');
    expect(bySelector.get('.drawer.members')).toBe('var(--shadow-drawer-end)');
  });

  it('every theme block defines the shade the sheet tokens cast', () => {
    const blocks = [
      ":root[data-theme='dark']",
      ":root[data-theme='light']",
      ":root[data-style='pixel']:not([data-theme])",
      ":root[data-style='pixel'][data-theme='light']",
    ];
    for (const head of blocks) {
      const start = tokensCss.indexOf(head);
      expect(start, head).toBeGreaterThan(-1);
      const block = tokensCss.slice(start, tokensCss.indexOf('\n}', start));
      expect(block, head).toMatch(/--tk-shade:\s*rgb\(/);
    }
  });

  it('no component draws an arbitrary Tailwind shadow outside the tokens', () => {
    const offenders = files
      .filter((f) => /shadow-\[(?!var\()/.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});
