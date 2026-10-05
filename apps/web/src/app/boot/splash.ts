/**
 * @cytale/web — the boot cover's dismissal (one owner, called by the app).
 *
 * `index.html` paints a cover before any module runs: the app used to open on
 * a browser-default white frame, then the token stylesheet landed and it
 * flipped dark, then the entry rendered a bare `shell`/`pane` skeleton, then a
 * stored session resolved and the login page was replaced by the shell. Four
 * paints, three of them transitional — which reads as a flicker, not a boot.
 *
 * The cover is the single paint that hides all of them. This module takes it
 * down, and it does so on ONE signal: a real surface is on screen. It is
 * deliberately not wired to `DOMContentLoaded` or to a timer — those fire when
 * the bundle has loaded, which is not the same as when there is something to
 * look at, and covering that gap is the entire point.
 *
 * Dismissal is idempotent by construction: the cover is marked `ready` before
 * anything is removed, so a second caller, the in-page fail-safe timer, and the
 * error boundary can all call it without racing.
 */

/** The cover element's id, shared with `index.html`. */
export const BOOT_COVER_ID = 'boot-cover';

/** Must match the `[data-state='ready']` transition in `index.html`. */
const FADE_MS = 200;

/** True when the reader asked for reduced motion (or the API is unavailable). */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Reveal the application by removing the boot cover.
 *
 * Safe to call when the cover is absent (unit tests, a build whose entry is
 * served without `index.html`, a second call after the first) — it is a no-op
 * rather than an error, because every one of those cases is legitimate.
 */
export function dismissBootCover(): void {
  if (typeof document === 'undefined') return;

  const el = document.getElementById(BOOT_COVER_ID);
  if (el === null || el.getAttribute('data-state') === 'ready') return;

  el.setAttribute('data-state', 'ready');
  el.setAttribute('aria-busy', 'false');

  // Reduced motion: the window is already gone, so take the node out in the
  // same tick rather than animating a fade the reader asked us not to animate.
  if (prefersReducedMotion()) {
    el.remove();
    return;
  }

  window.setTimeout(() => {
    el.remove();
  }, FADE_MS);
}

/**
 * How long the app may hold the cover once the entry is running (lane D #4).
 * The in-page fail-safe's 4 s is sized for "did the bundle execute at all";
 * a live app legitimately holds the cover longer on a slow link (session
 * restore, then the member's roster), and revealing an empty frame early is
 * the flash the cover exists to prevent.
 */
export const APP_OWNED_COVER_MAX_MS = 12_000;

/**
 * Take ownership of the cover from `public/boot-failsafe.js`: push its
 * deadline out to `ms`. A no-op where the fail-safe did not load (tests, a
 * build served without `index.html`).
 */
export function extendBootFailsafe(ms: number = APP_OWNED_COVER_MAX_MS): void {
  if (typeof window === 'undefined') return;
  const extend = (window as { __hrmnyExtendBootFailsafe?: (ms: number) => void })
    .__hrmnyExtendBootFailsafe;
  if (typeof extend === 'function') extend(ms);
}
