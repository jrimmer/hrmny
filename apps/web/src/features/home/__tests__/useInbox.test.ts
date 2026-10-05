/**
 * @cytale/web — the inbox hydrate (#117), driven through the hook.
 *
 * This is the wiring proof for the two rules the pure tests pin in isolation:
 *
 *   * the boot hydrate MERGES — a mention that lands while the fetch is in
 *     flight survives the response landing on top of it (a replace would
 *     erase it, which is the failure the ticket calls worse than what
 *     exists);
 *   * the ONE read state prunes — acknowledging the channel answers its rows
 *     in the surface, with no second tracker and no second set of numbers.
 *
 * Plus the two writes the surface performs (done / sweep) going to the right
 * REST paths, and rolling back when they fail.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createStateStore, type StateStore } from '@cytale/state';

import type { GatewayClient } from '@cytale/gateway-client';

import { useInbox } from '../useInbox.js';

const CHANNEL = '2000000000000002';
const WORKSPACE = '3000000000000003';
const MENTION = '1000000000000001';
const LIVE = '1000000000000009';

function storeWithChannel(): StateStore {
  const store = createStateStore();
  store.setState({
    currentUser: { id: '7000000000000007', username: 'me' } as never,
    sessionEpoch: 1,
    channels: {
      [CHANNEL]: {
        id: CHANNEL,
        workspace_id: WORKSPACE,
        name: 'release',
        type: 'text',
      } as never,
    },
    membersById: {
      '4000000000000004': { id: '4000000000000004', username: 'dana' } as never,
    },
  });
  return store;
}

/** A gateway stub whose handlers the test fires by hand. */
function fakeGateway() {
  const handlers = new Map<string, (payload: unknown) => void>();
  const gateway = {
    on: (name: string, handler: (payload: unknown) => void) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
  } as unknown as GatewayClient;

  return { gateway, emit: (name: string, payload: unknown) => handlers.get(name)?.(payload) };
}

const serverItem = {
  message_id: MENTION,
  channel_id: CHANNEL,
  thread_id: null,
  author_id: '4000000000000004',
  author_username: 'dana',
  kind: 'mention',
  excerpt: 'from the server <@7000000000000007>',
  created_at: '2026-09-14T10:00:00.000Z',
};

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useInbox — the hydrate', () => {
  it('loads the backlog on boot', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ items: [serverItem], oldest_id: MENTION })));

    const { result } = renderHook(() => useInbox(storeWithChannel(), null, 'tok'));

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.items.map((i) => i.message_id)).toEqual([MENTION]);

    const [url] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toContain('/api/v1/users/@me/inbox');
  });

  it('MERGES a live mention that lands while the hydrate is in flight', async () => {
    // A fetch the test resolves by hand — the race window, held open.
    let release: (value: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(pending));

    const store = storeWithChannel();
    const { gateway, emit } = fakeGateway();
    const { result } = renderHook(() => useInbox(store, gateway, 'tok'));

    await waitFor(() => expect(result.current.status).toBe('loading'));

    // The mention arrives live, mid-request.
    await act(async () => {
      emit('MessageCreate', {
        id: LIVE,
        channel_id: CHANNEL,
        thread_id: null,
        author_id: '4000000000000004',
        content: 'live ping <@7000000000000007>',
        created_at: '2026-09-14T11:00:00.000Z',
      });
    });

    // The snapshot the server answered with does NOT contain it (it was taken
    // before the message existed).
    await act(async () => {
      release(jsonResponse({ items: [serverItem], oldest_id: MENTION }));
      await pending;
    });

    await waitFor(() => expect(result.current.status).toBe('ready'));

    // Both survive — the local accrual is not clobbered by the hydrate.
    expect(result.current.items.map((i) => i.message_id)).toEqual([LIVE, MENTION]);
    expect(result.current.items.find((i) => i.message_id === LIVE)?.excerpt).toContain('live ping');
  });

  it('does not accrue a row for my own message or for a non-mention', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ items: [], oldest_id: null })));

    const store = storeWithChannel();
    const { gateway, emit } = fakeGateway();
    const { result } = renderHook(() => useInbox(store, gateway, 'tok'));

    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      emit('MessageCreate', {
        id: LIVE,
        channel_id: CHANNEL,
        author_id: '4000000000000004',
        content: 'no address here',
      });
      emit('MessageCreate', {
        id: '1000000000000011',
        channel_id: CHANNEL,
        author_id: '7000000000000007',
        content: 'my own <@7000000000000007>',
      });
    });

    expect(result.current.items).toHaveLength(0);
  });

  it('accrues a thread mention, which rides its own dispatch name', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ items: [], oldest_id: null })));

    const store = storeWithChannel();
    const { gateway, emit } = fakeGateway();
    const { result } = renderHook(() => useInbox(store, gateway, 'tok'));

    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      // The server keeps a thread reply off the channel timeline and dispatches
      // it under its own name — the payload still carries the parent channel.
      emit('ThreadMessageCreate', {
        id: LIVE,
        channel_id: CHANNEL,
        thread_id: '5000000000000005',
        author_id: '4000000000000004',
        content: 'in a thread <@7000000000000007>',
        created_at: '2026-09-14T11:00:00.000Z',
      });
    });

    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0]!.thread_id).toBe('5000000000000005');
  });

  it('reports a failed hydrate and retries on demand', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue(jsonResponse({ items: [serverItem], oldest_id: MENTION }));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useInbox(storeWithChannel(), null, 'tok'));

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toMatch(/network down/i);

    act(() => result.current.retry());

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.items).toHaveLength(1);
  });

  it('claims nothing without a credential', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useInbox(storeWithChannel(), null, null));

    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.items).toHaveLength(0);
  });
});

