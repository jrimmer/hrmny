/**
 * Route-level checks for the settings stack (plan 004 M10, R14).
 *
 * `renderRouter` mounts the REAL `app/` tree, so these pin the dispatcher the
 * M5 stack tests don't reach: every list row pushes the section it names, the
 * section renders inside the shell's frame, and an unknown segment gets an
 * honest not-found instead of a blank body.
 */
import { renderRouter, screen } from 'expo-router/testing-library';
import { userEvent } from '@testing-library/react-native';

import { resetSessionModuleMock, signInRouteSession, signOutRouteSession } from '../../auth/__tests__/support';

// The mobile tsconfig ships jest types only (no @types/node), so the two
// CommonJS globals these tests need are declared locally.
declare const __dirname: string;

const APP_DIR = `${__dirname}/../../../app`;

// M12's gate sends a signed-out tree to /sign-in; these tests exercise the
// settings stack, so the session fixture (a REAL SessionManager on memory
// storage) starts signed in. Nothing about the session is mocked.
jest.mock('@cytale/session', () => require('../../auth/__tests__/support').sessionModuleMock());

async function press(element: Parameters<typeof userEvent.press>[0]): Promise<void> {
  const user = userEvent.setup();
  await user.press(element);
}

beforeEach(() => {
  resetSessionModuleMock();
  signInRouteSession();
});

afterEach(() => {
  signOutRouteSession();
  resetSessionModuleMock();
});

describe('settings section routes', () => {
  it('pushes the appearance section from the list and renders it', async () => {
    const result = renderRouter(APP_DIR, { initialUrl: '/settings' });
    await result;

    await press(screen.getByTestId('settings-row-appearance'));

    expect(result.getPathname()).toBe('/settings/appearance');
    expect(screen.getByTestId('surface-settings-section')).toBeTruthy();
    expect(screen.getByTestId('title-bar-title')).toHaveTextContent('Appearance');
    expect(screen.getByTestId('settings-appearance')).toBeTruthy();
  });

  it('renders an honest not-found for an unknown section', async () => {
    const result = renderRouter(APP_DIR, { initialUrl: '/settings/emoji' });
    await result;

    expect(result.getPathname()).toBe('/settings/emoji');
    expect(screen.getByTestId('settings-section-not-found')).toBeTruthy();
  });
});
