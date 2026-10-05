/**
 * @cytale/web — the side-panel icons with a thread open at desktop.
 *
 * At desktop the thread dock takes the side column's slot (`railHidden`
 * covers `activeThread`), yet the channel header hid its rail icons whenever
 * the channel's column MODE was set — Members, by default at desktop. So with
 * a thread open there were no Members / Call log / Threads icons anywhere, and
 * the only way to the member list or My Threads was to close the thread first
 * (the same shape as Home's missing band, 63edc546).
 *
 * The fix keeps the header icons up while a thread holds the column, none
 * pressed, and choosing one REPLACES the thread with that pane (Discord's
 * behaviour; the dock and the column share one slot). Rendered through the
 * whole `AuthenticatedApp` because the rule lives in how the shell composes
 * the header, the dock and the column — jsdom's band is desktop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

import type { Message } from '@cytale/domain';
import { defaultStore } from '@cytale/state';

vi.mock('react-virtuoso', () => ({
  Virtuoso: React.forwardRef(function VirtuosoMock(
    props: {
      data?: readonly unknown[];
      itemContent: (index: number, data: unknown) => React.ReactNode;
      computeItemKey?: (index: number, data: unknown) => string;
    },
    ref: React.Ref<unknown>,
  ) {
    React.useImperativeHandle(ref, () => ({
      scrollToIndex: () => undefined,
      scrollTo: () => undefined,
      scrollBy: () => undefined,
    }));
    const items = props.data ?? [];
    return (
      <div data-testid="virtuoso-mock">
        {items.map((item, i) => (
          <div key={props.computeItemKey?.(i, item) ?? i} data-testid="virtuoso-item">
            {props.itemContent(i, item)}
          </div>
        ))}
      </div>
    );
  }),
}));

import { AuthenticatedApp } from '../../AuthenticatedApp.js';
import { api, authStore } from '../../features/auth/session.js';

const WS = '1001';
const CHANNEL = '2002';
const ROOT = '3002';
const THREAD = '4004';
const REPLY = '3004';
const ME = '7000000000000001';

const root: Message = {
  id: ROOT,
  channel_id: CHANNEL,
  thread_id: null,
  author_id: ME,
  content: 'thread root',
  created_at: '2026-08-30T12:00:00Z',
  edited_at: null,
};

const reply: Message = { ...root, id: REPLY, thread_id: THREAD, content: 'a reply' };

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
  } as unknown as Response;
}

function installFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (/\/channels\/([^/]+)\/messages\/([^/?]+)$/.test(url)) {
        return jsonResponse(200, { message: root });
      }
      if (/\/channels\/([^/]+)\/messages(?:\?([^#]*))?$/.test(url)) {
        return jsonResponse(200, { messages: [root], oldest_id: null });
      }
      if (/\/people(\?|$)/.test(url) || /\/members(\?|$)/.test(url)) {
        return jsonResponse(200, { people: [], next_before: null });
      }
      if (/\/users\/@me\/inbox/.test(url)) {
        return jsonResponse(200, { items: [], oldest_id: null });
      }
      return jsonResponse(200, {});
    }),
  );
}

function seedStore(): void {
  authStore.setState({ status: 'authenticated', emailVerified: true } as never);
  defaultStore.setState({
    currentUser: { id: ME, username: 'me', email: 'me@example.com', avatar_url: null } as never,
    sessionStatus: 'ready',
    workspaces: {
      [WS]: {
        id: WS,
        name: 'Workspace',
        icon_url: null,
        description: null,
        owner_id: ME,
        role_version: 0,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    } as never,
    channels: {
      [CHANNEL]: {
        id: CHANNEL,
        workspace_id: WS,
        name: 'general',
        type: 'text',
        topic: null,
        position: 0,
        last_message_id: ROOT,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    } as never,
    messagesByChannel: {} as never,
    threadsById: {
      [THREAD]: {
        id: THREAD,
        channel_id: CHANNEL,
        parent_message_id: ROOT,
        name: 'thread root',
        created_by: ME,
        archived: false,
        member_state: { notify: true, last_read_id: null },
        created_at: '2026-08-30T12:00:00Z',
      },
    } as never,
    threadIdsByChannel: { [CHANNEL]: [THREAD] } as never,
    messagesByThread: {} as never,
    unreadByChannel: {} as never,
    membersById: {} as never,
  });
}

/**
 * Land on the channel with its thread docked — through a reply's permalink,
 * the address form whose thread segment opens the dock on arrival.
 */
async function renderWithThreadOpen(): Promise<HTMLElement> {
  seedStore();
  installFetch();
  vi.spyOn(api, 'getThreadMessages').mockResolvedValue([reply]);
  globalThis.location.hash = `/workspace/${WS}/channel/${CHANNEL}/thread/${THREAD}/message/${REPLY}`;
  render(<AuthenticatedApp />);
  await screen.findByTestId('thread-dock');
  return screen.findByTestId('channel-header');
}

beforeEach(() => {
  globalThis.history.replaceState(null, '', '/');
  globalThis.location.hash = '';
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  globalThis.location.hash = '';
});

describe('desktop, thread open — the side-panel icons stay reachable', () => {
  it('the channel header carries all three icons, none pressed, and no column is up', async () => {
    const header = await renderWithThreadOpen();
    const icons = within(header).getByTestId('rail-icons');
    for (const mode of ['members', 'calls', 'threads'] as const) {
      const icon = within(icons).getByTestId(`rail-icon-${mode}`);
      expect(icon.getAttribute('aria-pressed')).toBe('false');
    }
    // The dock holds the slot: the column (and its own icon set) is down.
    expect(screen.queryByTestId('rail-pane')).toBeNull();
    expect(screen.getAllByTestId('rail-icons')).toHaveLength(1);
  });

  it.each(['members', 'calls', 'threads'] as const)(
    'choosing %s replaces the thread with that pane',
    async (mode) => {
      const header = await renderWithThreadOpen();
      await userEvent.setup().click(within(header).getByTestId(`rail-icon-${mode}`));

      await waitFor(() => expect(screen.queryByTestId('thread-dock')).toBeNull());
      const pane = await screen.findByTestId('rail-pane');
      // OPENS the chosen mode — not a toggle of the (hidden) default Members.
      expect(pane.getAttribute('data-mode')).toBe(mode);
      // The icons moved into the column's header (the desktop rule), pressed.
      expect(within(pane).getByTestId(`rail-icon-${mode}`).getAttribute('aria-pressed')).toBe(
        'true',
      );
      expect(within(screen.getByTestId('channel-header')).queryByTestId('rail-icons')).toBeNull();
    },
  );

  it("the thread's own close still leaves the column as it was (Members at desktop)", async () => {
    await renderWithThreadOpen();
    await userEvent.setup().click(screen.getByTestId('thread-close'));
    await waitFor(() => expect(screen.queryByTestId('thread-dock')).toBeNull());
    expect((await screen.findByTestId('rail-pane')).getAttribute('data-mode')).toBe('members');
  });
});
