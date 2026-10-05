/**
 * ReleaseNotesPane + its route + the version badge that opens it.
 *
 * Owner request (2026-09-27): the version becomes a link that replaces the
 * center column with release notes, grouped by deployment and then by New
 * features / Improvements / Bug fixes. States-first: loading, error (Retry),
 * and "not available" (a build without the notes file) are all real states.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { AxeMatchers } from 'vitest-axe/matchers';

import { VersionBadge } from '../../../app/layout/VersionBadge.js';
import { detailBlocks, fetchReleaseNotes, ReleaseNotesPane } from '../ReleaseNotesPane.js';
import { parseReleaseNotesPath, useReleaseNotesRoute } from '../router.js';
import type { ReleaseNotesDoc } from '../types.js';

declare module 'vitest' {
  interface Assertion<T> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}

const DOC: ReleaseNotesDoc = {
  version: 1,
  generatedAt: '2026-09-28T10:05:00Z',
  head: { sha: 'a'.repeat(40), short: 'aaaaaaa', date: '2026-09-28T10:00:00Z' },
  historyComplete: true,
  deploymentsNote: null,
  groups: [
    {
      kind: 'current',
      sha: 'a'.repeat(40),
      short: 'aaaaaaa',
      date: '2026-09-28T10:00:00Z',
      newFeatures: [{ description: 'release notes behind the version badge', scope: 'web', short: 'aaaaaaa', sha: 'a'.repeat(40) }],
      improvements: [],
      bugFixes: [{ description: 'a thing no longer breaks', scope: null, short: 'bbbbbbb', sha: 'b'.repeat(40) }],
      maintenance: 3,
    },
    {
      kind: 'deployment',
      sha: 'd'.repeat(40),
      short: 'd4671ef',
      date: '2026-09-27T23:36:18Z',
      current: false,
      newFeatures: [],
      improvements: [{ description: 'menus align', scope: 'web', short: 'ea8d269', sha: 'e'.repeat(40) }],
      bugFixes: [],
      maintenance: 0,
    },
    {
      kind: 'earlier',
      day: '2026-09-25',
      date: '2026-09-25T00:00:00Z',
      newFeatures: [],
      improvements: [],
      bugFixes: [],
      maintenance: 1,
    },
  ],
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ReleaseNotesPane', () => {
  it('shows the loading skeleton until the notes arrive', async () => {
    let resolve!: (d: ReleaseNotesDoc) => void;
    render(<ReleaseNotesPane onClose={() => {}} load={() => new Promise((r) => (resolve = r))} />);
    expect(screen.getByTestId('release-notes-loading')).toBeTruthy();
    await act(async () => resolve(DOC));
    expect(screen.queryByTestId('release-notes-loading')).toBeNull();
  });

  it('renders each group with its buckets, omitting empty ones', async () => {
    render(<ReleaseNotesPane onClose={() => {}} load={async () => DOC} />);
    const groups = await screen.findAllByTestId('release-notes-group');
    expect(groups.map((g) => g.getAttribute('data-kind'))).toEqual(['current', 'deployment', 'earlier']);

    const [current, deployment, earlier] = groups as [HTMLElement, HTMLElement, HTMLElement];
    expect(within(current).getByRole('heading', { level: 2 }).textContent).toBe('This version');
    expect(within(current).getByRole('heading', { name: 'New features' })).toBeTruthy();
    expect(within(current).getByRole('heading', { name: 'Bug fixes' })).toBeTruthy();
    expect(within(current).queryByRole('heading', { name: 'Improvements' })).toBeNull();
    expect(within(current).getByText('release notes behind the version badge')).toBeTruthy();
    expect(within(current).getByText('web')).toBeTruthy(); // the scope chip
    expect(within(current).getByText('aaaaaaa')).toBeTruthy(); // the short sha
    expect(within(current).getByTestId('release-notes-maintenance').textContent).toBe(
      '+3 maintenance changes',
    );

    expect(within(deployment).getByRole('heading', { level: 2 }).textContent).toBe('vd4671ef');
    expect(within(deployment).getByText(/^Deployed /)).toBeTruthy();
    expect(within(deployment).getByRole('heading', { name: 'Improvements' })).toBeTruthy();
    expect(within(deployment).queryByTestId('release-notes-maintenance')).toBeNull();

    expect(within(earlier).getByRole('heading', { level: 2 }).textContent).toMatch(/^Earlier — .*25/);
    expect(within(earlier).getByTestId('release-notes-maintenance').textContent).toBe(
      '1 maintenance change',
    );
  });

  it('a build without notes says so (not an error)', async () => {
    render(<ReleaseNotesPane onClose={() => {}} load={async () => null} />);
    expect(await screen.findByTestId('release-notes-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('release-notes-error')).toBeNull();
  });

  it('an empty document is the empty state', async () => {
    render(<ReleaseNotesPane onClose={() => {}} load={async () => ({ ...DOC, groups: [] })} />);
    expect(await screen.findByTestId('release-notes-empty')).toBeTruthy();
  });

  it('says when deployment history was unavailable at build time', async () => {
    render(
      <ReleaseNotesPane
        onClose={() => {}}
        load={async () => ({ ...DOC, deploymentsNote: 'deployment record unavailable (HTTP 500)' })}
      />,
    );
    expect(await screen.findByTestId('release-notes-note')).toBeTruthy();
  });

  it('a failed load shows the error banner and Retry loads again', async () => {
    const load = vi
      .fn<() => Promise<ReleaseNotesDoc | null>>()
      .mockRejectedValueOnce(new Error('Could not load the release notes (HTTP 502).'))
      .mockResolvedValueOnce(DOC);
    render(<ReleaseNotesPane onClose={() => {}} load={load} />);
    expect((await screen.findByTestId('release-notes-error')).textContent).toContain('HTTP 502');
    fireEvent.click(screen.getByTestId('release-notes-retry'));
    expect(await screen.findAllByTestId('release-notes-group')).toHaveLength(3);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('the close button calls onClose', async () => {
    const onClose = vi.fn();
    render(<ReleaseNotesPane onClose={onClose} load={async () => DOC} />);
    await screen.findAllByTestId('release-notes-group');
    fireEvent.click(screen.getByRole('button', { name: 'Close release notes' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape closes, like the settings panes beside it', async () => {
    const onClose = vi.fn();
    render(<ReleaseNotesPane onClose={onClose} load={async () => DOC} />);
    await screen.findAllByTestId('release-notes-group');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('an Escape a layer above already handled does not also close the pane', async () => {
    const onClose = vi.fn();
    render(<ReleaseNotesPane onClose={onClose} load={async () => DOC} />);
    await screen.findAllByTestId('release-notes-group');
    const claim = (e: KeyboardEvent) => e.preventDefault();
    document.addEventListener('keydown', claim, { capture: true });
    try {
      fireEvent.keyDown(document, { key: 'Escape' });
    } finally {
      document.removeEventListener('keydown', claim, { capture: true });
    }
    expect(onClose).not.toHaveBeenCalled();
  });

  it('has no axe violations with notes rendered', async () => {
    const { container } = render(<ReleaseNotesPane onClose={() => {}} load={async () => DOC} />);
    await screen.findAllByTestId('release-notes-group');
    expect(await axe(container)).toHaveNoViolations();
  });
});

/** Curated notes, a raw-commit fallback with a body, and admin notes. */
const NOTED: ReleaseNotesDoc = {
  ...DOC,
  groups: [
    {
      kind: 'current',
      sha: 'a'.repeat(40),
      short: 'aaaaaaa',
      date: '2026-09-28T10:00:00Z',
      newFeatures: [
        {
          description: 'You can now open a thread beside the channel.',
          scope: 'web',
          short: 'aaaaaaa',
          sha: 'a'.repeat(40),
          source: 'notes',
        },
      ],
      improvements: [],
      bugFixes: [
        {
          description: 'one pane ✕ and one dialog ✕',
          scope: 'web',
          short: 'bbbbbbb',
          sha: 'b'.repeat(40),
          source: 'commit',
          detail: 'Every pane had its own close glyph,\nso they disagreed.\n\n  * panes use one ✕\n  * dialogs use one ✕',
        },
      ],
      admin: {
        newFeatures: [
          { description: 'Owners can rotate a bot token.', scope: 'server', short: 'ccccccc', sha: 'c'.repeat(40), source: 'trailer' },
        ],
        improvements: [],
        bugFixes: [
          { description: 'Backups no longer skip uploads.', scope: 'server', short: 'ddddddd', sha: 'd'.repeat(40), source: 'notes' },
        ],
      },
      maintenance: 2,
    },
  ],
};

