/**
 * @cytale/web — ReleaseNotesPane (`#/release-notes`, opened from the rail's
 * version badge).
 *
 * Takes the CENTER column (the message pane's place) and lists what changed,
 * newest first, grouped the way the owner asked (2026-09-27): by deployment,
 * then New features / Improvements / Bug fixes, with the rest counted as
 * maintenance. The grouping is done at BUILD time (scripts/release-notes.mjs)
 * — the pane only renders `/release-notes.json`, so it adds no git or
 * registry knowledge to the client and costs nothing until opened (lazy
 * chunk, fetched on open).
 *
 * States-first: loading (skeleton), error (banner + Retry), and "not
 * available" — a dev server, a test run or an image built without history
 * has no notes file, and that is a normal state, not a failure. A missing
 * file typically answers as the SPA fallback (index.html) rather than a 404,
 * so anything that is not a JSON document of the known shape reads as
 * absent.
 *
 * Each entry is one note (owner request 2026-09-28): the commit's
 * `Release-note:` trailer or its curated entry, or — when neither exists — the
 * commit's own subject with the rest of its message behind a "Details"
 * disclosure, never a truncation. Admin-only notes sit in a "For admins"
 * disclosure after the member-facing lists, collapsed by default.
 */
import { useCallback, useEffect, useId, useState } from 'react';

import { PaneEmpty, PaneErrorBanner, PaneSkeleton } from '../../app/ui/PaneStates.js';
import { versionLabel } from '../../app/version.js';
import {
  isReleaseNotesDoc,
  type NoteBuckets,
  type ReleaseNoteEntry,
  type ReleaseNotesDoc,
  type ReleaseNotesGroup,
} from './types.js';
import { paneCloseButtonClass } from '../../app/ui/button.js';

export const RELEASE_NOTES_URL = '/release-notes.json';

