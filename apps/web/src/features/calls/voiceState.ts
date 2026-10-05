/**
 * @cytale/web — re-export shim for the extracted voice state machine.
 *
 * The AM14 composite machine is a pure reducer (no platform globals at all),
 * so it moved to `@cytale/calls` unchanged; the web call surfaces keep
 * importing `./voiceState.js`.
 */

export {
  ACTIVE_STATUSES,
  initialVoiceState,
  isTerminal,
  transition,
  type TransitionResult,
  type VoiceEffect,
  type VoiceInput,
  type VoiceNotice,
  type VoiceState,
  type VoiceStatus,
} from '@cytale/calls';
