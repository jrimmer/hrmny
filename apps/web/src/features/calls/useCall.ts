/**
 * @cytale/web — the call affordance API (calls plan U7 seam, U8 internals;
 * calls V2 plan U5b wiring).
 *
 * The stable surface every call entry point wires against: the channel
 * header's Start/Join buttons and the sidebar slot's click. U8 replaced the
 * U7 stub internals: intents now drive the module call engine
 * (useCallMedia.ts) — op-22 control, the RTCPeerConnection lifecycle, and
 * the AM14 composite state machine — while the call sites stayed untouched.
 *
 * `isJoined` remains a STORE read (the gateway's CALL_SYNC/CALL_UPDATE/
 * CALL_END events hydrate it), so the slot's return-to-call vs join
 * distinction (AM18) is reactive across every surface. `engineVoice()` /
 * `engineSpeaking()` expose the composite machine + speaking set for
 * surfaces that want them; the reactive hooks (`useCallEngineState`,
 * `useCallSpeakingFor`) are the preferred consumption path.
 *
 * V2 U5b additions: the publish/quality/budget intents (camera, screen +
 * share-audio, per-source tiers, the receiver's max-quality ceiling) and
 * the video wiring hooks every media surface composes from —
 * `useCallVideoStreams` (the engine's manifest-attributed video tracks as
 * attachable streams), `useCallVideoWant` (the adaptive budget), plus the
 * shared stage-selection (VM22) and grid-participant (VM3/VM18) helpers
 * both the channel panel and the DM frame consume.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import type { CallSourceKind, VideoQualityPreference, VideoWant } from '@cytale/protocol';
import {
  defaultStore,
  selectIsInCall,
  type ParticipantSourceInfo,
  type StateStore,
} from '@cytale/state';

import { useSpeakingSet } from './useSpeaking.js';
import {
  getCallEngine,
  type CallEngine,
  type CallEngineSnapshot,
  type MediaTrackLike,
} from './useCallMedia.js';
import type { PublishQualityId, PublishingState } from './usePublish.js';
import {
  initialStageSelection,
  stageSelectionReducer,
  type StageSelectionState,
} from './video/stageSelection.js';
import type { GridParticipant } from './video/TileGrid.js';
import type { VoiceState } from './voiceState.js';

export interface UseCall {
  /** Intent to start a call on a channel; `ring` summons the room (AM17). */
  startCall(channelId: string, opts?: { ring?: boolean }): void;
  /**
   * Intent to join the channel's live call — or RETURN to the call surface
   * when this client already holds the leg there (AM18: never re-joins).
   */
  joinCall(channelId: string): void;
  /** True when the viewer holds a voice leg in the channel's live call. */
  isJoined(channelId: string): boolean;
  /** This client's composite voice state (null when no leg was attempted). */
  engineVoice(): VoiceState | null;
  /** The speaking-user-ids set for the ACTIVE call (AM5). */
  engineSpeaking(): ReadonlySet<string>;
  /** V2: publish the camera at a tier (R1/R2 — SEND_VIDEO-gated server-side). */
  publishCamera(quality?: 'low' | 'medium' | 'high'): void;
  /** V2: publish screen (+ share-audio when the platform supplies it — VM9). */
  publishScreen(opts?: { audio?: boolean; quality?: PublishQualityId }): void;
  /** V2: VM13 window-switch affordance on a live share. */
  switchScreenSource(): void;
  /** V2: stop one published source (screen takes its share-audio along). */
  unpublishSource(source: CallSourceKind): void;
  /** V2: re-tier a live source (the sender quality pickers). */
  setPublishQuality(source: CallSourceKind, quality: PublishQualityId): void;
  /** V2/R9: declare the receiver's max-quality ceiling (→ video_want). */
  setReceiverMaxQuality(pref: VideoQualityPreference): void;
  /** V2: the engine's live publishing state (null when no leg). */
  enginePublishing(): PublishingState | null;
  /** V2: the engine's current receiver want (null when no leg). */
  engineVideoWant(): VideoWant | null;
}

/**
 * The call affordance API. `store` is injectable for tests; the app uses
 * the module-default store (the same one the session's gateway events
 * hydrate). Actions route through the module call engine.
 */
