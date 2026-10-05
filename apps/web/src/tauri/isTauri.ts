/**
 * @cytale/web — Tauri desktop-shell runtime detection (U27).
 *
 * The desktop app (apps/desktop) hosts THIS web build in the OS webview
 * (WebView2 / WKWebView). Tauri 2 injects a `window.__TAURI_INTERNALS__`
 * global only when running inside the shell — the same bundle served as a
 * PWA in a browser never sees it. These pure helpers are the seam the web
 * UI uses to branch on "am I in the desktop shell?" (native notifications,
 * deep-link navigation, window-state) without importing any Tauri crate.
 *
 * No side effects; safe to call in SSR/tests (jsdom has no such global).
 */

/**
 * True when the current runtime is the Tauri desktop shell (not a browser).
 * Tauri 2 exposes `window.__TAURI_INTERNALS__`; its absence means browser.
 */
export function isTauri(): boolean {
  if (typeof window === 'undefined') return false;
  return '__TAURI_INTERNALS__' in window;
}

/**
 * The desktop shell's platform, when known. Tauri exposes the OS via the
 * `__TAURI_INTERNALS__` metadata; browsers report `navigator.platform`.
 * Returns null when not running in Tauri.
 */
export function tauriPlatform(): 'windows' | 'macos' | 'linux' | null {
  if (!isTauri()) return null;
  const nav = navigator.platform.toLowerCase();
  if (nav.includes('win')) return 'windows';
  if (nav.includes('mac')) return 'macos';
  if (nav.includes('linux')) return 'linux';
  return null;
}
