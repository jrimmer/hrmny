/**
 * @cytale/web — re-export shim for the extracted call/media engine.
 *
 * The engine itself now lives in `@cytale/calls` (the media spike's enabling
 * refactor: one engine, both clients). This module keeps the web import path
 * stable — every call surface and call test still imports
 * `./useCallMedia.js` — and re-exports only what the web build owns on top
 * of the package:
 *
 *   `browserMediaEnv()`   the browser's MediaEnv (browserEnv.ts)
 *   `getCallEngine()`     the app-wide engine, built from webCallEngineDeps
 *   `setCallEngineForTests()`  its test seam
 *   `webCallEngineDeps()` the deps object (webWiring.ts)
 */

export {
  applyDtxToAnswerSdp,
  audioMlineInfo,
  configureIce,
  createCallEngine,
  currentIceServers,
  normalizeIceBody,
  type AdaptiveBudgetFactory,
  type AdaptiveBudgetHooks,
  type AudioMlineInfo,
  type CallEngine,
  type CallEngineDeps,
  type CallEngineSnapshot,
  type CallGatewayLike,
  type IceCandidateInitLike,
  type MediaEnv,
  type MediaStreamLike,
  type MediaTrackLike,
  type PeerConnectionLike,
  type PlaybackHandle,
  type RTCIceServerLike,
  type RtpDescriptionLike,
  type RtpSenderLike,
  type RtpTransceiverLike,
} from '@cytale/calls';

export { browserMediaEnv } from './browserEnv.js';
export { getCallEngine, setCallEngineForTests, webCallEngineDeps } from './webWiring.js';
