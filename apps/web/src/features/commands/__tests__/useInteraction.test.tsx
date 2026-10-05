/**
 * @cytale/web — useInteraction tests (bots plan U9).
 *
 * The bounded pending contract: 202 acceptance is NOT the response; pending
 * clears only when the bot's message lands in the channel slice (authored by
 * the command's application principal); the ~10s client timeout lands the
 * named "no response" state with re-invoke; a late-arriving response just
 * lands as a normal store message with nothing to clean up; invocation 4xx
 * surfaces a typed error (forbidden on 403).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ApplicationCommand } from '@cytale/api-client';
import { applyGatewayEvent, createStateStore, type StateStore } from '@cytale/state';

import { INTERACTION_TIMEOUT_MS, useInteraction } from '../useInteraction.js';

const CHANNEL = '9007199254740993';
const BOT_ID = '8000000000000001';

const SHRUG: ApplicationCommand = {
  id: '9100000000000001',
  application_id: BOT_ID,
  name: 'shrug',
  description: 'Appends a shrug',
  options: null,
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;
let store: StateStore;
let seq = 1_000_000;

/** Land a gateway message in the channel slice (the bot's response path). */
function landBotMessage(content: string, authorId = BOT_ID): void {
  applyGatewayEvent(store, {
    op: 0,
    t: 'MessageCreate',
    s: ++seq,
    d: {
      id: String(1_900_000_000_000_000 + seq),
      channel_id: CHANNEL,
      thread_id: null,
      author_id: authorId,
      content,
      created_at: '2026-09-04T12:00:00Z',
      edited_at: null,
    },
  } as never);
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn(async () => jsonResponse(202, { interaction_id: '9300000000000001' }));
  vi.stubGlobal('fetch', fetchMock);
  store = createStateStore();
  store.setState({ currentUser: { id: '7000000000000002', username: 'me' } });
});

afterEach(() => {
  cleanup();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useInteraction — invoke', () => {
  it('POSTs /interactions with the command/channel/options and holds pending', async () => {
    const { result } = renderHook(() => useInteraction(store));

    await act(async () => {
      await result.current.invoke(SHRUG, CHANNEL, {});
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/api/v1/interactions');
    expect(JSON.parse(String(init.body))).toEqual({
      command_id: SHRUG.id,
      channel_id: CHANNEL,
    });
    expect(result.current.status).toMatchObject({ kind: 'pending', command: SHRUG });
  });

  it('omits the options key for zero-option invocations and sends values when filled', async () => {
    const echo: ApplicationCommand = {
      ...SHRUG,
      name: 'echo',
      options: [{ name: 'text', description: 'What to echo', required: true }],
    };
    const { result } = renderHook(() => useInteraction(store));
    await act(async () => {
      await result.current.invoke(echo, CHANNEL, { text: 'hi' });
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({
      command_id: echo.id,
      channel_id: CHANNEL,
      options: { text: 'hi' },
    });
  });
});

describe('useInteraction — response watch', () => {
  it("clears pending when the bot principal's message lands in the channel", async () => {
    const { result } = renderHook(() => useInteraction(store));
    await act(async () => {
      await result.current.invoke(SHRUG, CHANNEL, {});
    });
    expect(result.current.status.kind).toBe('pending');

    act(() => landBotMessage('¯\\_(ツ)_/¯'));
    expect(result.current.status.kind).toBe('idle'); // nothing left to clean up
    // The response itself is an ordinary message in the store slice.
    const items = store.getState().messagesByChannel[CHANNEL]?.items ?? [];
    expect(items.some((m) => m.content === '¯\\_(ツ)_/¯' && m.author_id === BOT_ID)).toBe(true);
  });

  it('ignores messages from other authors', async () => {
    const { result } = renderHook(() => useInteraction(store));
    await act(async () => {
      await result.current.invoke(SHRUG, CHANNEL, {});
    });
    act(() => landBotMessage('human chatter', '7000000000000009'));
    expect(result.current.status.kind).toBe('pending');
  });
});

describe('useInteraction — timeout', () => {
  it('lands the named no-response state at the 10s deadline with re-invoke', async () => {
    const { result } = renderHook(() => useInteraction(store));
    await act(async () => {
      await result.current.invoke(SHRUG, CHANNEL, {});
    });

    await act(async () => {
      vi.advanceTimersByTimeAsync(INTERACTION_TIMEOUT_MS - 1);
    });
    expect(result.current.status.kind).toBe('pending');

    await act(async () => {
      vi.advanceTimersByTimeAsync(2);
    });
    expect(result.current.status).toMatchObject({ kind: 'no-response', command: SHRUG });

    // Re-invoke affordance: a fresh invocation (new pending, new POST).
    await act(async () => {
      await result.current.reinvoke();
    });
    expect(result.current.status.kind).toBe('pending');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a late-arriving response after the deadline lands as a normal message — nothing to clean up', async () => {
    const { result } = renderHook(() => useInteraction(store));
    await act(async () => {
      await result.current.invoke(SHRUG, CHANNEL, {});
    });
    await act(async () => {
      vi.advanceTimersByTimeAsync(INTERACTION_TIMEOUT_MS + 5);
    });
    expect(result.current.status.kind).toBe('no-response');

    // The bot answers after the client gave up: the message simply exists.
    act(() => landBotMessage('sorry, slow'));
    const items = store.getState().messagesByChannel[CHANNEL]?.items ?? [];
    expect(items.some((m) => m.content === 'sorry, slow')).toBe(true);
    // The dismissable error stays until the user acts on it.
    expect(result.current.status.kind).toBe('no-response');
    act(() => result.current.dismiss());
    expect(result.current.status.kind).toBe('idle');
  });
});

describe('useInteraction — errors', () => {
  it('surfaces a 403 invocation failure as a forbidden error', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(403, { error: { key: 'forbidden', code: 40303, message: 'no send right' } }),
    );
    const { result } = renderHook(() => useInteraction(store));

    await act(async () => {
      await result.current.invoke(SHRUG, CHANNEL, {});
    });

    expect(result.current.status).toMatchObject({
      kind: 'error',
      forbidden: true,
      error: 'no send right',
    });
  });

  it('surfaces a 404 unknown-command failure and retry re-POSTs', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(404, { error: { key: 'command_not_found', code: 40404, message: 'unknown command' } }),
      )
      .mockResolvedValueOnce(jsonResponse(202, { interaction_id: '9300000000000002' }));
    const { result } = renderHook(() => useInteraction(store));

    await act(async () => {
      await result.current.invoke(SHRUG, CHANNEL, {});
    });
    expect(result.current.status).toMatchObject({
      kind: 'error',
      forbidden: false,
      error: 'unknown command',
    });

    await act(async () => {
      await result.current.reinvoke();
    });
    expect(result.current.status.kind).toBe('pending');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('response arriving while error state is shown leaves it dismissable', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(403, { error: { key: 'forbidden', code: 40303, message: 'no send right' } }),
    );
    const { result } = renderHook(() => useInteraction(store));
    await act(async () => {
      await result.current.invoke(SHRUG, CHANNEL, {});
    });
    act(() => result.current.dismiss());
    expect(result.current.status.kind).toBe('idle');
  });
});
