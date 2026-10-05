// @vitest-environment node
/**
 * scripts/release-notes.mjs — the build-time half of the release notes.
 *
 * It lives at the repo root (the release/desktop workflows run it before the
 * SPA build), but its tests run HERE so the web suite CI already runs covers
 * the classification and grouping the pane renders.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildGroups,
  classify,
  formatMissing,
  missingNotes,
  normaliseNote,
  parseBody,
  parseSubject,
  readDeployments,
  readNotes,
  resolveNote,
  type Commit,
  type CuratedNote,
} from '../../../../../../scripts/release-notes.mjs';

let n = 0;
/** A commit, newest-first lists are built by the caller. */
function c(subject: string, date: string, extra: Partial<Commit> = {}): Commit {
  n += 1;
  const sha = `${n}`.padStart(7, '0').padEnd(40, 'a');
  return { sha, short: sha.slice(0, 7), date, parents: 1, subject, ...extra };
}

describe('parseSubject', () => {
  it('splits type, scope and description', () => {
    expect(parseSubject('feat(web): notification controls in the header')).toEqual({
      type: 'feat',
      scope: 'web',
      description: 'notification controls in the header',
    });
  });

  it('keeps a scope-less subject and a breaking bang', () => {
    expect(parseSubject('fix: a thing')).toEqual({ type: 'fix', scope: null, description: 'a thing' });
    expect(parseSubject('feat(api)!: drop v0')).toEqual({ type: 'feat', scope: 'api', description: 'drop v0' });
  });

  it('a non-conventional subject has no type', () => {
    expect(parseSubject('Merge pull request #130 from x')).toEqual({
      type: null,
      scope: null,
      description: 'Merge pull request #130 from x',
    });
  });
});

describe('classify', () => {
  it('maps the owner-facing buckets', () => {
    expect(classify('feat')).toBe('newFeatures');
    expect(classify('perf')).toBe('improvements');
    expect(classify('style')).toBe('improvements');
    expect(classify('fix')).toBe('bugFixes');
  });

  it('counts everything else as maintenance', () => {
    for (const t of ['test', 'ci', 'docs', 'chore', 'refactor', 'build', 'revert', null]) {
      expect(classify(t)).toBeNull();
    }
  });
});

