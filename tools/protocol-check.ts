/**
 * U29 + hardening plan 6.6 — protocol drift checker.
 *
 * Verifies that the gateway wire contract agrees in all three places it is
 * written down:
 *
 *   1. the SERVER — `packages/protocol/manifest.json`, generated from the
 *      Elixir sources by `mix protocol.manifest` (opcodes, event names and
 *      per-event payload field names);
 *   2. the TS PACKAGE — `packages/protocol/src/*.ts` (opcodes, the EventName
 *      union, and every event payload type's fields);
 *   3. the DOCS — `docs/protocol/*.md`.
 *
 * Before 6.6 this script compared only (2) against (3) by substring search and
 * read ZERO Elixir, so a server-side event or payload-field rename passed
 * green. The manifest closes that gap: this script first makes sure the
 * committed manifest still matches the server source (via
 * `mix protocol.manifest --check`, run in `apps/server`), then diffs both the
 * package and the docs against it.
 *
 *   node --experimental-strip-types tools/protocol-check.ts
 *
 * Exit 0 = no drift; exit 1 = drift (missing, phantom, or mismatched surface).
 * Wired into CI via `pnpm protocol:check` at the repo root.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function read(p: string): string {
  return readFileSync(join(root, p), 'utf8');
}

// ---------------------------------------------------------------------------
// The server-derived manifest (hardening plan 6.6)
// ---------------------------------------------------------------------------

interface Manifest {
  opcodes: Record<string, number>;
  events: Record<string, string[]>;
}

const manifestPath = 'packages/protocol/manifest.json';

function loadManifest(): Manifest {
  try {
    return JSON.parse(read(manifestPath)) as Manifest;
  } catch (error) {
    throw new Error(
      `protocol-check: cannot read ${manifestPath} (${(error as Error).message}) — ` +
        'generate it from the server with `cd apps/server && mix protocol.manifest`',
    );
  }
}

const manifest = loadManifest();

const problems: string[] = [];
const warnings: string[] = [];

// The manifest is only meaningful if it still describes the server. `--check`
// regenerates it in memory from the Elixir sources and raises on any
// difference, so a server-side rename fails here even though the committed
// JSON on disk is untouched.
{
  const check = spawnSync('mix', ['protocol.manifest', '--check'], {
    cwd: join(root, 'apps/server'),
    encoding: 'utf8',
    timeout: 300_000,
  });

  if (check.error) {
    problems.push(
      `could not run \`mix protocol.manifest --check\` to verify the committed manifest ` +
        `against the server (${check.error.message}) — Elixir is required by this gate`,
    );
  } else if (check.status !== 0) {
    const detail = `${check.stdout ?? ''}${check.stderr ?? ''}`.trim();

    // Distinguish a genuinely stale manifest from "mix could not run the task
    // at all". The task is project code, so it cannot run before the project's
    // deps are fetched: an environment without `mix deps.get` fails with
    // "Unchecked dependencies", and reporting THAT as "the manifest is STALE"
    // points the reader at the wrong file. Only the task's own staleness
    // message counts as drift.
    if (/is STALE/.test(detail)) {
      problems.push(
        `the committed ${manifestPath} is STALE relative to the server — ` +
          `a server event/payload/opcode change was not regenerated:\n${detail}`,
      );
    } else {
      problems.push(
        `could not verify the committed ${manifestPath} against the server: ` +
          `\`mix protocol.manifest --check\` exited ${check.status} WITHOUT reporting staleness, ` +
          `so this is an environment error (are the Elixir deps fetched? did mix run in apps/server?), ` +
          `not protocol drift:\n${detail}`,
      );
    }
  }
}

const serverOpcodes = new Map<number, string>(
  Object.entries(manifest.opcodes).map(([name, code]) => [code, name]),
);
const serverEventNames = new Set(Object.keys(manifest.events));

/** Normalize an opcode name across the TS/server casing conventions. */
function normalizeOp(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ---- Extract the shipped contract surface from @cytale/protocol ------------

const opcodesSrc = read('packages/protocol/src/opcodes.ts');

// GatewayOp members: `Name = 3` inside the `export const GatewayOp = { ... }` object.
const opBlock =
  /export\s+const\s+GatewayOp\s*=\s*\{([\s\S]*?)\}\s*(?:as const)?;/.exec(opcodesSrc)?.[1] ?? '';
const shippedOps = [...opBlock.matchAll(/^\s*(\w+):\s*(\d+)/gm)].map(
  ([, name, value]) => `${name}=${value}`,
);

const eventsSrc = read('packages/protocol/src/events.ts');
const payloadsSrc = read('packages/protocol/src/payloads.ts');

// EventName union members: single-quoted string literals in `export type EventName = ...`.
const eventNameBlock = /export\s+type\s+EventName\s*=\s*([\s\S]*?);/.exec(eventsSrc)?.[1] ?? '';
const shippedEvents = [...eventNameBlock.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]!);

