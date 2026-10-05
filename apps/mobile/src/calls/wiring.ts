/**
 * @cytale/mobile — the mobile deps for the portable call engine (media spike,
 * step 2).
 *
 * The RN counterpart of `apps/web/src/features/calls/webWiring.ts`. The engine
 * in `@cytale/calls` is already dependency-injected, so the whole port is the
 * values assembled here:
 *
 *   media            `rnMediaEnv()`                  — react-native-webrtc
 *   captureEnv       `rnCaptureEnv()`                — mic/camera capture
 *   gateway          the session's gateway           — call ops + dispatches
 *   fetchIceServers  `manager.api.getIceServers()`   — GET /calls/ice
 *   store            `@cytale/state`'s defaultStore  — the engine's default
 *
 * `onSignal` is NOT injected: the package's own `onCallSignal` emitter is the
 * same module instance the gateway preprocessor chain dispatches into, so the
 * default is already correct here (see `session.tsx`, which routes CALL_SIGNAL
 * frames through `routeCallSignalEvent`).
 *
 * `monitor` is NOT injected either: speaking detection needs an audio-level
 * meter, which the browser gets from `AudioContext` and react-native-webrtc
 * does not expose. The package's host-neutral `unavailableSpeakingEnv` is
 * therefore the honest default — no speaking rings on mobile. That is a real
 * gap, recorded rather than faked: a level meter is a native-module job.
 */

import type { SessionManager } from '@cytale/session';
import {
  createCallEngine,
  unavailableSpeakingEnv,
  SpeakingMonitor,
  type CallEngine,
  type CallEngineDeps,
  type CallGatewayLike,
} from '@cytale/calls';

import { rnCaptureEnv, rnMediaEnv } from './rnMediaEnv';

/** Build the engine deps against a live session manager. */
export function mobileCallEngineDeps(manager: SessionManager): CallEngineDeps {
  return {
    media: rnMediaEnv(),
    captureEnv: rnCaptureEnv(),
    monitor: new SpeakingMonitor({ env: unavailableSpeakingEnv() }),
    // The engine's `CallGatewayLike` is the structural slice of the gateway it
    // drives; the real client satisfies it at runtime, but `GatewayClient.on` is
    // generic and never structurally matches under `strictFunctionTypes`. Same
    // cast, same reason, as the web wiring.
    gateway: () => manager.getGateway() as unknown as CallGatewayLike | null,
    fetchIceServers: async () => (await manager.api.getIceServers()).ice_servers ?? [],
  };
}

let defaultEngine: CallEngine | null = null;

/**
 * The app-wide call engine, built once against the given session manager.
 *
 * Mobile holds exactly one voice leg, same as web. `destroy()` is the caller's
 * when the session ends; the engine is otherwise a module singleton so a route
 * remount does not tear down a live call.
 */
export function getCallEngine(manager: SessionManager): CallEngine {
  if (!defaultEngine) defaultEngine = createCallEngine(mobileCallEngineDeps(manager));
  return defaultEngine;
}

/** Test seam: substitute the module engine (restored with null). */
export function setCallEngineForTests(engine: CallEngine | null): void {
  defaultEngine = engine;
}