describe('buildGroups', () => {
  // History, newest first. D2 and D1 are deployments.
  const head = c('feat(web): the newest thing', '2026-09-28T10:00:00Z');
  const afterD2 = c('fix(server): after the last deploy', '2026-09-28T09:00:00Z');
  const d2 = c('perf(web): the deployed tip', '2026-09-27T23:00:00Z');
  const inD2 = c('test(web): a spec', '2026-09-27T20:00:00Z');
  const merge = c("Merge branch 'x'", '2026-09-27T19:00:00Z', { parents: 2 });
  const d1 = c('ci: the first recorded deploy', '2026-09-27T08:00:00Z');
  const old1 = c('feat(mobile): older, same day', '2026-09-26T22:00:00Z');
  const old2 = c('fix(web): older, the day before', '2026-09-25T12:00:00Z');
  const history = [head, afterD2, d2, inD2, merge, d1, old1, old2];
  const deployments = [
    { sha: d1.sha, promoted_at: '2026-09-27T08:30:17Z' },
    { sha: d2.sha, promoted_at: '2026-09-27T23:36:18Z' },
  ];

  it('groups: this version, each deployment, then earlier days — newest first', () => {
    const groups = buildGroups(history, deployments);
    expect(groups.map((g) => (g.kind === 'earlier' ? `earlier:${g.day}` : `${g.kind}:${g.short}`))).toEqual([
      `current:${head.short}`,
      `deployment:${d2.short}`,
      `deployment:${d1.short}`,
      'earlier:2026-09-26',
      'earlier:2026-09-25',
    ]);

    const [current, dep2, dep1] = groups;
    expect(current!.newFeatures.map((e) => e.description)).toEqual(['the newest thing']);
    expect(current!.bugFixes).toEqual([
      { description: 'after the last deploy', scope: 'server', short: afterD2.short, sha: afterD2.sha, source: 'commit' },
    ]);
    // (D1, D2]: the tip itself plus the test commit; the merge is skipped.
    expect(dep2).toMatchObject({ kind: 'deployment', date: '2026-09-27T23:36:18Z', current: false });
    expect(dep2!.improvements.map((e) => e.scope)).toEqual(['web']);
    expect(dep2!.maintenance).toBe(1);
    // The oldest deployment holds only itself — what shipped before it is unknown.
    expect(dep1!.maintenance).toBe(1);
    expect(dep1!.newFeatures).toEqual([]);
  });

  it('when HEAD is the newest deployment, that deployment is the current group', () => {
    const groups = buildGroups(history.slice(2), deployments);
    expect(groups[0]).toMatchObject({ kind: 'deployment', sha: d2.sha, current: true });
    expect(groups.filter((g) => g.kind === 'current')).toEqual([]);
  });

  it('ignores deployments outside HEAD and duplicate records', () => {
    const groups = buildGroups(history, [
      ...deployments,
      { sha: d2.sha, promoted_at: '2026-10-01T00:00:00Z' }, // re-run: first record wins
      { sha: 'f'.repeat(40), promoted_at: '2026-09-30T00:00:00Z' }, // another line of history
    ]);
    expect(groups.filter((g) => g.kind === 'deployment')).toHaveLength(2);
    expect(groups[1]!.date).toBe('2026-09-27T23:36:18Z');
  });

  it('with no deployment record, HEAD leads as "This version" and the rest groups by UTC day', () => {
    const groups = buildGroups(history, []);
    expect(groups[0]).toMatchObject({ kind: 'current', sha: history[0]!.sha });
    const entries = groups[0]!.newFeatures.length + groups[0]!.improvements.length + groups[0]!.bugFixes.length;
    expect(entries + groups[0]!.maintenance).toBe(1);
    expect(groups.slice(1).every((g) => g.kind === 'earlier')).toBe(true);
    expect(groups.slice(1).map((g) => (g.kind === 'earlier' ? g.day : ''))[0]).toBeDefined();
  });

  it('a one-commit (shallow) history is "This version" alone, never "Earlier" (owner report on 8ecbab4)', () => {
    const groups = buildGroups(history.slice(0, 1), []);
    expect(groups.map((g) => g.kind)).toEqual(['current']);
  });

  it('caps the earlier tail by days', () => {
    const groups = buildGroups(history, [], { earlierDays: 2 });
    expect(groups.filter((g) => g.kind === 'earlier').length).toBeLessThanOrEqual(2);
  });

  it('an empty history is no groups', () => {
    expect(buildGroups([], deployments)).toEqual([]);
  });
});

describe('readDeployments', () => {
  it('reports an unconfigured record instead of guessing a URL', async () => {
    expect(await readDeployments(undefined)).toEqual({ deployments: [], note: 'no deployment record configured' });
    expect(await readDeployments('')).toEqual({ deployments: [], note: 'no deployment record configured' });
  });

  it('reads a local record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rn-'));
    const file = join(dir, 'd.json');
    writeFileSync(file, JSON.stringify([{ sha: 'a'.repeat(40), promoted_at: '2026-09-27T00:00:00Z' }]));
    const res = await readDeployments(file);
    expect(res.note).toBeNull();
    expect(res.deployments).toHaveLength(1);
  });

  it('an unreadable record is a note, never a throw', async () => {
    const res = await readDeployments('/nonexistent/deployments.json');
    expect(res.deployments).toEqual([]);
    expect(res.note).toMatch(/unavailable/);
  });

  it('a record that is not an array is a note', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rn-'));
    const file = join(dir, 'd.json');
    writeFileSync(file, '{"nope":1}');
    expect((await readDeployments(file)).note).toMatch(/not a JSON array/);
  });
});