describe('ReleaseNotesPane — notes, details and the admin section', () => {
  it('renders a curated note as the entry, without the scope chip', async () => {
    render(<ReleaseNotesPane onClose={() => {}} load={async () => NOTED} />);
    const features = await screen.findByTestId('release-notes-features');
    const entry = within(features).getByTestId('release-notes-entry');
    expect(entry.getAttribute('data-source')).toBe('notes');
    expect(within(entry).getByText('You can now open a thread beside the channel.')).toBeTruthy();
    expect(within(entry).queryByText('web')).toBeNull();
    expect(within(entry).queryByTestId('release-notes-detail-toggle')).toBeNull();
  });

  it('a fallback shows the full subject, with the body behind a Details disclosure that toggles by keyboard', async () => {
    const user = userEvent.setup();
    render(<ReleaseNotesPane onClose={() => {}} load={async () => NOTED} />);
    const fixes = await screen.findByTestId('release-notes-fixes');
    expect(within(fixes).getByText('one pane ✕ and one dialog ✕')).toBeTruthy();
    const toggle = within(fixes).getByRole('button', { name: 'Details' });
    const detail = within(fixes).getByTestId('release-notes-detail');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe(detail.id);
    expect(detail.hidden).toBe(true);

    toggle.focus();
    await user.keyboard('{Enter}');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(detail.hidden).toBe(false);
    // Hard wraps unwrap into one paragraph; bullets become a list.
    expect(within(detail).getByText('Every pane had its own close glyph, so they disagreed.').tagName).toBe('P');
    expect(within(detail).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'panes use one ✕',
      'dialogs use one ✕',
    ]);
    expect(toggle.textContent).toBe('Hide details');

    await user.keyboard(' ');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(detail.hidden).toBe(true);
  });

  it('admin notes sit in a "For admins" disclosure, collapsed by default, opened by keyboard', async () => {
    const user = userEvent.setup();
    render(<ReleaseNotesPane onClose={() => {}} load={async () => NOTED} />);
    const admin = await screen.findByTestId('release-notes-admin');
    const toggle = within(admin).getByRole('button', { name: 'For admins (2)' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(within(admin).queryByText('Owners can rotate a bot token.')).toBeNull();
    // Member-facing lists never carry the admin notes.
    expect(screen.queryByText('Backups no longer skip uploads.')).toBeNull();

    toggle.focus();
    await user.keyboard('{Enter}');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(within(admin).getByRole('heading', { level: 4, name: 'New features' })).toBeTruthy();
    expect(within(admin).getByText('Owners can rotate a bot token.')).toBeTruthy();
    expect(within(admin).getByText('Backups no longer skip uploads.')).toBeTruthy();
    expect(screen.getByTestId('release-notes-maintenance').textContent).toBe('+2 maintenance changes');
  });

  it('a group with no admin notes has no admin section', async () => {
    render(<ReleaseNotesPane onClose={() => {}} load={async () => DOC} />);
    await screen.findAllByTestId('release-notes-group');
    expect(screen.queryByTestId('release-notes-admin')).toBeNull();
  });

  it('has no axe violations collapsed, and none with details and the admin section open', async () => {
    const { container } = render(<ReleaseNotesPane onClose={() => {}} load={async () => NOTED} />);
    await screen.findAllByTestId('release-notes-group');
    expect(await axe(container)).toHaveNoViolations();
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    fireEvent.click(screen.getByRole('button', { name: 'For admins (2)' }));
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('detailBlocks', () => {
  it('unwraps paragraphs, lists bullets and continues indented bullet lines', () => {
    expect(detailBlocks('A wrapped\nline.\n\nIntro:\n  * one\n    continued\n  - two\n\nTail.')).toEqual([
      { kind: 'p', text: 'A wrapped line.' },
      { kind: 'p', text: 'Intro:' },
      { kind: 'ul', items: ['one continued', 'two'] },
      { kind: 'p', text: 'Tail.' },
    ]);
  });
});

describe('fetchReleaseNotes', () => {
  const respond = (body: string, init: ResponseInit) =>
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, init));

  it('reads the document', async () => {
    respond(JSON.stringify(DOC), { status: 200, headers: { 'content-type': 'application/json' } });
    expect(await fetchReleaseNotes()).toEqual(DOC);
  });

  it('a 404 is "not available"', async () => {
    respond('', { status: 404 });
    expect(await fetchReleaseNotes()).toBeNull();
  });

  it('the SPA fallback (index.html for a missing file) is "not available"', async () => {
    respond('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } });
    expect(await fetchReleaseNotes()).toBeNull();
  });

  it('an unknown document shape is "not available"', async () => {
    respond('{"version":2}', { status: 200, headers: { 'content-type': 'application/json' } });
    expect(await fetchReleaseNotes()).toBeNull();
  });

  it('a server error is an error', async () => {
    respond('', { status: 500 });
    await expect(fetchReleaseNotes()).rejects.toThrow(/HTTP 500/);
  });
});

describe('release-notes route + version badge', () => {
  beforeEach(() => {
    window.location.hash = '';
  });

  it('parses the route', () => {
    expect(parseReleaseNotesPath('/release-notes').open).toBe(true);
    expect(parseReleaseNotesPath('/').open).toBe(false);
    expect(parseReleaseNotesPath('/settings/account').open).toBe(false);
  });

  function Probe() {
    const route = useReleaseNotesRoute();
    return (
      <>
        <VersionBadge />
        <span data-testid="probe-open">{String(route.open)}</span>
        <button type="button" onClick={route.close}>
          close
        </button>
      </>
    );
  }

  it('the badge is a link to #/release-notes, and clicking it opens the notes', async () => {
    render(<Probe />);
    const badge = screen.getByTestId('rail-version');
    expect(badge.tagName).toBe('A');
    expect(badge.getAttribute('href')).toBe('#/release-notes');
    fireEvent.click(badge);
    await waitFor(() => expect(screen.getByTestId('probe-open').textContent).toBe('true'));
    expect(window.location.hash).toBe('#/release-notes');
    expect(badge.getAttribute('aria-current')).toBe('page');
  });

  it('close after a badge click steps BACK to where the member was', async () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    render(<Probe />);
    fireEvent.click(screen.getByTestId('rail-version'));
    await waitFor(() => expect(screen.getByTestId('probe-open').textContent).toBe('true'));
    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('close on a deep link (nothing of ours behind it) goes to the root', async () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    window.location.hash = '#/release-notes';
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('probe-open').textContent).toBe('true'));
    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    expect(back).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('probe-open').textContent).toBe('false'));
  });
});
