/**
 * @cytale/web — HomeDashboard acceptance coverage.
 *
 * The home main area: greeting, account stats, per-workspace catchup with
 * channel jumps, quick actions, and the fresh-account welcome hero that
 * replaces the old zero-workspace empty-shell fall-through.
 */
import { axe } from 'vitest-axe';
import type { AxeMatchers } from 'vitest-axe/matchers';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

declare module 'vitest' {
  interface Assertion<T> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}

import type { Channel, Workspace } from '@cytale/domain';

import { HomeDashboard } from '../HomeDashboard';
import type { HomeStore } from '../HomeSidebar';

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

function makeStore(overrides: Partial<HomeStore> = {}): HomeStore {
  return {
    workspaces: { 'ws-1': ws('ws-1', 'Alpha') },
    channels: {
      'c-1': ch('c-1', 'general'),
      'c-2': ch('c-2', 'random'),
    },
    unreadByChannel: {
      'c-1': { unread_count: 3, mention_count: 1 },
    },
    threadIdsByChannel: {},
    threadsById: {},
    currentUser: { id: 'u-self' },
    ...overrides,
  };
}

function renderDashboard(
  store = makeStore(),
  props: Partial<Parameters<typeof HomeDashboard>[0]> = {},
) {
  return render(
    <HomeDashboard
      store={store}
      username="jordan"
      onSelectChannel={vi.fn()}
      onCreateWorkspace={vi.fn().mockResolvedValue(ws('ws-new', 'New'))}
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
      {...props}
    />,
  );
}

afterEach(() => cleanup());

describe('HomeDashboard — greeting', () => {
  it('greets the user by name', () => {
    renderDashboard();
    const greeting = screen.getByTestId('home-greeting').textContent ?? '';
    expect(greeting).toContain('jordan');
    expect(greeting).toMatch(/good (morning|afternoon|evening)|still up/i);
  });

  it('omits the name gracefully when the user is unknown', () => {
    renderDashboard(makeStore(), { username: null });
    expect(screen.getByTestId('home-greeting').textContent).not.toContain(',');
  });
});

describe('HomeDashboard — catchup', () => {
  it('catchup card lists the workspace top unread channels and jumps on click', async () => {
    const onSelectChannel = vi.fn();
    renderDashboard(makeStore(), { onSelectChannel });
    const button = screen.getByTestId('catchup-channel-c-1');
    expect(button.textContent).toContain('general');
    await userEvent.setup().click(button);
    expect(onSelectChannel).toHaveBeenCalledWith('c-1');
  });

  it('all-clear state when nothing is unread', () => {
    renderDashboard(makeStore({ unreadByChannel: {} }));
    expect(screen.getByTestId('home-all-caught-up').textContent).toMatch(/all caught up/i);
    expect(screen.queryByTestId('home-catchup')).toBeNull();
  });
});

describe('HomeDashboard — fresh account hero', () => {
  it('zero workspaces render the welcome hero with a create CTA (not an empty shell)', async () => {
    const onCreateWorkspace = vi.fn().mockResolvedValue(ws('ws-new', 'New'));
    renderDashboard(
      makeStore({ workspaces: {}, unreadByChannel: {} }),
      { onCreateWorkspace },
    );
    expect(screen.getByTestId('home-hero-title').textContent).toContain('jordan');
    await userEvent.setup().click(screen.getByTestId('home-hero-create'));
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('loading state is announced', () => {
    renderDashboard(makeStore(), { loading: true });
    expect(screen.getByRole('status').textContent).toMatch(/loading/i);
  });
});

describe('HomeDashboard — accessibility (WCAG 2.1 AA bar)', () => {
  it('has no axe violations with content', async () => {
    const { container } = renderDashboard();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations in the fresh-account hero', async () => {
    const { container } = renderDashboard(makeStore({ workspaces: {}, unreadByChannel: {} }));
    expect(await axe(container)).toHaveNoViolations();
  });
});
