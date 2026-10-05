/**
 * @cytale/web — SettingsNav, the settings surface's column-2 menu.
 *
 * The gear's pattern (owner-ratified): the left cluster stays, the sidebar
 * column shows the settings menu, the pane column shows the selected
 * section, and the fourth column is hidden. This component owns only the
 * menu; the shell swap lives in AuthenticatedApp.
 *
 * Curated against Discord's user-settings tree, carrying only what Hrmny
 * can back honestly today (substrate-audited 2026-09-06):
 *
 *   My Account    Discord's My Account + Sessions merged (our token model
 *                 has no per-device metadata yet, so a session LIST would
 *                 be fake — the revoke-all action is real).
 *   Appearance    theme (dark only — light is a planned tokens remap,
 *                 shown disabled) + a real client-local reduce-motion
 *                 toggle.
 *   Integrations  Discord's Authorized Apps analog: the "My integrations"
 *                 rollup of the caller's machine principals.
 *   SSH           keys + certificates for the terminal client (tui plan U3):
 *                 generate a keypair, submit its public half, list, re-issue,
 *                 and retire a key.
 *   Voice & Video DISABLED — V2's U5/U8 own device + quality settings
 *                 ("not in V2's file list; add or defer at U5"), so the
 *                 row is visible-but-dead with the reason in its title
 *                 (the composer GIF button's honest-dead pattern).
 *
 * Footer: Log out (red, Discord placement) — the app's first logout
 * affordance, so no duplicate exists anywhere else.
 *
 * U5 — mobile (below 768px): the desktop two-column squeeze (nav + content
 * side-by-side in ~318px, Log out unreachable) is replaced by a list→content
 * stack. The `mobile` variant renders the SAME sections as the pane's
 * full-width LIST — Log out as its final row (same onLogout flow) — with the
 * explicit ✕ + Escape-to-close contract in the list header (the section
 * views carry the ← back instead; see SettingsPane). The desktop col-2 menu
 * JSX below is untouched.
 */

import { useEffect, useRef } from 'react';

import type { SettingsSection } from './router.js';

export interface SettingsNavProps {
  active: SettingsSection;
  onSelect(section: SettingsSection): void;
  onLogout(): void;
  /** Below 768px: render as the pane's full-width list (U5), not the menu. */
  mobile?: boolean;
  /** Mobile only: the list header's ✕ + Escape-to-close (the desktop pane
   *  owns Escape; the desktop menu closes nothing itself). */
  onClose?: () => void;
}

interface NavItem {
  id: SettingsSection;
  label: string;
  hint: string;
}

const ITEMS: NavItem[] = [
  { id: 'account', label: 'My Account', hint: 'Username, email, password and sessions' },
  { id: 'appearance', label: 'Appearance', hint: 'Theme and motion' },
  { id: 'emoji', label: 'Reaction & Emoji', hint: 'Favorites for the pickers' },
  {
    id: 'notifications',
    label: 'Notifications',
    hint: 'What reaches you, and where it is delivered',
  },
  {
    id: 'integrations',
    // The section ID stays `integrations` — it is the hash segment and an
    // internal name — while the WORD is Agent: the one user-facing word for
    // a machine principal (R1).
    label: 'Agents',
    hint: 'Your agents and the access each one holds',
  },
  {
    id: 'webhooks',
    label: 'Webhooks',
    hint: 'Incoming URLs you own, and where each one posts',
  },
  {
    id: 'ssh',
    label: 'SSH',
    hint: 'Keys and certificates for the terminal client',
  },
];

const SECTION_TITLE: Record<SettingsSection, string> = {
  account: 'My Account',
  appearance: 'Appearance',
  emoji: 'Reaction & Emoji',
  notifications: 'Notifications',
  integrations: 'Agents',
  webhooks: 'Webhooks',
  ssh: 'SSH',
};

export function sectionTitle(section: SettingsSection): string {
  return SECTION_TITLE[section];
}

const navItemClass = (active: boolean): string =>
  'flex min-h-9 w-full items-center rounded-md px-3 py-1.5 text-left text-sm font-medium transition-colors duration-[var(--duration-control)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] ' +
  (active
    ? 'bg-surface-strong text-text-primary'
    : 'text-text-muted hover:bg-surface-hover hover:text-text');

