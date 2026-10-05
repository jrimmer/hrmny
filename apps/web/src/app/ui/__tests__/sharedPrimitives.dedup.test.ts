/**
 * @cytale/web — plan 7.7 (mechanical half) source pins: ONE glyph module,
 * ONE all-capabilities object.
 *
 * The drift this pins: `PhoneIcon` was declared five times (MobileTopbar,
 * CallSlot, CallPanel, DmCallIndicator, MessagePane) and `Spinner` twice
 * (CallPanel, DmCallIndicator) — each a byte-for-byte copy of the same path
 * with its own size default, so a glyph fix had to land five times. The
 * all-capabilities posture was likewise a literal in two places (CallPanel's
 * `ALL_CAPABILITIES`, DmCallIndicator's `DM_ALL_CAPABILITIES`).
 *
 * This is a text scan, not a render test: the point is that the SECOND
 * declaration cannot exist, which a DOM assertion cannot see. It is deliberately
 * strict about its scope and carries non-vacuity floors (the tree walk must
 * find the source files; the capability scan must find the calls feature), so
 * it cannot pass by scanning an empty set.
 *
 * SCOPE, exactly:
 *   - `apps/web/src`, every `.ts/.tsx/.js/.jsx/.mjs/.cjs` file, excluding
 *     `__tests__` directories and `*.test.*` / `*.spec.*` files. (Test files
 *     may import the glyphs and name them freely.)
 *   - the all-capabilities literal is scoped to `apps/web/src/features/calls`
 *     because that is the call-capability surface 7.7 names; the workspace
 *     media-settings defaults (`features/channels/{mediaOverrides,
 *     MediaSettingsDialog}.tsx`) are a different concern with a different key
 *     set (`overrides_allowed` / `master`) and are intentionally out of scope.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB_ROOT = join(__dirname, '..', '..', '..', '..');
const SRC = join(WEB_ROOT, 'src');

/** The ONE module allowed to declare the shared glyphs. */
const ICONS_MODULE = 'app/ui/icons.tsx';
/** The ONE module allowed to hold the all-true capability object. */
const CAPABILITIES_MODULE = 'features/calls/capability/callCapabilities.ts';

const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/;

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!SOURCE_EXT.test(entry.name)) continue;
      if (/\.(?:test|spec)\./.test(entry.name)) continue;
      out.push(relative(SRC, full).split(sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

/**
 * A local DECLARATION of `name` — `function X(`, `const X =`, `let`/`var X =`.
 * JSX usage (`<X />`) and imports deliberately do not match: consuming the
 * shared glyph is the point.
 */
function declaringFiles(name: string, files: readonly string[]): string[] {
  const declaration = new RegExp(`\\b(?:function|const|let|var)\\s+${name}\\b`);
  return files.filter((f) => declaration.test(readFileSync(join(SRC, f), 'utf8')));
}

/**
 * A single flat object literal carrying calls/video/screenshare all TRUE — in
 * ANY key order. The three keys are checked with a set test rather than one
 * ordered pattern: a reordered duplicate is exactly as much of a duplicate, and
 * an order-sensitive regex would let it through the gate it exists to enforce.
 */
function isAllTrueCapabilityLiteral(source: string): boolean {
  for (const match of source.matchAll(/\{[^{}]{0,400}\}/g)) {
    const literal = match[0];
    const hasTrue = (key: string) => new RegExp(`\\b${key}:\\s*true\\b`).test(literal);
    if (hasTrue('calls') && hasTrue('video') && hasTrue('screenshare')) return true;
  }
  return false;
}

const ALL_SOURCE_FILES = sourceFiles(SRC);
const CALL_SOURCE_FILES = ALL_SOURCE_FILES.filter((f) => f.startsWith('features/calls/'));

describe('plan 7.7 — one PhoneIcon / one Spinner definition', () => {
  it('walks the real web source tree (non-vacuity floor)', () => {
    expect(ALL_SOURCE_FILES.length).toBeGreaterThan(200);
    expect(ALL_SOURCE_FILES).toContain(ICONS_MODULE);
  });

  it('declares PhoneIcon exactly once (no exceptions)', () => {
    expect(declaringFiles('PhoneIcon', ALL_SOURCE_FILES)).toEqual([ICONS_MODULE]);
  });

  it('declares Spinner exactly once (no exceptions)', () => {
    expect(declaringFiles('Spinner', ALL_SOURCE_FILES)).toEqual([ICONS_MODULE]);
  });
});

describe('plan 7.7 — one all-capabilities literal', () => {
  it('scans the calls feature (non-vacuity floor)', () => {
    expect(CALL_SOURCE_FILES.length).toBeGreaterThan(20);
  });

  it('recognises the literal in ANY key order (the gate cannot pass vacuously)', () => {
    // Review finding: the matcher used to require calls -> video -> screenshare
    // in that order, so a reordered copy of the same object sailed through the
    // gate that exists to forbid it.
    expect(isAllTrueCapabilityLiteral('const X = { screenshare: true, calls: true, video: true };')).toBe(true);
    expect(isAllTrueCapabilityLiteral('const X = { calls: true, video: true };')).toBe(false);
    expect(isAllTrueCapabilityLiteral('const X = { calls: true, video: false, screenshare: true };')).toBe(false);
  });

  it('holds the all-true capability object in exactly one module', () => {
    const files = CALL_SOURCE_FILES.filter((f) =>
      isAllTrueCapabilityLiteral(readFileSync(join(SRC, f), 'utf8')),
    );
    expect(files).toEqual([CAPABILITIES_MODULE]);
  });

  it('exposes both surface views from that module', () => {
    const source = readFileSync(join(SRC, CAPABILITIES_MODULE), 'utf8');
    expect(source).toContain('export const CALL_CAPABILITIES_ALL');
    expect(source).toContain('export const DM_CALL_CAPABILITIES');
  });
});
