/**
 * @cytale/web — voice-call affordances (calls plan U7–U10).
 */
export { CallSlot, type CallSlotProps } from './CallSlot.js';
export { CallControls, type CallControlsProps } from './CallControls.js';
export { DmCallIndicator, type DmCallIndicatorProps } from './dm/DmCallIndicator.js';
export {
  CallPanel,
  CallPanelSurface,
  type CallPanelProps,
  type CallPanelSurfaceProps,
} from './CallPanel.js';
export {
  CallLogPane,
  CallLogThreadView,
  type CallLogPaneProps,
  type CallLogThreadViewProps,
} from './log/CallLogPane.js';
export { CallLogStandalone, type CallLogStandaloneProps } from './log/CallLogStandalone.js';
export { useCallLog, type CallLogLoadState, type UseCallLogOptions } from './log/useCallLog.js';
export {
  useCall,
  useCallEngineState,
  useCallSpeakingFor,
  useCallVideoStreams,
  useCallVideoWant,
  useStageSelection,
  computeGridParticipants,
  mediaStreamForTrack,
  type UseCall,
  type LiveShareView,
  type EndedShareView,
  type StageWiring,
  type GridComputation,
  type GridComputationInput,
} from './useCall.js';
export {
  configureIce,
  createCallEngine,
  getCallEngine,
  setCallEngineForTests,
  type AdaptiveBudgetFactory,
  type AdaptiveBudgetHooks,
  type CallEngine,
  type CallEngineDeps,
  type CallEngineSnapshot,
} from './useCallMedia.js';
export { routeCallSignalEvent, onCallSignal } from './session-call-signal.js';
export {
  emptyManifest,
  isAudioSource,
  isVideoSource,
  manifestFromEntries,
  ownEntries,
  parseCallOffer,
  parseMlines,
  trackKey,
  type CallTrackAttribution,
  type CallTrackManifest,
  type MlineInfo,
  type ParsedCallOffer,
} from './manifest.js';
export {
  CAMERA_QUALITY_PRESETS,
  DEFAULT_CAMERA_QUALITY,
  DEFAULT_SCREEN_QUALITY,
  SCREEN_QUALITY_PRESETS,
  SIMULCAST_LAYER_BITRATE_FRACTIONS,
  SIMULCAST_LAYER_SCALES,
  applySenderCaps,
  browserCaptureEnv,
  createPublishEngine,
  type CaptureConstraints,
  type CaptureEnv,
  type PublishEngine,
  type PublishEngineOps,
  type PublishQualityId,
  type PublishingState,
  type QualityPreset,
} from './usePublish.js';
export {
  AdaptiveBudget,
  DEGRADE_FREEZE_DELTA,
  DEGRADE_JITTER_S,
  DEGRADE_STALLED_BYTES_PER_POLL,
  LADDER_INITIAL_TILES,
  LADDER_MAX_TILES,
  LADDER_MIN_TILES,
  LADDER_POLL_MS,
  LADDER_UPSHIFT_WINDOWS,
  LADDER_WINDOW_MS,
  collectInboundVideoStats,
  type AdaptiveBudgetHandle,
  type AdaptiveBudgetOptions,
  type InboundVideoStats,
  type StatsRecordLike,
  type StatsReportLike,
} from './useAdaptiveBudget.js';
export {
  RingToasts,
  RingToast,
  type RingToastsProps,
  type RingToastProps,
} from './ring/RingToast.js';
export {
  ringReducer,
  ringExpiryDelayMs,
  useRingToasts,
  isDmRing,
  viewerInCall,
  notifyBackgroundRing,
  RING_TIMEOUT_MS,
  type RingToastState,
  type RingAction,
  type RingDriverDeps,
} from './ring/ringReducer.js';
export {
  createRingSound,
  RING_CADENCE_MS,
  type RingSoundController,
  type RingSoundEnv,
  type RingSoundStartResult,
} from './ring/RingSound.js';
export {
  callMuteStore,
  getCallMute,
  isCallMuted,
  useCallMute,
  toggleCallMute,
  type CallMuteEntry,
  type CallMuteStatus,
} from './ring/notificationMute.js';
