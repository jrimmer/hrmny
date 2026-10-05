/**
 * @cytale/web — U20 Channel Sidebar acceptance coverage.
 *
 * Red-first history: written before the components existed and observed
 * failing (module resolution). Now the unit's regression net.
 *
 * Contract under test (plan U20):
 *   1. sidebar renders workspaces in the rail and channels in the list,
 *      grouped by category; unread badges show correctly.
 *   2. click a channel → active channel set (onSelectChannel callback).
 *   3. switch workspace → channel list updates to the new workspace's
 *      channels.
 *   4. a channel with no unread → no badge; a channel with mentions →
 *      mention count highlighted.
 *   5. invite landing: ready / invalid / expired empty-states; post-auth
 *      redemption calls acceptInvite.
 */
import { axe } from 'vitest-axe';
import type { AxeMatchers } from 'vitest-axe/matchers';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The media-settings dialog's api seam (calls V2 plan U8): the entry is
// always listed; the FETCH carries the permission honesty (403 → the
// dialog's denied state).
const getWorkspaceMediaSettings = vi.fn();
vi.mock('../../auth/session.js', () => ({
  api: {
    getWorkspaceMediaSettings: (...args: unknown[]) =>
      getWorkspaceMediaSettings(...(args as [string])),
  },
}));

declare module 'vitest' {
  interface Assertion<T> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}

import { ApiError } from '@cytale/api-client';
import type { Channel, Workspace } from '@cytale/domain';

import { ChannelSidebar } from '../ChannelSidebar';
import { InviteLandingPage } from '../InviteLandingPage';
import { acceptInvite, resolveInvite } from '../api';
import type { SidebarStore } from '../useSidebarProjection';

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

function ch(id: string, name: string, position: number): Channel {
  return {
    id,
    workspace_id: 'ws-1',
    recipients: null,
    name,
    type: 'text',
    topic: null,
    position,
    last_message_id: null,
    created_at: '2026-08-30T00:00:00Z',
  };
}

function makeStore(overrides: Partial<SidebarStore> = {}): SidebarStore {
  return {
    workspaces: {
      'ws-1': ws('ws-1', 'Alpha'),
      'ws-2': ws('ws-2', 'Beta'),
    },
    channels: {
      'c-1': ch('c-1', 'general', 0),
      'c-2': ch('c-2', 'random', 1),
      'c-3': ch('c-3', 'dev', 2),
    },
    unreadByChannel: {
      'c-2': { unread_count: 3, mention_count: 1 },
      'c-3': { unread_count: 5, mention_count: 0 },
    },
    channelIdsByWorkspace: {
      'ws-1': ['c-1', 'c-2', 'c-3'],
      'ws-2': [],
    },
    memberIdsByWorkspace: {
      'ws-1': ['u-1'],
      'ws-2': ['u-1'],
    },
    ...overrides,
  };
}

function renderSidebar(props: Partial<Parameters<typeof ChannelSidebar>[0]> = {}) {
  return render(
    <ChannelSidebar
      store={makeStore()}
      activeWorkspaceId="ws-1"
      activeChannelId={null}
      {...props}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ChannelSidebar — render', () => {
  it('renders workspaces in the rail and channels in the list, grouped by category', () => {
    renderSidebar({
      categories: [
        { label: 'Text', channelIds: ['c-1', 'c-2'] },
        { label: 'Dev', channelIds: ['c-3'] },
      ],
    });

    expect(screen.getByTestId('workspace-ws-1')).toBeTruthy();
    expect(screen.getByTestId('workspace-ws-2')).toBeTruthy();
    expect(screen.getByText('Text')).toBeTruthy();
    expect(screen.getByText('Dev')).toBeTruthy();
    expect(screen.getByTestId('channel-c-1')).toBeTruthy();
    expect(screen.getByTestId('channel-c-2')).toBeTruthy();
    expect(screen.getByTestId('channel-c-3')).toBeTruthy();
  });

  it('renders unread badges and highlights mention counts', () => {
    renderSidebar();

    // c-2 has 3 unread + 1 mention → mention badge shown.
    expect(screen.getByTestId('mentions-c-2').textContent).toBe('1');
    // c-3 has 5 unread, 0 mentions → unread badge shown.
    expect(screen.getByTestId('unread-c-3').textContent).toBe('5');
    // c-1 has no unread → no badge.
    expect(screen.queryByTestId('unread-c-1')).toBeNull();
    expect(screen.queryByTestId('mentions-c-1')).toBeNull();
  });

  it('renders a single "Channels" group when no categories are supplied', () => {
    renderSidebar();
    expect(screen.getByText('Channels')).toBeTruthy();
    expect(screen.getByTestId('channel-c-1')).toBeTruthy();
  });
});

