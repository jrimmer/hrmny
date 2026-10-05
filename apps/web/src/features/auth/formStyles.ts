/**
 * U19 — shared form styling tokens (Tailwind classes over the U18 theme).
 * Kept in one place so every auth page reads identically. The page shell
 * (authPageClass) centers the card on the app background; the card is one
 * surface escalation up with a subtle border (escalation rule §4).
 */

/** Auth page shell: full-viewport centered card (Discord auth placement). */
export const authPageClass =
  'grid min-h-dvh place-items-center bg-background px-4';

/** Auth card: surface + border + radius (one escalation above background). */
export const authCardClass =
  'w-full max-w-sm rounded-lg border border-line bg-surface p-8';

/** Auth page heading. */
export const authHeadingClass = 'mb-6 text-xl font-semibold text-text-primary';

/** Ghost (secondary) button: transparent, subtle border, muted → primary on hover. */
export const ghostButtonClass =
  'w-full rounded-md border border-line bg-transparent px-3 py-2 font-medium text-text ' +
  'transition-colors duration-[var(--duration-control)] hover:border-input-line hover:bg-surface-hover ' +
  'hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-[var(--color-focus)] disabled:cursor-not-allowed disabled:opacity-50';

export const fieldClass =
  'w-full rounded-md border border-input-line bg-input px-3 py-2 text-text-primary ' +
  'placeholder:text-text-muted transition-colors duration-[var(--duration-control)] ' +
  'focus:outline-none focus:ring-2 focus:ring-[var(--color-focus)]';

export const buttonClass =
  'w-full rounded-md bg-accent px-3 py-2 font-medium text-text-onaccent ' +
  'transition-[filter,opacity] duration-[var(--duration-control)] ' +
  'hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-[var(--color-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-surface ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

export const labelClass = 'mb-1 block text-sm text-text-muted';

export const errorClass =
  'rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger';

export const noticeClass =
  'rounded-md border border-line bg-surface-emphasized px-3 py-2 text-sm text-text-muted';

/** Warning-tinted notice (view-only gate,ComposerBanner). */
export const warningClass =
  'rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm';
