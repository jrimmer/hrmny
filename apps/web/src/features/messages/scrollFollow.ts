/**
 * @cytale/web — the at-bottom follow decision, shared by every pane.
 *
 * One rule governs all of them (#128 defect 3, and every scroll report before
 * it): **at the bottom means FOLLOW — scrolled up means never drag.** When the
 * reader keeps the newest message in view, anything that moves the live edge
 * (a new row, a taller row) or anything that shrinks the scroll region under
 * them (the composer well stepping down while a typist is live, the reply
 * bar, a banner) must keep the newest message fully visible. The moment the
 * reader scrolls up, the view belongs to them and nothing may yank it back.
 *
 * The decision is split out of the components because it is subtle and was
 * each of these bugs at least once (2026-09-13..15 reports): re-arming on
 * proximity alone yanked readers stopping a notch short of the end; disarming
 * on scroll deltas disarmed the pin while the LIBRARY settled its own scroll;
 * following on every append dragged history readers to the bottom. jsdom has
 * no layout engine, so the components wire DOM events to these pure
 * functions and the unit suite tests the RULE here.
 */

/**
 * How close to the end counts as "reading the newest messages". Wide enough
 * that a residual settling shortfall still reads as pinned, narrow enough
 * that a deliberate scroll-up is never yanked back.
 */
export const AT_BOTTOM_THRESHOLD = 64;

/** The three offsets a scroll position is decided from. */
export interface ScrollOffsets {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** Distance from the scroll end: 0 means pinned to the last row. */
export function distanceFromEnd(el: ScrollOffsets): number {
  return el.scrollHeight - el.clientHeight - el.scrollTop;
}

/**
 * The scroll-event rule: where the reader IS, plus — inside the band — the
 * DIRECTION they last moved.
 *
 * Well away from the end (`distance > AT_BOTTOM_THRESHOLD`) the reader has
 * left: no following. Inside the band, re-arming needs movement toward the
 * end: re-arming on distance alone let a reader who stopped a few px short
 * stay followed even as they wheeled away, and the next live message yanked
 * them back (2026-09-13). Movement toward the end is honest about who moved —
 * the library's own settle always moves TOWARD the end, a scrollbar drag
 * downward re-arms, an upward one does not — and it needs no input events.
 *
 * `landingActive`: a boundary landing (#104/#114) still owns the view while
 * it settles. Its programmatic scrolls are not the reader arriving, so they
 * must not re-arm the follow.
 *
 * Returns the next at-bottom flag.
 */
export function atBottomOnScroll(params: {
  distance: number;
  /** scrollTop before this event, or null when unknown (first event). */
  previousTop: number | null;
  currentTop: number;
  landingActive: boolean;
  currentAtBottom: boolean;
}): boolean {
  if (params.distance > AT_BOTTOM_THRESHOLD) return false;
  const movedTowardEnd =
    params.previousTop === null || params.currentTop >= params.previousTop - 1;
  if (movedTowardEnd && !params.landingActive) return true;
  return params.currentAtBottom;
}

/**
 * The wheel rule: WHEEL IS INTENT; it is not the scroll offset.
 *
 * An upward wheel IS the reader leaving — it disarms at any distance,
 * unconditionally, before any scroll event can misread the situation. A wheel
 * DOWN that lands back inside the band is the reader returning to the live
 * edge and re-arms (measured-from-the-end is not the same as landing ON it;
 * requiring the exact pixel left a reader who stopped a few px short
 * permanently un-followed — 2026-09-14). A wheel down that is still outside
 * the band changes nothing.
 */
export function atBottomOnWheel(params: {
  deltaY: number;
  distance: number;
  currentAtBottom: boolean;
}): boolean {
  if (params.deltaY < 0) return false;
  if (params.distance <= AT_BOTTOM_THRESHOLD) return true;
  return params.currentAtBottom;
}

/**
 * The touch rule: a finger down has no wheel event, so its drag deltas carry
 * the intent — dragging the content DOWN is the reader leaving the end.
 * The first upward pixel disarms, well before the distance band would.
 */
export function atBottomOnTouchDrag(params: {
  currentTop: number;
  previousTop: number | null;
  currentAtBottom: boolean;
}): boolean {
  if (params.previousTop === null) return params.currentAtBottom;
  if (params.currentTop < params.previousTop - 1) return false;
  return params.currentAtBottom;
}
