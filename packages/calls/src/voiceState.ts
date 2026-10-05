/**
 * @cytale/web — the composite voice state machine (calls plan U8, AM14;
 * calls V2 plan U4 amends: VM5 listen-only, VM8 share-ended notice).
 *
 * One machine per active client voice leg, composing the three legs the
 * plan's HTD names — signaling (gateway op-22 ↔ CALL_UPDATE), media
 * (RTCPeerConnection + mic), and permission (VIEW_CHANNEL/START_CALL +
 * mic capture) — into the DoD states connecting/connected/reconnecting/
 * permission-denied/voice-unavailable/offline.
 *
 * PURE by construction: a `transition(state, input)` function over plain
 * data, no timers, no IO, no subscriptions. The media controller
 * (useCallMedia.ts) owns the inputs' origins; this module only decides
 * what each input MEANS. Unit tests cover every edge of the diagram
 * (see voiceState.test.ts).
 *
 * Composite ordering: `pc-connected` and the mic OUTCOME (granted or
 * denied) may arrive in either order during ConnectingMedia; the machine
 * carries both as flags and fires Connected when the PC is up AND the mic
 * outcome is known (granted, OR denied — VM5's listen-only: a denied mic
 * degrades the leg to listen-only, it no longer tears it down; a later
 * `mic-granted` upgrades the flag in place). A pc-connected while
 * Reconnecting (the ICE-restart leg or a gateway resume whose media never
 * dropped) also exits to Connected.
 *
 * ```mermaid (source of truth: plan HTD "Client composite voice state")
 *   [*] --> Idle
 *   Idle --> ConnectingSignaling: join-intent
 *   ConnectingSignaling --> ConnectingMedia: session-confirmed
 *   ConnectingMedia --> Connected: pc-connected + mic outcome known
 *   Connected --> Reconnecting: gateway-resume | ice-failed(recoverable)
 *   Reconnecting --> Connected: backfill-ok | pc-connected
 *   ConnectingSignaling --> PermissionDenied: forced-leave
 *   Connected --> PermissionDenied: forced-leave (revocation)
 *   ConnectingMedia --> VoiceUnavailable: ice-failed(exhausted)
 *   Reconnecting --> VoiceUnavailable: media leg unrecoverable
 *   Reconnecting --> VoiceUnavailable: reconnect-timeout (bounded ~15 s wait)
 *   Connected --> Offline: gateway-invalid (media torn down per AM4)
 *   Reconnecting --> Idle: backfill-self-absent (re-join effect)
 *   PermissionDenied --> Idle  ·  VoiceUnavailable --> Idle  ·  Offline --> Idle
 * ```
 */

/** The composite statuses (AM14 names, DoD states). */
export type VoiceStatus =
  | 'idle'
  | 'connecting-signaling'
  | 'connecting-media'
  | 'connected'
  | 'reconnecting'
  | 'permission-denied'
  | 'voice-unavailable'
  | 'offline';

/**
 * A reason surfaced to the user alongside a state. Terminal exits
 * (displaced / forced-leave / offline) carry their notice INTO Idle so
 * surfaces can render it; `share-ended` (VM8) is a NON-terminal
 * notice — a mid-call event banner ("your screen share ended") that a
 * connected leg keeps rendering until dismissed. The KTD6 source-revoked
 * notices (`camera-stopped` / `share-stopped`) are the same shape: the room
 * unpublished the source on a rights revocation — the leg keeps running.
 */
export type VoiceNotice =
  | 'displaced' // own leg displaced by a second device (AM8)
  | 'forced-leave' // mid-call rights revocation (AM3/R10)
  | 'share-ended' // the screen share ended natively (VM8) — leg unaffected
  | 'share-unavailable' // screen capture cannot run here (F5) — leg unaffected; the notice offers the web-app handoff (KDV3)
  | 'camera-stopped' // the room unpublished the camera (KTD6) — leg unaffected
  | 'share-stopped' // the room unpublished the screen share (KTD6) — leg unaffected
  | 'offline'; // invalid-session teardown (AM4)

