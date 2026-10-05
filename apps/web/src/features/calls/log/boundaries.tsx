/**
 * @cytale/web — call-log boundary rows (calls plan U9, AM11).
 *
 * Call start/end boundaries are VIRTUAL ROWS derived from call metadata,
 * never messages (KTD5's no-ALTER corollary): a live call's started_at
 * comes from the store's LiveCall slice (CALL_START/CALL_SYNC hydrate it),
 * ended calls from `GET /channels/{id}/call`'s bounded `recently_ended`
 * list. `interleaveCallLog` merges them with the standing thread's message
 * history at the right chronological position (oldest at top, chat order —
 * the MessageList reading order, not the store's newest-first slice order).
 *
 * Reason labels (R8): `last_left` is the idle sweep after the last
 * participant left; `swept` is boot/crash-recovery cleanup.
 */

import type { Message } from '@cytale/domain';
import type { EndedCallRecord } from '@cytale/api-client';
import { formatClockPadded } from '../../../app/ui/time.js';
import type { LiveCall } from '@cytale/state';

/** Why a call ended, human-readable (mapped from the wire reasons). */
export function reasonLabel(reason: EndedCallRecord['reason']): string {
  switch (reason) {
    case 'last_left':
      return 'last participant left';
    case 'swept':
      return 'closed by server sweep';
  }
}

/** One virtual boundary row (AM11). */
export interface CallBoundary {
  kind: 'start' | 'end';
  /** The call this boundary belongs to (dedupe key). */
  callId: string;
  /** ISO timestamp of the boundary. */
  at: string;
  /** End rows carry the reason; start rows omit it. */
  reason?: EndedCallRecord['reason'];
}

/** Start + end boundaries for one recently-ended call. */
export function boundariesFromEnded(records: EndedCallRecord[]): CallBoundary[] {
  const out: CallBoundary[] = [];
  for (const r of records) {
    out.push({ kind: 'start', callId: r.call_id, at: r.started_at });
    out.push({ kind: 'end', callId: r.call_id, at: r.ended_at, reason: r.reason });
  }
  return out;
}

/**
 * The live call's start boundary from the store's LiveCall — null when the
 * slice has no started_at yet (a CALL_SYNC-only roster carries no boundary
 * metadata; REST or the next CALL_START fills it).
 */
export function liveStartBoundary(call: LiveCall): CallBoundary | null {
  if (call.started_at === null) return null;
  return { kind: 'start', callId: call.call_id, at: call.started_at };
}

/**
 * Merge ended boundaries with the live call's start boundary. The live
 * boundary is dropped when the same call already appears in the ended list
 * (a CALL_END racing a stale REST page must not double-render the start).
 */
export function mergeBoundaries(
  ended: CallBoundary[],
  live: CallBoundary | null,
): CallBoundary[] {
  if (live === null) return ended;
  if (ended.some((b) => b.callId === live.callId)) return ended;
  return [...ended, live];
}

/** One row of the interleaved call log (a message or a boundary). */
export type CallLogRow =
  | { kind: 'message'; message: Message }
  | { kind: 'boundary'; boundary: CallBoundary };

/**
 * Interleave boundaries among messages chronologically.
 *
 * Input `messages` is the store's newest-first thread slice (the
 * `messagesByThread` shape); the output is chat order (oldest at top). A
 * boundary renders before the first row strictly newer than it — on an
 * exact timestamp tie the message wins, so a message sent at the very
 * moment a call started reads as in-call chatter (and one sent as the call
 * ended reads as during-call), which is the honest reading either way.
 */
export function interleaveCallLog(messages: Message[], boundaries: CallBoundary[]): CallLogRow[] {
  const rows: CallLogRow[] = [...messages]
    .reverse() // store slice is newest-first; chat order is oldest-first
    .map((message) => ({ kind: 'message' as const, message }));
  const sorted = [...boundaries].sort((a, b) => timeOf(a.at) - timeOf(b.at));
  for (const boundary of sorted) {
    const at = timeOf(boundary.at);
    let i = 0;
    while (i < rows.length && timeOf(rowTime(rows[i]!)) <= at) i++;
    rows.splice(i, 0, { kind: 'boundary', boundary });
  }
  return rows;
}

function rowTime(row: CallLogRow): string {
  return row.kind === 'message' ? row.message.created_at : row.boundary.at;
}

/** Timestamp coercion: unparseable stamps sort as epoch 0 (deterministic). */
function timeOf(iso: string): number {
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** The row's time the way message rows render theirs (locale 2-digit). */
export function formatBoundaryTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return formatClockPadded(iso);
}

// ---------------------------------------------------------------------------
// The row (system-row style — the DateDivider idiom: hairlines + label)
// ---------------------------------------------------------------------------

export function CallBoundaryRow({ boundary }: { boundary: CallBoundary }) {
  const time = formatBoundaryTime(boundary.at);
  const label =
    boundary.kind === 'start'
      ? `Call started — ${time}`
      : `Call ended — ${time} (${reasonLabel(boundary.reason ?? 'last_left')})`;
  return (
    <div
      className="mx-2 my-2 flex items-center gap-2"
      role="separator"
      aria-label={label}
      data-testid={boundary.kind === 'start' ? 'call-boundary-start' : 'call-boundary-end'}
      data-call-id={boundary.callId}
      data-at={boundary.at}
    >
      <span className="h-px flex-1 bg-line" aria-hidden />
      <span className="flex items-center gap-1.5 text-xs font-medium text-text-muted">
        <span aria-hidden className="text-text-muted">
          📞
        </span>
        {label}
      </span>
      <span className="h-px flex-1 bg-line" aria-hidden />
    </div>
  );
}
