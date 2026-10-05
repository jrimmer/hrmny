/**
 * Thread route wiring (plan 004 M9, R12).
 *
 * Mounts the REAL `app/` directory (root layout → drawer group → channel
 * route → pushed thread route) so the responsive contract is asserted where
 * the device runs it: the thread is a FULL-WIDTH surface pushed over the
 * conversation with a back path (plan-003's sub-768px behaviour, which is the
 * native presentation), never a side dock.
 *
 * "Back restores the channel's position" is asserted structurally, because
 * there is no simulator in this environment to read a scroll offset from: the
 * channel list must still be the SAME mounted instance (a remount would land
 * it on the newest message) with the IDENTICAL window object (no refetch, no
 * re-merge). FlashList is stubbed for that observation only — the rows still
 * render through the real `renderItem`, and the rest of the tree is real.
 */
import { act, renderRouter, screen, waitFor, within } from 'expo-router/testing-library';
import { router } from 'expo-router';

import type { Message } from '@cytale/domain';

import { defaultStore } from '../../navigation/store';
import { resetSessionModuleMock, signInRouteSession, signOutRouteSession } from '../../auth/__tests__/support';
import {
  APP_DIR,
  IDS as NAV,
  press,
  resetShellStore,
  seedShellStore,
} from '../../navigation/__tests__/support';
import { resetSurfaceStates, setSurfaceStates } from '../../navigation/shellState';
import { IDS, makeReply, replyId, threadRecord } from './support';

// M12's gate sends a signed-out tree to /sign-in; these tests exercise the
// drawer, so the session fixture (a REAL SessionManager on memory storage)
// starts signed in. Nothing about the session is mocked.
jest.mock('@cytale/session', () => require('../../auth/__tests__/support').sessionModuleMock());

/** Mounts per FlashList testID and the last `data` each received. */
const mockMounts: Record<string, number> = {};
const mockData: Record<string, unknown> = {};

jest.mock('@shopify/flash-list', () => {
  const { View } = require('react-native');
  const React = require('react');
  return {
    FlashList: (props: Record<string, any>) => {
      const id = typeof props.testID === 'string' ? props.testID : 'unknown';
      React.useEffect(() => {
        mockMounts[id] = (mockMounts[id] ?? 0) + 1;
      }, []);
      mockData[id] = props.data;
      return React.createElement(
        View,
        { testID: props.testID },
        (props.data as unknown[]).map((item, index) =>
          React.cloneElement(props.renderItem({ item, index, target: 'Cell' }), {
            key: props.keyExtractor(item, index),
          }),
        ),
      );
    },
  };
});

const CHANNEL_MESSAGE_IDS = ['1000000000000000001', '1000000000000000002'] as const;

function channelMessage(id: string, content: string): Message {
  return {
    id,
    channel_id: NAV.general,
    thread_id: null,
    author_id: NAV.alice,
    content,
    created_at: '2026-09-08T12:00:00.000Z',
    edited_at: null,
  };
}

/** Seed the channel window, the thread record and the thread's replies. */
function seedThreadSurface(): void {
  defaultStore.setState({
    threadsById: { [NAV.thread]: threadRecord({ name: 'Release train' }) },
    threadIdsByChannel: { [NAV.general]: [NAV.thread] },
    messagesByChannel: {
      [NAV.general]: {
        items: [
          channelMessage(CHANNEL_MESSAGE_IDS[1], 'newest channel message'),
          channelMessage(CHANNEL_MESSAGE_IDS[0], 'oldest channel message'),
        ],
        oldestId: CHANNEL_MESSAGE_IDS[0],
        hasCompleteHistory: true,
      },
    },
    messagesByThread: {
      [IDS.thread]: {
        items: [makeReply(2), makeReply(1)],
        oldestId: replyId(1),
        hasCompleteHistory: true,
      },
    },
  });
}

beforeEach(() => {
  resetSessionModuleMock();
  signInRouteSession();
  resetShellStore();
  resetSurfaceStates();
  seedShellStore();
  seedThreadSurface();
  for (const key of Object.keys(mockMounts)) delete mockMounts[key];
  for (const key of Object.keys(mockData)) delete mockData[key];
});

