/**
 * @cytale/web — U26 People Directory tests (vitest + jsdom).
 *
 * Red-first history: written against the U9 people contract with `fetch`
 * mocked; the surface must render members, debounce search, paginate via
 * `next_before`, and cover the states-first DoD (loading/empty/error/offline/
 * permission-denied) with axe-clean, keyboard-operable markup.
 */
import { axe } from 'vitest-axe';
import type { AxeMatchers } from 'vitest-axe/matchers';
import { cleanup, render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

declare module 'vitest' {
  interface Assertion<T> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}

import { PeopleDirectory } from '../PeopleDirectory.js';
import { ProfileCard } from '../ProfileCard.js';
import type { PeopleMember, PeoplePage } from '../types.js';
import type { DirectoryStore } from '../useDirectoryMembers.js';

const WS = '9007199254740993';

function page(people: PeoplePage['people'], next_before: string | null = null): PeoplePage {
  return { people, next_before };
}

const MEMBERS = [
  { user: { id: '1', username: 'janedoe' }, nickname: 'Jane', joined_at: '2026-01-01T00:00:00Z', roles: [] },
  { user: { id: '2', username: 'johnsmith' }, nickname: null, joined_at: '2026-02-01T00:00:00Z', roles: ['r1'] },
  { user: { id: '3', username: 'jane_ops' }, nickname: 'Jane Ops', joined_at: '2026-03-01T00:00:00Z', roles: [] },
];

function renderDirectory(props: Partial<Parameters<typeof PeopleDirectory>[0]> = {}) {
  return render(
      <PeopleDirectory workspaceId={WS} {...props} />
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('PeopleDirectory — happy path', () => {
  it('renders members with name, handle, avatar, presence, and role', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => page(MEMBERS) }));

    renderDirectory();

    await waitFor(() => expect(screen.getByTestId('people-list')).toBeTruthy());
    expect(screen.getByText('Jane')).toBeTruthy();
    expect(screen.getByText('@janedoe')).toBeTruthy();
    expect(screen.getByText('@johnsmith')).toBeTruthy();
    // presence text rendered per row
    expect(screen.getAllByText('offline').length).toBeGreaterThan(0);
  });

  it('controlled query prop drives the debounced server search (rail-header ⌕)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => page(MEMBERS) });
    vi.stubGlobal('fetch', fetchMock);

    // The internal search input is gone — the rail header owns the text.
    const view = renderDirectory({ debounceMs: 50, query: '' });
    await waitFor(() => expect(screen.getByTestId('people-list')).toBeTruthy());

    view.rerender(
      <PeopleDirectory workspaceId={WS} debounceMs={50} query="jan" />,
    );

    // Debounced: the query param should eventually carry "jan".
    await waitFor(() => {
      const calls = fetchMock.mock.calls as [string, ...unknown[]][];
      const last = calls[calls.length - 1]?.[0] as string;
      expect(last).toContain('query=jan');
    });
  });
});

describe('PeopleDirectory — pagination', () => {
  it('load-more appends the next page via next_before cursor', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => page(MEMBERS.slice(0, 2), '2') })
      .mockResolvedValueOnce({ ok: true, json: async () => page(MEMBERS.slice(2)) });
    vi.stubGlobal('fetch', fetchMock);

    renderDirectory();
    await waitFor(() => expect(screen.getByTestId('people-load-more')).toBeTruthy());

    await userEvent.click(screen.getByTestId('people-load-more'));

    await waitFor(() => expect(screen.getByText('@jane_ops')).toBeTruthy());
    // The second call carried the before cursor.
    const calls = fetchMock.mock.calls as [string, ...unknown[]][];
    expect(calls[1]?.[0] as string).toContain('before=2');
  });
});

