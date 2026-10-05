/**
 * @cytale/web — call-log boundary tests (calls plan U9, AM11).
 *
 * Interpolation correctness: messages + boundaries interleaved
 * chronologically (chat order, oldest at top), tie-breaking, live-boundary
 * merge/dedupe, and the human reason labels.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { Message } from '@cytale/domain';
import type { EndedCallRecord } from '@cytale/api-client';
import type { LiveCall } from '@cytale/state';

import {
  boundariesFromEnded,
  interleaveCallLog,
  liveStartBoundary,
  mergeBoundaries,
  reasonLabel,
  CallBoundaryRow,
} from '../boundaries.js';

afterEach(() => {
  cleanup();
});

function msg(id: string, at: string): Message {
  return {
    id,
    channel_id: '100',
    thread_id: '500',
    author_id: '200',
    content: `m-${id}`,
    created_at: at,
    edited_at: null,
  };
}

const ENDED: EndedCallRecord[] = [
  {
    call_id: '700',
    started_by: '200',
    started_at: '2026-09-06T10:00:00Z',
    ended_at: '2026-09-06T10:30:00Z',
    reason: 'last_left',
  },
];

describe('interleaveCallLog', () => {
  it('places start/end boundaries around messages sent during the call', () => {
    // Store slice is NEWEST-FIRST (the messagesByThread shape).
    const messages = [
      msg('920', '2026-09-06T10:31:00Z'), // after the call
      msg('915', '2026-09-06T10:05:00Z'), // during the call
      msg('910', '2026-09-06T09:55:00Z'), // before the call
    ];
    const rows = interleaveCallLog(messages, boundariesFromEnded(ENDED));

    expect(rows.map((r) => r.kind)).toEqual([
      'message', // 09:55 before
      'boundary', // 10:00 start
      'message', // 10:05 during
      'boundary', // 10:30 end
      'message', // 10:31 after
    ]);
    expect(rows[3]).toMatchObject({ kind: 'boundary', boundary: { kind: 'end', reason: 'last_left' } });
  });

  it('outputs chat order (oldest first) regardless of input order', () => {
    const rows = interleaveCallLog(
      [msg('920', '2026-09-06T10:31:00Z'), msg('910', '2026-09-06T09:55:00Z')],
      boundariesFromEnded(ENDED),
    );
    const times = rows.map((r) =>
      r.kind === 'message' ? r.message.created_at : r.boundary.at,
    );
    expect(times).toEqual([...times].sort());
  });

  it('keeps a message that ties a boundary timestamp before the boundary (message wins ties)', () => {
    const rows = interleaveCallLog(
      [msg('911', '2026-09-06T10:00:00Z')],
      boundariesFromEnded(ENDED),
    );
    // start (10:00, tie → message first), then the end pair member (10:30).
    expect(rows.map((r) => r.kind)).toEqual(['message', 'boundary', 'boundary']);
  });

  it('renders the live start boundary at the call position with no end row', () => {
    const live: LiveCall = {
      call_id: '800',
      thread_id: '500',
      started_by: '200',
      started_at: '2026-09-06T11:00:00Z',
      participants: {},
    };
    const rows = interleaveCallLog(
      [msg('930', '2026-09-06T11:02:00Z')],
      mergeBoundaries(boundariesFromEnded(ENDED), liveStartBoundary(live)),
    );
    expect(rows.map((r) => r.kind)).toEqual([
      'boundary', // 10:00 ended start
      'boundary', // 10:30 end
      'boundary', // 11:00 LIVE start
      'message',
    ]);
    const liveRow = rows[2];
    expect(liveRow).toMatchObject({ kind: 'boundary', boundary: { kind: 'start', callId: '800' } });
  });

  it('interleaves multiple ended calls in chronological order', () => {
    const records: EndedCallRecord[] = [
      {
        call_id: '710',
        started_by: '200',
        started_at: '2026-09-06T13:00:00Z',
        ended_at: '2026-09-06T13:10:00Z',
        reason: 'swept',
      },
      ...ENDED,
    ];
    const rows = interleaveCallLog([msg('940', '2026-09-06T12:00:00Z')], boundariesFromEnded(records));
    expect(rows.map((r) => (r.kind === 'boundary' ? `${r.boundary.callId}:${r.boundary.kind}` : 'm'))).toEqual([
      '700:start', // 10:00
      '700:end', // 10:30
      'm', // 12:00 — between the two calls
      '710:start', // 13:00
      '710:end', // 13:10
    ]);
  });
});

describe('mergeBoundaries / liveStartBoundary', () => {
  it('drops the live boundary when the same call already ended in the REST list', () => {
    const live: LiveCall = {
      call_id: '700', // same id as ENDED
      thread_id: '500',
      started_by: '200',
      started_at: '2026-09-06T10:00:00Z',
      participants: {},
    };
    const merged = mergeBoundaries(boundariesFromEnded(ENDED), liveStartBoundary(live));
    expect(merged).toHaveLength(2); // only the ended pair, no double start
  });

  it('returns null for a live call without started_at (CALL_SYNC-only roster)', () => {
    const live: LiveCall = {
      call_id: '800',
      thread_id: '500',
      started_by: null,
      started_at: null,
      participants: {},
    };
    expect(liveStartBoundary(live)).toBeNull();
  });
});

describe('reasonLabel + CallBoundaryRow', () => {
  it('maps wire reasons to human labels', () => {
    expect(reasonLabel('last_left')).toBe('last participant left');
    expect(reasonLabel('swept')).toBe('closed by server sweep');
  });

  it('renders start and end rows with labels and metadata', () => {
    render(
      <>
        <CallBoundaryRow boundary={{ kind: 'start', callId: '700', at: '2026-09-06T10:00:00Z' }} />
        <CallBoundaryRow boundary={{ kind: 'end', callId: '700', at: '2026-09-06T10:30:00Z', reason: 'swept' }} />
      </>,
    );

    const start = screen.getByTestId('call-boundary-start');
    expect(start.getAttribute('data-call-id')).toBe('700');
    expect(start.getAttribute('aria-label')).toMatch(/^Call started — \d/);

    const end = screen.getByTestId('call-boundary-end');
    expect(end.textContent).toContain('closed by server sweep');
    expect(end.getAttribute('aria-label')).toContain('Call ended');
  });
});