export function SettingsNav({ active, onSelect, onLogout, mobile = false, onClose }: SettingsNavProps) {
  // Focus enters the menu when the surface opens — keyboard users land on
  // the sections, not wherever the shell happened to be. (The mobile list
  // mounts/unmounts on the list↔section switch, so ← refocuses the rows.)
  const firstItemRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    firstItemRef.current?.focus();
  }, []);

  // U5: on the mobile LIST, Escape closes the whole surface (the existing
  // SettingsPane contract); in a section, the pane's ← owns Escape first.
  // Desktop is untouched — there the pane owns Escape exclusively.
  useEffect(() => {
    if (!mobile || !onClose) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [mobile, onClose]);

  if (mobile) {
    return (
      <div className="flex h-full flex-col bg-background" data-testid="settings-nav" data-mobile="true">
        <header className="flex min-h-12 items-center gap-1 border-b border-line px-2">
          <h2 className="min-w-0 flex-1 truncate px-2 text-sm font-semibold uppercase tracking-wide text-text-muted">
            User settings
          </h2>
          <button
            type="button"
            aria-label="Close user settings"
            data-testid="settings-nav-close"
            className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-md text-lg text-text-muted transition-colors duration-[var(--duration-control)] hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
            onClick={onClose}
          >
            ✕
          </button>
        </header>

        <nav aria-label="User settings" className="flex-1 overflow-y-auto px-2 py-2">
          <ul className="flex flex-col gap-1">
            {ITEMS.map((item, i) => {
              const isActive = item.id === active;
              return (
                <li key={item.id}>
                  <button
                    ref={i === 0 ? firstItemRef : undefined}
                    type="button"
                    className="settings-list-row"
                    data-active={isActive || undefined}
                    aria-current={isActive ? 'page' : undefined}
                    data-testid={`settings-nav-${item.id}`}
                    onClick={() => onSelect(item.id)}
                  >
                    {item.label}
                  </button>
                </li>
              );
            })}
            <li>
              {/* Visible-but-dead (V2 owns voice/video settings; title carries
                  the reason — the composer GIF button's pattern). */}
              <span
                className="settings-list-row"
                data-dead="true"
                aria-disabled="true"
                title="Arrives with the video and screenshare update — device and quality options will live here."
                data-testid="settings-nav-voice"
              >
                Voice &amp; Video
              </span>
            </li>
            <li className="settings-list-logout-row">
              {/* The list's FINAL row — the desktop footer's exact logout
                  flow (same prop), now reachable without the two-column
                  squeeze that parked it off-screen. */}
              <button
                type="button"
                className="settings-list-row"
                data-danger="true"
                data-testid="settings-nav-logout"
                onClick={onLogout}
              >
                Log out
              </button>
            </li>
          </ul>
        </nav>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col" data-testid="settings-nav">
      <div className="flex min-h-12 items-center px-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted">
          User settings
        </h2>
      </div>

      <nav aria-label="User settings" className="flex-1 overflow-y-auto px-2 py-3">
        <ul className="flex flex-col gap-1">
          {ITEMS.map((item, i) => {
            const isActive = item.id === active;
            return (
              <li key={item.id}>
                <button
                  ref={i === 0 ? firstItemRef : undefined}
                  type="button"
                  className={navItemClass(isActive)}
                  aria-current={isActive ? 'page' : undefined}
                  data-testid={`settings-nav-${item.id}`}
                  onClick={() => onSelect(item.id)}
                >
                  {item.label}
                </button>
              </li>
            );
          })}
          <li>
            {/* Visible-but-dead (V2 owns voice/video settings; title carries
                the reason — the composer GIF button's pattern). */}
            <span
              className="flex min-h-9 w-full cursor-not-allowed items-center rounded-md px-3 py-1.5 text-left text-sm font-medium text-text-muted opacity-50"
              aria-disabled="true"
              title="Arrives with the video and screenshare update — device and quality options will live here."
              data-testid="settings-nav-voice"
            >
              Voice &amp; Video
            </span>
          </li>
        </ul>
      </nav>

      <div className="border-t border-line px-2 py-3">
        <button
          type="button"
          className="flex min-h-9 w-full items-center rounded-md px-3 py-1.5 text-left text-sm font-semibold text-danger transition-colors duration-[var(--duration-control)] hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
          data-testid="settings-nav-logout"
          onClick={onLogout}
        >
          Log out
        </button>
      </div>
    </div>
  );
}
