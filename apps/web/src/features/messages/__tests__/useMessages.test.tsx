/**
 * @cytale/web — useMessages tests (U21 slice 1).
 *
 * Optimistic send: placeholder row → REST 201 → nonce replaced. Edit/delete
 * reconcile the store. Fetch is mocked against the documented U9 contract.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';

import { createStateStore, type StateStore } from '@cytale/state';
import type { Message } from '@cytale/domain';

import { applyReactionAdd, applyReactionEvent } from '../reactions.js';
import { useMessages } from '../useMessages.js';

const CHANNEL = '9007199254740993';
const ME = '7000000000000002';
const THREAD = '7000000000000009';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
  } as unknown as Response;
}

function makeStore(): StateStore {
  const store = createStateStore();
  store.setState({ currentUser: { id: ME, username: 'me' } });
  return store;
}

let sendCalls: { body: { content: string; nonce?: string; thread_id?: string | null } }[] = [];
let editCalls: { id: string; body: { content: string } }[] = [];
let deleteCalls: string[] = [];

function installFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? 'GET').toUpperCase();
    if (url.endsWith(`/channels/${CHANNEL}/messages`) && method === 'POST') {
      const body = JSON.parse(String(init.body ?? '{}')) as { content: string; nonce?: string };
      sendCalls.push({ body });
      const id = `1000000000000${sendCalls.length}`;
      return jsonResponse(201, {
        id,
        channel_id: CHANNEL,
        thread_id: null,
        author_id: ME,
        content: body.content,
        created_at: '2026-08-30T00:00:00Z',
        edited_at: null,
      });
    }
    if (url.includes('/messages/') && method === 'PATCH') {
      const id = url.split('/').pop()!;
      const body = JSON.parse(String(init.body ?? '{}')) as { content: string };
      editCalls.push({ id, body });
      return jsonResponse(200, {
        id,
        channel_id: CHANNEL,
        thread_id: null,
        author_id: ME,
        content: body.content,
        created_at: '2026-08-30T00:00:00Z',
        edited_at: '2026-08-30T00:01:00Z',
      });
    }
    if (url.includes('/messages/') && method === 'DELETE') {
      deleteCalls.push(url.split('/').pop()!);
      return jsonResponse(200, {});
    }
    return jsonResponse(404, { error: { key: 'not_found', code: 40404, message: 'no route' } });
  }));
}

beforeEach(() => {
  sendCalls = [];
  editCalls = [];
  deleteCalls = [];
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useMessages — send', () => {
  it('optimistic send: placeholder appears, then nonce replaced on 201', async () => {
    const store = makeStore();
    const { result } = renderHook(() => useMessages(store));

    await act(async () => {
      await result.current.send(CHANNEL, 'hello world');
    });

    // After confirmation, the placeholder is gone and the server id is present.
    const items = store.getState().messagesByChannel[CHANNEL]?.items ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('10000000000001');
    expect(items[0]!.content).toBe('hello world');
    // No pending placeholder remains.
    expect(Object.keys(store.getState().pendingByNonce)).toHaveLength(0);
  });

  it('send failure KEEPS the optimistic row, marked failed, and surfaces the error', async () => {
    const store = makeStore();
    // Make the POST fail with ACCOUNT_UNVERIFIED.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(403, { error: { key: 'ACCOUNT_UNVERIFIED', code: 40303, message: 'verify' } }),
      ),
    );
    const { result } = renderHook(() => useMessages(store));

    await act(async () => {
      await expect(result.current.send(CHANNEL, 'nope')).rejects.toMatchObject({
        key: 'ACCOUNT_UNVERIFIED',
      });
    });

    // Held (2026-09-28, the Discord failed row): the row stays where it was
    // drawn, marked with why; nothing is pending any more.
    const items = store.getState().messagesByChannel[CHANNEL]?.items ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      content: 'nope',
      send_state: 'failed',
      send_error: { key: 'ACCOUNT_UNVERIFIED', message: 'verify' },
    });
    expect(Object.keys(store.getState().pendingByNonce)).toHaveLength(0);
    expect(Object.values(store.getState().failedByNonce)[0]).toMatchObject({ held: true });
  });

  it('send without a signed-in user throws UNAUTHENTICATED', async () => {
    const store = createStateStore(); // no currentUser
    const { result } = renderHook(() => useMessages(store));

    await act(async () => {
      await expect(result.current.send(CHANNEL, 'x')).rejects.toMatchObject({
        key: 'UNAUTHENTICATED',
      });
    });
  });

  it('carries thread_id in the POST body for a thread send, and omits it otherwise', async () => {
    const store = makeStore();
    const { result } = renderHook(() => useMessages(store));

    await act(async () => {
      await result.current.send(CHANNEL, 'thread reply', THREAD);
      await result.current.send(CHANNEL, 'channel message');
    });

    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[0]!.body.thread_id).toBe(THREAD);
    expect(sendCalls[1]!.body).not.toHaveProperty('thread_id');
  });
});

describe('useMessages — edit/delete', () => {
  it('edit reconciles the store with the updated content', async () => {
    const store = makeStore();
    // Seed a message.
    const seed: Message = {
      id: '1000000000000999',
      channel_id: CHANNEL,
      thread_id: null,
      author_id: ME,
      content: 'original',
      created_at: '2026-08-30T00:00:00Z',
      edited_at: null,
    };
    store.setState((s) => ({
      messagesByChannel: {
        ...s.messagesByChannel,
        [CHANNEL]: { items: [seed], oldestId: null, hasCompleteHistory: true },
      },
    }));

    const { result } = renderHook(() => useMessages(store));
    await act(async () => {
      await result.current.edit(CHANNEL, '1000000000000999', 'edited');
    });

    const items = store.getState().messagesByChannel[CHANNEL]!.items;
    expect(items[0]!.content).toBe('edited');
    expect(items[0]!.edited_at).toBe('2026-08-30T00:01:00Z');
  });

  it('edit is OPTIMISTIC: the new content lands before the server confirms', async () => {
    const store = makeStore();
    const seed: Message = {
      id: '1000000000000777',
      channel_id: CHANNEL,
      thread_id: null,
      author_id: ME,
      content: 'original',
      created_at: '2026-08-30T00:00:00Z',
      edited_at: null,
    };
    store.setState((s) => ({
      messagesByChannel: {
        ...s.messagesByChannel,
        [CHANNEL]: { items: [seed], oldestId: null, hasCompleteHistory: true },
      },
    }));

    // Hold the PATCH open so the optimistic state is observable mid-flight.
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const orig = globalThis.fetch as unknown as (...a: unknown[]) => Promise<Response>;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input);
        if (url.includes('/messages/') && (init.method ?? '').toUpperCase() === 'PATCH') {
          await gate;
        }
        return orig(input, init);
      }),
    );

    const { result } = renderHook(() => useMessages(store));
    let settled = false;
    const p = result.current
      .edit(CHANNEL, '1000000000000777', 'edited optimistically')
      .then(() => {
        settled = true;
      });

    await act(async () => {
      await Promise.resolve();
    });
    // Mid-flight: the row already shows the new text.
    expect(store.getState().messagesByChannel[CHANNEL]!.items[0]!.content).toBe(
      'edited optimistically',
    );
    expect(settled).toBe(false);

    release!();
    await act(async () => {
      await p;
    });
    // Converged with the server's edited_at.
    expect(store.getState().messagesByChannel[CHANNEL]!.items[0]!.content).toBe(
      'edited optimistically',
    );
    expect(store.getState().messagesByChannel[CHANNEL]!.items[0]!.edited_at).toBe(
      '2026-08-30T00:01:00Z',
    );
  });

  it('edit ROLLS BACK to the prior content when the write fails', async () => {
    const store = makeStore();
    const seed: Message = {
      id: '1000000000000666',
      channel_id: CHANNEL,
      thread_id: null,
      author_id: ME,
      content: 'original',
      created_at: '2026-08-30T00:00:00Z',
      edited_at: '2026-08-30T00:00:30Z',
    };
    store.setState((s) => ({
      messagesByChannel: {
        ...s.messagesByChannel,
        [CHANNEL]: { items: [seed], oldestId: null, hasCompleteHistory: true },
      },
    }));

    const orig = globalThis.fetch as unknown as (...a: unknown[]) => Promise<Response>;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input);
        if (url.includes('/messages/') && (init.method ?? '').toUpperCase() === 'PATCH') {
          return jsonResponse(500, { error: { key: 'internal', code: 50000, message: 'boom' } });
        }
        return orig(input, init);
      }),
    );

    const { result } = renderHook(() => useMessages(store));
    await act(async () => {
      await expect(
        result.current.edit(CHANNEL, '1000000000000666', 'doomed edit'),
      ).rejects.toBeTruthy();
    });

    const row = store.getState().messagesByChannel[CHANNEL]!.items[0]!;
    expect(row.content).toBe('original');
    // The original edited_at is restored too (not the optimistic stamp).
    expect(row.edited_at).toBe('2026-08-30T00:00:30Z');
  });

  it('delete reconciles the store by removing the message', async () => {
    const store = makeStore();
    const seed: Message = {
      id: '1000000000000888',
      channel_id: CHANNEL,
      thread_id: null,
      author_id: ME,
      content: 'bye',
      created_at: '2026-08-30T00:00:00Z',
      edited_at: null,
    };
    store.setState((s) => ({
      messagesByChannel: {
        ...s.messagesByChannel,
        [CHANNEL]: { items: [seed], oldestId: null, hasCompleteHistory: true },
      },
    }));

    const { result } = renderHook(() => useMessages(store));
    await act(async () => {
      await result.current.remove(CHANNEL, '1000000000000888');
    });

    expect(store.getState().messagesByChannel[CHANNEL]!.items).toHaveLength(0);
  });
});

describe('useMessages — attachments (composer image posting)', () => {  const STAGED = [
    {
      id: '6000000000000001',
      filename: 'cat.png',
      content_type: 'image/png',
      size: 3,
      url: '/attachments/6000000000000001/cat.png',
    },
  ];

  it('send binds staged attachment metadata into the create body', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = (init.method ?? 'GET').toUpperCase();
      if (url.endsWith(`/channels/${CHANNEL}/messages`) && method === 'POST') {
        bodies.push(JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>);
        return jsonResponse(201, {
          id: `1000000000000${bodies.length}`,
          channel_id: CHANNEL,
          thread_id: null,
          author_id: ME,
          content: String(bodies[bodies.length - 1]!.content ?? ''),
          created_at: '2026-08-30T00:00:00Z',
          edited_at: null,
        });
      }
      return jsonResponse(404, { error: { key: 'not_found', code: 40404, message: 'no route' } });
    }));
    const store = makeStore();
    const { result } = renderHook(() => useMessages(store));

    // Image-only send: empty content + staged attachments.
    await act(async () => {
      await result.current.send(CHANNEL, '', null, null, STAGED);
    });
    expect(bodies[0]).toMatchObject({ content: '', attachments: STAGED });

    // Text-only send keeps the body free of the key (native envelope unchanged).
    await act(async () => {
      await result.current.send(CHANNEL, 'plain');
    });
    expect(bodies[1]).toMatchObject({ content: 'plain' });
    expect(bodies[1]).not.toHaveProperty('attachments');
  });
});

describe('useMessages — toggleReaction (optimistic add/remove + rollback)', () => {
  const MID = '1000000000000777';
  const THUMBS = encodeURIComponent('👍');

  function seedWithReactions(): StateStore {
    const store = makeStore();
    const seed: Message = {
      id: MID,
      channel_id: CHANNEL,
      thread_id: null,
      author_id: ME,
      content: 'react to me',
      created_at: '2026-09-04T00:00:00Z',
      edited_at: null,
    };
    store.setState((s) => ({
      messagesByChannel: {
        ...s.messagesByChannel,
        [CHANNEL]: {
          items: [seed],
          oldestId: null,
          hasCompleteHistory: true,
        },
      },
    }));
    return store;
  }

  function reactionsOf(store: StateStore): { emoji: string; count: number; me: boolean }[] {
    const row = store.getState().messagesByChannel[CHANNEL]!.items.find((m) => m.id === MID);
    return ((row as { reactions?: { emoji: string; count: number; me: boolean }[] }).reactions ??
      []) as { emoji: string; count: number; me: boolean }[];
  }

  let reactionCalls: { method: string; url: string }[] = [];

  function installReactionFetch(status = 204): void {
    reactionCalls = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = (init.method ?? 'GET').toUpperCase();
      if (url.includes(`/messages/${MID}/reactions/`)) {
        reactionCalls.push({ method, url });
        return jsonResponse(status, {});
      }
      return jsonResponse(404, { error: { key: 'not_found', code: 40404, message: 'no route' } });
    }));
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('adds optimistically, PUTs the pinned @me route with the exact args, and survives the own echo', async () => {
    installReactionFetch();
    const store = seedWithReactions();
    const { result } = renderHook(() => useMessages(store));

    await act(async () => {
      await result.current.toggleReaction(CHANNEL, MID, '👍');
    });

    // Exact REST call: PUT .../reactions/👍(@me) with the pinned ids.
    expect(reactionCalls).toHaveLength(1);
    expect(reactionCalls[0]!.method).toBe('PUT');
    expect(new URL(reactionCalls[0]!.url).pathname).toBe(
      `/api/v1/channels/${CHANNEL}/messages/${MID}/reactions/${THUMBS}/@me`,
    );
    // Optimistic chip persisted after the 204.
    expect(reactionsOf(store)).toEqual([{ emoji: '👍', count: 1, me: true }]);
    expect(result.current.reactionError()).toBeNull();

    // The gateway echo of the own add must not double-count.
    act(() => {
      applyReactionEvent(store, {
        op: 0,
        t: 'MessageReactionAdd',
        s: 500,
        d: { channel_id: CHANNEL, message_id: MID, user_id: ME, emoji: '👍' },
      });
    });
    expect(reactionsOf(store)).toEqual([{ emoji: '👍', count: 1, me: true }]);
  });

  it('removes my reaction via the DELETE route and clears the chip at zero', async () => {
    installReactionFetch();
    const store = seedWithReactions();
    // Seed an own reaction (count 1, me).
    applyReactionAdd(store, { channel_id: CHANNEL, message_id: MID, user_id: ME, emoji: '👍' });
    const { result } = renderHook(() => useMessages(store));

    await act(async () => {
      await result.current.toggleReaction(CHANNEL, MID, '👍');
    });

    expect(reactionCalls).toHaveLength(1);
    expect(reactionCalls[0]!.method).toBe('DELETE');
    expect(new URL(reactionCalls[0]!.url).pathname).toBe(
      `/api/v1/channels/${CHANNEL}/messages/${MID}/reactions/${THUMBS}/@me`,
    );
    expect(reactionsOf(store)).toEqual([]); // chip gone, key absent
  });

  it('rolls back the optimistic chip on 4xx and records the error (row stays stable)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse(400, { error: { key: 'too_many_emojis', code: 40001, message: 'too many emojis' } }),
    ));
    const store = seedWithReactions();
    const { result } = renderHook(() => useMessages(store));

    await act(async () => {
      await expect(result.current.toggleReaction(CHANNEL, MID, '🎉')).rejects.toMatchObject({
        key: 'too_many_emojis',
      });
    });

    // Rolled back: no chip, and the error is surfaced for the inline affordance.
    expect(reactionsOf(store)).toEqual([]);
    const err = result.current.reactionError();
    expect(err).toMatchObject({
      channelId: CHANNEL,
      messageId: MID,
      emoji: '🎉',
      key: 'too_many_emojis',
      message: 'too many emojis',
    });

    // Retry (the inline affordance's action) succeeds and clears the error.
    installReactionFetch();
    await act(async () => {
      await result.current.toggleReaction(CHANNEL, MID, '🎉');
    });
    expect(result.current.reactionError()).toBeNull();
    expect(reactionsOf(store)).toEqual([{ emoji: '🎉', count: 1, me: true }]);
  });

  it('throws UNAUTHENTICATED without a signed-in user (no fetch)', async () => {
    installReactionFetch();
    const store = createStateStore(); // no currentUser
    const seed: Message = {
      id: MID,
      channel_id: CHANNEL,
      thread_id: null,
      author_id: '7000000000000001',
      content: 'x',
      created_at: '2026-09-04T00:00:00Z',
      edited_at: null,
    };
    store.setState((s) => ({
      messagesByChannel: {
        ...s.messagesByChannel,
        [CHANNEL]: { items: [seed], oldestId: null, hasCompleteHistory: true },
      },
    }));
    const { result } = renderHook(() => useMessages(store));

    await act(async () => {
      await expect(result.current.toggleReaction(CHANNEL, MID, '👍')).rejects.toMatchObject({
        key: 'UNAUTHENTICATED',
      });
    });
    expect(reactionCalls).toHaveLength(0);
  });

  it('never reacts on the optimistic-send placeholder row', async () => {
    installReactionFetch();
    const store = makeStore();
    const { result } = renderHook(() => useMessages(store));

    await act(async () => {
      await result.current.toggleReaction(CHANNEL, 'pending_abc123', '👍');
    });

    expect(reactionCalls).toHaveLength(0);
  });
});