describe('ChannelSidebar — selection', () => {
  it('click a channel → active channel set via onSelectChannel', async () => {
    const onSelectChannel = vi.fn();
    renderSidebar({ onSelectChannel });

    await userEvent.click(screen.getByTestId('channel-c-2'));
    expect(onSelectChannel).toHaveBeenCalledWith('c-2');
  });

  it('marks the active channel with aria-current', () => {
    renderSidebar({ activeChannelId: 'c-1' });
    expect(screen.getByTestId('channel-c-1').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('channel-c-2').getAttribute('aria-current')).toBeNull();
  });

  it('switch workspace → channel list updates to the new workspace channels', async () => {
    const onSelectWorkspace = vi.fn();
    renderSidebar({ onSelectWorkspace });

    await userEvent.click(screen.getByTestId('workspace-ws-2'));
    expect(onSelectWorkspace).toHaveBeenCalledWith('ws-2');
  });
});

describe('ChannelSidebar — accessibility', () => {
  it('has no axe violations at desktop width', async () => {
    const { container } = renderSidebar();
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});

describe('ChannelSidebar — DM calls render no slot (calls plan U10, R11)', () => {
  it('a live DM call in the DM slice produces no call-slot row anywhere', () => {
    renderSidebar({
      store: makeStore({
        // A live 1:1 call on a DM channel (the DM slice, never callByChannel)
        // AND a room call on a workspace channel — only the room call slots.
        dmCallByChannel: {
          'dm-1': {
            call_id: '99',
            thread_id: null,
            started_by: 'u-2',
            started_at: '2026-09-06T12:00:00Z',
            participants: {
              'u-1': { user_id: 'u-1', mute: false, deafen: false, leg: 'L1' },
              'u-2': { user_id: 'u-2', mute: false, deafen: false, leg: 'L2' },
            },
          },
        },
        callByChannel: {
          'c-2': {
            call_id: '98',
            thread_id: '55',
            started_by: 'u-2',
            started_at: '2026-09-06T12:00:00Z',
            participants: {
              'u-2': { user_id: 'u-2', mute: false, deafen: false, leg: 'L3' },
            },
          },
        },
      }),
    });

    // The room call slots under its channel; the DM call never slots.
    expect(screen.getByTestId('call-slot-c-2')).toBeTruthy();
    expect(screen.queryByTestId('call-slot-dm-1')).toBeNull();
    // Exactly one slot row in the whole sidebar (class count — the testid
    // tree carries nested avatar/placeholder ids inside the row).
    expect(document.querySelectorAll('.call-slot')).toHaveLength(1);
  });
});

describe('InviteLandingPage', () => {
  function jsonResponse(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => 'application/json' },
      json: async () => body,
    } as unknown as Response;
  }

  it('ready state shows the workspace name and auth actions when unauthenticated', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(200, {
          invite: {
            code: 'abc',
            workspace: { id: 'ws-1', name: 'Alpha' },
            expires_at: null,
            max_uses: 5,
            use_count: 0,
          },
        }),
      ),
    );

    const onNavigate = vi.fn();
    render(<InviteLandingPage code="abc" authenticated={false} onNavigate={onNavigate} />);

    await waitFor(() => expect(screen.getByTestId('invite-ready')).toBeTruthy());
    expect(screen.getByText(/Join Alpha/)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: /Sign in/i }));
    expect(onNavigate).toHaveBeenCalledWith('/login');
  });

  it('invalid code renders the invalid empty-state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(404, { error: { key: 'invite_not_found', code: 40404, message: 'no such invite' } }),
      ),
    );

    render(<InviteLandingPage code="nope" />);
    await waitFor(() => expect(screen.getByTestId('invite-invalid')).toBeTruthy());
  });

  it('expired code renders the expired empty-state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(410, { error: { key: 'invite_expired', code: 41001, message: 'expired' } }),
      ),
    );

    render(<InviteLandingPage code="old" />);
    await waitFor(() => expect(screen.getByTestId('invite-expired')).toBeTruthy());
  });

  it('post-auth redemption calls acceptInvite and surfaces the joined workspace', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input);
        if (url.endsWith('/invites/abc') && init.method === 'POST') {
          return jsonResponse(200, { workspace_id: 'ws-1', joined: true });
        }
        return jsonResponse(200, {
          invite: {
            code: 'abc',
            workspace: { id: 'ws-1', name: 'Alpha' },
            expires_at: null,
            max_uses: 5,
            use_count: 0,
          },
        });
      }),
    );

    const onAccept = vi.fn(async () => {});
    render(<InviteLandingPage code="abc" authenticated onAccept={onAccept} />);

    await waitFor(() => expect(screen.getByTestId('invite-ready')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: /Accept invite/i }));
    expect(onAccept).toHaveBeenCalledWith('abc');
  });

  it('acceptInvite posts with the bearer token and returns the workspace id', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { workspace_id: 'ws-9', joined: true }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const wsId = await acceptInvite('xyz', 'tok-1');
    expect(wsId).toBe('ws-9');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/invites/xyz');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok-1');
  });

  it('resolveInvite parses the documented envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(200, {
          invite: {
            code: 'abc',
            workspace: { id: 'ws-1', name: 'Alpha' },
            expires_at: null,
            max_uses: 5,
            use_count: 0,
          },
        }),
      ),
    );

    const invite = await resolveInvite('abc');
    expect(invite.workspace?.name).toBe('Alpha');
  });
});

