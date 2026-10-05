/**
 * @cytale/web — search state hook (U24).
 *
 * Owns the search lifecycle: debounced query input, filter-syntax parsing
 * (from:/in:/before:/after:), the U13 search fetch, and cursor pagination.
 * Exposes a states-first surface (idle/loading/error/empty/results) so the
 * search surface renders the right state without re-deriving it.
 *
 * The 501 `search_not_available` case is surfaced distinctly (the Tantivy
 * index may be down) so the UI can say "search unavailable" rather than a
 * generic error.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchSearchPage, type SearchHit, type SearchPage } from './api.js';
import { parseSearchQuery } from './query.js';

export type SearchStatus = 'idle' | 'loading' | 'error' | 'unavailable' | 'empty' | 'results';

export interface UseSearch {
  status: SearchStatus;
  /** Parsed free-text keyword (non-filter remainder). */
  q: string;
  /** Parsed filters (from:/in:/before:/after:). */
  filters: { from?: string; in?: string; before?: string; after?: string };
  /** Current page of results (empty when not in results state). */
  results: SearchHit[];
  /** True when a next older page exists. */
  hasMore: boolean;
  /** Error detail when status is 'error' or 'unavailable'. */
  error: { status: number; key?: string; message?: string } | null;
  /** Set the raw search input (debounced internally). */
  setInput(input: string): void;
  /** Load the next older page (cursor pagination). */
  loadMore(): void;
  /** Re-run the current query (retry after error). */
  retry(): void;
  /** Clear results and return to idle. */
  clear(): void;
}

export interface UseSearchOptions {
  workspaceId: string;
  /** Debounce delay in ms (tests override to a small value). */
  debounceMs?: number;
  /** Bearer token for the authenticated endpoint (U19 authStore seam). */
  token?: string;
  /** Override the fetch (tests). */
  fetchPage?: typeof fetchSearchPage;
}

const DEFAULT_DEBOUNCE_MS = 300;

export function useSearch(options: UseSearchOptions): UseSearch {
  const { workspaceId, debounceMs = DEFAULT_DEBOUNCE_MS, token } = options;
  const fetchPage = options.fetchPage ?? fetchSearchPage;

  const [input, setInput] = useState('');
  const [status, setStatus] = useState<SearchStatus>('idle');
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState<UseSearch['filters']>({});
  const [results, setResults] = useState<SearchHit[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [error, setError] = useState<UseSearch['error']>(null);

  // Debounce the raw input into a parsed query.
  useEffect(() => {
    if (input.trim() === '') {
      setStatus('idle');
      setQ('');
      setFilters({});
      setResults([]);
      setNextBefore(null);
      setError(null);
      return;
    }

    const timer = setTimeout(() => {
      const parsed = parseSearchQuery(input);
      setQ(parsed.q);
      setFilters(parsed.filters);
      setStatus('loading');
      setError(null);
    }, debounceMs);

    return () => clearTimeout(timer);
  }, [input, debounceMs]);

  // Run the search when the parsed query changes.
  useEffect(() => {
    if (status !== 'loading') return;
    let cancelled = false;

    (async () => {
      try {
        const page = await fetchPage({
          workspaceId,
          q,
          filters,
          token,
        });
        if (cancelled) return;
        setResults(page.results);
        setNextBefore(page.next_before);
        setStatus(page.results.length > 0 ? 'results' : 'empty');
      } catch (err) {
        if (cancelled) return;
        const e = err as { status: number; key?: string; message?: string };
        setError({ status: e.status, key: e.key, message: e.message });
        setStatus(e.status === 501 ? 'unavailable' : 'error');
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, q, filters, workspaceId, token, fetchPage]);

  const loadMore = useCallback(async () => {
    if (!nextBefore || status !== 'results') return;
    try {
      const page = await fetchPage({
        workspaceId,
        q,
        filters,
        before: nextBefore,
        token,
      });
      setResults((prev) => [...prev, ...page.results]);
      setNextBefore(page.next_before);
    } catch (err) {
      const e = err as { status: number; key?: string; message?: string };
      setError({ status: e.status, key: e.key, message: e.message });
      setStatus(e.status === 501 ? 'unavailable' : 'error');
    }
  }, [nextBefore, status, workspaceId, q, filters, token, fetchPage]);

  const retry = useCallback(() => {
    setStatus('loading');
    setError(null);
  }, []);

  const clear = useCallback(() => {
    setInput('');
  }, []);

  return {
    status,
    q,
    filters,
    results,
    hasMore: nextBefore !== null,
    error,
    setInput,
    loadMore,
    retry,
    clear,
  };
}
