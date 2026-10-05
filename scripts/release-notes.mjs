#!/usr/bin/env node
/**
 * Release notes for the SPA — writes apps/web/public/release-notes.json, which
 * the web app's version badge opens (`#/release-notes`, ReleaseNotesPane).
 *
 * Owner request (2026-09-27): "make the version a link that replaces the
 * center/main column with release notes … group the commits by deployment then
 * by New Features, feature improvements, and bug fixes."
 *
 * Inputs, and why each is where it is:
 *   * `git log HEAD` — the commits ARE the notes (conventional-commit subjects).
 *     The build's checkout must carry full history (release.yml and desktop.yml
 *     check out with fetch-depth: 0); a shallow clone still produces a file,
 *     flagged `historyComplete: false`, rather than failing the build.
 *   * deployments.json — the list a deployment's pipeline appends to after
 *     each promotion (a JSON array of deployed commits, read anonymously from
 *     the URL or file in RELEASE_NOTES_DEPLOYMENTS / --deployments; a
 *     deployment's release configuration supplies it). Git cannot know what was
 *     deployed; this record is the only place that does. Unset or unreachable
 *     → the notes still render, grouped by day, and say why.
 *
 * Grouping (newest first):
 *   1. "This version" — commits after the newest recorded deployment that is an
 *      ancestor of HEAD, up to HEAD. When HEAD IS that deployment the group is
 *      simply the deployment, marked current.
 *   2. One group per recorded deployment: (previous deployment, this one].
 *   3. Commits older than the oldest recorded deployment: "Earlier", one group
 *      per UTC calendar day, capped at EARLIER_DAYS so the JSON stays small.
 *
 * Classification by the subject's conventional-commit type: feat → newFeatures;
 * perf, style → improvements; fix → bugFixes; everything else (test, ci, docs,
 * chore, refactor, build, revert, non-conventional) → a `maintenance` COUNT.
 * Merge commits are skipped entirely (their content is the commits they merge).
 *
 * The TEXT of each entry (owner request 2026-09-28: "not simple truncations …
 * but either the entire message or your tighter rewording of it"), first match
 * wins:
 *   1. a `Release-note:` trailer in the commit message — one paragraph; wrap it
 *      onto indented continuation lines like any git trailer. `Release-note: none`
 *      hides the commit (it counts as maintenance). `Release-note-audience: admin`
 *      files it under the group's collapsed "For admins" section.
 *   2. docs/release-notes/notes.json — the curated backfill, full sha → note
 *      (string, null/"none" to hide, or {note, section?, audience?, correct?}).
 *      An entry with `"correct": true` wins over step 1: the way to fix a
 *      published commit's trailer, since history is not rewritten.
 *   3. the whole commit message: the subject's description as the headline and
 *      the body (trailers stripped) as `detail`, which the pane shows collapsed.
 *      Never a truncation. Displayed commits that fall back here are listed as a
 *      warning (never an error) — `--missing` prints just that list.
 * A note on a commit whose type is not displayed (chore, refactor …) shows it
 * under Improvements unless its notes entry names a `section`.
 *
 * This script must NEVER fail a build: the notes are a convenience, the SPA is
 * the product. Every failure path logs a warning and exits 0; the web app
 * treats a missing file as "not available in this build".
 *
 * Usage: node scripts/release-notes.mjs [--out <file>] [--deployments <url|file>] [--notes <file>]
 *        node scripts/release-notes.mjs --missing   # displayed commits with no note; writes nothing
 *                                                   # (pnpm release-notes:missing)
 * Env:   RELEASE_NOTES_DEPLOYMENTS (same as --deployments), RELEASE_NOTES_OFFLINE=1
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const EARLIER_DAYS = 30;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = join(REPO_ROOT, 'apps', 'web', 'public', 'release-notes.json');
export const DEFAULT_NOTES = join(REPO_ROOT, 'docs', 'release-notes', 'notes.json');
const SECTIONS = ['newFeatures', 'improvements', 'bugFixes'];
const AUDIENCES = ['user', 'admin'];

// type(scope)!: description — scope and breaking-bang optional.
const CONVENTIONAL = /^([A-Za-z]+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/;

/** Parse a subject into {type, scope, description}; type null when not conventional. */
export function parseSubject(subject) {
  const m = CONVENTIONAL.exec(subject.trim());
  if (!m) return { type: null, scope: null, description: subject.trim() };
  return { type: m[1].toLowerCase(), scope: m[2] ? m[2].trim() : null, description: m[4].trim() };
}

/** The bucket a commit type lands in (null = maintenance, counted only). */
export function classify(type) {
  switch (type) {
    case 'feat':
      return 'newFeatures';
    case 'perf':
    case 'style':
      return 'improvements';
    case 'fix':
      return 'bugFixes';
    default:
      return null;
  }
}

