/**
 * Tier 3 #6 — composer drafts are keyed by the signed-in member, nothing is
 * stored with nobody signed in, and sign-out's purge removes every draft key
 * (per-member and the pre-per-member legacy shape) and nothing else.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { clearAllDrafts, draftKey, readDraft, writeDraft } from '../draftStorage.js';

afterEach(() => localStorage.clear());

describe('draftStorage', () => {
  it('keys by member and scope', () => {
    expect(draftKey('7', 'C1')).toBe('cytale.draft.7.C1');
    expect(draftKey('7', 'C1.t.T1')).toBe('cytale.draft.7.C1.t.T1');
    expect(draftKey(null, 'C1')).toBeNull();
    expect(draftKey('', 'C1')).toBeNull();
  });

  it("one member never reads another's draft for the same channel", () => {
    writeDraft('7', 'C1', 'alice text');
    expect(readDraft('7', 'C1')).toBe('alice text');
    expect(readDraft('8', 'C1')).toBe('');
  });

  it('nothing is written or read with nobody signed in', () => {
    writeDraft(null, 'C1', 'anon');
    expect(localStorage.length).toBe(0);
    localStorage.setItem('cytale.draft.C1', 'legacy');
    expect(readDraft(null, 'C1')).toBe('');
  });

  it('an empty draft removes the key', () => {
    writeDraft('7', 'C1', 'x');
    writeDraft('7', 'C1', '');
    expect(localStorage.getItem('cytale.draft.7.C1')).toBeNull();
  });

  it('clearAllDrafts removes every draft key and leaves the rest', () => {
    writeDraft('7', 'C1', 'a');
    writeDraft('8', 'C2.t.T', 'b');
    localStorage.setItem('cytale.draft.C3', 'legacy');
    localStorage.setItem('cytale.last_user', '7');
    clearAllDrafts();
    expect(Object.keys({ ...localStorage }).filter((k) => k.startsWith('cytale.draft.'))).toEqual([]);
    expect(localStorage.getItem('cytale.draft.7.C1')).toBeNull();
    expect(localStorage.getItem('cytale.draft.C3')).toBeNull();
    expect(localStorage.getItem('cytale.last_user')).toBe('7');
  });
});
