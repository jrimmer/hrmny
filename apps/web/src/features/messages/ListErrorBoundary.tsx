/**
 * @cytale/web — the message list's OWN crash guard (#135/#137).
 *
 * The scrollback crash lives INSIDE react-virtuoso's synchronous emit graph:
 * a render-time `RangeError: Maximum call stack size exceeded` that used to
 * propagate straight to the app-shell boundary and take the whole session
 * down. Reload recovered the app but threw away the scroll position and
 * every loaded page of history — the expensive part was losing the SESSION
 * to a LIST bug. So the boundary is scoped to the list alone, and the
 * recovery is scoped the same way:
 *
 *   * on a crash it REMOUNTS the list — a fresh Virtuoso whose
 *     `initialTopMostItemIndex` lands on the newest loaded message (position
 *     reset). Everything that matters survives, because it was never inside
 *     the crashed subtree: the store still holds every loaded page of
 *     history, the composer draft, the gateway session, the pane itself.
 *   * remounts are CAPPED. A fault that survives its own remount (the
 *     oscillation re-triggering on the fresh mount) must not loop forever,
 *     silently remount-crashing per frame: past the cap the pane renders a
 *     small inline panel with a Try again button that clears the cap and
 *     remounts once more. The app shell's boundary stays as the last resort;
 *     this one fires first and contains the blast radius.
 *
 * Mechanically this follows the AppErrorBoundary shape — the crashing
 * children leave the tree in the same render that derives the error state
 * (`getDerivedStateFromError` → render null for exactly one commit), and the
 * reporting + retry decision happen in `componentDidCatch` at that commit.
 * Deciding the remount ANYWHERE but a committed state change makes React
 * re-render the still-mounted throwing subtree in its recovery loop, and
 * the crash re-throws out of the boundary (verified 2026-09-19).
 *
 * Every catch is reported through the shared reporter with the reporter's
 * `error-boundary` source (the component stack attributes it to the list
 * subtree), so a remount loop surfaces in telemetry as one fingerprint,
 * not one report per frame — and not as a blank screen nobody can attribute.
 *
 * Hardening plan 7.4 reuses the same containment at the OTHER volatile
 * panes — each rail tab, the settings pane, the call panel — so a render
 * throw there costs that pane (remounted under the same cap) instead of the
 * whole shell: session, draft, scroll position and route all survive,
 * because none of them live inside the guarded subtree. `surface` and
 * `testIdPrefix` are the only knobs those mounts need; the remount cap
 * semantics are byte-identical to the list's.
 */

import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';

import type { ClientErrorReporter } from '@cytale/api-client';

import { clientErrors } from '../observability/clientErrors.js';
import { PaneRetryButton } from '../../app/ui/PaneStates.js';

export interface ListErrorBoundaryProps {
  children: ReactNode;
  /** Reporter seam (tests); defaults to the shared `clientErrors`. */
  reporter?: Pick<ClientErrorReporter, 'captureThrown'>;
  /** Remounts allowed within `windowMs` before the fallback takes over. */
  maxRemounts?: number;
  /** Sliding window the remount cap is counted in. */
  windowMs?: number;
  /**
   * The surface this boundary guards, named in the fallback copy (hardening
   * plan 7.4 reuses this boundary for the rail tabs, the settings pane and
   * the call panel). Defaults to the message list — the original scope.
   */
  surface?: string;
  /**
   * Prefix for the fallback's testids (`<prefix>-crash-fallback` /
   * `<prefix>-crash-retry`). Defaults to `list`; scoped hosts pass their own
   * so a shell test can find the crashed pane among several boundaries.
   */
  testIdPrefix?: string;
}

interface ListErrorBoundaryState {
  /** The crash under processing. Non-null takes the children OUT of the
   *  tree for the commit that runs componentDidCatch. */
  error: Error | null;
  /**
   * Epoch of the mounted list. Keyed onto the children, so every bump tears
   * the crashed Virtuoso subtree down completely and mounts a fresh one.
   */
  attempt: number;
  /** Timestamps of recent crashes, pruned against `windowMs`. */
  crashes: number[];
  /** True once the cap is hit: the inline panel renders instead of the list. */
  exhausted: boolean;
}

export class ListErrorBoundary extends Component<ListErrorBoundaryProps, ListErrorBoundaryState> {
  override state: ListErrorBoundaryState = {
    error: null,
    attempt: 0,
    crashes: [],
    exhausted: false,
  };

  /** The crashing children leave the tree NOW; componentDidCatch decides. */
  static getDerivedStateFromError(error: Error): Pick<ListErrorBoundaryState, 'error'> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    const { maxRemounts = 2, windowMs = 60_000, reporter } = this.props;
    try {
      (reporter ?? clientErrors).captureThrown(error, {
        // `source` is a closed wire union with no list-specific member; this
        // IS an error boundary, and the component stack (below) is what
        // attributes the crash to the list subtree rather than the shell.
        source: 'error-boundary',
        // The component stack names the crashing subtree inside the list —
        // redacted and truncated by the reporter like any other stack.
        stack: info.componentStack
          ? `${String(error.stack ?? '')}\n${info.componentStack}`
          : undefined,
      });
    } catch {
      // A reporting failure must never be the second incident.
    }

    const now = Date.now();
    const crashes = [...this.state.crashes, now].filter((t) => t > now - windowMs);
    if (crashes.length > maxRemounts) {
      this.setState({ crashes, exhausted: true });
    } else {
      // One more remount: a fresh subtree epoch, and the children come back.
      this.setState((s) => ({ error: null, crashes, attempt: s.attempt + 1 }));
    }
  }

  override render(): ReactNode {
    const { error, exhausted, attempt } = this.state;
    const { surface = 'message list', testIdPrefix = 'list' } = this.props;
    if (exhausted) {
      return (
        <div
          role="alert"
          data-testid={`${testIdPrefix}-crash-fallback`}
          className="flex h-full flex-col items-center justify-center gap-3 px-6 py-8 text-center"
        >
          <p className="text-sm text-text-primary">The {surface} hit an error.</p>
          <p className="text-xs text-text-muted">
            Your session is safe. Retrying remounts the {surface}.
          </p>
          {/* The app's one retry affordance (PaneStates): same copy and
              style as every pane's Retry — this was a bordered "Try again". */}
          <PaneRetryButton
            testId={`${testIdPrefix}-crash-retry`}
            onRetry={() =>
              this.setState((s) => ({
                error: null,
                attempt: s.attempt + 1,
                crashes: [],
                exhausted: false,
              }))
            }
          />
        </div>
      );
    }
    // A crash is being processed (componentDidCatch fires at this commit):
    // render nothing rather than the throwing subtree. One commit, one frame.
    if (error !== null) return null;
    return <Fragment key={attempt}>{this.props.children}</Fragment>;
  }
}
