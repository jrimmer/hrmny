/**
 * @cytale/web — shared SVG glyphs (started 2026-09-15, UI consistency pass).
 *
 * The app's icon idiom is hand-rolled inline SVG: 24-grid paths, fill none,
 * stroke currentColor at 2px, round caps/joins — recolored per state through
 * CSS color, never separate assets. Emoji/text glyphs that carry STATE (the
 * old 🧵 / ⟡) migrate here: they rendered differently per OS and put a second
 * optical strategy on surfaces that were otherwise all stroke-2 SVG.
 *
 * `PhoneIcon` is the one deliberate exception to the stroke idiom: it arrived
 * as a solid Material-style silhouette copied five times (plan 7.7), and
 * re-stroking it would change the rendered weight everywhere it is used.
 */

/**
 * A phone handset (filled, Material-style). Plan 7.7: this was five verbatim
 * copies (MobileTopbar, CallSlot, CallPanel, DmCallIndicator, MessagePane)
 * differing only in `size` and CallSlot's layout class — so `size`/`className`
 * are the whole parameterisation, and the path below is the one every copy
 * carried. NOTE the fill: unlike the stroke-2 glyphs around it this is a solid
 * silhouette, so it keeps `fill="currentColor"` — re-stroking it would change
 * the rendered weight at every call site.
 */
export function PhoneIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.2.2 2.4.6 3.6.1.3 0 .7-.2 1l-2.3 2.2z" />
    </svg>
  );
}

/**
 * The inline busy ring (plan 7.7: was a verbatim pair in CallPanel and
 * DmCallIndicator). Animates through Tailwind's existing `animate-spin`
 * utility — the same mechanism both copies used — and takes the caller's
 * `data-testid`, which was the copies' only difference.
 */
export function Spinner({ testId }: { testId: string }) {
  return (
    <span
      aria-hidden
      data-testid={testId}
      className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-text-muted border-t-transparent"
    />
  );
}

/**
 * The shared stroke-2 frame for the glyphs below — one place for the idiom
 * (24-grid, fill none, currentColor, round caps/joins) so a new glyph cannot
 * drift from it.
 */
function StrokeIcon({ size = 16, children }: { size?: number; children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/**
 * Notification level glyphs (notification controls, 2026-09-27): bell = all
 * messages, at-sign = mentions only, bell-off = nothing. The header control
 * cycles through them in that order, and every surface that names a level
 * (menus, sheet, settings) shows the same glyph for it (lucide bell / at-sign
 * / bell-off).
 */
export function BellIcon({ size = 16 }: { size?: number }) {
  return (
    <StrokeIcon size={size}>
      <path d="M10.268 21a2 2 0 0 0 3.464 0" />
      <path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" />
    </StrokeIcon>
  );
}

export function BellOffIcon({ size = 16 }: { size?: number }) {
  return (
    <StrokeIcon size={size}>
      <path d="M10.268 21a2 2 0 0 0 3.464 0" />
      <path d="M17 17H4a1 1 0 0 1-.74-1.673C4.59 13.956 6 12.499 6 8a6 6 0 0 1 .258-1.742" />
      <path d="m2 2 20 20" />
      <path d="M8.668 3.01A6 6 0 0 1 18 8c0 2.687.77 4.653 1.707 6.05" />
    </StrokeIcon>
  );
}

export function AtSignIcon({ size = 16 }: { size?: number }) {
  return (
    <StrokeIcon size={size}>
      <circle cx="12" cy="12" r="4" />
      <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
    </StrokeIcon>
  );
}

/** A thread/conversation: two stacked chat bubbles (lucide messages-square). */
export function ThreadIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z" />
      <path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1" />
    </svg>
  );
}