/** Machine state — plain data, comparable with ===. */
export interface VoiceState {
  status: VoiceStatus;
  /** Media leg reached `connected` at least once in this negotiation. */
  pcConnected: boolean;
  /** Mic capture granted (track held). */
  micGranted: boolean;
  /**
   * VM5: mic capture was DENIED — the leg degraded to listen-only and
   * survives (guidance surfaces offer retryMic). Cleared by a later
   * mic-granted (in-place upgrade) or a fresh join.
   */
  micDenied: boolean;
  /** Terminal reason or the mid-call share-ended notice; null otherwise. */
  notice: VoiceNotice | null;
}

/**
 * Every input the machine understands. Origins:
 *  - join-intent / leave-intent / dismiss — user affordances
 *  - session-confirmed — CALL_UPDATE `joined` on the OWN leg
 *  - pc-connected / mic-granted / mic-denied — media leg (denied is
 *    LISTEN-ONLY now, VM5 — not a teardown)
 *  - share-ended — the publish engine's native-stop path for a screen
 *    share (VM8: ended screens never auto-restart; the notice says so)
 *  - gateway-resume / gateway-invalid — gateway lifecycle (engine poll)
 *  - backfill-ok / backfill-self-absent — CALL_SYNC after a resume (AM4)
 *  - ice-failed — PC connection `failed` (server owns the restart offer;
 *    recoverable = the one restart hasn't been spent, exhausted = it has)
 *  - reconnect-timeout — the controller's bounded Reconnecting wait (~15 s)
 *    expired without the restart offer / resume backfill landing; a truly
 *    dead leg must not park the surface in Reconnecting forever
 *  - source-revoked — CALL_UPDATE camera_off/screen_off on the OWN leg: the
 *    room unpublished the source on a rights revocation (KTD6); the
 *    controller retires the capture and the notice says why it stopped
 *  - forced-leave / displaced — CALL_UPDATE targeting the OWN leg (AM8)
 */
export type VoiceInput =
  | { type: 'join-intent' }
  | { type: 'session-confirmed' }
  | { type: 'pc-connected' }
  | { type: 'mic-granted' }
  | { type: 'mic-denied' }
  | { type: 'share-ended' }
  | { type: 'share-unavailable' }
  | { type: 'gateway-resume' }
  | { type: 'gateway-invalid' }
  | { type: 'backfill-ok' }
  | { type: 'backfill-self-absent' }
  | { type: 'ice-failed'; recoverable: boolean }
  | { type: 'reconnect-timeout' }
  | { type: 'source-revoked'; source: 'camera' | 'screen' }
  | { type: 'forced-leave' }
  | { type: 'displaced' }
  | { type: 'leave-intent' }
  | { type: 'dismiss' };

/** Side effects the ORCHESTRATOR (not the machine) must run. */
export type VoiceEffect = { type: 'rejoin' };

export interface TransitionResult {
  state: VoiceState;
  effects: VoiceEffect[];
}

/** The machine's start state (and the shape of every full reset). */
export function initialVoiceState(): VoiceState {
  return {
    status: 'idle',
    pcConnected: false,
    micGranted: false,
    micDenied: false,
    notice: null,
  };
}

/** Statuses in which a voice leg is being established or held. */
export const ACTIVE_STATUSES: ReadonlySet<VoiceStatus> = new Set([
  'connecting-signaling',
  'connecting-media',
  'connected',
]);

const IDLE: VoiceState = initialVoiceState();

/** True when the mic outcome is known either way (granted or listen-only). */
function micResolved(state: VoiceState): boolean {
  return state.micGranted || state.micDenied;
}

/**
 * Apply one input. Unknown-state/unknown-input combinations are no-ops that
 * return the SAME state object (identity-stable for subscription updates) —
 * a late media event after teardown must never resurrect a leg.
 */
