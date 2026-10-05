/**
 * @cytale/web — ContextRail + home aggregate rail content coverage.
 *
 * The right column's tabbed header (Members | Call log, tooltip'd icons),
 * the home aggregates (all-members dedupe, all-calls fan-out states), and
 * the shell's column resize separators.
 */
import { axe } from 'vitest-axe';
import type { AxeMatchers } from 'vitest-axe/matchers';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

declare module 'vitest' {
  interface Assertion<T> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}

import type { Channel } from '@cytale/domain';
import type { CallStateResponse } from '@cytale/api-client';

import { ContextRail } from '../ContextRail';
import { AllMembersList } from '../../../features/directory/AllMembersList';
import { AllCallsList } from '../../../features/calls/log/AllCallsList';

afterEach(() => cleanup());

describe('ContextRail — tabbed header', () => {
  const tabs = [
    {
      id: 'members',
      label: 'Members',
      testId: 'rail-tab-members',
      icon: <span>M</span>,
      content: <div data-testid="members-content">members</div>,
    },
    {
      id: 'calls',
      label: 'Call log',
      testId: 'rail-tab-calls',
      icon: <span>C</span>,
      content: <div data-testid="calls-content">calls</div>,
    },
  ];

  it('renders the open mode content and no tab row', () => {
    render(<ContextRail tabs={tabs} active="members" />);
    expect(screen.getByTestId('members-content')).toBeTruthy();
    expect(screen.queryByTestId('calls-content')).toBeNull();
    // The mode is chosen from the rail icons at the window's top right (owner
    // direction 2026-09-12). An in-rail row would be a second, contradictory
    // control — pinned as an ABSENCE so it cannot come back by accident.
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByTestId('rail-tab-members')).toBeNull();
  });

  it('carries NO tablist or tab roles — the icon cluster owns selection', () => {
    render(<ContextRail tabs={tabs} active="members" />);
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
  });

  it('open search: magnifier slides next to the ACTIVE icon, input covers the inactive tab', async () => {
    const onToggle = vi.fn();
    const view = render(
      <ContextRail
        tabs={tabs}
        active="members"
        search={{ open: false, onToggle, query: '', onQueryChange: vi.fn() }}
      />,
    );

    await userEvent.setup().click(screen.getByTestId('rail-search-toggle'));
    expect(onToggle).toHaveBeenCalledOnce();
    view.rerender(
      <ContextRail
        tabs={tabs}
        active="members"
        search={{ open: true, onToggle, query: '', onQueryChange: vi.fn() }}
      />,
    );

    // DOM order: active icon, then the magnifier, then the borderless input;
    // the inactive tab's icon is covered (unmounted) while search is open.
    const header = screen.getByTestId('context-rail-tabs');
    const order = [...header.children].map(
      (el) =>
        el.getAttribute('data-testid') ??
        (el.classList.contains('context-rail-active-icon') ? 'active-icon' : el.tagName),
    );
    expect(order).toEqual(['active-icon', 'rail-search-toggle', 'rail-search-input']);
    expect(screen.getByTestId('rail-search-toggle').getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByTestId('rail-tab-calls')).toBeNull();
  });

  it('clicking away dismisses the search and restores the closed layout', async () => {
    const onToggle = vi.fn();
    const view = render(
      <ContextRail
        tabs={tabs}
        active="members"
        search={{ open: true, onToggle, query: 'al', onQueryChange: vi.fn() }}
      />,
    );
    expect(screen.getByTestId('rail-search-input')).toBeTruthy();

    // A click in the rail's CONTENT area (outside the header row) dismisses.
    await userEvent.setup().click(screen.getByTestId('members-content'));
    expect(onToggle).toHaveBeenCalledOnce();

    // Host applies the toggle → the closed layout is the magnifier again (no
    // tabs to restore: the tab row is gone).
    view.rerender(
      <ContextRail
        tabs={tabs}
        active="members"
        search={{ open: false, onToggle, query: '', onQueryChange: vi.fn() }}
      />,
    );
    expect(screen.queryByTestId('rail-search-input')).toBeNull();
    // The closed layout is the content plus the magnifier — there is no tab row
    // to come back (the icon cluster owns selection).
    expect(screen.getByTestId('rail-search-toggle')).toBeTruthy();
    expect(screen.queryByRole('tab')).toBeNull();
  });

  it('has no axe violations', async () => {
    const { container } = render(<ContextRail tabs={tabs} active="members" />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('AllMembersList — home aggregate', () => {
  const member = (id: string, username: string, nickname: string | null = null) => ({
    user: { id, username },
    nickname,
    joined_at: null,
    roles: [],
  });

  it('renders rows and routes selection', async () => {
    const onSelectMember = vi.fn();
    render(
      <AllMembersList
        members={[member('u-2', 'bob'), member('u-1', 'alice', 'Alice')]}
        presence={{ 'u-1': 'online' }}
        onSelectMember={onSelectMember}
      />,
    );
    const row = screen.getByTestId('all-members-row-u-1');
    expect(row.textContent).toContain('Alice');
    await userEvent.setup().click(row);
    expect(onSelectMember).toHaveBeenCalledOnce();
  });

  it('empty state says so explicitly', () => {
    render(<AllMembersList members={[]} presence={{}} />);
    expect(screen.getByTestId('all-members-empty').textContent).toMatch(/no members yet/i);
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <AllMembersList members={[member('u-1', 'alice')]} presence={{}} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('AllCallsList — home aggregate', () => {
  const channel = (id: string, name: string): Channel => ({
    id,
    workspace_id: 'ws-1',
    recipients: null,
    name,
    type: 'text',
    topic: null,
    position: 0,
    last_message_id: null,
    created_at: '2026-08-30T00:00:00Z',
  });

  it('renders per-channel ended calls and jumps to the channel', async () => {
    const getCall = vi.fn(async (channelId: string): Promise<CallStateResponse> => ({
      thread_id: `t-${channelId}`,
      live: null,
      recently_ended:
        channelId === 'c-1'
          ? [{ call_id: 'call-1', started_by: 'u-1', started_at: '2026-09-06T10:00:00Z', ended_at: new Date().toISOString(), reason: 'last_left' }]
          : [],
    }));
    const onSelectChannel = vi.fn();
    render(
      <AllCallsList channels={[channel('c-1', 'general'), channel('c-2', 'random')]} getCall={getCall} onSelectChannel={onSelectChannel} />,
    );
    await waitFor(() => expect(screen.getByTestId('all-calls-list')).toBeTruthy());
    await userEvent.setup().click(screen.getByTestId('all-calls-ended-call-1'));
    expect(onSelectChannel).toHaveBeenCalledWith('c-1');
  });

  it('explicit empty state when nothing was ever called', async () => {
    const getCall = vi.fn(async (): Promise<CallStateResponse> => ({
      thread_id: null,
      live: null,
      recently_ended: [],
    }));
    render(<AllCallsList channels={[channel('c-1', 'general')]} getCall={getCall} onSelectChannel={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('all-calls-empty').textContent).toMatch(/no calls yet/i));
  });

  it('error state offers Retry when every fetch fails', async () => {
    const getCall = vi.fn(async (): Promise<CallStateResponse> => {
      throw new Error('down');
    });
    render(<AllCallsList channels={[channel('c-1', 'general')]} getCall={getCall} onSelectChannel={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('all-calls-retry')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toMatch(/could not load/i);
  });
});