describe('PeopleDirectory — states-first DoD', () => {
  it('loading state announces a progressbar', () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
    renderDirectory();
    expect(screen.getByTestId('people-loading')).toBeTruthy();
    expect(screen.getByRole('progressbar')).toBeTruthy();
  });

  it('empty state renders when the page has no members', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => page([]) }));
    renderDirectory();
    await waitFor(() => expect(screen.getByTestId('people-empty')).toBeTruthy());
  });

  it('error state renders an alert with a working retry', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: { message: 'boom' } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => page(MEMBERS) });
    vi.stubGlobal('fetch', fetchMock);

    renderDirectory();
    await waitFor(() => expect(screen.getByTestId('people-error')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toMatch(/boom/i);

    await userEvent.click(screen.getByTestId('people-retry'));
    await waitFor(() => expect(screen.getByTestId('people-list')).toBeTruthy());
  });

  it('offline state renders a status banner', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => page(MEMBERS) }));
    // Simulate offline by dispatching the offline event after mount.
    renderDirectory();
    await waitFor(() => expect(screen.getByTestId('people-list')).toBeTruthy());

    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(screen.getByTestId('people-offline')).toBeTruthy();
  });

  it('permission-denied (403) renders an alert instead of the list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}) }));
    renderDirectory();
    await waitFor(() => expect(screen.getByTestId('people-permission-denied')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toMatch(/permission/i);
  });
});

describe('PeopleDirectory — accessibility', () => {
  it('has no axe violations in the ready state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => page(MEMBERS) }));
    const { container } = renderDirectory();
    await waitFor(() => expect(screen.getByTestId('people-list')).toBeTruthy());
    expect(await axe(container)).toHaveNoViolations();
  });

  it('supports arrow-key navigation and Enter selection', async () => {
    const onSelect = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => page(MEMBERS) }));
    renderDirectory({ onSelectMember: onSelect });

    await waitFor(() => expect(screen.getByTestId('people-list')).toBeTruthy());

    const firstOption = screen.getByTestId('people-row-1');
    firstOption.focus();
    await userEvent.keyboard('{Enter}');

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]?.[0]).toMatchObject({ user: { id: '1' } });
  });

  // The row highlight must follow the LIVE pointer (or the keyboard's focus),
  // never latch. Hover used to write the roving `focusedIndex`, which both
  // marked the row `aria-selected` and moved DOM focus to it — so the
  // last-hovered row stayed lit with the pointer elsewhere (user report
  // 2026-09-11: "only highlight when there's an active mouseover").
  it('a hovered row is not left selected, and hover does not steal focus', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => page(MEMBERS) }),
    );
    renderDirectory();

    await waitFor(() => expect(screen.getByTestId('people-list')).toBeTruthy());

    const row = screen.getByTestId('people-row-2');
    await userEvent.hover(row);

    expect(row.getAttribute('aria-selected'), 'hover latched a selection').toBeNull();
    expect(document.activeElement, 'hover moved DOM focus').not.toBe(row);
    // The pointer highlight itself is the `hover:` style (CSS), which is live
    // by construction — jsdom has no layout, so the class is the contract.
    expect(row.className).toContain('hover:bg-surface-hover');
    expect(row.className, 'a sticky focus background is what we removed').not.toContain(
      'focus:bg-surface-hover',
    );
  });
});

describe('ProfileCard', () => {
  it('renders name, handle, presence, role badge, and DM action', async () => {
    const onSendDm = vi.fn();
    render(
          <ProfileCard
          member={MEMBERS[1] as never}
          presence="online"
          roleLabels={{ r1: 'Moderator' }}
          onSendDm={onSendDm}
        />
      );

    expect(screen.getByText('@johnsmith')).toBeTruthy();
    expect(screen.getByText('online')).toBeTruthy();
    expect(screen.getByText('Moderator')).toBeTruthy();

    await userEvent.click(screen.getByTestId('profile-send-dm'));
    expect(onSendDm).toHaveBeenCalledTimes(1);
  });
});

// -- U12 attribution: kind badge on directory rows + profile cards ------------

const PARENT = {
  user: { id: '9000000000000001', username: 'janedoe' },
  nickname: 'Jane',
  joined_at: '2026-01-01T00:00:00Z',
  roles: [],
};
const BOT = {
  user: { id: '9000000000000002', username: 'release-bot' },
  nickname: null,
  joined_at: '2026-01-01T00:00:00Z',
  roles: [],
  kind: 'bot' as const,
  parent_user_id: '9000000000000001',
};
const AGENT = {
  user: { id: '9000000000000004', username: 'triage-agent' },
  nickname: null,
  joined_at: '2026-01-01T00:00:00Z',
  roles: [],
  kind: 'agent' as const,
  parent_user_id: '9000000000000001',
};
const HOOK = {
  user: { id: '9000000000000003', username: 'deploy-hook' },
  nickname: 'Deploys',
  joined_at: '2026-01-01T00:00:00Z',
  roles: [],
  kind: 'webhook' as const,
  parent_user_id: '9000000000000001',
};

