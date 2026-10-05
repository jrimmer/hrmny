/**
 * @cytale/calls — public API (media spike step 1).
 *
 * The call/media engine, extracted from apps/web so every platform client can
 * own the same negotiation, manifest attribution, adaptive budget, publish
 * lifecycle and voice state machine:
 *
 *   apps/web      — `browserEnv.ts` (the browser's `MediaEnv`/`CaptureEnv`/
 *                   `SpeakingEnv`) + `webWiring.ts` (the session defaults and
 *                   the app-wide engine singleton)
 *   apps/mobile   — `rnMediaEnv.ts` (react-native-webrtc), in progress
 *
 * NOTHING here touches a platform global: capture, playback, the peer
 * connection, WebAudio and the gateway are all injected through
 * `CallEngineDeps`, and the package's own defaults are the honest
 * "unavailable" fallbacks in platform.ts. That is what makes the engine
 * portable — and what the grep in the spike's verification step pins.
 *
 * React is deliberately NOT a dependency: the engine is plain TypeScript
 * (classes + subscribe/getSnapshot), and the React bindings (`useCall`,
 * `useSpeakingSet`) live with the React client that owns them.
 */

export * from './manifest.js';
export * from './platform.js';
export * from './session-call-signal.js';
export * from './speaking.js';
export * from './useAdaptiveBudget.js';
export * from './useCallMedia.js';
export * from './usePublish.js';
export * from './voiceState.js';
