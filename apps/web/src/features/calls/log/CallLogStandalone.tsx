/**
 * @cytale/web — the standalone call log (calls plan U9, R6 + AM18).
 *
 * The main-room access to the call log WITHOUT joining: opened from the
 * channel header's always-available "Call log" action (U7's onOpenCallLog
 * seam, wired for real by the shell). Presentation mirrors the
 * ThreadSidePanel dock — the same pane-narrower idiom, indented-context
 * reading beside the still-live channel — around the shared
 * CallLogThreadView body (message rows, boundary rows, thread composer,
 * and the full states-first set).
 */

import { useEffect } from 'react';

import { CallLogThreadView, type CallLogThreadViewProps } from './CallLogPane.js';
import { paneCloseButtonClass } from '../../../app/ui/button.js';

export interface CallLogStandaloneProps extends CallLogThreadViewProps {
  /** Closes the dock (the header ✕ — the shell unmounts the surface). */
  onClose?: () => void;
}

export function CallLogStandalone({ onClose, ...viewProps }: CallLogStandaloneProps) {
  // A dock with a ✕ also closes on Escape, like the settings panes and
  // release notes; a layer above that already handled the key (a dialog, a
  // menu, the composer cancelling a reply) wins. Without onClose the host owns
  // the surface's lifetime (the side column closes through RailIcons).
  useEffect(() => {
    if (!onClose) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <aside
      className="flex h-full w-full flex-col bg-background"
      aria-label="Call log"
      data-testid="call-log-standalone"
      data-channel-id={viewProps.channelId}
    >
      {/* Header row — the ThreadSidePanel chrome (~58px band, 40×40 hit
          areas, focus-visible rings). */}
      <div
        className="flex h-[58px] shrink-0 items-center gap-1 border-b border-line px-3"
        data-testid="call-log-header"
      >
        <span aria-hidden className="mr-1 text-lg" data-testid="call-log-icon">
          📞
        </span>
        <h2
          className="min-w-0 flex-1 truncate text-base font-semibold text-text-primary"
          data-testid="call-log-title"
        >
          Call log
        </h2>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            className={paneCloseButtonClass}
            aria-label="Close call log"
            data-testid="call-log-close"
          >
            ✕
          </button>
        ) : null}
      </div>

      {/* The shared body: states-first log view + thread composer. */}
      <div className="flex min-h-0 flex-1 flex-col p-2">
        <CallLogThreadView {...viewProps} />
      </div>
    </aside>
  );
}
