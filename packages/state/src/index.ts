/**
 * @cytale/state — public API (U17).
 *
 * Headless state store turning gateway events + REST reads into UI state.
 * apps/web (U18+) consumes `defaultStore` (or its own `createStateStore()`)
 * with zustand selectors; the U28 harness may reuse reconcile for
 * client-side convergence checks.
 */

export {
  createStateStore,
  compareNewestFirst,
  messageSortKey,
  EVICTED_SLICE_ROWS,
  RECENT_CHANNELS_MAX,
  type CallParticipantState,
  type CallRingEntry,
  type FailedSend,
  type LiveCall,
  type MessageSlice,
  type PendingSend,
  type PresenceEntry,
  type SessionStatus,
  type StateState,
  type StateStore,
  type UnreadState,
  MESSAGE_SLICE_MAX,
  type PageDirection,
} from './store.js';

export {
  advanceLastSeq,
  applyGatewayEvent,
  hasLoadedHistory,
  mergeChannelMessages,
  mergeNewestPage,
  mergeThreadMessages,
  resetForFreshSession,
  setCallLogThread,
  setMessageWindowHold,
  type MergeOptions,
} from './reconcile.js';

export {
  channelFromReady,
  dmChannelFromReady,
  mergeMembers,
  replaceMembers,
  replaceRecordMap,
  replaceRoster,
  replaceThreads,
  rosterFromReady,
  rosterPatch,
  workspaceFromReady,
  type Roster,
} from './roster.js';

export {
  startMemberResolver,
  type MemberLookup,
  type MemberResolver,
  type MemberResolverOptions,
} from './memberResolver.js';

export { isBatching, withBatchedWrites } from './batch.js';

// Notification controls (2026-09-27): the ONE copy of the member's levels and
// broadcast switches, and the walk every surface resolves them through.
export {
  ACCOUNT_ENTITY_ID,
  clearNotificationLevel,
  DEFAULT_NOTIFICATION_LEVEL,
  emptyNotificationPrefs,
  hydrateNotificationPreferences,
  isBroadcastSuppressed,
  messageAddressesMe,
  nextNotificationLevel,
  NOTIFICATION_LAYER_LABEL,
  NOTIFICATION_LEVEL_CYCLE,
  NOTIFICATION_LEVEL_LABEL,
  notificationControlLabel,
  notificationOverrideKey,
  notificationResetLabel,
  resolveNotificationLevel,
  resolveNotificationTarget,
  setBroadcastSuppressed,
  setNotificationLevel,
  type NotificationDecidedBy,
  type NotificationLevel,
  type NotificationPrefsApi,
  type NotificationPrefsState,
  type NotificationScope,
  type NotificationTarget,
  type NotificationTargetView,
  type ResolvedNotificationLevel,
  type ResolveNotificationInput,
} from './notificationPreferences.js';

export { evictionPatch, touchChannel } from './lru.js';

// The synthetic seq space has ONE owner (hardening 6.8): the floor the replay
// gate classifies against and the allocator every local reconcile stamps with
// are re-exported from the same module, so no consumer can hold a second copy
// of either.
export { nextSyntheticSeq, SYNTHETIC_SEQ_FLOOR } from './syntheticSeq.js';

export {
  clearCallRing,
  selectCallLogThreadId,
  selectCallRing,
  selectCallRoster,
  selectCameraPublishers,
  selectDmCall,
  selectIsInCall,
  selectIsPublishing,
  selectLiveCall,
  selectLiveCallChannelIds,
  selectMediaEnabled,
  selectParticipantCount,
  selectParticipantSources,
  selectScreenSharers,
  selectSourcePublishers,
  type ParticipantSourceInfo,
} from './call/projection.js';

export {
  beginOptimisticSend,
  confirmOptimisticSend,
  failOptimisticSend,
  holdFailedSend,
  discardFailedSend,
  retryFailedSend,
  getNonce,
  makePlaceholderId,
  newSendNonce,
  isConnectionFailure,
  heldSendsAwaitingConnection,
  markHeldSendsWaiting,
  type HeldSendState,
  type BeginSendInput,
  type BeginSendOptions,
  type BeginSendResult,
} from './optimistic.js';

export {
  draftThreadKey,
  isDraftThreadKey,
  seedDraftThread,
  dropEmptyDraftThread,
  promoteDraftThread,
} from './draftThread.js';

export {
  channelMentionCount,
  channelUnreadCount,
  type BadgeCounts,
  markChannelRead,
  clearChannelFloor,
  settleOpenChannelUnread,
  resetChannelBadgeMemo,
  isUnreadByReadState,
  markThreadRead,
  deriveChannelBadge,
  deriveTotalBadge,
} from './unread.js';

import { createStateStore } from './store.js';

/** Module-default store for simple consumers (apps/web uses this directly). */
export const defaultStore = createStateStore();

// Per-workspace nicknames (#169): the name to show for a member in a place.
export {
  globalRow,
  memberNameIn,
  nicknameIn,
  nicknamesForChannel,
  withNickname,
  type NicknamesByWorkspace,
} from './nicknames.js';
