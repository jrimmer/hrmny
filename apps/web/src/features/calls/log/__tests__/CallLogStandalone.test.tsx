/**
 * @cytale/web — CallLogStandalone tests (calls plan U9, R6/AM18).
 *
 * The main-room access without joining: the ThreadSidePanel-dock chrome,
 * hydration of the standing-thread mapping from REST (the idle-channel
 * path — client never saw a call), boundary rows from recently_ended with
 * no live call, close wiring, and axe on the docked surface.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import type { AxeMatchers } from 'vitest-axe/matchers';
import React from 'react';

declare module 'vitest' {
  interface Assertion<T> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}

import type { Message } from '@cytale/domain';
import type { CallStateResponse } from '@cytale/api-client';
import { createStateStore, type StateStore } from '@cytale/state';

import { authStore } from '../../../auth/session.js';
import { CallLogStandalone } from '../CallLogStandalone.js';

const CH = '9007199254740993';
const THREAD = '9007199254741000';
const ME = '7000000000000002';

const CALL_STATE: CallStateResponse = {
  thread_id: THREAD,
  live: null,
  recently_ended: [
    {
      call_id: '5000000000000001',
      started_by: ME,
      started_at: '2026-09-06T10:00:00Z',
      ended_at: '2026-09-06T10:30:00Z',
      reason: 'swept',
    },
  ],
};

const THREAD_MESSAGES: Message[] = [
  {
    id: '1000000000000002',
    channel_id: CH,
    thread_id: THREAD,
    author_id: ME,
    content: 'during the call',
    created_at: '2026-09-06T10:05:00Z',
    edited_at: null,
  },
];

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
  } as unknown as Response;
}

function installFetch(callState: CallStateResponse = CALL_STATE) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes(`/channels/${CH}/call`)) return jsonResponse(200, callState);
    if (url.includes(`/threads/${THREAD}/messages`)) {
      return jsonResponse(200, { messages: THREAD_MESSAGES });
    }
    return jsonResponse(404, { error: { key: 'not_found', code: 40404, message: 'no route' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function makeStore(): StateStore {
  const store = createStateStore();
  store.setState({ currentUser: { id: ME, username: 'me' } });
  return store;
}

beforeEach(() => {
  installFetch();
  authStore.getState().reset();
  authStore.getState().setStatus('authenticated');
  authStore.getState().setVerified(true);
  authStore.getState().setUser({
    id: ME,
    username: 'me',
    email: 'me@example.com',
    email_verified_at: '2026-08-30T00:00:00Z',
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CallLogStandalone — dock surface', () => {
  it('renders the ThreadSidePanel-dock chrome (title, close) around the log body', async () => {
    const onClose = vi.fn();
    render(<CallLogStandalone channelId={CH} store={makeStore()} onClose={onClose} />);

    expect(screen.getByTestId('call-log-standalone').getAttribute('data-channel-id')).toBe(CH);
    expect(screen.getByTestId('call-log-title').textContent).toBe('Call log');

    await waitFor(() => {
      expect(screen.getAllByTestId('message-item')).toHaveLength(1);
    });

    await userEvent.click(screen.getByTestId('call-log-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape closes the dock, like the settings panes and release notes', async () => {
    const onClose = vi.fn();
    render(<CallLogStandalone channelId={CH} store={makeStore()} onClose={onClose} />);
    await waitFor(() => expect(screen.getAllByTestId('message-item')).toHaveLength(1));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('an Escape a layer above already handled does not also close the dock', async () => {
    const onClose = vi.fn();
    render(<CallLogStandalone channelId={CH} store={makeStore()} onClose={onClose} />);
    await waitFor(() => expect(screen.getAllByTestId('message-item')).toHaveLength(1));
    const claim = (e: KeyboardEvent) => e.preventDefault();
    document.addEventListener('keydown', claim, { capture: true });
    try {
      fireEvent.keyDown(document, { key: 'Escape' });
    } finally {
      document.removeEventListener('keydown', claim, { capture: true });
    }
    expect(onClose).not.toHaveBeenCalled();
  });

  it('hydrates the standing-thread mapping from REST on an idle channel the client never saw a call on', async () => {
    const store = makeStore();
    expect(store.getState().callLogThreadIdByChannel[CH]).toBeUndefined();
    render(<CallLogStandalone channelId={CH} store={store} />);

    await waitFor(() => {
      expect(store.getState().callLogThreadIdByChannel[CH]).toBe(THREAD);
    });
    // Thread history loaded through the existing thread-message path.
    await waitFor(() => {
      expect(store.getState().messagesByThread[THREAD]?.items).toHaveLength(1);
    });
  });

  it('renders boundary rows from recently_ended with no live call (idle reading)', async () => {
    render(<CallLogStandalone channelId={CH} store={makeStore()} />);

    await waitFor(() => {
      expect(screen.getByTestId('call-boundary-start')).toBeTruthy();
    });
    expect(screen.getByTestId('call-boundary-end').textContent).toContain(
      'closed by server sweep',
    );
    // DOM order: start boundary, the in-call message, end boundary.
    const rows = screen.getByTestId('call-log-rows');
    const order = [...rows.querySelectorAll('[data-message-id], [data-testid^="call-boundary-"]')].map(
      (el) => el.getAttribute('data-testid') ?? 'message',
    );
    expect(order).toEqual(['call-boundary-start', 'message-item', 'call-boundary-end']);
  });

  it('renders the named empty state for a channel with no call history', async () => {
    installFetch({ thread_id: null, live: null, recently_ended: [] });
    render(<CallLogStandalone channelId={CH} store={makeStore()} />);

    await waitFor(() => {
      expect(screen.getByTestId('call-log-empty')).toBeTruthy();
    });
  });

  it('renders the error state with retry on REST failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(500, { error: { key: 'server_error', code: 50001, message: 'boom' } })),
    );
    render(<CallLogStandalone channelId={CH} store={makeStore()} />);

    await waitFor(() => {
      expect(screen.getByTestId('call-log-error').getAttribute('role')).toBe('alert');
    });
    expect(screen.getByTestId('call-log-retry')).toBeTruthy();
  });

  it('has no axe violations (rows + boundaries + composer)', async () => {
    const { container } = render(<CallLogStandalone channelId={CH} store={makeStore()} />);
    await waitFor(() => {
      expect(screen.getAllByTestId('message-item')).toHaveLength(1);
    });
    expect(await axe(container)).toHaveNoViolations();
  });
});
