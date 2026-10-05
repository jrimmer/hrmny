/**
 * @cytale/web — CallLogPane tests (calls plan U9).
 *
 * The panel-embedded log surface: the states-first DoD (loading / empty /
 * error+retry / offline / view-only / permission-denied), boundary rows
 * interpolated among messages (REST ended + store live start), and the
 * composer routing — posts to the THREAD reply route, never the channel
 * (R5) — including the keyboard flow log→composer→send through the real
 * Enter wiring (the onEditorReady seam; jsdom cannot drive Lexical input).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import type { AxeMatchers } from 'vitest-axe/matchers';
import React from 'react';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  KEY_ENTER_COMMAND,
  type LexicalEditor,
} from 'lexical';

declare module 'vitest' {
  interface Assertion<T> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}

import type { Message } from '@cytale/domain';
import type { CallStateResponse } from '@cytale/api-client';
import { createStateStore, type StateStore } from '@cytale/state';

import { authStore } from '../../../auth/session.js';
import { CallLogPane } from '../CallLogPane.js';

const CH = '9007199254740993';
const THREAD = '9007199254741000';
const ME = '7000000000000002';
const U2 = '7000000000000009';

const CALL_STATE: CallStateResponse = {
  thread_id: THREAD,
  live: null,
  recently_ended: [
    {
      call_id: '5000000000000001',
      started_by: ME,
      started_at: '2026-09-06T10:00:00Z',
      ended_at: '2026-09-06T10:30:00Z',
      reason: 'last_left',
    },
  ],
};

// Newest-first (the store slice order): after / during / before the call.
const THREAD_MESSAGES: Message[] = [
  {
    id: '1000000000000003',
    channel_id: CH,
    thread_id: THREAD,
    author_id: ME,
    content: 'after the call',
    created_at: '2026-09-06T10:31:00Z',
    edited_at: null,
  },
  {
    id: '1000000000000002',
    channel_id: CH,
    thread_id: THREAD,
    author_id: U2,
    content: 'during the call',
    created_at: '2026-09-06T10:05:00Z',
    edited_at: null,
  },
  {
    id: '1000000000000001',
    channel_id: CH,
    thread_id: THREAD,
    author_id: ME,
    content: 'before the call',
    created_at: '2026-09-06T09:55:00Z',
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

/** Fetch stub: getCall + thread history (+ POST capture for sends). */
function installFetch(overrides: { callState?: CallStateResponse; failCall?: boolean } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.includes(`/channels/${CH}/call`)) {
      if (overrides.failCall) {
        return jsonResponse(500, { error: { key: 'server_error', code: 50001, message: 'boom' } });
      }
      return jsonResponse(200, overrides.callState ?? CALL_STATE);
    }
    if (url.includes(`/threads/${THREAD}/messages`)) {
      if (method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { content: string };
        return jsonResponse(201, {
          message: {
            id: '1000000000000009',
            channel_id: CH,
            thread_id: THREAD,
            author_id: ME,
            content: body.content,
            created_at: '2026-09-06T10:32:00Z',
            edited_at: null,
          },
        });
      }
      return jsonResponse(200, { messages: THREAD_MESSAGES });
    }
    return jsonResponse(404, { error: { key: 'not_found', code: 40404, message: 'no route' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function makeStore(): StateStore {
  const store = createStateStore();
  store.setState((s) => ({
    ...s,
    currentUser: { id: ME, username: 'me' },
    membersById: {
      ...s.membersById,
      [U2]: { id: U2, username: 'river', nickname: null, joined_at: '', roles: [] },
    },
  }));
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

describe('CallLogPane — states-first DoD', () => {
  it('shows the announced loading skeleton while hydrating', () => {
    // A never-resolving getCall keeps the loading state mounted.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );
    render(<CallLogPane channelId={CH} store={makeStore()} />);
    const skeleton = screen.getByTestId('call-log-loading');
    expect(skeleton.getAttribute('role')).toBe('progressbar');
    expect(skeleton.getAttribute('aria-busy')).toBe('true');
  });

  it('renders the named empty state for a channel with no call history', async () => {
    installFetch({
      callState: { thread_id: null, live: null, recently_ended: [] },
    });
    render(<CallLogPane channelId={CH} store={makeStore()} />);

    await waitFor(() => {
      expect(screen.getByTestId('call-log-empty')).toBeTruthy();
    });
    expect(screen.getByTestId('call-log-empty').textContent).toContain('No call history yet');
    // Nothing to post into — no composer without a standing thread.
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('renders error with retry on REST failure, and retry recovers', async () => {
    let fail = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes(`/channels/${CH}/call`)) {
          if (fail) {
            fail = false;
            return jsonResponse(500, { error: { key: 'server_error', code: 50001, message: 'boom' } });
          }
          return jsonResponse(200, CALL_STATE);
        }
        if (url.includes(`/threads/${THREAD}/messages`)) {
          return jsonResponse(200, { messages: THREAD_MESSAGES });
        }
        return jsonResponse(404, { error: { key: 'not_found', code: 40404, message: 'no route' } });
      }),
    );
    render(<CallLogPane channelId={CH} store={makeStore()} />);

    await waitFor(() => {
      expect(screen.getByTestId('call-log-error').getAttribute('role')).toBe('alert');
    });

    await act(async () => {
      screen.getByTestId('call-log-retry').click();
    });
    await waitFor(() => {
      expect(screen.getByTestId('call-log-rows')).toBeTruthy();
    });
    expect(screen.getAllByTestId('message-item')).toHaveLength(3);
  });

  it('shows the persistent offline banner while content still renders', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    render(<CallLogPane channelId={CH} store={makeStore()} />);
    await waitFor(() => {
      expect(screen.getByTestId('call-log-rows')).toBeTruthy();
    });
    expect(screen.getByTestId('call-log-offline').getAttribute('role')).toBe('status');
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  });

  it('replaces the composer with an explicit view-only note when SEND_MESSAGES is denied', async () => {
    render(<CallLogPane channelId={CH} store={makeStore()} canSendMessages={false} />);
    await waitFor(() => {
      expect(screen.getByTestId('call-log-rows')).toBeTruthy();
    });
    expect(screen.getByTestId('call-log-view-only').textContent).toContain('View-only');
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('replaces the surface with a permission-denied alert when the channel is invisible', () => {
    render(
      <CallLogPane channelId={CH} store={makeStore()} permissionDenied="Channel not found." />,
    );
    const alert = screen.getByTestId('call-log-permission-denied');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(screen.queryByTestId('call-log-loading')).toBeNull();
  });
});

describe('CallLogPane — rows and boundaries', () => {
  it('interleaves REST ended boundaries among the thread messages chronologically', async () => {
    render(<CallLogPane channelId={CH} store={makeStore()} />);

    await waitFor(() => {
      expect(screen.getAllByTestId('message-item')).toHaveLength(3);
    });

    const rows = screen.getByTestId('call-log-rows');
    const order = [...rows.querySelectorAll('[data-message-id], [data-testid^="call-boundary-"]')].map(
      (el) =>
        el.hasAttribute('data-message-id')
          ? `m:${el.getAttribute('data-message-id')}`
          : `${el.getAttribute('data-testid')}:${el.getAttribute('data-call-id')}`,
    );
    expect(order).toEqual([
      'm:1000000000000001', // 09:55 before
      'call-boundary-start:5000000000000001', // 10:00
      'm:1000000000000002', // 10:05 during
      'call-boundary-end:5000000000000001', // 10:30
      'm:1000000000000003', // 10:31 after
    ]);
    expect(screen.getByTestId('call-boundary-end').textContent).toContain(
      'last participant left',
    );
  });

  it('renders the LIVE start boundary from the store (no end row) while a call is live', async () => {
    const store = makeStore();
    store.setState({
      callByChannel: {
        [CH]: {
          call_id: '5000000000000002',
          thread_id: THREAD,
          started_by: ME,
          started_at: '2026-09-06T11:00:00Z',
          participants: {},
        },
      },
    });
    render(<CallLogPane channelId={CH} store={store} />);

    await waitFor(() => {
      expect(screen.getAllByTestId('call-boundary-start')).toHaveLength(2);
    });
    const live = screen
      .getAllByTestId('call-boundary-start')
      .find((el) => el.getAttribute('data-call-id') === '5000000000000002');
    expect(live).toBeTruthy();
    // The live call has ended rows only from REST (one), none for the live id.
    expect(
      screen.getAllByTestId('call-boundary-end').filter(
        (el) => el.getAttribute('data-call-id') === '5000000000000002',
      ),
    ).toHaveLength(0);
  });

  it('hydrates the standing-thread mapping into the store (R5 exclusion key)', async () => {
    const store = makeStore();
    render(<CallLogPane channelId={CH} store={store} />);
    await waitFor(() => {
      expect(store.getState().callLogThreadIdByChannel[CH]).toBe(THREAD);
    });
  });
});

describe('CallLogPane — composer routing (R5)', () => {
  it('posts to the thread reply route, never the channel; the channel timeline/unread stay clean', async () => {
    const fetchMock = installFetch();
    const store = makeStore();
    let editor: LexicalEditor | null = null;
    render(
      <CallLogPane
        channelId={CH}
        store={store}
        onComposerReady={(e) => {
          editor = e;
        }}
      />,
    );

    await waitFor(() => expect(editor).not.toBeNull());
    await waitFor(() => {
      expect(screen.getAllByTestId('message-item')).toHaveLength(3);
    });

    act(() => {
      editor!.update(() => {
        const root = $getRoot();
        root.clear();
        const p = $createParagraphNode();
        p.append($createTextNode('sent from the call log'));
        root.append(p);
      });
    });
    editor!.dispatchCommand(KEY_ENTER_COMMAND, {
      shiftKey: false,
      preventDefault: () => {},
    } as unknown as KeyboardEvent);

    await waitFor(() => {
      expect(
        vi
          .mocked(fetchMock)
          .mock.calls.some(([input, init]) => {
            const method = (init?.method ?? 'GET').toUpperCase();
            return method === 'POST' && String(input).includes(`/threads/${THREAD}/messages`);
          }),
      ).toBe(true);
    });

    // NEVER a channel-message POST (R5: call-log text lands in the thread only).
    expect(
      vi
        .mocked(fetchMock)
        .mock.calls.some(([input, init]) => {
          const method = (init?.method ?? 'GET').toUpperCase();
          return method === 'POST' && String(input).includes(`/channels/${CH}/messages`);
        }),
    ).toBe(false);

    // The sent message reconciles into the log surface (ThreadMessageCreate)…
    await waitFor(() => {
      expect(store.getState().messagesByThread[THREAD]?.items).toHaveLength(4);
    });
    expect(screen.getByTestId('call-log-rows').textContent).toContain('sent from the call log');

    // …and the channel timeline + unread never learn about it.
    expect(store.getState().messagesByChannel[CH]).toBeUndefined();
    expect(store.getState().unreadByChannel[CH]).toBeUndefined();
  });

  it('keyboard flow: Tab reaches the composer from the pane (panel → log → composer)', async () => {
    render(<CallLogPane channelId={CH} store={makeStore()} />);
    await waitFor(() => {
      expect(screen.getAllByTestId('message-item')).toHaveLength(3);
    });

    // Lexical's editable (the combobox-pattern input).
    const editable = screen.getByRole('combobox');
    // Walk the document tab order from the top: the composer's editable is
    // reachable by keyboard alone (no pointer-only path).
    document.body.focus();
    for (let i = 0; i < 40 && document.activeElement !== editable; i++) {
      await userEvent.tab();
    }
    expect(document.activeElement).toBe(editable);
  });

  it('has no axe violations in the ready state (rows + boundaries + composer)', async () => {
    const { container } = render(<CallLogPane channelId={CH} store={makeStore()} />);
    await waitFor(() => {
      expect(screen.getAllByTestId('message-item')).toHaveLength(3);
    });
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations in the empty state', async () => {
    installFetch({ callState: { thread_id: null, live: null, recently_ended: [] } });
    const { container } = render(<CallLogPane channelId={CH} store={makeStore()} />);
    await waitFor(() => {
      expect(screen.getByTestId('call-log-empty')).toBeTruthy();
    });
    expect(await axe(container)).toHaveNoViolations();
  });
});
