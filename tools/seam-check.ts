/**
 * Seam sweep — detects the "unit shipped, wiring dead" class before humans
 * (or users) find it. The 2026-09 session produced five of these by hand
 * (store seam never wired, invite creation unrouted, overwrites + ack
 * routed-but-crashing, dispatch-name drift, mark-read hook unconsumed);
 * every one is mechanically detectable.
 *
 * Detectors:
 *   A. ROUTED-BUT-UNDEFINED  — router.ex actions with no controller def
 *                              (guaranteed 500s).
 *   B. WIRE DRIFT            — server-emitted dispatch names the store does
 *                              not reconcile (silently ignored events), server
 *                              names absent from the protocol union, and
 *                              protocol events nobody emits.
 *   C. DEAD STORE SLICES     — StateState fields written but never read
 *                              outside their writer.
 *   D. ORPHAN PROPS          — component props declared in *Props interfaces
 *                              but never passed by any caller.
 *
 * A, B, C and D are all errors (exit 1). C and D were warnings until the
 * 2026-09-20 hardening (6.7), when their counts reached zero: C at zero on
 * this branch, D at zero after the detector stopped reporting props that are
 * genuinely passed (shorthand JSX attributes, object-literal keys feeding a
 * spread) and the few documented design/test seams were listed as intentional.
 * B's absent-from-union finding stays a warning: the server emits
 * "ACCOUNT_DELETE" (accounts/deletion.ex) while the union defines
 * "AccountDelete", and that producer is outside this change's edit surface —
 * an error there would leave the gate permanently red instead of surfacing it.
 *
 * Usage: pnpm seam:check
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function read(p: string): string {
  return readFileSync(join(root, p), 'utf8');
}

function walk(dir: string, pred: (name: string) => boolean, acc: string[] = []): string[] {
  for (const entry of readdirSync(join(root, dir))) {
    const rel = join(dir, entry);
    if (statSync(join(root, rel)).isDirectory()) {
      walk(rel, pred, acc);
    } else if (pred(entry)) {
      acc.push(rel);
    }
  }
  return acc;
}

const errors: string[] = [];
const warnings: string[] = [];

// ---------------------------------------------------------------------------
// A. Routed-but-undefined controller actions
// ---------------------------------------------------------------------------

{
  const router = read('apps/server/lib/cytale_web/router.ex');
  const routed = [...router.matchAll(/(?:get|post|patch|put|delete)\("([^"]+)",\s*(\w+),\s*:(\w+)\)/g)];

  const controllers = new Map<string, Set<string>>();
  for (const file of walk('apps/server/lib/cytale_web/controllers', (n) => n.endsWith('.ex'))) {
    const src = read(file);
    const mod = src.match(/defmodule\s+([\w.]+)\s+do/)?.[1];
    if (!mod) continue;
    const defs = new Set([...src.matchAll(/^\s*def\s+(\w+)/gm)].map((m) => m[1]!));
    controllers.set(mod, defs);
  }

  // Controllers are named SHORT in the router (`DmController`) and resolved
  // through the enclosing `scope` alias — and the same short name exists in
  // more than one namespace (`CytaleWeb.DmController` and
  // `CytaleWeb.Compat.DmController` are different modules with different
  // routes). Resolving the nearest preceding scope is what makes this detector
  // exact: assuming a bare `CytaleWeb.*` prefix reported every route in the
  // `/api/v10` and `/api` compat scopes as "unknown controller", which is 66
  // false positives and is why this detector could not be trusted in CI.
  // Every `scope` in router.ex carries an explicit module alias, so the nearest
  // preceding one is always the right prefix — including the compat table that is
  // now mounted by `for prefix <- ~w(/api/v10 /api) do scope prefix, CytaleWeb.Compat
  // do … end` (hardening plan 3.8). That form spells the prefix as an identifier
  // rather than a string, so the pattern accepts either; the MODULE is what this
  // resolver needs, and it stays explicit in both forms.
  const scopes = [...router.matchAll(/scope\s+(?:"[^"]*"|[a-z_][\w]*),\s*([\w.]+)\s+do/g)].map((m) => ({
    at: m.index!,
    module: m[1]!,
  }));

  const resolveController = (controller: string, at: number): Set<string> | undefined => {
    const scope = scopes.filter((s) => s.at < at).at(-1);
    return controllers.get(`${scope ? scope.module : 'CytaleWeb'}.${controller}`);
  };

  for (const match of routed) {
    const [, path, controller, action] = match;
    const defs = resolveController(controller!, match.index!);
    if (!defs) {
      errors.push(`A: route ${path} targets unknown controller ${controller}`);
      continue;
    }
    // Plug-style controllers (init/call) forward every verb themselves.
    if (!defs.has(action!) && !defs.has('call')) {
      errors.push(`A: ${path} routes to ${controller}.${action}() — action not defined (500 on call)`);
    }
  }
}

// ---------------------------------------------------------------------------
// B. Wire drift: server emits vs store reconcile vs protocol contract
// ---------------------------------------------------------------------------

{
  // Protocol contract: the EventName union members.
  const eventsSrc = read('packages/protocol/src/events.ts');
  const union = eventsSrc.match(/export type EventName =\n([\s\S]*?);/)?.[1] ?? '';
  const protocolEvents = new Set([...union.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]!));

  // Server emits: names written at a real emission site under lib/ — the first
  // element of a dispatch tuple, the calls sink's `:atom -> "Name"` table, an
  // `@…event "Name"` attribute, or a lifecycle frame's `t:` value. Two file
  // classes are excluded on purpose: the compat dialect's translation table
  // (`gateway_dialect.ex`), whose UPPER_SNAKE spellings are a wire dialect
  // rather than native names, and `lib/mix/tasks/`, which only mention event
  // names in prose.
  //
  // The old scan kept only names that were ALREADY protocol events
  // (`if (protocolEvents.has(name))`), which discarded precisely the drift it
  // advertised. The names the union does not know are now collected too.
  const emittedRaw = new Set<string>();
  for (const file of walk('apps/server/lib', (n) => n.endsWith('.ex'))) {
    if (file.includes('mix/tasks/') || file.endsWith('compat/gateway_dialect.ex')) continue;
    const src = read(file);
    for (const m of src.matchAll(/\{\s*"([A-Z][A-Za-z0-9_]*)"\s*,/g)) emittedRaw.add(m[1]!);
    for (const m of src.matchAll(/->\s*"([A-Z][A-Za-z0-9_]*)"/g)) emittedRaw.add(m[1]!);
    for (const m of src.matchAll(/@\w*event\w*\s+"([A-Za-z][A-Za-z0-9_]*)"/g)) emittedRaw.add(m[1]!);
    for (const m of src.matchAll(/\bt:\s*([^\n]+)/g)) {
      for (const q of m[1]!.matchAll(/"([A-Za-z][A-Za-z0-9_]*)"/g)) emittedRaw.add(q[1]!);
    }
  }

  // Bare all-caps tokens with no underscore are HTTP verbs (`{"POST", …}`),
  // not events; the compat dialect's shouty names live only in the excluded
  // translation table.
  const emittedNames = [...emittedRaw].filter((n) => !/^[A-Z]+$/.test(n) || n.includes('_'));

  // Drift the union cannot express. A WARNING (not an error): the server emits
  // "ACCOUNT_DELETE" while the union defines "AccountDelete", and that producer
  // (accounts/deletion.ex) is outside this item's edit surface — promoting it
  // would leave the gate permanently red rather than surface the drift.
  for (const name of emittedNames) {
    if (!protocolEvents.has(name)) {
      warnings.push(
        `B: server emits "${name}" but the EventName union has no such event — ` +
          `clients cannot type or reconcile it`,
      );
    }
  }

  const emitted = new Set(emittedNames.filter((n) => protocolEvents.has(n)));

  // Store reconcile cases.
  const reconcile = read('packages/state/src/reconcile.ts');
  const reconciled = new Set([...reconcile.matchAll(/case '([A-Za-z]+)':/g)].map((m) => m[1]!));

  for (const name of emitted) {
    if (!reconciled.has(name)) {
      errors.push(`B: server emits "${name}" but the store has no reconcile case — silently ignored client-side`);
    }
  }
  for (const name of protocolEvents) {
    if (!emitted.has(name) && name !== 'Ready' && name !== 'Resumed') {
      warnings.push(`B: protocol event "${name}" is emitted by nobody (future contract or dead spec)`);
    }
  }
}

// ---------------------------------------------------------------------------
// C. Store slices written but never read
// ---------------------------------------------------------------------------

{
  const storeSrc = read('packages/state/src/store.ts');
  const stateBlock = storeSrc.match(/export interface StateState \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const fields = [...stateBlock.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]!);

  const stateFiles = walk('packages/state/src', (n) => n.endsWith('.ts') && !n.includes('__tests__'));
  const webFiles = walk('apps/web/src', (n) => n.endsWith('.ts') || n.endsWith('.tsx'));
  const allSrc = [...stateFiles, ...webFiles].map((f) => read(f)).join('\n');

  for (const field of fields) {
    // Reads look like `.field` on a state snapshot (s.field / state.field /
    // store.getState().field), not followed by ':' (object-literal writes).
    const readRe = new RegExp(`\\.${field}\\b(?!:)`, 'g');
    const reads = (allSrc.match(readRe) ?? []).length;
    const writes = (allSrc.match(new RegExp(`\\b${field}:`, 'g')) ?? []).length;
    if (reads === 0 && writes > 0) {
      // An ERROR since 6.7: this branch's count is zero, so a new hit is real
      // missing wiring rather than tolerated noise.
      errors.push(`C: store slice "${field}" is written but never read — dead state or missing wiring`);
    }
  }
}

// ---------------------------------------------------------------------------
// D. Orphan props: declared in *Props, never passed by any caller
// ---------------------------------------------------------------------------

{
  const allFiles = walk('apps/web/src', (n) => n.endsWith('.tsx') || n.endsWith('.ts'));
  const components = allFiles
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => ({ file: f, src: read(f) }))
    .filter((f) => /export (function|const) \w+/.test(f.src));

  const webSrc = allFiles.map((f) => read(f)).join('\n');

  // Does `prop` appear inside a JSX tag of `componentName`? This is the form
  // the old `prop=` search missed: bare shorthand (`<X prop />`). Braces are
  // tracked so an arrow function's `=>` does not end the tag early.
  const passedInTag = (src: string, componentName: string, prop: string): boolean => {
    const open = new RegExp(`<${componentName}\\b`, 'g');
    let match: RegExpExecArray | null;
    while ((match = open.exec(src))) {
      let i = match.index + match[0].length;
      let depth = 0;
      let str: string | null = null;
      for (; i < src.length; i += 1) {
        const ch = src[i]!;
        if (str) {
          if (ch === '\\') i += 1;
          else if (ch === str) str = null;
          continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') str = ch;
        else if (ch === '{') depth += 1;
        else if (ch === '}') depth -= 1;
        else if (ch === '>' && depth === 0) break;
      }
      if (new RegExp(`\\b${prop}\\b`).test(src.slice(match.index, i + 1))) return true;
    }
    return false;
  };

  for (const { file, src } of components) {
    // Component name → prop names from its Props interface.
    const propsIface = src.match(/export interface (\w+)Props \{([\s\S]*?)\n\}/);
    if (!propsIface) continue;
    const componentName = propsIface[1]!.replace(/Props$/, '');
    if (!new RegExp(`<${componentName}[\\s/>]`).test(webSrc)) continue; // never rendered

    const propBlock = propsIface[2]!;
    // Framework-standard / intentional seams: `children` is React composition;
    // the rest are documented test-injection hooks, render seams and defaults
    // (each named in its own file), not missing wiring. Listed here so the
    // error-level detector (6.7) stays at zero without hiding new dead props.
    const INTENTIONAL_PROPS = new Set([
      'children',
      'onEditorReady', // Lexical test seam (jsdom can't drive the editor)
      'inputTestId', // search surface test anchors
      'listTestId',
      'triggerIcon', // HeaderActionsMenu render seam (defaults to the gear icon)
      'pageSize', // PeopleDirectory pagination default (50); no caller overrides it yet
      'client', // SshSection test-injection seam (defaults to the session-backed client)
    ]);
    const others = webSrc.replace(src, '');
    const props = [...propBlock.matchAll(/^\s{2}(\w+)\??:/gm)]
      .map((m) => m[1]!)
      .filter((prop) => !INTENTIONAL_PROPS.has(prop));
    for (const prop of props) {
      // Passed looks like a JSX attribute (`prop={`), a bare JSX shorthand
      // (`<X prop />`), or an object-literal key feeding a spread
      // (`renderPane({ prop })` / `<X {...makeProps({ prop })} />`). The old
      // detector only knew the first form, which is why passing styles that
      // are just as common read as "no caller passes it".
      const passedElsewhere =
        new RegExp(`\\b${prop}\\s*=`).test(others) ||
        new RegExp(`\\b${prop}\\s*:`).test(others) ||
        passedInTag(webSrc, componentName, prop);
      if (!passedElsewhere) {
        // An ERROR since 6.7: at zero on this branch, so a new hit is real
        // missing wiring.
        errors.push(`D: <${componentName}> declares prop "${prop}" — no caller passes it (${file})`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log(`seam-check: ${errors.length} error(s), ${warnings.length} warning(s)`);
for (const e of errors) console.log(`  ERROR   ${e}`);
for (const w of warnings) console.log(`  warn    ${w}`);

if (errors.length > 0) {
  console.log('seam-check: FAIL (dead routes, wire drift, dead store slices or orphan props)');
  process.exit(1);
}
console.log('seam-check: no dead seams detected at error level');
