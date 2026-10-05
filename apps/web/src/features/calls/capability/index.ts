/**
 * @cytale/web — desktop capability + plain handoff (calls V2 plan U6).
 *
 * Probes (KTD8): lazy, desktop-gated, session-cached classification of
 * what the shell's webview can honestly capture — API presence plus a
 * dry-run attempt, because presence alone lies (macOS WKWebView trap).
 * Handoff (KDV3): one button, the bare web origin in the default browser,
 * no deep links, no auto-join.
 */
export {
  CAPABILITY_PROBE_TIMEOUT_MS,
  captureSupport,
  reportCaptureOutcome,
  resetCapabilityCacheForTests,
  screenshareSupport,
  type CapabilityKind,
  type CapabilityProbeOptions,
  type CapabilityStatus,
} from './capability.js';
export {
  isHandoffInitiated,
  openWebApp,
  resetHandoffForTests,
  setWebAppOrigin,
  webAppOrigin,
} from './handoff.js';
export {
  DESKTOP_HANDOFF_COPY,
  DISPLACED_VIA_HANDOFF_NOTICE,
  type DesktopHandoffKind,
} from './copy.js';
export { DesktopHandoffButton, type DesktopHandoffButtonProps } from './DesktopHandoffButton.js';
export { DesktopHandoffNotice, type DesktopHandoffNoticeProps } from './DesktopHandoffNotice.js';
