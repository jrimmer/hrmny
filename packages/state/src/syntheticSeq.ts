/**
 * @cytale/state — the synthetic sequence space (hardening 6.8).
 *
 * Local REST reconciles (thread history loads, thread sends, message
 * edits/removes, avatar convergence) re-enter the store through
 * `applyGatewayEvent`. The dispatcher classifies seqs ABOVE
 * `SYNTHETIC_SEQ_FLOOR` as synthetic-space events: they always apply and never
 * advance `lastSeq` (#143) — so they can neither be dropped by the replay gate
 * nor poison it against the real stream (whose per-session seqs count up from
 * 1).
 *
 * THE FLOOR AND THE ALLOCATOR SHARE THIS MODULE. The gate that classifies a
 * stamp and the allocator that mints one read the same binding from the same
 * file, so they cannot drift. A mirrored floor beside a counter in another
 * package (apps/web used to keep both) is exactly the bug this ownership
 * removes: two numbers that must agree, owned by two packages.
 */

/**
 * Floor of the synthetic seq space. Stamps are FLOOR + 1, FLOOR + 2, … Real
 * gateway dispatches live far below it: the server numbers them per session
 * from 1 (Cytale.Gateway.Session.buffer_event), and READY/RESUMED are
 * sequence-less control frames (s: 0).
 */
export const SYNTHETIC_SEQ_FLOOR = 1_000_000;

/** The one cursor, seeded AT the floor so the first stamp is FLOOR + 1. */
let localSeq = SYNTHETIC_SEQ_FLOOR;

/**
 * Next synthetic sequence number — always strictly above the floor and always
 * increasing. ONE counter for the whole client: per-module counters collide
 * (module B's first stamp landing below module A's last would break the
 * synthetic space's own ordering), so this is the only writer of the space.
 */
export function nextSyntheticSeq(): number {
  return ++localSeq;
}
