/**
 * @cytale/protocol — single source of truth for the Cytale wire protocol.
 *
 * Consumed by the web SPA (U17), desktop shell (U27), gateway client (U15),
 * future React Native clients, mirrored by the Elixir server, and imported by
 * the U28 load harness. Wire encode/decode lives here exactly once so
 * production clients and the harness never drift.
 */

// Opcodes, directions, compression modes
export {
  COMPRESSION_MODES,
  CORE_GATEWAY_OP_NAMES,
  GATEWAY_OP_DIRECTIONS,
  GATEWAY_OP_NAMES,
  GatewayOp,
  KNOWN_GATEWAY_OPS,
  RESERVED_OP_MIN,
  isCompressionMode,
  isKnownOp,
  isReservedOp,
} from './opcodes.js';
export type {
  CompressionMode,
  GatewayOpCode,
  OpDirection,
} from './opcodes.js';

// Event payloads, event-name union, dispatch mapping
export {
  CALL_END_REASONS,
  CALL_MANIFEST_SOURCES,
  CALL_SIGNAL_ENVELOPE_VERSION,
  CALL_UPDATE_STATES,
  EVENT_NAMES,
  GATEWAY_EVENTS,
  isCallEndReason,
  isCallManifestSource,
  isCallSignalOfferEnvelope,
  isCallUpdateState,
  isEventName,
  parseCallSignalOfferEnvelope,
} from './events.js';
export type {
  AccountDelete,
  CallEnd,
  CallEndReason,
  CallManifestSource,
  CallParticipant,
  CallRing,
  CallSignal,
  CallSignalManifestEntry,
  CallSignalOfferEnvelope,
  CallSourceState,
  CallStart,
  CallSync,
  CallSyncDmEntry,
  CallSyncEntry,
  CallUpdate,
  CallUpdateState,
  ChannelCreate,
  ChannelDelete,
  ChannelUpdate,
  EventName,
  EventNameToPayload,
  EventPayloadMap,
  GatewayEvent,
  InteractionCreate,
  InteractionModal,
  InteractionSuccess,
  MemberAdd,
  MemberRemove,
  MemberUpdate,
  MessageAck,
  MessageActionRow,
  MessageCreate,
  MessageDelete,
  MessageUpdate,
  ReadStateSync,
  ReadStateSyncEntry,
  ReadStateUpdate,
  ModalAnswerRow,
  ModalTextInput,
  PresenceStatus,
  PresenceUpdate,
  Ready,
  ReadyChannel,
  ReadyDmChannel,
  ReadyWorkspace,
  Resumed,
  RoleCreate,
  RoleDelete,
  RoleUpdate,
  ThreadCreate,
  ThreadDelete,
  ThreadListSync,
  ThreadMemberAdd,
  ThreadMemberRemove,
  ThreadMessageCreate,
  ThreadUpdate,
  TypingStart,
  UserUpdate,
} from './events.js';

// Client/server lifecycle + reserved-range command payloads
export {
  CALL_CONTROL_ACTIONS,
  CALL_SIGNAL_BODY_MAX_BYTES,
  CALL_SIGNAL_KINDS,
  CALL_SOURCE_KINDS,
  CLIENT_HELLO,
  GATEWAY_VERSION,
  INT64_MAX as SNOWFLAKE_INT64_MAX,
  VIDEO_QUALITY_PREFERENCES,
  isCallControlAction,
  isCallSignalKind,
  isCallSourceKind,
  isSnowflake,
  isVideoQualityPreference,
  makeSnowflake,
} from './payloads.js';
export type {
  CallControlAction,
  CallSignalKind,
  CallSourceKind,
  GatewayCallSignalPayload,
  GatewayCallStateUpdatePayload,
  GatewayClientMessageAckPayload,
  GatewayClientTypingStartPayload,
  GatewayHelloPayload,
  GatewayIdentifyPayload,
  GatewayResumePayload,
  GatewayServerTypingStartPayload,
  HeartbeatData,
  IdentifyProperties,
  InvalidSessionData,
  MessageAckServerAck,
  Snowflake,
  VideoQualityPreference,
  VideoWant,
} from './payloads.js';

// Envelope types and runtime guards
export {
  dispatchEvent,
  isGatewayEnvelope,
  narrowDispatch,
} from './envelope.js';
export type {
  GatewayDispatchEnvelope,
  GatewayEnvelope,
  ValidatedGatewayFrame,
} from './envelope.js';

// Package version
export const PROTOCOL_PACKAGE_VERSION = '0.1.0' as const;
