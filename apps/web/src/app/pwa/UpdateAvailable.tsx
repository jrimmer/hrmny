/**
 * @cytale/web — the "new version" affordance (lane D #6).
 *
 * A deploy used to reload every open tab by itself (the service worker's
 * controller take-over). Now the new version WAITS, and this says so: a small,
 * non-blocking status line with a Reload button — the member picks the moment
 * (after the sentence they are typing, after the call). Dismissible for the
 * session; the update still applies on the next navigation.
 */

import { useState, useSyncExternalStore } from 'react';

import { applyUpdate, getUpdateState, subscribeUpdateState } from './registerSW.js';

export function UpdateAvailable() {
  const state = useSyncExternalStore(subscribeUpdateState, getUpdateState, getUpdateState);
  const [dismissed, setDismissed] = useState(false);

  if (state === 'none' || dismissed) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="update-available"
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        maxWidth: 'calc(100vw - 32px)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '8px 12px',
        borderRadius: 8,
        background: 'var(--color-surface-strong, #2b2d31)',
        color: 'var(--color-content, #f2f3f5)',
        border: '1px solid var(--color-line, transparent)',
        // The popover elevation token (pixel style's hard shadow included).
        boxShadow: 'var(--shadow-popover)',
        fontSize: 14,
        zIndex: 1000,
      }}
    >
      <span>
        {state === 'available' ? 'An update is available.' : 'Reload to finish updating.'}
      </span>
      <button
        type="button"
        data-testid="update-available-reload"
        className="update-available-btn"
        onClick={applyUpdate}
        style={{
          padding: '4px 10px',
          borderRadius: 6,
          border: 'none',
          background: 'var(--color-action, #5865f2)',
          color: 'var(--color-on-action, #ffffff)',
          cursor: 'pointer',
          font: 'inherit',
        }}
      >
        Reload
      </button>
      <button
        type="button"
        aria-label="Dismiss update notice"
        data-testid="update-available-dismiss"
        className="update-available-btn"
        onClick={() => setDismissed(true)}
        style={{
          padding: '4px 6px',
          border: 'none',
          background: 'transparent',
          color: 'inherit',
          cursor: 'pointer',
          font: 'inherit',
        }}
      >
        ✕
      </button>
    </div>
  );
}
