/**
 * @cytale/web — re-export shim for the extracted publish engine.
 *
 * The capture/publish lifecycle now lives in `@cytale/calls`; the browser
 * capture environment it is injected with (`browserCaptureEnv()`) stays here
 * in `browserEnv.ts`, and `webWiring.ts` hands it to the engine. Call sites
 * (and the call tests) keep importing `./usePublish.js` unchanged.
 */

export {
  CAMERA_QUALITY_PRESETS,
  DEFAULT_CAMERA_QUALITY,
  DEFAULT_SCREEN_QUALITY,
  SCREEN_QUALITY_PRESETS,
  SIMULCAST_LAYER_BITRATE_FLOORS_KBPS,
  SIMULCAST_LAYER_BITRATE_FRACTIONS,
  SIMULCAST_LAYER_SCALES,
  applySenderCaps,
  createPublishEngine,
  type CaptureConstraints,
  type CaptureEnv,
  type PublishEngine,
  type PublishEngineDeps,
  type PublishEngineOps,
  type PublishQualityId,
  type PublishingState,
  type QualityPreset,
  type RtpSendParamsLike,
} from '@cytale/calls';

export { browserCaptureEnv } from './browserEnv.js';
