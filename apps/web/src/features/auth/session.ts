/**
 * U19 — app-level auth session, web composition root (plan 004 M4).
 *
 * The orchestration itself now lives in `@cytale/session` (shared with the
 * native client, KTD4) and is storage-pluggable. This module is the WEB
 * binding: it supplies the localStorage-backed `TokenStorage`, the
 * build-time `configuredOrigin` override, and the two DOM-free dispatch
 * seams (`applyReactionEvent`, `routeCallSignalEvent`) that must keep running
 * BEFORE the shared store dispatcher. Behaviour is unchanged — the U19 web
 * suite is the regression gate for the extraction.
 *
 * Token strategy (unchanged): access token in memory (authStore), refresh
 * token in localStorage (documented XSS tradeoff in authStore.ts). The
 * api-client's Http layer handles 401 → single-flight refresh → one retry
 * automatically via the TokenProvider seam; proactive refresh before expiry is
 * driven by the expiry timestamp.
 */

import { SessionManager, validateServerOrigin } from '@cytale/session';

export { ServerOriginError, validateServerOrigin } from '@cytale/session';
import { applyGatewayEvent, defaultStore } from '@cytale/state';

import { HOSTED_ORIGIN, configuredOrigin } from '../../app/origin.js';
import { routeCallSignalEvent } from '../calls/session-call-signal.js';
import { routeInteractionSuccessFrame } from '../interactions/interactionAnswers.js';
import { applyNotificationSoundEvent } from '../../app/notifications/session-notification-sound.js';
import { applyReactionEvent } from '../messages/reactions.js';
// #88: the client-error seam sits BESIDE the auth error classification, not
// inside it — `authErrors.ts` decides what to SHOW a user, the reporter decides
// what the maintainer gets. This file is the composition root web and the
// desktop shell both boot through, so the api client's failure observation
// (with the server's request id) is wired exactly once, here.
import { clientErrors } from '../observability/clientErrors.js';

import { isTauri } from '../../tauri/index.js';
import { webTokenStorage, type AuthStore } from './authStore.js';
import { tauriTokenStorage } from './tauriTokenStorage.js';

/**
 * The login form's suggested server (desktop shell only — browsers are
 * same-origin): the build's hosted deployment (`VITE_CYTALE_HOSTED_ORIGIN`),
 * or empty in a build that names none, where the user types their server.
 */
export const DEFAULT_SERVER_ORIGIN: string = HOSTED_ORIGIN ?? '';

/**
 * Platform credential storage: the shell keeps the token pair in the OS
 * credential store, the browser keeps its documented localStorage tradeoff.
 */
const tokenStorage = isTauri() ? tauriTokenStorage() : webTokenStorage;

/**
 * #111 rig hook: pin the gateway payload codec via localStorage
 * (`cytale.gateway.compression` = 'zlib_stream' | 'zstd_stream' | 'none').
 * E2e sets 'zlib_stream' to exercise the negotiated zlib fallback end to end
 * — the path a browser WITHOUT native zstd (Safari-class) rides. Any other
 * value (or absent key) keeps the default negotiation untouched. Read once
 * at composition; storage may not exist under non-DOM tooling.
 */
const gatewayCompression = (() => {
  if (typeof localStorage === 'undefined') return undefined;
  const value = localStorage.getItem('cytale.gateway.compression');
  return value === 'zlib_stream' || value === 'zstd_stream' || value === 'none'
    ? value
    : undefined;
})();

/**
 * The desktop shell's login-form server choice (owner direction 2026-09-19:
 * the desktop login carries a server-address field). Persisted by the login
 * page; read here so a restored session reconnects to the server it
 * authenticated against. Browser builds never read it — they are
 * same-origin by construction.
 */
export const SERVER_ORIGIN_KEY = 'cytale.server_origin';

const persistedServerOrigin = (() => {
  if (!isTauri() || typeof localStorage === 'undefined') return undefined;
  const raw = localStorage.getItem(SERVER_ORIGIN_KEY);
  if (raw === null) return undefined;
  try {
    return validateServerOrigin(raw);
  } catch {
    return undefined;
  }
})();

export const session = new SessionManager({
  storage: tokenStorage,
  resolveOrigin: () => persistedServerOrigin ?? configuredOrigin(),
  store: defaultStore,
  gatewayCompression,
  // Every failed call (non-2xx, or a rejected fetch) is offered here with its
  // status and the server's `x-request-id` (#88) — the one place all three
  // clients get the trace handle from.
  onRequestFailure: failure => clientErrors.observeApiFailure(failure),
  // Ordering is load-bearing: reactions reconcile BEFORE applyGatewayEvent so
  // their replay gate (`s <= lastSeq`) sees the pre-dispatch sequence, and
  // CALL_SIGNAL routing stays ahead of the store (its CallSignal case is a
  // deliberate no-op).
  gatewayPreprocessors: [
    (frame, store) => {
      applyReactionEvent(store, frame);
    },
    (frame) => {
      routeCallSignalEvent(frame);
    },
    // The bot answered one of this user's interactions: the pending control
    // resolves (InteractionSuccess is UI state; the store ignores it).
    (frame) => {
      routeInteractionSuccessFrame(frame);
    },
    // The audible half of a notification. Attached HERE rather than in a
    // component so it runs on the same dispatch that produces the badge — a
    // ding from a different signal than the one the member sees is how the two
    // start disagreeing. It self-gates on the member's preference, the channel
    // level, and whether the message is actually for them.
    (frame, store) => {
      applyNotificationSoundEvent(frame, store);
    },
  ],
});

// Dev-only debug handle (2026-09-10): the store has no other reachable
// surface from the console/automation, which made an empty-list regression
// undiagnosable from the page. Gated to dev builds. The gate rides the
// vite `define` (like __CYTALE_VERSION__) rather than import.meta.env
// because this module is typechecked AND executed under non-Vite tools too
// (the mobile parity suite walks this graph) — `typeof` keeps those runs
// calm with the gate simply off.
declare const __CYTALE_DEV__: boolean | undefined;

if (typeof __CYTALE_DEV__ !== 'undefined' && __CYTALE_DEV__) {
  (globalThis as { __cytaleStore?: unknown }).__cytaleStore = defaultStore;
  // Its companion: a gateway dispatch applied through the SAME reconcile the
  // live socket feeds, so a fixture-backed spec can drive MessageCreate /
  // MessageDelete traffic without a server (the store handle alone can only
  // write state, which would bypass the rules under test).
  // InteractionSuccess is routed too: it is UI state that never reaches the
  // store, and the component-click specs drive it through this handle.
  (globalThis as { __cytaleDispatch?: unknown }).__cytaleDispatch = (
    event: Parameters<typeof applyGatewayEvent>[1],
  ) => {
    routeInteractionSuccessFrame(event);
    return applyGatewayEvent(defaultStore, event);
  };
}

export const authStore: AuthStore = session.authStore;
export const api = session.api;
export { SessionManager };
