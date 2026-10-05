/**
 * @cytale/mobile — `@cytale/session` resolves and executes under jest-expo
 * (plan 004 M4).
 *
 * The session package is the first shared package the native app imports for
 * BEHAVIOUR (the M2 harness covers the others); its NodeNext `.js` specifiers
 * and its `zustand` dependency must resolve under jest exactly as Metro will
 * resolve them for the app. A failure here is the `.js`-specifier class of
 * problem the M1/M2 resolver shims exist to prevent.
 */
import { createAuthStore, createMemoryTokenStorage, createSessionManager } from '@cytale/session';

describe('@cytale/session under jest-expo', () => {
  it('exposes the store, storage adapter, and session factory', () => {
    expect(typeof createSessionManager).toBe('function');

    const storage = createMemoryTokenStorage();
    const store = createAuthStore(storage);
    store.getState().updateTokens('access-1', 'refresh-1', 900);

    expect(store.getState().getRefreshToken()).toBe('refresh-1');
    expect(storage.read()).toEqual({ accessToken: 'access-1', refreshToken: 'refresh-1' });
  });
});
