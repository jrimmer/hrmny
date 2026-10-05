/**
 * @cytale/web — the DM call indicator (calls plan U10, R11/AM7/AM17/AM18;
 * calls V2 plan U5b — VM17's full-media DM frame).
 *
 * THE DM call surface: a phone affordance in the DM conversation header that
 * starts a call (op-22 start on the DM channel — the server rings the target
 * by default, AM7, so no ring modifier exists here) and, while a call is
 * live, EXPANDS (AM18). V2 (KDV1/R10): the connected expansion is the INLINE
 * MEDIA BLOCK (VM17) — docked under the DM header, stage stacked above the
 * tile pair, with the compact controls in its foot — dismissible back to the
 * compact indicator strip. DM calls render no sidebar slot, no call log, no
 * timeline marker anywhere (R11) — by construction in those surfaces; this
 * component is the only DM call UI.
 *
 * States (states-first DoD, UX_SPEC §9 — every one has a surface here):
 *
 *   idle              → "Call" phone button (participation IS the authz —
 *                       no START_CALL gating, nothing hidden)
 *   incoming-ring     → ring entry + live DM call: ringing affordance with
 *                       Join / Decline (the full ring sound/toast UX is U11;
 *                       this is the header's incoming state)
 *   in-call           → VM17 media block (connected): stage + tile pair +
 *                       controls; connecting spinners, reconnecting banner,
 *                       displaced notice, voice-unavailable alert, offline
 *                       alert render in the compact expansion (U8's composite
 *                       engine states, AM14) — as does the dismissed block
 *   live-not-joined   → a live DM call this client isn't in: "Join" (AM17's
 *                       button-flip; e.g. after Decline, or a call learned
 *                       from CALL_SYNC without a ring)
 *   missed-call       → ring entry whose call ended without this client
 *                       joining: missed-call glyph + "Call back" (no message
 *                       artifact — R11). "View" = the DM channel being the
 *                       active channel: this component mounts exactly then,
 *                       so a missed state already present at mount is
 *                       consumed (clearCallRing) on arrival — the indicator
 *                       stays visible only when the miss happened while the
 *                       conversation was already open.
 *   caller-no-answer  → transient "didn't answer" note for the caller whose
 *                       ring was never joined (recipient offline; call ended
 *                       or swept) — dismissed, or replaced by the next call.
 *
 * CAPABILITY POSTURE (V2): DM rooms skip the workspace/channel capability
 * checks (U8 — participation is authorization; capabilities are all-true on
 * the REST surface for DMs), so the ONLY gating path here is VM10's honest
 * webview/platform affordance: on mobile the screenshare control always
 * renders — visibly disabled — and activates an explanatory dialog.
 *
 * MOBILE CHOICE (recorded per the unit brief): the expansion is the compact
 * anchored strip on BOTH breakpoints — no bottom sheet, no full panel. The
 * media block is width-capped under the header at any width; AM18 explicitly
 * prefers the compact expansion for DMs.
 *
 * WCAG: real buttons (≥40×40 hit areas, focus-visible rings), aria-pressed
 * toggles (via CallControls), role=status/alert on every state surface,
 * keyboard-operable throughout (Join/Decline/Call back/Leave are native
 * buttons).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  clearCallRing,
  defaultStore,
  selectCallRing,
  selectCallRoster,
  selectCameraPublishers,
  selectDmCall,
  selectParticipantSources,
  selectScreenSharers,
  type StateStore,
} from '@cytale/state';

import { useIsMobileWidth } from '../../../app/layout/useIsMobileWidth.js';
import { useStoreSlices } from '../../../app/useStoreSelector.js';
import { PhoneIcon, Spinner } from '../../../app/ui/icons.js';

import { CallControls } from '../CallControls.js';
import { DM_CALL_CAPABILITIES } from '../capability/callCapabilities.js';
import { MEDIA_DISABLED_TITLE, useMediaEnabled } from '../useMediaEnabled.js';
import { useSpeakingSet } from '../useSpeaking.js';
import {
  computeGridParticipants,
  mediaStreamForTrack,
  useCallEngineState,
  useCallVideoStreams,
  useCallVideoWant,
  useStageSelection,
  type LiveShareView,
} from '../useCall.js';
import type { CallEngine, CallEngineSnapshot } from '../useCallMedia.js';
import { getCallEngine } from '../useCallMedia.js';
import { PublishControls } from '../CallPanel.js';
import {
  SelfView,
  ShareSwitcher,
  Stage,
  TileGrid,
  type StageShare,
  type SwitcherShare,
} from '../video/index.js';
import { displayNameOf } from '@cytale/domain';

// ---------------------------------------------------------------------------
// Presentational pieces (house patterns)
// ---------------------------------------------------------------------------

const HEADER_ACTION =
  'flex min-h-10 min-w-10 items-center justify-center gap-1.5 rounded-md px-2.5 ' +
  'text-sm font-medium text-text-muted transition-colors duration-[var(--duration-control)] ' +
  'hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]';

const EXPANSION_ACTION =
  'flex min-h-10 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium ' +
  'transition-colors duration-[var(--duration-control)] hover:bg-surface-hover ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]';

/** The missed-call glyph: a phone with a slash — visually distinct from Call. */
function MissedCallIcon({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path
        d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.2.2 2.4.6 3.6.1.3 0 .7-.2 1l-2.3 2.2z"
        fill="currentColor"
      />
      <path d="M3.7 2.3 21.7 20.3l-1.4 1.4L2.3 3.7z" fill="currentColor" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// The indicator
// ---------------------------------------------------------------------------

/** What `DmCallIndicator` reads off the store (lane D #17). */
const DM_INDICATOR_SLICES = [
  'currentUser',
  'channels',
  'membersById',
  'callRingByChannel',
  'dmCallByChannel',
  'callByChannel',
] as const;

/** What the expanded DM media block reads off the store (lane D #17). */
const DM_MEDIA_SLICES = ['currentUser', 'membersById', 'dmCallByChannel', 'callByChannel'] as const;

export interface DmCallIndicatorProps {
  /** The DM channel whose header renders this indicator. */
  channelId: string;
  /** U6 store (injectable for tests; app uses the module default). */
  store?: StateStore;
  /** Engine override (injectable for tests; defaults to the module engine). */
  engine?: CallEngine;
}

export function DmCallIndicator({
  channelId,
  store: storeProp,
  engine: engineProp,
}: DmCallIndicatorProps) {
  const store = storeProp ?? defaultStore;
  const engine = engineProp ?? getCallEngine();
  const snapshot = useCallEngineState(engine);
  // The slices this indicator's selectors read (lane D #17; was whole-store).
  const state = useStoreSlices(store, DM_INDICATOR_SLICES);
  const isMobile = useIsMobileWidth();

  const viewer = state.currentUser?.id ?? null;
  const ring = selectCallRing(state, channelId);
  const dmCall = selectDmCall(state, channelId);

  // VM17: the connected expansion is the inline media block, dismissible to
  // the compact indicator strip. A fresh leg (new call) un-dismisses.
  const [mediaDismissed, setMediaDismissed] = useState(false);
  const holdingLeg =
    snapshot.channelId === channelId &&
    (snapshot.voice.status !== 'idle' || snapshot.voice.notice !== null);
  useEffect(() => {
    if (!holdingLeg) setMediaDismissed(false);
  }, [holdingLeg]);

  // The engine holds THIS channel's leg (or a terminal notice about it).
  const engineHere = snapshot.channelId === channelId;

  const rosterIds = dmCall ? Object.keys(dmCall.participants) : [];
  const joinedInRoster = viewer !== null && dmCall?.participants[viewer] !== undefined;
  const peerInCall = rosterIds.find((id) => id !== viewer) ?? null;

  // Peer display: DM recipients when hydrated, else the live roster / ring
  // sender, else generic copy (the name is cosmetic — never load-bearing).
  const recipient = state.channels[channelId]?.recipients?.find((r) => r.id !== viewer)?.id;
  const peerId = recipient ?? peerInCall ?? ring?.from_user ?? null;
  const peerMember = peerId !== null ? state.membersById[peerId] : undefined;
  const peerName = displayNameOf(peerMember, 'them');

  // -- caller-side "no answer" latch (transient unavailable surface) ----------
  // While the DM call is live we latch whether THIS client held a leg and
  // whether the peer ever joined; at the live→ended transition a caller whose
  // ring was never answered gets the note (recipient offline; call swept or
  // left). Cleared by dismissal, a new call, or leaving the conversation.
  const seenRef = useRef<{ callId: string; self: boolean; peer: boolean } | null>(null);
  const [noAnswer, setNoAnswer] = useState<{ callId: string } | null>(null);

  useEffect(() => {
    if (dmCall !== undefined) {
      if (seenRef.current?.callId !== dmCall.call_id) {
        seenRef.current = { callId: dmCall.call_id, self: false, peer: false };
      }
      const seen = seenRef.current;
      if (seen) {
        if (joinedInRoster || holdingLeg) seen.self = true;
        if (peerInCall !== null) seen.peer = true;
      }
      return;
    }
    const seen = seenRef.current;
    seenRef.current = null;
    if (seen && seen.self && !seen.peer) {
      setNoAnswer({ callId: seen.callId });
    }
  }, [dmCall, joinedInRoster, peerInCall, holdingLeg]);

  // -- missed-call clear-on-view (U10 brief: "view" = the DM channel being
  // the active channel — this component mounts exactly then). A ring entry
  // whose call is already gone at mount is consumed on arrival; a miss that
  // happens WHILE the conversation is open stays visible (no remount) until
  // the user re-opens the conversation, calls back, or declines.
  useEffect(() => {
    const s = store.getState();
    if (
      s.callRingByChannel[channelId] !== undefined &&
      s.dmCallByChannel[channelId] === undefined
    ) {
      clearCallRing(store, channelId);
    }
    // Mount-only by design: opening the conversation is the consuming "view".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  // Ticket #124: the media master switch (READY → store). While this client
  // HOLDS a leg the call runs out naturally (a disable never tears it down),
  // so the in-call surfaces stay; every NEW call action — start, join,
  // call-back — refuses server-side and renders the honest visible-disabled
  // state here instead.
  const mediaEnabled = useMediaEnabled(store);
  const mediaDisabled = !mediaEnabled && !holdingLeg;

  // -- actions ----------------------------------------------------------------

  const startCall = () => {
    setNoAnswer(null); // a fresh call replaces the no-answer note
    engine.start(channelId); // AM7: the server rings DM targets by default
  };
  const joinCall = () => {
    setNoAnswer(null);
    clearCallRing(store, channelId); // answered — the ring is consumed
    engine.join(channelId);
  };
  const declineRing = () => {
    clearCallRing(store, channelId); // declined ≠ missed (R11's derivation)
  };
  const callBack = () => {
    clearCallRing(store, channelId);
    startCall();
  };

  // -- mode resolution (ordered; first match wins) ------------------------------
  //   holdingLeg    → in-call expansion (engine composite states)
  //   ring && call  → incoming ring (Join/Decline in the expansion)
  //   call          → live, not joined (Join — AM17's flip)
  //   ring          → missed (Call back)
  //   noAnswer      → transient caller note (still shows the Call button)
  //   otherwise     → idle Call button

  const missed = ring !== undefined && dmCall === undefined;
  const incoming = ring !== undefined && dmCall !== undefined && !holdingLeg;

  return (
    <div
      className="dm-call-indicator relative ml-auto flex shrink-0 items-center gap-1"
      data-testid="dm-call-indicator"
      data-channel-id={channelId}
      data-state={
        holdingLeg
          ? snapshot.voice.status === 'idle' && snapshot.voice.notice !== null
            ? `notice-${snapshot.voice.notice}`
            : snapshot.voice.status
          : incoming
            ? 'ringing'
            : dmCall !== undefined
              ? 'live'
              : missed
                ? 'missed'
                : 'idle'
      }
    >
      {/* -- collapsed header affordances ---------------------------------- */}

      {holdingLeg ? (
        // In call: the phone stays lit as the expansion's anchor (the state
        // itself is announced by the expansion's content below).
        <span
          aria-hidden
          className={HEADER_ACTION + ' pointer-events-none text-accent'}
          data-testid="dm-call-active"
        >
          <PhoneIcon />
        </span>
      ) : mediaDisabled ? (
        // Ticket #124: the honest disabled state — visible, inert, explained
        // (states-first: hidden-because-disabled ≠ not-built). Wins over the
        // join/live/missed arms: the server refuses every NEW call action.
        <button
          type="button"
          className={HEADER_ACTION + ' cursor-not-allowed opacity-50'}
          aria-label={MEDIA_DISABLED_TITLE}
          aria-disabled="true"
          title={MEDIA_DISABLED_TITLE}
          data-testid="dm-call-disabled"
          disabled
        >
          <PhoneIcon />
          <span className="hidden sm:inline">Calls off</span>
        </button>
      ) : dmCall !== undefined ? (
        <button
          type="button"
          className={HEADER_ACTION}
          aria-label="Join call"
          title="Join call"
          data-testid="dm-call-join"
          onClick={joinCall}
        >
          <PhoneIcon />
          <span className="hidden sm:inline">Join</span>
        </button>
      ) : (
        <button
          type="button"
          className={HEADER_ACTION + (missed ? ' text-accent hover:text-accent' : '')}
          aria-label={missed ? 'Missed call — call back' : 'Call'}
          title={missed ? 'Missed call — call back' : 'Call'}
          data-testid={missed ? 'dm-call-missed' : 'dm-call-start'}
          onClick={missed ? callBack : startCall}
        >
          {missed ? <MissedCallIcon /> : <PhoneIcon />}
          <span className="hidden sm:inline">{missed ? 'Missed call' : 'Call'}</span>
        </button>
      )}

      {/* -- the expansion (anchored strip: every active state's surface) --- */}

      {incoming ? (
        <div
          className="dm-call-popover"
          data-testid="dm-call-incoming"
          role="region"
          aria-label="Incoming call"
        >
          <p className="flex items-center gap-2 px-1 pb-2 text-sm font-medium text-text-primary">
            <span aria-hidden className="relative flex h-2.5 w-2.5" data-testid="dm-call-ring-pulse">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-accent" />
            </span>
            Incoming call from {peerName}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className={
                EXPANSION_ACTION +
                (mediaDisabled
                  ? ' cursor-not-allowed bg-surface-strong text-text-primary opacity-50'
                  : ' bg-surface-strong text-text-primary')
              }
              aria-label={mediaDisabled ? MEDIA_DISABLED_TITLE : 'Join call'}
              title={mediaDisabled ? MEDIA_DISABLED_TITLE : undefined}
              aria-disabled={mediaDisabled || undefined}
              data-testid="dm-call-incoming-join"
              disabled={mediaDisabled}
              onClick={joinCall}
            >
              <PhoneIcon size={14} />
              Join
            </button>
            <button
              type="button"
              className={EXPANSION_ACTION + ' text-text-muted'}
              aria-label="Decline call"
              data-testid="dm-call-incoming-decline"
              onClick={declineRing}
            >
              <MissedCallIcon size={14} />
              Decline
            </button>
          </div>
        </div>
      ) : null}

      {missed ? (
        <div className="dm-call-popover" data-testid="dm-call-missed-panel" role="status">
          <p className="flex items-center gap-2 px-1 pb-2 text-sm font-medium text-text-primary">
            <span aria-hidden className="text-accent">
              <MissedCallIcon size={14} />
            </span>
            Missed call from {peerName}
          </p>
          <button
            type="button"
            className={
              EXPANSION_ACTION +
              (mediaDisabled
                ? ' cursor-not-allowed bg-surface-strong text-text-primary opacity-50'
                : ' bg-surface-strong text-text-primary')
            }
            aria-label={mediaDisabled ? MEDIA_DISABLED_TITLE : 'Call back'}
            title={mediaDisabled ? MEDIA_DISABLED_TITLE : undefined}
            aria-disabled={mediaDisabled || undefined}
            data-testid="dm-call-callback"
            disabled={mediaDisabled}
            onClick={callBack}
          >
            <PhoneIcon size={14} />
            Call back
          </button>
        </div>
      ) : null}

      {holdingLeg ? (
        snapshot.voice.status === 'connected' && !mediaDismissed ? (
          // VM17: the connected expansion IS the inline media block — stage
          // stacked above the tile pair, controls in the foot, dismissible.
          <DmMediaBlock
            channelId={channelId}
            store={store}
            engine={engine}
            snapshot={snapshot}
            peerName={peerName}
            peerInCall={peerInCall !== null}
            mobile={isMobile}
            onCollapse={() => setMediaDismissed(true)}
          />
        ) : (
          <DmCallExpansion
            engine={engine}
            snapshot={snapshot}
            peerName={peerName}
            peerInCall={peerInCall !== null}
          />
        )
      ) : null}

      {noAnswer !== null && !holdingLeg ? (
        <div className="dm-call-popover" data-testid="dm-call-no-answer" role="status">
          <p className="px-1 pb-2 text-sm text-text-muted">
            <span className="font-medium text-text-primary">{peerName}</span> didn&apos;t answer.
          </p>
          <button
            type="button"
            className={EXPANSION_ACTION + ' text-text-muted'}
            aria-label="Dismiss"
            data-testid="dm-call-no-answer-dismiss"
            onClick={() => setNoAnswer(null)}
          >
            OK
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The in-call expansion (U8's composite states, compact form — AM18)
// ---------------------------------------------------------------------------

function DmCallExpansion({
  engine,
  snapshot,
  peerName,
  peerInCall,
}: {
  engine: CallEngine;
  snapshot: CallEngineSnapshot;
  peerName: string;
  peerInCall: boolean;
}) {
  const voice = snapshot.voice;
  // U8 parity: controls render in the joined states (connected/reconnecting).
  const controlsAllowed = voice.status === 'connected' || voice.status === 'reconnecting';

  return (
    <div
      className="dm-call-popover"
      data-testid="dm-call-expansion"
      data-voice-status={voice.status}
    >
      {/* connecting (both legs) — spinner + text */}
      {voice.status === 'connecting-signaling' ? (
        <p
          className="flex items-center gap-2 px-1 py-1 text-sm text-text-muted"
          role="status"
          data-testid="dm-call-state-connecting-signaling"
        >
          <Spinner testId="dm-call-spinner" />
          <span>Calling {peerName}…</span>
        </p>
      ) : null}
      {voice.status === 'connecting-media' ? (
        <p
          className="flex items-center gap-2 px-1 py-1 text-sm text-text-muted"
          role="status"
          data-testid="dm-call-state-connecting-media"
        >
          <Spinner testId="dm-call-spinner" />
          <span>Establishing voice…</span>
        </p>
      ) : null}

      {/* reconnecting — persistent status banner */}
      {voice.status === 'reconnecting' ? (
        <p
          className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning"
          role="status"
          data-testid="dm-call-state-reconnecting"
        >
          Reconnecting — your audio may pause briefly.
        </p>
      ) : null}

      {/* permission-denied (participation itself is the DM authz, so only
          forced-leave lands here) */}
      {voice.status === 'permission-denied' ? (
        <div
          className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
          role="alert"
          data-testid="dm-call-state-permission-denied"
        >
          <p>You don&apos;t have permission to be in this call.</p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className={EXPANSION_ACTION + ' bg-surface-strong text-text-primary'}
              data-testid="dm-call-retry"
              onClick={() => engine.retry()}
            >
              Retry
            </button>
            <button
              type="button"
              className={EXPANSION_ACTION + ' text-text-muted'}
              data-testid="dm-call-dismiss"
              onClick={() => engine.dismiss()}
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      {/* VM5 listen-only guidance (calls V2): a denied mic degrades the DM
          leg to listen-only — it survives, retryMic upgrades in place. */}
      {snapshot.listenOnly &&
      (voice.status === 'connected' || voice.status === 'connecting-media') ? (
        <div
          className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning"
          role="status"
          data-testid="dm-call-state-listen-only"
        >
          <p className="font-semibold">Listening only</p>
          <p className="mt-1 text-text-primary">
            Microphone access is blocked — you can hear this call but not speak. Allow the
            microphone for this site, then retry.
          </p>
          <button
            type="button"
            className={EXPANSION_ACTION + ' mt-2 bg-surface-strong text-text-primary'}
            data-testid="dm-call-retry-mic"
            onClick={() => engine.retryMic()}
          >
            Retry microphone
          </button>
        </div>
      ) : null}

      {/* voice-unavailable — alert + retry */}
      {voice.status === 'voice-unavailable' ? (
        <div
          className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
          role="alert"
          data-testid="dm-call-state-voice-unavailable"
        >
          <p className="font-semibold">Voice connection failed</p>
          <p className="mt-1 text-text-primary">
            The call could not keep a stable media connection. Check your network and retry.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className={EXPANSION_ACTION + ' bg-surface-strong text-text-primary'}
              data-testid="dm-call-retry"
              onClick={() => engine.retry()}
            >
              Retry
            </button>
            <button
              type="button"
              className={EXPANSION_ACTION + ' text-text-muted'}
              data-testid="dm-call-dismiss"
              onClick={() => engine.dismiss()}
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      {/* offline — teardown notice */}
      {voice.status === 'offline' ? (
        <div
          className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning"
          role="alert"
          data-testid="dm-call-state-offline"
        >
          <p>Connection lost — the call ended on this device.</p>
          <button
            type="button"
            className={EXPANSION_ACTION + ' mt-1 text-text-primary'}
            data-testid="dm-call-dismiss"
            onClick={() => engine.dismiss()}
          >
            OK
          </button>
        </div>
      ) : null}

      {/* displaced (AM8) — joined on another device */}
      {voice.status === 'idle' && voice.notice === 'displaced' ? (
        <div
          className="rounded-md border border-line bg-surface-hover px-3 py-2 text-sm text-text-muted"
          role="status"
          data-testid="dm-call-state-displaced"
        >
          You joined this call on another device.
          <button
            type="button"
            className={EXPANSION_ACTION + ' ml-2 text-text-primary'}
            data-testid="dm-call-dismiss"
            onClick={() => engine.dismiss()}
          >
            OK
          </button>
        </div>
      ) : null}

      {/* in-call: ringing note while the peer hasn't joined (phone
          semantics — the DM ring defaults on but the target may be
          offline/away) */}
      {(voice.status === 'connected' ||
        voice.status === 'connecting-media' ||
        voice.status === 'reconnecting') &&
      !peerInCall ? (
        <p
          className="flex items-center gap-2 px-1 py-1 text-sm text-text-muted"
          role="status"
          data-testid="dm-call-ringing-peer"
        >
          <Spinner testId="dm-call-spinner" />
          <span>Ringing {peerName}…</span>
        </p>
      ) : null}

      {/* the compact control set (AM18 — U8's exact trio) */}
      {controlsAllowed ? (
        <div className="flex items-center justify-center gap-2 pt-1" data-testid="dm-call-controls">
          <CallControls engine={engine} snapshot={snapshot} context="dm" />
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The VM17 inline media block (calls V2 plan U5b — KDV1/R10)
// ---------------------------------------------------------------------------

/**
 * The DM frame's inline media block: docked under the DM header (messages
 * scroll beneath), the stage stacked above the tile pair (VM17's geometry),
 * the compact controls + publish affordances in its foot. Dismiss collapses
 * to the compact indicator; no log, no slot, no artifacts (R11) — the block
 * renders ONLY media surfaces.
 */
function DmMediaBlock({
  channelId,
  store,
  engine,
  snapshot,
  peerName,
  peerInCall,
  mobile,
  onCollapse,
}: {
  channelId: string;
  store: StateStore;
  engine: CallEngine;
  snapshot: CallEngineSnapshot;
  peerName: string;
  peerInCall: boolean;
  mobile: boolean;
  onCollapse(): void;
}) {
  // The slices the expanded media block reads (lane D #17; was whole-store).
  const state = useStoreSlices(store, DM_MEDIA_SLICES);
  const viewer = state.currentUser?.id ?? null;
  const streams = useCallVideoStreams(engine);
  const want = useCallVideoWant(engine);
  const speakingAll = useSpeakingSet(engine.speakingSubscribe, engine.getSpeaking);

  const roster = useMemo(() => selectCallRoster(state, channelId), [state, channelId]);
  const rosterIds = useMemo(() => new Set(roster.map((p) => p.user_id)), [roster]);
  const cameraPublishers = useMemo(
    () => selectCameraPublishers(state, channelId),
    [state, channelId],
  );
  const nameOf = useCallback(
    (userId: string): string => {
      if (userId === viewer) return 'You';
      const member = state.membersById[userId];
      return displayNameOf(member, userId.slice(-4));
    },
    [state.membersById, viewer],
  );

  // VM22 stage selection over the DM call's sharers (identical machine).
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

  const [stageFullscreen, setStageFullscreen] = useState(false);
  useEffect(() => {
    if (mobile && shareLive) setStageFullscreen(true);
  }, [mobile, shareLive]);

  const localCameraStream = useMemo(() => {
    if (viewer === null || !snapshot.publishing.camera) return null;
    const track = engine.getLocalPublishTrack('camera');
    return track !== null ? mediaStreamForTrack(track) : null;
  }, [engine, viewer, snapshot.publishing.camera, snapshot.localVideoRev]);

  const grid = useMemo(
    () =>
      computeGridParticipants({
        rosterIds: roster.map((p) => p.user_id),
        cameraPublishers,
        nameOf,
        viewerId: viewer,
        streams,
        localCameraStream,
        speaking: speakingAll,
        budget: want.tiles,
        excludeSelf: shareLive,
        frozenAll: snapshot.voice.status === 'reconnecting',
      }),
    [roster, cameraPublishers, nameOf, viewer, streams, localCameraStream, speakingAll, want.tiles, shareLive, snapshot.voice.status],
  );

  const staged: StageShare | null = useMemo(() => {
    if (stage.staged === null) return null;
    const s = stage.staged;
    const ownTrack = s.userId === viewer ? engine.getLocalPublishTrack('screen') : null;
    return {
      shareId: s.userId,
      presenterId: s.userId,
      presenterName: s.userId === viewer ? 'You' : peerName,
      stream:
        ownTrack !== null ? mediaStreamForTrack(ownTrack) : streams.get(`${s.userId}:screen`),
      shareAudio: s.shareAudio,
    };
  }, [stage.staged, viewer, engine, streams, peerName, snapshot.localVideoRev]);

  const switcherShares = useMemo<SwitcherShare[]>(
    () =>
      sharers.map((s) => ({
        shareId: s.userId,
        presenterName: s.userId === viewer ? 'You' : nameOf(s.userId),
      })),
    [sharers, viewer, nameOf],
  );

  return (
    <div
      className="dm-media-block absolute right-0 top-full z-40 flex w-[min(560px,calc(100vw-2rem))] flex-col gap-2 popover p-2"
      data-testid="dm-media-block"
      data-share-live={shareLive || undefined}
      role="region"
      aria-label="Call media"
    >
      {/* VM17: the stage stacks above the tile pair while a share is live. */}
      {shareLive || stage.ended !== null ? (
        <div className="relative flex max-h-[48vh] min-h-[180px] flex-col [&>.video-stage]:flex-1">
          <Stage
            share={staged}
            endedReason={stage.ended?.reason ?? null}
            endedPresenterName={
              stage.ended !== null && stage.ended.share.userId !== viewer
                ? nameOf(stage.ended.share.userId)
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
          {shareLive && snapshot.publishing.camera && viewer !== null ? (
            stageFullscreen ? (
              <div className="pointer-events-none fixed inset-0 z-[60]">
                <div className="pointer-events-auto">
                  <SelfView
                    state="live"
                    stream={localCameraStream}
                    variant="overlay"
                    userId={viewer}
                  />
                </div>
              </div>
            ) : (
              <SelfView
                state="live"
                stream={localCameraStream}
                variant="overlay"
                userId={viewer}
              />
            )
          ) : null}
        </div>
      ) : null}

      {/* The tile pair (VM17) — strip geometry while the stage dominates. */}
      <TileGrid
        participants={grid.participants}
        variant={shareLive ? 'strip' : 'grid'}
        emptyHint="Nobody is on camera yet — turn yours on."
      />

      {/* Phone semantics: the ring note rides the media block while the peer
          hasn't joined (the block IS the connected expansion now). */}
      {!peerInCall ? (
        <p
          className="flex items-center gap-2 px-1 text-sm text-text-muted"
          role="status"
          data-testid="dm-call-ringing-peer"
        >
          <Spinner testId="dm-call-spinner" />
          <span>Ringing {peerName}…</span>
        </p>
      ) : null}

      {/* Foot: dismiss (VM17) + the compact controls + publish affordances. */}
      <div
        className="flex flex-wrap items-center justify-center gap-2 border-t border-line pt-2"
        data-testid="dm-media-controls"
      >
        <button
          type="button"
          className="flex h-10 min-w-10 items-center justify-center rounded-md px-2 text-sm font-medium text-text-muted transition-colors duration-[var(--duration-control)] hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
          aria-label="Collapse call media"
          title="Collapse to the compact call indicator"
          data-testid="dm-media-collapse"
          onClick={onCollapse}
        >
          <span aria-hidden>⌃</span>
        </button>
        <CallControls engine={engine} snapshot={snapshot} context="dm" />
        <PublishControls
          engine={engine}
          snapshot={snapshot}
          capabilities={DM_CALL_CAPABILITIES}
          canSendVideo
          canShareScreen
          mobile={mobile}
          context="dm"
        />
      </div>
    </div>
  );
}
