/**
 * @cytale/web — shared pane state fragments (promoted from the integrations
 * feature, U3 of the TUI/SSH plan).
 *
 * These are the per-pane treatments of the states-first DoD that are not
 * StateBanner shaped: the loading skeleton (announced progressbar + pulse
 * rows), the named empty state with a next-step hint, the shared list
 * `LoadState` machine, and the error banner with its Retry action. Offline /
 * permission-denied use the shared `StateBanner` (alert/status semantics)
 * directly from the panes, so they need no fragment of their own.
 *
 * They were written inside `features/integrations/` already parameterised by
 * `testId`/`retryTestId` — i.e. written to be shared — and this module is
 * that home: `app/ui/` is where cross-feature primitives live (`StateBanner`
 * alongside them). A feature that owns a list pane consumes these instead of
 * re-deriving the same skeleton/banner, because the states-first contract is
 * visual, not just semantic: two copies drift.
 *
 * The nonce/fetch/cancel/403-deny effect that drives `LoadState` stays a hook
 * in the consuming feature (`usePaneList` in integrations, `useSshCertificates`
 * in ssh) — the machine's shape is shared, the fetching is not.
 */

import { StateBanner } from './StateBanner.js';

/** The list-fetch state machine a pane renders against. */
export type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string };

export interface PaneSkeletonProps {
  /** Announced to screen readers via the progressbar's aria-label. */
  label: string;
  testId: string;
  /** Placeholder rows (default 3). */
  rows?: number;
  /**
   * `card` (default): bordered list cards — settings/integrations lists.
   * `message`: the message-row shape (avatar circle, author line, body line,
   * no card) — the thread panel, search results, the inbox, the threads
   * list — so a feed keeps its structure while it fills in.
   */
  variant?: 'card' | 'message';
}

const pulse = 'animate-pulse motion-reduce:animate-none rounded bg-surface-hover';

export function PaneSkeleton({ label, testId, rows = 3, variant = 'card' }: PaneSkeletonProps) {
  const keys = Array.from({ length: rows }, (_, i) => i);
  return (
    <div
      role="progressbar"
      aria-busy="true"
      aria-label={label}
      data-testid={testId}
      data-variant={variant}
      className={variant === 'message' ? 'flex flex-col gap-4 px-4 py-3' : 'flex flex-col gap-2 py-2'}
    >
      {variant === 'message'
        ? keys.map((i) => (
            <div key={i} aria-hidden="true" className="flex items-start gap-3">
              <div className={'mt-0.5 h-10 w-10 shrink-0 rounded-full ' + pulse} />
              <div className="min-w-0 flex-1 pt-1">
                <div className={'h-3 w-28 ' + pulse} />
                <div className={'mt-2 h-3 w-3/5 ' + pulse} />
              </div>
            </div>
          ))
        : keys.map((i) => (
            <div
              key={i}
              aria-hidden="true"
              className="flex items-center gap-3 rounded-md border border-line bg-surface px-3 py-3"
            >
              <div className={'h-9 w-9 rounded-full ' + pulse} />
              <div className="flex-1">
                <div className={'h-3.5 w-40 ' + pulse} />
                <div className={'mt-1.5 h-2.5 w-24 ' + pulse} />
              </div>
            </div>
          ))}
      <span className="sr-only">Loading…</span>
    </div>
  );
}

export interface PaneEmptyProps {
  title: string;
  hint: string;
  testId: string;
}

export function PaneEmpty({ title, hint, testId }: PaneEmptyProps) {
  return (
    <div
      data-testid={testId}
      className="flex flex-col items-center gap-1 rounded-md border border-dashed border-line px-4 py-10 text-center"
    >
      <p className="text-sm font-medium text-text-primary">{title}</p>
      <p className="text-sm text-text-muted">{hint}</p>
    </div>
  );
}

export interface PaneErrorBannerProps {
  /** The banner's testid (e.g. "bots-error"). */
  testId: string;
  /** The Retry button's testid (e.g. "bots-retry" — not derivable from `testId`). */
  retryTestId: string;
  message: string;
  onRetry: () => void;
}

/**
 * The app's ONE retry affordance (UI consistency, 2026-09-27): one style, one
 * copy — "Retry". Panes used to disagree (a primary "Retry", a secondary
 * "Retry", a home-button "Try again"), which read as three different kinds of
 * failure.
 */
export function PaneRetryButton({ testId, onRetry }: { testId: string; onRetry: () => void }) {
  return (
    <button
      type="button"
      onClick={onRetry}
      data-testid={testId}
      className="mt-2 rounded px-3 py-1.5 text-sm font-medium text-accent transition-colors duration-[var(--duration-control)] hover:bg-accent/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
    >
      Retry
    </button>
  );
}

export function PaneErrorBanner({ testId, retryTestId, message, onRetry }: PaneErrorBannerProps) {
  return (
    <StateBanner
      tone="danger"
      testId={testId}
      action={<PaneRetryButton testId={retryTestId} onRetry={onRetry} />}
    >
      {message}
    </StateBanner>
  );
}
