/**
 * @cytale/web — the call panel (calls plan U8, AM18; calls V2 plan U5b).
 *
 * Geometry: a docked split in the message-pane region on desktop (the
 * ThreadSidePanel dock pattern — the same surface, narrower), and a bottom
 * sheet overlay on mobile (<768px). `CallPanel` renders the content;
 * `CallPanelSurface` picks the geometry.
 *
 * States-first (UX_SPEC §9 — every state has a surface):
 *   connecting-signaling / connecting-media → spinners with text (status)
 *   connected                              → media + roster + controls + log
 *   reconnecting                           → persistent status banner (all
 *                                            live tiles carry the freeze hint)
 *   permission-denied                      → alert (mic guidance + retry, or
 *                                            removal copy) per notice
 *   voice-unavailable                      → alert + retry
 *   offline                                → alert (teardown notice) + dismiss
 *   idle+displaced notice                  → "joined elsewhere" notice
 *   alone in call                          → named empty state + ring-the-room
 *
 * V2 VIDEO COMPOSITION (U5b — VM16): no share → the tile grid fills the
 * media area; share-live → the Stage dominates with the grid demoted to the
 * strip rail and self-view demoted to its corner overlay (VM15); the stage
 * carries the fullscreen affordance (VM19 auto-expands it on mobile while a
 * share is live). Stage selection runs the VM22 machine (useStageSelection)
 * driven by the store's screen sharers; tile activation spotlights (VM21).
 * Publishing controls gate honestly: capability-off affordances render
 * visible-disabled with an explanatory dialog (VM10 pattern via
 * CapabilityDisabledButton), SEND_VIDEO/SHARE_SCREEN-denied controls render
 * pre-disabled with explanatory titles (VM20), and the quality pickers ride
 * the engine's per-source tiers + the receiver's max-quality ceiling.
 *
 * The call-log region embeds U9's CallLogPane — the standing log as a
 * thread view (rows + boundaries + thread composer).
 *
 * WCAG: real buttons (40×40 hit areas, focus-visible rings), aria-pressed
 * toggles, speaking rings carry both data-speaking and visible styling,
 * keyboard-operable throughout.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CallCapabilities } from '@cytale/api-client';
import {
  defaultStore,
  selectCallRoster,
  selectCameraPublishers,
  selectDmCall,
  selectScreenSharers,
  selectParticipantSources,
  type StateStore, nicknamesForChannel } from '@cytale/state';

import { api } from '../auth/session.js';
import { useStoreSlices } from '../../app/useStoreSelector.js';
import { useIsMobileWidth } from '../../app/layout/useIsMobileWidth.js';
import { PhoneIcon, Spinner } from '../../app/ui/icons.js';
import { Avatar } from '../../app/ui/UserAvatar.js';
import { ListErrorBoundary } from '../messages/ListErrorBoundary.js';

import { CallControls } from './CallControls.js';
import { CallLogPane } from './log/CallLogPane.js';
import { CALL_CAPABILITIES_ALL } from './capability/callCapabilities.js';
import {
  computeGridParticipants,
  mediaStreamForTrack,
  useCallEngineState,
  useCallVideoStreams,
  useCallVideoWant,
  useStageSelection,
  type LiveShareView,
} from './useCall.js';
import { openWebApp } from './capability/handoff.js';
import { useSpeakingSet } from './useSpeaking.js';
import type { CallEngine, CallEngineSnapshot } from './useCallMedia.js';
import { getCallEngine } from './useCallMedia.js';
import {
  CapabilityDisabledButton,
  QualityPicker,
  SelfView,
  ShareSwitcher,
  Stage,
  TileGrid,
  type StageShare,
  type SwitcherShare,
} from './video/index.js';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '../../components/shadcn/dialog.js';
import { displayNameOf } from '@cytale/domain';

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

const ICON_BUTTON =
  'flex h-10 min-w-10 items-center justify-center gap-1.5 rounded-md px-2 text-sm font-medium ' +
  'transition-colors duration-[var(--duration-control)] hover:bg-surface-hover ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]';

/** Muted / deafened indicators — text glyphs with text alternatives. */
function MuteMark({ muted }: { muted: boolean }) {
  return muted ? (
    <span
      className="text-xs text-danger"
      role="img"
      aria-label="muted"
      data-testid="roster-muted"
    >
      🎙̶
    </span>
  ) : null;
}

function DeafenMark({ deafened }: { deafened: boolean }) {
  return deafened ? (
    <span
      className="text-xs text-danger"
      role="img"
      aria-label="deafened"
      data-testid="roster-deafened"
    >
      🎧̶
    </span>
  ) : null;
}

/** Roster publish-state badges (R3 — visible to everyone incl. late joiners). */
const SOURCE_GLYPHS: Record<string, { glyph: string; label: string }> = {
  camera: { glyph: '📷', label: 'camera on' },
  screen: { glyph: '🖥', label: 'sharing screen' },
  screen_audio: { glyph: '🔊', label: 'sharing audio' },
};