/** Fetch the build's notes; null when this build carries none. */
export async function fetchReleaseNotes(): Promise<ReleaseNotesDoc | null> {
  // no-cache: revalidate, so a long-lived tab that took an update reads the
  // notes of the bundle it is now running rather than a cached older list.
  const res = await fetch(RELEASE_NOTES_URL, { cache: 'no-cache' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Could not load the release notes (HTTP ${res.status}).`);
  if (!(res.headers.get('content-type') ?? '').includes('json')) return null;
  const body: unknown = await res.json().catch(() => null);
  return isReleaseNotesDoc(body) ? body : null;
}

export interface ReleaseNotesPaneProps {
  onClose(): void;
  /** Seam for tests; defaults to fetching `/release-notes.json`. */
  load?: () => Promise<ReleaseNotesDoc | null>;
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'ready'; doc: ReleaseNotesDoc | null }
  | { kind: 'error'; message: string };

export function ReleaseNotesPane({ onClose, load = fetchReleaseNotes }: ReleaseNotesPaneProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setPhase({ kind: 'loading' });
    load()
      .then((doc) => {
        if (!cancelled) setPhase({ kind: 'ready', doc });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPhase({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Could not load the release notes.',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [load, nonce]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);

  // Escape closes, like the settings panes that share column 3 (the ✕ was
  // the only way out). A Radix layer above (the command palette, a menu)
  // claims the key first and marks it handled, so it never closes both.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <section
      aria-labelledby="release-notes-title"
      data-testid="release-notes-pane"
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <header className="flex items-center gap-3 px-4 py-3 sm:px-6">
        <div className="min-w-0 flex-1">
          <h1 id="release-notes-title" className="truncate text-lg font-semibold text-text-primary">
            Release notes
          </h1>
          <p className="text-xs text-text-muted" data-testid="release-notes-running">
            You are running <span className="font-mono">{versionLabel()}</span>
          </p>
        </div>
        <button
          type="button"
          aria-label="Close release notes"
          data-testid="release-notes-close"
          className={paneCloseButtonClass}
          onClick={onClose}
        >
          ✕
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6" data-testid="release-notes-content">
        <div className="mx-auto flex max-w-2xl flex-col gap-8">
          {phase.kind === 'loading' ? (
            <PaneSkeleton label="Loading release notes" testId="release-notes-loading" rows={4} />
          ) : phase.kind === 'error' ? (
            <PaneErrorBanner
              testId="release-notes-error"
              retryTestId="release-notes-retry"
              message={phase.message}
              onRetry={retry}
            />
          ) : phase.doc === null ? (
            <PaneEmpty
              testId="release-notes-unavailable"
              title="No release notes in this build"
              hint="Release notes are generated when the app is built for deployment."
            />
          ) : phase.doc.groups.length === 0 ? (
            <PaneEmpty
              testId="release-notes-empty"
              title="Nothing recorded yet"
              hint="Changes appear here once commits are built into a release."
            />
          ) : (
            <>
              {phase.doc.deploymentsNote ? (
                <p className="text-sm text-text-muted" data-testid="release-notes-note">
                  Deployment history was not available when this build was made, so changes are grouped by
                  day.
                </p>
              ) : null}
              {phase.doc.groups.map((group) => (
                <GroupSection key={groupKey(group)} group={group} />
              ))}
              {phase.doc.historyComplete ? null : (
                <p className="text-sm text-text-muted" data-testid="release-notes-partial">
                  Earlier releases aren&apos;t listed: this build was made without the project&apos;s full history.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function groupKey(group: ReleaseNotesGroup): string {
  return group.kind === 'earlier' ? `earlier-${group.day}` : `${group.kind}-${group.sha}`;
}

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
// An "Earlier" day is a UTC calendar day; format it AS that day, never shifted
// into the viewer's zone (which could name the day before).
const utcDay = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' });

function safeFormat(format: Intl.DateTimeFormat, iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : format.format(d);
}

const bucketCount = (b: NoteBuckets | undefined): number =>
  b ? b.newFeatures.length + b.improvements.length + b.bugFixes.length : 0;

function GroupSection({ group }: { group: ReleaseNotesGroup }) {
  let title: string;
  let meta: string | null;
  if (group.kind === 'current') {
    title = 'This version';
    meta = `v${group.short} · ${safeFormat(dateTime, group.date)}`;
  } else if (group.kind === 'deployment') {
    title = group.current ? 'This version' : `v${group.short}`;
    meta = group.current
      ? `v${group.short} · deployed ${safeFormat(dateTime, group.date)}`
      : `Deployed ${safeFormat(dateTime, group.date)}`;
  } else {
    title = `Earlier — ${safeFormat(utcDay, group.date)}`;
    meta = null;
  }
  const headingId = `release-notes-${groupKey(group)}`;
  const adminCount = bucketCount(group.admin);
  const notable = bucketCount(group) + adminCount;

  return (
    <section aria-labelledby={headingId} data-testid="release-notes-group" data-kind={group.kind}>
      <div className="mb-3 border-b border-line pb-2">
        <h2 id={headingId} className="text-base font-semibold text-text-primary">
          {title}
        </h2>
        {meta ? <p className="text-xs text-text-muted">{meta}</p> : null}
      </div>
      <div className="flex flex-col gap-4">
        <Buckets buckets={group} level={3} />
        {group.admin && adminCount > 0 ? <AdminSection buckets={group.admin} count={adminCount} /> : null}
        {group.maintenance > 0 ? (
          <p className="text-sm text-text-muted" data-testid="release-notes-maintenance">
            {notable > 0 ? '+' : ''}
            {group.maintenance} maintenance {group.maintenance === 1 ? 'change' : 'changes'}
          </p>
        ) : notable === 0 ? (
          <p className="text-sm text-text-muted">No user-facing changes.</p>
        ) : null}
      </div>
    </section>
  );
}

function Buckets({ buckets, level, testIdPrefix = 'release-notes' }: { buckets: NoteBuckets; level: 3 | 4; testIdPrefix?: string }) {
  return (
    <>
      <Bucket title="New features" entries={buckets.newFeatures} testId={`${testIdPrefix}-features`} level={level} />
      <Bucket title="Improvements" entries={buckets.improvements} testId={`${testIdPrefix}-improvements`} level={level} />
      <Bucket title="Bug fixes" entries={buckets.bugFixes} testId={`${testIdPrefix}-fixes`} level={level} />
    </>
  );
}

/** Notes for workspace/server admins: a disclosure, collapsed by default. */
function AdminSection({ buckets, count }: { buckets: NoteBuckets; count: number }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div data-testid="release-notes-admin" className="rounded-md border border-line">
      <h3 className="text-sm font-semibold text-text-primary">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          data-testid="release-notes-admin-toggle"
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
        >
          <span aria-hidden="true" className="inline-block w-3 text-text-muted">
            {open ? '▾' : '▸'}
          </span>
          For admins ({count})
        </button>
      </h3>
      <div id={panelId} hidden={!open} className="flex flex-col gap-4 px-3 pb-3 pt-1">
        {open ? <Buckets buckets={buckets} level={4} testIdPrefix="release-notes-admin" /> : null}
      </div>
    </div>
  );
}

function Bucket({
  title,
  entries,
  testId,
  level,
}: {
  title: string;
  entries: ReleaseNoteEntry[];
  testId: string;
  level: 3 | 4;
}) {
  if (entries.length === 0) return null;
  const Heading = level === 3 ? 'h3' : 'h4';
  return (
    <div data-testid={testId}>
      <Heading className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-text-muted">{title}</Heading>
      <ul className="flex flex-col gap-1.5">
        {entries.map((entry) => (
          <Entry key={entry.sha} entry={entry} />
        ))}
      </ul>
    </div>
  );
}

function Entry({ entry }: { entry: ReleaseNoteEntry }) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  // A curated note speaks for itself; the scope chip (web, server …) only
  // helps read a raw commit subject.
  const fallback = entry.source === undefined || entry.source === 'commit';
  return (
    <li className="text-sm text-text-primary" data-testid="release-notes-entry" data-source={entry.source ?? 'commit'}>
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1">
          {fallback && entry.scope ? (
            <span className="mr-1.5 inline-block rounded bg-surface-hover px-1.5 align-baseline text-[11px] leading-5 text-text-muted">
              {entry.scope}
            </span>
          ) : null}
          {entry.description}
          {entry.detail ? (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={detailId}
              data-testid="release-notes-detail-toggle"
              onClick={() => setOpen((o) => !o)}
              className="ml-1.5 rounded px-1 text-xs text-text-muted underline-offset-2 hover:text-text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
            >
              {open ? 'Hide details' : 'Details'}
            </button>
          ) : null}
        </span>
        <span className="shrink-0 font-mono text-xs text-text-muted" title={entry.sha}>
          {entry.short}
        </span>
      </div>
      {entry.detail ? (
        <div
          id={detailId}
          hidden={!open}
          data-testid="release-notes-detail"
          className="mt-1.5 flex flex-col gap-2 border-l-2 border-line pl-3 text-[13px] leading-relaxed text-text-muted"
        >
          {open ? <Detail text={entry.detail} /> : null}
        </div>
      ) : null}
    </li>
  );
}

type DetailBlock = { kind: 'p'; text: string } | { kind: 'ul'; items: string[] };

const BULLET = /^\s*[*•-]\s+/;

/**
 * A commit body as readable blocks: paragraphs unwrapped (the author's hard
 * wraps become spaces) and `*`/`-` bullets as a list, with indented lines
 * continuing the bullet above them.
 */
export function detailBlocks(text: string): DetailBlock[] {
  const blocks: DetailBlock[] = [];
  for (const para of text.split(/\n[ \t]*\n/)) {
    let prose: string[] = [];
    let items: string[] = [];
    const flushProse = () => {
      if (prose.length > 0) blocks.push({ kind: 'p', text: prose.join(' ') });
      prose = [];
    };
    const flushItems = () => {
      if (items.length > 0) blocks.push({ kind: 'ul', items });
      items = [];
    };
    for (const raw of para.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (BULLET.test(raw)) {
        flushProse();
        items.push(raw.replace(BULLET, '').trim());
      } else if (items.length > 0 && /^\s/.test(raw)) {
        items[items.length - 1] = `${items[items.length - 1]} ${line}`;
      } else {
        flushItems();
        prose.push(line);
      }
    }
    flushProse();
    flushItems();
  }
  return blocks;
}

function Detail({ text }: { text: string }) {
  return (
    <>
      {detailBlocks(text).map((b, i) =>
        b.kind === 'p' ? (
          <p key={i} className="break-words">
            {b.text}
          </p>
        ) : (
          <ul key={i} className="list-disc space-y-1 pl-5">
            {b.items.map((item, j) => (
              <li key={j} className="break-words">
                {item}
              </li>
            ))}
          </ul>
        ),
      )}
    </>
  );
}
