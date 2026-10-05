/**
 * @cytale/web — desktop handoff copy (calls V2 plan U6; R12 + KDV3 + KTD8).
 *
 * The single source of the desktop-shell honesty strings. The wiring unit
 * (U5b) feeds these into `video/CapabilityDisabledButton`'s
 * title/body/action props; `DesktopHandoffButton` here does it for them.
 * The displaced-leg variant string is consumed by `DesktopHandoffNotice`
 * (and exported for CallPanel/DmCallIndicator to reuse verbatim) — V1's
 * stock displacement copy ("You joined this call on another device.")
 * would be a lie here: the user *chose* to continue in the browser.
 *
 * KDV3 shapes every body: name the gap plainly, one button, and the user
 * signs in and joins the call themselves — no deep link, no auto-join.
 */

/** Which desktop handoff surface is explaining itself. */
export type DesktopHandoffKind = 'screenshare' | 'capture';

/** Per-kind dialog copy for the visible-disabled affordance (VM10 pattern). */
export const DESKTOP_HANDOFF_COPY: Record<
  DesktopHandoffKind,
  { dialogTitle: string; dialogBody: string; actionLabel: string }
> = {
  screenshare: {
    // Matches the exemplar copy U5a's committed tests exercise for "the U6
    // desktop handoff shape" — keep the phrases stable across surfaces.
    dialogTitle: 'Screen sharing isn\u2019t available in the desktop app',
    dialogBody:
      'This desktop platform can\u2019t capture your screen. Open the web app to share it \u2014 ' +
      'sign in there and join the call yourself.',
    actionLabel: 'Open the web app',
  },
  capture: {
    // KTD8: on platforms where capture is wholly absent (Linux), the
    // camera/mic affordances gate on the same handoff.
    dialogTitle: 'Camera and microphone aren\u2019t available in the desktop app',
    dialogBody:
      'This desktop platform can\u2019t capture camera or microphone. Open the web app to use them \u2014 ' +
      'sign in there and join the call yourself.',
    actionLabel: 'Open the web app',
  },
} as const;

/**
 * R12's displaced-leg copy, verbatim. Rendered by `DesktopHandoffNotice`
 * when a desktop leg is displaced after its user opened the web app
 * (the browser joins, AM8 one-leg displacement fires, the desktop shows
 * this — NOT the stock "another device" notice).
 */
export const DISPLACED_VIA_HANDOFF_NOTICE = 'Call continued in your browser.';
