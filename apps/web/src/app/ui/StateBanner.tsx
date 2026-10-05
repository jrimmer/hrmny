/**
 * @cytale/web — shared states-first banner.
 *
 * One component for the loading/empty/error/offline/permission-denied DoD
 * banners so the treatments cannot drift between surfaces (the states-first
 * contract is visual, not just semantic). Warning is a live region
 * (role=status); danger is an alert.
 */

import type { ReactNode } from 'react';

export type BannerTone = 'warning' | 'danger' | 'info';

export interface StateBannerProps {
  tone: BannerTone;
  /** Override the default testid (`banner-<tone>`). */
  testId?: string;
  children: ReactNode;
  /** Optional retry action rendered inside the banner. */
  action?: ReactNode;
}

/*
 * Danger-outline recipes, written down (UI consistency pass 2026-09-15):
 * NOTES — passive banners/callouts that something is wrong — are
 * `border-danger/30 bg-danger/10` (this file, DmCallIndicator/CallPanel
 * error notes). CONFIRM-REQUIRED ACTIONS — buttons that perform the
 * destructive thing — are `border-danger/40 bg-danger/10` + semibold
 * (AccountSection, PasskeysSection, InlineConfirm, MessageCompose discard).
 */
const toneClass: Record<BannerTone, string> = {
  warning: 'rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning',
  danger: 'rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger',
  info: 'rounded-md border border-line bg-surface-hover px-3 py-2 text-sm text-text-muted',
};

export function StateBanner({ tone, testId, children, action }: StateBannerProps) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      data-testid={testId ?? `banner-${tone}`}
      className={toneClass[tone]}
    >
      {children}
      {action}
    </div>
  );
}
