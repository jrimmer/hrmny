/**
 * @cytale/web — the header notification control (notification controls,
 * 2026-09-27).
 *
 * What the control promises: one click cycles all → mentions → nothing → all
 * and writes an EXPLICIT row; an inheriting target renders quieter and says
 * where its level comes from; the name always states the current and the
 * next state; a click is confirmed through a polite live region; a refusal
 * rolls the shared store back and says so; right-click opens the full menu
 * whose default radio clears the row; the phone variant's long-press opens a
 * sheet. Axe-clean in every state.
 */
import { axe } from 'vitest-axe';
import type { AxeMatchers } from 'vitest-axe/matchers';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

declare module 'vitest' {
  interface Assertion<T> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}

const setNotificationPreference = vi.fn();
const clearNotificationPreference = vi.fn();

vi.mock('../../auth/session.js', () => ({
  api: {
    setNotificationPreference: (...args: unknown[]) => setNotificationPreference(...args),
    clearNotificationPreference: (...args: unknown[]) => clearNotificationPreference(...args),
  },
}));

import { createStateStore, emptyNotificationPrefs, type StateStore } from '@cytale/state';

import { LONG_PRESS_MS } from '../../channels/ChannelContextMenu.js';
import { NotificationLevelControl } from '../NotificationLevelControl.js';
import { channelTarget } from '../notificationPrefs.js';

/**
 * Radix portals the menu/sheet to <body>, outside any landmark the test
 * mounts; `region` is an axe BEST-PRACTICE rule (not WCAG) about that page
 * furniture, so it is off here and every WCAG rule stays on.
 */
const PORTAL_AXE = { rules: { region: { enabled: false } } };

const WS = '5100000000000000001';
const CH = '5200000000000000001';
const DM = '5200000000000000009';

function storeWith(overrides: Record<string, 'all' | 'mentions' | 'mute'> = {}): StateStore {
  const store = createStateStore();
  store.setState({ notificationPrefs: { ...emptyNotificationPrefs(), overrides, status: 'ready' } });
  return store;
}

function renderControl(store: StateStore, target = channelTarget(CH, WS), variant: 'menu' | 'sheet' = 'menu') {
  return render(
    <NotificationLevelControl target={target} store={store} variant={variant} testIdPrefix="ctl" targetName="#general" />,
  );
}

beforeEach(() => {
  setNotificationPreference.mockReset().mockResolvedValue(undefined);
  clearNotificationPreference.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the cycle', () => {
  it('clicks run all → mentions → nothing → all, each an explicit write', async () => {
    const store = storeWith({ [`channel:${CH}`]: 'all' });
    renderControl(store);
    const button = screen.getByTestId('ctl');
    expect(button.getAttribute('data-level')).toBe('all');

    await act(async () => fireEvent.click(button));
    expect(setNotificationPreference).toHaveBeenLastCalledWith('channel', 'mentions', CH);
    expect(button.getAttribute('data-level')).toBe('mentions');

    await act(async () => fireEvent.click(button));
    expect(setNotificationPreference).toHaveBeenLastCalledWith('channel', 'mute', CH);
    expect(button.getAttribute('data-level')).toBe('mute');

    await act(async () => fireEvent.click(button));
    expect(setNotificationPreference).toHaveBeenLastCalledWith('channel', 'all', CH);
    expect(button.getAttribute('data-level')).toBe('all');
  });

  it('the first click on an inheriting target writes the NEXT level explicitly', async () => {
    const store = storeWith();
    renderControl(store);
    await act(async () => fireEvent.click(screen.getByTestId('ctl')));
    // Inherited mentions → next is mute, now stored at the channel.
    expect(setNotificationPreference).toHaveBeenCalledWith('channel', 'mute', CH);
    expect(store.getState().notificationPrefs.overrides[`channel:${CH}`]).toBe('mute');
    expect(screen.getByTestId('ctl').hasAttribute('data-inherited')).toBe(false);
  });
});

describe('labels and the inherited look', () => {
  it('inheriting: quieter, and the name carries the provenance and the next state', () => {
    renderControl(storeWith({ [`workspace:${WS}`]: 'mentions' }));
    const button = screen.getByTestId('ctl');
    expect(button.hasAttribute('data-inherited')).toBe(true);
    expect(button.getAttribute('aria-label')).toBe(
      'Notifications: Mentions only (workspace default) — click for Nothing',
    );
    // Tooltip and accessible name are the same string.
    expect(button.getAttribute('title')).toBe(button.getAttribute('aria-label'));
  });

  it('explicit: no provenance, just current and next', () => {
    renderControl(storeWith({ [`channel:${CH}`]: 'mute' }));
    expect(screen.getByTestId('ctl').getAttribute('aria-label')).toBe(
      'Notifications: Nothing — click for All messages',
    );
  });

  it('a DM inherits the account and offers "Use default"', async () => {
    const user = userEvent.setup();
    renderControl(storeWith(), channelTarget(DM, null));
    expect(screen.getByTestId('ctl').getAttribute('aria-label')).toBe(
      'Notifications: Mentions only (account default) — click for Nothing',
    );
    fireEvent.contextMenu(screen.getByTestId('ctl'));
    await screen.findByTestId('ctl-menu');
    expect(screen.getByTestId('ctl-menu-level-inherit').textContent).toBe('Use default (Mentions only)');
    await user.keyboard('{Escape}');
  });
});