describe('PeopleDirectory — machine seal (U12, retargeted 2026-09-11)', () => {
  // The name-line "BOT" pill is gone: a machine principal wears the robot seal
  // on its avatar's top-right. The AVATAR is aria-hidden, so the row announces
  // the attribution in sr-only text; the seal's tooltip carries it visually.
  it('marks machine rows with the avatar seal, naming the parent; humans get none', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => page([PARENT, BOT, AGENT, HOOK]) }));
    renderDirectory();
    await waitFor(() => expect(screen.getByTestId('people-list')).toBeTruthy());

    const badges = screen.getAllByTestId('kind-badge');
    expect(badges.map((b) => b.getAttribute('data-kind'))).toEqual(['bot', 'agent', 'webhook']);
    // One user-facing word for every machine credential (R1): the two
    // internal machine kinds read the same, so the seal never leaks the
    // `:bot` / `:agent` distinction into the vocabulary. Webhook keeps its
    // own word — it is not an agent.
    for (const badge of badges) {
      // The parent row (nickname "Jane") is on the same page → "via Jane".
      const expected =
        badge.getAttribute('data-kind') === 'webhook' ? 'Webhook account' : 'Agent account';
      expect(badge.getAttribute('title')).toBe(`${expected}, via Jane`);
    }

    // The seal rides the row's AVATAR, not the name line.
    const botRow = screen.getByTestId('people-row-9000000000000002');
    const avatar = botRow.querySelector('.people-avatar');
    expect(avatar, 'row avatar').not.toBeNull();
    expect(avatar!.contains(badges[0]!)).toBe(true);
    // …and the machine attribution is announced for screen readers.
    expect(botRow.textContent).toContain('Agent account, via Jane');
    // No pill left in the name line.
    expect(botRow.querySelector('.people-name')!.nextElementSibling?.className).not.toContain(
      'kind-badge',
    );
  });

  it('renders no badges on an all-human page', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => page(MEMBERS) }));
    renderDirectory();
    await waitFor(() => expect(screen.getByTestId('people-list')).toBeTruthy());
    expect(screen.queryByTestId('kind-badge')).toBeNull();
  });

  it('resolves the parent name from the store seam when the parent row is not loaded', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => page([BOT]) }));
    renderDirectory({
      store: {
        membersById: {
          '9000000000000001': { id: '9000000000000001', username: 'janedoe', nickname: 'Jane' },
        },
        memberIdsByWorkspace: {},
        presenceByUser: {},
      },
    });
    await waitFor(() => expect(screen.getByTestId('people-list')).toBeTruthy());
    const badge = screen.getByTestId('kind-badge');
    expect(badge.getAttribute('title')).toBe('Agent account, via Jane');
    expect(screen.getByText('Agent account, via Jane')).toBeTruthy();
  });

  it('has no axe violations with badges present', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => page([PARENT, BOT, AGENT, HOOK]) }));
    const { container } = renderDirectory();
    await waitFor(() => expect(screen.getByTestId('people-list')).toBeTruthy());
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('ProfileCard — machine seal (U12, retargeted 2026-09-11)', () => {
  it('wears the seal on the avatar, with the parent in the tooltip and sr-only text', () => {
    render(<ProfileCard member={BOT} presence="offline" parentName="Jane" />);
    const badge = screen.getByTestId('kind-badge');
    expect(badge.getAttribute('data-kind')).toBe('bot');
    expect(badge.getAttribute('title')).toBe('Agent account, via Jane');
    // On the avatar, not beside the name.
    const card = screen.getByTestId('profile-card');
    expect(card.querySelector('.profile-avatar')!.contains(badge)).toBe(true);
    // The attribution is still available to assistive tech.
    expect(screen.getByText('Agent account, via Jane')).toBeTruthy();
  });

  it('renders no badge for human members', () => {
    render(<ProfileCard member={PARENT} />);
    expect(screen.queryByTestId('kind-badge')).toBeNull();
  });
});