function RosterSourceMarks({ sources }: { sources?: Array<{ source: string }> }) {
  if (sources === undefined || sources.length === 0) return null;
  return (
    <span className="flex items-center gap-0.5">
      {sources.map((s) => {
        const meta = SOURCE_GLYPHS[s.source];
        if (!meta) return null;
        return (
          <span
            key={s.source}
            className="text-xs text-text-muted"
            role="img"
            aria-label={meta.label}
            data-testid="roster-source"
            data-source={s.source}
          >
            {meta.glyph}
          </span>
        );
      })}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Capability gating (R16/R17 — channel-override-then-master from the call REST)
// ---------------------------------------------------------------------------

/** What the call panel surfaces read off the store (lane D #17). */
const CALL_PANEL_SLICES = [
  'currentUser',
  'channels',
  'membersById',
  'nicknamesByWorkspace',
  'callByChannel',
  'dmCallByChannel',
] as const;

/** Fetch the channel's effective capabilities once (all-true on failure). */
export function useCallCapabilities(
  channelId: string,
  opts: { enabled: boolean; fetchCapabilities?: () => Promise<CallCapabilities | null> },
): CallCapabilities {
  const [caps, setCaps] = useState<CallCapabilities>(CALL_CAPABILITIES_ALL);
  const fetcher = opts.fetchCapabilities;
  const enabled = opts.enabled;
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const run = fetcher ?? (async () => {
      try {
        const res = await api.getCall(channelId);
        return res.capabilities ?? CALL_CAPABILITIES_ALL;
      } catch {
        return CALL_CAPABILITIES_ALL; // REST failure never gates the panel shut
      }
    });
    void run().then((next) => {
      if (!cancelled && next !== null) setCaps(next);
    });
    return () => {
      cancelled = true;
    };
  }, [channelId, enabled, fetcher]);
  return caps;
}

// ---------------------------------------------------------------------------
// Publishing controls (camera / screen / quality — R1/R2, VM10/VM20)
// ---------------------------------------------------------------------------

export interface PublishControlsProps {
  engine: CallEngine;
  snapshot: CallEngineSnapshot;
  capabilities: CallCapabilities;
  canSendVideo: boolean;
  canShareScreen: boolean;
  mobile: boolean;
  context: string;
}

