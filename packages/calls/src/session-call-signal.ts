/**
 * @cytale/web — CALL_SIGNAL pre-processing seam (calls plan U8).
 *
 * Media signaling never enters the store: `reconcile.ts` treats CallSignal
 * as a deliberate no-op and routes consumers here instead (the reactions.ts
 * precedent — a structural frame check inside session.ts's onAny chain that
 * starts working the moment the frames flow). The room (sole offerer, U5)
 * pushes SDP offers and ICE candidates to each participant as user-keyed
 * CallSignal dispatches; the ACTIVE media controller consumes them through
 * the module-level subscription below.
 *
 * Why an emitter and not the store (binding): signaling bodies are
 * ephemeral, single-recipient, and meaningless after the negotiation they
 * belong to — a resumed client awaits fresh state (CALL_SYNC + the room's
 * re-offer) rather than replaying stale descriptions. Sequence dedupe is
 * already owned by the gateway client's dispatch pipeline (duplicates drop
 * before any listener runs), so this seam adds no replay gate of its own;
 * the controller's negotiation state is the second line of defense.
 *
 * The frame check is STRUCTURAL (untrusted dispatch frames, same contract
 * as reactions.ts): op 0 + t === 'CallSignal' + string channel_id + string
 * body. Unknown frames stay accepted no-ops.
 */

/** One routed CallSignal dispatch (already channel-scoped). */
export interface CallSignalFrame {
  channel_id: string;
  /** Opaque signaling blob — self-describing JSON (SDP or ICE candidate). */
  body: string;
}

type CallSignalListener = (frame: CallSignalFrame) => void;

const listeners = new Set<CallSignalListener>();

/** Subscribe to routed CallSignal frames; returns an unsubscribe function. */
export function onCallSignal(listener: CallSignalListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Deliver one frame to every subscriber (module-internal + tests). */
export function emitCallSignal(frame: CallSignalFrame): void {
  for (const listener of [...listeners]) {
    try {
      listener(frame);
    } catch {
      // A broken consumer never breaks the dispatch chain (safeInvoke
      // precedent from the gateway client).
    }
  }
}

/** A gateway dispatch frame, viewed structurally (untrusted). */
interface DispatchFrame {
  op: number;
  t: string;
  s: number;
  d: unknown;
}

function isDispatchFrame(value: unknown): value is DispatchFrame {
  if (typeof value !== 'object' || value === null) return false;
  const f = value as Record<string, unknown>;
  return f.op === 0 && typeof f.t === 'string' && typeof f.s === 'number' && 'd' in f;
}

function isCallSignalPayload(d: unknown): d is { channel_id: string; body: string } {
  if (typeof d !== 'object' || d === null) return false;
  const p = d as Record<string, unknown>;
  return typeof p.channel_id === 'string' && typeof p.body === 'string';
}

/**
 * Route one gateway dispatch frame's CallSignal effects to the active media
 * controller. Returns true when the frame was a CallSignal dispatch;
 * every other frame is an accepted no-op (false), so the caller can pipe
 * the full dispatch stream through unfiltered — the same contract as
 * `applyReactionEvent`.
 */
export function routeCallSignalEvent(frame: unknown): boolean {
  if (!isDispatchFrame(frame) || frame.t !== 'CallSignal') return false;
  if (!isCallSignalPayload(frame.d)) return false;
  emitCallSignal({ channel_id: frame.d.channel_id, body: frame.d.body });
  return true;
}
