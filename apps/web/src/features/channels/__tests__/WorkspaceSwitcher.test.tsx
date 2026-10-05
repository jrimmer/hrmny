/**
 * @cytale/web — the rail's workspace badge is the channel row's badge.
 *
 * Plain unread is the neutral pill (`.channel-unread`); red
 * (`.channel-mentions`, with the count) is only for mentions — the rule every
 * sidebar row follows. The rail used to paint any unread red.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';

import type { Workspace } from '@cytale/domain';

import { WorkspaceSwitcher } from '../WorkspaceSwitcher.js';

const WS: Workspace = {
  id: '5400000000000000001',
  name: 'Playground',
  icon_url: null,
  owner_id: '1',
  created_at: '2026-09-01T00:00:00Z',
} as Workspace;

afterEach(cleanup);

function renderRail(unread: number, mentions: number) {
  return render(
    <WorkspaceSwitcher
      workspaces={[WS]}
      activeWorkspaceId={WS.id}
      unreadFor={() => unread}
      mentionsFor={() => mentions}
    />,
  );
}

describe('WorkspaceSwitcher badge', () => {
  it('plain unread is the neutral channel-row pill, not red', () => {
    renderRail(7, 0);
    const badge = screen.getByTestId(`workspace-unread-${WS.id}`);
    expect(badge.className).toBe('channel-unread');
    expect(badge.textContent).toBe('7');
    expect(screen.queryByTestId(`workspace-mentions-${WS.id}`)).toBeNull();
    expect(screen.getByTestId(`workspace-${WS.id}`).getAttribute('aria-label')).toBe('Playground, 7 unread');
  });

  it('mentions turn it red with the mention count, and win over unread', () => {
    renderRail(7, 2);
    const badge = screen.getByTestId(`workspace-mentions-${WS.id}`);
    expect(badge.className).toBe('channel-mentions');
    expect(badge.textContent).toBe('2');
    expect(screen.queryByTestId(`workspace-unread-${WS.id}`)).toBeNull();
    expect(screen.getByTestId(`workspace-${WS.id}`).getAttribute('aria-label')).toBe(
      'Playground, 7 unread, 2 mentions',
    );
  });

  it('nothing new, no badge', () => {
    const { container } = renderRail(0, 0);
    expect(container.querySelector('.workspace-badge')).toBeNull();
    expect(screen.getByTestId(`workspace-${WS.id}`).hasAttribute('data-unread')).toBe(false);
  });

  it('has no axe violations with a mention badge', async () => {
    const { container } = renderRail(3, 1);
    expect(await axe(container)).toHaveNoViolations();
  });
});