export function useCall(store: StateStore = defaultStore): UseCall {
  const startCall = useCallback((channelId: string, opts?: { ring?: boolean }): void => {
    getCallEngine().start(channelId, opts);
  }, []);

  const joinCall = useCallback((channelId: string): void => {
    getCallEngine().join(channelId);
  }, []);

  const isJoined = useCallback(
    (channelId: string): boolean => {
      const state = store.getState();
      const viewer = state.currentUser?.id ?? null;
      return viewer !== null && selectIsInCall(state, channelId, viewer);
    },
    [store],
  );

  const engineVoice = useCallback((): VoiceState | null => {
    const snapshot = getCallEngine().getSnapshot();
    return snapshot.channelId === null ? null : snapshot.voice;
  }, []);

  const engineSpeaking = useCallback((): ReadonlySet<string> => {
    return getCallEngine().getSpeaking();
  }, []);

  const publishCamera = useCallback(
    (quality?: 'low' | 'medium' | 'high'): void => {
      getCallEngine().publishCamera(quality);
    },
    [],
  );

  const publishScreen = useCallback(
    (opts?: { audio?: boolean; quality?: PublishQualityId }): void => {
      getCallEngine().publishScreen(opts);
    },
    [],
  );

  const switchScreenSource = useCallback((): void => {
    getCallEngine().switchScreenSource();
  }, []);

  const unpublishSource = useCallback((source: CallSourceKind): void => {
    getCallEngine().unpublishSource(source);
  }, []);

  const setPublishQuality = useCallback(
    (source: CallSourceKind, quality: PublishQualityId): void => {
      getCallEngine().setPublishQuality(source, quality);
    },
    [],
  );

  const setReceiverMaxQuality = useCallback((pref: VideoQualityPreference): void => {
    getCallEngine().setReceiverMaxQuality(pref);
  }, []);

  const enginePublishing = useCallback((): PublishingState | null => {
    const snapshot = getCallEngine().getSnapshot();
    return snapshot.channelId === null ? null : snapshot.publishing;
  }, []);

  const engineVideoWant = useCallback((): VideoWant | null => {
    const snapshot = getCallEngine().getSnapshot();
    return snapshot.channelId === null ? null : getCallEngine().getVideoWant();
  }, []);

  return {
    startCall,
    joinCall,
    isJoined,
    engineVoice,
    engineSpeaking,
    publishCamera,
    publishScreen,
    switchScreenSource,
    unpublishSource,
    setPublishQuality,
    setReceiverMaxQuality,
    enginePublishing,
    engineVideoWant,
  };
}

// ---------------------------------------------------------------------------
// Reactive engine bindings (CallPanel + sidebar seam)
// ---------------------------------------------------------------------------

/** Subscribe React to the engine's composite snapshot. */
export function useCallEngineState(engine?: CallEngine): CallEngineSnapshot {
  const e = engine ?? getCallEngine();
  return useSyncExternalStore(e.subscribe, e.getSnapshot, e.getSnapshot);
}

const EMPTY_SPEAKING: ReadonlySet<string> = new Set();

/**
 * The live speaking set for `channelId` — the CallSlot seam (AM5). Empty
 * unless this client's active call is on that channel.
 */
export function useCallSpeakingFor(channelId: string): ReadonlySet<string> {
  const engine = getCallEngine();
  const all = useSpeakingSet(engine.speakingSubscribe, engine.getSpeaking);
  const snapshot = useCallEngineState(engine);
  return useMemo(
    () => (snapshot.channelId === channelId ? all : EMPTY_SPEAKING),
    [snapshot.channelId, channelId, all],
  );
}

// ---------------------------------------------------------------------------
// V2 video wiring (calls V2 plan U5b) — the seams every media surface uses
// ---------------------------------------------------------------------------

/** Per-track MediaStream cache (identity-stable — tiles never re-attach). */
const streamByTrack = new WeakMap<object, unknown>();

/**
 * Wrap one media track as an attachable stream. The cache keys on track
 * identity, so re-renders hand <video> elements the SAME stream object and
 * browsers never see a spurious detach/attach. Environments without a
 * MediaStream constructor (jsdom) fall back to the raw track — the Tile's
 * guarded srcObject assignment is inert there by design.
 */
export function mediaStreamForTrack(track: unknown): unknown {
  if (track === null || track === undefined) return null;
  if (typeof track !== 'object') return track;
  let stream = streamByTrack.get(track);
  if (stream === undefined) {
    try {
      stream = new MediaStream([track as MediaStreamTrack]);
    } catch {
      stream = track; // no MediaStream global — visual surfaces stay inert
    }
    streamByTrack.set(track, stream);
  }
  return stream;
}

/**
 * The engine's manifest-attributed REMOTE video tracks as attachable
 * streams, keyed `${userId}:${source}` ('camera' | 'screen' — R5: the
 * manifest is the only attribution source, never m-line position). This is
 * THE video-track subscription seam: <video> elements on tiles and the
 * stage attach what this hook hands them.
 */