// A trailer line: `Key: value` (git's shape — the key has no spaces).
const TRAILER_LINE = /^([A-Za-z0-9][A-Za-z0-9-]*)[ \t]*:[ \t]*(.*)$/;

/**
 * Split a commit body (the message after its subject line) into its prose and
 * its trailers. Trailers are the trailing paragraph(s) made only of `Key: value`
 * lines and their whitespace-indented continuation lines, as in git; a
 * continuation is joined onto its trailer's value with a single space.
 * @returns {{ text: string, trailers: {key: string, value: string}[] }}
 */
export function parseBody(body) {
  const paragraphs = String(body ?? '')
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n/)
    .map((p) => p.replace(/^\n+|\s+$/g, ''))
    .filter((p) => p.trim().length > 0);
  const trailers = [];
  while (paragraphs.length > 0) {
    const parsed = parseTrailerBlock(paragraphs[paragraphs.length - 1]);
    if (!parsed) break;
    trailers.unshift(...parsed);
    paragraphs.pop();
  }
  return { text: paragraphs.join('\n\n'), trailers };
}

function parseTrailerBlock(paragraph) {
  const out = [];
  for (const line of paragraph.split('\n')) {
    const m = TRAILER_LINE.exec(line);
    if (m && !/^[ \t]/.test(line)) out.push({ key: m[1], value: m[2].trim() });
    else if (/^[ \t]+\S/.test(line) && out.length > 0) {
      const last = out[out.length - 1];
      last.value = `${last.value} ${line.trim()}`.trim();
    } else return null;
  }
  return out.length > 0 ? out : null;
}

const isNone = (text) => typeof text === 'string' && text.trim().toLowerCase() === 'none';

/**
 * Normalise one notes-file value to {note, section?, audience?}; `note` null
 * hides the commit. Returns undefined (ignored, with a warning) when malformed.
 */
export function normaliseNote(value) {
  if (value === null || isNone(value)) return { note: null };
  if (typeof value === 'string') return value.trim() ? { note: value.trim() } : undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const note = value.note === null || isNone(value.note) ? null : value.note;
  if (note !== null && (typeof note !== 'string' || !note.trim())) return undefined;
  if (value.section !== undefined && !SECTIONS.includes(value.section)) return undefined;
  if (value.audience !== undefined && !AUDIENCES.includes(value.audience)) return undefined;
  if (value.correct !== undefined && typeof value.correct !== 'boolean') return undefined;
  return {
    note: note === null ? null : note.trim(),
    ...(value.section ? { section: value.section } : {}),
    ...(value.audience ? { audience: value.audience } : {}),
    ...(value.correct ? { correct: true } : {}),
  };
}

/**
 * Read docs/release-notes/notes.json → Map(full sha → normalised note). A
 * missing or broken file is an empty map plus warnings — never a throw.
 * @returns {{ notes: Map<string, object>, warnings: string[] }}
 */
export function readNotes(file = DEFAULT_NOTES) {
  const notes = new Map();
  const warnings = [];
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    if (err?.code !== 'ENOENT') warnings.push(`notes file unreadable (${err?.message ?? err})`);
    return { notes, warnings };
  }
  const table = parsed && typeof parsed === 'object' ? parsed.notes : undefined;
  if (!table || typeof table !== 'object' || Array.isArray(table)) {
    warnings.push('notes file has no "notes" object');
    return { notes, warnings };
  }
  for (const [sha, value] of Object.entries(table)) {
    const entry = /^[0-9a-f]{40}$/.test(sha) ? normaliseNote(value) : undefined;
    if (entry) notes.set(sha, entry);
    else warnings.push(`notes entry ${sha} ignored (needs a full sha and a string, null, or {note, section?, audience?})`);
  }
  return { notes, warnings };
}

/**
 * Decide what one commit shows: the trailer, else the notes file, else the
 * whole message. `note: null` = hidden (counted as maintenance).
 * @returns {{ source: 'trailer'|'notes'|'commit', note: string|null, detail: string|null,
 *             audience: 'user'|'admin', section?: string }}
 */
export function resolveNote(commit, notes = new Map()) {
  const { text, trailers } = parseBody(commit.body);
  const find = (key) => {
    const t = trailers.filter((x) => x.key.toLowerCase() === key);
    return t.length > 0 ? t[t.length - 1].value : undefined;
  };
  const curated = notes.get(commit.sha);
  // A CORRECTION ({"correct": true}) replaces a published commit's own
  // trailer: history cannot be rewritten, and a note that overpromised must
  // still be fixable (2026-10-05).
  if (curated?.correct) {
    return {
      source: 'notes',
      note: curated.note,
      detail: null,
      audience: curated.audience ?? 'user',
      ...(curated.section ? { section: curated.section } : {}),
    };
  }
  const trailerNote = find('release-note');
  if (trailerNote !== undefined && trailerNote !== '') {
    const audience = (find('release-note-audience') ?? '').toLowerCase() === 'admin' ? 'admin' : 'user';
    return { source: 'trailer', note: isNone(trailerNote) ? null : trailerNote, detail: null, audience };
  }
  if (curated) {
    return {
      source: 'notes',
      note: curated.note,
      detail: null,
      audience: curated.audience ?? 'user',
      ...(curated.section ? { section: curated.section } : {}),
    };
  }
  return {
    source: 'commit',
    note: parseSubject(commit.subject).description,
    detail: text.trim() ? text : null,
    audience: 'user',
  };
}

