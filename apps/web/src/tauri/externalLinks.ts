/**
 * @cytale/web — external links in the desktop shell go to the default browser.
 *
 * The WKWebView/WebView2 surface Tauri hosts has no `target="_blank"`
 * handling of its own: without an interception, clicking a link in a message
 * does nothing at all (owner report 2026-09-20). One document-level click
 * listener covers every anchor the app renders — markdown links, permalink
 * chips, attachment cards, the help links — without touching each call site:
 * when the shell is Tauri and the click resolved to an external http(s)
 * anchor, the default is prevented and the URL is handed to the standard
 * Tauri 2 opener plugin (`plugin:opener|open_url`, the same seam the call
 * handoff uses), which opens the user's default browser.
 *
 * The shell side of the seam is the `opener:allow-open-url` capability
 * (apps/desktop/src-tauri/capabilities/desktop.json). Since WEB-1 it admits
 * every `https://` URL plus exactly one plain-http origin — `http://localhost:5173`,
 * tauri.conf.json's devUrl, which is what the call handoff opens in `tauri
 * dev`. The first shipped allowlist carried only the deployment host, so
 * EVERY other message link was refused by the IPC guard and died as a click.
 * Plain http is otherwise refused on purpose (a message link must never be
 * able to reach a local service); the `.catch` below then falls back to
 * `window.open`, whose fate is per-engine (docs/self-hosting.md).
 *
 * In-app routes (`#/…`, the hash router) never match: they carry no
 * `target="_blank"` and their href starts with `#`, which the http(s) guard
 * excludes by construction.
 */

/** Minimal structural type of Tauri 2's injected runtime (no npm dep). */
interface TauriInternalsGlobal {
  __TAURI_INTERNALS__?: {
    invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
  };
}

/** The opener plugin's command name (tauri-plugin-opener v2). */
const OPENER_COMMAND = 'plugin:opener|open_url';

/** Only absolute http(s) URLs leave the shell; everything else stays native. */
function externalHttpUrl(href: string): string | null {
  if (!/^https?:\/\//i.test(href)) return null;
  return href;
}

/** True when the runtime is the Tauri desktop shell (the isTauri seam). */
function insideTauriShell(): boolean {
  return (
    typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  );
}

/**
 * Install the interceptor (idempotent, at-most-once per document). In a
 * browser this is a no-op — anchors behave exactly as before.
 */
export function wireExternalLinksToDefaultBrowser(): void {
  if (typeof document === 'undefined') return;
  if ((document as Document & { __hrmnyExternalLinksWired?: boolean }).__hrmnyExternalLinksWired) {
    return;
  }
  (document as Document & { __hrmnyExternalLinksWired?: boolean }).__hrmnyExternalLinksWired = true;
  if (!insideTauriShell()) return;

  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey) return;
    // Re-check the shell AT CLICK time: preventDefault is only ever spent
    // when the opener path will actually handle the click.
    if (!insideTauriShell()) return;
    const anchor = (event.target as Element | null)?.closest?.('a');
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (!href) return;
    const url = externalHttpUrl(href);
    if (!url) return;

    event.preventDefault();
    const internals = (window as unknown as TauriInternalsGlobal).__TAURI_INTERNALS__;
    if (internals && typeof internals.invoke === 'function') {
      void internals.invoke(OPENER_COMMAND, { url }).catch(() => {
        // The shell refused (or the plugin is missing): last resort, let the
        // webview try its own navigation — better than a silent dead click.
        window.open(url, '_blank', 'noopener,noreferrer');
      });
    } else {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  });
}