export function useCallVideoStreams(engine?: CallEngine): ReadonlyMap<string, unknown> {
  const e = engine ?? getCallEngine();
  const tracks = useSyncExternalStore(e.videoSubscribe, e.getVideoTracks, e.getVideoTracks);
  return useMemo(() => {
    const out = new Map<string, unknown>();
    for (const [key, track] of tracks) out.set(key, mediaStreamForTrack(track));
    return out;
  }, [tracks]);
}

/** The receiver's current want (live-tile budget + max quality) — KTD7. */
export function useCallVideoWant(engine?: CallEngine): VideoWant {
  const e = engine ?? getCallEngine();
  return useSyncExternalStore(e.wantSubscribe, e.getVideoWant, e.getVideoWant);
}

// -- stage selection (VM22, shared by the panel + the DM frame) ---------------

/** One live screen share as the stage wiring sees it (roster-derived, R3). */
export interface LiveShareView {
  /** The sharer (one screen per participant — the user IS the share id). */
  userId: string;
  /** Publish time (ISO 8601) — VM4's most-recent input. */
  since: string | undefined;
  /** VM9: the share carries a live share-audio track. */
  shareAudio: boolean;
}

/** The ended-share notice the Stage renders before collapsing (VM22). */
export interface EndedShareView {
  share: LiveShareView;
  reason: 'stopped' | 'presenter-left';
}

export interface StageWiring {
  selection: StageSelectionState;
  /** The share the stage renders (null = collapsed / none live). */
  staged: LiveShareView | null;
  /** Set while the LAST share ended and the notice hasn't collapsed. */
  ended: EndedShareView | null;
  /** Switcher selection → viewer-selected (VM22). */
  selectShare(shareId: string): void;
  /** Pin/unpin the staged share (VM4: pin overrides everything). */
  togglePin(): void;
  /** Dismiss the ended notice (collapse to grid — VM22's last-ends). */
  collapseEnded(): void;
}

/**
 * Drive the VM22 stage-selection machine from the store's live shares
 * (`shares` MOST RECENT FIRST — selectScreenSharers' order). Share
 * lifetimes diff across renders into share-started/share-ended events;
 * the machine's own transitions handle follow/hold/pin. The ended notice
 * only surfaces when NO share remains (a survivor re-stages silently).
 */