describe('confirmation and failure', () => {
  it('a click is confirmed through a polite live region', async () => {
    renderControl(storeWith({ [`channel:${CH}`]: 'mentions' }));
    const region = screen.getByTestId('ctl-confirm');
    expect(region.getAttribute('role')).toBe('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toBe('');

    await act(async () => fireEvent.click(screen.getByTestId('ctl')));
    expect(region.textContent).toBe('Notifications: Nothing');
  });

  it('the confirmation clears after its beat', async () => {
    vi.useFakeTimers();
    renderControl(storeWith({ [`channel:${CH}`]: 'mentions' }));
    await act(async () => fireEvent.click(screen.getByTestId('ctl')));
    expect(screen.getByTestId('ctl-confirm').textContent).toBe('Notifications: Nothing');
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByTestId('ctl-confirm').textContent).toBe('');
  });

  it('a refused write rolls the store back and raises an alert', async () => {
    setNotificationPreference.mockRejectedValue(new TypeError('Failed to fetch'));
    const store = storeWith({ [`channel:${CH}`]: 'all' });
    renderControl(store);
    await act(async () => fireEvent.click(screen.getByTestId('ctl')));

    await waitFor(() => expect(screen.getByTestId('ctl-error').getAttribute('role')).toBe('alert'));
    expect(store.getState().notificationPrefs.overrides[`channel:${CH}`]).toBe('all');
    expect(screen.getByTestId('ctl').getAttribute('data-level')).toBe('all');
    expect(screen.getByTestId('ctl-confirm').textContent).toBe('');
  });
});

describe('the full menu', () => {
  it('right-click opens the three levels plus the workspace default', async () => {
    renderControl(storeWith({ [`channel:${CH}`]: 'all' }));
    fireEvent.contextMenu(screen.getByTestId('ctl'));
    const menu = await screen.findByTestId('ctl-menu');
    const radios = within(menu).getAllByRole('menuitemradio');
    expect(radios).toHaveLength(4);
    expect(screen.getByTestId('ctl-menu-level-all').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('ctl-menu-level-inherit').textContent).toBe(
      'Use workspace default (Mentions only)',
    );
  });

  it('"Use workspace default" clears the row and the control goes back to inheriting', async () => {
    const user = userEvent.setup();
    const store = storeWith({ [`channel:${CH}`]: 'all' });
    renderControl(store);
    fireEvent.contextMenu(screen.getByTestId('ctl'));
    await user.click(await screen.findByTestId('ctl-menu-level-inherit'));

    expect(clearNotificationPreference).toHaveBeenCalledWith('channel', CH);
    await waitFor(() => expect(screen.queryByTestId('ctl-menu')).toBeNull());
    expect(screen.getByTestId('ctl').hasAttribute('data-inherited')).toBe(true);
  });

  it('long-press (touch) opens the menu too', async () => {
    vi.useFakeTimers();
    renderControl(storeWith());
    fireEvent.touchStart(screen.getByTestId('ctl'));
    await act(async () => {
      vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    });
    vi.useRealTimers();
    expect(await screen.findByTestId('ctl-menu')).toBeTruthy();
  });

  it('axe: zero violations closed, inherited, and with the menu open', async () => {
    const { container } = renderControl(storeWith());
    expect(await axe(container)).toHaveNoViolations();
    fireEvent.contextMenu(screen.getByTestId('ctl'));
    await screen.findByTestId('ctl-menu');
    expect(await axe(document.body, PORTAL_AXE)).toHaveNoViolations();
  });
});

describe('the phone sheet variant', () => {
  it('long-press opens a sheet with a radio group; choosing writes and dismisses', async () => {
    vi.useFakeTimers();
    renderControl(storeWith(), channelTarget(CH, WS), 'sheet');
    fireEvent.touchStart(screen.getByTestId('ctl'));
    await act(async () => {
      vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    });
    vi.useRealTimers();

    const sheet = await screen.findByTestId('ctl-sheet');
    expect(within(sheet).getByRole('radiogroup')).toBeTruthy();
    expect(screen.getByTestId('ctl-sheet-inherit').getAttribute('aria-checked')).toBe('true');

    await act(async () => fireEvent.click(screen.getByTestId('ctl-sheet-all')));
    expect(setNotificationPreference).toHaveBeenCalledWith('channel', 'all', CH);
    await waitFor(() => expect(screen.queryByTestId('ctl-sheet')).toBeNull());
  });

  it('a tap still cycles', async () => {
    renderControl(storeWith({ [`channel:${CH}`]: 'mute' }), channelTarget(CH, WS), 'sheet');
    await act(async () => fireEvent.click(screen.getByTestId('ctl')));
    expect(setNotificationPreference).toHaveBeenCalledWith('channel', 'all', CH);
  });

  it('axe: the open sheet has no violations', async () => {
    renderControl(storeWith(), channelTarget(CH, WS), 'sheet');
    fireEvent.contextMenu(screen.getByTestId('ctl'));
    await screen.findByTestId('ctl-sheet');
    expect(await axe(document.body, PORTAL_AXE)).toHaveNoViolations();
  });
});
