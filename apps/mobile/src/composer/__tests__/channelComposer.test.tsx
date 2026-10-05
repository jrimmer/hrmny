/**
 * Channel route wiring for the composer (plan 004 M7).
 *
 * Mounts the REAL `app/` directory (root layout → drawer group → channel
 * route) so the integration is asserted where the device runs it: the
 * composer sits under `MessageList` inside `channel-body`, and the reply
 * target the list hands up reaches the composer's reply bar. The session in
 * this harness is unauthenticated, which is also the signed-out contract —
 * the composer still renders (sending is the surface's job to gate).
 */
import { screen, within } from '@testing-library/react-native';
import { renderRouter } from 'expo-router/testing-library';

import { resetSessionModuleMock, signInRouteSession, signOutRouteSession } from '../../auth/__tests__/support';
import { APP_DIR, IDS, resetShellStore, seedShellStore } from '../../navigation/__tests__/support';
import { resetSurfaceStates } from '../../navigation/shellState';
import { resetEmojiPreferences } from '../emojiPreferences';

// M12's gate sends a signed-out tree to /sign-in, and the shell only renders
// for an authenticated member; this harness signs in through the session
// fixture (a REAL SessionManager on memory storage, empty-page wire).
jest.mock('@cytale/session', () => require('../../auth/__tests__/support').sessionModuleMock());

beforeEach(() => {
  resetSessionModuleMock();
  signInRouteSession();
  resetShellStore();
  resetSurfaceStates();
  resetEmojiPreferences();
  seedShellStore();
});

afterEach(() => {
  signOutRouteSession();
  resetSessionModuleMock();
  resetShellStore();
  resetSurfaceStates();
  resetEmojiPreferences();
});

describe('channel route — composer', () => {
  it('mounts the composer under the message list', async () => {
    await renderRouter(APP_DIR, { initialUrl: `/channel/${IDS.general}` });

    const body = screen.getByTestId('channel-body');
    expect(within(body).getByTestId('message-list-root')).toBeTruthy();
    expect(within(body).getByTestId('message-compose')).toBeTruthy();
    expect(within(body).getByTestId('composer-input')).toBeTruthy();
    expect(within(body).getByTestId('composer-send')).toBeTruthy();
  });

  it('keeps one composer for the channel and no reply bar until a reply starts', async () => {
    await renderRouter(APP_DIR, { initialUrl: `/channel/${IDS.general}` });

    expect(screen.getAllByTestId('message-compose')).toHaveLength(1);
    expect(screen.queryByTestId('reply-bar')).toBeNull();
  });
});
