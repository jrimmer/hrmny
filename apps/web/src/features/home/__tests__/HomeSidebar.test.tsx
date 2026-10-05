/**
 * @cytale/web — HomeSidebar acceptance coverage.
 *
 * The home column replaces the workspace ChannelSidebar while Home is
 * active: DM list (peer from recipients), mention + recent-thread quick
 * nav, workspace jump list with unread rollups, static wordmark header
 * (the "Cytale" workspace-menu dropdown is gone with the workspace context).
 */
import { axe } from 'vitest-axe';
import type { AxeMatchers } from 'vitest-axe/matchers';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

declare module 'vitest' {
  interface Assertion<T> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}

import type { Channel, Thread, Workspace } from '@cytale/domain';

import { HomeSidebar, type HomeStore } from '../HomeSidebar';

function ws(id: string, name: string): Workspace {
  return {
    id,
    name,
    icon_url: null,
    description: null,
    owner_id: '1',
    role_version: 0,
    created_at: '2026-08-30T00:00:00Z',
  };
}

function ch(id: string, name: string, overrides: Partial<Channel> = {}): Channel {
  return {
    id,
    workspace_id: 'ws-1',
    recipients: null,
    name,
    type: 'text',
    topic: null,
    position: 0,
    last_message_id: null,
    created_at: '2026-08-30T00:00:00Z',
    ...overrides,
  };
}

function dm(id: string, peerId: string, peerName: string, lastMessageId: string | null): Channel {
  return ch(id, `dm-${id}`, {
    workspace_id: null,
    type: 'dm',
    last_message_id: lastMessageId,
    recipients: [{ id: peerId, username: peerName }],
  });
}

function thread(id: string, channelId: string, name: string): Thread {
  return {
    id,
    channel_id: channelId,
    parent_message_id: null,
    name,
    created_by: 'u-9',
    archived: false,
    created_at: '2026-08-30T00:00:00Z',
  };
}

function makeStore(overrides: Partial<HomeStore> = {}): HomeStore {
  return {
    workspaces: {
      'ws-1': ws('ws-1', 'Alpha'),
      'ws-2': ws('ws-2', 'Beta'),
    },
    channels: {
      'c-1': ch('c-1', 'general'),
      'd-1': dm('d-1', 'u-peer-1', 'alice', '200'),
      'd-2': dm('d-2', 'u-peer-2', 'bob', '300'),
      'd-3': dm('d-3', 'u-peer-3', 'carol', null),
    },
    unreadByChannel: {
      'd-1': { unread_count: 4, mention_count: 1 },
      'c-1': { unread_count: 7, mention_count: 2 },
    },
    threadIdsByChannel: { 'c-1': ['t-1'] },
    threadsById: { 't-1': thread('t-1', 'c-1', 'Deploy talk') },
    currentUser: { id: 'u-self' },
    // #94 roster slices: the picker's pool (carol is deliberately absent —
    // a member known to the store is pickable only through a SHARED roster).
    membersById: {
      'u-self': { username: 'me' },
      'u-peer-1': { username: 'alice' },
      'u-peer-2': { username: 'bob' },
      'u-dave': { username: 'dave' },
    },
    memberIdsByWorkspace: {
      'ws-1': ['u-self', 'u-peer-1', 'u-dave'],
      // u-peer-1 is in BOTH rosters on purpose: the picker must still list
      // them once (the duplicate-per-workspace defect, 2026-09-14).
      'ws-2': ['u-peer-2', 'u-peer-1'],
    },
    ...overrides,
  };
}

function renderSidebar(store = makeStore(), props = {}) {
  return render(
    <HomeSidebar
      inbox={{
        items: [],
        status: 'ready',
        error: null,
        actionError: null,
        busy: false,
        dismiss: vi.fn(),
        sweep: vi.fn(),
        retry: vi.fn(),
      }}
              store={store}
      activeChannelId={null}
      onSelectDm={vi.fn()}
      onSelectWorkspace={vi.fn()}
      onSelectChannel={vi.fn()}
      onSelectThread={vi.fn()}
      onCreateWorkspace={vi.fn().mockResolvedValue(ws('ws-new', 'New'))}
      {...props}
    />,
  );
}

