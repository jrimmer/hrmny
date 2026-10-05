/**
 * @cytale/web — PWA environment capability helpers (U25).
 *
 * Web Push on iOS ships only from Safari/iOS 16.4; below that the subscribe
 * UI must be hidden ENTIRELY (no dead controls — resolved Open Question,
 * 2026-08-27). These pure helpers are the runtime detection the subscribe
 * surface (later unit) composes; they perform no side effects.
 */

function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;

  // iPadOS 13+ masquerades as Mac (no touch points in the UA).
  const isIPadMac = /Macintosh/.test(ua) && typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1;

  return /iPad|iPhone|iPod/.test(ua) || isIPadMac;
}

/**
 * The iOS version as `[major, minor]`, or null when it cannot be read.
 *
 * The MINOR part is load-bearing: the web-push floor is 16.4, not 16.0, and a
 * major-only compare reports 16.0–16.3 as supported — an enable control that
 * cannot succeed, which the no-dead-controls resolution forbids. `OS 16_4`
 * and `Version/16.4` are both matched (Safari writes the first in the platform
 * token and the second in the Version token).
 */
function iosVersion(): [number, number] | null {
  if (!isIOS()) return null;
  const ua = navigator.userAgent;
  const m = /(?:OS|Version)[/ ](\d+)[._](\d+)/.exec(ua);
  if (!m) return null;
  return [parseInt(m[1] as string, 10), parseInt(m[2] as string, 10)];
}

/**
 * True when this page is running as an INSTALLED app rather than a browser
 * tab. On iOS this is not cosmetic: Safari delivers web push only to a PWA the
 * member has added to their home screen, so 16.4 alone is not sufficient and a
 * probe that ignores this offers a control that cannot work.
 *
 * (`navigator.standalone` is the iOS-specific signal; the media query covers
 * every other engine.)
 */
export function isInstalledPwa(): boolean {
  if (typeof navigator !== 'undefined' && (navigator as Navigator & { standalone?: boolean }).standalone === true) {
    return true;
  }

  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(display-mode: standalone)').matches;
  }

  return false;
}

/**
 * True when the platform can complete a Web Push subscription:
 * secure-context service workers + the Push API + (on iOS) ≥ 16.4 running as
 * an INSTALLED PWA.
 */
export function isWebPushSupported(): boolean {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return false;
  if (!('serviceWorker' in navigator)) return false;
  if (!('PushManager' in window)) return false;
  // Insecure origins (plain HTTP, non-localhost) cannot register SWs.
  if (typeof window.isSecureContext === 'boolean' && !window.isSecureContext) return false;

  if (isIOS()) {
    const version = iosVersion();
    // Unknown iOS version: treat conservatively as unsupported.
    if (version === null) return false;
    const [major, minor] = version;
    if (major < 16) return false;
    if (major === 16 && minor < 4) return false;

    // Supported version, but only from the home screen.
    return isInstalledPwa();
  }

  return true;
}

/**
 * Why web push cannot be enabled here, or null when it can.
 *
 * A boolean would leave the settings surface guessing at an explanation, and
 * the honest reason differs per platform — "iOS needs the app installed" is
 * actionable, while "unsupported" invites the member to give up.
 */
export type WebPushBlocker = 'ios_update' | 'ios_install' | 'insecure' | 'unsupported';

export function webPushBlocker(): WebPushBlocker | null {
  if (isWebPushSupported()) return null;

  if (isIOS()) {
    const version = iosVersion();
    if (version === null) return 'ios_update';
    const [major, minor] = version;
    if (major < 16 || (major === 16 && minor < 4)) return 'ios_update';
    return 'ios_install';
  }

  if (typeof window !== 'undefined' && window.isSecureContext === false) return 'insecure';
  return 'unsupported';
}

/** True when the browser currently has no network connection. */
export function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}