export function useStageSelection(
  shares: readonly LiveShareView[],
  rosterIds: ReadonlySet<string>,
): StageWiring {
  const [selection, dispatch] = useReducer(stageSelectionReducer, initialStageSelection);
  const [ended, setEnded] = useState<EndedShareView | null>(null);
  const prevRef = useRef<readonly LiveShareView[]>([]);

  // Oldest → newest (the machine's contract).
  const ordered = useMemo(() => [...shares].reverse(), [shares]);

  useEffect(() => {
    const prev = prevRef.current;
    const prevIds = new Set(prev.map((s) => s.userId));
    const nextIds = ordered.map((s) => s.userId);
    const nextSet = new Set(nextIds);
    let lastEndedShare: LiveShareView | null = null;
    for (const share of prev) {
      if (nextSet.has(share.userId)) continue;
      dispatch({ type: 'share-ended', shareId: share.userId, remaining: nextIds });
      lastEndedShare = share;
    }
    for (const id of nextIds) {
      if (prevIds.has(id)) continue;
      dispatch({ type: 'share-started', shareId: id });
      setEnded(null); // a new share re-stages; the old notice is done
    }
    prevRef.current = ordered;
    if (lastEndedShare !== null && nextIds.length === 0) {
      // VM22's last-ends: the notice names WHY (stopped vs presenter-left).
      setEnded({
        share: lastEndedShare,
        reason: rosterIds.has(lastEndedShare.userId) ? 'stopped' : 'presenter-left',
      });
    }
    // rosterIds is a fresh Set per render by callers — keyed on membership
    // content via the store-derived shares/roster it accompanies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ordered, rosterIds]);

  const staged = useMemo(
    () => shares.find((s) => s.userId === selection.activeShareId) ?? null,
    [shares, selection.activeShareId],
  );

  const selectShare = useCallback((shareId: string) => {
    dispatch({ type: 'select', shareId });
  }, []);

  const togglePin = useCallback(() => {
    if (selection.mode === 'pinned') {
      dispatch({ type: 'unpin', live: ordered.map((s) => s.userId) });
    } else if (staged !== null) {
      dispatch({ type: 'pin', shareId: staged.userId });
    }
  }, [selection.mode, staged, ordered]);

  const collapseEnded = useCallback(() => setEnded(null), []);

  return { selection, staged, ended, selectShare, togglePin, collapseEnded };
}

// -- grid participants (VM3/VM18, shared by the panel + the DM frame) ----------

export interface GridComputationInput {
  /** Roster user ids (stable order — the render order). */
  rosterIds: readonly string[];
  /** Camera publishers, MOST RECENT FIRST (selectCameraPublishers). */
  cameraPublishers: readonly ParticipantSourceInfo[];
  /** Display-name resolver (the caller owns "You"). */
  nameOf(userId: string): string;
  /** The viewer's user id (self tile mirrors — VM15). */
  viewerId: string | null;
  /** Remote streams keyed `${userId}:camera` (useCallVideoStreams). */
  streams: ReadonlyMap<string, unknown>;
  /** The viewer's own camera stream (self-view — local, never echoed). */
  localCameraStream: unknown;
  /** Current speakers (VM3 priority: speaker > recency). */
  speaking: ReadonlySet<string>;
  /** Live-tile budget (the receiver's want — beyond = VM18 avatars). */
  budget: number;
  /** Omit the self tile (stage-dominant overlay mode — VM15). */
  excludeSelf?: boolean;
  /** Offline/reconnecting degradation hint on live tiles. */
  frozenAll?: boolean;
}

export interface GridComputation {
  participants: GridParticipant[];
  /** Live video tile count (self included — it IS a rendered tile). */
  liveCount: number;
}

/**
 * Derive the tile grid's participants (pure): every roster member renders
 * (camera-off avatars for non-publishers — never blank, never hidden);
 * camera publishers within the budget are live (loading until their
 * manifest-attributed track attaches), beyond it they degrade to the VM18
 * connection-paused avatar. Live slots follow VM3's priority (current
 * speaker first, then most-recent publisher); the SELF tile is local — it
 * never consumes the receiver budget.
 */
export function computeGridParticipants(input: GridComputationInput): GridComputation {
  const {
    rosterIds,
    cameraPublishers,
    nameOf,
    viewerId,
    streams,
    localCameraStream,
    speaking,
    budget,
    excludeSelf = false,
    frozenAll = false,
  } = input;

  // Live-slot reservation: speakers first, then recency (VM3's tile half —
  // the stage/speaker protection against the SERVER is KTD2's, not ours).
  const ranked = [...cameraPublishers].sort((a, b) => {
    const rankA = speaking.has(a.user_id) ? 0 : 1;
    const rankB = speaking.has(b.user_id) ? 0 : 1;
    return rankA - rankB; // stable within a class: most-recent-first holds
  });
  const liveSet = new Set<string>();
  let slots = Math.max(0, budget);
  for (const p of ranked) {
    if (slots <= 0) break;
    if (p.user_id === viewerId) continue; // local stream — no budget cost
    liveSet.add(p.user_id);
    slots -= 1;
  }

  const participants: GridParticipant[] = [];
  let liveCount = 0;
  for (const userId of rosterIds) {
    const isSelf = userId === viewerId;
    if (isSelf && excludeSelf) continue;
    const publisher = cameraPublishers.some((p) => p.user_id === userId);
    const speakingNow = speaking.has(userId);
    if (isSelf) {
      // VM15: self is mirrored; its stream is the local capture (own m-lines
      // never echo back through ontrack — the server forwards to OTHERS).
      if (localCameraStream != null) {
        participants.push({
          userId,
          name: 'You',
          state: 'live',
          stream: localCameraStream,
          speaking: speakingNow,
          isSelf: true,
          frozen: frozenAll,
        });
        liveCount += 1;
      } else {
        participants.push({
          userId,
          name: 'You',
          state: publisher ? 'loading' : 'camera-off',
          speaking: speakingNow,
          isSelf: true,
        });
      }
      continue;
    }
    if (!publisher) {
      participants.push({ userId, name: nameOf(userId), state: 'camera-off', speaking: speakingNow });
      continue;
    }
    if (liveSet.has(userId)) {
      const stream = streams.get(`${userId}:camera`);
      if (stream != null) {
        participants.push({
          userId,
          name: nameOf(userId),
          state: 'live',
          stream,
          speaking: speakingNow,
          frozen: frozenAll,
        });
        liveCount += 1;
      } else {
        // Roster says camera; the manifest-attributed track hasn't arrived.
        participants.push({ userId, name: nameOf(userId), state: 'loading', speaking: speakingNow });
      }
      continue;
    }
    // VM18: beyond the budget — a DISTINCT affordance from camera-off.
    participants.push({
      userId,
      name: nameOf(userId),
      state: 'connection-paused',
      speaking: speakingNow,
    });
  }
  return { participants, liveCount };
}