describe('useInbox — the one read state prunes the view', () => {
  it('drops a row the channel watermark already covers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ items: [serverItem], oldest_id: MENTION })));

    const store = storeWithChannel();
    const { result } = renderHook(() => useInbox(store, null, 'tok'));

    await waitFor(() => expect(result.current.items).toHaveLength(1));

    act(() => {
      store.setState({
        unreadByChannel: {
          [CHANNEL]: { last_read_id: MENTION, unread_count: 0, mention_count: 0 },
        },
      });
    });

    await waitFor(() => expect(result.current.items).toHaveLength(0));
  });

  it('leaves a row the watermark does not cover', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ items: [serverItem], oldest_id: MENTION })));

    const store = storeWithChannel();
    const { result } = renderHook(() => useInbox(store, null, 'tok'));

    await waitFor(() => expect(result.current.items).toHaveLength(1));

    act(() => {
      store.setState({
        unreadByChannel: {
          [CHANNEL]: { last_read_id: '1000000000000000', unread_count: 1, mention_count: 0 },
        },
      });
    });

    expect(result.current.items).toHaveLength(1);
  });
});

describe('useInbox — done and sweep', () => {
  it('answers one row over REST and hides it immediately', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ items: [serverItem], oldest_id: MENTION }))
      .mockResolvedValueOnce(jsonResponse({ done: MENTION }));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useInbox(storeWithChannel(), null, 'tok'));
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    act(() => result.current.dismiss(MENTION));

    await waitFor(() => expect(result.current.items).toHaveLength(0));
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(String(url)).toContain(`/api/v1/users/@me/inbox/${MENTION}`);
    expect((init as RequestInit).method).toBe('DELETE');
  });

  it('rolls a failed done back and says so', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ items: [serverItem], oldest_id: MENTION }))
      .mockRejectedValueOnce(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useInbox(storeWithChannel(), null, 'tok'));
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    act(() => result.current.dismiss(MENTION));

    await waitFor(() => expect(result.current.actionError).toBeTruthy());
    expect(result.current.items).toHaveLength(1);
  });

  it('sweeps the collection', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ items: [serverItem], oldest_id: MENTION }))
      .mockResolvedValueOnce(jsonResponse({ done_count: 1 }));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useInbox(storeWithChannel(), null, 'tok'));
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    act(() => result.current.sweep());

    await waitFor(() => expect(result.current.items).toHaveLength(0));
    const [, init] = fetchMock.mock.calls[1]!;
    expect((init as RequestInit).method).toBe('DELETE');
  });
});
