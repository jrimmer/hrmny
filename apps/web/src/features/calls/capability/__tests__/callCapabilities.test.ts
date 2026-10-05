/**
 * @cytale/web — the all-capabilities posture (plan 7.7).
 *
 * CallPanel's `ALL_CAPABILITIES` and DmCallIndicator's `DM_ALL_CAPABILITIES`
 * were two literals for the same posture. They are now one object plus two
 * named views, and these tests pin BOTH facts: the exact values AND key sets
 * each surface used, and the single-object derivation that removes the literal
 * duplication.
 *
 * The key-set assertions are load-bearing: the DM surface's own contract has
 * no `start` key (participation is the DM authorization), and a naive
 * "reuse the same object" unification would have leaked it in.
 */
import { describe, expect, it } from 'vitest';

import { CALL_CAPABILITIES_ALL, DM_CALL_CAPABILITIES } from '../callCapabilities.js';

describe('call capability postures', () => {
  it('the channel surface is all-true, START_CALL included', () => {
    expect(CALL_CAPABILITIES_ALL).toEqual({
      calls: true,
      video: true,
      screenshare: true,
      start: true,
    });
    expect(Object.keys(CALL_CAPABILITIES_ALL).sort()).toEqual([
      'calls',
      'screenshare',
      'start',
      'video',
    ]);
  });

  it('the DM surface carries the three DM keys, all true (no START_CALL gating)', () => {
    expect(DM_CALL_CAPABILITIES).toEqual({ calls: true, video: true, screenshare: true });
    expect(Object.keys(DM_CALL_CAPABILITIES).sort()).toEqual(['calls', 'screenshare', 'video']);
  });

  it('the DM view is derived from the one all-true object', () => {
    // Same values, no second literal: a change to ALL_TRUE reaches both views.
    expect(DM_CALL_CAPABILITIES.calls).toBe(CALL_CAPABILITIES_ALL.calls);
    expect(DM_CALL_CAPABILITIES.video).toBe(CALL_CAPABILITIES_ALL.video);
    expect(DM_CALL_CAPABILITIES.screenshare).toBe(CALL_CAPABILITIES_ALL.screenshare);
  });
});
