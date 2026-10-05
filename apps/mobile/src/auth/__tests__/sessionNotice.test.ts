/**
 * Session-loss notice (plan 004 M12, R6). `watchSessionLoss` drives a REAL
 * `SessionManager` — the transition and the manager's own reason string are
 * what the sign-in screen renders, so they are asserted here without a React
 * tree.
 */
import { createMemoryTokenStorage, createSessionManager } from '@cytale/session';

import {
  DEFAULT_SIGNED_OUT_MESSAGE,
  SESSION_EXPIRED_MESSAGE,
  getSessionNotice,
  resetSessionNotice,
  watchSessionLoss,
} from '../sessionNotice';
import { capturePendingRoute, clearPendingRoute, peekPendingRoute } from '../pendingRoute';
import { isVerificationGateDismissed, markFreshSignIn, resetVerificationGate } from '../verificationGate';
import { installWire, VERIFIED_USER } from './support';

function signedInManager() {
  const manager = createSessionManager({
    storage: createMemoryTokenStorage({ accessToken: 'access-1', refreshToken: 'refresh-1' }),
    createGatewayClient: () =>
      ({ connect: async () => undefined, disconnect: () => undefined, destroy: () => undefined }) as never,
  });
  manager.authStore
    .getState()
    .setAuthenticated({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 900 }, VERIFIED_USER);
  return manager;
}

let teardown: (() => void) | null = null;
let wire: ReturnType<typeof installWire> | null = null;

beforeEach(() => {
  resetSessionNotice();
  resetVerificationGate();
  clearPendingRoute();
  // logout() revokes server-side; the wire answers it and records the call.
  wire = installWire([]);
});

afterEach(() => {
  teardown?.();
  teardown = null;
  wire?.restore();
  wire = null;
  resetSessionNotice();
  resetVerificationGate();
  clearPendingRoute();
});

describe('session loss', () => {
  it('explains a deliberate sign-out with the neutral message', async () => {
    const manager = signedInManager();
    teardown = watchSessionLoss(manager);

    await manager.logout();

    expect(getSessionNotice()?.message).toBe(DEFAULT_SIGNED_OUT_MESSAGE);
  });

  it('keeps the manager\u2019s own reason (sign-out everywhere)', async () => {
    const manager = signedInManager();
    teardown = watchSessionLoss(manager);

    await manager.logout('You were signed out on all devices.');

    expect(getSessionNotice()?.message).toBe('You were signed out on all devices.');
  });

  it('reports an expired credential when the store resets without a logout', () => {
    const manager = signedInManager();
    teardown = watchSessionLoss(manager);

    // What refreshTokens() does when the refresh token is rejected.
    manager.authStore.getState().reset();

    expect(getSessionNotice()?.message).toBe(SESSION_EXPIRED_MESSAGE);
  });

  it('stays quiet on a cold launch and clears on the next live session', async () => {
    const manager = signedInManager();
    teardown = watchSessionLoss(manager);

    expect(getSessionNotice()).toBeNull();

    await manager.logout('Session over.');
    expect(getSessionNotice()).not.toBeNull();

    manager.authStore
      .getState()
      .setAuthenticated({ access_token: 'a2', refresh_token: 'r2', expires_in: 900 }, VERIFIED_USER);
    expect(getSessionNotice()).toBeNull();
  });

  it('resets the verification gate so a later sign-in sees it again', async () => {
    const manager = signedInManager();
    teardown = watchSessionLoss(manager);
    markFreshSignIn();
    expect(isVerificationGateDismissed()).toBe(false);

    await manager.logout();

    // freshSignIn is cleared too: the next sign-in marks it again.
    expect(isVerificationGateDismissed()).toBe(false);
  });
});

describe('queued deep links', () => {
  it('drops the queued route on a deliberate sign-out', async () => {
    const manager = signedInManager();
    teardown = watchSessionLoss(manager);
    capturePendingRoute('/thread/9');

    // The settings row's Log out calls exactly this.
    await manager.logout();

    expect(peekPendingRoute()).toBeNull();
    // The gate renders signed out at the surface being left before it
    // redirects, and captures it — that capture must not be the next
    // sign-in's destination.
    capturePendingRoute('/settings');
    expect(peekPendingRoute()).toBeNull();
  });

  it('drops the queued route on sign-out everywhere (a reason, still deliberate)', async () => {
    const manager = signedInManager();
    teardown = watchSessionLoss(manager);
    capturePendingRoute('/thread/9');

    await manager.logout('You were signed out on all devices.');

    expect(peekPendingRoute()).toBeNull();
  });

  it('keeps the queued route when the credential expires without a logout', () => {
    const manager = signedInManager();
    teardown = watchSessionLoss(manager);
    capturePendingRoute('/thread/9');

    // What refreshTokens() does when the refresh token is rejected.
    manager.authStore.getState().reset();

    expect(peekPendingRoute()).toEqual({ href: '/thread/9' });
  });

  it('keeps the queued route when the api layer hard-logs-out an expired session', async () => {
    const manager = signedInManager();
    teardown = watchSessionLoss(manager);
    capturePendingRoute('/thread/9');

    // The manager's api `onLogout`: the credential died, the member did not
    // choose to leave, so re-auth resumes where they were.
    await manager.logout(SESSION_EXPIRED_MESSAGE);

    expect(peekPendingRoute()).toEqual({ href: '/thread/9' });
  });

  it('keeps the queued route when a failed sign-in cleans itself up', async () => {
    // `#acceptTokens` hard-logs-out when `/users/@me` fails; the store was
    // never authenticated, so this is not a member-initiated sign-out.
    const manager = createSessionManager({
      storage: createMemoryTokenStorage({ accessToken: 'access-1', refreshToken: 'refresh-1' }),
      createGatewayClient: () =>
        ({ connect: async () => undefined, disconnect: () => undefined, destroy: () => undefined }) as never,
    });
    teardown = watchSessionLoss(manager);
    capturePendingRoute('/thread/9');

    await manager.logout();

    expect(peekPendingRoute()).toEqual({ href: '/thread/9' });
  });
});