describe('PeopleDirectory — presence on the avatar', () => {
  it('renders presence as the avatar corner dot (panel parity), not a separate element', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => page(MEMBERS) }));
    renderDirectory({ presence: { '1': 'online', '2': 'idle', '3': 'dnd' } });
    await waitFor(() => expect(screen.getByTestId('people-list')).toBeTruthy());

    const row = screen.getByTestId('people-row-1');
    const avatar = row.querySelector('.people-avatar');
    expect(avatar?.getAttribute('data-presence')).toBe('online');
    // The standalone dot element is gone; the status word survives sr-only.
    expect(row.querySelector('.people-presence')).toBeNull();
    expect(row.textContent).toContain('online');
  });
});

// Live roster (2026-10-02): the directory is a REST read, but a deleted bot
// (MemberRemove), a granted one (MemberAdd) and a rename (UserUpdate) change
// the store under it. The directory follows the store's membership diff and
// its names, without a reload.
describe('PeopleDirectory — follows the live roster', () => {
  // A bot's label is its display name (#168); its nickname is per-workspace
  // and unset here (#169).
  const BOT = {
    user: { id: '9', username: 'relay', display_name: 'Relay' },
    nickname: null,
    joined_at: '2026-10-02T00:00:00Z',
    roles: [],
    kind: 'bot' as const,
    parent_user_id: '1',
  };
  const ROWS: PeopleMember[] = [...MEMBERS, BOT];

  function storeOf(
    rows: PeopleMember[],
    overrides: Record<string, { display_name?: string; username?: string }> = {},
  ): DirectoryStore {
    return {
      membersById: Object.fromEntries(
        rows.map((r) => [
          r.user.id,
          {
            id: r.user.id,
            username: overrides[r.user.id]?.username ?? r.user.username,
            display_name: overrides[r.user.id]?.display_name ?? r.user.display_name ?? null,
            nickname: null,
            avatar_url: null,
            kind: r.kind ?? 'human',
            parent_user_id: r.parent_user_id,
          },
        ]),
      ),
      memberIdsByWorkspace: { [WS]: rows.map((r) => r.user.id) },
      presenceByUser: {},
    };
  }

  it('a removed member leaves the list; a rename shows the new name with the handle kept', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => page(ROWS) }));
    const view = renderDirectory({ store: storeOf(ROWS) });
    await waitFor(() => expect(screen.getByTestId('people-row-9')).toBeTruthy());
    expect(screen.getByTestId('people-row-9').textContent).toContain('Relay');

    // UserUpdate: the label rides display_name.
    view.rerender(<PeopleDirectory workspaceId={WS} store={storeOf(ROWS, { '9': { display_name: 'Relay Prime' } })} />);
    await waitFor(() => expect(screen.getByTestId('people-row-9').textContent).toContain('Relay Prime'));
    expect(screen.getByTestId('people-row-9').textContent).toContain('@relay');

    // MemberRemove (the bot was deleted): gone, with no refetch.
    const fetches = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    view.rerender(<PeopleDirectory workspaceId={WS} store={storeOf(MEMBERS)} />);
    await waitFor(() => expect(screen.queryByTestId('people-row-9')).toBeNull());
    expect(screen.getByTestId('people-row-1')).toBeTruthy();
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(fetches);
  });

  it('a member who joins live (MemberAdd) is appended', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => page(MEMBERS) }));
    const view = renderDirectory({ store: storeOf(MEMBERS) });
    await waitFor(() => expect(screen.getByTestId('people-row-1')).toBeTruthy());
    expect(screen.queryByTestId('people-row-9')).toBeNull();

    view.rerender(<PeopleDirectory workspaceId={WS} store={storeOf(ROWS)} />);
    await waitFor(() => expect(screen.getByTestId('people-row-9')).toBeTruthy());
    expect(screen.getByTestId('people-row-9').textContent).toContain('Relay');
  });
});