describe('parseBody', () => {
  it('strips the trailing trailer block and keeps multi-paragraph prose', () => {
    const body = [
      'First paragraph, wrapped',
      'onto a second line.',
      '',
      '  * a bullet',
      '  * another',
      '',
      'Co-Authored-By: Someone <s@example.com>',
      'Signed-off-by: Me <me@example.com>',
    ].join('\n');
    const { text, trailers } = parseBody(body);
    expect(text).toBe('First paragraph, wrapped\nonto a second line.\n\n  * a bullet\n  * another');
    expect(trailers.map((t) => t.key)).toEqual(['Co-Authored-By', 'Signed-off-by']);
  });

  it('joins indented continuation lines onto a multi-line trailer', () => {
    const { trailers } = parseBody(
      'Body.\n\nRelease-note: Threads now open in the side panel,\n  so the channel stays in view.\nRelease-note-audience: admin',
    );
    expect(trailers).toEqual([
      { key: 'Release-note', value: 'Threads now open in the side panel, so the channel stays in view.' },
      { key: 'Release-note-audience', value: 'admin' },
    ]);
  });

  it('a prose paragraph that merely contains a colon is not a trailer block', () => {
    const { text, trailers } = parseBody('Gates: the suite passed\nand the typecheck did too.');
    expect(trailers).toEqual([]);
    expect(text).toContain('Gates:');
  });

  it('an empty body is empty', () => {
    expect(parseBody(undefined)).toEqual({ text: '', trailers: [] });
  });
});

describe('resolveNote — trailer beats notes file beats the full message', () => {
  const sha = 'c'.repeat(40);
  const commit = (body: string): Commit => ({
    sha,
    short: sha.slice(0, 7),
    date: '2026-09-28T00:00:00Z',
    parents: 1,
    subject: 'fix(web): one pane ✕ and one dialog ✕',
    body,
  });
  const notes = new Map<string, CuratedNote>([[sha, { note: 'From the notes file.' }]]);

  it('the trailer wins over a notes entry', () => {
    const r = resolveNote(commit('Why.\n\nRelease-note: From the trailer.'), notes);
    expect(r).toMatchObject({ source: 'trailer', note: 'From the trailer.', detail: null, audience: 'user' });
  });

  it('the notes file wins over the message', () => {
    expect(resolveNote(commit('Why it changed.'), notes)).toMatchObject({ source: 'notes', note: 'From the notes file.' });
  });

  it('with neither, the headline is the subject description and the body is the detail, trailers stripped', () => {
    const r = resolveNote(commit('Why it changed.\n\nAnd more.\n\nCo-Authored-By: X <x@example.com>'));
    expect(r).toEqual({
      source: 'commit',
      note: 'one pane ✕ and one dialog ✕',
      detail: 'Why it changed.\n\nAnd more.',
      audience: 'user',
    });
  });

  it('a subject-only commit has no detail', () => {
    expect(resolveNote(commit('')).detail).toBeNull();
  });

  it('`Release-note: none` hides, whatever the notes file says', () => {
    expect(resolveNote(commit('Release-note: none'), notes).note).toBeNull();
    expect(resolveNote(commit('Release-note: None'), notes).note).toBeNull();
  });

  it('Release-note-audience: admin marks the trailer note admin', () => {
    const r = resolveNote(commit('Release-note: Owners can rotate bot tokens.\nRelease-note-audience: admin'));
    expect(r.audience).toBe('admin');
  });

  // 2026-10-05: a published trailer cannot be rewritten, so a notes entry
  // marked `correct: true` is how an overpromising note gets fixed.
  it('a `correct: true` notes entry wins over the trailer (a correction)', () => {
    const corrected = new Map<string, CuratedNote>([[sha, { note: 'The accurate note.', correct: true }]]);
    const r = resolveNote(commit('Why.\n\nRelease-note: The overpromising note.'), corrected);
    expect(r).toMatchObject({ source: 'notes', note: 'The accurate note.' });
    expect(normaliseNote({ note: 'x', correct: true })).toEqual({ note: 'x', correct: true });
    expect(normaliseNote({ note: 'x', correct: 'yes' })).toBeUndefined();
  });

  it('the notes file carries audience and section', () => {
    const r = resolveNote(commit('x'), new Map([[sha, { note: 'Admins can export.', audience: 'admin', section: 'newFeatures' }]]));
    expect(r).toMatchObject({ source: 'notes', audience: 'admin', section: 'newFeatures' });
  });
});

