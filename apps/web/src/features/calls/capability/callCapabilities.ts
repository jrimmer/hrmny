/**
 * @cytale/web — the all-capabilities posture (calls V2 plan U8/R17; hardening
 * plan 7.7).
 *
 * "This surface assumes every media capability is available until the call
 * REST says otherwise." That posture used to be a hand-written literal in two
 * places — CallPanel's `ALL_CAPABILITIES` and DmCallIndicator's
 * `DM_ALL_CAPABILITIES` — so a new capability key had to be added twice or the
 * two surfaces silently disagreed.
 *
 * The values were identical; the KEY SETS were not, and that split is real:
 *
 *   - the channel/dock call surface carries START_CALL gating, so its posture
 *     includes `start: true` (the server resolves it default-on, channel-
 *     overridable — it gates the phone affordance, AM17);
 *   - DM rooms skip the workspace/channel capability checks entirely
 *     (participation IS the authorization there), so the DM surface's own
 *     contract has no `start` key at all — only `calls`/`video`/`screenshare`.
 *
 * Both are now views of the ONE object below, so the duplication left is the
 * naming, not the literal.
 *
 * NOT to be confused with `capability.ts` next door: that is the DEVICE-PROBE
 * module (can this webview capture a screen/camera at all — KTD8). This module
 * answers a server-authorization question; that one answers a platform one.
 */
import type { CallCapabilities } from '@cytale/api-client';

/**
 * The DM surface's view of the posture: the capability keys WITHOUT `start`.
 * DM rooms have no START_CALL gate (U8 — participation is authorization), so
 * that key is not part of this surface's contract.
 */
export type DmCallCapabilities = Pick<CallCapabilities, 'calls' | 'video' | 'screenshare'>;

/**
 * The single all-true object. `start: true` is the channel surface's
 * START_CALL default; the DM view below simply does not speak about it.
 */
const ALL_TRUE: CallCapabilities = {
  calls: true,
  video: true,
  screenshare: true,
  start: true,
};

/**
 * Channel/dock call surface: every capability on until the call REST lands
 * (and still all-true when that REST call FAILS — a fetch error must never
 * gate the panel shut; see `useCallCapabilities`).
 */
export const CALL_CAPABILITIES_ALL: CallCapabilities = ALL_TRUE;

/**
 * DM call surface: the same object with `start` dropped, so the DM posture
 * keeps exactly the three keys it always had (the runtime key set is
 * observable, e.g. through `Object.keys`, so this is a real projection rather
 * than a narrowed type). Destructuring rather than a second literal keeps ONE
 * source of truth: any capability key added to `ALL_TRUE` above lands in both
 * views automatically.
 */
const { start: _start, ...DM_VIEW } = ALL_TRUE;
export const DM_CALL_CAPABILITIES: DmCallCapabilities = DM_VIEW;
