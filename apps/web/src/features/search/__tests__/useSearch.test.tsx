/**
 * @cytale/web — useSearch tests (U24).
 *
 * Debounced query, from:/in:/before:/after: filter parsing, cursor
 * pagination, and the distinct 501 `search_not_available` state.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useSearch } from '../useSearch.js';
import { parseSearchQuery } from '../query.js';
import type { SearchPage } from '../api.js';

const WS = '9007199254740993';

function page(results: SearchPage['results'], next_before: string | null = null): SearchPage {
  return { results, next_before };
}

function hit(id: string) {
  return { message_id: id, channel_id: '9007199254740993', thread_id: null, score: 0.9 };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseSearchQuery', () => {
  it('extracts from:/in:/before:/after: filters and keeps the keyword remainder', () => {
    const parsed = parseSearchQuery('from:janet in:#general before:2026-08-01 deploy');
    expect(parsed.q).toBe('deploy');
    expect(parsed.filters.from).toBe('janet');
    expect(parsed.filters.in).toBe('general'); // # stripped
    expect(parsed.filters.before).toBe('2026-08-01');
  });

  it('treats a space-containing filter value as filter + keyword (graceful fallback)', () => {
    // `before:last week` splits on whitespace: `before:last` is a filter,
    // `week` falls back to a keyword. This is the documented graceful
    // fallback for ambiguous multi-word filter values.
    const parsed = parseSearchQuery('from:janet before:last week deploy');
    expect(parsed.q).toBe('week deploy');
    expect(parsed.filters.from).toBe('janet');
    expect(parsed.filters.before).toBe('last');
  });

  it('treats unknown key:value tokens as free-text (graceful fallback)', () => {
    const parsed = parseSearchQuery('foo:bar deploy');
    expect(parsed.q).toBe('foo:bar deploy');
    expect(parsed.filters).toEqual({});
  });

  it('drops a bare key: with no value (treated as a keyword token)', () => {
    const parsed = parseSearchQuery('from: deploy');
    // `from:` has no value → not a filter; it falls back to a keyword token.
    expect(parsed.q).toBe('from: deploy');
    expect(parsed.filters.from).toBeUndefined();
  });
});

describe('useSearch', () => {
  it('debounces input and fetches the parsed query', async () => {
    const fetchPage = vi.fn().mockResolvedValue(page([hit('1')]));
    const { result } = renderHook(() =>
      useSearch({ workspaceId: WS, debounceMs: 20, fetchPage }),
    );

    act(() => result.current.setInput('deploy'));
    expect(result.current.status).toBe('idle');

    await waitFor(() => expect(result.current.status).toBe('results'));
    expect(fetchPage).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS, q: 'deploy', filters: {} }),
    );
    expect(result.current.results).toHaveLength(1);
  });

  it('parses from:/in: filters into the fetch call', async () => {
    const fetchPage = vi.fn().mockResolvedValue(page([hit('1')]));
    const { result } = renderHook(() =>
      useSearch({ workspaceId: WS, debounceMs: 20, fetchPage }),
    );

    act(() => result.current.setInput('from:janet in:#general deploy'));
    await waitFor(() => expect(result.current.status).toBe('results'));
    expect(fetchPage).toHaveBeenCalledWith(
      expect.objectContaining({
        q: 'deploy',
        filters: { from: 'janet', in: 'general' },
      }),
    );
  });

  it('renders empty state when no results', async () => {
    const fetchPage = vi.fn().mockResolvedValue(page([]));
    const { result } = renderHook(() =>
      useSearch({ workspaceId: WS, debounceMs: 20, fetchPage }),
    );
    act(() => result.current.setInput('nothing'));
    await waitFor(() => expect(result.current.status).toBe('empty'));
  });

  it('surfaces the 501 search_not_available state distinctly', async () => {
    const fetchPage = vi
      .fn()
      .mockRejectedValue({ status: 501, key: 'search_not_available' });
    const { result } = renderHook(() =>
      useSearch({ workspaceId: WS, debounceMs: 20, fetchPage }),
    );
    act(() => result.current.setInput('deploy'));
    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(result.current.error?.key).toBe('search_not_available');
  });

  it('surfaces a generic error state for non-501 failures', async () => {
    const fetchPage = vi.fn().mockRejectedValue({ status: 500 });
    const { result } = renderHook(() =>
      useSearch({ workspaceId: WS, debounceMs: 20, fetchPage }),
    );
    act(() => result.current.setInput('deploy'));
    await waitFor(() => expect(result.current.status).toBe('error'));
  });

  it('loadMore appends the next page and advances the cursor', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(page([hit('1')], '1000000000000002'))
      .mockResolvedValueOnce(page([hit('2')], null));
    const { result } = renderHook(() =>
      useSearch({ workspaceId: WS, debounceMs: 20, fetchPage }),
    );
    act(() => result.current.setInput('deploy'));
    await waitFor(() => expect(result.current.status).toBe('results'));
    expect(result.current.hasMore).toBe(true);

    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.results.map((r) => r.message_id)).toEqual(['1', '2']);
    expect(result.current.hasMore).toBe(false);
  });

  it('clear() returns to idle', async () => {
    const fetchPage = vi.fn().mockResolvedValue(page([hit('1')]));
    const { result } = renderHook(() =>
      useSearch({ workspaceId: WS, debounceMs: 20, fetchPage }),
    );
    act(() => result.current.setInput('deploy'));
    await waitFor(() => expect(result.current.status).toBe('results'));
    act(() => result.current.clear());
    expect(result.current.status).toBe('idle');
    expect(result.current.results).toEqual([]);
  });
});
