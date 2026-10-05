/**
 * #121 — the Home gear's Server settings entry: OPERATOR-ONLY.
 *
 * The affordance hides for everyone else (`is_operator` off), shows for an
 * operator, and opening it navigates to `#/serversettings` — while the
 * routes themselves stay gated server-side (a hidden link loses nothing
 * because the server refuses non-operators anyway).
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HomeStore } from '../HomeSidebar.js';
import { HomeSidebar } from '../HomeSidebar.js';

afterEach(() => cleanup());

function renderSidebar(props: { isOperator?: boolean; onOpenServerSettings?: () => void }) {
  const store: HomeStore = {
    workspaces: {},
    channels: {},
    unreadByChannel: {},
    threadIdsByChannel: {},
    threadsById: {},
    currentUser: { id: 'u-self' },
  };

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
      onCreateWorkspace={vi.fn()}
      {...props}
    />,
  );
}

describe('HomeSidebar — server settings entry (#121)', () => {
  it('is hidden for a non-operator', async () => {
    const user = userEvent.setup();
    renderSidebar({ isOperator: false, onOpenServerSettings: vi.fn() });

    await user.click(screen.getByTestId('home-actions'));
    const menu = screen.getByTestId('home-actions-menu');
    expect(menu.textContent).not.toContain('Server settings');
    expect(screen.queryByTestId('home-actions-server-settings')).toBeNull();
  });

  it('is hidden when the operator props are absent entirely (older callers)', async () => {
    const user = userEvent.setup();
    renderSidebar({});

    await user.click(screen.getByTestId('home-actions'));
    expect(screen.queryByTestId('home-actions-server-settings')).toBeNull();
  });

  it('shows for an operator and opens the server settings route', async () => {
    const user = userEvent.setup();
    const onOpenServerSettings = vi.fn();
    renderSidebar({ isOperator: true, onOpenServerSettings });

    await user.click(screen.getByTestId('home-actions'));
    expect(screen.getByTestId('home-actions-server-settings').textContent).toContain('Server settings');

    await user.click(screen.getByTestId('home-actions-server-settings'));
    expect(onOpenServerSettings).toHaveBeenCalledTimes(1);
  });
});
