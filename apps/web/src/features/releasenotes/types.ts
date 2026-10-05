/**
 * @cytale/web — the release-notes document (`/release-notes.json`).
 *
 * Written at build time by scripts/release-notes.mjs from the git history and
 * the deployment record deploy.yml keeps; this module is the reader's view of
 * that shape. `version` guards the contract: a document the pane does not
 * understand renders as "not available", never as a half-parsed list.
 */

export interface ReleaseNoteEntry {
  /**
   * The note: a commit's `Release-note:` trailer, else its curated entry in
   * docs/release-notes/notes.json, else (source "commit") the subject without
   * its `type(scope):` prefix.
   */
  description: string;
  /** `feat(web): …` → "web"; null when the subject carried none. */
  scope: string | null;
  short: string;
  sha: string;
  /** Where `description` came from. Absent in documents older than the field. */
  source?: 'trailer' | 'notes' | 'commit';
  /**
   * Only on a "commit" fallback: the rest of the commit message (trailers
   * stripped), shown collapsed under the headline. Paragraphs are separated
   * by a blank line; lines inside one are the author's hard wraps.
   */
  detail?: string;
}

export interface NoteBuckets {
  newFeatures: ReleaseNoteEntry[];
  improvements: ReleaseNoteEntry[];
  bugFixes: ReleaseNoteEntry[];
}

interface GroupBody extends NoteBuckets {
  /**
   * Notes for people who run or administer a workspace or server
   * (`Release-note-audience: admin`), shown in a collapsed section. Absent in
   * documents older than the field.
   */
  admin?: NoteBuckets;
  /** test/ci/docs/chore/refactor/build… and hidden notes — counted, not listed. */
  maintenance: number;
}

/** Commits after the newest deployment, up to the build's own commit. */
export interface CurrentGroup extends GroupBody {
  kind: 'current';
  sha: string;
  short: string;
  /** HEAD's commit date (ISO UTC). */
  date: string;
}

/** One promotion to production: (previous deployment, this one]. */
export interface DeploymentGroup extends GroupBody {
  kind: 'deployment';
  sha: string;
  short: string;
  /** When deploy.yml promoted it (ISO UTC). */
  date: string;
  /** This build IS the deployment. */
  current: boolean;
}

/** Older than any recorded deployment: one UTC calendar day. */
export interface EarlierGroup extends GroupBody {
  kind: 'earlier';
  /** YYYY-MM-DD (UTC). */
  day: string;
  date: string;
}

export type ReleaseNotesGroup = CurrentGroup | DeploymentGroup | EarlierGroup;

export interface ReleaseNotesDoc {
  version: 1;
  generatedAt: string;
  head: { sha: string; short: string; date: string } | null;
  /** False when the build's checkout was shallow — the list is truncated. */
  historyComplete: boolean;
  /** Set when the deployment record could not be read (grouping is by day). */
  deploymentsNote: string | null;
  groups: ReleaseNotesGroup[];
}

/** Narrow an unknown JSON value to a document this reader understands. */
export function isReleaseNotesDoc(value: unknown): value is ReleaseNotesDoc {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<ReleaseNotesDoc>;
  return v.version === 1 && Array.isArray(v.groups);
}