describe('normaliseNote / readNotes', () => {
  it('accepts a string, null, "none", and the object form', () => {
    expect(normaliseNote('  A note. ')).toEqual({ note: 'A note.' });
    expect(normaliseNote(null)).toEqual({ note: null });
    expect(normaliseNote('none')).toEqual({ note: null });
    expect(normaliseNote({ note: 'X.', section: 'improvements', audience: 'admin' })).toEqual({
      note: 'X.',
      section: 'improvements',
      audience: 'admin',
    });
    expect(normaliseNote({ note: null })).toEqual({ note: null });
  });

  it('rejects malformed values', () => {
    expect(normaliseNote('')).toBeUndefined();
    expect(normaliseNote(3)).toBeUndefined();
    expect(normaliseNote({ note: 'X.', section: 'misc' })).toBeUndefined();
    expect(normaliseNote({ note: 'X.', audience: 'ops' })).toBeUndefined();
  });

  it('reads the file, warns on bad entries and short shas, never throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rn-'));
    const file = join(dir, 'notes.json');
    writeFileSync(
      file,
      JSON.stringify({ notes: { ['a'.repeat(40)]: 'Good.', abc1234: 'short sha', ['b'.repeat(40)]: 42 } }),
    );
    const { notes, warnings } = readNotes(file);
    expect([...notes.keys()]).toEqual(['a'.repeat(40)]);
    expect(warnings).toHaveLength(2);
    expect(readNotes(join(dir, 'absent.json'))).toEqual({ notes: new Map(), warnings: [] });
    writeFileSync(file, '{ not json');
    expect(readNotes(file).warnings[0]).toMatch(/unreadable/);
  });
});

describe('buildGroups with notes', () => {
  const at = '2026-09-28T10:00:00Z';
  const feat = c('feat(web): terse headline', at, { body: 'Long engineering body.' });
  const hidden = c('fix(test): harness race', at);
  const admin = c('feat(server): bot token rotation', at, { body: 'Release-note: Owners can rotate a bot token.\nRelease-note-audience: admin' });
  const moved = c('feat(web): actually a fix', at);
  const choreNoted = c('chore(web): swap a dependency', at, { body: 'Release-note: The emoji picker opens faster.' });
  const raw = c('fix(web): one pane ✕', at, { body: 'Why:\n\nparagraph two.\n\nCo-Authored-By: X <x@example.com>' });
  const notes = new Map<string, CuratedNote>([
    [feat.sha, { note: 'Threads open beside the channel.' }],
    [hidden.sha, { note: null }],
    [moved.sha, { note: 'Pasting an image no longer loses it.', section: 'bugFixes' }],
  ]);
  // `base` is a deployment, so every commit above it lands in "This version".
  const base = c('ci: the deployed base', '2026-09-27T10:00:00Z');
  const [group] = buildGroups([feat, hidden, admin, moved, choreNoted, raw, base], [{ sha: base.sha }], { notes });

  it('uses the notes, hides `none` as maintenance, and honours a section override', () => {
    expect(group!.newFeatures.map((e) => [e.description, e.source])).toEqual([
      ['Threads open beside the channel.', 'notes'],
    ]);
    expect(group!.bugFixes.map((e) => e.description)).toEqual(['Pasting an image no longer loses it.', 'one pane ✕']);
    expect(group!.maintenance).toBe(1);
  });

  it('a note on a maintenance-typed commit shows under Improvements', () => {
    expect(group!.improvements.map((e) => e.description)).toEqual(['The emoji picker opens faster.']);
  });

  it('admin notes go to the group’s admin buckets, not the member lists', () => {
    expect(group!.admin).toEqual({
      newFeatures: [
        { description: 'Owners can rotate a bot token.', scope: 'server', short: admin.short, sha: admin.sha, source: 'trailer' },
      ],
      improvements: [],
      bugFixes: [],
    });
  });

  it('the fallback entry carries the full body as detail, and only it has one', () => {
    const fallback = group!.bugFixes.find((e) => e.sha === raw.sha)!;
    expect(fallback).toMatchObject({ source: 'commit', detail: 'Why:\n\nparagraph two.' });
    expect(group!.newFeatures[0]!.detail).toBeUndefined();
  });

  it('missingNotes lists exactly the displayed fallbacks', () => {
    const missing = missingNotes([group!]);
    expect(missing.map((e) => e.sha)).toEqual([raw.sha]);
    expect(formatMissing(missing, new Map([[raw.sha, raw]]))).toBe(`  ${raw.sha}  fix(web): one pane ✕`);
  });

  it('a group of only admin notes is not "empty"', () => {
    const only = c('feat(server): x', at, { body: 'Release-note: Y.\nRelease-note-audience: admin' });
    const groups = buildGroups([only], []);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.admin!.newFeatures).toHaveLength(1);
  });
});
