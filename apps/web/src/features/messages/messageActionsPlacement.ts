/**
 * @cytale/web — where the message hover toolbar renders.
 *
 * The control users call "the message bar" / "the reaction bar" is the message
 * HOVER TOOLBAR: `data-testid="message-actions"`, `.message-actions`, hosted by
 * each row's `message-actions-host`.
 *
 * Config-driven so the two placements can be compared without editing
 * components:
 *
 *   'top-right' — the horizontal pill at the message's own top-right, floating
 *                 over the row's top-right corner. The reference client's
 *                 placement, and the resting default: the vertical rail reads
 *                 as unattached on a one-line message, and a horizontal bar
 *                 leaves room for more controls later (user direction
 *                 2026-09-12, after trying the rail).
 *   'left-rail' — a vertical stack in the gutter left of the message, centred
 *                 in that gutter and on the message, reading top→bottom: the
 *                 rule, reply, copy link, thread, edit, delete, and the react
 *                 emoji LAST. Kept for comparison; flip it with the override
 *                 below.
 *
 * The default lives here; a per-browser override in localStorage flips it
 * (reload to apply — the value is resolved once per boot, so a virtualized
 * list never re-reads storage per row).
 */

export type MessageActionsPlacement = 'top-right' | 'left-rail';

export const MESSAGE_ACTIONS_PLACEMENT_KEY = 'cytale.message-actions-placement';

/** The default placement. */
const DEFAULT_PLACEMENT: MessageActionsPlacement = 'top-right';

function isPlacement(v: unknown): v is MessageActionsPlacement {
  return v === 'top-right' || v === 'left-rail';
}

let cached: MessageActionsPlacement | null = null;

/**
 * The stored override, or null when unset (or unreadable, or not a placement
 * we know). Never cached — `messageActionsPlacement` owns the caching, so
 * this stays directly testable.
 */
export function readStoredPlacement(): MessageActionsPlacement | null {
  try {
    const raw = globalThis.localStorage?.getItem(MESSAGE_ACTIONS_PLACEMENT_KEY);
    return isPlacement(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** The resolved placement (read from storage once per boot, then cached). */
export function messageActionsPlacement(): MessageActionsPlacement {
  if (cached !== null) return cached;
  cached = readStoredPlacement() ?? DEFAULT_PLACEMENT;
  return cached;
}

/** Flip the placement for this browser (next reload picks it up). */
export function setMessageActionsPlacement(placement: MessageActionsPlacement): void {
  cached = placement;
  try {
    globalThis.localStorage?.setItem(MESSAGE_ACTIONS_PLACEMENT_KEY, placement);
  } catch {
    // storage unavailable — the in-memory value still applies for this session
  }
}