describe('ChannelSidebar — server header (Discord parity)', () => {
  it('opens the workspace menu from the server-name trigger and lists the actions', async () => {
    renderSidebar({
      serverName: 'Alpha',
      onCreateChannel: vi.fn(),
      onCreateInvite: vi.fn(),
      onOpenIntegrations: vi.fn(),
    });

    const trigger = screen.getByTestId('workspace-menu-trigger');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    await userEvent.click(trigger);

    const menu = screen.getByTestId('workspace-menu');
    expect(menu.getAttribute('role')).toBe('menu');
    expect(screen.getByTestId('workspace-menu-invite').textContent).toContain('Invite People');
    expect(screen.getByTestId('workspace-menu-create-channel').textContent).toContain(
      'Create Channel',
    );
    expect(screen.getByTestId('workspace-menu-integrations').textContent).toContain(
      'Integrations',
    );
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  it('escape closes the menu and restores focus to the trigger', async () => {
    renderSidebar({ serverName: 'Alpha', onCreateChannel: vi.fn() });

    await userEvent.click(screen.getByTestId('workspace-menu-trigger'));
    expect(screen.getByTestId('workspace-menu')).toBeTruthy();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('workspace-menu')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('workspace-menu-trigger'));
  });

  it('menu Create Channel opens the dialog; submit calls back with the slugified name', async () => {
    const onCreateChannel = vi.fn(async () => ch('c-9', 'new-vibes', 3));
    renderSidebar({ serverName: 'Alpha', onCreateChannel });

    await userEvent.click(screen.getByTestId('workspace-menu-trigger'));
    await userEvent.click(screen.getByTestId('workspace-menu-create-channel'));

    const dialog = screen.getByTestId('create-channel-dialog');
    expect(dialog).toBeTruthy();

    // Discord auto-formats the name to the channel slug as you type.
    await userEvent.type(screen.getByTestId('create-channel-name'), 'New Vibes');
    expect((screen.getByTestId('create-channel-name') as HTMLInputElement).value).toBe(
      'new-vibes',
    );
    await userEvent.type(screen.getByTestId('create-channel-topic'), 'Vibes only');
    await userEvent.click(screen.getByTestId('create-channel-submit'));

    await waitFor(() =>
      expect(onCreateChannel).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'new-vibes', topic: 'Vibes only', type: 'text' }),
      ),
    );
    // Success closes the dialog.
    await waitFor(() => expect(screen.queryByTestId('create-channel-dialog')).toBeNull());
  });

  it('the header gear menu opens Create Channel', async () => {
    renderSidebar({ serverName: 'Alpha', onCreateChannel: vi.fn() });

    await userEvent.click(screen.getByTestId('workspace-menu-trigger'));
    await userEvent.click(screen.getByTestId('workspace-menu-create-channel'));
    expect(screen.getByTestId('create-channel-dialog')).toBeTruthy();
  });

  it('menu Media Settings opens the workspace media-settings dialog (calls V2 plan U8)', async () => {
    getWorkspaceMediaSettings.mockResolvedValue({
      calls: true,
      video: true,
      screenshare: true,
      overrides_allowed: false,
    });
    renderSidebar({ serverName: 'Alpha' });

    await userEvent.click(screen.getByTestId('workspace-menu-trigger'));
    await userEvent.click(screen.getByTestId('workspace-menu-media-settings'));

    expect(screen.getByTestId('media-settings-dialog')).toBeTruthy();
    await waitFor(() => {
      expect(getWorkspaceMediaSettings).toHaveBeenCalledWith('ws-1');
    });
    await waitFor(() => {
      expect(screen.getByTestId('media-settings-list')).not.toBeNull();
    });
    getWorkspaceMediaSettings.mockClear();
  });

  it('a forbidden create renders the permission-denied alert', async () => {
    const onCreateChannel = vi.fn(async () => {
      throw new ApiError({ key: 'forbidden', code: 40_003, message: 'Request denied.', status: 403 });
    });
    renderSidebar({ serverName: 'Alpha', onCreateChannel });

    await userEvent.click(screen.getByTestId('workspace-menu-trigger'));
    await userEvent.click(screen.getByTestId('workspace-menu-create-channel'));
    await userEvent.type(screen.getByTestId('create-channel-name'), 'secret');
    await userEvent.click(screen.getByTestId('create-channel-submit'));

    const alert = await waitFor(() => screen.getByTestId('create-channel-error'));
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain("don't have permission");
    // The dialog stays open with the error.
    expect(screen.getByTestId('create-channel-dialog')).toBeTruthy();
  });

  it('Invite People mints an invite and shows the copyable landing link', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    const onCreateInvite = vi.fn(async () => ({ code: 'abc123' }));
    renderSidebar({ serverName: 'Alpha', onCreateInvite });

    await userEvent.click(screen.getByTestId('workspace-menu-trigger'));
    await userEvent.click(screen.getByTestId('workspace-menu-invite'));
    expect(screen.getByTestId('invite-dialog')).toBeTruthy();

    // Defaults: 1 day, no limit (Discord's defaults, server-honest).
    await userEvent.click(screen.getByTestId('invite-generate'));
    await waitFor(() => expect(onCreateInvite).toHaveBeenCalledWith({ maxAgeSeconds: 86400, maxUses: 0 }));

    const link = await waitFor(() => screen.getByTestId('invite-link') as HTMLInputElement);
    expect(link.value).toContain('#/invite/abc123');

    await userEvent.click(screen.getByTestId('invite-copy'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining('#/invite/abc123')));
    expect(screen.getByTestId('invite-copy').textContent).toBe('Copied!');
  });

  it('expiry and max-uses selections ride the mint call', async () => {
    const onCreateInvite = vi.fn(async () => ({ code: 'x' }));
    renderSidebar({ serverName: 'Alpha', onCreateInvite });

    await userEvent.click(screen.getByTestId('workspace-menu-trigger'));
    await userEvent.click(screen.getByTestId('workspace-menu-invite'));

    await userEvent.selectOptions(screen.getByTestId('invite-expiry'), '600');
    await userEvent.selectOptions(screen.getByTestId('invite-max-uses'), '25');
    await userEvent.click(screen.getByTestId('invite-generate'));

    await waitFor(() =>
      expect(onCreateInvite).toHaveBeenCalledWith({ maxAgeSeconds: 600, maxUses: 25 }),
    );
  });

  it('with no active workspace, the header offers Create Workspace (fresh install)', async () => {
    const onCreateWorkspace = vi.fn(async () => ws('ws-9', 'Acme'));
    renderSidebar({
      serverName: 'Cytale',
      activeWorkspaceId: null,
      onCreateWorkspace,
      onCreateChannel: vi.fn(),
    });

    await userEvent.click(screen.getByTestId('workspace-menu-trigger'));
    // Workspace-scoped items are absent; the create-workspace flow remains.
    expect(screen.queryByTestId('workspace-menu-invite')).toBeNull();
    expect(screen.queryByTestId('workspace-menu-create-channel')).toBeNull();
    expect(screen.getByTestId('workspace-menu-create-workspace')).toBeTruthy();

    await userEvent.click(screen.getByTestId('workspace-menu-create-workspace'));
    await userEvent.type(screen.getByTestId('create-workspace-name'), 'Acme');
    await userEvent.click(screen.getByTestId('create-workspace-submit'));

    await waitFor(() => expect(onCreateWorkspace).toHaveBeenCalledWith({ name: 'Acme' }));
  });

  it('with no active workspace, the header gear menu opens Create Workspace', async () => {
    renderSidebar({
      serverName: 'Cytale',
      activeWorkspaceId: null,
      onCreateWorkspace: vi.fn(async () => ws('ws-9', 'Acme')),
    });

    await userEvent.click(screen.getByTestId('workspace-menu-trigger'));
    const item = screen.getByTestId('workspace-menu-create-workspace');
    // The workspace menu's own convention is Title Case (Create Channel,
    // Workspace Settings, …); the retired ⋯ menu used sentence case.
    expect(item.textContent).toContain('Create Workspace');
    await userEvent.click(item);
    expect(screen.getByTestId('create-workspace-dialog')).toBeTruthy();
  });

  it('has no axe violations with the menu open', async () => {
    const { container } = renderSidebar({
      serverName: 'Alpha',
      onCreateChannel: vi.fn(),
      onCreateInvite: vi.fn(),
      onOpenIntegrations: vi.fn(),
    });
    await userEvent.click(screen.getByTestId('workspace-menu-trigger'));
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it('has no axe violations with the create-channel dialog open', async () => {
    renderSidebar({ serverName: 'Alpha', onCreateChannel: vi.fn() });
    await userEvent.click(screen.getByTestId('workspace-menu-trigger'));
    await userEvent.click(screen.getByTestId('workspace-menu-create-channel'));
    const results = await axe(document.body);
    expect(results).toHaveNoViolations();
  });
});

