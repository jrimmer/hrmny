/**
 * @cytale/web — shared button class vocabulary.
 *
 * The single source for the app's button treatments outside the auth pages
 * (auth keeps `features/auth/formStyles.ts`, its own cohesive set). Every
 * surface that needs a primary action, a small ghost action, or a
 * pagination "load more" uses these so hover/focus/disabled states stay in
 * lockstep.
 */

/** Primary action: accent fill, brightness hover, focus ring. */
export const primaryButtonClass =
  'min-h-10 rounded-md bg-accent px-4 py-2 text-sm font-medium text-text-onaccent ' +
  'transition-[filter] duration-[var(--duration-control)] hover:brightness-110 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]';

/** Small ghost action: bordered, muted → primary on hover. */
export const ghostButtonSmClass =
  'rounded-md border border-line bg-transparent px-3 py-1.5 text-sm font-medium text-text ' +
  'transition-colors duration-[var(--duration-control)] hover:border-input-line hover:bg-surface-hover ' +
  'hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]';

/** Pagination footer: subtle bordered button that reads as "more below". */
export const loadMoreButtonClass =
  'rounded-md border border-line bg-transparent px-3 py-1.5 text-sm font-medium text-text ' +
  'transition-colors duration-[var(--duration-control)] hover:border-input-line hover:bg-surface-hover ' +
  'hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]';

/**
 * A pane's ✕ (release notes, settings, server settings, the thread panel, the
 * call log): a 40px hit, a 16px glyph, muted → primary on hover. The panes
 * each carried a copy of this string and drifted — a text-xl glyph on one, a
 * hover that never brightened the glyph on two.
 */
export const paneCloseButtonClass =
  'flex h-10 w-10 items-center justify-center rounded-md text-base leading-none text-text-muted ' +
  'transition-colors duration-[var(--duration-control)] hover:bg-surface-hover hover:text-text-primary ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]';

/**
 * A header's icon control: a 40px hit, no border, muted → primary on hover.
 * The side-column icons (members / call log / threads) and the phone
 * topbar's channel controls (notifications, start/join call) share it — the
 * topbar's two phone glyphs used to be a bordered tile beside a bare icon.
 */
export const headerIconButtonClass =
  'flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-text-muted ' +
  'transition-colors duration-[var(--duration-control)] hover:bg-surface-hover ' +
  'hover:text-text-primary focus-visible:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]';
