/**
 * @cytale/web — the workspace menu's Notifications group (notification
 * controls, 2026-09-27): the workspace's own level as a radio group with
 * "Use account default", plus the per-workspace "Suppress @everyone and
 * @here" checkbox. Writes go through the shared preference store.
 */
import { axe } from 'vitest-axe';
import type { AxeMatchers } from 'vitest-axe/matchers';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

declare module 'vitest' {
  interface Assertion<T> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}

const setNotificationPreference = vi.fn();
const clearNotificationPreference = vi.fn();
const setBroadcastSuppression = vi.fn();

vi.mock('../../auth/session.js', () => ({
  api: {
    setNotificationPreference: (...args: unknown[]) => setNotificationPreference(...args),
    clearNotificationPreference: (...args: unknown[]) => clearNotificationPreference(...args),
    setBroadcastSuppression: (...args: unknown[]) => setBroadcastSuppression(...args),
  },
}));

import { defaultStore, emptyNotificationPrefs } from '@cytale/state';

import { WorkspaceMenu } from '../WorkspaceMenu.js';

/** Radix portals the menu outside any landmark; `region` is best-practice, not WCAG. */
const PORTAL_AXE = { rules: { region: { enabled: false } } };

const WS = '5300000000000000001';

function renderMenu() {
  return render(<WorkspaceMenu workspaceName="Alpha" hasActiveWorkspace workspaceId={WS} onCreateChannel={vi.fn()} />);
}

async function open() {
  await userEvent.click(screen.getByTestId('workspace-menu-trigger'));
  return screen.getByTestId('workspace-menu');
}

beforeEach(() => {
  setNotificationPreference.mockReset().mockResolvedValue(undefined);
  clearNotificationPreference.mockReset().mockResolvedValue(undefined);
  setBroadcastSuppression.mockReset().mockResolvedValue(undefined);
  defaultStore.setState({ notificationPrefs: { ...emptyNotificationPrefs(), status: 'ready' } });
});

afterEach(cleanup);

describe('WorkspaceMenu — Notifications group', () => {
  it('lists the three levels, "Use account default", and the broadcast switch', async () => {
    renderMenu();
    const menu = await open();
    const group = within(menu).getByTestId('workspace-menu-notifications');
    expect(within(group).getAllByRole('menuitemradio').map((r) => r.textContent)).toEqual([
      'All messages',
      'Mentions only',
      'Nothing',
      'Use account default (Mentions only)',
    ]);
    const suppress = within(group).getByRole('menuitemcheckbox');
    expect(suppress.textContent).toBe('Suppress @everyone and @here');
    expect(suppress.getAttribute('aria-checked')).toBe('false');
  });

  it('choosing a level writes the WORKSPACE layer and closes the menu', async () => {
    renderMenu();
    await open();
    await userEvent.click(screen.getByTestId('workspace-menu-level-all'));
    expect(setNotificationPreference).toHaveBeenCalledWith('workspace', 'all', WS);
    await waitFor(() => expect(screen.queryByTestId('workspace-menu')).toBeNull());
    expect(defaultStore.getState().notificationPrefs.overrides[`workspace:${WS}`]).toBe('all');
  });

  it('"Use account default" clears the workspace row', async () => {
    defaultStore.setState({
      notificationPrefs: { ...emptyNotificationPrefs(), status: 'ready', overrides: { [`workspace:${WS}`]: 'mute' } },
    });
    renderMenu();
    await open();
    expect(screen.getByTestId('workspace-menu-level-mute').getAttribute('aria-checked')).toBe('true');
    await userEvent.click(screen.getByTestId('workspace-menu-level-inherit'));
    expect(clearNotificationPreference).toHaveBeenCalledWith('workspace', WS);
  });

  it('the broadcast switch flips through the shared store', async () => {
    renderMenu();
    await open();
    await userEvent.click(screen.getByTestId('workspace-menu-suppress-broadcasts'));
    expect(setBroadcastSuppression).toHaveBeenCalledWith(WS, true);
    expect(defaultStore.getState().notificationPrefs.suppressBroadcasts[WS]).toBe(true);
  });

  it('a refused switch rolls back and alerts inside the menu', async () => {
    setBroadcastSuppression.mockRejectedValue(new TypeError('Failed to fetch'));
    renderMenu();
    await open();
    await userEvent.click(screen.getByTestId('workspace-menu-suppress-broadcasts'));
    await waitFor(() => expect(screen.getByTestId('workspace-menu-notifications-error')).toBeTruthy());
    expect(defaultStore.getState().notificationPrefs.suppressBroadcasts[WS]).toBeUndefined();
    expect(screen.getByTestId('workspace-menu-suppress-broadcasts').getAttribute('aria-checked')).toBe('false');
  });

  it('no active workspace → no Notifications group', async () => {
    render(<WorkspaceMenu workspaceName="Cytale" hasActiveWorkspace={false} onCreateWorkspace={vi.fn()} />);
    await open();
    expect(screen.queryByTestId('workspace-menu-notifications')).toBeNull();
  });

  it('axe: zero violations with the group open', async () => {
    renderMenu();
    await open();
    expect(await axe(document.body, PORTAL_AXE)).toHaveNoViolations();
  });
});