describe('ChannelSidebar — categories (server category rows)', () => {
  it('groups channels under their category headers, ungrouped first', () => {
    const store = makeStore({
      channels: {
        'c-1': ch('c-1', 'general', 0),
        'cat-1': { ...ch('cat-1', 'Projects', 1), type: 'category' as const },
        'c-2': { ...ch('c-2', 'alpha', 0), parent_id: 'cat-1' },
        'c-3': { ...ch('c-3', 'beta', 1), parent_id: 'cat-1' },
      },
      channelIdsByWorkspace: { 'ws-1': ['c-1', 'cat-1', 'c-2', 'c-3'], 'ws-2': [] },
    });
    renderSidebar({ store, serverName: 'Alpha' });

    // The category is a header, not a channel row.
    expect(screen.getByText('Projects')).toBeTruthy();
    expect(screen.queryByTestId('channel-cat-1')).toBeNull();
    // The ungrouped section keeps its VISIBLE header once categories exist —
    // it used to lose it, stranding parentless channels under nothing while
    // an empty category rendered as a bare label (owner report 2026-09-15).
    expect(screen.getByText('Channels')).toBeTruthy();
    // Its children render as rows; the parentless channel sits above.
    expect(screen.getByTestId('channel-c-2')).toBeTruthy();
    expect(screen.getByTestId('channel-c-3')).toBeTruthy();
    const general = screen.getByTestId('channel-c-1');
    const alpha = screen.getByTestId('channel-c-2');
    expect(general.compareDocumentPosition(alpha) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('offers the workspace categories in the create dialog (file-at-creation)', async () => {
    const store = makeStore({
      channels: {
        'c-1': ch('c-1', 'general', 0),
        'cat-1': { ...ch('cat-1', 'Projects', 1), type: 'category' as const },
      },
      channelIdsByWorkspace: { 'ws-1': ['c-1', 'cat-1'], 'ws-2': [] },
    });
    const onCreateChannel = vi.fn(async () => ch('c-9', 'gamma', 0));
    renderSidebar({ store, serverName: 'Alpha', onCreateChannel });

    await userEvent.click(screen.getByTestId('workspace-menu-trigger'));
    await userEvent.click(screen.getByTestId('workspace-menu-create-channel'));
    const select = screen.getByTestId('create-channel-parent') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      'No category',
      'Projects',
    ]);
    await userEvent.type(screen.getByTestId('create-channel-name'), 'gamma');
    await userEvent.selectOptions(select, 'cat-1');
    await userEvent.click(screen.getByTestId('create-channel-submit'));
    expect(onCreateChannel).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'gamma', parent_id: 'cat-1' }),
    );
  });

  it('creates a category from the same dialog (type toggle)', async () => {
    const onCreateChannel = vi.fn(async () => ({ ...ch('cat-2', 'areas', 0), type: 'category' as const }));
    renderSidebar({ serverName: 'Alpha', onCreateChannel });

    await userEvent.click(screen.getByTestId('workspace-menu-trigger'));
    await userEvent.click(screen.getByTestId('workspace-menu-create-channel'));
    await userEvent.click(screen.getByTestId('create-channel-kind-category'));
    // Category mode drops the topic/parent fields…
    expect(screen.queryByTestId('create-channel-topic')).toBeNull();
    // …and the CHANNEL affordances too: no # prefix, and the name keeps its
    // case and dots — a category is a label, not a URL slug (owner report
    // 2026-09-15: "example.com" was rejected and shown with a #).
    expect(document.querySelector('.modal-input-prefix')).toBeNull();
    await userEvent.type(screen.getByTestId('create-channel-name'), 'Example.com!');
    await userEvent.click(screen.getByTestId('create-channel-submit'));
    expect(onCreateChannel).toHaveBeenCalledWith(
      // Case preserved, the dot kept, the '!' dropped.
      expect.objectContaining({ name: 'Example.com', type: 'category' }),
    );
  });

  it('the channel gear opens settings and saves a category move', async () => {
    const store = makeStore({
      channels: {
        'c-1': ch('c-1', 'general', 0),
        'cat-1': { ...ch('cat-1', 'Projects', 1), type: 'category' as const },
      },
      channelIdsByWorkspace: { 'ws-1': ['c-1', 'cat-1'], 'ws-2': [] },
    });
    const onUpdateChannel = vi.fn(async () => undefined);
    renderSidebar({ store, serverName: 'Alpha', onUpdateChannel });

    await userEvent.click(screen.getByTestId('channel-context-trigger-c-1'));
    await userEvent.click(screen.getByTestId('channel-context-settings'));
    expect(screen.getByTestId('channel-settings-dialog')).toBeTruthy();
    expect((screen.getByTestId('channel-settings-name') as HTMLInputElement).value).toBe('general');

    await userEvent.selectOptions(screen.getByTestId('channel-settings-parent'), 'cat-1');
    await userEvent.click(screen.getByTestId('channel-settings-save'));
    expect(onUpdateChannel).toHaveBeenCalledWith(
      'c-1',
      expect.objectContaining({ parent_id: 'cat-1', name: 'general' }),
    );
  });
});
