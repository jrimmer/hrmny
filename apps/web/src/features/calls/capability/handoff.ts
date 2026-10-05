/**
 * @cytale/web — desktop → browser handoff (calls V2 plan U6; R12 + KDV3).
 *
 * KDV3, deliberately unfancy: the handoff is ONE button that opens the
 * configured web origin in the user's DEFAULT browser. No deep link, no
 * channel path, no auto-join — the user logs in and joins the call
 * themselves. The V1 one-leg-per-user displacement (AM8) then does the
 * rest server-side: the browser joins, the desktop leg is displaced, and
 * the desktop shows `DesktopHandoffNotice` ("Call continued in your
 * browser.") instead of the stock "another device" copy.
 *
 * Opener seam: the standard Tauri 2 opener plugin command
 * (`plugin:opener|open_url`), invoked through the raw
 * `window.__TAURI_INTERNALS__` global — the web app deliberately imports
 * no Tauri npm package (see src/tauri/isTauri.ts). If the shell has not
 * registered the plugin (or rejects the URL), we fall back to
 * `window.open`, which is a real default-browser open on WebView2.
 */

/** Minimal structural type of Tauri 2's injected runtime (no npm dep). */
interface TauriInternalsGlobal {
  __TAURI_INTERNALS__?: {
    invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
  };
}

/** The opener plugin's command name (tauri-plugin-opener v2). */
const OPENER_COMMAND = 'plugin:opener|open_url';

/** Module state: has the user opened the web app from this shell? */
let handoffInitiated = false;

/** Runtime override for the handoff origin (null = use the build/env value). */
let originOverride: string | null = null;

/**
 * Set (or clear, with null) the web origin the handoff opens — the runtime
 * seam the desktop shell (or tests) can use to point at the deployment
 * without a rebuild. Wins over `VITE_WEB_ORIGIN`.
 */
export function setWebAppOrigin(origin: string | null): void {
  originOverride = origin && origin.length > 0 ? origin : null;
}

/**
 * The web origin the handoff opens — the "configured web origin" (plan
 * U6). Resolution order:
 *   1. `setWebAppOrigin(...)` — runtime override.
 *   2. `VITE_WEB_ORIGIN` (build-time config; the only honest source for
 *      production desktop bundles, whose webview origin is an internal
 *      scheme like `tauri://localhost`, not the deployment).
 *   3. `window.location.origin` — correct everywhere the web app is
 *      served over http(s): browsers, the installed PWA, and
 *      `tauri dev` (devUrl).
 * Never carries a path/query/hash — KDV3 forbids deep links.
 */
export function webAppOrigin(): string {
  const raw = originOverride ?? readConfiguredWebOrigin() ?? globalThis.location?.origin ?? '';
  return raw.replace(/\/+$/, '');
}

/**
 * Open the web app in the default browser (the ONE handoff action).
 * Takes no arguments and opens only the bare origin — by KDV3 the user
 * signs in and joins the call themselves.
 */
export async function openWebApp(): Promise<void> {
  const url = webAppOrigin();
  handoffInitiated = true;

  const internals = (globalThis.window as TauriInternalsGlobal | undefined)
    ?.__TAURI_INTERNALS__;
  if (internals && typeof internals.invoke === 'function') {
    try {
      await internals.invoke(OPENER_COMMAND, { url });
      return;
    } catch {
      // The shell hasn't wired the opener plugin (or refused the URL) —
      // fall through to the browser-native opener.
    }
  }
  globalThis.window?.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * True once `openWebApp` has run in this shell. The wiring unit uses this
 * to pick the displaced-notice variant: a displacement following a
 * handoff renders "Call continued in your browser.", not the stock
 * "You joined this call on another device."
 */
export function isHandoffInitiated(): boolean {
  return handoffInitiated;
}

/** Test-only: reset the handoff-initiated flag and origin override between cases. */
export function resetHandoffForTests(): void {
  handoffInitiated = false;
  originOverride = null;
}

/**
 * Read VITE_WEB_ORIGIN from vite's `import.meta.env`. Typed structurally
 * because apps/web deliberately does not depend on vite/client types.
 */
function readConfiguredWebOrigin(): string | undefined {
  const env = (import.meta as unknown as { env?: Record<string, unknown> }).env;
  const value = env?.VITE_WEB_ORIGIN;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
