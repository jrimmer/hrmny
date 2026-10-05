// Types for scripts/release-notes.mjs — its unit tests run in the web vitest
// suite (apps/web/src/features/releasenotes/__tests__/generator.test.ts),
// which type-checks under the web tsconfig. The document shape itself is
// apps/web/src/features/releasenotes/types.ts.

export const EARLIER_DAYS: number;
export const DEFAULT_NOTES: string;

export interface Commit {
  sha: string;
  short: string;
  /** ISO UTC. */
  date: string;
  /** Parent count — more than one is a merge. */
  parents: number;
  subject: string;
  /** The message after the subject line (`%b`); absent = no body. */
  body?: string;
}

export type Section = 'newFeatures' | 'improvements' | 'bugFixes';
export type Audience = 'user' | 'admin';

/** A notes-file entry after normalising; `note: null` hides the commit. */
export interface CuratedNote {
  note: string | null;
  section?: Section;
  audience?: Audience;
  /** A correction: wins over the commit's own Release-note trailer. */
  correct?: true;
}

export interface ResolvedNote {
  source: 'trailer' | 'notes' | 'commit';
  note: string | null;
  detail: string | null;
  audience: Audience;
  section?: Section;
}

export interface Deployment {
  sha: string;
  short?: string;
  promoted_at?: string;
}

export function parseSubject(subject: string): {
  type: string | null;
  scope: string | null;
  description: string;
};
export function classify(type: string | null): 'newFeatures' | 'improvements' | 'bugFixes' | null;
export function parseBody(body: string | undefined): { text: string; trailers: { key: string; value: string }[] };
export function normaliseNote(value: unknown): CuratedNote | undefined;
export function readNotes(file?: string): { notes: Map<string, CuratedNote>; warnings: string[] };
export function resolveNote(commit: Commit, notes?: Map<string, CuratedNote>): ResolvedNote;
export function buildGroups(
  commits: Commit[],
  deployments: unknown,
  options?: { earlierDays?: number; notes?: Map<string, CuratedNote> },
): import('../apps/web/src/features/releasenotes/types.js').ReleaseNotesGroup[];
export function missingNotes(
  groups: import('../apps/web/src/features/releasenotes/types.js').ReleaseNotesGroup[],
): import('../apps/web/src/features/releasenotes/types.js').ReleaseNoteEntry[];
export function formatMissing(
  missing: import('../apps/web/src/features/releasenotes/types.js').ReleaseNoteEntry[],
  commitsBySha?: Map<string, Commit>,
): string;
export function readCommits(cwd?: string): Commit[];
export function readDeployments(source: string | undefined): Promise<{ deployments: Deployment[]; note: string | null }>;