afterEach(() => {
  signOutRouteSession();
  resetSessionModuleMock();
  resetShellStore();
  resetSurfaceStates();
});

describe('thread surface', () => {
  it('pushes full-width over the channel, shows the replies, and back restores the channel position', async () => {
    const result = renderRouter(APP_DIR, { initialUrl: `/channel/${NAV.general}` });
    await result;

    expect(screen.getByTestId(`message-row-${CHANNEL_MESSAGE_IDS[0]}`)).toBeTruthy();
    expect(mockMounts['message-list']).toBe(1);
    const channelWindowBefore = mockData['message-list'];

    await act(async () => {
      router.push(`/thread/${NAV.thread}`);
    });

    expect(result.getPathname()).toBe(`/thread/${NAV.thread}`);
    const thread = screen.getByTestId('surface-thread');
    // One title bar for THIS surface: thread name + parent channel context.
    expect(within(thread).getAllByTestId('title-bar')).toHaveLength(1);
    expect(within(thread).getByTestId('title-bar-title')).toHaveTextContent('Release train');
    expect(screen.getByLabelText('Release train, #general')).toBeTruthy();
    // The thread's own list, full width in the surface body (no dock split).
    expect(within(thread).getByTestId('thread-message-list-root')).toBeTruthy();
    expect(screen.getByTestId(`message-row-${replyId(1)}`)).toBeTruthy();
    expect(screen.getByTestId(`message-row-${replyId(2)}`)).toBeTruthy();
    expect(mockMounts['thread-message-list']).toBe(1);

    await act(async () => {
      router.back();
    });

    expect(result.getPathname()).toBe(`/channel/${NAV.general}`);
    expect(screen.getByTestId('surface-channel')).toBeTruthy();
    expect(screen.getByTestId(`message-row-${CHANNEL_MESSAGE_IDS[0]}`)).toBeTruthy();
    // Same mounted list, same window object: the channel never re-landed at
    // its newest message and never refetched while the thread was open.
    expect(mockMounts['message-list']).toBe(1);
    expect(mockData['message-list']).toBe(channelWindowBefore);
  });

  it('back from a deep-linked thread lands on its parent channel', async () => {
    const result = renderRouter(APP_DIR, { initialUrl: `/thread/${NAV.thread}` });
    await result;

    expect(result.getPathname()).toBe(`/thread/${NAV.thread}`);
    expect(screen.getByTestId(`message-row-${replyId(1)}`)).toBeTruthy();

    // No history to pop (cold deep link) — the back path still leads to the
    // conversation the thread hangs off (R12: never a dead end).
    await press(screen.getByLabelText('Back'));

    expect(result.getPathname()).toBe(`/channel/${NAV.general}`);
    expect(screen.getByTestId('surface-channel')).toBeTruthy();
  });

  it('keeps the unknown thread a surface state, not a list state', async () => {
    const result = renderRouter(APP_DIR, { initialUrl: '/thread/999999999999999999' });
    await result;
    await waitFor(() => expect(screen.getByTestId('surface-error')).toBeTruthy());
    expect(screen.getByText('Thread 999999999999999999 is unavailable.')).toBeTruthy();
    expect(screen.queryByTestId('thread-message-list-root')).toBeNull();
  });

  it('renders the offline banner and permission-denied states on the surface', async () => {
    const result = renderRouter(APP_DIR, { initialUrl: `/thread/${NAV.thread}` });
    await result;
    await waitFor(() => expect(screen.getByTestId('surface-thread')).toBeTruthy());

    await act(async () => setSurfaceStates({ offline: true }));
    expect(screen.getByTestId('offline-banner')).toBeTruthy();

    await act(async () => setSurfaceStates({ offline: false }));
    expect(screen.queryByTestId('offline-banner')).toBeNull();

    await act(async () =>
      setSurfaceStates({ permissionDenied: 'You do not have access to this thread.' }),
    );
    expect(screen.getByTestId('permission-denied')).toBeTruthy();
    expect(screen.getByText('You do not have access to this thread.')).toBeTruthy();
  });
});
