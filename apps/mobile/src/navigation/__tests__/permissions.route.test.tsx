/**
 * Channel-route permission derivation (ce-code-review gap B): the route reads
 * the workspace's roles through the api-client, resolves the current user's
 * bits on-device, and hands `MessageList` MANAGE_MESSAGES.
 *
 * `MessageList` is stubbed to report the prop it receives — this file's
 * subject is the ROUTE's derivation (wire roles → roster role ids → resolver),
 * not the list internals. The real list + real sheet half of the chain lives
 * in `permissions.list.test.tsx`, and the sheet's own gate in
 * `messages/__tests__/MessageActionsSheet.test.tsx`.
 */
import { screen, waitFor } from '@testing-library/react-native';
import { renderRouter } from 'expo-router/testing-library';

import { PERMISSIONS } from '@cytale/domain';

import {
  installWire,
  resetSessionModuleMock,
  signInRouteSession,
  signOutRouteSession,
  TOKENS,
  VERIFIED_USER,
  type Wire,
} from '../../auth/__tests__/support';
import { resetWorkspaceRoles } from '../permissions';
import { resetSurfaceStates } from '../shellState';
import { defaultStore } from '../store';
import { APP_DIR, IDS, resetShellStore, seedShellStore } from './support';

jest.mock('@cytale/session', () => require('../../auth/__tests__/support').sessionModuleMock());

// Mounting the whole app tree costs seconds, and this box runs parallel agent
// sessions — the repo's other `renderRouter` suites share the exposure (they
// time out at the 5s default under load and pass when run alone). Each test
// still fails fast on its own `waitFor`; this only bounds the whole test.
jest.setTimeout(30_000);

// Reports the permission gate the route resolved. The real component's props
// are the route's only contract with the list, so a stub is the honest probe.
jest.mock('../../messages/MessageList', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { Text, View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    MessageList: (props: { canManageMessages?: boolean }) =>
      React.createElement(
        View,
        { testID: 'message-list-stub' },
        React.createElement(
          Text,
          { testID: 'stub-can-manage' },
          String(props.canManageMessages === true),
        ),
      ),
  };
});

const MOD_ROLE_ID = '500000000000000001';

/**
 * The wire the route needs: the workspace's role rows (a Moderator role that
 * grants MANAGE_MESSAGES) and the auth reads a rebuilt manager performs. The
 * member's HELD ids come from the seeded roster, never from the wire.
 */
function installRoleWire(): Wire {
  return installWire([
    {
      match: (url) => /\/workspaces\/[^/]+\/roles$/.test(url),
      respond: () => ({
        status: 200,
        body: {
          roles: [
            {
              id: MOD_ROLE_ID,
              workspace_id: IDS.ws1,
              name: 'Moderator',
              permissions: PERMISSIONS.MANAGE_MESSAGES.toString(),
              position: 1,
              color: null,
            },
          ],
        },
      }),
    },
    { match: (url) => url.endsWith('/users/@me'), respond: () => ({ status: 200, body: { user: VERIFIED_USER } }) },
    { match: (url) => url.endsWith('/auth/refresh'), respond: () => ({ status: 200, body: TOKENS }) },
  ]);
}

let wire: Wire | null = null;

beforeEach(() => {
  resetSessionModuleMock();
  signInRouteSession();
  resetShellStore();
  resetSurfaceStates();
  resetWorkspaceRoles();
  seedShellStore();
});

afterEach(() => {
  wire?.restore();
  wire = null;
  signOutRouteSession();
  resetSessionModuleMock();
  resetShellStore();
  resetSurfaceStates();
  resetWorkspaceRoles();
});

describe('channel route permission gate', () => {
  it('hands the list MANAGE_MESSAGES for a member holding the role', async () => {
    defaultStore.setState((state) => ({
      membersById: {
        ...state.membersById,
        [IDS.me]: { ...state.membersById[IDS.me]!, roles: [MOD_ROLE_ID] },
      },
    }));
    wire = installRoleWire();

    await renderRouter(APP_DIR, { initialUrl: `/channel/${IDS.general}` });

    await waitFor(() => expect(screen.getByTestId('stub-can-manage')).toHaveTextContent('true'));
    expect(screen.getByTestId('message-list-stub')).toBeTruthy();
  });

  it('hands the list false for a member without the role', async () => {
    // The role exists in the workspace; this member does not hold it.
    wire = installRoleWire();

    await renderRouter(APP_DIR, { initialUrl: `/channel/${IDS.general}` });

    // The roles read is asynchronous: wait for the resolution to settle, then
    // assert the gate stayed false rather than asserting the initial render.
    await waitFor(() => expect(wire?.seen('/roles')).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId('stub-can-manage')).toHaveTextContent('false'));
  });
});
