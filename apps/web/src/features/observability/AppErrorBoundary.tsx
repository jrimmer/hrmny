/**
 * @cytale/web — the app-shell React error boundary (#88).
 *
 * A render-time exception used to unmount the whole tree and leave a blank
 * page: the user saw nothing, and the maintainer heard about it only if
 * someone said so. This boundary turns that into two things at once — a
 * report through the shared reporter, and a fallback a person can act on.
 *
 * The report is fingerprinted like every other capture point, so a loop (a
 * component that throws on every render, or a retry that re-throws) produces
 * ONE report, not one per frame.
 *
 * It sits at the app shell, NOT around each feature: `LexicalErrorBoundary`
 * and per-pane handling already exist for their local cases, and a boundary at
 * every level would fragment where an error is attributed.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

import type { ClientErrorReporter } from '@cytale/api-client';

import { clientErrors } from './clientErrors.js';
import { dismissBootCover } from '../../app/boot/splash.js';

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Reporter seam (tests); defaults to the shared `clientErrors`. */
  reporter?: ClientErrorReporter;
  /** Full report seam: bypasses `reporter` entirely when supplied. */
  onError?: (error: unknown, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class AppErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The fallback must never sit behind the boot cover. A throw during the
    // first render is exactly when the cover is still up, and the cover is
    // opaque — the message the person needs would be hidden by it.
    dismissBootCover();
    const report = this.props.onError ?? ((err: unknown, details: ErrorInfo) => defaultReport(err, details, this.props.reporter));
    try {
      report(error, info);
    } catch {
      // A reporting failure must never be the second incident.
    }
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <div className="shell" role="alert" data-testid="app-error-fallback">
        <div className="pane" style={{ padding: '2rem', display: 'grid', gap: '0.75rem' }}>
          <h1 style={{ fontSize: '1rem', fontWeight: 600 }}>Something went wrong</h1>
          <p style={{ margin: 0 }}>
            The app hit an unexpected error. Reloading usually clears it.
          </p>
          {/* The message is shown, not hidden: a person reporting the problem
              needs something to quote, and it is already the same text the
              report carries. */}
          <pre
            style={{ margin: 0, opacity: 0.75, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
            data-testid="app-error-detail"
          >
            {this.state.error.message}
          </pre>
          <button type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}

function defaultReport(
  error: unknown,
  info: ErrorInfo,
  reporter: ClientErrorReporter = clientErrors
): void {
  reporter.captureThrown(error, {
    source: 'error-boundary',
    // The component stack is the diagnosis; it is a stack, so it is redacted
    // and truncated by the reporter like any other.
    stack: info.componentStack ? `${String(error instanceof Error ? error.stack : '')}\n${info.componentStack}` : undefined,
  });
}
