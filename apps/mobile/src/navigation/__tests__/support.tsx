/**
 * Shared fixtures for the navigation tests (plan 004 M5). Not a test file —
 * jest's testMatch only picks up `*.test.ts(x)`.
 *
 * The store is seeded directly (the shell is a projection over
 * `@cytale/state`); `resetShellStore()` restores the pristine state so a
 * seeded workspace never leaks into the next test.
 */
import { userEvent } from '@testing-library/react-native';
import { defaultStore } from '@cytale/state';

// The mobile tsconfig ships jest types only (no @types/node), so the two
// CommonJS globals these tests need are declared locally instead of pulling
// Node types into the app's type environment.
declare const __dirname: string;

/**
 * Press + flush. RNTL v14 runs React 19's concurrent renderer, where
 * `fireEvent`'s synchronous act leaves the update unflushed; `userEvent` is
 * the async-first API that awaits the effects. Every press in the navigation
 * tests goes through here.
 */
export async function press(element: Parameters<typeof userEvent.press>[0]): Promise<void> {
  const user = userEvent.setup();
  await user.press(element);
}

/** The real app directory expo-router's testing library renders. */
export const APP_DIR = `${__dirname}/../../../app`;

const PRISTINE = defaultStore.getState();

/** Restore the module-default store to its boot state. */
export function resetShellStore(): void {
  defaultStore.setState(PRISTINE, true);
}

export const IDS = {
  me: '900000000000000001',
  alice: '900000000000000002',
  bob: '900000000000000003',
  ws1: '800000000000000001',
  ws2: '800000000000000002',
  general: '700000000000000001',
  random: '700000000000000002',
  other: '700000000000000003',
  thread: '600000000000000001',
} as const;

/** Two workspaces, three channels, three members, one unread badge. */
export function seedShellStore(): void {
  defaultStore.setState({
    currentUser: { id: IDS.me, username: 'rowan' },
    workspaces: {
      [IDS.ws1]: {
        id: IDS.ws1,
        name: 'JMC',
        owner_id: IDS.me,
        role_version: 1,
        created_at: '2026-09-08T00:00:00.000Z',
      },
      [IDS.ws2]: {
        id: IDS.ws2,
        name: 'Starbug',
        owner_id: IDS.me,
        role_version: 1,
        created_at: '2026-09-08T00:00:00.000Z',
      },
    },
    channels: {
      [IDS.general]: {
        id: IDS.general,
        workspace_id: IDS.ws1,
        name: 'general',
        type: 'text',
        topic: 'Ship it',
        position: 0,
        last_message_id: null,
        created_at: '2026-09-08T00:00:00.000Z',
      },
      [IDS.random]: {
        id: IDS.random,
        workspace_id: IDS.ws1,
        name: 'random',
        type: 'text',
        topic: null,
        position: 1,
        last_message_id: null,
        created_at: '2026-09-08T00:00:00.000Z',
      },
      [IDS.other]: {
        id: IDS.other,
        workspace_id: IDS.ws2,
        name: 'starbug-general',
        type: 'text',
        topic: null,
        position: 0,
        last_message_id: null,
        created_at: '2026-09-08T00:00:00.000Z',
      },
    },
    membersById: {
      [IDS.me]: { id: IDS.me, username: 'rowan', nickname: null, joined_at: '2026-09-08T00:00:00.000Z', roles: [] },
      [IDS.alice]: { id: IDS.alice, username: 'alice', nickname: null, joined_at: '2026-09-08T00:00:00.000Z', roles: [] },
      // The shown name is the display name (#168); a nickname is per-workspace (#169).
      [IDS.bob]: { id: IDS.bob, username: 'bob', display_name: 'Bobby', nickname: null, joined_at: '2026-09-08T00:00:00.000Z', roles: [] },
    },
    memberIdsByWorkspace: { [IDS.ws1]: [IDS.me, IDS.alice, IDS.bob] },
    presenceByUser: { [IDS.alice]: { status: 'online', last_seen_at: '2026-09-08T00:00:00.000Z' } },
    unreadByChannel: {
      [IDS.random]: { last_read_id: null, unread_count: 3, mention_count: 1 },
    },
  });
}