const emptyBuckets = () => ({ newFeatures: [], improvements: [], bugFixes: [] });

function emptyGroup(fields) {
  return { ...fields, ...emptyBuckets(), admin: emptyBuckets(), maintenance: 0 };
}

function addCommit(group, commit, notes) {
  const { type, scope } = parseSubject(commit.subject);
  const r = resolveNote(commit, notes);
  const bucket = r.note === null ? null : r.section ?? classify(type) ?? (r.source === 'commit' ? null : 'improvements');
  if (bucket === null) {
    group.maintenance += 1;
    return;
  }
  const entry = { description: r.note, scope, short: commit.short, sha: commit.sha, source: r.source };
  if (r.detail) entry.detail = r.detail;
  (r.audience === 'admin' ? group.admin : group)[bucket].push(entry);
}

const isEmpty = (g) =>
  SECTIONS.every((s) => g[s].length === 0 && g.admin[s].length === 0) && g.maintenance === 0;

/** Displayed entries that fell back to the raw commit message (no trailer, no notes entry). */
export function missingNotes(groups) {
  const out = [];
  for (const g of groups) {
    for (const holder of [g, g.admin]) {
      for (const s of SECTIONS) for (const e of holder?.[s] ?? []) if (e.source === 'commit') out.push(e);
    }
  }
  return out;
}

/**
 * Group commits (newest first, as `git log` gives them) by deployment.
 *
 * The running build always leads with its own section: "This version" (or
 * its deployment, when HEAD is one). With no usable deployment below it there
 * is no range to give that section, so it holds HEAD's commit alone and the
 * rest of the (capped) history is grouped by day. It never files the build
 * you are running under "Earlier" (owner report on 8ecbab4).
 *
 * @param commits     [{sha, short, date (ISO UTC), parents: number, subject}], newest first
 * @param deployments [{sha, promoted_at}] in any order; ones not in `commits` are ignored
 * @param options.notes  Map(full sha → normalised note), from readNotes
 */
export function buildGroups(commits, deployments, { earlierDays = EARLIER_DAYS, notes = new Map() } = {}) {
  const head = commits[0];
  if (!head) return [];
  const inHistory = new Set(commits.map((c) => c.sha));
  // Dedupe by sha (the first record wins: a re-promotion of the same commit
  // does not move its group) and drop deployments HEAD does not contain — a
  // record from another line of history has no range in this one.
  const deployed = new Map();
  for (const d of Array.isArray(deployments) ? deployments : []) {
    if (d && typeof d.sha === 'string' && inHistory.has(d.sha) && !deployed.has(d.sha)) {
      deployed.set(d.sha, d);
    }
  }

  const groups = [];
  const earlierByDay = new Map();
  let remaining = deployed.size;
  // The group commits currently fall into; null = the per-day tail.
  let open = deployed.has(head.sha)
    ? null
    : emptyGroup({ kind: 'current', sha: head.sha, short: head.short, date: head.date });
  const close = () => {
    // "This version" can come out empty (HEAD a merge straight onto a
    // deployment); a deployment always shows, even with nothing notable in it.
    if (open && !(open.kind === 'current' && isEmpty(open))) groups.push(open);
    open = null;
  };

  for (const commit of commits) {
    const dep = deployed.get(commit.sha);
    if (dep) {
      close();
      open = emptyGroup({
        kind: 'deployment',
        sha: commit.sha,
        short: commit.short,
        date: typeof dep.promoted_at === 'string' ? dep.promoted_at : commit.date,
        current: commit.sha === head.sha,
      });
      remaining -= 1;
    }

    // Merges carry no notes of their own — their content is what they merge.
    if (commit.parents <= 1) {
      if (open) {
        addCommit(open, commit, notes);
      } else {
        const day = commit.date.slice(0, 10);
        let g = earlierByDay.get(day);
        if (!g) {
          if (earlierByDay.size >= earlierDays) break;
          g = emptyGroup({ kind: 'earlier', day, date: `${day}T00:00:00Z` });
          earlierByDay.set(day, g);
          groups.push(g);
        }
        addCommit(g, commit, notes);
      }
    }

    // The oldest deployment's range ends at its own commit: what shipped
    // before it is unknown, so everything older goes to the per-day tail.
    // Likewise "This version" with no deployment below it: HEAD alone.
    if (remaining === 0 && open && (dep || open.kind === 'current')) close();
  }
  close();
  return groups;
}