export function PublishControls({
  engine,
  snapshot,
  capabilities,
  canSendVideo,
  canShareScreen,
  mobile,
  context,
}: PublishControlsProps) {
  const publishing = snapshot.publishing;

  // R9/quality reactivity: the pickers' labels read the engine directly
  // (getReceiverMaxQuality / getPublishQuality are plain reads). Subscribing
  // to the want channel re-renders on every pick (and on adaptive-ladder
  // steps), keeping the trigger labels honest instead of lagging one render
  // behind the wire op. (Found live in the V2 WebKit walkthrough.)
  useCallVideoWant(engine);

  // -- camera (SEND_VIDEO-gated server-side; capability + bit gating here) -----
  const cameraControl = capabilities.video === false ? (
    <CapabilityDisabledButton
      label="Turn on camera"
      icon="📷"
      context={context}
      dialogTitle="Video isn't available"
      dialogBody="Video is turned off for this channel or workspace. You can still join the call and share your screen."
    />
  ) : !canSendVideo ? (
    <button
      type="button"
      className={ICON_BUTTON + ' text-text-muted disabled:cursor-not-allowed disabled:opacity-50'}
      aria-pressed={publishing.camera}
      aria-label={publishing.camera ? 'Turn off camera' : 'Turn on camera'}
      title="You don't have permission to send video in this channel."
      data-testid={`call-camera-${context}`}
      disabled
    >
      <span aria-hidden>{publishing.camera ? '📷̶' : '📷'}</span>
    </button>
  ) : (
    <button
      type="button"
      className={ICON_BUTTON + (publishing.camera ? ' text-text-primary' : ' text-text-muted')}
      aria-pressed={publishing.camera}
      aria-label={publishing.camera ? 'Turn off camera' : 'Turn on camera'}
      data-testid={`call-camera-${context}`}
      onClick={() =>
        publishing.camera ? engine.unpublishSource('camera') : engine.publishCamera()
      }
    >
      <span aria-hidden>{publishing.camera ? '📷̶' : '📷'}</span>
    </button>
  );

  // -- screen share (SHARE_SCREEN-gated; VM10's mobile honest-disabled) -------
  const screenControl = capabilities.screenshare === false ? (
    <CapabilityDisabledButton
      label="Share your screen"
      icon="🖥"
      context={context}
      dialogTitle="Screen sharing isn't available"
      dialogBody="Screen sharing is turned off for this channel or workspace. You can still join the call and share your camera."
    />
  ) : mobile ? (
    // VM10 (ratified flip): the affordance ALWAYS renders on mobile — visibly
    // disabled, activating explains the gap. Never disappears by platform.
    <CapabilityDisabledButton label="Share your screen" icon="🖥" context={context} />
  ) : !canShareScreen ? (
    <button
      type="button"
      className={ICON_BUTTON + ' text-text-muted disabled:cursor-not-allowed disabled:opacity-50'}
      aria-pressed={publishing.screen}
      aria-label={publishing.screen ? 'Stop sharing your screen' : 'Share your screen'}
      title="You don't have permission to share your screen in this channel."
      data-testid={`call-share-${context}`}
      disabled
    >
      <span aria-hidden>🖥</span>
    </button>
  ) : (
    <button
      type="button"
      className={ICON_BUTTON + (publishing.screen ? ' text-text-primary' : ' text-text-muted')}
      aria-pressed={publishing.screen}
      aria-label={publishing.screen ? 'Stop sharing your screen' : 'Share your screen'}
      data-testid={`call-share-${context}`}
      onClick={() =>
        publishing.screen
          ? engine.unpublishSource('screen')
          : engine.publishScreen({ audio: true }) // VM9: share-audio where the platform supplies it
      }
    >
      <span aria-hidden>🖥</span>
    </button>
  );

  return (
    <>
      {cameraControl}
      {screenControl}
      {publishing.screen ? (
        <button
          type="button"
          className={ICON_BUTTON + ' text-text-muted'}
          aria-label="Switch shared window"
          title="Pick a different window or screen to share"
          data-testid={`call-switch-share-${context}`}
          onClick={() => engine.switchScreenSource()}
        >
          <span aria-hidden>⇄</span>
        </button>
      ) : null}

      {/* Sender quality pickers (R2 — per live source). */}
      {publishing.camera ? (
        <QualityPicker
          kind="sender"
          source="camera"
          context={context}
          value={engine.getPublishQuality('camera')}
          onPick={(id) => engine.setPublishQuality('camera', id as 'low' | 'medium' | 'high')}
          disabled={!canSendVideo || capabilities.video === false}
          disabledTitle="You don't have permission to send video in this channel."
        />
      ) : null}
      {publishing.screen ? (
        <QualityPicker
          kind="sender"
          source="screen"
          context={context}
          value={engine.getPublishQuality('screen')}
          onPick={(id) => engine.setPublishQuality('screen', id as 'low' | 'medium' | 'high' | 'source')}
        />
      ) : null}

      {/* Receiver max-quality (R9 — the simulcast GO branch's ceiling). */}
      <QualityPicker
        kind="receiver"
        context={context}
        value={engine.getReceiverMaxQuality()}
        onPick={(id) => engine.setReceiverMaxQuality(id as 'high' | 'medium' | 'low')}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// The media area (grid + stage composition — VM15/VM16/VM18–VM22)
// ---------------------------------------------------------------------------

interface CallMediaAreaProps {
  channelId: string;
  store: StateStore;
  engine: CallEngine;
  snapshot: CallEngineSnapshot;
  speaking: ReadonlySet<string>;
  mobile: boolean;
  reconnecting: boolean;
  displayName(userId: string): string;
  /** The composition's testid context (panel | dm). */
  context: string;
}

function CallMediaArea({
  channelId,
  store,
  engine,
  snapshot,
  speaking,
  mobile,
  reconnecting,
  displayName,
  context,
}: CallMediaAreaProps) {
  // Call + roster slices only (lane D #17; was whole-store).
  const state = useStoreSlices(store, CALL_PANEL_SLICES);
  const viewer = state.currentUser?.id ?? null;
  const streams = useCallVideoStreams(engine);
  const want = useCallVideoWant(engine);

  const roster = useMemo(() => selectCallRoster(state, channelId), [state, channelId]);
  const rosterIds = useMemo(() => new Set(roster.map((p) => p.user_id)), [roster]);
  const cameraPublishers = useMemo(
    () => selectCameraPublishers(state, channelId),
    [state, channelId],
  );

  // -- stage selection (VM22) over the store's screen sharers (VM4) -----------
  const sharers = useMemo(
    () =>
      selectScreenSharers(state, channelId).map<LiveShareView>((s) => ({
        userId: s.user_id,
        since: s.since,
        shareAudio: selectParticipantSources(state, channelId, s.user_id).some(
          (src) => src.source === 'screen_audio',
        ),
      })),
    [state, channelId],
  );
  const stage = useStageSelection(sharers, rosterIds);
  const shareLive = sharers.length > 0;

  // VM19: while a share is live on mobile, the stage expands fullscreen with
  // the grid collapsed to the thumbnail strip (each NEW share re-expands).
  const [stageFullscreen, setStageFullscreen] = useState(false);
  useEffect(() => {
    if (mobile && shareLive) setStageFullscreen(true);
  }, [mobile, shareLive]);

  // VM21: tile activation → spotlight (enlarge one participant's camera).
  const [spotlightId, setSpotlightId] = useState<string | null>(null);
  useEffect(() => {
    if (spotlightId !== null && !rosterIds.has(spotlightId)) setSpotlightId(null);
  }, [rosterIds, spotlightId]);

  // -- grid participants (VM3/VM18) -------------------------------------------
  const localCameraStream = useMemo(() => {
    if (viewer === null || !snapshot.publishing.camera) return null;
    const track = engine.getLocalPublishTrack('camera');
    return track !== null ? mediaStreamForTrack(track) : null;
    // snapshot.localVideoRev is the identity trigger for this read (a
    // replaceTrack switch re-keys the stream without flipping `publishing`).
  }, [engine, viewer, snapshot.publishing.camera, snapshot.localVideoRev]);

  const grid = useMemo(
    () =>
      computeGridParticipants({
        rosterIds: roster.map((p) => p.user_id),
        cameraPublishers,
        nameOf: displayName,
        viewerId: viewer,
        streams,
        localCameraStream,
        speaking,
        budget: want.tiles,
        excludeSelf: shareLive, // VM15: stage dominates → self is the overlay
        frozenAll: reconnecting,
      }),
    [roster, cameraPublishers, displayName, viewer, streams, localCameraStream, speaking, want.tiles, shareLive, reconnecting],
  );

  // VM15: while the stage dominates, self-view is the corner overlay.
  const overlaySelf = shareLive && snapshot.publishing.camera && viewer !== null;

  // VM18: budget step-downs (and recovery) announce politely.
  const [announcement, setAnnouncement] = useState('');
  const liveCountRef = useRef<number | null>(null);
  useEffect(() => {
    const prev = liveCountRef.current;
    liveCountRef.current = grid.liveCount;
    if (prev === null || prev === grid.liveCount) return;
    setAnnouncement(
      grid.liveCount < prev
        ? `Connection slowed — showing ${grid.liveCount} live video ${grid.liveCount === 1 ? 'tile' : 'tiles'}`
        : `Connection recovered — showing ${grid.liveCount} live video ${grid.liveCount === 1 ? 'tile' : 'tiles'}`,
    );
  }, [grid.liveCount]);

  // -- the staged share (Stage's view model) -----------------------------------
  const staged: StageShare | null = useMemo(() => {
    if (stage.staged === null) return null;
    const s = stage.staged;
    const ownTrack = s.userId === viewer ? engine.getLocalPublishTrack('screen') : null;
    return {
      shareId: s.userId,
      presenterId: s.userId,
      presenterName: s.userId === viewer ? 'You' : displayName(s.userId),
      // Own share stages the LOCAL capture (own m-lines never echo back
      // through ontrack — the server forwards to others).
      stream:
        ownTrack !== null ? mediaStreamForTrack(ownTrack) : streams.get(`${s.userId}:screen`),
      shareAudio: s.shareAudio,
    };
  }, [stage.staged, viewer, engine, streams, displayName, snapshot.localVideoRev]);

  const switcherShares = useMemo<SwitcherShare[]>(
    () =>
      sharers.map((s) => ({
        shareId: s.userId,
        presenterName: s.userId === viewer ? 'You' : displayName(s.userId),
      })),
    [sharers, viewer, displayName],
  );

  const spotlight = useMemo(() => {
    if (spotlightId === null) return null;
    return grid.participants.find((p) => p.userId === spotlightId) ?? null;
  }, [grid.participants, spotlightId]);

  return (
    <div
      className="flex min-h-0 flex-col gap-2"
      data-testid={`call-media-area-${context}`}
      data-share-live={shareLive || undefined}
      data-spotlight={spotlightId ?? undefined}
    >
      {/* Stage region (VM16: dominates while a share is live; collapsed
          otherwise — including the VM22 ended notice until dismissed). */}
      {shareLive || stage.ended !== null ? (
        <div
          className="relative flex max-h-[56vh] min-h-[220px] flex-col [&>.video-stage]:flex-1"
          data-testid={`call-stage-wrap-${context}`}
        >
          <Stage
            share={staged}
            endedReason={stage.ended?.reason ?? null}
            endedPresenterName={
              stage.ended !== null && stage.ended.share.userId !== viewer
                ? displayName(stage.ended.share.userId)
                : undefined
            }
            pinned={stage.selection.mode === 'pinned'}
            fullscreen={stageFullscreen}
            onPinToggle={() => stage.togglePin()}
            onEnlargeToggle={() => setStageFullscreen((f) => !f)}
            onCollapse={() => stage.collapseEnded()}
            switcher={
              <ShareSwitcher
                shares={switcherShares}
                activeShareId={stage.selection.activeShareId}
                mode={stage.selection.mode}
                onSelect={(shareId) => stage.selectShare(shareId)}
              />
            }
          />
          {/* VM15: self-view demotes to the corner overlay while the stage
              dominates. In fullscreen the overlay follows the viewport. */}
          {overlaySelf ? (
            stageFullscreen ? (
              <div className="pointer-events-none fixed inset-0 z-[60]">
                <div className="pointer-events-auto">
                  <SelfView
                    state="live"
                    stream={localCameraStream}
                    speaking={viewer !== null && speaking.has(viewer)}
                    variant="overlay"
                    userId={viewer ?? 'self'}
                    onEnlarge={() => viewer && setSpotlightId(viewer)}
                  />
                </div>
              </div>
            ) : (
              <SelfView
                state="live"
                stream={localCameraStream}
                speaking={viewer !== null && speaking.has(viewer)}
                variant="overlay"
                userId={viewer ?? 'self'}
                onEnlarge={() => viewer && setSpotlightId(viewer)}
              />
            )
          ) : null}
        </div>
      ) : null}

      {/* Spotlight (VM21 tile activation): the enlarged participant fills the
          media area, the others collapse to the strip, Back returns. */}
      {spotlight !== null ? (
        <>
          <TileGrid participants={[spotlight]} announcement="" variant="grid" />
          <div className="flex items-center justify-between" data-testid={`call-spotlight-bar-${context}`}>
            <button
              type="button"
              className={ICON_BUTTON + ' text-text-muted'}
              aria-label="Back to grid"
              data-testid={`spotlight-back-${context}`}
              onClick={() => setSpotlightId(null)}
            >
              <span aria-hidden>←</span> Grid
            </button>
            <p className="text-xs text-text-muted">
              Spotlight — {spotlight.name}
            </p>
          </div>
          <TileGrid participants={grid.participants.filter((p) => p.userId !== spotlight.userId)} variant="strip" />
        </>
      ) : (
        /* VM16: the grid fills (no share) or demotes to the strip (share). */
        <TileGrid
          participants={grid.participants}
          announcement={announcement}
          variant={shareLive ? 'strip' : 'grid'}
          onEnlarge={(userId) => setSpotlightId(userId)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

export interface CallPanelProps {
  /** The channel whose call this panel renders. */
  channelId: string;
  /** U6 store (injectable for tests; app uses the module default). */
  store?: StateStore;
  /** Engine override (injectable for tests; defaults to the module engine). */
  engine?: CallEngine;
  /** Hide the surface (mobile sheet collapse / dock dismiss). */
  onClose?: () => void;
  /**
   * Override the responsive pick for the media composition (tests); defaults
   * to useIsMobileWidth (VM19).
   */
  mobile?: boolean;
  /**
   * Effective media capabilities (R17). When absent the panel fetches them
   * from GET /channels/{id}/call (all-true on failure; DM channels skip).
   */
  capabilities?: CallCapabilities;
  /** Test seam over the capabilities fetch. */
  fetchCapabilities?: () => Promise<CallCapabilities | null>;
  /** VM20: viewer lacks SEND_VIDEO — camera affordances pre-disabled + title. */
  canSendVideo?: boolean;
  /** VM20: viewer lacks SHARE_SCREEN — share affordances pre-disabled + title. */
  canShareScreen?: boolean;
}

export function CallPanel({
  channelId,
  store: storeProp,
  engine,
  onClose,
  mobile: mobileProp,
  capabilities: capabilitiesProp,
  fetchCapabilities,
  canSendVideo = true,
  canShareScreen = true,
}: CallPanelProps) {
  const store = storeProp ?? defaultStore;
  const e = engine ?? getCallEngine();
  const snapshot = useCallEngineState(e);
  const speakingAll = useSpeakingSet(e.speakingSubscribe, e.getSpeaking);
  // Call + roster slices only (lane D #17; was whole-store).
  const state = useStoreSlices(store, CALL_PANEL_SLICES);
  const responsiveMobile = useIsMobileWidth();
  const mobile = mobileProp ?? responsiveMobile;

  const voice = snapshot.voice;
  const viewer = state.currentUser?.id ?? null;
  const roster = selectCallRoster(state, channelId);
  // U10/R11: DM channels never render the call-log region (see the markup).
  const dmCallSurface =
    selectDmCall(state, channelId) !== undefined ||
    state.channels[channelId]?.type === 'dm';
  // Speaking rings only when THIS call is the engine's active call.
  const speaking =
    snapshot.channelId === channelId ? speakingAll : new Set<string>();
  const activeSurface =
    voice.status !== 'idle' ||
    voice.notice !== null ||
    snapshot.channelId === channelId;
  const legHeld =
    voice.status === 'connected' ||
    voice.status === 'connecting-media' ||
    voice.status === 'reconnecting';

  const capabilities = useCallCapabilities(channelId, {
    enabled: capabilitiesProp === undefined && !dmCallSurface,
    fetchCapabilities,
  });
  const effectiveCaps = capabilitiesProp ?? capabilities;

  const displayName = useCallback(
    (userId: string): string => {
      const member = state.membersById[userId];
      const nicknames = nicknamesForChannel(state, channelId);
      return displayNameOf(member && { ...member, nickname: nicknames?.[userId] ?? null }, userId.slice(-4));
    },
    [state, channelId],
  );

  const avatarUrl = useCallback(
    (userId: string): string | null => state.membersById[userId]?.avatar_url ?? null,
    [state.membersById],
  );

  const controlButtons = (context: string) => (
    // U10 extraction: the trio lives in CallControls now (DM calls reuse the
    // exact controls); markup is byte-identical to the U8 inline version.
    <CallControls engine={e} snapshot={snapshot} context={context} disabled={!activeSurface} />
  );

  return (
    <section
      className="flex h-full w-full min-w-0 flex-col bg-surface"
      aria-label="Call"
      data-testid="call-panel"
      data-channel-id={channelId}
      data-voice-status={voice.status}
    >
      {/* Header */}
      <div
        className="flex h-[58px] shrink-0 items-center gap-1 border-b border-line px-3"
        data-testid="call-header"
      >
        <span aria-hidden className="mr-1 text-text-muted">
          <PhoneIcon size={16} />
        </span>
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-text-primary" data-testid="call-title">
          Call
          {roster.length > 0 ? (
            <span className="ml-2 text-sm font-normal text-text-muted">
              {roster.length} {roster.length === 1 ? 'participant' : 'participants'}
            </span>
          ) : null}
        </h2>
        {onClose ? (
          <button
            type="button"
            className={ICON_BUTTON + ' text-text-muted'}
            aria-label="Close call panel"
            data-testid="call-close"
            onClick={onClose}
          >
            <span aria-hidden>✕</span>
          </button>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3" data-testid="call-body">
        {/* Composite state surfaces */}
        {voice.status === 'connecting-signaling' ? (
          <div className="flex items-center gap-2 text-sm text-text-muted" role="status" data-testid="call-state-connecting-signaling">
            <Spinner testId="call-spinner" />
            <span>Connecting to the call…</span>
          </div>
        ) : null}

        {voice.status === 'connecting-media' ? (
          <div className="flex items-center gap-2 text-sm text-text-muted" role="status" data-testid="call-state-connecting-media">
            <Spinner testId="call-spinner" />
            <span>Establishing voice…</span>
          </div>
        ) : null}

        {voice.status === 'reconnecting' ? (
          <div
            className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning"
            role="status"
            data-testid="call-state-reconnecting"
          >
            Reconnecting — your audio may pause briefly.
          </div>
        ) : null}

        {voice.status === 'permission-denied' ? (
          <div
            className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
            role="alert"
            data-testid="call-state-permission-denied"
          >
            <p>You don&apos;t have permission to be in this call.</p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                className={ICON_BUTTON + ' bg-surface-strong text-text-primary'}
                data-testid="call-retry"
                onClick={() => e.retry()}
              >
                Retry
              </button>
              <button
                type="button"
                className={ICON_BUTTON + ' text-text-muted'}
                data-testid="call-dismiss"
                onClick={() => e.dismiss()}
              >
                Dismiss
              </button>
            </div>
          </div>
        ) : null}

        {/* VM5 listen-only guidance: the leg SURVIVES a denied mic — offer
            the in-place upgrade (retryMic) rather than a teardown retry. */}
        {snapshot.listenOnly &&
        (voice.status === 'connected' || voice.status === 'connecting-media') ? (
          <div
            className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning"
            role="status"
            data-testid="call-state-listen-only"
          >
            <p className="font-semibold">Listening only</p>
            <p className="mt-1 text-text-primary">
              Microphone access is blocked, so you can hear the call but not speak. Allow the
              microphone for this site (padlock icon in the address bar) and check your OS settings
              — then retry.
            </p>
            <button
              type="button"
              className={ICON_BUTTON + ' mt-2 bg-surface-strong text-text-primary'}
              data-testid="call-retry-mic"
              onClick={() => e.retryMic()}
            >
              Retry microphone
            </button>
          </div>
        ) : null}

        {/* VM8: the screen share ended natively (stop bar / closed window /
            OS revoke) — mid-call notice, the leg is unaffected. */}
        {voice.notice === 'share-ended' && voice.status !== 'idle' ? (
          <div
            className="rounded-md border border-line bg-surface-hover px-3 py-2 text-sm text-text-muted"
            role="status"
            data-testid="call-notice-share-ended"
          >
            Your screen share ended.
            <button
              type="button"
              className={ICON_BUTTON + ' ml-2 text-text-primary'}
              aria-label="Dismiss share ended notice"
              onClick={() => e.dismiss()}
            >
              OK
            </button>
          </div>
        ) : null}

        {/* F5: this host cannot run screen capture at all (e.g. WKWebView's
            NotSupportedError) and the user asked to share — same banner
            shape, with the KDV3 plain handoff: open the web app, nothing
            fancier. The picker-cancel path never reaches this notice. */}
        {voice.notice === 'share-unavailable' && voice.status !== 'idle' ? (
          <div
            className="rounded-md border border-line bg-surface-hover px-3 py-2 text-sm text-text-muted"
            role="status"
            data-testid="call-notice-share-unavailable"
          >
            Screen sharing isn't available in this app.
            <button
              type="button"
              className={ICON_BUTTON + ' ml-2 text-text-primary'}
              aria-label="Open the web app to share your screen"
              data-testid="call-notice-share-unavailable-handoff"
              onClick={() => {
                void openWebApp();
              }}
            >
              Open in web app
            </button>
            <button
              type="button"
              className={ICON_BUTTON + ' ml-2 text-text-primary'}
              aria-label="Dismiss screen sharing unavailable notice"
              onClick={() => e.dismiss()}
            >
              OK
            </button>
          </div>
        ) : null}

        {/* KTD6: the room unpublished the source on a rights revocation —
            mid-call notice, the leg itself is unaffected (share-ended's
            shape, "permission changed" copy). */}
        {voice.notice === 'camera-stopped' && voice.status !== 'idle' ? (
          <div
            className="rounded-md border border-line bg-surface-hover px-3 py-2 text-sm text-text-muted"
            role="status"
            data-testid="call-notice-camera-stopped"
          >
            Camera stopped — permission changed.
            <button
              type="button"
              className={ICON_BUTTON + ' ml-2 text-text-primary'}
              aria-label="Dismiss camera stopped notice"
              onClick={() => e.dismiss()}
            >
              OK
            </button>
          </div>
        ) : null}
        {voice.notice === 'share-stopped' && voice.status !== 'idle' ? (
          <div
            className="rounded-md border border-line bg-surface-hover px-3 py-2 text-sm text-text-muted"
            role="status"
            data-testid="call-notice-share-stopped"
          >
            Screen share stopped — permission changed.
            <button
              type="button"
              className={ICON_BUTTON + ' ml-2 text-text-primary'}
              aria-label="Dismiss share stopped notice"
              onClick={() => e.dismiss()}
            >
              OK
            </button>
          </div>
        ) : null}

        {voice.status === 'voice-unavailable' ? (
          <div
            className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
            role="alert"
            data-testid="call-state-voice-unavailable"
          >
            <p className="font-semibold">Voice connection failed</p>
            <p className="mt-1 text-text-primary">
              The call could not keep a stable media connection. Check your network and retry.
            </p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                className={ICON_BUTTON + ' bg-surface-strong text-text-primary'}
                data-testid="call-retry"
                onClick={() => e.retry()}
              >
                Retry
              </button>
              <button
                type="button"
                className={ICON_BUTTON + ' text-text-muted'}
                data-testid="call-dismiss"
                onClick={() => e.dismiss()}
              >
                Dismiss
              </button>
            </div>
          </div>
        ) : null}

        {voice.status === 'offline' ? (
          <div
            className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning"
            role="alert"
            data-testid="call-state-offline"
          >
            <p>Connection lost — the call ended on this device.</p>
            <button
              type="button"
              className={ICON_BUTTON + ' mt-2 text-text-primary'}
              data-testid="call-dismiss"
              onClick={() => e.dismiss()}
            >
              OK
            </button>
          </div>
        ) : null}

        {voice.status === 'idle' && voice.notice === 'displaced' ? (
          <div
            className="rounded-md border border-line bg-surface-hover px-3 py-2 text-sm text-text-muted"
            role="status"
            data-testid="call-state-displaced"
          >
            You joined this call on another device.
            <button
              type="button"
              className={ICON_BUTTON + ' ml-2 text-text-primary'}
              data-testid="call-dismiss"
              onClick={() => e.dismiss()}
            >
              OK
            </button>
          </div>
        ) : null}

        {/* V2 media area (VM16): grid + stage while a leg is held. */}
        {legHeld ? (
          <CallMediaArea
            channelId={channelId}
            store={store}
            engine={e}
            snapshot={snapshot}
            speaking={speaking}
            mobile={mobile}
            reconnecting={voice.status === 'reconnecting'}
            displayName={displayName}
            context="panel"
          />
        ) : null}

        {/* Roster (connecting-media onward, while a leg is being held) */}
        {legHeld ? (
          <>
            {voice.status === 'connected' && roster.length <= 1 ? (
              <div className="rounded-md border border-line bg-surface-hover px-3 py-4 text-center" data-testid="call-alone-empty">
                <p className="text-sm font-semibold text-text-primary">You&apos;re the only one here</p>
                <p className="mt-1 text-sm text-text-muted">
                  Others can join from the channel — or summon them with a ring.
                </p>
                <button
                  type="button"
                  className={ICON_BUTTON + ' mt-2 bg-surface-strong text-text-primary'}
                  aria-label="Ring the room"
                  data-testid="call-ring-room"
                  onClick={() => e.ring()}
                >
                  🔔 Ring the room
                </button>
              </div>
            ) : null}

            <ul className="flex flex-col gap-1" aria-label="Call participants" data-testid="call-roster">
              {roster.map((participant) => {
                const isSelf = participant.user_id === viewer;
                const isSpeaking = speaking.has(participant.user_id);
                return (
                  <li
                    key={participant.user_id}
                    className="flex min-h-10 items-center gap-2 rounded-md px-2 text-sm"
                    data-testid="call-roster-row"
                    data-user-id={participant.user_id}
                    data-speaking={isSpeaking || undefined}
                  >
                    <Avatar
                      id={participant.user_id}
                      name={displayName(participant.user_id)}
                      src={avatarUrl(participant.user_id)}
                      size={28}
                      className={
                        'ring-2 ' +
                        (isSpeaking
                          ? 'ring-[var(--color-presence-online)]'
                          : 'ring-transparent')
                      }
                    />
                    <span className="min-w-0 flex-1 truncate text-text-primary">
                      {isSelf ? 'You' : displayName(participant.user_id)}
                    </span>
                    <RosterSourceMarks sources={participant.sources} />
                    <MuteMark muted={participant.mute} />
                    <DeafenMark deafened={participant.deafen} />
                    {isSelf ? (
                      // The roster's own row doubles as the control surface —
                      // mute/deafen/leave reachable from the roster itself.
                      <span className="flex items-center gap-1">{controlButtons('roster')}</span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}

        {/* Controls bar (persistent for the joined states) */}
        {voice.status === 'connected' || voice.status === 'reconnecting' ? (
          <div
            className="mt-auto flex shrink-0 flex-wrap items-center justify-center gap-2 border-t border-line pt-3"
            data-testid="call-controls"
          >
            {controlButtons('panel')}
            <PublishControls
              engine={e}
              snapshot={snapshot}
              capabilities={effectiveCaps}
              canSendVideo={canSendVideo}
              canShareScreen={canShareScreen}
              mobile={mobile}
              context="panel"
            />
          </div>
        ) : null}

        {/* The call-log pane — U9 fills the reserved region with the
            standing log (thread view + boundaries + thread composer).
            Calls plan U10 (R11): DM channels never render the log — they
            keep no standing thread and no durable artifact; the DM header
            indicator is the DM call surface instead (AM18). Belt-and-braces
            on top of the shell's dock gate: a DM channel (typed `dm`) or a
            live DM call suppresses the region even if a host mounts the
            panel anyway. */}
        {!dmCallSurface ? <CallLogPane channelId={channelId} store={store} /> : null}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Responsive surface: desktop dock vs mobile bottom sheet (AM18)
// ---------------------------------------------------------------------------

export interface CallPanelSurfaceProps extends CallPanelProps {
  /** Override the responsive pick (tests); defaults to useIsMobileWidth. */
  forceMobile?: boolean;
}

export function CallPanelSurface({ forceMobile, ...panelProps }: CallPanelSurfaceProps) {
  const isMobile = useIsMobileWidth();
  const sheet = forceMobile ?? isMobile;

  if (!sheet) {
    // Desktop: the thread-dock pattern — same pane, narrower, docked beside
    // the message pane (the shell owns the split container).
    return (
      <div className="call-dock" data-testid="call-dock">
        {/* Hardening plan 7.4: a render throw in the call panel remounts the
            panel under the list boundary's cap instead of taking the shell
            (and the call's route/draft) down with it. The dock geometry
            stays: only the panel's own contents are guarded. */}
        <ListErrorBoundary surface="call panel" testIdPrefix="call">
          <CallPanel {...panelProps} mobile={forceMobile} />
        </ListErrorBoundary>
      </div>
    );
  }

  // Mobile (<768px): a bottom sheet overlay above the message pane. Radix
  // Dialog gives the focus trap + Esc handling + focus return for free.
  return (
    <Dialog open onOpenChange={(open) => {
      if (!open) panelProps.onClose?.();
    }}>
      <DialogContent
        showCloseButton={false}
        overlayClassName="call-sheet-overlay"
        overlayTestId="call-sheet-overlay"
        className="call-sheet"
        aria-label="Call"
        data-testid="call-sheet"
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          panelProps.onClose?.();
        }}
      >
        <DialogTitle className="sr-only">Call</DialogTitle>
        <ListErrorBoundary surface="call panel" testIdPrefix="call">
          <CallPanel {...panelProps} mobile={forceMobile} />
        </ListErrorBoundary>
      </DialogContent>
    </Dialog>
  );
}
