/**
 * @cytale/web — retrying image source for content-addressed attachments.
 *
 * Attachment URLs (`/api/v1/attachments/<hash>`) never change for a given
 * file, so a single failed load is permanent: the webview will not re-request
 * a URL it already failed, and re-uploading the same bytes produces the same
 * URL. Observed for real — a workspace icon stayed blank until the desktop app
 * was restarted, after a transient 404 while the blob was missing.
 *
 * This hook retries a failed load with a cache-busting query param (the
 * attachment route ignores query strings), then gives up and lets the caller
 * render its fallback. A changed `src` always starts a fresh cycle.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { retryUrl } from '../origin.js';

/** Delay before retry N (0-based attempt index) — short, then longer. */
const RETRY_DELAY_MS = 1_200;

/**
 * URLs that just failed, shared across every mounted instance. Without it, one
 * broken hash costs `attempts × instances` requests — a member rail plus 40
 * message rows is 100+ requests against an endpoint that is already failing
 * (each with a distinct `?retry=N` URL, so nothing coalesces). A new instance
 * that sees a recently-failed URL renders its fallback immediately; the entry
 * expires so a later mount retries.
 */
const FAILURE_TTL_MS = 30_000;
const recentFailures = new Map<string, number>();

function markRecentlyFailed(url: string): void {
  recentFailures.set(url, Date.now() + FAILURE_TTL_MS);
}

function clearRecentlyFailed(url: string): void {
  recentFailures.delete(url);
}

function isRecentlyFailed(url: string | null | undefined): boolean {
  if (typeof url !== 'string' || url === '') return false;
  const until = recentFailures.get(url);
  if (until === undefined) return false;
  if (until <= Date.now()) {
    recentFailures.delete(url);
    return false;
  }
  return true;
}

/** Test seam: forget every recorded failure. */
export function resetImageFailureMemoForTests(): void {
  recentFailures.clear();
}

export interface RetryingImage {
  /** URL to render, or null when the load has definitively failed. */
  url: string | null;
  /** Attach to the `<img>`: schedules a retry, or pins the failure. */
  onError: () => void;
  /** Attach to the `<img>`: clears this URL from the shared failure memo. */
  onLoad: () => void;
  /** Manual re-attempt for the SAME src (the fallback tile's retry button):
   *  clears the shared failure memo and restarts the attempt cycle — this
   *  is the only path that recovers a byte-identical re-upload, whose hash,
   *  and therefore src, never changed (#47). */
  retry: () => void;
}

export function useRetryingImage(
  src: string | null | undefined,
  maxAttempts = 2,
): RetryingImage {
  const [attempt, setAttempt] = useState(0);
  // A URL a sibling instance just failed renders the fallback immediately.
  const [failed, setFailed] = useState(() => isRecentlyFailed(src));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setAttempt(0);
    setFailed(isRecentlyFailed(src));
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, [src]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const onError = useCallback(() => {
    // Recorded on the FIRST failure so siblings stop asking; this instance
    // keeps retrying (and clears the mark if a retry succeeds).
    if (typeof src === 'string' && src !== '') markRecentlyFailed(src);
    if (attempt >= maxAttempts) {
      setFailed(true);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      setAttempt((n) => n + 1);
    }, RETRY_DELAY_MS);
  }, [attempt, maxAttempts, src]);

  const onLoad = useCallback(() => {
    if (typeof src === 'string' && src !== '') clearRecentlyFailed(src);
  }, [src]);

  const retry = useCallback(() => {
    if (typeof src === 'string' && src !== '') clearRecentlyFailed(src);
    setFailed(false);
    setAttempt((n) => n + 1);
  }, [src]);

  const base = typeof src === 'string' && src !== '' ? src : null;
  const url = failed || !base ? null : retryUrl(base, attempt);

  return { url, onError, onLoad, retry };
}