export function transition(state: VoiceState, input: VoiceInput): TransitionResult {
  switch (input.type) {
    case 'join-intent': {
      // Terminal statuses accept a fresh join directly — the panel's Retry
      // is dismiss+join in one gesture.
      if (state.status !== 'idle' && !isTerminal(state.status)) return { state, effects: [] };
      return { state: { ...initialVoiceState(), status: 'connecting-signaling' }, effects: [] };
    }

    case 'session-confirmed': {
      if (state.status !== 'connecting-signaling') return { state, effects: [] };
      // The room already pushed its (first) offer and the PC is up AND the
      // mic outcome landed first — everything is ready; skip the
      // intermediate state (listen-only counts as a known outcome, VM5).
      if (state.pcConnected && micResolved(state)) {
        return { state: { ...state, status: 'connected' }, effects: [] };
      }
      return { state: { ...state, status: 'connecting-media' }, effects: [] };
    }

    case 'pc-connected': {
      if (state.status === 'idle' || isTerminal(state.status)) {
        return { state, effects: [] };
      }
      // Duplicate notification while already Connected: identity no-op.
      if (state.pcConnected && state.status === 'connected') return { state, effects: [] };
      const next: VoiceState = { ...state, pcConnected: true };
      if (
        (state.status === 'connecting-media' || state.status === 'reconnecting') &&
        micResolved(state)
      ) {
        // Both legs ready: direct promotion. The reconnecting case covers
        // the ICE-restart offer landing (pcConnected was already true from
        // before the failure — the flag alone did not promote) and a
        // gateway resume whose media never dropped.
        next.status = 'connected';
      }
      return { state: next, effects: [] };
    }

    case 'mic-granted': {
      if (state.micGranted) return { state, effects: [] };
      // VM5 upgrade: a listen-only leg that later gains the mic flips the
      // flag in place (the controller rebinds the track by manifest mid).
      const next: VoiceState = { ...state, micGranted: true, micDenied: false };
      if (state.status === 'connecting-media' && state.pcConnected) {
        next.status = 'connected';
      }
      // connecting-signaling awaits session-confirmed; reconnecting awaits
      // backfill/pc — the flag alone never promotes those. A listen-only
      // Connected leg simply keeps its status with the flag upgraded.
      return { state: next, effects: [] };
    }

    case 'mic-denied': {
      if (!ACTIVE_STATUSES.has(state.status) && state.status !== 'reconnecting') {
        return { state, effects: [] };
      }
      // VM5 (ratified): denial DEGRADES the leg to listen-only — the leg
      // survives, the guidance surface offers retryMic, and a connected
      // PC promotes as usual (listen-only Connected).
      const next: VoiceState = { ...state, micDenied: true };
      if (state.status === 'connecting-media' && state.pcConnected) {
        next.status = 'connected';
      }
      return { state: next, effects: [] };
    }

    case 'share-ended': {
      if (!ACTIVE_STATUSES.has(state.status) && state.status !== 'reconnecting') {
        return { state, effects: [] };
      }
      // VM8: the screen share ended natively (stop bar / closed window /
      // OS revoke). NEVER auto-restarted; the notice is a mid-call banner.
      if (state.notice === 'share-ended') return { state, effects: [] };
      return { state: { ...state, notice: 'share-ended' }, effects: [] };
    }

    case 'share-unavailable': {
      if (!ACTIVE_STATUSES.has(state.status) && state.status !== 'reconnecting') {
        return { state, effects: [] };
      }
      // F5: getDisplayMedia cannot run in this host (e.g. WKWebView's
      // NotSupportedError) and the user ASKED to share — a silent no-op is
      // the dishonest outcome the walkthrough flagged. Mid-call banner in
      // share-ended's shape; the surface pairs it with the KDV3 web-app
      // handoff action.
      if (state.notice === 'share-unavailable') return { state, effects: [] };
      return { state: { ...state, notice: 'share-unavailable' }, effects: [] };
    }

    case 'source-revoked': {
      if (!ACTIVE_STATUSES.has(state.status) && state.status !== 'reconnecting') {
        return { state, effects: [] };
      }
      // KTD6: the ROOM unpublished the source (rights revocation — the
      // controller already retired the capture to match). Mid-call banner
      // exactly like share-ended: the leg itself is unaffected.
      const notice: VoiceNotice =
        input.source === 'camera' ? 'camera-stopped' : 'share-stopped';
      if (state.notice === notice) return { state, effects: [] };
      return { state: { ...state, notice }, effects: [] };
    }

    case 'gateway-resume': {
      if (!ACTIVE_STATUSES.has(state.status) && state.status !== 'reconnecting') {
        return { state, effects: [] };
      }
      if (state.status === 'reconnecting') return { state, effects: [] };
      return { state: { ...state, status: 'reconnecting' }, effects: [] };
    }

    case 'gateway-invalid': {
      if (state.status === 'idle' || isTerminal(state.status)) {
        return { state, effects: [] };
      }
      // AM4: an un-resumable session tears the voice leg down server-side —
      // the client mirrors with a full media teardown (the controller does
      // that on this transition) and lands in Offline.
      return {
        state: { ...IDLE, status: 'offline', notice: 'offline' },
        effects: [],
      };
    }

    case 'backfill-ok': {
      if (state.status !== 'reconnecting') return { state, effects: [] };
      return {
        state: { ...state, status: 'connected', pcConnected: true },
        effects: [],
      };
    }

    case 'backfill-self-absent': {
      if (state.status !== 'reconnecting' && state.status !== 'connected') {
        return { state, effects: [] };
      }
      // AM4: the resume backfill says our leg is gone. The machine lands in
      // Idle (call surface closes); the orchestrator runs the `rejoin`
      // effect — a fresh op-22 join that, if the call is still live, drives
      // the machine straight back through join-intent → session-confirmed.
      return { state: { ...IDLE }, effects: [{ type: 'rejoin' }] };
    }

    case 'ice-failed': {
      if (state.status === 'idle' || isTerminal(state.status)) {
        return { state, effects: [] };
      }
      if (!input.recoverable) {
        // One restart spent (the server's ice_restart offer) and the leg
        // still fails — the no-DTX-style capacity math is moot; voice is
        // unavailable on this network path.
        return { state: { ...IDLE, status: 'voice-unavailable' }, effects: [] };
      }
      if (state.status === 'reconnecting') return { state, effects: [] };
      return { state: { ...state, status: 'reconnecting' }, effects: [] };
    }

    case 'reconnect-timeout': {
      if (state.status !== 'reconnecting') return { state, effects: [] };
      // Bounded wait: the restart offer (or the resume's backfill) never
      // landed within the controller's ~15 s window — the same recovery
      // surface as ICE exhaustion (VoiceUnavailable + Retry), never an
      // endless Reconnecting park on a dead leg.
      return { state: { ...IDLE, status: 'voice-unavailable' }, effects: [] };
    }

    case 'forced-leave': {
      if (state.status === 'idle' || isTerminal(state.status)) {
        return { state, effects: [] };
      }
      // R10/AM3: live permission re-check evicted us (also covers the
      // ConnectingSignaling leg of the diagram — VIEW_CHANNEL failing the
      // join surfaces as a forced_leave on the half-open leg).
      return {
        state: { ...IDLE, status: 'permission-denied', notice: 'forced-leave' },
        effects: [],
      };
    }

    case 'displaced': {
      if (state.status === 'idle' || isTerminal(state.status)) {
        return { state, effects: [] };
      }
      // AM8: a second device joined — its leg won. Notice survives into
      // Idle so the panel can say "joined elsewhere".
      return { state: { ...IDLE, notice: 'displaced' }, effects: [] };
    }

    case 'leave-intent': {
      if (state.status === 'idle') return { state, effects: [] };
      return { state: { ...IDLE }, effects: [] };
    }

    case 'dismiss': {
      if (isTerminal(state.status)) {
        return { state: { ...IDLE }, effects: [] };
      }
      // Mid-call notices (share-ended) clear WITHOUT leaving the leg; an
      // idle-with-notice (displaced) clears to clean idle.
      if (state.notice !== null) {
        if (ACTIVE_STATUSES.has(state.status) || state.status === 'reconnecting') {
          return { state: { ...state, notice: null }, effects: [] };
        }
        return { state: { ...IDLE }, effects: [] };
      }
      return { state, effects: [] };
    }

    default: {
      // Compile-time exhaustiveness: an unhandled input fails the build.
      const _exhaustive: never = input;
      void _exhaustive;
      return { state, effects: [] };
    }
  }
}

/** The three recovery-terminal statuses (Idle is the resting state). */
export function isTerminal(status: VoiceStatus): boolean {
  return (
    status === 'permission-denied' ||
    status === 'voice-unavailable' ||
    status === 'offline'
  );
}