// ---- Payload fields from the TS package ------------------------------------

/**
 * Remove `//` and block comments while leaving string literals intact. The
 * brace/`;` scanners below are not comment-aware, and these sources are full of
 * prose comments containing apostrophes (which would otherwise open a "string"
 * and swallow the rest of the file).
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let str: string | null = null;
  while (i < src.length) {
    const ch = src[i]!;
    if (str) {
      out += ch;
      if (ch === '\\') {
        out += src[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (ch === str) str = null;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      str = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const eventsClean = stripComments(eventsSrc);
const payloadsClean = stripComments(payloadsSrc);

/** Return the text between the `{` at `open` and its matching `}` (exclusive). */
function matchBraces(text: string, open: number): string {
  let depth = 0;
  let inString: string | null = null;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') inString = ch;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return text.slice(open + 1);
}

type TypeDef = { kind: 'object'; body: string } | { kind: 'alias'; target: string };
const typeDefs = new Map<string, TypeDef>();

function parseTypeDefs(src: string): void {
  for (const m of src.matchAll(/export\s+type\s+(\w+)\s*=\s*/g)) {
    const name = m[1]!;
    const start = m.index! + m[0].length;
    const ws = /^\s*/.exec(src.slice(start))![0].length;
    const at = start + ws;
    if (src[at] === '{') {
      typeDefs.set(name, { kind: 'object', body: matchBraces(src, at) });
    } else {
      const end = src.indexOf(';', at);
      typeDefs.set(name, { kind: 'alias', target: src.slice(at, end === -1 ? undefined : end).trim() });
    }
  }
  for (const m of src.matchAll(/export\s+interface\s+(\w+)[^{]*\{/g)) {
    const open = m.index! + m[0].length - 1;
    typeDefs.set(m[1]!, { kind: 'object', body: matchBraces(src, open) });
  }
}

parseTypeDefs(eventsClean);
parseTypeDefs(payloadsClean);

/** Top-level members of an object type body (depth-aware). */
function topLevelFields(body: string): { name: string; optional: boolean }[] {
  const fields: { name: string; optional: boolean }[] = [];
  let depth = 0;
  let inString: string | null = null;
  let current = '';
  const flush = () => {
    const member = current.trim();
    const match = /^(?:readonly\s+)?(\w+)(\??)\s*:/.exec(member);
    if (match) fields.push({ name: match[1]!, optional: match[2] === '?' });
    current = '';
  };
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!;
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === inString) inString = null;
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') inString = ch;
    else if ('{(<['.includes(ch)) depth += 1;
    else if ('})>]'.includes(ch)) depth -= 1;
    if (ch === ';' && depth === 0) flush();
    else current += ch;
  }
  flush();
  return fields;
}

function fieldsForType(
  name: string,
  seen = new Set<string>(),
): { name: string; optional: boolean }[] | null {
  if (seen.has(name)) return null;
  const def = typeDefs.get(name);
  if (!def) return null;
  if (def.kind === 'object') return topLevelFields(def.body);
  const target = /^([A-Za-z_]\w*)/.exec(def.target)?.[1];
  if (!target) return null;
  return fieldsForType(target, new Set([...seen, name]));
}

// Event name -> payload type name, from the EventPayloadMap interface.
const payloadMapBlock =
  /export\s+interface\s+EventPayloadMap\s*\{([\s\S]*?)\n\}/.exec(eventsClean)?.[1] ?? '';
const payloadTypeByEvent = new Map<string, string>(
  [...payloadMapBlock.matchAll(/^\s*(\w+):\s*(\w+)\s*;/gm)].map((m) => [m[1]!, m[2]!]),
);

const packageFields = new Map<string, { name: string; optional: boolean }[] | null>();
for (const event of shippedEvents) {
  const typeName = payloadTypeByEvent.get(event) ?? event;
  packageFields.set(event, fieldsForType(typeName));
}

// ---- Extract the documented surface from docs/protocol/*.md ----------------

const docsDir = join(root, 'docs', 'protocol');
const docs = readdirSync(docsDir).filter((f) => f.endsWith('.md'));
const docsText = docs.map((f) => readFileSync(join(docsDir, f), 'utf8')).join('\n');

// ---- Compare: server manifest vs TS package --------------------------------

const shippedOpByCode = new Map<number, string>();
for (const op of shippedOps) {
  const [name, value] = op.split('=');
  shippedOpByCode.set(Number(value), name!);
}

