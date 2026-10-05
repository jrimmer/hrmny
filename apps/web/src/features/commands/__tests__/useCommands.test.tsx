/**
 * @cytale/web — useCommands tests (bots plan U9).
 *
 * Debounced open-fetch (a stray "/" that vanishes before the debounce never
 * hits the wire), ready-cache, error + forbidden (permission-denied) flag,
 * retry, and workspace-switch invalidation. fetch is stubbed per-test; the
 * hook talks to the real session api instance like production.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ApplicationCommand } from '@cytale/api-client';

import { useCommands } from '../useCommands.js';

const WS = '5000000000000001';

const COMMANDS: ApplicationCommand[] = [
  {
    id: '9100000000000001',
    application_id: '8000000000000001',
    name: 'shrug',
    description: 'Appends a shrug',
    options: null,
  },
  {
    id: '9100000000000002',
    application_id: '8000000000000001',
    name: 'echo',
    description: 'Echoes text',
    options: [{ name: 'text', description: 'What to echo', required: true }],
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

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useCommands', () => {
  it('fetches the workspace roster on load, debounced', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { commands: COMMANDS }));
    const { result } = renderHook(() => useCommands(WS));

    act(() => result.current.load());
    expect(fetchMock).not.toHaveBeenCalled(); // debounce window

    await act(async () => {
      vi.advanceTimersByTime(260);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain(
      `/api/v1/workspaces/${WS}/commands`,
    );
    expect(result.current.state.status).toBe('ready');
    expect(result.current.state.status === 'ready' && result.current.state.commands).toHaveLength(2);
  });

  it('cancels the fetch when the debounce never elapses (stray slash)', () => {
    const { result } = renderHook(() => useCommands(WS));
    act(() => result.current.load());
    // unmount before the debounce fires
    cleanup();
    act(() => {
      vi.advanceTimersByTime(260);
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.state.status).toBe('idle');
  });

  it('caches the loaded roster — repeated load() does not refetch', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { commands: COMMANDS }));
    const { result } = renderHook(() => useCommands(WS));
    act(() => result.current.load());
    await act(async () => {
      vi.advanceTimersByTime(260);
    });

    act(() => result.current.load());
    act(() => {
      vi.advanceTimersByTime(260);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('flags member-gate 403 as forbidden and retry refetches', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(403, { error: { key: 'forbidden', code: 40303, message: 'not a member' } }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { commands: COMMANDS }));
    const { result } = renderHook(() => useCommands(WS));

    act(() => result.current.retry());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.state).toMatchObject({ status: 'error', forbidden: true });

    act(() => result.current.retry());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.state.status).toBe('ready');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces load errors without the forbidden flag', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(500, { error: { key: 'internal', code: 50000, message: 'boom' } }),
    );
    const { result } = renderHook(() => useCommands(WS));

    act(() => result.current.retry());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.state).toMatchObject({ status: 'error', forbidden: false });
  });

  it('treats an empty roster as ready (empty state, not error)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { commands: [] }));
    const { result } = renderHook(() => useCommands(WS));

    act(() => result.current.retry());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.state).toEqual({ status: 'ready', commands: [] });
  });

  it('resets to idle when the workspace changes', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { commands: COMMANDS }));
    const { result, rerender } = renderHook(({ ws }) => useCommands(ws), {
      initialProps: { ws: WS as string | null },
    });
    act(() => result.current.load());
    await act(async () => {
      vi.advanceTimersByTime(260);
    });
    expect(result.current.state.status).toBe('ready');

    rerender({ ws: '5000000000000002' });
    expect(result.current.state.status).toBe('idle');
  });

  it('load is a no-op without a workspace (DM compose)', () => {
    const { result } = renderHook(() => useCommands(null));
    act(() => result.current.load());
    act(() => {
      vi.advanceTimersByTime(260);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
