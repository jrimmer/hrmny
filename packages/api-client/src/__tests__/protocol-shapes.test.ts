/**
 * @cytale/api-client — REST call shapes vs the wire protocol (hardening 6.5).
 *
 * The REST call surface used to re-declare the protocol roster locally as
 * `CallRosterMember` (three fields) instead of importing `CallParticipant`, so
 * the V2 `sources` list was invisible to every TypeScript consumer of
 * `GET /channels/{id}/call` even though the JSON carried it.
 *
 * The assertions below are COMPILE-TIME: `npx tsc --noEmit` is the gate
 * (`vitest run` transpiles without typechecking). `Equal` is deliberate
 * structural IDENTITY, not assignability — `{ user_id, mute, deafen }` and
 * `{ user_id, mute, deafen, sources? }` are mutually assignable, so a
 * one-directional `const _x: CallParticipant[] = roster` would NOT catch the
 * dropped OPTIONAL field; identity does. Any drift resolves `Assert<...>` to
 * `false` and fails the build with TS2344 naming the assertion that broke.
 */
import { describe, expect, it } from 'vitest';

import type { CallEndReason, CallParticipant } from '@cytale/protocol';
import type { EndedCallRecord, LiveCallState } from '../types.js';

/** Structural identity (distinguishes an absent optional key from a present one). */
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
  ? true
  : false;

/** Resolves to its argument; `false` fails the constraint `true` (TS2344). */
type Assert<T extends true> = T;

// ---------------------------------------------------------------------------
// The assertions — one per REST shape that mirrors a protocol type
// ---------------------------------------------------------------------------

/**
 * `live.participants` IS protocol's `CallParticipant[]` — the same type
 * CALL_SYNC dispatches. Re-declaring the roster here (the old
 * `CallRosterMember` shadow, i.e. dropping `sources`) fails this line.
 */
type _RosterIsProtocolRoster = Assert<Equal<LiveCallState['participants'], CallParticipant[]>>;

/**
 * The V2 `sources` key exists on the REST roster element exactly as protocol
 * declares it. This pins the OPPOSITE drift direction from the assertion
 * above: if protocol itself drops (or renames) `sources`, indexing it is a
 * TS2339 here — adding a new optional protocol field, by contrast, stays
 * green because both sides are the same imported type.
 */
type _RosterCarriesSources = Assert<
  Equal<LiveCallState['participants'][number]['sources'], CallParticipant['sources']>
>;

/**
 * `recently_ended[].reason` IS protocol's `CallEndReason` (`last_left` |
 * `swept`) — the server's `CALL_END_REASONS` — so the two can never list
 * different reasons.
 */
type _EndedReasonIsProtocolReason = Assert<Equal<EndedCallRecord['reason'], CallEndReason>>;

describe('REST call shapes mirror @cytale/protocol (hardening 6.5)', () => {
  it('keeps the V2 source roster on a REST read', () => {
    const participants: LiveCallState['participants'] = [
      {
        user_id: '200000000000000001',
        mute: false,
        deafen: false,
        sources: [{ source: 'camera', since: '2026-09-06T12:00:00.000Z' }],
      },
    ];
    expect(participants[0]!.sources?.[0]!.source).toBe('camera');
  });

  it('keeps the protocol end reasons on a boundary row', () => {
    const reasons: EndedCallRecord['reason'][] = ['last_left', 'swept'];
    expect(reasons).toHaveLength(2);
  });

  it('types a source-less participant as audio-only (sources elided)', () => {
    const participants: LiveCallState['participants'] = [
      { user_id: '200000000000000002', mute: true, deafen: true },
    ];
    expect(participants[0]!.sources).toBeUndefined();
  });
});
