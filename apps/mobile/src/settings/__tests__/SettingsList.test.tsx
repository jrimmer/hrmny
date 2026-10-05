/**
 * SettingsList (plan 004 M10, R14) — the list half of the list→section stack.
 *
 * The final row is the one ACTION on the list: log out must clear the
 * injected credential adapter (expo-secure-store in production), which is
 * asserted against the real session manager's memory storage.
 */
import { render, screen, userEvent, waitFor } from '@testing-library/react-native';

import { SettingsList } from '../SettingsList';
import { buildSettingsHarness, SEEDED_PAIR, USER } from './support';

describe('SettingsList', () => {
  it('lists the sections with Log out as the final row', async () => {
    const { services } = buildSettingsHarness(() => {
      throw new Error('the list performs no fetches');
    }, { user: USER });

    await render(<SettingsList services={services} onOpenSection={() => {}} />);

    expect(screen.getByTestId('settings-row-account')).toHaveTextContent(/Account/);
    expect(screen.getByTestId('settings-row-appearance')).toHaveTextContent(/Appearance/);
    // The WORD is "Agents" (R1); the row's key stays `integrations`.
    expect(screen.getByTestId('settings-row-integrations')).toHaveTextContent(/Agents/);
    expect(screen.getByTestId('settings-row-logout')).toHaveTextContent(/Log out/);

    // Order is the contract: Log out is last.
    const rows = screen.getAllByTestId(/^settings-row-/);
    expect(rows[rows.length - 1]?.props.testID).toBe('settings-row-logout');
  });

  it('pushes the selected section', async () => {
    const { services } = buildSettingsHarness(() => {
      throw new Error('the list performs no fetches');
    }, { user: USER });
    const onOpenSection = jest.fn();

    await render(<SettingsList services={services} onOpenSection={onOpenSection} />);
    const user = userEvent.setup();
    await user.press(screen.getByTestId('settings-row-appearance'));

    expect(onOpenSection).toHaveBeenCalledWith('appearance');
  });

  it('logs out from the final row: session unauthenticated, secure storage cleared', async () => {
    const { services, session, storage } = buildSettingsHarness(() => {
      throw new Error('log out must not fetch through the api client');
    }, { seed: SEEDED_PAIR, user: USER });
    expect(storage.read()).toEqual(SEEDED_PAIR);

    await render(<SettingsList services={services} onOpenSection={() => {}} />);
    const user = userEvent.setup();
    await user.press(screen.getByTestId('settings-row-logout'));

    await waitFor(() => expect(session.authStore.getState().status).toBe('unauthenticated'));
    expect(storage.read()).toBeNull();
    expect(session.authStore.getState().currentUser).toBeNull();
  });
});