/** The log of HEAD, newest first. */
export function readCommits(cwd = REPO_ROOT) {
  const out = execFileSync(
    'git',
    ['log', '--format=%H%x1f%h%x1f%cI%x1f%P%x1f%s%x1f%b%x1e', '--abbrev=7', 'HEAD'],
    { cwd, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
  ).toString('utf8');
  return out
    .split('\x1e')
    .map((r) => r.replace(/^\n/, ''))
    .filter((r) => r.length > 0)
    .map((r) => {
      const [sha, short, date, parents, subject, body] = r.split('\x1f');
      return {
        sha,
        short: short.slice(0, 7),
        date: new Date(date).toISOString().replace('.000Z', 'Z'),
        parents: parents.trim() === '' ? 0 : parents.trim().split(/\s+/).length,
        subject: subject ?? '',
        body: body ?? '',
      };
    });
}

function isShallow(cwd = REPO_ROOT) {
  try {
    return (
      execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
        cwd,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim() === 'true'
    );
  } catch {
    return false;
  }
}

/** Read the deployment record: {deployments, note}; note is non-null when unavailable. */
export async function readDeployments(source) {
  if (!source) return { deployments: [], note: 'no deployment record configured' };
  try {
    let text;
    if (/^https?:\/\//.test(source)) {
      const res = await fetch(source, { signal: AbortSignal.timeout(15_000) });
      if (res.status === 404) return { deployments: [], note: null }; // no deployment recorded yet
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    } else {
      text = readFileSync(source, 'utf8');
    }
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('not a JSON array');
    return { deployments: parsed, note: null };
  } catch (err) {
    return { deployments: [], note: `deployment record unavailable (${err?.message ?? err})` };
  }
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
}

/** The human list of missing notes, for the build log and `--missing`. */
export function formatMissing(missing, commitsBySha = new Map()) {
  return missing
    .map((e) => {
      const c = commitsBySha.get(e.sha);
      return `  ${e.sha}  ${c ? c.subject : e.description}`;
    })
    .join('\n');
}

async function main() {
  const out = arg('--out') ?? DEFAULT_OUT;
  const source = arg('--deployments') ?? process.env.RELEASE_NOTES_DEPLOYMENTS;
  const notesFile = arg('--notes') ?? DEFAULT_NOTES;
  const missingOnly = process.argv.includes('--missing');

  let commits;
  try {
    commits = readCommits();
  } catch (err) {
    console.warn(`[release-notes] no git history here (${err?.message ?? err}) — skipping; the app shows "not available"`);
    return;
  }
  const { deployments, note } =
    process.env.RELEASE_NOTES_OFFLINE === '1'
      ? { deployments: [], note: 'deployment record not read (offline build)' }
      : await readDeployments(source);
  if (note) console.warn(`[release-notes] ${note} — grouping by day only`);
  const shallow = isShallow();
  if (shallow) console.warn('[release-notes] shallow checkout — notes cover only the fetched history');
  const { notes, warnings } = readNotes(notesFile);
  for (const w of warnings) console.warn(`[release-notes] ${w}`);

  const groups = buildGroups(commits, deployments, { notes });
  const missing = missingNotes(groups);
  const bySha = new Map(commits.map((c) => [c.sha, c]));

  if (missingOnly) {
    // stdout is the list itself, so it pipes; the how-to goes to stderr.
    if (missing.length > 0) console.log(formatMissing(missing, bySha));
    console.warn(
      missing.length === 0
        ? '[release-notes] every displayed commit has a note'
        : `[release-notes] ${missing.length} displayed commit(s) have no Release-note trailer or notes entry.\n` +
            `  Read each with \`git show -s <sha>\` and add it to docs/release-notes/notes.json.`,
    );
    return;
  }

  if (missing.length > 0) {
    console.warn(
      `[release-notes] WARNING: ${missing.length} displayed commit(s) have no Release-note trailer or ` +
        `docs/release-notes/notes.json entry — showing their full commit message instead:\n` +
        formatMissing(missing, bySha),
    );
  }

  const head = commits[0];
  const doc = {
    version: 1,
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    head: head ? { sha: head.sha, short: head.short, date: head.date } : null,
    historyComplete: !shallow,
    deploymentsNote: note,
    groups,
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(doc) + '\n');
  console.log(`[release-notes] wrote ${doc.groups.length} groups from ${commits.length} commits to ${out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    // Never fail the build over notes.
    console.warn(`[release-notes] skipped: ${err?.stack ?? err}`);
  });
}