for (const [code, name] of shippedOpByCode) {
  const serverName = serverOpcodes.get(code);
  if (serverName === undefined) {
    problems.push(
      `opcode ${name}=${code} is shipped by the package but absent from the server manifest — ` +
        `packages/protocol/src/opcodes.ts and apps/server .../gateway/opcode.ex disagree`,
    );
  } else if (normalizeOp(serverName) !== normalizeOp(name!)) {
    problems.push(
      `opcode ${code} is '${name}' in the package but '${serverName}' on the server (name drift)`,
    );
  }
}

for (const [code, name] of serverOpcodes) {
  if (!shippedOpByCode.has(code)) {
    problems.push(
      `opcode ${name}=${code} is defined on the server but absent from ` +
        `packages/protocol/src/opcodes.ts`,
    );
  }
}

for (const name of shippedEvents) {
  if (!serverEventNames.has(name)) {
    warnings.push(
      `package event "${name}" is emitted by no server source (future contract, REST-only, ` +
        `or a non-conforming server spelling)`,
    );
  }
}

for (const name of [...serverEventNames].sort()) {
  if (!shippedEvents.includes(name)) {
    problems.push(
      `server emits event "${name}" but it is not in the EventName union — ` +
        `clients cannot type or dispatch it (server-side rename?)`,
    );
    continue;
  }

  const tsFields = packageFields.get(name);
  if (!tsFields) {
    warnings.push(`payload fields for "${name}" could not be derived from the package types`);
    continue;
  }

  const serverFields = new Set(manifest.events[name] ?? []);
  for (const field of tsFields) {
    // Optional package fields MAY be omitted on the wire (ChannelDelete.workspace_id
    // is the live example), so only required fields must be emitted. A required
    // field the server never sends is the server-side field-rename signal.
    if (!field.optional && !serverFields.has(field.name)) {
      problems.push(
        `package payload type for "${name}" declares required field "${field.name}" the server ` +
          `never emits (server-side field rename? manifest: [${(manifest.events[name] ?? []).join(', ')}])`,
      );
    }
  }
  for (const field of [...serverFields].sort()) {
    if (!tsFields.some((f) => f.name === field)) {
      warnings.push(
        `server emits "${name}.${field}" but the package payload type does not declare it ` +
          `(incomplete typing — additive field)`,
      );
    }
  }
}

// ---- Compare: server manifest vs docs --------------------------------------

for (const [name, code] of [...serverOpcodes].sort((a, b) => a[1].localeCompare(b[1]))) {
  const mentioned =
    docsText.includes(name) ||
    docsText.includes(`\`${code}\``) ||
    new RegExp(`\\b${code}\\b`).test(docsText);
  if (!mentioned) problems.push(`opcode ${name}=${code} documented nowhere in docs/protocol/`);
}

const docsUpper = docsText.toUpperCase();
// Every event either side knows about must be documented: server-emitted names
// (the manifest) and package-declared names that no server source emits yet
// (Role*, ThreadMember*, …).
for (const ev of [...new Set([...serverEventNames, ...shippedEvents])].sort()) {
  // Event docs use the canonical package casing; lifecycle events are widely
  // discussed in wire shorthand (READY/RESUMED), so compare case-insensitively.
  if (!docsText.includes(ev) && !docsUpper.includes(ev.toUpperCase())) {
    problems.push(`event '${ev}' documented nowhere in docs/protocol/`);
  }
}

// Phantom entries: gateway.md's opcode table (`| <op> | <Name> | ...`) must
// only list opcodes the server actually ships, with the right code.
const gatewayDoc = read('docs/protocol/gateway.md');
for (const line of gatewayDoc.split('\n')) {
  // Rows of the opcode table: numeric first cell + alphabetic second cell.
  const row = /^\|\s*(\d+)\s*\|\s*([A-Za-z][A-Za-z ]*?)\s*\|/.exec(line);
  if (!row) continue;
  const [, value, name] = row;
  const serverName = serverOpcodes.get(Number(value));
  if (!serverName) {
    problems.push(
      `documented opcode '${name}' (code ${value}) does not exist in the server manifest`,
    );
  } else if (normalizeOp(serverName) !== normalizeOp(name!.replace(/\s+/g, ''))) {
    problems.push(
      `documented opcode '${name}' (code ${value}) does not match the server name '${serverName}'`,
    );
  }
}

// ---- Report -----------------------------------------------------------------

console.log(
  `protocol-check: server manifest has ${serverOpcodes.size} opcodes, ` +
    `${serverEventNames.size} events; package has ${shippedOps.length} opcodes, ` +
    `${shippedEvents.length} events; ${docs.length} doc files`,
);

for (const w of warnings) console.warn(`  warn    ${w}`);

if (problems.length > 0) {
  console.error('protocol drift detected:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log('protocol-check: server, package and docs agree (no drift).');
