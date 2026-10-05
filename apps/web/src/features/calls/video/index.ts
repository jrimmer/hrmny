/**
 * @cytale/web — video call surfaces (calls V2 plan U5a).
 *
 * Fixture/props-driven components, deliberately unwired: streams arrive as
 * props, state arrives as props, and every callback belongs to the host.
 * The wiring unit (U5b) embeds these in CallPanel/DmCallIndicator and feeds
 * them from the engine (useCallMedia/usePublish/useAdaptiveBudget) and the
 * store. Nothing here imports the engine.
 */
export { Tile, tileCameraStateText, type TileProps, type TileVideoState } from './Tile.js';
export { TileGrid, type GridParticipant, type TileGridProps } from './TileGrid.js';
export { Stage, type StageProps, type StageShare } from './Stage.js';
export { SelfView, type SelfViewProps } from './SelfView.js';
export {
  ShareSwitcher,
  type ShareSwitcherProps,
  type SwitcherShare,
} from './ShareSwitcher.js';
export {
  QualityPicker,
  CAMERA_QUALITY_IDS,
  RECEIVER_QUALITY_IDS,
  SCREEN_QUALITY_IDS,
  type QualityPickerProps,
} from './QualityPicker.js';
export {
  CapabilityDisabledButton,
  CAPABILITY_DISABLED_DEFAULTS,
  type CapabilityDisabledButtonProps,
} from './CapabilityDisabledButton.js';
export {
  initialStageSelection,
  mostRecentShareId,
  stageSelectionReducer,
  type StageSelectionEvent,
  type StageSelectionState,
  type StageSelectionMode,
} from './stageSelection.js';
