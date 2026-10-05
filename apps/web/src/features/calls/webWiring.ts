/**
 * @cytale/web — the web deps for the portable call engine (media spike step 1).
 *
 * The engine moved to `@cytale/calls` (plan: the media spike's enabling
 * refactor). Everything in that package is host-neutral; the four defaults
 * that made it *this app's* engine stayed here, because each one is a web
 * fact rather than an engine fact:
 *
 *   media            `browserMediaEnv()`            — document/RTCPeerConnection
 *   monitor          `browserSpeakingEnv()`         — AudioContext
 *   captureEnv       `browserCaptureEnv()`          — navigator.mediaDevices
 *   gateway          `() => session.getGateway()`   — the session singleton
 *   fetchIceServers  `defaultFetchIceServers()`     — the session api (GET
 *                                                     /calls/ice)
 *
 * `onSignal` is the deliberate exception: the engine's own default
 * (`onCallSignal`, the package's CALL_SIGNAL emitter) is host-neutral, and
 * it is the SAME module instance the web app dispatches into — session.ts
 * imports `routeCallSignalEvent` from the re-export shim at
 * `features/calls/session-call-signal.ts`, which points at the package. So
 * the subscription needs no web binding and could not have drifted.
 *
 * This module is the ONLY place that builds engine deps for web callers: the
 * app-wide singleton below, and anything that constructs its own engine.
 */

import {
  SpeakingMonitor,
  createCallEngine,
  type CallEngine,
  type CallEngineDeps,
  type CallGatewayLike,
  type RTCIceServerLike,
} from '@cytale/calls';

import { api, session } from '../auth/session.js';

import { browserCaptureEnv, browserMediaEnv, browserSpeakingEnv } from './browserEnv.js';

/** The default ICE-config fetch: GET /calls/ice through the session api. */
async function defaultFetchIceServers(): Promise<RTCIceServerLike[]> {
  const res = await api.getIceServers();
  return res.ice_servers ?? [];
}

/**
 * The web engine deps: the same five values `createCallEngine()` used to
 * default to internally, now injected explicitly.
 *
 * `gateway` is the one member that needs a cast. The package's
 * `CallGatewayLike` declares its handler as `(p: never) => void`
 * (contravariance bottom, so platform-free fakes fit) while `GatewayClient.on`
 * is generic over the event name — structurally the two do not line up under
 * `strictFunctionTypes`. The pre-extraction engine rode that gap through
 * `deps.gateway ?? (() => session.getGateway())`, which TS does not
 * contextually type, so no one noticed; the runtime contract (the three call
 * dispatches) is exactly what the engine exercises, and this is the one place
 * that records it.
 */
export function webCallEngineDeps(): CallEngineDeps {
  return {
    media: browserMediaEnv(),
    monitor: new SpeakingMonitor({ env: browserSpeakingEnv() }),
    gateway: () => session.getGateway() as unknown as CallGatewayLike | null,
    fetchIceServers: defaultFetchIceServers,
    captureEnv: browserCaptureEnv(),
  };
}

// ---------------------------------------------------------------------------
// Module default engine (the SPA holds exactly one voice leg)
// ---------------------------------------------------------------------------

let defaultEngine: CallEngine | null = null;
let engineOverride: CallEngine | null = null;

/** The app-wide call engine (lazily built against the web deps). */
export function getCallEngine(): CallEngine {
  if (engineOverride) return engineOverride;
  if (!defaultEngine) defaultEngine = createCallEngine(webCallEngineDeps());
  return defaultEngine;
}

/** Test seam: substitute the module engine (restored with null). */
export function setCallEngineForTests(engine: CallEngine | null): void {
  engineOverride = engine;
}
