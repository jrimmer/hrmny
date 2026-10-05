/**
 * Lane D #3 — the last location is remembered per user, and bad or foreign
 * storage never breaks a boot.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { readLastLocation, readLastUserId, writeLastLocation, writeLastUserId } from '../lastLocation.js';

afterEach(() => {
  localStorage.clear();
});

describe('last location', () => {
  it('round-trips per user, and never hands one member another\'s location', () => {
    writeLastLocation('111', { home: false, workspaceId: '222', channelId: '333' });
    expect(readLastLocation('111')).toEqual({ home: false, workspaceId: '222', channelId: '333' });
    expect(readLastLocation('999')).toBeNull();
    expect(readLastLocation(null)).toBeNull();
  });

  it('drops malformed values instead of trusting them', () => {
    localStorage.setItem('cytale.last-location.111', '{"home":true,"workspaceId":"<script>","channelId":5}');
    expect(readLastLocation('111')).toEqual({ home: true, workspaceId: null, channelId: null });
    localStorage.setItem('cytale.last-location.111', 'not json');
    expect(readLastLocation('111')).toBeNull();
  });

  it('remembers the last signed-in user id (and forgets it on sign-out)', () => {
    writeLastUserId('4242');
    expect(readLastUserId()).toBe('4242');
    writeLastUserId(null);
    expect(readLastUserId()).toBeNull();
  });
});
