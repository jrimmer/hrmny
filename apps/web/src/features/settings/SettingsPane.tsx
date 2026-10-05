/**
 * @cytale/web — SettingsPane, the settings surface's column-3 frame.
 *
 * Owns the section header (title + close ✕), the Escape-to-close contract,
 * and the centered content column. The sections themselves are passed in
 * by AuthenticatedApp, which wires their API callbacks.
 *
 * Escape closes the surface only when `escapeEnabled` — a modal layered
 * above (the integrations panel) owns Escape while it is open.
 *
 * U5 — mobile section view: with `onBack` provided (the list→content stack
 * below 768px), the affordances split — the ✕ becomes a ← back control that
 * returns to the full-width list, and Escape routes to that back target
 * ("Escape in a section goes back to the list; then ✕ closes"). Desktop
 * (no onBack) renders exactly as before.
 */

import { useEffect, type ReactNode } from 'react';

import { ListErrorBoundary } from '../messages/ListErrorBoundary.js';
import { paneCloseButtonClass } from '../../app/ui/button.js';

export interface SettingsPaneProps {
  title: string;
  onClose(): void;
  /** U5 mobile: present → ← back-to-list replaces the ✕, and Escape routes
   *  to the list instead of closing. Absent on desktop. */
  onBack?: () => void;
  /** False while an overlay above owns the Escape key (integrations panel). */
  escapeEnabled?: boolean;
  children: ReactNode;
}

export function SettingsPane({ title, onClose, onBack, escapeEnabled = true, children }: SettingsPaneProps) {
  useEffect(() => {
    if (!escapeEnabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        (onBack ?? onClose)();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [escapeEnabled, onBack, onClose]);

  return (
    <section
      aria-label={`${title} — user settings`}
      data-testid="settings-pane"
      className="flex h-full flex-col bg-background"
    >
      <header className="flex items-center gap-3 px-4 py-3 sm:px-6">
        {onBack ? (
          <button
            type="button"
            aria-label="Back to the settings list"
            data-testid="settings-back"
            className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-md text-lg text-text-muted transition-colors duration-[var(--duration-control)] hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
            onClick={onBack}
          >
            ←
          </button>
        ) : null}
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold text-text-primary" data-testid="settings-pane-title">
          {title}
        </h1>
        {onBack ? null : (
          <button
            type="button"
            aria-label="Close user settings"
            data-testid="settings-close"
            className={paneCloseButtonClass}
            onClick={onClose}
          >
            ✕
          </button>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6" data-testid="settings-content">
        <div className="mx-auto flex max-w-2xl flex-col gap-8">
          {/* Hardening plan 7.4: a section that throws during render costs
              the section (remounted under the list boundary's cap), not the
              shell — the header, the col-2 nav and every route survive. */}
          <ListErrorBoundary surface="settings pane" testIdPrefix="settings">
            {children}
          </ListErrorBoundary>
        </div>
      </div>
    </section>
  );
}