afterEach(() => cleanup());

describe('HomeSidebar — direct messages', () => {
  it('lists DM rows named by the peer (not the raw channel name), newest first', () => {
    renderSidebar();
    expect(screen.getByTestId('home-dm-d-2').textContent).toContain('bob');
    expect(screen.getByTestId('home-dm-d-1').textContent).toContain('alice');
    // d-2 (last_message_id 300) sorts above d-1 (200); d-3 (null) sinks.
    expect(screen.getByTestId('home-dm-d-2').compareDocumentPosition(screen.getByTestId('home-dm-d-1'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(screen.getByTestId('home-dm-d-1').compareDocumentPosition(screen.getByTestId('home-dm-d-3'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('orders DMs by the live recency slice when the gateway has seen a newer message', () => {
    // The message hot path keeps recency in its own narrow slice instead of
    // rewriting the channel record, so the hydrated row id is stale for a DM
    // that saw traffic — the slice's value must win.
    renderSidebar(makeStore({ lastMessageIdByChannel: { 'd-3': '400' } }));
    // d-3 (400) now leads; d-2 (300) follows it.
    expect(
      screen.getByTestId('home-dm-d-3').compareDocumentPosition(screen.getByTestId('home-dm-d-2')),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('carries ONE badge from the store rollups — the mention count wins, as on channel rows', () => {
    // d-1 has 4 unread, 1 mention: the channel row's rule is mention-over-
    // unread, one badge per row (DM rows used to show both side by side).
    renderSidebar();
    expect(screen.getByTestId('home-dm-mentions-d-1').textContent).toBe('1');
    expect(screen.queryByTestId('home-dm-unread-d-1')).toBeNull();
    expect(screen.getByTestId('home-dm-d-1').getAttribute('data-unread')).toBe('true');
  });

  // Notification controls (2026-09-27): a muted DM dims and drops its unread
  // count but keeps the mention badge; "mentions only" does NOT hide a DM's
  // unread count — a DM is addressed to you as a whole.
  it('a muted DM row dims, drops the unread badge, and keeps mentions', () => {
    renderSidebar(
      makeStore({
        unreadByChannel: {
          'd-1': { unread_count: 4, mention_count: 1 },
          'd-2': { unread_count: 3, mention_count: 0 },
        },
        notificationPrefs: {
          overrides: { 'channel:d-1': 'mute', 'channel:d-2': 'mute' },
          suppressBroadcasts: {},
          status: 'ready',
        },
      }),
    );
    expect(screen.getByTestId('home-dm-d-2').getAttribute('data-muted')).toBe('true');
    expect(screen.queryByTestId('home-dm-unread-d-2')).toBeNull();
    expect(screen.getByTestId('home-dm-d-2').getAttribute('data-unread')).toBeNull();
    expect(screen.getByTestId('home-dm-muted-d-2')).toBeTruthy();
    expect(screen.getByTestId('home-dm-mentions-d-1').textContent).toBe('1');
    expect(screen.getByTestId('home-dm-d-2').textContent).toContain('muted');
  });

  it('a DM under an account-level "mentions only" still shows its unread count', () => {
    renderSidebar(
      makeStore({
        unreadByChannel: { 'd-2': { unread_count: 3, mention_count: 0 } },
        notificationPrefs: { overrides: { 'account:0': 'mentions' }, suppressBroadcasts: {}, status: 'ready' },
      }),
    );
    expect(screen.getByTestId('home-dm-unread-d-2').textContent).toBe('3');
    expect(screen.getByTestId('home-dm-d-2').getAttribute('data-muted')).toBeNull();
  });

  it('empty DM list renders the honest empty state', () => {
    renderSidebar(makeStore({ channels: { 'c-1': ch('c-1', 'general') }, unreadByChannel: {} }));
    expect(screen.getByTestId('home-dms-empty').textContent).toMatch(/no conversations yet/i);
  });

  it('selecting a DM row calls onSelectDm with the channel id', async () => {
    const onSelectDm = vi.fn();
    renderSidebar(makeStore(), { onSelectDm });
    await userEvent.setup().click(screen.getByTestId('home-dm-d-1'));
    expect(onSelectDm).toHaveBeenCalledWith('d-1');
  });

  it('the active DM row is marked aria-current', () => {
    renderSidebar(makeStore(), { activeChannelId: 'd-1' });
    expect(screen.getByTestId('home-dm-d-1').getAttribute('aria-current')).toBe('page');
  });
});

describe('HomeSidebar — threads nav', () => {
  it('routes recent (non-archived) threads via onSelectThread', async () => {
    const onSelectThread = vi.fn();
    renderSidebar(makeStore(), { onSelectThread });
    await userEvent.setup().click(screen.getByTestId('home-thread-t-1'));
    expect(onSelectThread).toHaveBeenCalledWith('t-1', 'c-1');
  });

  it('hides the threads section when there is nothing to show', () => {
    renderSidebar(
      makeStore({
        unreadByChannel: {},
        threadIdsByChannel: {},
        threadsById: {},
      }),
    );
    expect(screen.queryByRole('region', { name: 'Recent threads' })).toBeNull();
  });
});

describe('HomeSidebar — header', () => {
  it('carries a static wordmark (no workspace-menu dropdown) and an Actions menu', async () => {
    const onCreateWorkspace = vi.fn().mockResolvedValue(ws('ws-new', 'New'));
    renderSidebar(makeStore(), { onCreateWorkspace });
    expect(screen.queryByTestId('server-header')).toBeNull();
    expect(screen.getByText('Hrmny')).toBeTruthy();

    // the ＋ is gone; an Actions (ellipsis) affordance opens the home menu
    expect(screen.queryByTestId('home-create-workspace')).toBeNull();
    await userEvent.setup().click(screen.getByTestId('home-actions'));
    const menu = screen.getByTestId('home-actions-menu');
    expect(menu.getAttribute('role')).toBe('menu');
    await userEvent.setup().click(screen.getByTestId('home-actions-create-workspace'));
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('Escape closes the Actions menu without opening the dialog', async () => {
    renderSidebar();
    await userEvent.setup().click(screen.getByTestId('home-actions'));
    expect(screen.getByTestId('home-actions-menu')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('home-actions-menu')).toBeNull();
  });
});

describe('HomeSidebar — header menu keyboard contract (one menu primitive)', () => {
  it('focus enters the menu, and Escape hands it back to the gear', async () => {
    renderSidebar();
    const user = userEvent.setup();
    const trigger = screen.getByTestId('home-actions');
    trigger.focus();
    await user.keyboard('{Enter}');
    const menu = screen.getByTestId('home-actions-menu');
    await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('home-actions-menu')).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });
});

describe('HomeSidebar — accessibility (WCAG 2.1 AA bar)', () => {
  it('has no axe violations', async () => {
    const { container } = renderSidebar();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations in the empty state', async () => {
    const { container } = renderSidebar(
      makeStore({ unreadByChannel: {}, threadIdsByChannel: {}, threadsById: {}, workspaces: {} }),
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('HomeSidebar — start a conversation (#94)', () => {
  function dmChannel(id: string): Channel {
    return {
      id,
      workspace_id: null,
      name: '',
      type: 'dm',
      topic: null,
      position: 0,
      last_message_id: null,
      created_at: '2026-08-30T00:00:00Z',
      recipients: [{ id: 'u-x', username: 'peer' }],
    };
  }

  it('the ＋ rides the DM heading, above the rows, and opens the picker', async () => {
    renderSidebar(makeStore(), { onStartDm: vi.fn().mockResolvedValue(dmChannel('d-new')) });
    const start = screen.getByTestId('dm-start');
    // It IS the heading's control — not a row of its own (user direction
    // 2026-09-14: "Move the Start Conversation to just the plus to the right of
    // the DIRECT MESSAGES heading").
    const heading = start.closest('h3');
    expect(heading?.className).toContain('category-label');
    expect(screen.getByTestId('dm-start').closest('section')?.getAttribute('aria-label')).toBe(
      'Direct Messages',
    );
    // above the DM rows
    expect(start.compareDocumentPosition(screen.getByTestId('home-dm-d-2'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    await userEvent.setup().click(start);
    expect(await screen.findByTestId('dm-picker')).toBeTruthy();
  });

  it('the empty column carries the same heading ＋ (no inline duplicate)', async () => {
    const store = makeStore({
      channels: { 'c-1': ch('c-1', 'general') },
      unreadByChannel: { 'c-1': { unread_count: 0, mention_count: 0 } },
    });
    renderSidebar(store, { onStartDm: vi.fn().mockResolvedValue(dmChannel('d-new')) });
    expect(screen.getByTestId('home-dms-empty')).toBeTruthy();
    // Exactly one affordance on the surface, and it is the heading's.
    const starts = screen.getAllByTestId('dm-start');
    expect(starts).toHaveLength(1);
    expect(starts[0]!.closest('h3')).not.toBeNull();
    await userEvent.setup().click(starts[0]!);
    expect(await screen.findByTestId('dm-picker')).toBeTruthy();
  });

  it('without the start handler wired (structural fixtures), no affordance renders', () => {
    renderSidebar();
    expect(screen.queryByTestId('dm-start')).toBeNull();
  });

  it('the picker lists shared-workspace members ONCE each, self excluded', async () => {
    renderSidebar(makeStore(), { onStartDm: vi.fn().mockResolvedValue(dmChannel('d-new')) });
    await userEvent.setup().click(screen.getByTestId('dm-start'));
    await screen.findByTestId('dm-picker');

    expect(screen.getByTestId('dm-picker-result-u-peer-1').textContent).toContain('alice');
    expect(screen.getByTestId('dm-picker-result-u-dave').textContent).toContain('dave');
    expect(screen.getByTestId('dm-picker-result-u-peer-2').textContent).toContain('@bob');
    // the viewer is never a candidate
    expect(screen.queryByTestId('dm-picker-result-u-self')).toBeNull();
    // the scope guard: carol is in the store but shares NO roster with you
    expect(screen.queryByTestId('dm-picker-result-u-peer-3')).toBeNull();
    // ONE row per person, even though alice is in both shared workspaces
    expect(screen.getAllByTestId('dm-picker-result-u-peer-1')).toHaveLength(1);
    // and no workspace headings (a DM is instance-wide)
    const picker = within(screen.getByTestId('dm-picker'));
    expect(picker.queryByText('Alpha')).toBeNull();
    expect(picker.queryByText('Beta')).toBeNull();
  });

  it('a DM whose peer no longer resolves reads "Unknown", not a blank row', () => {
    // The server's DM payload has no `name` and builds `recipients` from the
    // peer users, so a peer that is gone yields `recipients: []` and name ''.
    // The nullish fallback accepted that empty string and the row rendered as a
    // bare avatar tile — the "huge green dot" under the heading (user report
    // 2026-09-14).
    const store = makeStore({
      channels: {
        // A complete Channel, like the file's own helpers build: the build's
        // typecheck (tsc -p tsconfig.build.json, which includes test files)
        // rejected the shorthand version of this fixture.
        'd-ghost': {
          id: 'd-ghost',
          workspace_id: null,
          name: '',
          type: 'dm',
          topic: null,
          position: 0,
          last_message_id: null,
          parent_id: null,
          recipients: [],
          created_at: '2026-08-30T00:00:00Z',
        },
      },
    });
    renderSidebar(store, { onStartDm: vi.fn() });
    const row = screen.getByTestId('home-dm-d-ghost');
    expect(row.textContent).toContain('Unknown');
    // and the tile has initials to draw, rather than rendering empty
    expect(row.querySelector('.home-avatar')?.textContent).toBe('UN');
  });

  it('type-to-filter narrows the picker rows', async () => {
    renderSidebar(makeStore(), { onStartDm: vi.fn().mockResolvedValue(dmChannel('d-new')) });
    await userEvent.setup().click(screen.getByTestId('dm-start'));
    await userEvent.type(await screen.findByTestId('dm-picker-input'), 'dave');
    expect(screen.getByTestId('dm-picker-result-u-dave')).toBeTruthy();
    expect(screen.queryByTestId('dm-picker-result-u-peer-1')).toBeNull();
  });

  it('selecting a member opens the DM through onStartDm and closes the picker', async () => {
    const onStartDm = vi.fn().mockResolvedValue(dmChannel('d-new'));
    renderSidebar(makeStore(), { onStartDm });
    await userEvent.setup().click(screen.getByTestId('dm-start'));
    await userEvent.click(await screen.findByTestId('dm-picker-result-u-dave'));
    await waitFor(() => expect(onStartDm).toHaveBeenCalledTimes(1));
    expect(onStartDm).toHaveBeenCalledWith('u-dave');
  });

  it('axe: no violations with the affordance and the picker open', async () => {
    renderSidebar(makeStore(), { onStartDm: vi.fn().mockResolvedValue(dmChannel('d-new')) });
    await userEvent.setup().click(screen.getByTestId('dm-start'));
    await screen.findByTestId('dm-picker-results');
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it('axe: no violations on the empty column with the inline affordance', async () => {
    const { container } = renderSidebar(
      makeStore({
        channels: {},
        unreadByChannel: {},
        threadIdsByChannel: {},
        threadsById: {},
        workspaces: {
          'ws-1': ws('ws-1', 'Alpha'),
          'ws-2': ws('ws-2', 'Beta'),
        },
      }),
      { onStartDm: vi.fn().mockResolvedValue(dmChannel('d-new')) },
    );
    expect(screen.getByTestId('home-dms-empty')).toBeTruthy();
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('HomeSidebar — DM row identity marks (owner direction 2026-09-15)', () => {
  it('a human peer carries a presence dot and no seal', () => {
    // The roster says 'human' explicitly — the dot must still render, since a
    // machine is what suppresses it, not the mere presence of a kind.
    const store = makeStore();
    store.membersById = { ...store.membersById, 'u-peer-2': { username: 'bob', kind: 'human' } };
    renderSidebar(store, { presence: { 'u-peer-2': 'online' } });
    const avatar = screen.getByTestId('home-dm-d-2').querySelector('[data-presence]');
    expect(avatar?.getAttribute('data-presence')).toBe('online');
    // Negatives: no agent seal on a person, and the seal's word is not announced.
    expect(screen.getByTestId('home-dm-d-2').querySelector('[data-testid="kind-badge"]')).toBeNull();
  });

  it('an agent peer carries BOTH the seal and a presence dot', () => {
    const store = makeStore();
    store.membersById = {
      ...store.membersById,
      'u-peer-3': { username: 'mia', kind: 'bot', parent_user_id: 'u-self' },
    };
    renderSidebar(store, { presence: { 'u-peer-3': 'online' } });
    const row = screen.getByTestId('home-dm-d-3');
    expect(row.querySelector('[data-testid="kind-badge"]')).toBeTruthy();
    // An agent DOES carry presence: it goes offline when its connection drops,
    // and that is the signal a reader wants on its row (owner direction
    // 2026-09-15). The two marks coexist — seal top-right, dot bottom-right.
    expect(row.querySelector('[data-presence]')?.getAttribute('data-presence')).toBe('online');
    // The seal is decorative; its meaning is announced in text.
    expect(row.textContent).toContain('Agent');
  });
});
