/**
 * Deep-link intent store (plan 004 M12). The contract the replay depends on:
 * one intent at a time, consumed exactly once, never the app's default
 * surface, and cleared on sign-out.
 */
import {
  capturePendingRoute,
  clearPendingRoute,
  clearPendingRouteOnSignOut,
  peekPendingRoute,
  takePendingRoute,
} from '../pendingRoute';

beforeEach(clearPendingRoute);
afterEach(clearPendingRoute);

describe('pending deep links', () => {
  it('captures an intent and peeks at it without consuming it', () => {
    capturePendingRoute('/channel/7');
    expect(peekPendingRoute()).toEqual({ href: '/channel/7' });
    expect(peekPendingRoute()).toEqual({ href: '/channel/7' });
  });

  it('consumes an intent exactly once', () => {
    capturePendingRoute('/thread/9');
    expect(takePendingRoute()).toEqual({ href: '/thread/9' });
    expect(takePendingRoute()).toBeNull();
    expect(peekPendingRoute()).toBeNull();
  });

  it('ignores the default surface — there is nothing to resume', () => {
    capturePendingRoute('/');
    capturePendingRoute('');
    expect(peekPendingRoute()).toBeNull();
  });

  it('keeps the last link when a second arrives before the replay', () => {
    capturePendingRoute('/channel/1');
    capturePendingRoute('/channel/2');
    expect(takePendingRoute()).toEqual({ href: '/channel/2' });
  });

  it('clears on sign-out', () => {
    capturePendingRoute('/channel/1');
    clearPendingRoute();
    expect(takePendingRoute()).toBeNull();
  });
});

describe('deliberate sign-out', () => {
  it('drops the queued intent and the surface the gate re-captures', () => {
    capturePendingRoute('/channel/7');

    clearPendingRouteOnSignOut();

    expect(peekPendingRoute()).toBeNull();
    // The gate renders signed out at the surface being left BEFORE it
    // redirects to /sign-in, and captures it on every re-render. Neither
    // capture is an intent.
    capturePendingRoute('/settings');
    capturePendingRoute('/settings');
    expect(peekPendingRoute()).toBeNull();
  });

  it('still captures a deep link opened later while signed out', () => {
    clearPendingRouteOnSignOut();
    capturePendingRoute('/settings'); // the gate's capture of the surface left

    capturePendingRoute('/channel/7');

    expect(takePendingRoute()).toEqual({ href: '/channel/7' });
  });

  it('forgets the abandoned surface once the intent is consumed', () => {
    clearPendingRouteOnSignOut();
    capturePendingRoute('/settings');

    takePendingRoute(); // the member is back in the app

    capturePendingRoute('/settings');
    expect(peekPendingRoute()).toEqual({ href: '/settings' });
  });

  it('clearPendingRoute() resets the sign-out bookkeeping too', () => {
    clearPendingRouteOnSignOut();

    clearPendingRoute(); // test hygiene between cases

    capturePendingRoute('/channel/7');
    expect(peekPendingRoute()).toEqual({ href: '/channel/7' });
  });
});
