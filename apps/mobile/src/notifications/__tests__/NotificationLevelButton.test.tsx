/**
 * The native title-bar notification control (2026-09-27): a tap cycles the
 * channel's level through the shared preference slice, a long-press opens the
 * sheet whose radios include "Use workspace default", and the accessible name
 * states the current level (with its provenance while inherited) and the next.
 */
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { createStateStore, emptyNotificationPrefs, type NotificationPrefsApi } from '@cytale/state';

import { NotificationLevelButton } from '../NotificationLevelButton';

const WS = '5500000000000000001';
const CH = '5500000000000000100';

function setup(overrides: Record<string, 'all' | 'mentions' | 'mute'> = {}, api?: Partial<NotificationPrefsApi>) {
  const store = createStateStore();
  store.setState({ notificationPrefs: { ...emptyNotificationPrefs(), overrides, status: 'ready' } });
  const client: NotificationPrefsApi = {
    getNotificationPreferences: jest.fn(async () => ({ preferences: [], suppress_broadcasts: [] })),
    setNotificationPreference: jest.fn(async () => undefined),
    clearNotificationPreference: jest.fn(async () => undefined),
    setBroadcastSuppression: jest.fn(async () => undefined),
    ...api,
  };
  return { store, client };
}

async function renderButton(store: ReturnType<typeof createStateStore>, client: NotificationPrefsApi) {
  await render(
    <NotificationLevelButton
      target={{ scope: 'channel', entityId: CH, channelId: CH, workspaceId: WS }}
      store={store}
      api={client}
      targetName="#general"
    />,
  );
}

afterEach(() => {
  jest.useRealTimers();
});

describe('NotificationLevelButton', () => {
  it('names the inherited level, its source, and the next state', async () => {
    const { store, client } = setup({ [`workspace:${WS}`]: 'mentions' });
    await renderButton(store, client);
    expect(screen.getByTestId('title-bar-notifications').props.accessibilityLabel).toBe(
      'Notifications: Mentions only (workspace default) — tap for Nothing',
    );
    // The glyph is decorative (hidden from assistive tech), so it is queried
    // with hidden elements included.
    expect(
      screen.getByTestId('title-bar-notifications-glyph-mentions', { includeHiddenElements: true }),
    ).toBeTruthy();
  });

  it('a tap cycles all → mentions → nothing → all', async () => {
    const { store, client } = setup({ [`channel:${CH}`]: 'all' });
    await renderButton(store, client);
    for (const next of ['mentions', 'mute', 'all'] as const) {
      await act(async () => {
        fireEvent.press(screen.getByTestId('title-bar-notifications'));
      });
      expect(client.setNotificationPreference).toHaveBeenLastCalledWith('channel', next, CH);
      expect(store.getState().notificationPrefs.overrides[`channel:${CH}`]).toBe(next);
    }
  });

  it('a refused tap rolls back and says so', async () => {
    const { store, client } = setup(
      { [`channel:${CH}`]: 'all' },
      { setNotificationPreference: jest.fn(async () => Promise.reject(new Error('offline'))) },
    );
    await renderButton(store, client);
    await act(async () => {
      fireEvent.press(screen.getByTestId('title-bar-notifications'));
    });
    expect(store.getState().notificationPrefs.overrides[`channel:${CH}`]).toBe('all');
    expect(screen.getByTestId('title-bar-notifications-status').props.children).toMatch(/couldn't change/i);
  });

  it('a long-press opens the sheet; "Use workspace default" clears the row', async () => {
    const { store, client } = setup({ [`channel:${CH}`]: 'mute' });
    await renderButton(store, client);
    await act(async () => {
      fireEvent(screen.getByTestId('title-bar-notifications'), 'longPress');
    });
    const inherit = screen.getByTestId('title-bar-notifications-option-inherit');
    expect(inherit.props.accessibilityLabel).toBe('Use workspace default (Mentions only)');
    expect(screen.getByTestId('title-bar-notifications-option-mute').props.accessibilityState).toEqual({
      checked: true,
    });
    await act(async () => {
      fireEvent.press(inherit);
    });
    expect(client.clearNotificationPreference).toHaveBeenCalledWith('channel', CH);
    expect(store.getState().notificationPrefs.overrides[`channel:${CH}`]).toBeUndefined();
  });
});
